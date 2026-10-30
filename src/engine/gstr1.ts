/**
 * GST ERP — GSTR-1 builder.
 *
 * Reads the SAP sales register and produces a complete GSTR-1 for one GSTIN and
 * one period: B2B, B2CL, B2CS, CDNR, CDNUR, the HSN summary, and the portal
 * JSON.
 *
 * PLACEMENT RULES THAT MATTER MOST
 *   - Customer has a GSTIN            -> B2B
 *   - Customer has no GSTIN, has POS  -> B2CL  (inter-state) / B2CS (intra-state)
 *   - Cash / no POS / export          -> B2CS (or EXP, not modelled yet)
 *   - Credit or debit note to a REGISTERED customer   -> CDNR (table 9A), and it
 *                                        must carry the original invoice number
 *                                        and date.
 *   - Credit or debit note to an UNREGISTERED customer -> CDNUR (table 9B), and
 *                                        it carries `typ` instead of a GSTIN:
 *                                        how the ORIGINAL supply was reported.
 *
 * A credit note filed into B2B instead of CDNR is rejected by the portal, and a
 * CDNR without the linked original is rejected too, so both are validated here
 * rather than left for the CA to discover at filing time.
 */

import {
  effectiveRate,
  fyOf,
  isCreditNote,
  labelOf,
  r2,
  stateOf,
  supplyType,
  taxOf,
  type GstInvoiceForReturn,
  type InvoiceType,
} from './core';

export type Table = 'B2B' | 'B2CL' | 'B2CS' | 'CDNR' | 'CDNUR' | 'EXP' | 'NIL';

export type NilSupplyType = 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C';

export interface NilRow {
  sply_ty: NilSupplyType;
  nil_amt: number;
  expt_amt: number;
  ngsup_amt: number;
}

/**
 * B2CL is defined by a threshold on the INVOICE VALUE of an inter-state supply
 * to an unregistered recipient. Below (or at) that threshold the same invoice
 * belongs to B2CS, and the portal rejects a B2CL row for it. It is a value
 * test, not a taxable-value test — the threshold is on the invoice as printed.
 *
 * THE THRESHOLD IS NOT A CONSTANT. It was Rs 2,50,000 until 31 July 2024; on the
 * recommendation of the 53rd GST Council (Notification 12/2024-Central Tax) it
 * was lowered to Rs 1,00,000 for tax periods from August 2024 onward. A report
 * built on 2025-26 data with the old Rs 2.5 lakh figure files a Rs 1.5 lakh
 * inter-state B2C sale as a consolidated B2CS row instead of invoice-wise B2CL,
 * which is the wrong table on the return.
 */
export const B2CL_THRESHOLD = 100000;
/** The threshold that applied up to and including July 2024. */
export const B2CL_THRESHOLD_LEGACY = 250000;

/** The B2CL threshold for a tax period (`YYYY-MM`); the current rule if unknown. */
export function b2clThresholdFor(period: string): number {
  return period && period < '2024-08' ? B2CL_THRESHOLD_LEGACY : B2CL_THRESHOLD;
}

export interface ReturnItem {
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Item serial inside the invoice (`itms[].num`). Falls back to the position. */
  num?: number;
  /** Only meaningful on the HSN summary — the portal has no HSN per item. */
  hsn?: string;
  uqc?: string;
  qty?: number;
  desc?: string;
}

export interface ReturnInvoice {
  table: Table;
  counterpartyGstin: string;
  counterpartyName: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string;
  reverseCharge: boolean;
  invoiceType: InvoiceType;
  items: ReturnItem[];
  /** CDNR only — the invoice being credited or debited. */
  noteRefNo?: string;
  noteRefDate?: string;
  /**
   * CDNUR only. Table 9B has no GSTIN to group on, so each note declares `typ`
   * — how the ORIGINAL supply it corrects was reported (B2CL, B2CS, or one of
   * the two export types).
   */
  noteType?: 'B2CL' | 'B2CS' | 'EXPWP' | 'EXPWOP';
  /**
   * The document series this row belongs to, when the register declares one.
   * Carried per invoice only so the DOC_ISSUED table can be summarised; it is
   * not part of the invoice itself.
   */
  docNature?: string;
  docSeriesFrom?: number;
  docSeriesTo?: number;
  docSeriesCancelled?: number;
}

/**
 * Which side of the return an HSN bucket belongs to.
 *
 * B2B is a registered counterparty (tables 4A and 9A), B2C an unregistered one
 * (5A/5B and 9B). The HSN summary itself is one table on the portal, but the
 * Accounts team reconciles it in two halves — a B2C row that looks short is a
 * different conversation from a B2B one — so the split is computed here, once,
 * from the same condition that routed the invoice.
 */
export type HsnScope = 'B2B' | 'B2C';

export interface HsnRow {
  hsn: string;
  uqc: string;
  rateIn: number;
  rateOut: number;
  /** Description of the goods/service, where the register gives one. */
  desc: string;
  /** Total quantity of this HSN + UQC + rate. 0 when the register has no qty. */
  qty: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/**
 * A B2CS bucket: one place of supply at one rate.
 *
 * Table 7 is reported state-wise, so the POS is part of the bucket's identity,
 * not decoration. Bucketing by rate alone put two states' supplies into one row,
 * and the portal JSON then had no `pos` to declare. The importer already insists
 * on a place of supply for an unregistered recipient (spec V13) precisely
 * because a B2CS row without one cannot be reported, so the value is available
 * and was simply being thrown away at the last step.
 */
export interface B2csBucket extends ReturnItem {
  /** Place-of-supply state code, as reported on the return. */
  pos: string;
}

/**
 * An HSN bucket that knows which side of the return it belongs to.
 *
 * The PORTAL table 12 does not split B2B from B2C — one HSN at one rate is one
 * row — so the merged `HsnRow[]` stays exactly what it always was and the portal
 * JSON is unchanged. This is the extra dimension the Accounts team reconciles
 * in, kept alongside rather than folded into the filed shape.
 */
export interface ScopedHsnRow extends HsnRow {
  /** B2B (registered counterparty) or B2C (unregistered). */
  scope: HsnScope;
}

export interface Gstr1Model {
  gstin: string;
  period: string;
  periodLabel: string;
  financialYear: string;
  b2b: ReturnInvoice[];
  b2cl: ReturnInvoice[];
  b2cs: B2csBucket[];
  cdnr: ReturnInvoice[];
  /** Table 9B — credit / debit notes to unregistered recipients. */
  cdnur: ReturnInvoice[];
  /** Table 6A — exports (EXPWP / EXPWOP). */
  exp: ReturnInvoice[];
  /** Table 8 — nil-rated, exempted, and non-GST outward supplies. */
  nil: NilRow[];
  /** Table 12 as one summary — B2B and B2C merged, as the portal files it. */
  hsn: HsnRow[];
  /** Table 12 restricted to registered recipients (4A / 9A). */
  hsnB2b: ScopedHsnRow[];
  /** Table 12 restricted to unregistered recipients (5A / 5B / 9B). */
  hsnB2c: ScopedHsnRow[];
  /** Problems that would make the portal reject the return. */
  validation: ValidationIssue[];
  totals: {
    invoices: number;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    invoiceValue: number;
    creditNotes: number;
  };
}

export interface ValidationIssue {
  severity: 'ERROR' | 'WARNING';
  invoiceNo: string;
  message: string;
}

/**
 * An invoice's `itms` — one entry per ITEM line, not one blended entry.
 *
 * An invoice carrying goods at 18% and a taxable freight line at 18% is two
 * `itm_det` lines on the portal, each with its own taxable value and tax. The
 * old code collapsed every invoice into a single blended bucket, so the portal
 * never saw the item break-up and the HSN summary could only report one rate
 * per invoice with no quantity.
 *
 * The rate is the one PRINTED on the line when the file gives it. Deriving it
 * from tax ÷ taxable is only a fallback: it snaps to the nearest slab and would
 * quietly hide a 12% line charged at 18%.
 */
/**
 * The HSN scope of an invoice, from the recipient.
 *
 * This mirrors the routing exactly: a 15-character customer GSTIN is a
 * registered recipient (4A, or 9A for a note), anything else is B2C (5A / 5B,
 * or 9B for a note). Kept as one line so the HSN split and the return tables
 * cannot drift apart.
 */
function hsnScopeOf(customerGstin: string): HsnScope {
  return customerGstin.length === 15 ? 'B2B' : 'B2C';
}

/** HSN rows in a stable order: HSN, then rate. */
function sortHsn<T extends HsnRow>(rows: T[]): T[] {
  return rows.sort(
    (a, b) => (a.hsn || '').localeCompare(b.hsn || '') || a.rateOut - b.rateOut,
  );
}

/**
 * Fold the B2B and B2C buckets back into the single table 12 the portal files:
 * one row per HSN/SAC + UQC + rate, quantities and amounts summed.
 *
 * The split is a reconciliation dimension, not a filing one. Merging here —
 * rather than at each consumer — is what keeps the portal JSON and the workbook
 * sheet byte-identical to what they were before the split existed.
 */
function mergeHsnByHsnUqcRate(rows: ScopedHsnRow[]): HsnRow[] {
  const out = new Map<string, HsnRow>();
  for (const r of rows) {
    const key = `${r.hsn}|${r.uqc}|${r.rateOut}`;
    const cur = out.get(key);
    if (!cur) {
      // `scope` is deliberately dropped: it has no meaning on the filed table.
      out.set(key, {
        hsn: r.hsn, uqc: r.uqc, rateIn: r.rateIn, rateOut: r.rateOut, desc: r.desc,
        qty: r.qty, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
      });
      continue;
    }
    cur.qty = r2(cur.qty + r.qty);
    cur.taxable = r2(cur.taxable + r.taxable);
    cur.igst = r2(cur.igst + r.igst);
    cur.cgst = r2(cur.cgst + r.cgst);
    cur.sgst = r2(cur.sgst + r.sgst);
    cur.cess = r2(cur.cess + r.cess);
    if (!cur.desc && r.desc) cur.desc = r.desc;
  }
  return sortHsn([...out.values()]);
}

function itemsOf(inv: GstInvoiceForReturn): ReturnItem[] {
  const items = inv.items ?? [];
  if (items.length > 0) {
    return items.map((it) => ({
      rate:
        it.gst_rate !== undefined && it.gst_rate !== null
          ? r2(it.gst_rate)
          : effectiveRate(it.taxable_value, taxOf(it)),
      taxable: r2(it.taxable_value),
      igst: r2(it.igst),
      cgst: r2(it.cgst),
      sgst: r2(it.sgst),
      cess: r2(it.cess),
      num: it.line_no,
      hsn: it.hsn,
      uqc: it.uqc,
      qty: r2(it.quantity ?? 0),
      desc: it.description,
    }));
  }
  return [
    {
      rate: effectiveRate(inv.taxable_value, taxOf(inv)),
      taxable: r2(inv.taxable_value),
      igst: r2(inv.igst),
      cgst: r2(inv.cgst),
      sgst: r2(inv.sgst),
      cess: r2(inv.cess),
      hsn: inv.hsn,
    },
  ];
}

/** The document-series fields a return invoice carries, if its register had them. */
function seriesOf(inv: GstInvoiceForReturn): Pick<
  ReturnInvoice,
  'docNature' | 'docSeriesFrom' | 'docSeriesTo' | 'docSeriesCancelled'
> {
  return {
    docNature: inv.doc_nature,
    docSeriesFrom: inv.doc_series_from,
    docSeriesTo: inv.doc_series_to,
    docSeriesCancelled: inv.doc_series_cancelled,
  };
}

export function buildGstr1(gstin: string, sales: GstInvoiceForReturn[]): Gstr1Model {
  // Resolved up front because the B2CL gate below depends on which tax period
  // this run is for: the threshold changed on 1 August 2024.
  const period = sales[0]?.period || '';
  const b2b: ReturnInvoice[] = [];
  const b2cl: ReturnInvoice[] = [];
  const cdnr: ReturnInvoice[] = [];
  const cdnur: ReturnInvoice[] = [];
  const exp: ReturnInvoice[] = [];
  const nilOrder: NilSupplyType[] = ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'];
  const nilBuckets = new Map<NilSupplyType, NilRow>();
  const b2csBuckets = new Map<string, B2csBucket>();
  const hsnBuckets = new Map<string, ScopedHsnRow>();
  const validation: ValidationIssue[] = [];

  let taxable = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let cess = 0;
  let invoiceValue = 0;
  let creditNotes = 0;

  for (const s of sales) {
    const cust = (s.customer_gstin || '').toUpperCase();
    const pos = supplyType(gstin, cust, s.place_of_supply);
    const value = r2(s.invoice_value);
    const t = r2(s.taxable_value);
    const tax = taxOf(s);
    // Built once and reused, so the invoice's `itms` and the HSN summary can
    // never be built from two different readings of the same row.
    const lineItems = itemsOf(s);

    taxable = r2(taxable + t);
    igst = r2(igst + r2(s.igst));
    cgst = r2(cgst + r2(s.cgst));
    sgst = r2(sgst + r2(s.sgst));
    cess = r2(cess + r2(s.cess));
    invoiceValue = r2(invoiceValue + value);

    // ---- HSN summary ----
    // Table 12 is grouped by HSN/SAC + UQC + rate, and its quantity column is
    // why the register is read item-wise: one HSN bucket has to carry the qty
    // and unit the CA declared. `rateIn` stays 0 — this entity buys nothing on
    // these registrations, so there is no inward rate to report.
    //
    // The scope is part of the bucket key: the same HSN at the same rate sold
    // once to a registered customer and once over the counter is two buckets to
    // the Accounts team, and merging them would hide a B2C shortfall inside a
    // healthy B2B number. It is decided by exactly the condition that routes the
    // invoice, so the summary can never disagree with the tables.
    const hsnScope = hsnScopeOf(cust);
    for (const it of lineItems) {
      const hsnKey = `${hsnScope}|${it.hsn || 'NA'}|${it.uqc || ''}|${r2(it.rate).toFixed(3)}`;
      if (!hsnBuckets.has(hsnKey)) {
        hsnBuckets.set(hsnKey, {
          scope: hsnScope,
          hsn: it.hsn || '',
          uqc: it.uqc || 'PCS',
          rateIn: 0,
          rateOut: r2(it.rate),
          desc: it.desc || '',
          qty: 0,
          taxable: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          cess: 0,
        });
      }
      const h = hsnBuckets.get(hsnKey)!;
      h.qty = r2(h.qty + r2(it.qty ?? 0));
      if (!h.desc && it.desc) h.desc = it.desc;
      h.taxable = r2(h.taxable + r2(it.taxable));
      h.igst = r2(h.igst + r2(it.igst));
      h.cgst = r2(h.cgst + r2(it.cgst));
      h.sgst = r2(h.sgst + r2(it.sgst));
      h.cess = r2(h.cess + r2(it.cess));
    }

    // ---- credit / debit notes ----
    if (isCreditNote(s.invoice_type)) {
      creditNotes++;
      // A note follows the recipient, exactly like the supply it corrects: table
      // 9A (CDNR) when the customer is registered, table 9B (CDNUR) when they are
      // not. A note to an unregistered customer filed into CDNR is rejected by
      // the portal because CDNR is grouped by a GSTIN the note does not have.
      const registered = cust.length === 15;
      const exportFamily =
        s.invoice_type === 'SEZWP' ||
        s.invoice_type === 'SEWOP' ||
        s.invoice_type === 'DE' ||
        s.invoice_type === 'EXPWP' ||
        s.invoice_type === 'EXPWOP';
      // Table 9B carries `typ` instead of a GSTIN: the class of the ORIGINAL
      // supply. B2CL when it would have been invoice-wise (inter-state, value
      // over this period's threshold), otherwise the consolidated B2CS.
      const noteType: ReturnInvoice['noteType'] = registered
        ? undefined
        : exportFamily
          ? s.invoice_type === 'SEWOP' || s.invoice_type === 'EXPWOP'
            ? 'EXPWOP'
            : 'EXPWP'
          : pos.pos && pos.basis === 'POS' && pos.isInterState && Math.abs(value) > b2clThresholdFor(period)
            ? 'B2CL'
            : 'B2CS';

      if (!s.note_ref_no) {
        // 9A requires the original invoice, so a missing link is a portal
        // rejection. On 9B the portal explicitly allows a note with no original
        // ("add credit or debit notes without linking to original invoice"), so
        // there it is advice, not an error.
        validation.push(
          registered
            ? {
              severity: 'ERROR',
              invoiceNo: s.invoice_no,
              message:
                'CDNR note me original invoice number missing hai. Portal isko reject kar dega — SAP se linked invoice number bharein.',
            }
            : {
              severity: 'WARNING',
              invoiceNo: s.invoice_no,
              message:
                'CDNUR note me original invoice ka reference nahi hai. Table 9B ise accept karta hai, lekin original invoice number/date dene se officer ko trail milta hai.',
            },
        );
      }
      if (exportFamily && !registered) {
        validation.push({
          severity: 'WARNING',
          invoiceNo: s.invoice_no,
          message:
            'Export/SEZ note ka CDNUR `typ` EXPWP ya EXPWOP hai — ye books se pata nahi chalta (export proceeds aaye ya nahi). CA se confirm karke sahi karein.',
        });
      }

      const row: ReturnInvoice = {
        table: registered ? 'CDNR' : 'CDNUR',
        counterpartyGstin: cust,
        counterpartyName: s.customer_name,
        invoiceNo: s.invoice_no,
        invoiceDate: s.invoice_date,
        invoiceValue: value,
        placeOfSupply: pos.pos,
        reverseCharge: s.reverse_charge,
        // A debit note has to keep its debit identity: the portal's `ntty` is C
        // for a credit note and D for a debit note, and collapsing both to 'R'
        // here turned every debit note into a credit note in the return — while
        // also sliding it past the missing-original-invoice validation below,
        // which only fires on note-like invoice types.
        invoiceType: s.invoice_type === 'CANCEL' ? 'CANCEL' : s.invoice_type === 'DN' ? 'DN' : 'R',
        items: lineItems,
        noteRefNo: s.note_ref_no,
        noteRefDate: s.note_ref_date,
        noteType,
        ...seriesOf(s),
      };
      if (registered) cdnr.push(row);
      else cdnur.push(row);
      continue;
    }

    // ---- exports (Table 6A) ----
    if (s.invoice_type === 'EXPWP' || s.invoice_type === 'EXPWOP') {
      exp.push({
        table: 'EXP',
        counterpartyGstin: '',
        counterpartyName: s.customer_name,
        invoiceNo: s.invoice_no,
        invoiceDate: s.invoice_date,
        invoiceValue: value,
        placeOfSupply: pos.pos,
        reverseCharge: s.reverse_charge,
        invoiceType: s.invoice_type,
        items: lineItems,
        ...seriesOf(s),
      });
      continue;
    }

    // ---- Table 8: Nil-rated, Exempt, and Non-GST outward supplies ----
    const isZeroRatedType =
      s.invoice_type === 'SEZWP' || s.invoice_type === 'SEWOP' || s.invoice_type === 'DE';
    const explicitNilKind =
      s.invoice_type === 'NIL' || s.invoice_type === 'EXEMPT' || s.invoice_type === 'NONGST';
    if (explicitNilKind || (t !== 0 && tax === 0 && !isZeroRatedType)) {
      const reg = cust.length === 15;
      const inter = reg ? stateOf(cust) !== stateOf(gstin) : pos.isInterState;
      const sply_ty: NilSupplyType = reg
        ? inter
          ? 'INTRB2B'
          : 'INTRAB2B'
        : inter
          ? 'INTRB2C'
          : 'INTRAB2C';
      const cur = nilBuckets.get(sply_ty) ?? { sply_ty, nil_amt: 0, expt_amt: 0, ngsup_amt: 0 };
      if (s.invoice_type === 'EXEMPT') {
        cur.expt_amt = r2(cur.expt_amt + t);
      } else if (s.invoice_type === 'NONGST') {
        cur.ngsup_amt = r2(cur.ngsup_amt + t);
      } else {
        cur.nil_amt = r2(cur.nil_amt + t);
      }
      nilBuckets.set(sply_ty, cur);
      if (explicitNilKind) continue;
    }

    // ---- registered customer -> B2B ----
    if (cust.length === 15) {
      if (stateOf(cust) !== stateOf(gstin)) {
        // An inter-state sale to a registered customer must still be B2B, but
        // the split must be IGST. Flag a wrong split rather than silently
        // re-allocating tax, because the books figure is what was invoiced.
        if (r2(s.igst) === 0 && (r2(s.cgst) > 0 || r2(s.sgst) > 0)) {
          validation.push({
            severity: 'ERROR',
            invoiceNo: s.invoice_no,
            message:
              'Inter-state sale par CGST/SGST lag rakha hai, IGST nahi. Place of supply galat ho sakta hai — check karein.',
          });
        }
      }
      b2b.push({
        table: 'B2B',
        counterpartyGstin: cust,
        counterpartyName: s.customer_name,
        invoiceNo: s.invoice_no,
        invoiceDate: s.invoice_date,
        invoiceValue: value,
        placeOfSupply: pos.pos,
        reverseCharge: s.reverse_charge,
        invoiceType: s.invoice_type,
        items: lineItems,
        ...seriesOf(s),
      });
      continue;
    }

    // ---- unregistered, POS known, inter-state ----
    // Only where the invoice VALUE crosses this period's threshold is it B2CL;
    // everything smaller falls through to B2CS below. Routing a Rs 50,000 B2C
    // invoice into B2CL is a portal error, and splitting the table wrong is not
    // a rounding matter — it changes which return table the liability sits in.
    if (pos.pos && pos.basis === 'POS') {
      if (pos.isInterState && value > b2clThresholdFor(period)) {
        b2cl.push({
          table: 'B2CL',
          counterpartyGstin: '',
          counterpartyName: s.customer_name,
          invoiceNo: s.invoice_no,
          invoiceDate: s.invoice_date,
          invoiceValue: value,
          placeOfSupply: pos.pos,
          reverseCharge: s.reverse_charge,
          invoiceType: s.invoice_type,
          items: lineItems,
          ...seriesOf(s),
        });
        continue;
      }
    }

    // ---- everything else -> B2CS, grouped by place of supply AND rate ----
    // Grouping by rate alone merged two states into one row, which is not how
    // table 7 is filed, and left the portal JSON with no `pos` to declare.
    const rate = effectiveRate(t, tax);
    const b2csPos = pos.pos || '';
    const b2csKey = `${b2csPos}|${rate}`;
    if (!b2csBuckets.has(b2csKey)) {
      b2csBuckets.set(b2csKey, { pos: b2csPos, rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    }
    const bucket = b2csBuckets.get(b2csKey)!;
    bucket.taxable = r2(bucket.taxable + t);
    bucket.igst = r2(bucket.igst + r2(s.igst));
    bucket.cgst = r2(bucket.cgst + r2(s.cgst));
    bucket.sgst = r2(bucket.sgst + r2(s.sgst));
    bucket.cess = r2(bucket.cess + r2(s.cess));

    if (cust.length > 0 && cust.length !== 15) {
      validation.push({
        severity: 'WARNING',
        invoiceNo: s.invoice_no,
        message: `Customer GSTIN "${cust}" 15 character ka nahi hai — B2CS me chala gaya. Data cleaning kar lein taaki B2B me aaye.`,
      });
    }
  }

  // ---- duplicate invoice detection inside the return ----
  const seen = new Map<string, number>();
  for (const inv of [...b2b, ...b2cl, ...cdnr, ...cdnur, ...exp]) {
    const k = `${inv.table === 'CDNUR' ? 'CDNUR' : inv.table === 'EXP' ? 'EXP' : inv.counterpartyGstin}|${inv.invoiceNo}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) {
      validation.push({
        severity: 'ERROR',
        invoiceNo: k.split('|')[1],
        message: `Ye invoice GSTR-1 me ${n} baar aa raha hai (${k.split('|')[0]}). Portal duplicate reject karega.`,
      });
    }
  } return {
    gstin,
    period,
    periodLabel: labelOf(period),
    financialYear: fyOf(period),
    b2b,
    b2cl,
    b2cs: [...b2csBuckets.values()].sort(
      (a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate,
    ),
    cdnr,
    cdnur,
    exp,
    nil: nilOrder.filter((k) => nilBuckets.has(k)).map((k) => nilBuckets.get(k)!),
    // The filed table is the two halves added back together, so the portal JSON
    // and the workbook keep the exact shape they had before the split existed.
    hsn: mergeHsnByHsnUqcRate([...hsnBuckets.values()]),
    hsnB2b: sortHsn([...hsnBuckets.values()].filter((h) => h.scope === 'B2B')),
    hsnB2c: sortHsn([...hsnBuckets.values()].filter((h) => h.scope === 'B2C')),
    validation,
    totals: {
      invoices: b2b.length + b2cl.length + cdnr.length + cdnur.length + exp.length,
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      invoiceValue,
      creditNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// portal JSON
// ---------------------------------------------------------------------------

/**
 * The portal reads dates as DD-MM-YYYY. An ISO date in `idt` or `nt_dt` fails
 * structure validation at upload — before the return ever reaches the officer —
 * so every date passes through here.
 */
function portalDate(iso?: string | null): string {
  const s = String(iso ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/**
 * One invoice's rate buckets as the portal's `itms` array.
 *
 * The portal nests every amount under `itm_det` and numbers each line within
 * the invoice. A flat `{num, rt, txval}` row is not a shape it accepts.
 */
function portalItems(items: ReturnItem[]): unknown[] {
  return items.map((i, idx) => ({
    // The line's own serial from the register where it declared one, so the
    // portal's item numbering matches what the CA sees in the sales file.
    num: i.num ?? idx + 1,
    itm_det: {
      rt: i.rate,
      txval: i.taxable,
      iamt: i.igst,
      camt: i.cgst,
      samt: i.sgst,
      csamt: i.cess,
    },
  }));
}

/** The shared body of one invoice, used by b2b and b2cl. */
function portalInvoice(i: ReturnInvoice): Record<string, unknown> {
  return {
    inum: i.invoiceNo,
    idt: portalDate(i.invoiceDate),
    val: i.invoiceValue,
    pos: i.placeOfSupply,
    rchrg: i.reverseCharge ? 'Y' : 'N',
    inv_typ: i.invoiceType,
    itms: portalItems(i.items),
  };
}

/**
 * The portal does not take a flat list. b2b is grouped by the recipient's
 * GSTIN, b2cl by place of supply and cdnr by GSTIN again, each group carrying
 * its own array. The old flat rows looked right in the editor and were not the
 * schema the utility validates against.
 */
function grouped<T>(rows: T[], keyOf: (r: T) => string): Array<[string, T[]]> {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else {
      byKey.set(k, [r]);
      order.push(k);
    }
  }
  return order.map((k) => [k, byKey.get(k)!] as [string, T[]]);
}

function toFp(period: string): string {
  return (period || '').replace('-', '');
}

export function gstr1PortalJson(m: Gstr1Model, hash = null): unknown {
  const fp = toFp(m.period);
  const docIssued = docIssuedOf(m);

  const b2bPortal = grouped(m.b2b, (i) => i.counterpartyGstin).map(([ctin, inv]) => ({
    ctin,
    inv: inv.map((i) => portalInvoice(i)),
  }));

  const b2clPortal = grouped(m.b2cl, (i) => i.placeOfSupply).map(([pos, inv]) => ({
    pos,
    inv: inv.map((i) => portalInvoice(i)),
  }));

  const b2csPortal = m.b2cs.map((i) => ({
    // Table 7 is reported state-wise: a B2CS row is one place of supply at one
    // rate, so the POS is part of the row rather than an optional extra.
    pos: i.pos,
    // sply_ty on the portal is INTER or INTRA — never a label like "B2C". It is
    // read off how the tax was actually charged: IGST means the supply crossed
    // a state line, CGST + SGST means it did not. A nil bucket carries no tax at
    // all, so it falls back to INTRA, the local answer for a Maharashtra entity.
    sply_ty: i.igst > 0 ? 'INTER' : 'INTRA',
    typ: 'OE',
    rt: i.rate,
    txval: i.taxable,
    iamt: i.igst,
    camt: i.cgst,
    samt: i.sgst,
    csamt: i.cess,
  }));

  const cdnrPortal = grouped(m.cdnr, (i) => i.counterpartyGstin).map(([ctin, nt]) => ({
    ctin,
    nt: nt.map((i) => {
      // The note's OWN number and date come first — that is what table 9A asks
      // for — followed by the invoice the note corrects, which is exactly why
      // note_ref_no exists. The old row had only the original invoice, so the
      // note itself was never declared at all.
      const invTyp =
        i.invoiceType === 'SEZWP' || i.invoiceType === 'SEWOP' || i.invoiceType === 'DE'
          ? i.invoiceType
          : 'R';
      return {
        nt_num: i.invoiceNo,
        nt_dt: portalDate(i.invoiceDate),
        ntty: i.invoiceType === 'DN' ? 'D' : 'C',
        inum: i.noteRefNo || '',
        idt: portalDate(i.noteRefDate),
        val: i.invoiceValue,
        pos: i.placeOfSupply,
        rchrg: i.reverseCharge ? 'Y' : 'N',
        inv_typ: invTyp,
        itms: portalItems(i.items),
      };
    }),
  }));

  // Table 9B is a FLAT list — there is no recipient GSTIN to group on, which is
  // exactly what separates it from 9A. `typ` replaces `ctin`, and there is no
  // `inv_typ` on a CDNUR record.
  const cdnurPortal = m.cdnur.map((i) => ({
    typ: i.noteType ?? 'B2CS',
    ntty: i.invoiceType === 'DN' ? 'D' : 'C',
    nt_num: i.invoiceNo,
    nt_dt: portalDate(i.invoiceDate),
    val: i.invoiceValue,
    pos: i.placeOfSupply,
    rchrg: i.reverseCharge ? 'Y' : 'N',
    inum: i.noteRefNo || '',
    idt: portalDate(i.noteRefDate),
    itms: portalItems(i.items),
  }));

  const hsn = m.hsn.map((h, idx) => ({
    num: idx + 1,
    // `rtin` / `rtout` are the OFFLINE TOOL'S EXCEL column names, not the JSON
    // field. The JSON carries one rate per row, and this application has no
    // inward HSN rate to report, so rateIn is dropped rather than invented.
    hsn_sc: h.hsn || '',
    desc: h.desc || '',
    uqc: h.uqc,
    // `qty` is summed from the item lines. A register that carries no quantity
    // reports 0 rather than a made-up figure.
    qty: r2(h.qty),
    rt: h.rateOut,
    txval: h.taxable,
    iamt: h.igst,
    camt: h.cgst,
    samt: h.sgst,
    csamt: h.cess,
  }));

  return {
    gstin: m.gstin,
    fp,
    version: 'GST1.1',
    hash,
    b2b: b2bPortal,
    b2cl: b2clPortal,
    b2cs: b2csPortal,
    cdnr: cdnrPortal,
    cdnur: cdnurPortal,
    exp: grouped(m.exp, (i) => (i.invoiceType === 'EXPWP' ? 'WPAY' : 'WOPAY')).map(([exp_typ, inv]) => ({
      exp_typ,
      inv: inv.map((i) => ({
        inum: i.invoiceNo,
        idt: portalDate(i.invoiceDate),
        val: i.invoiceValue,
        itms: portalItems(i.items),
      })),
    })),
    nil: {
      inv: m.nil.map((r) => ({
        sply_ty: r.sply_ty,
        expt_amt: r.expt_amt,
        nil_amt: r.nil_amt,
        ngsup_amt: r.ngsup_amt,
      })),
    },
    // The five amendment tables. They MUST be empty for a fresh return: the old
    // code copied the whole regular data set into b2bqa / b2cla / b2csa / cdnra,
    // which would have declared every single invoice a SECOND time as an
    // amendment of itself, and stuffed a fabricated grand total into b2ba as if
    // it were one line of items. Nothing is ever drafted as an amendment here.
    b2ba: [],
    b2bqa: [],
    b2cla: [],
    b2csa: [],
    cdnra: [],
    hsn: { data: hsn },
    doc_issued: { doc_det: docIssued },
    doc_num: docIssued.length,
    amended_doc_issued: { doc_det: [] },
    amended_doc_num: 0,
    sect: 'B2B,B2CL,B2CS,CDNR,CDNUR,EXP,NIL,HSN',
  };
}

/**
 * The DOC_ISSUED declaration (nature of documents issued), from the series each
 * invoice was issued in.
 *
 * A fresh return used to declare NOTHING here — `doc_det` empty, `doc_num` 0 —
 * even though the register knows the series ("Invoices for outward supply",
 * 1001 to 1200, 3 cancelled). The portal asks this table to cover every
 * document series the taxpayer issued, so an empty one is an incomplete return.
 *
 * One `docs` entry per distinct series. `totnum` is the size of the declared
 * range when both bounds are numbers (1200 − 1001 + 1 = 200), and otherwise the
 * number of invoices actually seen in that series, which is the only honest
 * count available. No series declared anywhere ⇒ the table stays empty exactly
 * as before.
 */
function docIssuedOf(m: Gstr1Model): Array<Record<string, unknown>> {
  const series = new Map<
    string,
    { nature: string; from?: number; to?: number; cancelled: number; seen: number }
  >();

  for (const inv of [...m.b2b, ...m.b2cl, ...m.cdnr, ...m.cdnur, ...m.exp]) {
    const from = inv.docSeriesFrom;
    const to = inv.docSeriesTo;
    const cancelled = inv.docSeriesCancelled ?? 0;
    if (from === undefined && to === undefined && !inv.docNature) continue;
    const nature = inv.docNature || 'Invoices for outward supply';
    const key = `${nature}|${from ?? ''}|${to ?? ''}|${cancelled}`;
    const e = series.get(key) ?? { nature, from, to, cancelled, seen: 0 };
    e.seen += 1;
    series.set(key, e);
  }

  return [...series.values()].map((e, idx) => {
    const totnum =
      e.from !== undefined && e.to !== undefined && e.to >= e.from
        ? e.to - e.from + 1
        : e.seen;
    return {
      doc_num: idx + 1,
      doc_typ: e.nature,
      docs: [
        {
          num: 1,
          from: e.from !== undefined ? String(e.from) : '',
          to: e.to !== undefined ? String(e.to) : '',
          totnum,
          cancel: e.cancelled,
          net_issue: Math.max(totnum - e.cancelled, 0),
        },
      ],
    };
  });
}

/** Flat working-sheet rows so the CA can read the return in a grid. */
export interface Gstr1SheetRow {
  table: string;
  gstin: string;
  party: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceValue: number;
  pos: string;
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Item line detail — one row per item, so the CA can trace each HSN. */
  lineNo?: number;
  hsn?: string;
  uqc?: string;
  qty?: number;
  desc?: string;
}

export function gstr1SheetRows(m: Gstr1Model): Gstr1SheetRow[] {
  const rows: Gstr1SheetRow[] = [];
  const push = (table: string, inv: ReturnInvoice) => {
    for (const it of inv.items) {
      rows.push({
        table,
        gstin: inv.counterpartyGstin,
        party: inv.counterpartyName,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        invoiceValue: inv.invoiceValue,
        pos: inv.placeOfSupply,
        rate: it.rate,
        taxable: it.taxable,
        igst: it.igst,
        cgst: it.cgst,
        sgst: it.sgst,
        cess: it.cess,
        lineNo: it.num,
        hsn: it.hsn,
        uqc: it.uqc,
        qty: it.qty,
        desc: it.desc,
      });
    }
  };

  m.b2b.forEach((i) => push('B2B', i));
  m.b2cl.forEach((i) => push('B2CL', i));
  m.cdnr.forEach((i) => push('CDNR', i));
  m.cdnur.forEach((i) => push('CDNUR', i));
  m.exp.forEach((i) => push('EXP', i));
  for (const it of m.b2cs) {
    rows.push({
      table: 'B2CS',
      gstin: '',
      party: '(unregistered / no POS)',
      invoiceNo: '',
      invoiceDate: '',
      invoiceValue: r2(it.taxable + it.igst + it.cgst + it.sgst + it.cess),
      pos: it.pos,
      rate: it.rate,
      taxable: it.taxable,
      igst: it.igst,
      cgst: it.cgst,
      sgst: it.sgst,
      cess: it.cess,
    });
  }
  for (const n of m.nil) {
    const totalNil = r2(n.nil_amt + n.expt_amt + n.ngsup_amt);
    rows.push({
      table: 'NIL',
      gstin: '',
      party: `Table 8 (${n.sply_ty})`,
      invoiceNo: '',
      invoiceDate: '',
      invoiceValue: totalNil,
      pos: n.sply_ty,
      rate: 0,
      taxable: totalNil,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
      desc: `Nil: ${n.nil_amt}, Exempt: ${n.expt_amt}, Non-GST: ${n.ngsup_amt}`,
    });
  }
  return rows;
}

/**
 * Table 12 (HSN summary) as flat rows for the workbook.
 *
 * The summary exists in the model and in the portal JSON, but a CA checking the
 * return needs to SEE it: HSN-wise taxable value, quantity and tax are exactly
 * what this feature exists to get right, and there was no sheet to check them
 * against.
 */
export function gstr1HsnSheetRows(m: Gstr1Model): Array<Record<string, string | number>> {
  return m.hsn.map((h) => ({
    hsn: h.hsn || 'NA',
    description: h.desc,
    uqc: h.uqc,
    qty: r2(h.qty),
    rate: h.rateOut,
    taxable: h.taxable,
    igst: h.igst,
    cgst: h.cgst,
    sgst: h.sgst,
    cess: h.cess,
  }));
}
