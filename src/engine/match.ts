/**
 * GST ERP — purchase reconciliation engine.
 *
 * Matches the purchase books (SAP purchase register) against the GSTR-2B
 * download and classifies every line. Pure functions, no I/O.
 *
 * MATCH KEY
 *   (our GSTIN, supplier GSTIN, invoice number)
 * All three normalised. The date is deliberately NOT part of the key: vendors
 * routinely re-date an invoice while keeping the same GSTIN + number, and
 * treating that as a missing/extra pair hides the real problem (a re-date)
 * behind two phantom exceptions.
 *
 * STATUSES
 *   Matched          GSTIN + invoice found on both sides, amounts agree
 *   Amount Mismatch  found on both sides, taxable or ITC differs beyond tol.
 *   ITC Blocked      found on both sides, but GSTR-2B marks ITC unavailable.
 *                    These MUST NOT be claimed — cl.16(4) of the CGST Act.
 *   Missing in 2B    in the books, absent from GSTR-2B. Vendor follow-up.
 *   Duplicate        the same GSTIN + invoice appears twice on this side.
 *   Pending Review   a 2B line with no book counterpart and no other anchor.
 */

import {
  isCreditDoc,
  isSec16_4TimeBarred,
  normDocType,
  normGstin,
  normInvoice,
  r2,
  taxOf,
  withinTolerance,
  type DocType,
  type Gstr2bRecord,
  type PurchaseBill,
  type ReconRow,
} from './core';

export interface ReconOptions {
  /** Rupee tolerance before a difference is real. Portal rounding is common. */
  tolerance?: number;
  /** Do not treat repeat GSTIN+invoice as an error (some vendors reuse numbers). */
  ignoreDuplicates?: boolean;
}

export interface ReconResult {
  rows: ReconRow[];
  /** 2B lines that no book line claimed — "not booked in purchase". */
  unbooked2b: ReconRow[];
  summary: {
    books_rows: number;
    twob_rows: number;
    matched: number;
    amount_mismatch: number;
    itc_blocked: number;
    missing_in_2b: number;
    duplicate: number;
    unbooked_2b: number;
    books_itc: number;
    twob_itc: number;
    claimable_itc: number;
    /** Gross = Tax Invoice + Debit Note; credit = the reduction credit notes take. */
    books_taxable_gross: number;
    books_taxable_credit: number;
    books_taxable_net: number;
    books_itc_gross: number;
    books_itc_credit: number;
    twob_taxable_gross: number;
    twob_taxable_credit: number;
    twob_taxable_net: number;
    twob_itc_gross: number;
    twob_itc_credit: number;
    /** Document counts by type, per side. */
    books_docs: { invoice: number; debit: number; credit: number };
    twob_docs: { invoice: number; debit: number; credit: number };
  };
}

export const DEFAULT_TOLERANCE = 1;

/**
 * The values reconciliation actually matches on.
 *
 * Phase 0 lets the Accounts user correct the supplier GSTIN, invoice number and
 * invoice date a line is matched by, without touching the book values. When an
 * override is absent the book value is used, so an untouched import reconciles
 * byte-for-byte as it did before this feature existed.
 */
export interface MatchKeyValues {
  supplier_gstin: string;
  invoice_no: string;
  invoice_date: string;
  /** True when at least one override differs from the book values. */
  edited: boolean;
}

export function matchValuesOf(b: PurchaseBill): MatchKeyValues {
  const bookGstin = normGstin(b.supplier_gstin);
  const bookInv = String(b.invoice_no ?? '').trim();
  const bookDate = b.invoice_date || '';

  const g = b.recon_supplier_gstin ? normGstin(b.recon_supplier_gstin) : bookGstin;
  const i = b.recon_invoice_no ? String(b.recon_invoice_no).trim() : bookInv;
  const d = b.recon_invoice_date ? b.recon_invoice_date : bookDate;

  return { supplier_gstin: g, invoice_no: i, invoice_date: d, edited: g !== bookGstin || i !== bookInv || d !== bookDate };
}

function keyOf(gstin: unknown, invoiceNo: unknown): string {
  return `${normGstin(gstin)}|${normInvoice(invoiceNo)}`;
}

/**
 * The book line's document type, with one safety net.
 *
 * A file that labelled a row "Invoice" but printed every amount with a minus is
 * a credit note in substance — the sign cannot be explained any other way — and
 * matching it against an invoice of the same number would hide a real duplicate
 * booking. A stated Credit Note / Debit Note is always believed.
 */
function bookDocOf(b: PurchaseBill): DocType {
  const stated = normDocType(b.document_type);
  if (stated !== 'Tax Invoice') return stated;
  const amounts = [b.taxable_value, b.igst, b.cgst, b.sgst, b.cess]
    .map(r2)
    .filter((n) => n !== 0);
  return amounts.length > 0 && amounts.every((n) => n < 0) ? 'Credit Note' : 'Tax Invoice';
}

/**
 * The 2B month a line matched in.
 *
 * Prefers the portal's own `fp` (the return period the supplier filed under) and
 * falls back to the period column of the 2B file. The purchase register's month
 * is never used: an invoice booked in March can appear in the April 2B, and
 * pretending otherwise is exactly the kind of quiet wrongness this system exists
 * to prevent.
 */
function twobDocOf(r: Gstr2bRecord): DocType {
  const stated = normDocType(r.invoice_type);
  if (stated !== 'Tax Invoice') return stated;
  const amounts = [r.taxable_value, r.igst, r.cgst, r.sgst, r.cess]
    .map(r2)
    .filter((n) => n !== 0);
  return amounts.length > 0 && amounts.every((n) => n < 0) ? 'Credit Note' : 'Tax Invoice';
}

function twobMonthOf(r: Gstr2bRecord): string {
  return (r.portal_fp || r.period || '').trim();
}

/**
 * Stable identity for a 2B line.
 *
 * Reconciliation tracks which portal lines a book row claimed. That set is
 * compared against the same ids when scanning for unbooked lines, so the id
 * MUST be derived purely from the row's own fields — never from a running
 * counter, which would produce different values on the two passes and report
 * every single line as unbooked.
 */
function twobId(r: Gstr2bRecord): string {
  return r.id as string;
}

function itcBlocked(rec: Gstr2bRecord): boolean {
  return String(rec.itc_availability ?? 'Yes').trim().toLowerCase() !== 'yes';
}

/**
 * A 2B line that takes credit AWAY rather than giving it: a credit note, or any
 * negative document. The advice for an unbooked line depends on this — an
 * unbooked credit note has to be booked and REVERSED, never "claimed".
 */
function reducesItc(r: Gstr2bRecord): boolean {
  return r2(r.taxable_value) < 0 || /credit note|creditnote|cdn/i.test(String(r.invoice_type || ''));
}

/**
 * Reconcile one company's purchase side.
 *
 * Both arrays are filtered to a single `our_gstin` by the caller so that a
 * group with several registrations can never cross-match one GSTIN's purchases
 * against another's GSTR-2B.
 */
export function reconcilePurchases(
  books: PurchaseBill[],
  twob: Gstr2bRecord[],
  opts: ReconOptions = {},
): ReconResult {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;

  // Give every 2B line a stable id up front. Both the matching pass and the
  // unbooked pass then read the SAME id for the same row.
  twob = twob.map((r, i) => ({ ...r, id: r.id || `2b#${i}` }));

  // ---- index the 2B side, and note repeats -------------------------------
  const twobByKey = new Map<string, Gstr2bRecord[]>();
  for (const r of twob) {
    const k = keyOf(r.supplier_gstin, r.invoice_no);
    if (!twobByKey.has(k)) twobByKey.set(k, []);
    twobByKey.get(k)!.push(r);
  }

  // ---- count repeats on the books side ----------------------------------
  const booksKeyCount = new Map<string, number>();
  for (const b of books) {
    const m = matchValuesOf(b);
    const k = keyOf(m.supplier_gstin, m.invoice_no);
    booksKeyCount.set(k, (booksKeyCount.get(k) || 0) + 1);
  }

  const claimed = new Set<string>();
  const rows: ReconRow[] = [];

  for (const b of books) {
    const mv = matchValuesOf(b);
    const k = keyOf(mv.supplier_gstin, mv.invoice_no);
    const itc = taxOf(b);
    const bookDoc = bookDocOf(b);
    // A credit note is never the counterpart of an invoice that happens to
    // carry the same number. The portal keeps notes in CDNR and the books keep
    // them in the same register, so the type has to be part of the identity.
    const bucket = (twobByKey.get(k) || []).filter(
      (x) => twobDocOf(x) === bookDoc,
    );

    const base: ReconRow = {
      status: 'Pending Review',
      our_gstin: normGstin(b.our_gstin),
      unit_name: b.unit_name,
      party_name: b.party_name,
      supplier_gstin: normGstin(b.supplier_gstin),
      invoice_no: String(b.invoice_no ?? '').trim(),
      invoice_date: b.invoice_date,
      period: b.period,
      matched_on_recon: mv.edited || undefined,
      document_type: bookDoc,
      taxable_value: r2(b.taxable_value),
      igst: r2(b.igst),
      cgst: r2(b.cgst),
      sgst: r2(b.sgst),
      cess: r2(b.cess),
      itc,
      duplicate_count: booksKeyCount.get(k),
      source_file: b.source_file,
      source_row: b.source_row,
      itc_decision: b.itc_decision,
      itc_decision_month: b.itc_decision_month,
      return_classification: b.return_classification,
      reverse_charge: b.reverse_charge,
      hsn: b.hsn,
      sec16_4_barred: isSec16_4TimeBarred(b.invoice_date, b.itc_decision_month || b.period) || undefined,
    };

    // A repeated key on the books side is a real finding — flag every copy so
    // the reviewer can see the whole cluster, not just the second occurrence.
    if (!opts.ignoreDuplicates && (booksKeyCount.get(k) || 0) > 1) {
      rows.push({
        ...base,
        status: 'Duplicate',
        action:
          'Purchase register me ye same GSTIN + Invoice No 2 ya zyada baar hai. Duplicate booking hoga to ITC double claim ho jayega — pehle duplicate entry delete/void karein.',
      });
      continue;
    }

    if (bucket.length === 0) {
      rows.push({
        ...base,
        status: 'Missing in 2B',
        action:
          'Purchase book me hai par GSTR-2B me nahi. Vendor se GSTR-1 me daal kar file karwaayein; tab tak ispe ITC claim mat karein (cl.16(2)(b)).',
      });
      continue;
    }

    // A single invoice reaches GSTR-2B as several lines when it carries more than
    // one rate, so an invoice-level comparison is the SUM of the lines the portal
    // filed for it in ONE return month. Comparing against a single line reported
    // half an invoice as an amount mismatch, and left the invoice's other line
    // looking like a purchase nobody had booked.
    const primary = bucket.find((x) => x.invoice_date === mv.invoice_date) || bucket[0];
    const matched2bMonth = twobMonthOf(primary) || primary.period || '';
    const group = bucket.filter((x) => (twobMonthOf(x) || x.period || '') === matched2bMonth);
    for (const g of group) claimed.add(twobId(g));

    const matchId = twobId(primary);
    const blockedLine = group.find(itcBlocked);
    const twobTaxable = r2(group.reduce((a, x) => a + r2(x.taxable_value), 0));
    const twobIgst = r2(group.reduce((a, x) => a + r2(x.igst), 0));
    const twobCgst = r2(group.reduce((a, x) => a + r2(x.cgst), 0));
    const twobSgst = r2(group.reduce((a, x) => a + r2(x.sgst), 0));
    const twobCess = r2(group.reduce((a, x) => a + r2(x.cess), 0));
    const twobRcm = b.reverse_charge ?? group.some((x) => x.reverse_charge);
    const twobItc = r2(group.reduce((a, x) => a + taxOf(x), 0));
    const diffItc = r2(twobItc - itc);
    const diffTaxable = r2(twobTaxable - r2(b.taxable_value));
    // Taxable and every tax component, not just the total tax: two invoices can
    // carry the same tax total split differently (IGST vs CGST+SGST), and that
    // is exactly the kind of mismatch that blocks credit on the portal.
    const component = (f: 'igst' | 'cgst' | 'sgst' | 'cess') =>
      r2(group.reduce((a, x) => a + r2(x[f]), 0) - r2(b[f]));
    const diffComponents = {
      igst: component('igst'),
      cgst: component('cgst'),
      sgst: component('sgst'),
      cess: component('cess'),
    };

    if (blockedLine) {
      rows.push({
        ...base,
        status: 'ITC Blocked',
        matched_2b_id: matchId,
        matched_2b_month: matched2bMonth || undefined,
        two_b_taxable: r2(twobTaxable),
        two_b_igst: twobIgst,
        two_b_cgst: twobCgst,
        two_b_sgst: twobSgst,
        two_b_cess: twobCess,
        reverse_charge: twobRcm,
        two_b_itc: twobItc,
        itc_difference: diffItc,
        taxable_difference: diffTaxable,
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: blockedLine?.reason ?? primary.reason,
        action: `GSTR-2B me ITC available = "${blockedLine?.itc_availability ?? primary.itc_availability}"${blockedLine?.reason ?? primary.reason ? ` (${blockedLine?.reason ?? primary.reason})` : ''}. Ye credit claim nahi ho sakta — books se claim hataayein.`,
      });
      continue;
    }

    const amountOk =
      withinTolerance(diffTaxable, 0, tolerance) &&
      withinTolerance(diffItc, 0, tolerance) &&
      Object.values(diffComponents).every((d) => withinTolerance(d, 0, tolerance));

    if (amountOk) {
      rows.push({
        ...base,
        status: 'Matched',
        matched_2b_id: matchId,
        matched_2b_month: matched2bMonth || undefined,
        two_b_taxable: r2(twobTaxable),
        two_b_igst: twobIgst,
        two_b_cgst: twobCgst,
        two_b_sgst: twobSgst,
        two_b_cess: twobCess,
        reverse_charge: twobRcm,
        two_b_itc: twobItc,
        itc_difference: r2(diffItc),
        taxable_difference: r2(diffTaxable),
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        action: 'OK — GSTR-3B table 4(A) me claim kar sakte hain.',
      });
    } else {
      rows.push({
        ...base,
        status: 'Amount Mismatch',
        matched_2b_id: matchId,
        matched_2b_month: matched2bMonth || undefined,
        two_b_taxable: r2(twobTaxable),
        two_b_igst: twobIgst,
        two_b_cgst: twobCgst,
        two_b_sgst: twobSgst,
        two_b_cess: twobCess,
        reverse_charge: twobRcm,
        two_b_itc: twobItc,
        itc_difference: diffItc,
        taxable_difference: diffTaxable,
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: blockedLine?.reason ?? primary.reason,
        action:
          `GSTIN + document dono match hain par amount alag hai (taxable ${diffTaxable >= 0 ? '+' : ''}${diffTaxable}, ITC ${diffItc >= 0 ? '+' : ''}${diffItc}` +
          `; IGST ${diffComponents.igst}, CGST ${diffComponents.cgst}, SGST ${diffComponents.sgst}, Cess ${diffComponents.cess}). ` +
          'Vendor se corrected document ya 2B me amendment karwaayein. GSTR-3B me 2B wala amount claim karein.',
      });
    }
  }

  // ---- 2B lines nobody claimed ------------------------------------------
  const unbooked2b: ReconRow[] = [];
  for (let idx = 0; idx < twob.length; idx++) {
    const r = twob[idx];
    const matchId = twobId(r);
    if (claimed.has(matchId)) continue;
    // If the books had this key at all we already reported it as Missing in 2B
    // is impossible; this branch means the key truly has no book counterpart.
    const itc = taxOf(r);
    unbooked2b.push({
      // 'Missing in Books' — NOT 'Missing in 2B'. This row IS in GSTR-2B and is
      // absent from the purchase books. The two directions are opposite findings
      // and sharing one label made the exception reports unreadable.
      status: itcBlocked(r) ? 'ITC Blocked' : 'Missing in Books',
      our_gstin: normGstin(r.our_gstin),
      party_name: r.supplier_name,
      supplier_gstin: normGstin(r.supplier_gstin),
      invoice_no: String(r.invoice_no ?? '').trim(),
      invoice_date: r.invoice_date,
      period: r.period,
      document_type: normDocType(r.invoice_type),
      taxable_value: r2(r.taxable_value),
      igst: r2(r.igst),
      cgst: r2(r.cgst),
      sgst: r2(r.sgst),
      cess: r2(r.cess),
      itc,
      itc_availability: r.itc_availability,
      reverse_charge: r.reverse_charge,
      reason: r.reason,
      matched_2b_id: matchId,
      matched_2b_month: twobMonthOf(r) || undefined,
      action: itcBlocked(r)
        ? '2B me hai par purchase book me nahi, aur ITC blocked hai. Book nahi karna — claim hoga hi nahi.'
        : reducesItc(r)
          ? 'GSTR-2B me CREDIT NOTE hai par purchase book me nahi. Credit note book karein aur uska ITC REVERSE karein — credit note par claim nahi hota, ye credit lene ke bajaye wapas karna hota hai.'
          : 'GSTR-2B me hai par purchase book me nahi. Bills me book karein, tab 4(A) me claim kar sakte hain. Jaldi karein — 30 November ke baad ITC nahi milega.',
      source_file: r.source_file,
      source_row: r.source_row,
    });
  }

  // ---- Probable / Fuzzy Match Suggestions (Missing in 2B <-> Unbooked 2B) --
  const unbookedBySupplier = new Map<string, ReconRow[]>();
  for (const u of unbooked2b) {
    const sk = `${u.our_gstin}|${u.supplier_gstin}|${u.document_type || 'Tax Invoice'}`;
    if (!unbookedBySupplier.has(sk)) unbookedBySupplier.set(sk, []);
    unbookedBySupplier.get(sk)!.push(u);
  }
  for (const r of rows) {
    if (r.status !== 'Missing in 2B') continue;
    const sk = `${r.our_gstin}|${r.supplier_gstin}|${r.document_type || 'Tax Invoice'}`;
    const candidates = unbookedBySupplier.get(sk);
    if (!candidates || candidates.length === 0) continue;
    const cand = candidates.find(
      (c) => Math.abs(r2(c.taxable_value) - r2(r.taxable_value)) <= 2 && Math.abs(r2(c.itc) - r2(r.itc)) <= 2,
    );
    if (cand) {
      r.suggested_2b_invoice_no = cand.invoice_no;
      r.suggested_2b_date = cand.invoice_date;
      r.match_hint = `Probable 2B match: "${cand.invoice_no}" dated ${cand.invoice_date} (Taxable ${cand.taxable_value}, ITC ${cand.itc})`;
    }
  }

  // ---- summary -----------------------------------------------------------
  const byStatus = (s: ReconRow['status']) => rows.filter((r) => r.status === s);
  const sum = <T>(list: T[], f: (r: T) => number) =>
    r2(list.reduce((a, r) => a + r2(f(r)), 0));

  const booksItc = sum(rows, (r) => r.itc);
  const twobItc = r2(twob.reduce((a, r) => a + taxOf(r), 0));

  // Gross and reduction kept apart. A month with 10,00,000 of invoices and a
  // 2,00,000 credit note nets to 8,00,000, but "8,00,000 of purchases" and
  // "10,00,000 of purchases less 2,00,000 of credits" are different statements; a
  // CA reconciling a vendor account needs the second one.
  const grossRows = rows.filter((r) => r.document_type !== 'Credit Note');
  const creditRows = rows.filter((r) => r.document_type === 'Credit Note');
  const twobGross = twob.filter((r) => !isCreditDoc(r.invoice_type));
  const twobCredit = twob.filter((r) => isCreditDoc(r.invoice_type));
  const absSum = <T>(list: T[], f: (x: T) => number) =>
    r2(list.reduce((a, x) => a + Math.abs(r2(f(x))), 0));
  const docCounts = (types: string[]) => {
    let invoice = 0, debit = 0, credit = 0;
    for (const t of types) {
      const d = normDocType(t);
      if (d === 'Credit Note') credit++;
      else if (d === 'Debit Note') debit++;
      else invoice++;
    }
    return { invoice, debit, credit };
  };
  // Claimable = what GSTR-2B actually supports and 2B has not blocked — at face
  // value. This used to take min(tax, taxable value), which silently dropped
  // credit from any line whose tax exceeded its taxable value, and it is not a
  // rule in GST: the portal's tax figure IS the credit on offer.
  const claimableItc = r2(twob.filter((r) => !itcBlocked(r)).reduce((a, r) => a + taxOf(r), 0));


  return {
    rows,
    unbooked2b,
    summary: {
      books_rows: books.length,
      twob_rows: twob.length,
      matched: byStatus('Matched').length,
      amount_mismatch: byStatus('Amount Mismatch').length,
      itc_blocked: byStatus('ITC Blocked').length,
      missing_in_2b: byStatus('Missing in 2B').length,
      duplicate: byStatus('Duplicate').length,
      unbooked_2b: unbooked2b.length,
      books_itc: booksItc,
      twob_itc: twobItc,
      claimable_itc: claimableItc,
      books_taxable_gross: sum(grossRows, (r) => r.taxable_value),
      books_taxable_credit: absSum(creditRows, (r) => r.taxable_value),
      books_taxable_net: sum(rows, (r) => r.taxable_value),
      books_itc_gross: sum(grossRows, (r) => r.itc),
      books_itc_credit: absSum(creditRows, (r) => r.itc),
      twob_taxable_gross: sum(twobGross, (r) => r.taxable_value),
      twob_taxable_credit: absSum(twobCredit, (r) => r.taxable_value),
      twob_taxable_net: r2(twob.reduce((a, r) => a + r2(r.taxable_value), 0)),
      twob_itc_gross: r2(twobGross.reduce((a, r) => a + taxOf(r), 0)),
      twob_itc_credit: absSum(twobCredit, taxOf),
      books_docs: docCounts(rows.map((r) => r.document_type ?? 'Tax Invoice')),
      twob_docs: docCounts(twob.map((r) => r.invoice_type)),
    },
  };
}

/**
 * Roll reconciled rows up on any dimension the caller asks for.
 *
 * The dashboard needs the same numbers sliced three ways — by company, by
 * unit/GSTIN, and by month — so this stays generic rather than writing three
 * near-identical loops.
 */
export interface Slice {
  label: string;
  rows: number;
  taxable_value: number;
  itc: number;
  matched: number;
  amount_mismatch: number;
  itc_blocked: number;
  missing_in_2b: number;
  duplicate: number;
  unbooked_2b: number;
  claimable_itc: number;
}

export function sliceRecon(
  result: ReconResult,
  dimension: 'company' | 'unit' | 'period',
  companyOf: (gstin: string) => { label: string },
): Slice[] {
  const groups = new Map<string, Slice>();
  const bucket = (label: string): Slice => {
    if (!groups.has(label)) {
      groups.set(label, {
        label,
        rows: 0,
        taxable_value: 0,
        itc: 0,
        matched: 0,
        amount_mismatch: 0,
        itc_blocked: 0,
        missing_in_2b: 0,
        duplicate: 0,
        unbooked_2b: 0,
        claimable_itc: 0,
      });
    }
    return groups.get(label)!;
  };

  const dimOf = (r: ReconRow): string => {
    if (dimension === 'period') return r.period;
    if (dimension === 'unit') return r.unit_name || r.our_gstin;
    return companyOf(r.our_gstin).label;
  };

  for (const r of result.rows) {
    const g = bucket(dimOf(r));
    g.rows++;
    g.taxable_value = r2(g.taxable_value + r.taxable_value);
    g.itc = r2(g.itc + r.itc);
    const key = r.status.toLowerCase().replace(/\s+/g, '_') as keyof Slice;
    if (typeof g[key] === 'number') (g[key] as number)++;
  }
  for (const r of result.unbooked2b) {
    const g = bucket(dimOf(r));
    g.unbooked_2b++;
    if (r.status === 'ITC Blocked') g.itc_blocked++;
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Percent of book-side rows that are clean matches. Drives the health bar. */
export function matchPercent(s: ReconResult['summary']): number {
  const decided = s.books_rows - s.duplicate;
  if (decided <= 0) return 0;
  return Math.round((s.matched / decided) * 1000) / 10;
}
