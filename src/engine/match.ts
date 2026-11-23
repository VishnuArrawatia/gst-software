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
  fyOf,
  isCreditDoc,
  isSec16_4TimeBarred,
  normDocType,
  normGstin,
  normInvoice,
  r2,
  taxOf,
  withinTolerance,
  type DetailedReconStatus,
  type DocType,
  type Gstr2bRecord,
  type PurchaseBill,
  type ReconRow,
} from './core';

export type DateWindow = 'any' | 'exact' | '2days' | '5days' | 'month';

export interface ReconOptions {
  /** Rupee tolerance before a difference is real. Portal rounding is common. */
  tolerance?: number;
  /** Do not treat repeat GSTIN+invoice as an error (some vendors reuse numbers). */
  ignoreDuplicates?: boolean;
  /** Optional invoice-date matching window enforced on matched candidates. */
  dateWindow?: DateWindow;
  /** 2B line ids already matched to purchase lines in OTHER months (excluded from matching). */
  claimedElsewhere?: Set<string>;
  /** When true, strictly enforce Tax Invoice↔Tax Invoice, DN↔DN, CN↔CN. */
  strictDocType?: boolean;
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
  extra_taxable: number;
  extra_igst: number;
  extra_cgst: number;
  extra_sgst: number;
  extra_utgst: number;
  extra_cess: number;
  has_extra_charges: boolean;
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

  const extra_taxable = r2(b.recon_extra_taxable ?? 0);
  const extra_igst = r2(b.recon_extra_igst ?? 0);
  const extra_cgst = r2(b.recon_extra_cgst ?? 0);
  const extra_sgst = r2(b.recon_extra_sgst ?? 0);
  const extra_utgst = r2(b.recon_extra_utgst ?? 0);
  const extra_cess = r2(b.recon_extra_cess ?? 0);
  const has_extra_charges =
    extra_taxable !== 0 ||
    extra_igst !== 0 ||
    extra_cgst !== 0 ||
    extra_sgst !== 0 ||
    extra_utgst !== 0 ||
    extra_cess !== 0;

  return {
    supplier_gstin: g,
    invoice_no: i,
    invoice_date: d,
    extra_taxable,
    extra_igst,
    extra_cgst,
    extra_sgst,
    extra_utgst,
    extra_cess,
    has_extra_charges,
    edited: g !== bookGstin || i !== bookInv || d !== bookDate || has_extra_charges,
  };
}

function keyOf(gstin: unknown, invoiceNo: unknown, ourGstin?: unknown): string {
  const og = normGstin(ourGstin);
  return og ? `${og}|${normGstin(gstin)}|${normInvoice(invoiceNo)}` : `${normGstin(gstin)}|${normInvoice(invoiceNo)}`;
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

type TaxAmounts = { taxable_value: number; igst: number; cgst: number; sgst: number; cess: number };

function isAllNegative(d: TaxAmounts): boolean {
  const nonZero = [d.taxable_value, d.igst, d.cgst, d.sgst, d.cess].map(r2).filter((n) => n !== 0);
  return nonZero.length > 0 && nonZero.every((n) => n < 0);
}

/**
 * Effective ledger polarity (`credit` reduces ITC; `debit` adds ITC).
 * Buyers frequently book purchase returns as negative "Debit Note" rows while
 * suppliers report them in GSTR-2B CDNR as Credit Notes — both share `credit`
 * polarity and match safely without ever matching a positive invoice.
 */
function docPolarity(doc: DocType, d: TaxAmounts): 'credit' | 'debit' {
  if (doc === 'Credit Note' || isAllNegative(d)) return 'credit';
  return 'debit';
}

function daysBetween(a?: string, b?: string): number {
  if (!a || !b) return 9999;
  const ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a).trim());
  const mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b).trim());
  if (!ma || !mb) return 9999;
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round(Math.abs(ta - tb) / 86400000);
}

function monthDiffAbs(a?: string, b?: string): number {
  const ma = /^(\d{4})-(\d{2})/.exec(String(a || '').trim());
  const mb = /^(\d{4})-(\d{2})/.exec(String(b || '').trim());
  if (!ma || !mb) return 999;
  return Math.abs((Number(ma[1]) * 12 + Number(ma[2])) - (Number(mb[1]) * 12 + Number(mb[2])));
}

function dateWithinWindow(bookDate: string, twobDate: string, window: DateWindow): boolean {
  if (window === 'any' || !bookDate || !twobDate) return true;
  if (window === 'exact') return daysBetween(bookDate, twobDate) === 0;
  if (window === '2days') return daysBetween(bookDate, twobDate) <= 2;
  if (window === '5days') return daysBetween(bookDate, twobDate) <= 5;
  if (window === 'month') return bookDate.slice(0, 7) === twobDate.slice(0, 7);
  return true;
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
  const dateWindow: DateWindow = opts.dateWindow ?? 'any';
  const claimedElsewhere = opts.claimedElsewhere;
  // Phase 1 mandatory rule: strictly prevent Tax Invoice, Debit Note and Credit
  // Note from matching each other unless a caller explicitly opts out.
  const strictDocType = opts.strictDocType !== false;

  // Give every 2B line a stable id up front. Both the matching pass and the
  // unbooked pass then read the SAME id for the same row.
  twob = twob.map((r, i) => ({ ...r, id: r.id || `2b#${i}` }));

  // ---- index the 2B side, and note repeats -------------------------------
  const twobByKey = new Map<string, Gstr2bRecord[]>();
  for (const r of twob) {
    const k = keyOf(r.supplier_gstin, r.invoice_no, r.our_gstin);
    if (!twobByKey.has(k)) twobByKey.set(k, []);
    twobByKey.get(k)!.push(r);
  }

  // ---- count repeats on the books side (keyed by ourGSTIN + GSTIN + inv + exact docType) -
  // A Tax Invoice, Debit Note, and Credit Note sharing the same reference number
  // are distinct economic events, never a duplicate booking.
  const booksKeyCount = new Map<string, number>();
  const booksSoftPosCount = new Map<string, string[]>();
  for (const b of books) {
    const m = matchValuesOf(b);
    const bDoc = bookDocOf(b);
    const dk = `${keyOf(m.supplier_gstin, m.invoice_no, b.our_gstin)}|${bDoc}`;
    booksKeyCount.set(dk, (booksKeyCount.get(dk) || 0) + 1);

    const softK = `${normGstin(b.our_gstin)}|${normGstin(m.supplier_gstin)}|${bDoc}|${m.invoice_date || ''}|${r2(b.taxable_value).toFixed(2)}|${taxOf(b).toFixed(2)}`;
    if (!booksSoftPosCount.has(softK)) booksSoftPosCount.set(softK, []);
    booksSoftPosCount.get(softK)!.push(`${b.source_file || 'books'}#${b.source_row ?? ''}:${m.invoice_no}`);
  }

  // Diagnostic index for SUPPLIER GSTIN MISMATCH & DOCUMENT TYPE MISMATCH
  const twobByOurAndInv = new Map<string, Gstr2bRecord[]>();
  for (const r of twob) {
    const ik = `${normGstin(r.our_gstin)}|${normInvoice(r.invoice_no)}`;
    if (!twobByOurAndInv.has(ik)) twobByOurAndInv.set(ik, []);
    twobByOurAndInv.get(ik)!.push(r);
  }

  const claimed = new Set<string>();
  const rows: ReconRow[] = [];

  for (const b of books) {
    const mv = matchValuesOf(b);
    const k = keyOf(mv.supplier_gstin, mv.invoice_no, b.our_gstin);
    const itc = taxOf(b);
    // Effective Books-side amounts for GSTR-2B comparison (Books + Additional Charges overlay).
    // Original book_* values are preserved intact on `base` (immutable).
    const effTaxable = r2(r2(b.taxable_value) + mv.extra_taxable);
    const effIgst = r2(r2(b.igst) + mv.extra_igst);
    const effCgst = r2(r2(b.cgst) + mv.extra_cgst);
    const effSgst = r2(r2(b.sgst) + mv.extra_sgst);
    const effUtgst = r2(r2(b.utgst ?? 0) + mv.extra_utgst);
    const effCess = r2(r2(b.cess) + mv.extra_cess);
    const effItc = taxOf({ igst: effIgst, cgst: effCgst, sgst: effSgst, utgst: effUtgst, cess: effCess });
    const bookDoc = bookDocOf(b);
    const bookPol = docPolarity(bookDoc, b);
    const dk = `${k}|${bookDoc}`;

    // Candidate 2B lines: same normalized ourGSTIN + supplierGSTIN + Invoice No + exact docType (strictDocType=true),
    // and not already claimed in this run or in another month's purchase register.
    const rawBucket = (twobByKey.get(k) || []).filter((x) => {
      const id = twobId(x);
      if (claimed.has(id) || claimedElsewhere?.has(id)) return false;
      const tDoc = twobDocOf(x);
      if (strictDocType && tDoc !== bookDoc) return false;
      return docPolarity(tDoc, x) === bookPol;
    });

    const base: ReconRow = {
      book_line_id: b.id,
      status: 'Pending Review',
      our_gstin: normGstin(b.our_gstin),
      unit_name: b.unit_name,
      party_name: b.party_name,
      supplier_gstin: normGstin(b.supplier_gstin),
      invoice_no: String(b.invoice_no ?? '').trim(),
      invoice_date: b.invoice_date,
      period: b.period,
      matched_on_recon: mv.edited || undefined,
      recon_extra_charges_type: b.recon_extra_charges_type || undefined,
      recon_extra_taxable: mv.has_extra_charges ? mv.extra_taxable : undefined,
      recon_extra_igst: mv.has_extra_charges ? mv.extra_igst : undefined,
      recon_extra_cgst: mv.has_extra_charges ? mv.extra_cgst : undefined,
      recon_extra_sgst: mv.has_extra_charges ? mv.extra_sgst : undefined,
      recon_extra_utgst: mv.has_extra_charges ? mv.extra_utgst : undefined,
      recon_extra_cess: mv.has_extra_charges ? mv.extra_cess : undefined,
      document_type: bookDoc,
      taxable_value: r2(b.taxable_value),
      igst: r2(b.igst),
      cgst: r2(b.cgst),
      sgst: r2(b.sgst),
      utgst: r2(b.utgst ?? 0),
      cess: r2(b.cess),
      itc,
      duplicate_count: booksKeyCount.get(dk),
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
    if (!opts.ignoreDuplicates && (booksKeyCount.get(dk) || 0) > 1) {
      rows.push({
        ...base,
        status: 'Duplicate',
        detailed_status: 'DUPLICATE',
        duplicate_ref: `DUP:${mv.supplier_gstin}|${mv.invoice_no} (x${booksKeyCount.get(dk)})`,
        action:
          'Purchase register me ye same GSTIN + Invoice No 2 ya zyada baar hai. Duplicate booking hoga to ITC double claim ho jayega — pehle duplicate entry delete/void karein.',
      });
      continue;
    }

    // Group candidate 2B lines by (twobMonth, docType, source_file) so multi-rate
    // lines of one invoice in one 2B upload sum cleanly without multiplying when
    // the same GSTR-2B file was uploaded more than once under renamed filenames.
    const groupsByMonthDoc = new Map<string, Gstr2bRecord[]>();
    for (const x of rawBucket) {
      const gm = twobMonthOf(x) || x.period || '';
      const gk = `${gm}|${twobDocOf(x)}|${x.source_file || ''}`;
      if (!groupsByMonthDoc.has(gk)) groupsByMonthDoc.set(gk, []);
      groupsByMonthDoc.get(gk)!.push(x);
    }

    interface ScoredGroup {
      group: Gstr2bRecord[];
      month: string;
      twobTaxable: number;
      twobIgst: number;
      twobCgst: number;
      twobSgst: number;
      twobUtgst: number;
      twobCess: number;
      twobItc: number;
      diffItc: number;
      diffTaxable: number;
      diffComponents: { igst: number; cgst: number; sgst: number; utgst: number; cess: number };
      amountExact: boolean;
      exactDate: boolean;
      within60Days: boolean;
      minDateDiff: number;
      mDiff: number;
      exactDoc: boolean;
      amtDiff: number;
    }

    const scoredGroups: ScoredGroup[] = [];
    for (const grp of groupsByMonthDoc.values()) {
      const m0 = twobMonthOf(grp[0]) || grp[0].period || '';
      const twobTaxable = r2(grp.reduce((a, x) => a + r2(x.taxable_value), 0));
      const twobIgst = r2(grp.reduce((a, x) => a + r2(x.igst), 0));
      const twobCgst = r2(grp.reduce((a, x) => a + r2(x.cgst), 0));
      const twobSgst = r2(grp.reduce((a, x) => a + r2(x.sgst), 0));
      const twobUtgst = r2(grp.reduce((a, x) => a + r2(x.utgst ?? 0), 0));
      const twobCess = r2(grp.reduce((a, x) => a + r2(x.cess), 0));
      const twobItc = r2(grp.reduce((a, x) => a + taxOf(x), 0));
      const diffItc = r2(twobItc - effItc);
      const diffTaxable = r2(twobTaxable - effTaxable);
      const diffComponents = {
        igst: r2(twobIgst - effIgst),
        cgst: r2(twobCgst - effCgst),
        sgst: r2(twobSgst - effSgst),
        utgst: r2(twobUtgst - effUtgst),
        cess: r2(twobCess - effCess),
      };
      const amountExact =
        withinTolerance(diffTaxable, 0, tolerance) &&
        withinTolerance(diffItc, 0, tolerance) &&
        Object.values(diffComponents).every((d) => withinTolerance(d, 0, tolerance));
      const minDateDiff = grp.reduce((mn, x) => Math.min(mn, daysBetween(mv.invoice_date, x.invoice_date)), 9999);
      scoredGroups.push({
        group: grp,
        month: m0,
        twobTaxable,
        twobIgst,
        twobCgst,
        twobSgst,
        twobUtgst,
        twobCess,
        twobItc,
        diffItc,
        diffTaxable,
        diffComponents,
        amountExact,
        exactDate: minDateDiff === 0,
        within60Days: minDateDiff <= 60,
        minDateDiff,
        mDiff: monthDiffAbs(b.period, m0),
        exactDoc: grp.some((x) => twobDocOf(x) === bookDoc),
        amtDiff: Math.abs(diffTaxable) + Math.abs(diffItc),
      });
    }

    scoredGroups.sort((a, z) => {
      if (a.amountExact !== z.amountExact) return a.amountExact ? -1 : 1;
      if (a.exactDate !== z.exactDate) return a.exactDate ? -1 : 1;
      if (a.within60Days !== z.within60Days) return a.within60Days ? -1 : 1;
      if (a.minDateDiff !== z.minDateDiff) return a.minDateDiff - z.minDateDiff;
      if (a.mDiff !== z.mDiff) return a.mDiff - z.mDiff;
      if (a.exactDoc !== z.exactDoc) return a.exactDoc ? -1 : 1;
      return a.amtDiff - z.amtDiff;
    });

    const best = scoredGroups[0];
    // Cross-FY collision guard: never pair a book invoice with a 180+ day old/future
    // GSTR-2B bill whose invoice number collided across FY resets if amounts also disagree.
    const crossFyCollision = !!(
      best && !best.amountExact && best.minDateDiff > 180 && best.minDateDiff < 9999
    );

    if (!best || crossFyCollision) {
      // Classify exact mismatch diagnosis among unbooked 2B / Books without auto-matching
      const sameKeyDiffType = (twobByKey.get(k) || []).find(
        (x) => !claimed.has(twobId(x)) && !claimedElsewhere?.has(twobId(x)) && twobDocOf(x) !== bookDoc,
      );
      const sameInvDiffGstin = (twobByOurAndInv.get(`${normGstin(b.our_gstin)}|${normInvoice(mv.invoice_no)}`) || []).find(
        (x) =>
          !claimed.has(twobId(x)) &&
          !claimedElsewhere?.has(twobId(x)) &&
          normGstin(x.supplier_gstin) !== mv.supplier_gstin &&
          twobDocOf(x) === bookDoc &&
          withinTolerance(x.taxable_value, b.taxable_value, Math.max(2, tolerance)) &&
          withinTolerance(taxOf(x), itc, Math.max(2, tolerance)),
      );
      const softK = `${normGstin(b.our_gstin)}|${normGstin(mv.supplier_gstin)}|${bookDoc}|${mv.invoice_date || ''}|${r2(b.taxable_value).toFixed(2)}|${itc.toFixed(2)}`;
      const softCluster = booksSoftPosCount.get(softK) || [];

      let detailedMissing: DetailedReconStatus = 'BOOKS ONLY';
      let dupRef: string | undefined;
      if (sameKeyDiffType) detailedMissing = 'DOCUMENT TYPE MISMATCH';
      else if (sameInvDiffGstin) detailedMissing = 'SUPPLIER GSTIN MISMATCH';
      else if (softCluster.length > 1) {
        detailedMissing = 'POSSIBLE DUPLICATE';
        dupRef = softCluster.slice(0, 3).join('; ');
      }

      rows.push({
        ...base,
        status: 'Missing in 2B',
        detailed_status: detailedMissing,
        duplicate_ref: dupRef,
        action:
          'Purchase book me hai par GSTR-2B me nahi. Vendor se GSTR-1 me daal kar file karwaayein; tab tak ispe ITC claim mat karein (cl.16(2)(b)).',
      });
      continue;
    }

    const group = best.group;
    const primary = group.find((x) => x.invoice_date === mv.invoice_date) || group[0];
    const matched2bMonth = best.month;
    const bestDoc = twobDocOf(group[0]);
    for (const g of rawBucket) {
      const gm = twobMonthOf(g) || g.period || '';
      if (gm === matched2bMonth && twobDocOf(g) === bestDoc) {
        claimed.add(twobId(g));
      }
    }

    const matchId = twobId(primary);
    const blockedLine = group.find(itcBlocked);
    const {
      twobTaxable,
      twobIgst,
      twobCgst,
      twobSgst,
      twobUtgst,
      twobCess,
      twobItc,
      diffItc,
      diffTaxable,
      diffComponents,
    } = best;
    const twobRcm = b.reverse_charge ?? group.some((x) => x.reverse_charge);
    const gapDays = mv.invoice_date && primary.invoice_date ? daysBetween(mv.invoice_date, primary.invoice_date) : undefined;
    const crossFy = Boolean(matched2bMonth && b.period && fyOf(matched2bMonth) !== fyOf(b.period));
    const subsequentMonth = Boolean(matched2bMonth && b.period && matched2bMonth !== b.period);
    const docNoDiff =
      String(mv.invoice_no ?? '').trim() !== String(primary.invoice_no ?? '').trim()
        ? `${mv.invoice_no} vs ${primary.invoice_no}`
        : undefined;
    const twoBFields = {
      matched_2b_id: matchId,
      matched_2b_month: matched2bMonth || undefined,
      doc_category: (primary as any).doc_category || undefined,
      two_b_supplier_gstin: normGstin(primary.supplier_gstin),
      two_b_invoice_no: String(primary.invoice_no ?? '').trim(),
      two_b_invoice_date: primary.invoice_date || '',
      two_b_taxable: r2(twobTaxable),
      two_b_igst: twobIgst,
      two_b_cgst: twobCgst,
      two_b_sgst: twobSgst,
      two_b_utgst: twobUtgst,
      two_b_cess: twobCess,
      reverse_charge: twobRcm,
      two_b_itc: twobItc,
      itc_difference: diffItc,
      taxable_difference: diffTaxable,
      subsequent_month_match: subsequentMonth,
      cross_fy_match: crossFy,
      matched_after_books_correction: mv.edited || undefined,
      date_diff_days: gapDays,
      doc_no_diff: docNoDiff,
      match_type: mv.edited
        ? 'Books Correction Match'
        : crossFy
          ? 'Cross-FY Match'
          : subsequentMonth
            ? 'Subsequent Month Match'
            : 'Same Month Match',
    };

    if (blockedLine) {
      rows.push({
        ...base,
        ...twoBFields,
        status: 'ITC Blocked',
        detailed_status: 'PENDING MANUAL REVIEW',
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: blockedLine?.reason ?? primary.reason,
        action: `GSTR-2B me ITC available = "${blockedLine?.itc_availability ?? primary.itc_availability}"${blockedLine?.reason ?? primary.reason ? ` (${blockedLine?.reason ?? primary.reason})` : ''}. Ye credit claim nahi ho sakta — books se claim hataayein.`,
      });
      continue;
    }

    const amountOk = best.amountExact;
    const dateOk = dateWithinWindow(mv.invoice_date, primary.invoice_date || '', dateWindow);
    const taxableDiffers = !withinTolerance(diffTaxable, 0, tolerance);
    const typeMismatch = bookDoc !== bestDoc;

    if (typeMismatch) {
      rows.push({
        ...base,
        ...twoBFields,
        status: 'Amount Mismatch',
        detailed_status: 'DOCUMENT TYPE MISMATCH',
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: `Document type mismatch: Books ${bookDoc} vs GSTR-2B ${bestDoc}`,
        action: `Books me "${bookDoc}" hai par GSTR-2B me "${bestDoc}" hai — document type verify karein.`,
      });
    } else if (amountOk && dateOk) {
      let ds: DetailedReconStatus = 'MATCHED IN SAME MONTH';
      if (mv.edited) ds = 'MATCHED AFTER BOOKS CORRECTION';
      else if (crossFy) ds = 'MATCHED IN SUBSEQUENT FINANCIAL YEAR';
      else if (subsequentMonth) ds = 'MATCHED IN SUBSEQUENT MONTH';

      rows.push({
        ...base,
        ...twoBFields,
        status: 'Matched',
        detailed_status: ds,
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        action: 'OK — GSTR-3B table 4(A) me claim kar sakte hain.',
      });
    } else if (amountOk && !dateOk) {
      const dateReason = `Invoice date mismatch: Books ${mv.invoice_date} vs 2B ${primary.invoice_date} (${gapDays} days, window: ${dateWindow})`;
      rows.push({
        ...base,
        ...twoBFields,
        status: 'Amount Mismatch',
        detailed_status: 'DOCUMENT DATE MISMATCH',
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: dateReason,
        action:
          `${dateReason}. Books me recon date check karein ya Date Window setting badlein.`,
      });
    } else {
      const ds: DetailedReconStatus = taxableDiffers
        ? 'MATCHED WITH TAXABLE DIFFERENCE'
        : 'MATCHED WITH TAX DIFFERENCE';
      rows.push({
        ...base,
        ...twoBFields,
        status: 'Amount Mismatch',
        detailed_status: ds,
        itc_availability: blockedLine?.itc_availability ?? primary.itc_availability,
        reason: blockedLine?.reason ?? primary.reason,
        action:
          `GSTIN + document dono match hain par amount alag hai (taxable ${diffTaxable >= 0 ? '+' : ''}${diffTaxable}, ITC ${diffItc >= 0 ? '+' : ''}${diffItc}` +
          `; IGST ${diffComponents.igst}, CGST ${diffComponents.cgst}, SGST ${diffComponents.sgst}, UTGST ${diffComponents.utgst}, Cess ${diffComponents.cess}). ` +
          'Vendor se corrected document ya 2B me amendment karwaayein. GSTR-3B me 2B wala amount claim karein.',
      });
    }
  }

  // ---- 2B lines nobody claimed ------------------------------------------
  // If the same 2B invoice appears across multiple uploaded source_files, only emit
  // rows from the newest upload so multi-upload copies never inflate Missing-in-Books.
  const latestUnbookedSourceByInv = new Map<string, string>();
  for (const r of twob) {
    if (claimed.has(twobId(r))) continue;
    const ik = `${normGstin(r.our_gstin)}|${keyOf(r.supplier_gstin, r.invoice_no)}|${twobMonthOf(r) || r.period || ''}|${twobDocOf(r)}`;
    latestUnbookedSourceByInv.set(ik, r.source_file || '');
  }

  const unbooked2b: ReconRow[] = [];
  for (let idx = 0; idx < twob.length; idx++) {
    const r = twob[idx];
    const matchId = twobId(r);
    if (claimed.has(matchId)) continue;
    const ik = `${normGstin(r.our_gstin)}|${keyOf(r.supplier_gstin, r.invoice_no)}|${twobMonthOf(r) || r.period || ''}|${twobDocOf(r)}`;
    const chosenSrc = latestUnbookedSourceByInv.get(ik);
    if (chosenSrc !== undefined && (r.source_file || '') !== chosenSrc) continue;
    // If the books had this key at all we already reported it as Missing in 2B
    // is impossible; this branch means the key truly has no book counterpart.
    const itc = taxOf(r);
    unbooked2b.push({
      // 'Missing in Books' — NOT 'Missing in 2B'. This row IS in GSTR-2B and is
      // absent from the purchase books. The two directions are opposite findings
      // and sharing one label made the exception reports unreadable.
      status: itcBlocked(r) ? 'ITC Blocked' : 'Missing in Books',
      detailed_status: itcBlocked(r) ? 'PENDING MANUAL REVIEW' : 'GSTR-2B ONLY',
      doc_category: r.doc_category,
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
      utgst: r2(r.utgst ?? 0),
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
    if (u.matched_2b_id && claimedElsewhere?.has(u.matched_2b_id)) continue;
    const pol = docPolarity(u.document_type || 'Tax Invoice', u);
    const sk = `${u.our_gstin}|${u.supplier_gstin}|${pol}`;
    if (!unbookedBySupplier.has(sk)) unbookedBySupplier.set(sk, []);
    unbookedBySupplier.get(sk)!.push(u);
  }
  const probTol = Math.max(2, tolerance);
  const usedProbIds = new Set<string>();
  for (const r of rows) {
    if (r.status !== 'Missing in 2B') continue;
    const pol = docPolarity(r.document_type || 'Tax Invoice', r);
    const sk = `${r.our_gstin}|${r.supplier_gstin}|${pol}`;
    const cands = (unbookedBySupplier.get(sk) || [])
      .filter((c) => {
        if (c.matched_2b_id && usedProbIds.has(c.matched_2b_id)) return false;
        return Math.abs(r2(c.taxable_value) - r2(r.taxable_value)) <= probTol &&
               Math.abs(r2(c.itc) - r2(r.itc)) <= probTol;
      })
      .sort((a, z) => {
        const da = daysBetween(r.invoice_date, a.invoice_date);
        const dz = daysBetween(r.invoice_date, z.invoice_date);
        if (da !== dz) return da - dz;
        return monthDiffAbs(r.period, a.matched_2b_month || a.period) -
               monthDiffAbs(r.period, z.matched_2b_month || z.period);
      });
    const cand = cands[0];
    if (cand) {
      if (cand.matched_2b_id) usedProbIds.add(cand.matched_2b_id);
      r.suggested_2b_invoice_no = cand.invoice_no;
      r.suggested_2b_date = cand.invoice_date;
      r.match_hint = `Probable 2B match: "${cand.invoice_no}" dated ${cand.invoice_date} (Taxable ${cand.taxable_value}, ITC ${cand.itc})`;
      if (r.detailed_status === 'BOOKS ONLY' && (cand.document_type || 'Tax Invoice') === (r.document_type || 'Tax Invoice')) {
        r.detailed_status = 'DOCUMENT NUMBER MISMATCH';
      }
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
  const twobGross = twob.filter((r) => twobDocOf(r) !== 'Credit Note');
  const twobCredit = twob.filter((r) => twobDocOf(r) === 'Credit Note');
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
