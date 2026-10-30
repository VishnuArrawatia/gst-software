/**
 * Reading what the GST portal says was filed.
 *
 * A GSTR-1 download is not one table. The portal serves it as separate sheets —
 * b2b, b2cl, b2cs, cdnr — and each sheet names its own columns, so a single
 * flat vocabulary would either be too generous (and mis-read a column) or too
 * strict (and drop a sheet). The table is therefore taken from the SHEET NAME
 * first, which the portal always gives, and only then from a column, and only
 * then inferred.
 *
 * Two details of the real export drive most of this file.
 *
 * First, the portal's b2b sheet is RATE-WISE, not invoice-wise. An invoice
 * spanning two slabs is two rows sharing one invoice number, with the invoice
 * value repeated on each. Summing those rows gives a taxable value that is
 * right and an invoice value that is double. So the aggregator here sums money
 * that accumulates and takes the first value that merely repeats.
 *
 * Second, on the cdnr sheet "Invoice Number" means the invoice being credited,
 * not the note. The note itself is "Note Number". Mapping both onto one field
 * would reconcile every credit note against the wrong document and report a
 * clean match for a credit that was never actually linked.
 */

import { pickDataSheet, readAllSheets } from '../app/sheets';
import { normaliseHeader } from './columns';
import {
  fyOf,
  isBlankish,
  normDate,
  normGstin,
  normInvoice,
  normPos,
  periodFromAny,
  r2,
  taxOf,
} from './core';
import { parseTableType, type FiledRow, type Gstr1TableType } from './gstr1-recon';

// ---------------------------------------------------------------------------
// column vocabulary
// ---------------------------------------------------------------------------

/** Canonical field -> accepted header spellings (already lower-cased). */
const ALIASES: Record<string, string[]> = {
  our_gstin: ['gstin of company', 'our gstin', 'gstin/uin of company', 'gstin of the entity', 'taxpayer gstin'],
  table_type: ['table', 'table name', 'section', 'return table', 'type', 'b2b/b2cl/b2cs'],
  recipient_gstin: [
    'gstin of recipient', 'gstin/uin of recipient', 'recipient gstin', 'gstin of receiver',
    'gstin of recipient entity', 'counterparty gstin', 'party gstin',
  ],
  recipient_name: [
    'receiver name', 'recipient name', 'name of recipient', 'trade/legal name of recipient',
    'recipient legal name', 'customer name',
  ],
  // The note's OWN number, only present on a cdnr sheet.
  note_no: ['note number', 'note no', 'note no.', 'credit note number', 'debit note number'],
  invoice_no: ['invoice number', 'invoice no', 'invoice no.', 'bill no', 'document number'],
  // Only used when the export spells the original out separately. The plain
  // "Invoice Number" column is deliberately NOT aliased here: LOOKUP is
  // first-wins, so claiming it in two places would leave one of them with no
  // column at all, and the credit-note swap below has to start from a row it
  // can actually read.
  original_invoice_no: [
    'original invoice no', 'original invoice number', 'linked invoice no',
    'linked invoice number', 'against invoice', 'against invoice no',
  ],
  invoice_date: ['invoice date', 'invoice dt', 'document date', 'bill date'],
  invoice_type: ['invoice type', 'note type', 'note/value', 'document type', 'supply type', 'type of supply'],
  invoice_value: ['invoice value(₹)', 'invoice value', 'total invoice value', 'note value(₹)', 'note value'],
  place_of_supply: ['place of supply', 'place of supply (name)', 'pos', 'place of supply name'],
  reverse_charge: [
    'supply attract reverse charge', 'reverse charge', 'rcm', 'supply attracts reverse charge',
    'reverse charge applicable',
  ],
  hsn: ['hsn', 'hsn code', 'hsn/sac', 'sac', 'sac code'],
  rate: ['rate', 'rate(%)', 'rate %', 'tax rate', 'applicable % of tax rate'],
  taxable_value: ['taxable value (₹)', 'taxable value', 'taxable amount', 'taxable val', 'assessable value'],
  igst: ['integrated tax(₹)', 'integrated tax', 'igst', 'igst amount'],
  cgst: ['central tax(₹)', 'central tax', 'cgst', 'cgst amount'],
  sgst: ['state/ut tax(₹)', 'state/ut tax', 'sgst', 'sgst amount', 'utgst'],
  cess: ['cess(₹)', 'cess', 'cess amount'],
  note_date: ['note date', 'note dt', 'note date (original)'],
  original_invoice_date: ['invoice date (original)', 'original invoice date', 'linked invoice date'],
};

/**
 * Which column wins when two headers both claim the same meaning.
 *
 * `note_no` has to beat `invoice_no` on a cdnr sheet, or the note number and
 * the original invoice number get swapped — the single most damaging mistake
 * this parser could make, because it produces a clean-looking match.
 */
const PRIORITY: Record<string, string[]> = {
  invoice_no: ['note number', 'note no', 'note no.'],
  original_invoice_no: ['original invoice no', 'original invoice number'],
  invoice_date: ['note date', 'invoice date', 'invoice dt'],
  taxable_value: ['taxable value', 'taxable value (₹)'],
};

const LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      const k = normaliseHeader(a);
      if (!m.has(k)) m.set(k, field);
    }
  }
  return m;
})();

function rankOf(field: string, header: string): number {
  const prefs = PRIORITY[field];
  if (!prefs) return 999;
  const i = prefs.indexOf(header);
  return i === -1 ? 999 : i;
}

/** Map one header cell to a canonical field, or null when unrecognised. */
export function detectGstr1Field(header: unknown): string | null {
  return LOOKUP.get(normaliseHeader(header)) ?? null;
}

/** Header row -> field -> column index. First column wins a genuine tie. */
function mapGstr1Headers(headerRow: unknown[]): Map<string, number> {
  const best = new Map<string, { idx: number; rank: number }>();
  headerRow.forEach((cell, idx) => {
    const field = detectGstr1Field(cell);
    if (!field) return;
    const rank = rankOf(field, normaliseHeader(cell));
    const cur = best.get(field);
    if (!cur || rank < cur.rank) best.set(field, { idx, rank });
  });
  const out = new Map<string, number>();
  for (const [field, v] of best) out.set(field, v.idx);
  return out;
}

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

/**
 * Read a money cell.
 *
 * Portal exports carry "1,23,456.78" and occasionally "(123.45)" for a credit.
 * The parentheses are the dangerous case: parsed naively, "(1,234)" is the
 * number 1 with some trailing text, which turns a credit note into a small
 * positive invoice rather than an obvious negative one.
 */
export function parseMoney(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return r2(v);
  let s = String(v).trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,₹\s]/g, '');
  // The sign has to be read BEFORE any other cleanup. Stripping leading dashes
  // first would silently turn a credit into a positive amount.
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/^\+/, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return r2(negative ? -n : n);
}

/** Read a Yes/No cell the way the portal writes it. */
export function parseYesNo(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1';
}

// ---------------------------------------------------------------------------
// table detection
// ---------------------------------------------------------------------------

/**
 * Which table a sheet holds.
 *
 * Sheet name first, because the portal names its tabs b2b / b2cl / b2cs / cdnr
 * and that is unambiguous. Only then a column, and only then inference — and
 * the inference deliberately fails towards B2B, because an unrecognised sheet
 * holding customer GSTINs is far more likely to be B2B than B2CS, and getting
 * that wrong in the conservative direction surfaces as a mismatch a human can
 * check rather than as a silent miscount.
 */
export function detectTable(sheetName: string, headers: unknown[], sampleRows: unknown[][] = []): Gstr1TableType {
  const fromName = parseTableType(sheetName);
  if (fromName) return fromName;

  for (const h of headers) {
    const field = detectGstr1Field(h);
    if (field === 'note_no') return 'CDNR';
  }
  for (const h of headers) {
    const field = detectGstr1Field(h);
    if (field === 'table_type') {
      const declared = parseTableType(h);
      if (declared) return declared;
    }
  }
  // A declared value inside the data beats guessing from the columns.
  for (const row of sampleRows.slice(0, 5)) {
    for (const cell of row) {
      const declared = parseTableType(cell);
      if (declared) return declared;
    }
  }
  return 'B2B';
}

// ---------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------

export interface FiledParseOptions {
  /** Fallback when the export does not name the GSTIN. Required. */
  our_gstin: string;
  /** Fallback when the export does not name the period. Required. */
  period: string;
}

export interface FiledParseResult {
  rows: FiledRow[];
  /** Every sheet in the file, whether or not it held usable rows. */
  sheets: string[];
  /** Sheet name -> how many invoice-level rows it contributed. */
  perSheet: Record<string, number>;
  /** Rows dropped for a reason, with the reason. Surfaced, never silent. */
  skipped: Array<{ sheet: string; row: number; reason: string }>;
  tableOfSheet: Record<string, Gstr1TableType>;
}

/** What one raw row contributes before aggregation. */
interface RawRow {
  table: Gstr1TableType;
  invoice_number: string;
  invoice_date: string;
  note_ref_number: string;
  note_ref_date: string;
  recipient_gstin: string;
  recipient_name: string;
  place_of_supply: string;
  invoice_type: string;
  hsn: string;
  rate: number | null;
  invoice_value: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  reverse_charge: boolean;
  source_row: number;
}

/**
 * True when a parsed JSON value is a GST Portal GSTR-1 return / offline JSON.
 */
export function isGstr1Json(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  const root = (o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : o);
  return (
    Array.isArray(root.b2b) ||
    Array.isArray(root.b2cl) ||
    Array.isArray(root.b2cs) ||
    Array.isArray(root.cdnr) ||
    Array.isArray(root.cdnur) ||
    (typeof root.fp === 'string' && typeof root.gstin === 'string' && !('docdata' in root))
  );
}

/**
 * Parse a GST Portal GSTR-1 JSON object into invoice-level filed rows (`FiledParseResult`).
 */
export function parseFiledJson(data: unknown, opts: FiledParseOptions): FiledParseResult {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  const root = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, any>;
  const ourGstin = normGstin(root.gstin || opts.our_gstin || '');
  let fpPeriod = opts.period || '';
  if (typeof root.fp === 'string' && /^\d{6}$/.test(root.fp.trim())) {
    const fpStr = root.fp.trim();
    if (/^(0[1-9]|1[0-2])20\d{2}$/.test(fpStr)) {
      fpPeriod = `${fpStr.slice(2, 6)}-${fpStr.slice(0, 2)}`;
    } else if (/^20\d{2}(0[1-9]|1[0-2])$/.test(fpStr)) {
      fpPeriod = `${fpStr.slice(0, 4)}-${fpStr.slice(4, 6)}`;
    }
  }

  const raw: RawRow[] = [];
  const sheets: string[] = [];
  const perSheet: Record<string, number> = {};
  const tableOfSheet: Record<string, Gstr1TableType> = {};
  const skipped: FiledParseResult['skipped'] = [];
  let rowSeq = 0;

  const sumItems = (itms: any[]) => {
    let txval = 0, iamt = 0, camt = 0, samt = 0, csamt = 0;
    let rate: number | null = null;
    for (const it of Array.isArray(itms) ? itms : []) {
      const det = it?.itm_det && typeof it.itm_det === 'object' ? it.itm_det : it;
      txval = r2(txval + parseMoney(det?.txval));
      iamt = r2(iamt + parseMoney(det?.iamt));
      camt = r2(camt + parseMoney(det?.camt));
      samt = r2(samt + parseMoney(det?.samt));
      csamt = r2(csamt + parseMoney(det?.csamt));
      if (rate === null && det?.rt !== undefined) rate = parseMoney(det.rt);
    }
    return { txval, iamt, camt, samt, csamt, rate };
  };

  if (Array.isArray(root.b2b)) {
    sheets.push('b2b');
    tableOfSheet['b2b'] = 'B2B';
    let cnt = 0;
    for (const party of root.b2b) {
      const ctin = normGstin(party?.ctin || '');
      const cname = String(party?.trdnm || party?.cname || '');
      for (const inv of Array.isArray(party?.inv) ? party.inv : []) {
        rowSeq++;
        const inum = String(inv?.inum || '').trim();
        const idt = normDate(String(inv?.idt || ''));
        if (!inum) {
          skipped.push({ sheet: 'b2b', row: rowSeq, reason: 'no invoice number' });
          continue;
        }
        const m = sumItems(inv?.itms);
        raw.push({
          table: 'B2B',
          invoice_number: inum,
          invoice_date: idt,
          note_ref_number: '',
          note_ref_date: '',
          recipient_gstin: ctin,
          recipient_name: cname,
          place_of_supply: String(inv?.pos || ''),
          invoice_type: String(inv?.inv_typ || 'R'),
          hsn: '',
          rate: m.rate,
          invoice_value: parseMoney(inv?.val),
          taxable_value: m.txval,
          igst: m.iamt,
          cgst: m.camt,
          sgst: m.samt,
          cess: m.csamt,
          reverse_charge: parseYesNo(inv?.rchrg),
          source_row: rowSeq,
        });
        cnt++;
      }
    }
    perSheet['b2b'] = cnt;
  }

  if (Array.isArray(root.b2cl)) {
    sheets.push('b2cl');
    tableOfSheet['b2cl'] = 'B2CL';
    let cnt = 0;
    for (const posGrp of root.b2cl) {
      const pos = String(posGrp?.pos || '');
      for (const inv of Array.isArray(posGrp?.inv) ? posGrp.inv : []) {
        rowSeq++;
        const inum = String(inv?.inum || '').trim();
        const idt = normDate(String(inv?.idt || ''));
        if (!inum) continue;
        const m = sumItems(inv?.itms);
        raw.push({
          table: 'B2CL',
          invoice_number: inum,
          invoice_date: idt,
          note_ref_number: '',
          note_ref_date: '',
          recipient_gstin: '',
          recipient_name: '',
          place_of_supply: pos || String(inv?.pos || ''),
          invoice_type: 'R',
          hsn: '',
          rate: m.rate,
          invoice_value: parseMoney(inv?.val),
          taxable_value: m.txval,
          igst: m.iamt,
          cgst: m.camt,
          sgst: m.samt,
          cess: m.csamt,
          reverse_charge: false,
          source_row: rowSeq,
        });
        cnt++;
      }
    }
    perSheet['b2cl'] = cnt;
  }

  if (Array.isArray(root.b2cs)) {
    sheets.push('b2cs');
    tableOfSheet['b2cs'] = 'B2CS';
    let cnt = 0;
    for (const b of root.b2cs) {
      rowSeq++;
      raw.push({
        table: 'B2CS',
        invoice_number: '',
        invoice_date: '',
        note_ref_number: '',
        note_ref_date: '',
        recipient_gstin: '',
        recipient_name: '',
        place_of_supply: String(b?.pos || ''),
        invoice_type: 'R',
        hsn: '',
        rate: parseMoney(b?.rt),
        invoice_value: 0,
        taxable_value: parseMoney(b?.txval),
        igst: parseMoney(b?.iamt),
        cgst: parseMoney(b?.camt),
        sgst: parseMoney(b?.samt),
        cess: parseMoney(b?.csamt),
        reverse_charge: false,
        source_row: rowSeq,
      });
      cnt++;
    }
    perSheet['b2cs'] = cnt;
  }

  if (Array.isArray(root.cdnr)) {
    sheets.push('cdnr');
    tableOfSheet['cdnr'] = 'CDNR';
    let cnt = 0;
    for (const party of root.cdnr) {
      const ctin = normGstin(party?.ctin || '');
      const cname = String(party?.trdnm || party?.cname || '');
      for (const nt of Array.isArray(party?.nt) ? party.nt : []) {
        rowSeq++;
        const ntNum = String(nt?.nt_num || nt?.inum || '').trim();
        const ntDt = normDate(String(nt?.nt_dt || nt?.idt || ''));
        if (!ntNum) continue;
        const m = sumItems(nt?.itms);
        const ntty = String(nt?.ntty || 'C').toUpperCase();
        raw.push({
          table: 'CDNR',
          invoice_number: ntNum,
          invoice_date: ntDt,
          note_ref_number: String(nt?.inum || ''),
          note_ref_date: normDate(String(nt?.idt || '')),
          recipient_gstin: ctin,
          recipient_name: cname,
          place_of_supply: String(nt?.pos || ''),
          invoice_type: ntty === 'D' ? 'DN' : 'CN',
          hsn: '',
          rate: m.rate,
          invoice_value: parseMoney(nt?.val),
          taxable_value: m.txval,
          igst: m.iamt,
          cgst: m.camt,
          sgst: m.samt,
          cess: m.csamt,
          reverse_charge: parseYesNo(nt?.rchrg),
          source_row: rowSeq,
        });
        cnt++;
      }
    }
    perSheet['cdnr'] = cnt;
  }

  if (Array.isArray(root.cdnur)) {
    sheets.push('cdnur');
    tableOfSheet['cdnur'] = 'CDNUR';
    let cnt = 0;
    for (const nt of root.cdnur) {
      rowSeq++;
      const ntNum = String(nt?.nt_num || nt?.inum || '').trim();
      const ntDt = normDate(String(nt?.nt_dt || nt?.idt || ''));
      if (!ntNum) continue;
      const m = sumItems(nt?.itms);
      const ntty = String(nt?.ntty || 'C').toUpperCase();
      raw.push({
        table: 'CDNUR',
        invoice_number: ntNum,
        invoice_date: ntDt,
        note_ref_number: String(nt?.inum || ''),
        note_ref_date: normDate(String(nt?.idt || '')),
        recipient_gstin: '',
        recipient_name: '',
        place_of_supply: String(nt?.pos || ''),
        invoice_type: ntty === 'D' ? 'DN' : 'CN',
        hsn: '',
        rate: m.rate,
        invoice_value: parseMoney(nt?.val),
        taxable_value: m.txval,
        igst: m.iamt,
        cgst: m.camt,
        sgst: m.samt,
        cess: m.csamt,
        reverse_charge: false,
        source_row: rowSeq,
      });
      cnt++;
    }
    perSheet['cdnur'] = cnt;
  }

  const folded = foldRows(raw);
  const rows: FiledRow[] = folded.map((f) => ({
    our_gstin: ourGstin,
    period: fpPeriod || (f.invoice_date && periodFromAny(f.invoice_date)) || opts.period,
    table_type: f.table_type,
    invoice_number: f.invoice_number,
    invoice_date: f.invoice_date,
    invoice_type: f.invoice_type,
    recipient_gstin: f.recipient_gstin,
    recipient_name: f.recipient_name,
    place_of_supply: f.place_of_supply,
    reverse_charge: f.reverse_charge,
    hsn: f.hsn,
    taxable_value: f.taxable_value,
    igst: f.igst,
    cgst: f.cgst,
    sgst: f.sgst,
    cess: f.cess,
    invoice_value: f.invoice_value,
    rate: f.rate ?? undefined,
    note_ref_number: f.note_ref_number || undefined,
    note_ref_date: f.note_ref_date || undefined,
    source_row: f.source_row,
  }));

  return { rows, sheets, perSheet, skipped, tableOfSheet };
}

/**
 * Parse a GSTR-1 portal export into invoice-level filed rows.
 *
 * Reads every sheet rather than trusting the first, because a return filed with
 * both B2B and CDNR activity arrives as several tabs and the interesting one is
 * frequently not the first. Also accepts a GST Portal GSTR-1 JSON buffer.
 */
export function parseFiledWorkbook(buf: Buffer, opts: FiledParseOptions): FiledParseResult {
  const headStr = buf.subarray(0, 64).toString('utf8').trimStart();
  if (headStr.startsWith('{')) {
    try {
      const json = JSON.parse(buf.toString('utf8'));
      if (isGstr1Json(json)) return parseFiledJson(json, opts);
    } catch {
      // fall through to workbook reader
    }
  }
  const sheets = readAllSheets(buf);
  const required = ['taxable_value', 'igst', 'cgst', 'sgst'];
  const perSheet: Record<string, number> = {};
  const tableOfSheet: Record<string, Gstr1TableType> = {};
  const skipped: FiledParseResult['skipped'] = [];
  const rows: FiledRow[] = [];

  for (const sheet of sheets) {
    if (!sheet.rows.length) {
      perSheet[sheet.name] = 0;
      continue;
    }
    const picked = pickDataSheet([sheet], required, undefined, detectGstr1Field);
    const headerRow = picked.rows[picked.headerRowIndex] || [];
    const map = mapGstr1Headers(headerRow);
    const table = detectTable(sheet.name, headerRow, picked.rows.slice(picked.headerRowIndex + 1, picked.headerRowIndex + 6));
    tableOfSheet[sheet.name] = table;
    perSheet[sheet.name] = 0;

    // Without money columns the sheet is a cover note or a totals block. Skip
    // it quietly but record it, because "my file uploaded and nothing appeared"
    // is the worst possible import outcome.
    if (!map.has('taxable_value')) {
      skipped.push({ sheet: sheet.name, row: picked.headerRowIndex + 1, reason: 'no taxable value column' });
      continue;
    }

    const raw: RawRow[] = [];
    for (let i = picked.headerRowIndex + 1; i < picked.rows.length; i++) {
      const row = picked.rows[i];
      if (!row || row.every((c) => isBlankish(c))) continue;

      const hasAnyValue = ['invoice_value', 'taxable_value', 'igst', 'cgst', 'sgst', 'cess'].some((f) => {
        const idx = map.get(f);
        return idx !== undefined && !isBlankish(row[idx]);
      });
      if (!hasAnyValue) continue;

      const text = (field: string): string => {
        const idx = map.get(field);
        return idx === undefined ? '' : String(row[idx] ?? '').trim();
      };
      const num = (field: string): number => {
        const idx = map.get(field);
        return idx === undefined ? 0 : parseMoney(row[idx]);
      };
      const has = (field: string): boolean => map.get(field) !== undefined;

      // On a cdnr / cdnur sheet the note is the document and "Invoice Number"
      // is the invoice it credits. Anywhere else, invoice number is the
      // document.
      let invoiceNumber = text('invoice_no');
      let noteRef = '';
      let invoiceDate = normDate(text('invoice_date'));
      let noteRefDate = '';
      if ((table === 'CDNR' || table === 'CDNUR') && has('note_no')) {
        noteRef = invoiceNumber;
        invoiceNumber = text('note_no');
        noteRefDate = invoiceDate;
        invoiceDate = normDate(text('note_date')) || invoiceDate;
        if (has('original_invoice_date')) noteRefDate = normDate(text('original_invoice_date')) || noteRefDate;
      }

      if (!invoiceNumber && table !== 'B2CS') {
        skipped.push({ sheet: sheet.name, row: i + 1, reason: 'no invoice number' });
        continue;
      }

      const rateIdx = map.get('rate');
      const rate = rateIdx === undefined || isBlankish(row[rateIdx]) ? null : parseMoney(row[rateIdx]);

      raw.push({
        table,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        note_ref_number: noteRef,
        note_ref_date: noteRefDate,
        recipient_gstin: text('recipient_gstin'),
        recipient_name: text('recipient_name'),
        place_of_supply: text('place_of_supply'),
        invoice_type: text('invoice_type'),
        hsn: text('hsn'),
        rate,
        invoice_value: num('invoice_value'),
        taxable_value: num('taxable_value'),
        igst: num('igst'),
        cgst: num('cgst'),
        sgst: num('sgst'),
        cess: num('cess'),
        reverse_charge: parseYesNo(text('reverse_charge')),
        source_row: i + 1,
      });
    }

    const folded = foldRows(raw);
    perSheet[sheet.name] = folded.length;
    for (const f of folded) {
      rows.push({
        our_gstin: normGstin(opts.our_gstin),
        // A B2CS aggregate has no invoice date of its own, so it inherits the
        // period the user selected; a document is placed by its own date, which
        // is what lets one file carry a return period and still be right.
        period: (f.invoice_date && periodFromAny(f.invoice_date)) || opts.period,
        table_type: f.table_type,
        invoice_number: f.invoice_number,
        invoice_date: f.invoice_date,
        invoice_type: f.invoice_type,
        recipient_gstin: f.recipient_gstin,
        recipient_name: f.recipient_name,
        place_of_supply: f.place_of_supply,
        reverse_charge: f.reverse_charge,
        hsn: f.hsn,
        taxable_value: f.taxable_value,
        igst: f.igst,
        cgst: f.cgst,
        sgst: f.sgst,
        cess: f.cess,
        invoice_value: f.invoice_value,
        rate: f.rate ?? undefined,
        note_ref_number: f.note_ref_number || undefined,
        note_ref_date: f.note_ref_date || undefined,
        source_row: f.source_row,
      });
    }
  }

  return { rows, sheets: sheets.map((s) => s.name), perSheet, skipped, tableOfSheet };
}

/** One document after the rate lines have been folded together. */
interface FoldedRow {
  table_type: Gstr1TableType;
  invoice_number: string;
  invoice_date: string;
  invoice_type: string;
  recipient_gstin: string;
  recipient_name: string;
  place_of_supply: string;
  hsn: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_value: number;
  rate: number | null;
  note_ref_number: string;
  note_ref_date: string;
  reverse_charge: boolean;
  source_row: number;
}

/**
 * Collapse the portal's rate lines into one row per document.
 *
 * Sums accumulate across rate lines; identifiers and the invoice value repeat
 * on each line and must therefore be taken once, not summed. Getting this
 * backwards is the classic way to make a GSTR-1 import report a huge phantom
 * difference on a file that is actually correct.
 */
function foldRows(raw: RawRow[]): FoldedRow[] {
  const order: string[] = [];
  const byKey = new Map<string, FoldedRow>();

  for (const r of raw) {
    // B2CS rows have no document identity, so the rate is the identity.
    const key =
      r.table === 'B2CS'
        ? `${r.table}|${(r.rate ?? 0).toFixed(3)}`
        : `${r.table}|${normInvoice(r.invoice_number)}|${r.invoice_date}|${normGstin(r.recipient_gstin)}`;

    const existing = byKey.get(key);
    if (!existing) {
      const folded: FoldedRow = {
        table_type: r.table,
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        invoice_type: r.invoice_type,
        recipient_gstin: r.recipient_gstin,
        recipient_name: r.recipient_name,
        place_of_supply: r.place_of_supply,
        hsn: r.hsn,
        taxable_value: r.taxable_value,
        igst: r.igst,
        cgst: r.cgst,
        sgst: r.sgst,
        cess: r.cess,
        // The invoice value repeats on every rate line of one document.
        invoice_value: r.invoice_value,
        rate: r.rate,
        note_ref_number: r.note_ref_number,
        note_ref_date: r.note_ref_date,
        reverse_charge: r.reverse_charge,
        source_row: r.source_row,
      };
      byKey.set(key, folded);
      order.push(key);
      continue;
    }

    existing.taxable_value = r2(existing.taxable_value + r.taxable_value);
    existing.igst = r2(existing.igst + r.igst);
    existing.cgst = r2(existing.cgst + r.cgst);
    existing.sgst = r2(existing.sgst + r.sgst);
    existing.cess = r2(existing.cess + r.cess);
    // Keep the first non-zero invoice value. A later rate line carrying 0 (or a
    // repeat of the same figure) must not overwrite or double it.
    if (!existing.invoice_value && r.invoice_value) existing.invoice_value = r.invoice_value;
    if (!existing.place_of_supply && r.place_of_supply) existing.place_of_supply = r.place_of_supply;
    if (!existing.recipient_gstin && r.recipient_gstin) existing.recipient_gstin = r.recipient_gstin;
    if (!existing.recipient_name && r.recipient_name) existing.recipient_name = r.recipient_name;
  }

  return order.map((k) => byKey.get(k)!).filter(Boolean);
}

/** Totals of a parsed export, for the preview screen before anything is stored. */
export function summariseParsed(rows: FiledRow[]): {
  count: number;
  taxable: number;
  tax: number;
  byTable: Record<string, { count: number; taxable: number; tax: number }>;
} {
  const byTable: Record<string, { count: number; taxable: number; tax: number }> = {};
  let taxable = 0;
  let tax = 0;
  for (const r of rows) {
    const t = r2(r.taxable_value);
    const x = r2(taxOf({ igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess }));
    taxable = r2(taxable + t);
    tax = r2(tax + x);
    const table = parseTableType(r.table_type) ?? 'B2B';
    const bucket = (byTable[table] ??= { count: 0, taxable: 0, tax: 0 });
    bucket.count += 1;
    bucket.taxable = r2(bucket.taxable + t);
    bucket.tax = r2(bucket.tax + x);
  }
  return { count: rows.length, taxable, tax, byTable };
}

/** Period shown for a parsed export, resolved from the file or the fallback. */
export function resolvePeriod(rows: FiledRow[], fallback: string): string {
  for (const r of rows) {
    const p = periodFromAny(r.invoice_date);
    if (p) return p;
  }
  return fallback;
}

/** Financial year for a period, re-exported so callers need one import. */
export { fyOf, normPos };