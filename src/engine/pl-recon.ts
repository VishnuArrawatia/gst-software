/**
 * P&L versus GSTR-1 — the pure comparison.
 *
 * Nothing here reads or writes the database. It takes the P&L heads, what the
 * books put in each head for a month, and the GSTR-1 documents for the whole
 * company, and answers one question per head: does the amount in the P&L agree
 * with the amount the return declares?
 *
 * Three decisions came from the accounts team and are load-bearing:
 *
 *   1. BASIS — the P&L amount is the TAXABLE value, tax exclusive, so it is
 *      compared with `taxable_value` and never with `invoice_value`. Comparing
 *      a gross P&L figure with a taxable return figure would show a fake
 *      difference exactly equal to the tax on every single head.
 *
 *   2. GSTR-1 SIDE — the software's own DRAFT return, which is what it is
 *      about to file. The draft is the software's own claim, so a difference
 *      here is a defect in our own work rather than a dispute with the portal.
 *
 *   3. CREDIT NOTES — CDNR is its own head and its own row. It is never netted
 *      into Taxable Sales, because a netted figure cannot be traced to the
 *      table that produced it.
 *
 * The GSTR-1 detail is per GSTIN but the P&L is per company, so the GSTIN
 * slices are summed for the comparison and carried through unbroken underneath
 * it. Collapsing them to a single number would destroy the only thing that
 * makes a difference diagnosable.
 */

import { r2 } from './core';

/** Money tolerance, matching the purchase side. Two paise is not a finding. */
export const DEFAULT_TOLERANCE = 1;

export type PlHeadKind = 'SALE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'OTHER_INCOME' | 'EXPENSE';

export type PlReconStatus =
  | 'Pending Review'
  | 'Reconciled'
  | 'Difference Explained'
  | 'Difference Unresolved'
  | 'Not Mapped';

/** One P&L line and how it is treated for GST. */
export interface PlHeadDef {
  id: number;
  name: string;
  group_name: string;
  sequence: number;
  head_kind: PlHeadKind;
  is_mandatory: boolean;
  gst_applicable: boolean;
  taxable_type: string;
  return_mapping: string | null;
  gstr1_table: string | null;
  include_in_gstr1: boolean;
}

/** What the books put in one head for one month. */
export interface PlAmountLine {
  head_id: number;
  amount: number;
  amendment_no?: number;
}

/** A GSTR-1 document, reduced to what this comparison needs. */
export interface Gstr1DocLite {
  gstin: string;
  table_type: string;
  taxable_value: number;
  rate?: number | null;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** One GSTIN's contribution to a head, so a difference can be traced. */
export interface GstinSlice {
  gstin: string;
  table_type: string;
  taxable_value: number;
  tax: number;
  documents: number;
}

/** The combined GSTR-1 figure a head is compared against. */
export interface Gstr1Side {
  taxable_value: number;
  tax: number;
  invoice_value: number;
  documents: number;
  gstins: number;
  slices: GstinSlice[];
  /** False when the draft simply does not produce this table. */
  supported: boolean;
  unsupportedReason?: string;
}

export interface PlReconRow {
  head_id: number;
  head_name: string;
  group_name: string;
  sequence: number;
  head_kind: PlHeadKind;
  gstr1_table: string | null;
  gst_applicable: boolean;
  taxable_type: string;
  pl_amount: number;
  gstr1_taxable: number;
  gstr1_tax: number;
  gstr1_invoice_value: number;
  difference: number;
  status: PlReconStatus;
  reason: string;
  gstin_count: number;
  gstr1_documents: number;
  gstin_breakdown: GstinSlice[];
}

export interface PlReconResult {
  rows: PlReconRow[];
  /** Money headline. Counts only heads that are mapped AND comparable. */
  totalPl: number;
  totalGstr1Taxable: number;
  totalDifference: number;
  /** Amounts on heads deliberately outside GST (Other Income). Reported, never reconciled. */
  outsideGstAmount: number;
  gstinCount: number;
  matchedHeads: number;
  pendingHeads: number;
  unmappedHeads: number;
}

const taxOfDoc = (d: Gstr1DocLite): number => r2(Number(d.igst || 0) + Number(d.cgst || 0) + Number(d.sgst || 0) + Number(d.cess || 0));

/**
 * Which GSTR-1 documents a head is compared against.
 *
 * `rate === 0` rows are separated out because the portal carries nil-rated
 * supplies in the B2CS rate-wise table alongside ordinary supplies. Counting
 * them in both Taxable Sales and Nil Rated would make two heads agree with each
 * other and disagree with the return, which is worse than either answer.
 *
 * A table the draft does not produce returns `supported: false` rather than an
 * empty slice. Zero would be a claim — it would say "the return declares
 * nothing here", and the row would show a difference that is really just a gap
 * in our own draft builder.
 */
/**
 * Is this document a nil-rated / zero-rated supply?
 *
 * Only an explicit numeric 0 counts. B2B documents carry NO rate at all — the
 * portal's B2B table has no rate column — so their rate is NULL, and treating
 * NULL as 0 would sweep every B2B line out of Taxable Sales and leave the
 * comparison against nothing.
 */
function isZeroRated(d: Gstr1DocLite): boolean {
  return d.rate !== null && d.rate !== undefined && Number(d.rate) === 0;
}

export function gstr1SliceFor(head: PlHeadDef, docs: Gstr1DocLite[]): Gstr1Side {
  const empty: Gstr1Side = {
    taxable_value: 0, tax: 0, invoice_value: 0, documents: 0,
    gstins: 0, slices: [], supported: true,
  };

  const unsupported = (why: string): Gstr1Side => ({ ...empty, supported: false, unsupportedReason: why });

  let picked: Gstr1DocLite[];
  switch (head.gstr1_table) {
    case 'B2B/B2CL/B2CS':
      picked = docs.filter((d) => ['B2B', 'B2CL', 'B2CS'].includes(d.table_type) && !isZeroRated(d));
      break;
    case 'CDNR':
      // A credit note to an unregistered customer is still a credit note / sales
      // return — it is declared in 9B instead of 9A, not left out of the P&L
      // comparison.
      picked = docs.filter((d) => d.table_type === 'CDNR' || d.table_type === 'CDNUR');
      break;
    case 'NIL':
      picked = docs.filter((d) => ['B2CL', 'B2CS'].includes(d.table_type) && isZeroRated(d));
      break;
    case 'EXP':
      return unsupported('the GSTR-1 draft does not produce an EXP table yet');
    case 'EXEMPT':
      return unsupported('exempt supplies are not separable from nil-rated ones in the draft');
    default:
      return unsupported(`no GSTR-1 table is mapped for this head`);
  }

  const byGstin = new Map<string, GstinSlice>();
  let taxable = 0, tax = 0, invoice = 0;
  for (const d of picked) {
    const dTax = taxOfDoc(d);
    taxable = r2(taxable + Number(d.taxable_value || 0));
    tax = r2(tax + dTax);
    invoice = r2(invoice + Number(d.taxable_value || 0) + dTax);
    const key = `${d.gstin}|${d.table_type}`;
    const s = byGstin.get(key) || { gstin: d.gstin, table_type: d.table_type, taxable_value: 0, tax: 0, documents: 0 };
    s.taxable_value = r2(s.taxable_value + Number(d.taxable_value || 0));
    s.tax = r2(s.tax + dTax);
    s.documents += 1;
    byGstin.set(key, s);
  }

  return {
    taxable_value: taxable,
    tax,
    invoice_value: invoice,
    documents: picked.length,
    gstins: new Set(picked.map((d) => d.gstin)).size,
    slices: [...byGstin.values()],
    supported: true,
  };
}

/**
 * Compare every head against the GSTR-1 documents.
 *
 * `amounts` may carry several amendments for the same head; the highest
 * amendment wins, because that is the version the company stands behind. Older
 * ones stay in the table as history rather than being summed into the total.
 */
export function reconcilePlVsGstr1(
  heads: PlHeadDef[],
  amounts: PlAmountLine[],
  docs: Gstr1DocLite[],
  opts: { tolerance?: number } = {},
): PlReconResult {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;

  // Latest amendment per head wins; ties break on nothing because the unique
  // key already forbids two rows with the same head and amendment.
  const byHead = new Map<number, PlAmountLine>();
  for (const a of amounts) {
    const prev = byHead.get(a.head_id);
    if (!prev || (a.amendment_no ?? 0) > (prev.amendment_no ?? 0)) byHead.set(a.head_id, a);
  }

  const rows: PlReconRow[] = [];
  let totalPl = 0, totalGstr1Taxable = 0, totalDifference = 0, outsideGstAmount = 0;
  let matchedHeads = 0, pendingHeads = 0, unmappedHeads = 0;

  for (const head of heads) {
    const plAmount = r2(Number(byHead.get(head.id)?.amount ?? 0));
    const side = gstr1SliceFor(head, docs);
    const difference = r2(plAmount - side.taxable_value);

    let status: PlReconStatus;
    let reason: string;

    if (!head.gst_applicable) {
      // Deliberately outside GST. The amount is reported so the P&L still foots,
      // but it must never appear as a difference against a return.
      status = 'Not Mapped';
      reason =
        head.head_kind === 'OTHER_INCOME'
          ? 'other_income_non_gst'
          : 'this head is mapped as not applicable to GST';
      outsideGstAmount = r2(outsideGstAmount + plAmount);
      unmappedHeads += 1;
    } else if (!side.supported) {
      status = 'Not Mapped';
      reason = side.unsupportedReason || 'not comparable with the GSTR-1 draft';
      unmappedHeads += 1;
    } else if (Math.abs(difference) <= tolerance) {
      status = 'Reconciled';
      reason = '';
      matchedHeads += 1;
      totalPl = r2(totalPl + plAmount);
      totalGstr1Taxable = r2(totalGstr1Taxable + side.taxable_value);
    } else {
      // A difference is NOT an answer. It goes to a human with a reason to
      // choose, and the database refuses to store it unexplained.
      status = 'Pending Review';
      reason = '';
      pendingHeads += 1;
      totalPl = r2(totalPl + plAmount);
      totalGstr1Taxable = r2(totalGstr1Taxable + side.taxable_value);
    }

    // A head that was never compared has no difference. Leaving the raw
    // subtraction on the row would put a fake number in front of the reviewer —
    // Other Income of 50,000 outside GST would read as a 50,000 discrepancy
    // against a return that was never supposed to mention it.
    const effectiveDifference = status === 'Not Mapped' ? 0 : difference;

    totalDifference = r2(totalDifference + (status === 'Pending Review' ? difference : 0));

    rows.push({
      head_id: head.id,
      head_name: head.name,
      group_name: head.group_name,
      sequence: head.sequence,
      head_kind: head.head_kind,
      gstr1_table: head.gstr1_table,
      gst_applicable: head.gst_applicable,
      taxable_type: head.taxable_type,
      pl_amount: plAmount,
      gstr1_taxable: side.taxable_value,
      gstr1_tax: side.tax,
      gstr1_invoice_value: side.invoice_value,
      difference: effectiveDifference,
      status,
      reason,
      gstin_count: side.gstins,
      gstr1_documents: side.documents,
      gstin_breakdown: side.slices,
    });
  }

  rows.sort((a, b) => a.sequence - b.sequence || a.head_name.localeCompare(b.head_name));

  return {
    rows,
    totalPl,
    totalGstr1Taxable,
    totalDifference,
    outsideGstAmount,
    gstinCount: new Set(docs.map((d) => d.gstin)).size,
    matchedHeads,
    pendingHeads,
    unmappedHeads,
  };
}

/** Company-level totals across several months, for the dashboard tiles. */
export function summarisePeriods(results: PlReconResult[]): {
  pl: number; gstr1: number; difference: number; matched: number; pending: number; unmapped: number;
} {
  let pl = 0, gstr1 = 0, difference = 0, matched = 0, pending = 0, unmapped = 0;
  for (const r of results) {
    pl = r2(pl + r.totalPl);
    gstr1 = r2(gstr1 + r.totalGstr1Taxable);
    difference = r2(difference + r.totalDifference);
    matched += r.matchedHeads;
    pending += r.pendingHeads;
    unmapped += r.unmappedHeads;
  }
  return { pl, gstr1, difference, matched, pending, unmapped };
}