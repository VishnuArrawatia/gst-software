/**
 * GST ERP — Dedicated GSTR-2B Excel Multi-Format & Batch Import Engine (Part 2).
 *
 * Supports BOTH real-world GSTR-2B Excel structures without modifying original source values:
 *   Format A — Consolidated Flat GSTR-2B Excel (e.g. "GSTR-2B" sheet with 2B-Month & GSTIN of Company)
 *   Format B — Official GST Portal Multi-Sheet GSTR-2B Excel ("Read me" + B2B, B2BA, CDNR, CDNRA,
 *              ISD, ISDA, IMPG, IMPGSEZ, IMPS, B2B-CDNR, ECO, ECOA with merged multi-row headers)
 *
 * Pure module (uses SheetJS in-memory parsing only; no DB or filesystem I/O).
 */

import XLSX from 'xlsx';
import crypto from 'node:crypto';
import {
  docAmount,
  fyOf,
  inferDocType,
  isUtWithoutLegislature,
  isValidGstin,
  labelOf,
  normDate,
  normDocType,
  normGstin,
  normInvoice,
  periodFromAny,
  periodOf,
  r2,
  taxOf,
  type Gstr2bRecord,
} from './core';
import { normaliseHeader } from './columns';

export type Gstr2bPeriodMode = 'single' | 'range' | 'multi';

export type Gstr2bCategory =
  | 'B2B'
  | 'B2BA'
  | 'CDNR'
  | 'CDNRA'
  | 'ISD'
  | 'ISDA'
  | 'IMPG'
  | 'IMPGSEZ'
  | 'IMPS'
  | 'ECO'
  | 'ECOA'
  | 'B2B-CDNR'
  | 'OTHER';

export interface Gstr2bExcelRecord extends Gstr2bRecord {
  doc_category: Gstr2bCategory;
  financial_year: string;
  fingerprint: string;
  original_sign_preserved: boolean;
}

export interface Gstr2bExcelValidationError {
  file: string;
  sheet?: string;
  row?: number;
  code:
    | 'INVALID_STRUCTURE'
    | 'MISSING_GSTIN'
    | 'INVALID_GSTIN'
    | 'MISSING_PERIOD'
    | 'PERIOD_MISMATCH'
    | 'MISSING_DOC_NO'
    | 'MISSING_SUPPLIER'
    | 'MISSING_SUPPLIER_GSTIN'
    | 'UNAUTHORIZED_GSTIN'
    | 'EMPTY_FILE';
  message: string;
}

export interface Gstr2bExcelFilePreview {
  fileName: string;
  fileSha256: string;
  format: 'Official Multi-Sheet GSTR-2B' | 'Consolidated GSTR-2B Excel' | 'Invalid';
  gstins: string[];
  financialYears: string[];
  returnPeriods: string[];
  categories: Gstr2bCategory[];
  totalRecords: number;
  acceptedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  validationErrors: Gstr2bExcelValidationError[];
  totalTaxable: number;
  totalTax: number;
  sample: Array<Record<string, unknown>>;
}

export interface Gstr2bExcelBatchPreview {
  periodMode: Gstr2bPeriodMode;
  selectedPeriods: string[];
  files: Gstr2bExcelFilePreview[];
  gstins: string[];
  financialYears: string[];
  returnPeriods: string[];
  categories: Gstr2bCategory[];
  totalRecords: number;
  acceptedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  validationErrors: Gstr2bExcelValidationError[];
  acceptedRows: Gstr2bExcelRecord[];
  duplicateRows: Array<{ file: string; sheet: string; row: number; reason: string; invoice_no: string; supplier_gstin: string; period: string }>;
}

export interface Gstr2bExcelParseOptions {
  periodMode?: Gstr2bPeriodMode;
  period?: string;
  from?: string;
  to?: string;
  periods?: string[];
  fallbackGstin?: string;
  financialYear?: string;
  /** Optional list of permitted GSTINs for current user (enforced cleanly). */
  allowedGstins?: string[] | null;
  /** Existing DB fingerprints (`fingerprintOfGstr2bRecord`) for cross-batch & overlapping duplicate check. */
  existingDbFingerprints?: Set<string>;
  /** Existing DB soft-keys (`our_gstin|supplier_gstin|normInv|docType`) -> Set<period> for overlap detection. */
  existingDbSoftKeys?: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// Helpers: period expansion & sheet classification
// ---------------------------------------------------------------------------

/** Expand continuous or selected periods into sorted distinct `YYYY-MM` values. */
export function expandSelectedPeriods(opts: {
  periodMode?: Gstr2bPeriodMode;
  period?: string;
  from?: string;
  to?: string;
  periods?: string[];
}): string[] {
  const mode = opts.periodMode ?? 'single';
  const normP = (v?: string) => periodFromAny(v || '') || (/^\d{4}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : '');

  if (mode === 'single') {
    const p = normP(opts.period);
    return p ? [p] : [];
  }
  if (mode === 'range') {
    const start = normP(opts.from);
    const end = normP(opts.to);
    if (!start || !end) return [start, end].filter(Boolean);
    const lo = start <= end ? start : end;
    const hi = start <= end ? end : start;
    const [sy, sm] = lo.split('-').map(Number);
    const [ey, em] = hi.split('-').map(Number);
    const out: string[] = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
      if (out.length > 120) break;
    }
    return out;
  }
  const set = new Set<string>();
  for (const raw of opts.periods ?? []) {
    const p = normP(raw);
    if (p) set.add(p);
  }
  return [...set].sort();
}

const SKIP_SUMMARY_SHEETS = new Set([
  'read me', 'readme', 'instructions', 'summary',
  'itc available', 'itc not available', 'itc reversal', 'itc rejected',
  'itc summary', 'dashboard',
]);

function categoryFromSheetName(name: string): Gstr2bCategory | null {
  const s = name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (SKIP_SUMMARY_SHEETS.has(s)) return null;
  if (s === 'b2b' || s.startsWith('b2b ') || s === 'b2b invoices') return 'B2B';
  if (s === 'b2ba' || s.includes('b2b amend')) return 'B2BA';
  if (s === 'cdnr' || s.startsWith('cdnr ') || s.includes('credit debit note')) return 'CDNR';
  if (s === 'cdnra' || s.includes('cdnr amend')) return 'CDNRA';
  if (s === 'b2b-cdnr' || s === 'b2b cdnr') return 'B2B-CDNR';
  if (s === 'isd') return 'ISD';
  if (s === 'isda') return 'ISDA';
  if (s === 'impg' || s === 'import of goods' || s === 'imp of goods') return 'IMPG';
  if (s === 'impgsez' || s.includes('sez')) return 'IMPGSEZ';
  if (s === 'imps' || s === 'import of services' || s === 'imp of services') return 'IMPS';
  if (s === 'eco') return 'ECO';
  if (s === 'ecoa') return 'ECOA';
  if (s === 'gstr-2b' || s === 'gstr 2b' || s === 'gstr2b' || s === '2b' || s === 'sheet1' || s === 'data') {
    return 'OTHER';
  }
  return null;
}

const TOTALS_RE = /^\s*(grand\s*total|total|subtotal|sub\s*total)\b/i;

function numCell(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? r2(v) : 0;
  const s = String(v).replace(/[,₹\s]/g, '').trim();
  if (!s || s === '-' || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? r2(n) : 0;
}

function boolCell(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'r';
}

function parseMonthText(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) return periodFromAny(raw);
  const s = String(raw).trim();
  if (!s) return '';
  // MMYYYY e.g. 042026
  const mmyyyy = /^(\d{2})(\d{4})$/.exec(s);
  if (mmyyyy) {
    const mm = Number(mmyyyy[1]), yy = Number(mmyyyy[2]);
    if (mm >= 1 && mm <= 12 && yy >= 2017) return `${yy}-${String(mm).padStart(2, '0')}`;
  }
  // MM/YYYY or MM-YYYY
  const mmyySep = /^(\d{1,2})[/\-](\d{4})$/.exec(s);
  if (mmyySep) {
    const mm = Number(mmyySep[1]), yy = Number(mmyySep[2]);
    if (mm >= 1 && mm <= 12 && yy >= 2017) return `${yy}-${String(mm).padStart(2, '0')}`;
  }
  // YYYY/MM or YYYY-MM
  const yymmSep = /^(\d{4})[/\-](\d{1,2})$/.exec(s);
  if (yymmSep) {
    const yy = Number(yymmSep[1]), mm = Number(yymmSep[2]);
    if (mm >= 1 && mm <= 12 && yy >= 2017) return `${yy}-${String(mm).padStart(2, '0')}`;
  }
  // Full month name e.g. "April 2026", "Apr 2026", "April-2026"
  const months: Record<string, string> = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', sept: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const mName = /^([A-Za-z]+)[-\s',./]*(\d{2,4})$/.exec(s);
  if (mName && months[mName[1].toLowerCase()]) {
    let yy = Number(mName[2]);
    if (yy < 100) yy += 2000;
    return `${yy}-${months[mName[1].toLowerCase()]}`;
  }
  return periodFromAny(s);
}

/** Extract workbook-level GSTIN / Financial Year / Return Period from Read me or top banner cells. */
function extractWorkbookMeta(wb: XLSX.WorkBook): {
  gstin: string;
  financialYear: string;
  returnPeriod: string;
} {
  let gstin = '';
  let financialYear = '';
  let returnPeriod = '';

  const candidateSheets = wb.SheetNames.filter((n) =>
    /read\s*me|summary|info|cover|itc/i.test(n),
  );
  if (!candidateSheets.length && wb.SheetNames.length) candidateSheets.push(wb.SheetNames[0]);

  for (const sName of candidateSheets) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sName], {
      header: 1, raw: true, defval: null,
    }) as unknown[][];
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '').trim();
        if (!cell) continue;
        const low = cell.toLowerCase();
        const nextVal = row[c + 1] ?? row[c + 2] ?? '';

        if (!gstin && (low.includes('gstin') || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]/.test(cell.toUpperCase()))) {
          if (isValidGstin(cell)) gstin = normGstin(cell);
          else if (isValidGstin(nextVal)) gstin = normGstin(nextVal);
        }
        if (!financialYear && (low === 'fy' || low.includes('financial year') || low.includes('year'))) {
          const fyMatch = /(\d{4}\s*-\s*\d{2,4})/.exec(String(nextVal || cell));
          if (fyMatch) financialYear = fyMatch[1].replace(/\s+/g, '');
        }
        if (!returnPeriod && (low.includes('return period') || low.includes('tax period') || low === 'period' || low === 'month')) {
          const p = parseMonthText(nextVal) || parseMonthText(cell.replace(/.*[:\-]\s*/, ''));
          if (p) returnPeriod = p;
        }
      }
    }
  }
  return { gstin, financialYear, returnPeriod };
}

// ---------------------------------------------------------------------------
// Portal & consolidated Excel header recognition
// ---------------------------------------------------------------------------

type FieldKey =
  | 'our_gstin'
  | 'supplier_gstin'
  | 'supplier_name'
  | 'invoice_no'
  | 'invoice_type'
  | 'invoice_date'
  | 'invoice_value'
  | 'place_of_supply'
  | 'reverse_charge'
  | 'applicable_pct'
  | 'taxable_value'
  | 'igst'
  | 'cgst'
  | 'sgst'
  | 'utgst'
  | 'cess'
  | 'period'
  | 'filing_date'
  | 'itc_availability'
  | 'reason'
  | 'port_code'
  | 'amendment_no'
  | 'amendment_date';

const PORTAL_HEADER_MAP: Array<[RegExp, FieldKey]> = [
  [/^(our\s*gstin|our\s*gstn|gstin\s*of\s*company|gstin\s*of\s*recipient(\s*entity)?|company\s*gstin|recipient\s*gstin)$/, 'our_gstin'],
  [/^(gstin\s*of\s*supplier|gstin\s*of\s*the\s*supplier|supplier\s*gstin|isd\s*gstin|gstin\s*of\s*sez\s*supplier|gstin\s*uin|gstin\s*\/\s*uin)$/, 'supplier_gstin'],
  [/^(trade\s*\/?\s*legal\s*name|trade\s*legal\s*name|supplier\s*name|legal\s*name|trade\s*name|name\s*of\s*isd|isd\s*name|name\s*of\s*supplier|party\s*name|vendor\s*name)$/, 'supplier_name'],
  [/^(invoice\s*number|invoice\s*no|note\s*number|note\s*no|isd\s*document\s*number|isd\s*doc\s*no|bill\s*of\s*entry\s*number|boe\s*number|boe\s*no|document\s*number|doc\s*no)$/, 'invoice_no'],
  [/^(invoice\s*type|note\s*type|isd\s*document\s*type|note\s*supply\s*type|document\s*type|doc\s*type)$/, 'invoice_type'],
  [/^(invoice\s*date|note\s*date|isd\s*document\s*date|isd\s*doc\s*date|bill\s*of\s*entry\s*date|boe\s*date|document\s*date|doc\s*date)$/, 'invoice_date'],
  [/^(invoice\s*value|note\s*value|bill\s*of\s*entry\s*value|boe\s*value|document\s*value|total\s*invoice\s*value)(\s*₹)?$/, 'invoice_value'],
  [/^(place\s*of\s*supply|pos)$/, 'place_of_supply'],
  [/^(supply\s*attract\s*reverse\s*charge|reverse\s*charge|rcm|supply\s*attracts\s*reverse\s*charge)$/, 'reverse_charge'],
  [/^(applicable\s*%?\s*of\s*tax\s*rate|applicable\s*pct\s*of\s*tax\s*rate)$/, 'applicable_pct'],
  [/^(taxable\s*value|taxable\s*amount)(\s*₹)?$/, 'taxable_value'],
  [/^(integrated\s*tax|igst|igst\s*amount)(\s*₹)?$/, 'igst'],
  [/^(central\s*tax|cgst|cgst\s*amount)(\s*₹)?$/, 'cgst'],
  [/^(state\s*\/?\s*ut\s*tax|sgst(\s*\/\s*utgst)?|sgst\s*amount)(\s*₹)?$/, 'sgst'],
  [/^(utgst(\s*amount|\s*amt|\s*input)?|union\s*territory\s*tax|ut\s*tax)(\s*₹)?$/, 'utgst'],
  [/^(cess|cess\s*amount)(\s*₹)?$/, 'cess'],
  [/^(2b\s*-?\s*month|return\s*period|tax\s*period|gstr\s*-?\s*1\s*\/?\s*iff\s*\/?\s*gstr\s*-?\s*5\s*period|gstr\s*1\s*iff\s*period|period|month)$/, 'period'],
  [/^(gstr\s*-?\s*1\s*[/-]?\s*iff\s*[/-]?\s*gstr\s*-?\s*5\s*filing\s*date|gstr\s*-?\s*1\s*filing\s*date|filing\s*date|gstr\s*-?\s*6\s*filing\s*date)$/, 'filing_date'],
  [/^(itc\s*availability|itc\s*available|eligibility|itc\s*eligibility)$/, 'itc_availability'],
  [/^(reason|itc\s*reason|reason\s*for\s*ineligibility)$/, 'reason'],
  [/^(port\s*code)$/, 'port_code'],
  [/^(revised\s*note\s*number|original\s*invoice\s*number|original\s*note\s*number)$/, 'amendment_no'],
  [/^(original\s*invoice\s*date|original\s*note\s*date)$/, 'amendment_date'],
];

function mapPortalHeaderCell(raw: unknown): FieldKey | null {
  const norm = normaliseHeader(raw).replace(/\s*\(rs\)|\(inr\)|\(₹\)/g, '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  for (const [re, key] of PORTAL_HEADER_MAP) {
    if (re.test(norm)) return key;
  }
  return null;
}

function detectSheetHeaderRow(rows: unknown[][]): {
  headerRowIdx: number;
  colMap: Map<FieldKey, number>;
} {
  let bestRow = -1;
  let bestScore = 0;
  let bestMap = new Map<FieldKey, number>();

  const scanLimit = Math.min(rows.length, 15);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r] || [];
    const cur = new Map<FieldKey, number>();
    let hits = 0;
    for (let c = 0; c < row.length; c++) {
      let fk = mapPortalHeaderCell(row[c]);
      // Handle 2-row merged GST portal headers where top row has "Tax Amount" & bottom has "Integrated Tax"
      // OR where subheader has "Number"/"Date"/"Value" under "Invoice details" / "Note details" / "Bill of entry"
      if (!fk && r > 0) {
        const sub = String(row[c] ?? '').trim().toLowerCase();
        const sup = String(rows[r - 1]?.[c] ?? '').trim().toLowerCase();
        if (sub && sup) fk = mapPortalHeaderCell(`${sup} ${sub}`);
      }
      if (fk) {
        hits++;
        // Prefer 2B-Month over GSTR-1 period if both present
        if (!cur.has(fk) || (fk === 'period' && /2b|return|tax/i.test(String(row[c] ?? '')))) {
          cur.set(fk, c);
        }
      }
    }
    const hasDoc = cur.has('invoice_no') || cur.has('taxable_value');
    const score = cur.size * 10 + hits + (cur.has('invoice_no') ? 25 : 0) + (cur.has('taxable_value') ? 25 : 0);
    if (hasDoc && cur.size >= 3 && score > bestScore) {
      bestScore = score;
      bestRow = r;
      bestMap = cur;
    }
  }
  return { headerRowIdx: bestRow, colMap: bestMap };
}

/** Deterministic content fingerprint used for intra-file, intra-batch & cross-batch duplicate detection. */
export function fingerprintOfGstr2bRecord(r: Pick<
  Gstr2bRecord,
  'our_gstin' | 'supplier_gstin' | 'invoice_no' | 'invoice_type' | 'period' | 'portal_fp' | 'invoice_date' | 'taxable_value' | 'igst' | 'cgst' | 'sgst' | 'utgst' | 'cess'
> & { doc_category?: string }): string {
  const docT = normDocType(r.invoice_type);
  const per = (r.portal_fp || r.period || '').slice(0, 7);
  return [
    normGstin(r.our_gstin),
    normGstin(r.supplier_gstin),
    normInvoice(r.invoice_no),
    docT,
    r.doc_category || (docT === 'Credit Note' ? 'CDNR' : 'B2B'),
    per,
    String(r.invoice_date || '').slice(0, 10),
    r2(r.taxable_value).toFixed(2),
    r2(r.igst).toFixed(2),
    r2(r.cgst).toFixed(2),
    r2(r.sgst).toFixed(2),
    r2(r.utgst ?? 0).toFixed(2),
    r2(r.cess).toFixed(2),
  ].join('|');
}

function softKeyOf2b(r: Gstr2bExcelRecord): string {
  return `${normGstin(r.our_gstin)}|${normGstin(r.supplier_gstin)}|${normInvoice(r.invoice_no)}|${normDocType(r.invoice_type)}`;
}

// ---------------------------------------------------------------------------
// Main parser: batch preview & structured records
// ---------------------------------------------------------------------------

export function parseGstr2bExcelBatch(
  files: Array<{ name: string; buffer: Buffer }>,
  opts: Gstr2bExcelParseOptions = {},
): Gstr2bExcelBatchPreview {
  const periodMode: Gstr2bPeriodMode = opts.periodMode ?? 'single';
  const selectedPeriods = expandSelectedPeriods({
    periodMode,
    period: opts.period,
    from: opts.from,
    to: opts.to,
    periods: opts.periods,
  });
  const selectedSet = new Set(selectedPeriods);
  const allowedSet = opts.allowedGstins ? new Set(opts.allowedGstins.map(normGstin)) : null;

  const seenFingerprints = new Set<string>(opts.existingDbFingerprints ?? []);
  const seenSoftMonths = new Map<string, Set<string>>();
  if (opts.existingDbSoftKeys) {
    for (const [k, s] of opts.existingDbSoftKeys) seenSoftMonths.set(k, new Set(s));
  }

  const batchErrors: Gstr2bExcelValidationError[] = [];
  const filePreviews: Gstr2bExcelFilePreview[] = [];
  const acceptedRows: Gstr2bExcelRecord[] = [];
  const duplicateRows: Gstr2bExcelBatchPreview['duplicateRows'] = [];

  for (const file of files) {
    const fileSha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const fileErrors: Gstr2bExcelValidationError[] = [];
    const fileGstins = new Set<string>();
    const fileFys = new Set<string>();
    const filePeriods = new Set<string>();
    const fileCats = new Set<Gstr2bCategory>();
    const sample: Array<Record<string, unknown>> = [];

    let totalRecords = 0;
    let acceptedRecords = 0;
    let duplicateRecords = 0;
    let rejectedRecords = 0;
    let totalTaxable = 0;
    let totalTax = 0;
    let recognizedSheetCount = 0;
    let isMultiSheetPortal = false;

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    } catch (e: any) {
      const err: Gstr2bExcelValidationError = {
        file: file.name,
        code: 'INVALID_STRUCTURE',
        message: `Excel/CSV file unreadable: ${e?.message || 'corrupt workbook'}`,
      };
      fileErrors.push(err);
      batchErrors.push(err);
      filePreviews.push({
        fileName: file.name, fileSha256: fileSha, format: 'Invalid',
        gstins: [], financialYears: [], returnPeriods: [], categories: [],
        totalRecords: 0, acceptedRecords: 0, duplicateRecords: 0, rejectedRecords: 1,
        validationErrors: fileErrors, totalTaxable: 0, totalTax: 0, sample: [],
      });
      continue;
    }

    const meta = extractWorkbookMeta(wb);
    const metaPeriod = meta.returnPeriod || '';
    const sheetCats = wb.SheetNames.map((n) => ({ name: n, cat: categoryFromSheetName(n) }));
    const explicitPortalSheets = sheetCats.filter((s) => s.cat && s.cat !== 'OTHER');
    if (explicitPortalSheets.length > 0 && wb.SheetNames.length >= 2) isMultiSheetPortal = true;

    for (const { name: sheetName, cat: mappedCat } of sheetCats) {
      if (mappedCat === null) continue; // summary / Read me sheet
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const rows = XLSX.utils.sheet_to_json(ws, {
        header: 1, raw: true, defval: null, blankrows: false,
      }) as unknown[][];
      if (!rows.length) continue;

      const { headerRowIdx, colMap } = detectSheetHeaderRow(rows);
      if (headerRowIdx < 0 || !colMap.has('invoice_no') || (!colMap.has('taxable_value') && !colMap.has('igst'))) {
        continue;
      }
      recognizedSheetCount++;

      // Check whether this sheet explicitly carries at least one supplier GSTIN/ISD/Port column
      const hasSupplierCol = colMap.has('supplier_gstin') || colMap.has('port_code');
      if (!hasSupplierCol) {
        const err: Gstr2bExcelValidationError = {
          file: file.name, sheet: sheetName, row: headerRowIdx + 1,
          code: 'INVALID_STRUCTURE',
          message: `Sheet "${sheetName}" lacks Supplier GSTIN / Port Code column.`,
        };
        fileErrors.push(err);
        batchErrors.push(err);
        continue;
      }

      for (let r = headerRowIdx + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
        const firstCell = String(row[0] ?? '').trim();
        if (TOTALS_RE.test(firstCell)) continue;
        // Skip GST Portal repeated group-header / subheader lines
        const colGet = (k: FieldKey): unknown => {
          const idx = colMap.get(k);
          return idx !== undefined ? row[idx] : undefined;
        };

        const rawInv = colGet('invoice_no');
        const invStr = (rawInv instanceof Date ? normDate(rawInv) : String(rawInv ?? '')).trim();
        if (/^(invoice number|note number|document number|isd document number|bill of entry number)$/i.test(invStr)) {
          continue;
        }

        const rawSupGstin = normGstin(colGet('supplier_gstin'));
        const portCode = String(colGet('port_code') ?? '').trim().toUpperCase();
        const isImport = mappedCat === 'IMPG' || mappedCat === 'IMPGSEZ';

        // Skip trailing blank / descriptive note rows that carry neither invoice no nor any amount
        const rawTx = numCell(colGet('taxable_value'));
        const rawIg = numCell(colGet('igst'));
        const rawCg = numCell(colGet('cgst'));
        const rawSg = numCell(colGet('sgst'));
        const rawUt = numCell(colGet('utgst'));
        const rawCe = numCell(colGet('cess'));
        const rawIv = numCell(colGet('invoice_value'));
        if (!invStr && !rawSupGstin && rawTx === 0 && rawIg === 0 && rawCg === 0 && rawSg === 0 && rawUt === 0) continue;

        totalRecords++;

        const supplierGstin = rawSupGstin || (isImport && portCode ? `IMPG${portCode.slice(0, 11)}`.padEnd(15, '0') : '');
        if (!invStr) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'MISSING_DOC_NO',
            message: `Row ${r + 1} (${sheetName}): Invoice / Document number is missing.`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }
        if (!supplierGstin) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'MISSING_SUPPLIER_GSTIN',
            message: `Row ${r + 1} (${sheetName}): Supplier GSTIN is missing for document ${invStr}.`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }

        const rowOurGstin = normGstin(colGet('our_gstin')) || meta.gstin || normGstin(opts.fallbackGstin);
        if (!rowOurGstin) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'MISSING_GSTIN',
            message: `Row ${r + 1} (${sheetName}): Recipient / Company GSTIN is missing.`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }
        if (!isValidGstin(rowOurGstin)) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'INVALID_GSTIN',
            message: `Row ${r + 1} (${sheetName}): Invalid Company GSTIN "${rowOurGstin}".`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }
        if (allowedSet && !allowedSet.has(rowOurGstin)) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'UNAUTHORIZED_GSTIN',
            message: `Row ${r + 1} (${sheetName}): User is not permitted to import GSTIN ${rowOurGstin}.`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }

        const invDate = normDate(colGet('invoice_date'));
        const rowExplicitPeriod = parseMonthText(colGet('period')) || metaPeriod;
        // CRITICAL: Never overwrite the actual source period when it exists!
        // Only fall back to selectedPeriod in single-month mode when source had no explicit period.
        const actualPeriod =
          rowExplicitPeriod ||
          (periodMode === 'single' && selectedPeriods.length === 1 ? selectedPeriods[0] : '') ||
          periodOf(invDate);

        if (!actualPeriod || !/^\d{4}-\d{2}$/.test(actualPeriod)) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'MISSING_PERIOD',
            message: `Row ${r + 1} (${sheetName}): Return period missing for document ${invStr}.`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }

        if (selectedSet.size > 0 && !selectedSet.has(actualPeriod)) {
          rejectedRecords++;
          const err: Gstr2bExcelValidationError = {
            file: file.name, sheet: sheetName, row: r + 1, code: 'PERIOD_MISMATCH',
            message: `Row ${r + 1} (${sheetName}): Document ${invStr} belongs to return period ${labelOf(actualPeriod)} (${actualPeriod}), outside selected scope [${selectedPeriods.join(', ')}].`,
          };
          fileErrors.push(err); batchErrors.push(err);
          continue;
        }

        // Preserve category & determine exact document type without corrupting CN/DN signs
        const rawInvType = String(colGet('invoice_type') ?? '').trim();
        let effectiveCat: Gstr2bCategory = mappedCat;
        if (effectiveCat === 'OTHER') {
          if (/credit|cdnr|^\s*c\s*$|^\s*cn\s*$|debit|^\s*d\s*$|^\s*dn\s*$/i.test(rawInvType)) effectiveCat = 'CDNR';
          else if (/isd/i.test(rawInvType)) effectiveCat = 'ISD';
          else if (/impg|bill of entry/i.test(rawInvType)) effectiveCat = 'IMPG';
          else effectiveCat = 'B2B';
        }

        const hintedType =
          rawInvType ||
          (effectiveCat === 'CDNR' || effectiveCat === 'CDNRA'
            ? (rawTx < 0 ? 'Credit Note' : 'Debit Note')
            : effectiveCat === 'IMPG' || effectiveCat === 'IMPGSEZ'
              ? 'IMPG'
              : 'Regular');

        const docType = inferDocType(hintedType, [rawTx, rawIg, rawCg, rawSg, rawUt, rawCe]);
        const posVal = String(colGet('place_of_supply') ?? (isImport ? portCode : '')).trim();
        const useUtgst = !colMap.has('utgst') && rawUt === 0 && rawSg !== 0 && isUtWithoutLegislature(posVal || rowOurGstin);
        const taxable_value = docAmount(docType, rawTx);
        const igst = docAmount(docType, rawIg);
        const cgst = docAmount(docType, rawCg);
        const sgst = useUtgst ? 0 : docAmount(docType, rawSg);
        const utgst = useUtgst ? docAmount(docType, rawSg) : docAmount(docType, rawUt);
        const cess = docAmount(docType, rawCe);
        const computedVal = r2(taxable_value + taxOf({ igst, cgst, sgst, utgst, cess }));
        const invoice_value = rawIv !== 0 ? docAmount(docType, rawIv) : computedVal;

        const storedDocType =
          docType === 'Credit Note' ? 'Credit Note' : docType === 'Debit Note' ? 'Debit Note' : rawInvType || 'Regular';

        const fy = meta.financialYear || fyOf(actualPeriod);

        const recBase = {
          id: `${file.name}#${sheetName}#${r + 1}`,
          our_gstin: rowOurGstin,
          supplier_gstin: supplierGstin,
          supplier_name: String(colGet('supplier_name') ?? '').trim(),
          invoice_no: invStr,
          invoice_type: storedDocType,
          invoice_date: invDate,
          invoice_value,
          place_of_supply: posVal,
          reverse_charge: boolCell(colGet('reverse_charge')),
          taxable_value,
          igst,
          cgst,
          sgst,
          utgst,
          cess,
          period: actualPeriod,
          portal_fp: actualPeriod,
          filing_date: normDate(colGet('filing_date')) || undefined,
          itc_availability: String(colGet('itc_availability') ?? 'Yes').trim() || 'Yes',
          reason: String(colGet('reason') ?? '').trim() || undefined,
          applicable_pct: String(colGet('applicable_pct') ?? '').trim() || undefined,
          doc_category: effectiveCat,
          original_doc_no: String(colGet('amendment_no') ?? '').trim() || undefined,
          original_doc_date: normDate(colGet('amendment_date')) || undefined,
          financial_year: fy,
          source_taxable_value: rawTx,
          source_igst: rawIg,
          source_cgst: rawCg,
          source_sgst: rawSg,
          source_utgst: rawUt,
          source_cess: rawCe,
          source_file: file.name,
          source_row: r + 1,
          original_sign_preserved: true,
        };

        const fp = fingerprintOfGstr2bRecord(recBase);
        const sk = softKeyOf2b(recBase as Gstr2bExcelRecord);
        const existingMonths = seenSoftMonths.get(sk);

        if (seenFingerprints.has(fp)) {
          duplicateRecords++;
          duplicateRows.push({
            file: file.name, sheet: sheetName, row: r + 1,
            reason: 'Exact duplicate record (same GSTIN, supplier, doc no, type, period & amounts across file/batch/DB)',
            invoice_no: invStr, supplier_gstin: supplierGstin, period: actualPeriod,
          });
          fileGstins.add(rowOurGstin);
          fileFys.add(fy);
          filePeriods.add(actualPeriod);
          fileCats.add(effectiveCat);
          continue;
        }
        if (existingMonths && existingMonths.size > 0 && existingMonths.has(actualPeriod)) {
          duplicateRecords++;
          duplicateRows.push({
            file: file.name, sheet: sheetName, row: r + 1,
            reason: `Overlapping duplicate in return period ${actualPeriod}`,
            invoice_no: invStr, supplier_gstin: supplierGstin, period: actualPeriod,
          });
          fileGstins.add(rowOurGstin);
          fileFys.add(fy);
          filePeriods.add(actualPeriod);
          fileCats.add(effectiveCat);
          continue;
        }

        seenFingerprints.add(fp);
        if (!seenSoftMonths.has(sk)) seenSoftMonths.set(sk, new Set());
        seenSoftMonths.get(sk)!.add(actualPeriod);

        const rec: Gstr2bExcelRecord = { ...recBase, fingerprint: fp };
        acceptedRows.push(rec);
        acceptedRecords++;
        totalTaxable = r2(totalTaxable + taxable_value);
        totalTax = r2(totalTax + taxOf(rec));
        fileGstins.add(rowOurGstin);
        fileFys.add(fy);
        filePeriods.add(actualPeriod);
        fileCats.add(effectiveCat);

        if (sample.length < 25) {
          sample.push({
            our_gstin: rec.our_gstin,
            supplier_gstin: rec.supplier_gstin,
            supplier_name: rec.supplier_name,
            doc_category: rec.doc_category,
            document_type: docType,
            invoice_no: rec.invoice_no,
            invoice_date: rec.invoice_date,
            period: rec.period,
            financial_year: rec.financial_year,
            taxable_value: rec.taxable_value,
            total_tax: taxOf(rec),
            itc_availability: rec.itc_availability,
          });
        }
      }
    }

    if (recognizedSheetCount === 0) {
      const err: Gstr2bExcelValidationError = {
        file: file.name,
        code: 'INVALID_STRUCTURE',
        message: `${file.name} does not match any official GSTR-2B Excel structure (no recognized B2B/CDNR/ISD/IMPG/GSTR-2B table & columns found).`,
      };
      fileErrors.push(err);
      batchErrors.push(err);
      rejectedRecords++;
    } else if (totalRecords === 0 && fileErrors.length === 0) {
      const err: Gstr2bExcelValidationError = {
        file: file.name,
        code: 'EMPTY_FILE',
        message: `${file.name} recognized GSTR-2B structure but contained 0 transaction rows.`,
      };
      fileErrors.push(err);
      batchErrors.push(err);
    }

    filePreviews.push({
      fileName: file.name,
      fileSha256: fileSha,
      format:
        recognizedSheetCount === 0
          ? 'Invalid'
          : isMultiSheetPortal
            ? 'Official Multi-Sheet GSTR-2B'
            : 'Consolidated GSTR-2B Excel',
      gstins: [...fileGstins].sort(),
      financialYears: [...fileFys].filter(Boolean).sort(),
      returnPeriods: [...filePeriods].sort(),
      categories: [...fileCats].sort(),
      totalRecords,
      acceptedRecords,
      duplicateRecords,
      rejectedRecords,
      validationErrors: fileErrors,
      totalTaxable,
      totalTax,
      sample,
    });
  }

  return {
    periodMode,
    selectedPeriods,
    files: filePreviews,
    gstins: [...new Set(filePreviews.flatMap((f) => f.gstins))].sort(),
    financialYears: [...new Set(filePreviews.flatMap((f) => f.financialYears))].sort(),
    returnPeriods: [...new Set(filePreviews.flatMap((f) => f.returnPeriods))].sort(),
    categories: [...new Set(filePreviews.flatMap((f) => f.categories))].sort(),
    totalRecords: filePreviews.reduce((s, f) => s + f.totalRecords, 0),
    acceptedRecords: acceptedRows.length,
    duplicateRecords: duplicateRows.length,
    rejectedRecords: filePreviews.reduce((s, f) => s + f.rejectedRecords, 0),
    validationErrors: batchErrors,
    acceptedRows,
    duplicateRows,
  };
}
