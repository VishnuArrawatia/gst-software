/**
 * GST ERP — the GSTR-2B vs Books invoice-to-invoice reconciliation sheet.
 *
 * WHAT THIS IS
 *   The working file the Accounts team reconciles one month against GSTR-2B in.
 *   It is a TEMPLATE in the same sense as the sales and purchase register
 *   templates: a workbook they fill in and hand back. Two sheets, because the
 *   two questions are different sizes:
 *
 *     "2B vs Books (invoice-wise)"  one row per INVOICE — books total against the
 *                                   2B invoice, the difference, the status and
 *                                   what to do. This is the sheet a CA reads.
 *     "Line-wise (working)"         one row per PURCHASE LINE, carrying Line ID
 *                                   and the columns the upload may write. This is
 *                                   the sheet that goes back into the software.
 *
 * WHY BOTH
 *   The reconciliation itself is line-level: `purchase_lines` stores one row per
 *   source row, and the ITC decision is taken per line. But GSTR-2B is
 *   INVOICE-level — one 2B invoice against several book lines of the same invoice
 *   is normal. A line-level-only file makes that look like several small
 *   mismatches instead of one invoice that agrees, which is how a correct month
 *   gets read as a broken one.
 *
 * THE RULE THAT KEEPS THE TWO SHEETS HONEST
 *   The 2B figures are taken from ONE matched line, never summed across the
 *   lines of an invoice. Every line of a multi-line invoice matched the same 2B
 *   invoice and therefore carries the SAME 2B amounts; adding them up would count
 *   one 2B invoice once per item line. (That is the same double-count the sales
 *   item lines had to be split into a child table to avoid — see migration 22.)
 *   The BOOKS side is the opposite: it is summed, because each line really is
 *   part of that invoice's value.
 *
 * WHAT AN UPLOAD MAY CHANGE
 *   Nothing here writes anything itself. The file is read back by
 *   `report-import.ts`, which may write `recon_*`, the ITC decision, the return
 *   classification and the follow-up columns — and never a `book_*` amount. So a
 *   sheet that comes back with the amounts "corrected" cannot move a rupee.
 */

import XLSX from 'xlsx';

import { polishWorkbook } from './xlsx-format';
import { normGstin, normInvoice, r2 } from '../engine/core';
import {
  BOOK_COLS,
  DECISION_COLS,
  FOLLOWUP_COLS,
  RECON_COLS,
  TWOB_COLS,
  toCsv,
  toWorksheet,
  type Column,
} from './reports';

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

/**
 * Sheet 1 — one row per invoice.
 *
 * `Lines` is deliberately the second column after the identity: an invoice that
 * shows three book lines against one 2B invoice is read differently from an
 * invoice that is genuinely three short invoices, and the count is what tells
 * them apart.
 */
export const TWOB_RECON_INVOICE_COLUMNS: Column[] = [
  { h: 'GSTIN', k: 'our_gstin', t: 'gstin', w: 19 },
  { h: 'Period', k: 'period', t: 'period', w: 9 },
  { h: 'Supplier GSTIN', k: 'book_supplier_gstin', t: 'gstin', w: 19 },
  { h: 'Supplier Name', k: 'party_name', t: 'text', w: 30 },
  { h: 'Invoice No', k: 'book_invoice_no', t: 'text', w: 18 },
  { h: 'Invoice Date', k: 'book_invoice_date', t: 'date', w: 13 },
  { h: 'Lines', k: 'line_count', t: 'int', w: 7 },
  { h: 'Book Taxable Value', k: 'book_taxable_value', t: 'money', w: 17 },
  { h: 'Book IGST', k: 'book_igst', t: 'money', w: 13 },
  { h: 'Book CGST', k: 'book_cgst', t: 'money', w: 13 },
  { h: 'Book SGST', k: 'book_sgst', t: 'money', w: 13 },
  { h: 'Book CESS', k: 'book_cess', t: 'money', w: 12 },
  { h: 'Book ITC', k: 'book_itc', t: 'money', w: 14 },
  { h: '2B Matched', k: 'matched_yesno', t: 'text', w: 11 },
  { h: '2B Matched Month', k: 'matched_2b_month', t: 'period', w: 12 },
  { h: '2B Invoice No', k: 'twob_invoice_no', t: 'text', w: 18 },
  { h: '2B Invoice Date', k: 'twob_invoice_date', t: 'date', w: 13 },
  { h: '2B Taxable Value', k: 'twob_taxable_value', t: 'money', w: 16 },
  { h: '2B IGST', k: 'twob_igst', t: 'money', w: 12 },
  { h: '2B CGST', k: 'twob_cgst', t: 'money', w: 12 },
  { h: '2B SGST', k: 'twob_sgst', t: 'money', w: 12 },
  { h: '2B ITC', k: 'twob_itc', t: 'money', w: 13 },
  { h: 'Taxable Difference', k: 'taxable_difference', t: 'money', w: 16 },
  { h: 'ITC Difference', k: 'itc_difference', t: 'money', w: 14 },
  { h: '2B Match Status', k: 'match_status', t: 'text', w: 17 },
  { h: 'Line Status Break-up', k: 'status_breakup', t: 'text', w: 34 },
  { h: 'Duplicate Lines', k: 'duplicate_count', t: 'int', w: 14 },
  { h: 'ITC Decision', k: 'itc_decision', t: 'text', w: 15 },
  { h: 'Kya Karna Hai', k: 'suggested_action', t: 'text', w: 60 },
  { h: 'Locked', k: 'locked_yesno', t: 'text', w: 8 },
];

/**
 * Sheet 2 — one row per purchase line, and the sheet that is uploaded back.
 *
 * The column lists are borrowed from `reports.ts` rather than re-typed: the
 * screen, the CSV, the report and this sheet must agree on a column name, and
 * the upload reads the name.
 */
export const TWOB_RECON_LINE_COLUMNS: Column[] = [
  ...BOOK_COLS,
  ...RECON_COLS,
  ...TWOB_COLS,
  ...DECISION_COLS,
  { h: 'Kya Karna Hai', k: 'suggested_action', t: 'text', w: 60 },
  ...FOLLOWUP_COLS,
];

/** Every column of the working sheet the upload may write, plus the row key. */
export const TWOB_RECON_WRITABLE_HEADERS: string[] = [

  'Line ID',
  'Recon Supplier GSTIN',
  'Recon Invoice No',
  'Recon Invoice Date',
  'ITC Decision',
  'ITC Decision Month',
  'Return Classification',
  'Remarks',
  'Vendor Response',
  'Follow-up Date',
  'Expected Correction',
  'Action Taken',
];

// ---------------------------------------------------------------------------
// grouping: many book lines -> one invoice
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const date10 = (v: unknown): string => (v === null || v === undefined ? '' : String(v).slice(0, 10));

/**
 * Collapse the line-wise reconciliation rows into one row per invoice.
 *
 * The group key is (our GSTIN, period, supplier GSTIN, invoice number). Note
 * what is NOT in it: the invoice DATE. That is deliberate, and it is the reason
 * this sheet and the Duplicate report agree. The engine's own invoice identity is
 * `keyOf(supplier_gstin, invoice_no)` (see `src/engine/match.ts`) — two rows for
 * the same supplier and number are a duplicate booking whether or not the dates
 * differ, and every copy is flagged. If this sheet split them by date it would
 * show two rows where the software reports one duplicated invoice, and the reader
 * would have to guess which of the two the report was talking about.
 *
 * The period stays in the key, so the same invoice number in April and in May is
 * two rows — those are two different months of ITC, not one finding.
 *
 * A difference is left BLANK when the invoice never matched 2B. "Missing in 2B"
 * is not a zero difference and printing one would invite somebody to reconcile
 * it away; there is nothing on the other side to subtract.
 */
export function groupInvoices(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  const groups = new Map<string, Array<Record<string, any>>>();

  for (const r of rows) {
    const key = [
      normGstin(r.our_gstin),
      String(r.period ?? ''),
      normGstin(r.book_supplier_gstin),
      normInvoice(r.book_invoice_no),
    ].join('|');
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: Array<Record<string, any>> = [];

  for (const lines of groups.values()) {
    const first = lines[0];
    const sum = (k: string) => r2(lines.reduce((t, l) => t + num(l[k]), 0));

    // Never summed — see the header comment. One 2B invoice, taken once.
    const matched = lines.find((l) => l.matched_2b_key) ?? null;

    const bookTaxable = sum('book_taxable_value');
    const bookItc = sum('book_itc');
    const twobTaxable = matched ? num(matched.twob_taxable_value) : null;
    const twobItc = matched ? num(matched.twob_itc) : null;

    // Earliest date in the cluster. A duplicate booking often carries two dates,
    // and the oldest one is the one the invoice really belongs to.
    const dates = lines.map((l) => date10(l.book_invoice_date)).filter(Boolean).sort();

    const statuses = [...new Set(lines.map((l) => String(l.match_status || '').trim()).filter(Boolean))];
    const counts = new Map<string, number>();
    for (const s of statuses) counts.set(s, lines.filter((l) => String(l.match_status || '').trim() === s).length);

    const decisions = [...new Set(lines.map((l) => String(l.itc_decision || '').trim()).filter(Boolean))];
    const actions = [...new Set(lines.map((l) => String(l.suggested_action || '').trim()).filter(Boolean))];
    const locked = lines.some((l) => l.is_locked);

    out.push({
      our_gstin: first.our_gstin,
      period: first.period,
      book_supplier_gstin: first.book_supplier_gstin,
      party_name: first.party_name,
      book_invoice_no: first.book_invoice_no,
      book_invoice_date: dates[0] ?? '',
      line_count: lines.length,

      book_taxable_value: bookTaxable,
      book_igst: sum('book_igst'),
      book_cgst: sum('book_cgst'),
      book_sgst: sum('book_sgst'),
      book_cess: sum('book_cess'),
      book_itc: bookItc,

      matched_yesno: matched ? 'YES' : 'No',
      matched_2b_month: matched ? matched.matched_2b_month ?? '' : '',
      twob_invoice_no: matched ? matched.twob_invoice_no ?? '' : '',
      twob_invoice_date: matched ? date10(matched.twob_invoice_date) : '',
      twob_taxable_value: twobTaxable === null ? '' : twobTaxable,
      twob_igst: matched ? num(matched.twob_igst) : '',
      twob_cgst: matched ? num(matched.twob_cgst) : '',
      twob_sgst: matched ? num(matched.twob_sgst) : '',
      twob_itc: twobItc === null ? '' : twobItc,

      taxable_difference: twobTaxable === null ? '' : r2(bookTaxable - twobTaxable),
      itc_difference: twobItc === null ? '' : r2(bookItc - twobItc),

      match_status: statuses.length === 1 ? statuses[0] : statuses.length ? 'Mixed' : '',
      status_breakup: statuses.map((s) => `${s} ${counts.get(s)}`).join(' · '),
      duplicate_count: lines.reduce((m, l) => Math.max(m, num(l.duplicate_count)), 0),
      itc_decision: decisions.join(' | '),
      suggested_action: actions.join(' | '),
      locked_yesno: locked ? 'Locked' : '',
    });
  }

  // Invoice order: supplier, then invoice number, so one vendor's invoices walk
  // together and the 2B side can be read against the book side.
  out.sort(
    (a, b) =>
      String(a.our_gstin).localeCompare(String(b.our_gstin)) ||
      String(a.book_supplier_gstin).localeCompare(String(b.book_supplier_gstin)) ||
      String(a.book_invoice_no).localeCompare(String(b.book_invoice_no)) ||
      String(a.book_invoice_date).localeCompare(String(b.book_invoice_date)),
  );
  return out;
}

// ---------------------------------------------------------------------------
// examples (the shipped skeleton)
// ---------------------------------------------------------------------------

/**
 * Two example invoices, one of each shape that matters:
 *
 *   EXAMPLE-1 — one invoice, TWO item lines, matched against ONE 2B invoice.
 *               This is the case that proves the 2B side is not summed: the 2B
 *               taxable stays 100000 while the two book lines add up to it.
 *   EXAMPLE-2 — booked, absent from 2B, so its difference columns are blank.
 *
 * They carry a Line ID that no database has, so uploading them cannot change
 * anything: the upload rejects an unknown Line ID outright. The Instructions
 * sheet still tells the reader to delete them.
 */
export function exampleLines(): Array<Record<string, any>> {
  const base = {
    our_gstin: '26AALCS9985J1ZC',
    period: '2026-04',
    party_name: 'CROMPTON GREAVES',
    book_supplier_gstin: '27AAFCC9473R1ZP',
    book_invoice_no: 'EXAMPLE-1',
    book_invoice_date: '2026-04-15',
    recon_supplier_gstin: '',
    recon_invoice_no: '',
    recon_invoice_date: '',
    edited_yesno: '',
    itc_decision: 'Pending Review',
    itc_decision_month: '',
    itc_status: 'Matched — Pending Decision',
    return_classification: '',
    decision_by: '',
    decision_at: '',
    decision_reason: '',
    remarks: '',
    vendor_response: '',
    follow_up_date: '',
    expected_correction: '',
    action_taken: '',
    is_locked: false,
  };

  const line1 = {
    ...base,
    id: 999001,
    book_taxable_value: 60000,
    book_igst: 10800,
    book_cgst: 0,
    book_sgst: 0,
    utgst: 0,
    book_cess: 0,
    book_itc: 10800,
    match_status: 'Matched',
    matched_2b_key: 'example-2b.xlsx#2',
    matched_2b_month: '2026-04',
    matched_yesno: 'YES',
    twob_supplier_gstin: '27AAFCC9473R1ZP',
    twob_invoice_no: 'EXAMPLE-1',
    twob_invoice_date: '2026-04-15',
    twob_taxable_value: 100000,
    twob_igst: 18000,
    twob_cgst: 0,
    twob_sgst: 0,
    twob_itc: 18000,
    itc_availability: 'Yes',
    taxable_difference: 0,
    itc_difference: 0,
    duplicate_count: 1,
    mismatch_reason: '',
    suggested_action: '2B se poora match — ITC decision le lo.',
  };

  const line2 = {
    ...line1,
    id: 999002,
    book_taxable_value: 40000,
    book_igst: 7200,
    book_itc: 7200,
    itc_status: 'Matched — Pending Decision',
  };

  const missing = {
    ...base,
    id: 999003,
    party_name: 'TATA STEEL LIMITED',
    book_supplier_gstin: '24AABCU9604R1ZX',
    book_invoice_no: 'EXAMPLE-2',
    book_invoice_date: '2026-04-18',
    book_taxable_value: 25000,
    book_igst: 0,
    book_cgst: 2250,
    book_sgst: 2250,
    utgst: 0,
    book_cess: 0,
    book_itc: 4500,
    match_status: 'Missing in 2B',
    matched_2b_key: null,
    matched_2b_month: '',
    matched_yesno: 'No',
    twob_supplier_gstin: '',
    twob_invoice_no: '',
    twob_invoice_date: '',
    twob_taxable_value: null,
    twob_igst: 0,
    twob_cgst: 0,
    twob_sgst: 0,
    twob_itc: null,
    itc_availability: '',
    taxable_difference: null,
    itc_difference: null,
    duplicate_count: 1,
    mismatch_reason: 'No document in GSTR-2B',
    itc_status: 'Pending — No 2B',
    suggested_action: 'Vendor se poocho — 2B me nahi hai. Follow-up Date aur Vendor Response bharein.',
  };

  return [line1, line2, missing];
}

// ---------------------------------------------------------------------------
// the workbook
// ---------------------------------------------------------------------------

export interface TwobReconTemplateOptions {
  /** Printed on the Instructions sheet, e.g. "SAKAR ELECTRICALS & ELECTRONICS PVT LTD". */
  companyName?: string;
  /** The GSTIN / month the rows belong to, when they are real rows. */
  gstin?: string;
  period?: string;
  /** Line-level reconciliation rows. Empty (or missing) builds the skeleton. */
  rows?: Array<Record<string, any>>;
  /** Any filter the caller applied, so the sheet says where its rows came from. */
  filters?: string[];
}

/** A short label for the sheet that says whether it carries data or examples. */
function sheetStamp(opts: TwobReconTemplateOptions): string {
  const real = (opts.rows?.length ?? 0) > 0;
  if (!real) return 'EXAMPLE ROWS — inhe delete karke apna data daalein (asli file app se download karein)';
  const bits = [opts.companyName || '', opts.gstin || '', opts.period || '', ...(opts.filters ?? [])]
    .map((s) => String(s).trim())
    .filter(Boolean);
  return `Asli reconciliation${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
}

function instructionsSheet(opts: TwobReconTemplateOptions, lineCount: number, invoiceCount: number): XLSX.WorkSheet {
  const rows: unknown[][] = [
    ['GST CONTROL ERP — GSTR-2B vs BOOKS, INVOICE-TO-INVOICE RECONCILIATION'],
    [],
    ['Is file me har invoice ke saamne uski GSTR-2B entry hai. Ek row = ek invoice.'],
    [],
    ['SHEET 1 — "2B vs Books (invoice-wise)"'],
    ['Ek row = EK INVOICE. Books ka total (saari item lines jodkar) vs usi invoice ka 2B amount.'],
    ['  * "Lines" batata hai ki us invoice ki books me kitni lines hain. 3 lines + 1 2B invoice ka matlab'],
    ['    hai hamara register item-wise hai aur 2B invoice-wise — yeh mismatch nahi hai.'],
    ['  * Invoice ki pehchan Supplier GSTIN + Invoice No hai (date nahi) — wahi pehchan jo software ka'],
    ['    Duplicate report use karta hai. Isliye ek hi number do baar booka ho to yeh EK row banta hai'],
    ['    jisme "Lines" > 1 aur "Duplicate Lines" bhi dikhta hai, aur date sabse purani li jaati hai.'],
    ['  * 2B wale columns us ek 2B invoice se aate hain, JODE nahi jaate (warna ek 2B invoice'],
    ['    har item line par ginn li jaati). Books wale columns jode jaate hain — wo waqai us invoice ka hissa hain.'],
    ['  * "Taxable Difference" aur "ITC Difference" = Books − 2B.'],
    ['  * "Missing in 2B" par ye dono KHAALI rehte hain — doosri taraf kuch hai hi nahi, isliye'],
    ['    0 likhna galat hoga. 0 ka matlab hai "match hua par difference 0"; khaali ka matlab "compare hi nahi hua".'],
    ['  * "Line Status Break-up" batata hai line-wise status kitni baar aaya — mixed invoice yahin se pakad me aata hai.'],
    [],
    ['SHEET 2 — "Line-wise (working)"'],
    ['Ek row = EK PURCHASE LINE. Yehi sheet wapas upload hoti hai.'],
    ['  * "Line ID" is file ki jaan hai — ise kabhi edit ya delete mat karein.'],
    ['    Upload isi se pehchanta hai ki kaunsi line badalni hai.'],
    ['  * Ye columns bhare ja sakte hain: ' + TWOB_RECON_WRITABLE_HEADERS.join(', ') + '.'],
    ['  * Baaki sab (book_*, 2B, difference, status) padhne ke liye hain. Upload unhe IGNORE karta hai —'],
    ['    file me amount badal kar bhejne se books ka ek rupya nahi hilta.'],
    [],
    ['KAISE KAREIN (poora loop)'],
    ['1.  Software me pehle Books/SAP purchase register upload karein, aur us mahine ki GSTR-2B file.'],
    ['2.  Run chalayein — reconciliation khud ho jaati hai.'],
    ['3.  Reports screen se yahi working sheet download karein (GSTIN + month filter ke saath) —'],
    ['    usme asli lines pehle se bhare hue aate hain.'],
    ['4.  Sheet 2 me ITC Decision / ITC Reason / Vendor Response / Follow-up Date / Remarks bharein.'],
    ['5.  File ko wapas upload karein (Reports screen ka upload). Software pehle poora preview dikhata hai —'],
    ['    kya badlega, kaunsi line locked hai, kaunsi unknown hai. Confirm karne par hi likhta hai.'],
    [],
    ['DIKKATEN (jo app khud bata deta hai)'],
    ['* "Line ID ... is not in this system" — file purani hai (line dobara import hui). Naya download karein.'],
    ['* "... is LOCKED" — us mahine ka lock khula hai. Pehle lock kholna padega, warna kuch nahi likha jayega.'],
    ['* "Line ID appears twice in the file" — ek line do baar hai. Ek row rakhein.'],
    [],
    ['IS FILE KE BAARE ME'],
    [`Company: ${opts.companyName || '(apni company chuniye — GSTIN se pehchan ho jaati hai)'}`],
    [`Rows: ${lineCount} line(s), ${invoiceCount} invoice(s)`],
    [sheetStamp(opts)],
    [],
    ['Sheet 1 ke columns'],
    ['Header', 'Kya dikhata hai'],
  ];

  const noteFor: Record<string, string> = {
    line_count: 'Is invoice ki books me kitni lines hain.',
    book_taxable_value: 'Us invoice ki saari lines ka taxable value, jodkar.',
    book_itc: 'Books ka total ITC (IGST + CGST + SGST + CESS).',
    matched_yesno: 'YES = is invoice ka 2B record mila.',
    twob_taxable_value: '2B invoice ka taxable value — EK hi baar gina jaata hai.',
    taxable_difference: 'Books total − 2B. Missing in 2B par khaali (compare hi nahi hua).',
    itc_difference: 'Books ITC − 2B ITC. Missing in 2B par khaali.',
    match_status: 'Ek hi status ho to wahi, warna Mixed.',
    status_breakup: 'Line-wise status ki ginti — mixed invoice yahin se pakad me aata hai.',
    duplicate_count: 'Is invoice number ki kitni lines books me hain (duplicate ka signal).',
    suggested_action: 'Software ka suggestion — faisla aapka hai.',
    locked_yesno: 'Locked mahine ki line yahan nahi badli ja sakti.',
  };

  for (const c of TWOB_RECON_INVOICE_COLUMNS) {
    rows.push([c.h, noteFor[c.k] ?? '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 26 }, { wch: 96 }];
  return ws;
}

/**
 * The workbook: Instructions + invoice-wise sheet + line-wise working sheet.
 *
 * With `rows` it is the real monthly reconciliation; without them it is the
 * blank skeleton that ships in `templates/`.
 */
export function twobReconTemplateBuffer(opts: TwobReconTemplateOptions = {}): Buffer {
  const real = (opts.rows?.length ?? 0) > 0;
  const lines = real ? opts.rows! : exampleLines();
  const invoices = groupInvoices(lines);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, instructionsSheet(opts, lines.length, invoices.length), 'Instructions');
  XLSX.utils.book_append_sheet(wb, toWorksheet(TWOB_RECON_INVOICE_COLUMNS, invoices), '2B vs Books (invoice-wise)');
  XLSX.utils.book_append_sheet(wb, toWorksheet(TWOB_RECON_LINE_COLUMNS, lines), 'Line-wise (working)');

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
}

/**
 * The same template as CSV — sheet 1 only.
 *
 * A CSV cannot carry three sheets and it certainly cannot carry the working
 * sheet's Line IDs usefully (Excel mangles long numbers in CSV), so this is the
 * invoice-wise view for teams without Excel. The file that goes back into the
 * software is the .xlsx.
 */
export function twobReconTemplateCsv(): string {
  return toCsv(TWOB_RECON_INVOICE_COLUMNS, groupInvoices(exampleLines()), [
    'GST CONTROL ERP — GSTR-2B vs Books, invoice-to-invoice reconciliation (sheet 1 of the .xlsx template)',
    'This CSV is for reading. Upload the .xlsx working sheet — the line-wise sheet needs its Line IDs.',
  ]);
}

/** Read a workbook back as { sheetName -> rows } — used by the tests. */
export function readSheets(buf: Buffer): Record<string, unknown[][]> {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const out: Record<string, unknown[][]> = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: true, defval: null, blankrows: false,
    }) as unknown[][];
  }
  return out;
}
