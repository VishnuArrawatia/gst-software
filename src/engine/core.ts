/**
 * GST ERP — engine core: shared types and normalisation helpers.
 *
 * Everything here is pure and dependency-free so the same code runs from the
 * CLI, the API and the browser. No database, no filesystem, no Express.
 *
 * The single most important job of this module is normalisation. GST data
 * arrives from three very different places (SAP exports, the GST portal's
 * GSTR-2B download, and manual entry) and none of them agree on formatting:
 *   - GSTINs arrive with spaces, lowercase, and stray punctuation
 *   - invoice numbers arrive as "INV/001", "inv-001", "INV 001" or "INV001"
 *   - dates arrive as Excel serials, "01/04/2025", "2025-04-01", or "1-Apr-25"
 * If normalisation is not aggressive enough, reconciliation silently reports
 * false mismatches, which is worse than not reconciling at all.
 */

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

/** Round to 2 decimals. Every amount that reaches the engine goes through here. */
export function r2(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** Total tax on a document = igst + cgst + sgst + cess. */
export function taxOf(d: { igst?: number; cgst?: number; sgst?: number; cess?: number }): number {
  return r2(r2(d.igst) + r2(d.cgst) + r2(d.sgst) + r2(d.cess));
}

/** True when two amounts agree within a rupee tolerance. */
export function withinTolerance(a: number, b: number, tolerance = 1): boolean {
  return Math.abs(r2(a) - r2(b)) <= tolerance;
}

// ---------------------------------------------------------------------------
// GSTIN
// ---------------------------------------------------------------------------

/** The 15-character GSTIN shape the portal enforces. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Uppercase and strip everything that is not a letter or digit. */
export function normGstin(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidGstin(v: unknown): boolean {
  return GSTIN_RE.test(normGstin(v));
}

/** GST state code = the first two digits. */
export function stateOf(gstin: unknown): string {
  return normGstin(gstin).slice(0, 2);
}

/**
 * Decide whether a supply is inter-state (IGST) or intra-state (CGST+SGST).
 *
 * When both GSTINs are known the state codes decide. When the counterparty
 * GSTIN is missing (unregistered / B2C / export) we fall back to the supplied
 * place of supply, and finally to "inter-state" because IGST being under-
 * claimed is the riskier error for the taxpayer.
 */
export function supplyType(
  supplierGstin: unknown,
  recipientGstin: unknown,
  placeOfSupply?: string,
): { isInterState: boolean; pos: string; basis: 'GSTIN' | 'POS' | 'DEFAULT' } {
  const s = stateOf(supplierGstin);
  const r = stateOf(recipientGstin);
  if (s && r) return { isInterState: s !== r, pos: r, basis: 'GSTIN' };
  const pos = normPos(placeOfSupply);
  if (s && pos) return { isInterState: s !== pos, pos, basis: 'POS' };
  return { isInterState: true, pos: pos || s || '96', basis: 'DEFAULT' };
}

/**
 * Place of supply is a state name in the portal ("Gujarat") but a code in some
 * SAP exports ("24"). Reduce both to the two-digit code.
 */
const STATE_NAME_TO_CODE: Record<string, string> = {
  'andaman and nicobar islands': '35', 'andaman & nicobar': '35',
  'andhra pradesh': '37', arunachal: '12', 'arunachal pradesh': '12',
  assam: '04', bihar: '10', chhattisgarh: '22',
  dadra: '26', 'dadra and nagar haveli': '26', 'daman and diu': '26',
  delhi: '07', goa: '30', gujarat: '24', 'himachal pradesh': '02', hp: '02',
  'himachal': '02', karnataka: '29', kerala: '32',
  'jammu and kashmir': '01', jharkhand: '20',
  ladakh: '38', 'lakshadweep islands': '31', 'madhya pradesh': '23', mp: '23',
  maharashtra: '27', manipur: '14', meghalaya: '01', mizoram: '15',
  nagaland: '13', odisha: '21', orissa: '21', puducherry: '34',
  punjab: '03', rajasthan: '08', 'tamil nadu': '33', telangana: '36',
  'uttar pradesh': '09', 'uttarakhand': '05', 'west bengal': '19',
  'other territory': '97', 'other country': '96',
};

/** Reduce a place-of-supply string to a 2-digit code, or '' if unrecognised. */
export function normPos(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{2}$/.test(s)) return s;
  const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (STATE_NAME_TO_CODE[key]) return STATE_NAME_TO_CODE[key];
  // "Dadra and Nagar Haveli and Daman and Diu" and similar long forms.
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (key.includes(name)) return code;
  }
  return '';
}

// ---------------------------------------------------------------------------
// invoice numbers
// ---------------------------------------------------------------------------

/**
 * Aggressively normalise an invoice number for matching.
 *
 * "INV/001", "inv-001", "INV 001", "INV_001" and "INV001" are the same invoice
 * as far as reconciliation is concerned. Everything non-alphanumeric is
 * dropped. Case is kept significant only for the tail? No — lowercased, because
 * vendors are inconsistent about case and the GSTIN already disambiguates.
 */
export function normInvoice(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A number/date that should not exist but does often. */
export function isBlankish(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

// ---------------------------------------------------------------------------
// dates and periods
// ---------------------------------------------------------------------------

/**
 * Convert anything date-shaped into `YYYY-MM-DD`.
 *
 * Excel stores dates as days since 1899-12-30. Both SAP exports and the GST
 * portal hand us raw serials as numbers, so serial detection is essential.
 * Returns '' when the value cannot be understood — callers must treat that as
 * "unknown", never as "today".
 */
export function normDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';

  // Excel serial: 1..2958465 (1900-01-01 .. 9999-12-31)
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 20000 && n < 100000) {
      return excelSerialToIso(n);
    }
  }

  const s = String(v).trim();

  // dd/mm/yyyy or dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yy = Number(m[3]);
    if (yy < 100) yy += yy < 70 ? 2000 : 1900;
    return iso(yy, mm, dd);
  }

  // A bare 2- or 4-digit number that is not an Excel serial is a year, not a
  // date. Treating it as a date is what produces period 0099-12.
  if (/^\d{2,4}$/.test(s)) return '';

  // yyyy-mm-dd
  m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  // d-Mon-yyyy, e.g. 02-Sep-2025 / 2 September 2025
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (m && months[m[2].slice(0, 3).toLowerCase()]) {
    let yy = Number(m[3]);
    if (yy < 100) yy += yy < 70 ? 2000 : 1900;
    return iso(yy, months[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const iso = d.toISOString().slice(0, 10);
    // Same sanity window as above: `new Date('24')` happily yields year 2049 or
    // similar nonsense from a stray numeric cell.
    const y = Number(iso.slice(0, 4));
    if (y < 2017 || y > 2100) return '';
    return iso;
  }
  return '';
}

/**
 * Format a value read back from the database as `YYYY-MM-DD`.
 *
 * node-pg parses a PostgreSQL DATE into a JavaScript Date at LOCAL midnight.
 * In IST that is 18:30 UTC on the previous day, so `toISOString()` — which is
 * what most people reach for — silently returns the day BEFORE. On a purchase
 * reconciliation screen that means every invoice date shown to the CA is one
 * day earlier than what is actually stored, and on the outward side it means
 * no drafted invoice ever matches its filed counterpart.
 *
 * So the local parts are formatted directly. Same reason
 * `report-import.ts` does it its own way; this is the one place that should be
 * doing it, and both call sites now come here.
 */
export function isoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  }
  const s = String(v);
  // A plain 'YYYY-MM-DD' or an ISO timestamp needs only its first ten chars,
  // which is the date as written, with no timezone arithmetic involved.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s.slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Excel serial -> YYYY-MM-DD, honouring the 1900 leap-year quirk. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function iso(y: number, m: number, d: number): string {
  if (!m || m > 12 || !d || d > 31 || !y) return '';
  // GST returns live between 2017 and the near future. A year outside that
  // window means we misread the value, so return '' and let the caller fall
  // back rather than filing the invoice under year 0099.
  if (y < 2017 || y > 2100) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** YYYY-MM-DD -> `YYYY-MM`. */
export function periodOf(date: string): string {
  return (date || '').slice(0, 7);
}

/** `YYYY-MM` -> `Apr-25`, the label style the portal and this team both use. */
export function labelOf(period: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return period || '';
  return `${months[Number(m[2]) - 1]}-${m[1].slice(2)}`;
}

/** Financial year (India, April-March) that a period belongs to. */
export function fyOf(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Read a period from whatever a period column happens to hold.
 *
 * The same logical field arrives as `2025-04`, `1/4/2025`, an Excel serial
 * (45748), or the portal's text form `Apr'25` / `Apr-25`. Returns '' when the
 * value cannot be read, so the caller can fall back to the invoice date rather
 * than silently filing under the wrong month.
 */
export function periodFromAny(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';

  // YYYY-MM / YYYY/MM
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})$/);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;

  // Excel serial
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 100000) return excelSerialToIso(n).slice(0, 7);
  }

  // Mon'YY / Mon-YY / Mon YYYY
  const mon: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = s.match(/^([A-Za-z]{3,})\s*['’\-/]?\s*(\d{2,4})$/);
  if (m && mon[m[1].slice(0, 3).toLowerCase()]) {
    let yy = Number(m[2]);
    if (yy < 100) yy += yy < 70 ? 2000 : 1900;
    return `${yy}-${String(mon[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}`;
  }

  // dd/mm/yyyy
  const iso = normDate(s);
  return iso ? iso.slice(0, 7) : '';
}

/** Iterate every `YYYY-MM` from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!y || !m || !ty || !tm) return out;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// document types
// ---------------------------------------------------------------------------

/** GSTR-1 / GSTR-3B invoice type codes. */
export type InvoiceType = 'R' | 'Regular' | 'B2B' | 'SEZWP' | 'SEWOP' | 'DE' | 'DN' | 'CDNR' | 'C' | 'CANCEL';

export function normInvoiceType(v: unknown): Exclude<InvoiceType, 'CANCEL'> {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return 'R';
  // Portal "Regular"/"SEZWP"/"SEWOP"/"Deemed Export"
  if (s.startsWith('SEZ')) return 'SEZWP';
  if (s.startsWith('SEW')) return 'SEWOP';
  if (s.startsWith('DE') || s.startsWith('DEEMED')) return 'DE';
  // Credit / debit notes
  if (s.startsWith('CDN') || s === 'CREDIT NOTE' || s.startsWith('CN')) return 'CDNR';
  if (s.startsWith('DN') || s === 'DEBIT NOTE') return 'DN';
  return 'R';
}

export function isCreditNote(t: InvoiceType): boolean {
  return t === 'CDNR' || t === 'DN' || t === 'CANCEL';
}

// ---------------------------------------------------------------------------
// purchase document type — invoice / credit note / debit note
// ---------------------------------------------------------------------------

/**
 * What a purchase-side document IS. GSTR-2B separates these into B2B (invoice)
 * and CDNR (note), and the purchase register is uploaded as one mixed file, so
 * every row has to say which one it is before its amount can be netted.
 */
export const DOC_TYPES = ['Tax Invoice', 'Debit Note', 'Credit Note'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Recognise every spelling the portal, SAP and a human have ever used, and
 * return null when the text is not a document type at all.
 *
 * A credit note is checked before a debit note because "CN" and "CDNR" are the
 * common abbreviations; `DN` never collides with either. `null` is important:
 * the register must reject "Sales Return" or a typo loudly instead of filing it
 * as a purchase that ADDS credit.
 */
export function docTypeOrNull(v: unknown): DocType | null {
  const s = String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.includes('CREDIT') || s.startsWith('CDN') || s === 'CN' || s === 'C' || s === 'CR') {
    return 'Credit Note';
  }
  if (s.includes('DEBIT') || s === 'DN' || s === 'D' || s.startsWith('DB')) return 'Debit Note';
  if (
    s.includes('INVOICE') || s === 'INV' || s === 'R' || s === 'REGULAR' ||
    s === 'B2B' || s === 'TAX' || s === 'TI'
  ) {
    return 'Tax Invoice';
  }
  return null;
}

/** Same, with the only safe default: an unrecognised value is a Tax Invoice. */
export function normDocType(v: unknown): DocType {
  return docTypeOrNull(v) ?? 'Tax Invoice';
}

/** True when the document takes ITC away instead of giving it. */
export function isCreditDoc(v: unknown): boolean {
  return normDocType(v) === 'Credit Note';
}

/**
 * The sign the LEDGER needs, not the sign the paper prints.
 *
 * A credit note is always a reduction: -1. An invoice or a debit note is +1.
 * The template asks for every amount as a POSITIVE figure exactly as printed,
 * and this is the one place that turns the selection into a minus — so a user
 * can never produce a credit note that ADDS credit by typing it without a
 * minus, and a file that already carried minus signs does not become double
 * negative (the magnitude is taken first).
 */
export function docSign(v: unknown): 1 | -1 {
  return isCreditDoc(v) ? -1 : 1;
}

/** One amount, with the sign its document type requires. */
export function docAmount(v: unknown, amount: unknown): number {
  const n = r2(amount);
  return docSign(v) === -1 ? -Math.abs(n) : n;
}

/**
 * Decide the document type when the file does not say.
 *
 * Blank type + every non-zero amount negative is a credit note (that is what a
 * negative purchase row has always meant). A stated type is always believed, so
 * the dropdown beats the sign.
 */
export function inferDocType(stated: unknown, amounts: number[]): DocType {
  const named = docTypeOrNull(stated);
  if (named) return named;
  const nonZero = amounts.map(r2).filter((n) => n !== 0);
  return nonZero.length > 0 && nonZero.every((n) => n < 0) ? 'Credit Note' : 'Tax Invoice';
}

/**
 * How a line's amounts line up with its stated document type.
 *
 * `ok`        — no contradiction.
 * `applied`   — a credit note arrived positive; the minus was applied once.
 * `kept`      — a credit note arrived negative; it is left alone (no double negation).
 * `conflict`  — an invoice / debit note arrived negative, or the line mixes signs.
 *               The amounts are preserved exactly and the row is reported, never
 *               silently re-signed.
 */
export type SignCheck = 'ok' | 'applied' | 'kept' | 'conflict';

export function signCheckOf(type: DocType, amounts: number[]): SignCheck {
  const nonZero = amounts.map(r2).filter((n) => n !== 0);
  if (!nonZero.length) return 'ok';
  const anyPos = nonZero.some((n) => n > 0);
  const anyNeg = nonZero.some((n) => n < 0);
  if (type === 'Credit Note') {
    if (anyPos && anyNeg) return 'conflict';
    return anyPos ? 'applied' : 'kept';
  }
  if (anyNeg) return 'conflict';
  return 'ok';
}

/**
 * GST slabs, expressed as PERCENTAGES (the figures the return shows).
 * Note there is no 10% or 25% slab in GST — 0.25% and 3% are the small ones.
 */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

/** Snap a computed effective rate (in percent) onto the nearest legal slab. */
export function nearestRate(effective: number): number {
  let best: number = GST_RATES[0];
  let bestDiff = Infinity;
  for (const r of GST_RATES) {
    const d = Math.abs(r - effective);
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best;
}

/**
 * Derive the effective GST rate for a tax line.
 * For a credit note or a negative document we take the absolute ratio so the
 * rate stays a positive slab number in the B2CS/HSN summaries.
 */
export function effectiveRate(taxable: number, tax: number): number {
  const t = Math.abs(r2(taxable));
  if (t === 0) return 0;
  return nearestRate((Math.abs(r2(tax)) / t) * 100);
}

// ---------------------------------------------------------------------------
// domain types
// ---------------------------------------------------------------------------

/** One GST registration. A company may hold several (one per unit). */
export interface Gstin {
  gstin: string;
  company_id?: number | string;
  company_name?: string;
  unit_id?: number | string;
  unit_name?: string;
  state_code?: string;
  legal_name?: string;
  trade_name?: string;
}

/**
 * A purchase invoice from the books (SAP purchase register).
 * This is the ITC side of the reconciliation.
 */
export interface PurchaseBill {
  id?: string;
  our_gstin: string;
  unit_name?: string;
  party_name: string;
  supplier_gstin: string;
  invoice_no: string;
  /**
   * Invoice, Credit Note or Debit Note.
   *
   * The register holds all three, and only this field can tell them apart: a
   * credit note reduces ITC and a debit note increases it, while both look like
   * an ordinary purchase row. It is also part of the match: a credit note can
   * never be matched against an invoice that happens to share its number.
   */
  document_type?: DocType;
  /** Exactly what the file wrote, kept for audit (e.g. "CN", "Purchase Invoice"). */
  document_type_raw?: string;
  /** +1 or -1 — the one sign the document type applies to its amounts. */
  sign_effect?: 1 | -1;
  /**
   * The amounts EXACTLY as the file printed them, before the sign was applied.
   * `taxable_value` and the tax fields hold the normalized (signed) values that
   * every total and report uses; these keep the source for the audit trail and
   * for the mismatch export, so "we turned your -5000 into -5000" can be proved
   * rather than assumed.
   */
  source_taxable_value?: number;
  source_igst?: number;
  source_cgst?: number;
  source_sgst?: number;
  source_cess?: number;
  /**
   * PO / GRN / your-reference number carried alongside the invoice.
   *
   * Kept apart from `invoice_no` on purpose: reconciliation matches on the
   * invoice number, so a file carrying both must not have the reference read
   * into the invoice number.
   */
  reference_no?: string;
  /**
   * E-invoice / e-way bill, when the source file carries them.
   *
   * GSTR-2B reports neither, so these arrive only from a purchase register that
   * has the columns. `undefined` means the file said nothing, which is not the
   * same as saying "No".
   */
  has_e_invoice?: boolean;
  e_invoice_no?: string;
  has_e_way_bill?: boolean;
  e_way_bill_no?: string;
  invoice_date: string;
  /**
   * Date the invoice was booked in our books (may be the PO/GRN reference
   * date). Not the supplier's invoice date — that gap is what puts a purchase
   * in one month's books and a different month's GSTR-2B. The book entry month
   * is derived from this rather than stored twice.
   */
  book_entry_date?: string;
  period: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_total?: number;
  /** Free-text note carried from the source row, used in follow-up lists. */
  remark?: string;
  source_file?: string;
  source_row?: number;

  // ---- reconciliation overrides (Phase 0) -------------------------------
  // The Accounts user may correct the supplier GSTIN / invoice number / date
  // used for MATCHING without touching what the books actually say. When
  // absent, the book value is used, so an unedited import reconciles exactly
  // as it did before this feature existed.
  recon_supplier_gstin?: string;
  recon_invoice_no?: string;
  recon_invoice_date?: string;
}

/** A GSTR-2B line as downloaded from the GST portal. */
export interface Gstr2bRecord {
  id?: string;
  our_gstin: string;
  supplier_gstin: string;
  supplier_name: string;
  invoice_no: string;
  invoice_type: string;
  invoice_date: string;
  invoice_value: number;
  place_of_supply: string;
  reverse_charge: boolean;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  period: string;
  filing_date?: string;
  /** Return period the portal filed this 2B under (JSON `fp`, e.g. `2025-04`). */
  portal_fp?: string;
  /** 'Yes' / 'No' from the portal. Anything other than Yes blocks the claim. */
  itc_availability: string;
  reason?: string;
  applicable_pct?: string;
  source_file?: string;
  source_row?: number;
}

/**
 * One ITEM / tax-rate line of a sales invoice.
 *
 * The sales register is item-wise: a single invoice with two goods at 18% and
 * 12% arrives as two rows, and the HSN summary the portal asks for cannot be
 * produced from an invoice-level total. These lines are what `sales_invoices`
 * cannot hold (it has one HSN and one rate), so they are kept here and stored
 * in the `sales_invoice_items` child table.
 *
 * Every line carries the invoice's identity as well as its own money, so a file
 * can be read row-by-row and grouped into invoices afterwards — which is the
 * only order that cannot inflate an invoice total.
 */
export interface SalesItem {
  /** Serial WITHIN the invoice (the portal's `itms[].num`). */
  line_no?: number;
  item_code?: string;
  description?: string;
  hsn?: string;
  uqc?: string;
  quantity?: number;
  /** The rate printed on the line, in percent. Never derived unless absent. */
  gst_rate?: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Break-up of `taxable_value`, not an amount on top of it. */
  freight?: number;
  other_charges?: number;
  source_row?: number;
}

/** A sales invoice from the books (SAP sales register). Drives GSTR-1. */
export interface SalesInvoice {
  id?: string;
  our_gstin: string;
  unit_name?: string;
  /** SAP B1's CardCode — the party code, kept for traceability, never a name. */
  card_code?: string;
  customer_name: string;
  customer_gstin: string;
  /** 'Registered' / 'Unregistered' as the register declares it, if declared. */
  recipient_type?: string;
  invoice_no: string;
  invoice_date: string;
  period: string;
  invoice_type: InvoiceType;
  place_of_supply: string;
  reverse_charge: boolean;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_value: number;
  hsn?: string;
  /**
   * The invoice's item lines, when the file was item-wise. Absent for an
   * invoice-level register, which is still accepted: the builders fall back to
   * the invoice's own totals exactly as they always did.
   */
  items?: SalesItem[];
  /** Credit/debit notes need the linked original invoice number. */
  note_ref_no?: string;
  note_ref_date?: string;
  /** B2BA / CDNRA — the FILED invoice this row corrects, if it corrects one. */
  amendment_invoice_no?: string;
  amendment_invoice_date?: string;
  e_commerce_gstin?: string;
  /** DOC_ISSUED declaration, declared once per document series. */
  doc_nature?: string;
  doc_series_from?: number;
  doc_series_to?: number;
  doc_series_cancelled?: number;
  source_file?: string;
  source_row?: number;
}

/**
 * The document shape the return builders (GSTR-1 / GSTR-3B) consume.
 * Kept as a distinct name so a return builder never accidentally takes the ITC
 * side of the ledger — the two sides have different fields.
 */
export type GstInvoiceForReturn = SalesInvoice;

/** Reconciliation outcome for one book-side document. */
export type ReconStatus =
  | 'Matched'
  | 'Amount Mismatch'
  | 'Missing in 2B'
  | 'Missing in Books'
  | 'ITC Blocked'
  | 'Duplicate'
  | 'Pending Review';

export interface ReconRow {
  status: ReconStatus;
  our_gstin: string;
  unit_name?: string;
  party_name: string;
  supplier_gstin: string;
  invoice_no: string;
  invoice_date: string;
  period: string;
  /** Tax Invoice | Debit Note | Credit Note — decides gross vs reduction. */
  document_type?: DocType;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itc: number;
  /** Populated when a 2B line was found. */
  matched_2b_id?: string;
  two_b_taxable?: number;
  two_b_itc?: number;
  itc_difference?: number;
  taxable_difference?: number;
  itc_availability?: string;
  reason?: string;
  /**
   * Return period of the GSTR-2B file this line matched in (`YYYY-MM`), taken
   * from the portal file itself — never from the purchase register's month.
   */
  matched_2b_month?: string;
  /** Which values were used to match: the recon_* overrides, or the book values. */
  matched_on_recon?: boolean;
  /** Human-facing next action, used verbatim in the CA exception file. */
  action?: string;
  duplicate_count?: number;
  /** Source file and row this row came from — its stable identity. */
  source_file?: string;
  source_row?: number;
}
