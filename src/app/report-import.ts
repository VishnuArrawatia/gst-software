/**
 * GST ERP — reading a worked-on report back in.
 *
 * The intended loop is: export "Missing in 2B" to Excel, chase the vendors in
 * it, fill in `Vendor Response`, `Follow-up Date`, `Expected Correction` and
 * `Action Taken`, upload the file back. This module is the other half of that
 * loop.
 *
 * WHAT MAY BE WRITTEN
 *   recon_supplier_gstin, recon_invoice_no, recon_invoice_date
 *   itc_decision, itc_decision_month, decision_reason, return_classification
 *   remarks, vendor_response, follow_up_date, expected_correction, action_taken
 *
 * WHAT IS IGNORED, DELIBERATELY
 *   every `book_*` column and every amount. A file that arrives from a laptop
 *   with "Taxable Value" changed in it must not be able to alter what the books
 *   said — the database trigger enforces that too, but silently dropping those
 *   columns here is clearer than throwing at them. The columns are listed in the
 *   preview as "read-only, ignored" so nobody wonders where their edit went.
 *
 * Rows are matched by `Line ID`, which every exported report carries. If a row
 * has no Line ID it is rejected rather than guessed at, because guessing which
 * invoice someone meant is how an audit trail gets quietly wrong.
 */

import XLSX from 'xlsx';

import { pickDataSheet, readAllSheets, type HeaderDetector } from './sheets';
import {
  ITC_DECISIONS,
  RETURN_CLASSIFICATIONS,
  withClient,
  type FollowUpField,
  type LineEdit,
  type ReconField,
} from './store';
import { isValidGstin, labelOf, normDate, normGstin, r2 } from '../engine/core';

/** Header text (lower-cased, punctuation stripped) -> the field it may write. */
const WRITABLE: Record<string, string> = {
  // `key()` keeps the space, so "Line ID" arrives as "line id".
  'line id': 'id',
  lineid: 'id',
  'recon supplier gstin': 'recon_supplier_gstin',
  'recon gstin': 'recon_supplier_gstin',
  'reconciliation gstin': 'recon_supplier_gstin',
  'recon invoice no': 'recon_invoice_no',
  'recon invoice number': 'recon_invoice_no',
  'reconciliation invoice no': 'recon_invoice_no',
  'recon invoice date': 'recon_invoice_date',
  'reconciliation invoice date': 'recon_invoice_date',
  'itc decision': 'itc_decision',
  'itc decision month': 'itc_decision_month',
  'decision month': 'itc_decision_month',
  'itc reason': 'decision_reason',
  'decision reason': 'decision_reason',
  'return classification': 'return_classification',
  remarks: 'remarks',
  'vendor response': 'vendor_response',
  'follow up date': 'follow_up_date',
  'followup date': 'follow_up_date',
  'expected correction': 'expected_correction',
  'action taken': 'action_taken',
};

/** Columns we read but must never write — listed so the preview can say so. */
const READ_ONLY_HINTS = [
  'book ', 'taxable', 'igst', 'cgst', 'sgst', 'utgst', 'cess', 'itc', 'amount',
  'gstin', 'period', 'month', 'status', 'reason', 'line id',
];

/**
 * Reduce a header to a lookup key.
 *
 * Hyphens become spaces so "Follow-up Date" and "Follow Up Date" are the same
 * header — and, just as importantly, so that neither of them silently fails to
 * match and gets treated as a read-only column.
 */
const key = (h: unknown) =>
  String(h ?? '').toLowerCase().replace(/[₹_.()\[\]/\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The field a header would write, or null when it is read-only.
 *
 * Exported for one reason: the working-sheet template ships columns the Accounts
 * team is told they may fill in, and a template that offers a column this map
 * does not know would quietly lose their answers on upload. A test asserts every
 * fillable column of that template resolves here.
 */
export function writableField(header: unknown): string | null {
  return WRITABLE[key(header)] ?? null;
}

export interface ImportColumn {
  header: string;
  /** The field it writes, or null when it is read-only. */
  field: string | null;
  writable: boolean;
}

export interface ImportRowPlan {
  row: number;
  lineId: number | null;
  ok: boolean;
  /** What would change, field by field. Shown before anything is written. */
  changes: Array<{ field: string; from: string; to: string }>;
  errors: string[];
  warnings: string[];
  /** The row sits in a locked month, so it cannot be written at all. */
  locked?: boolean;
  current?: { gstin: string; period: string; invoice: string; status: string; decision: string };
}

export interface ImportPlan {
  headerRow: number;
  columns: ImportColumn[];
  rows: ImportRowPlan[];
  totals: {
    records: number;
    matched: number;
    valid: number;
    invalid: number;
    unchanged: number;
    changes: number;
    locked: number;
  };
  /** Fields found in the file that we cannot write. */
  ignored: string[];
  /** The only field a row can be matched on. */
  keyColumn: string | null;
  error?: string;
}

/** Recognises the one column a re-upload can be keyed on. */
const LINE_ID: HeaderDetector = (cell) => (writableField(cell) === 'id' ? 'id' : null);

/**
 * Read a workbook or CSV into rows of raw cells.
 *
 * WHICH SHEET: the one carrying a `Line ID`.
 *
 * Reading `SheetNames[0]` was wrong for every multi-sheet file this system
 * itself produces: a report export is a `Report` cover in front of the `Data`
 * sheet, and the reconciliation working sheet carries `Instructions` and the
 * invoice-wise view in front of the line-wise rows. The upload answered "No Line
 * ID column found" for a workbook that plainly had one, so the documented loop
 * (export → fill in → upload back) only ever worked as CSV. The scoring in
 * `sheets.ts` is reused rather than re-derived; when no sheet carries a Line ID
 * the first one is returned, so the error still names a sheet that is really
 * there.
 */
export function readTable(buf: Buffer, fileName: string): unknown[][] {
  const sheets = readAllSheets(buf);
  if (!sheets.length) return [];
  return pickDataSheet(sheets, ['id'], undefined, LINE_ID).rows;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
  return String(v).trim();
}

/**
 * Decide what an uploaded file is asking for, and whether it can be trusted.
 *
 * Nothing is written here. The caller shows this to the Accounts team, they
 * confirm, and only then does `applyImport` touch the database.
 */
export async function planImport(buf: Buffer, fileName: string): Promise<ImportPlan> {
  const plan: ImportPlan = {
    headerRow: 0, columns: [], rows: [],
    totals: { records: 0, matched: 0, valid: 0, invalid: 0, unchanged: 0, changes: 0, locked: 0 },
    ignored: [], keyColumn: null,
  };

  let table: unknown[][];
  try {
    table = readTable(buf, fileName);
  } catch (e: any) {
    plan.error = `Could not read the file: ${e.message}`;
    return plan;
  }
  if (table.length < 2) {
    plan.error = 'The file has no data rows.';
    return plan;
  }

  // The header may not be row 1 — an export has a cover sheet, and people paste
  // things with a title above. Take the first row that carries a Line ID or a
  // recognisable reconciliation column.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(table.length, 8); i++) {
    const keys = (table[i] ?? []).map(key);
    if (keys.some((k) => WRITABLE[k]) && keys.some((k) => /invoice|line id|gstin/.test(k))) {
      headerIdx = i;
      break;
    }
  }
  plan.headerRow = headerIdx + 1;
  const header = (table[headerIdx] ?? []).map(cell);

  const colIndex = new Map<number, string>();
  for (let c = 0; c < header.length; c++) {
    const k = key(header[c]);
    if (!k) continue;
    const field = WRITABLE[k] ?? null;
    plan.columns.push({ header: header[c], field, writable: !!field && field !== 'id' });
    if (field) colIndex.set(c, field);
    else if (READ_ONLY_HINTS.some((h) => k.includes(h)) && !plan.ignored.includes(header[c])) {
      plan.ignored.push(header[c]);
    }
  }

  const idCol = [...colIndex.entries()].find(([, f]) => f === 'id')?.[0];
  plan.keyColumn = idCol === undefined ? null : header[idCol];
  if (idCol === undefined) {
    plan.error =
      'No "Line ID" column found. Re-download the report from this system — every exported report carries it, ' +
      'and it is the only safe way to know which invoice a row means.';
    return plan;
  }

  // Writable columns other than the key. If there are none, there is nothing to
  // upload and we say so rather than reporting "0 changes".
  const writableFields = [...new Set([...colIndex.values()].filter((f) => f !== 'id'))];
  if (!writableFields.length) {
    plan.error =
      'This file has a Line ID but none of the columns we can write. Fill in at least one of: ' +
      'Recon Invoice No, Recon Invoice Date, Recon Supplier GSTIN, ITC Decision, ITC Decision Month, ' +
      'ITC Reason, Return Classification, Remarks, Vendor Response, Follow-up Date, ' +
      'Expected Correction, Action Taken.';
    return plan;
  }

  const dataRows = table.slice(headerIdx + 1).filter((r) => r.some((c) => cell(c) !== ''));
  plan.totals.records = dataRows.length;

  const ids = dataRows.map((r) => Number(cell(r[idCol])));
  const wanted = ids.filter((n) => Number.isFinite(n) && n > 0);
  const existing = new Map<number, any>();
  if (wanted.length) {
    const q = await withClient((c) =>
      c.query(
        `SELECT id, our_gstin, period, book_invoice_no, recon_invoice_no, recon_supplier_gstin,
                recon_invoice_date, match_status, itc_decision, itc_decision_month, return_classification,
                decision_reason, remarks, vendor_response, follow_up_date, expected_correction, action_taken,
                EXISTS (SELECT 1 FROM month_locks m
                         WHERE m.our_gstin = purchase_lines.our_gstin
                           AND m.period = purchase_lines.period AND m.is_locked) AS is_locked
           FROM purchase_lines
          WHERE id = ANY($1::bigint[])`,
        [wanted],
      ),
    );
    for (const r of q.rows) existing.set(Number(r.id), r);
  }

  const seen = new Set<number>();

  dataRows.forEach((raw, i) => {
    const rowNo = headerIdx + 2 + i;
    const rp: ImportRowPlan = { row: rowNo, lineId: null, ok: true, changes: [], errors: [], warnings: [] };

    const id = Number(cell(raw[idCol]));
    if (!Number.isFinite(id) || id <= 0) {
      rp.ok = false;
      rp.errors.push('Line ID missing or not a number.');
      plan.rows.push(rp);
      plan.totals.invalid++;
      return;
    }
    rp.lineId = id;

    const cur = existing.get(id);
    if (!cur) {
      rp.ok = false;
      rp.errors.push(`Line ID ${id} is not in this system (it may have been re-imported). Download a fresh report.`);
      plan.rows.push(rp);
      plan.totals.invalid++;
      return;
    }
    if (seen.has(id)) {
      rp.ok = false;
      rp.errors.push(`Line ID ${id} appears twice in the file.`);
    }
    seen.add(id);
    plan.totals.matched++;

    rp.current = {
      gstin: cur.our_gstin,
      period: labelOf(cur.period),
      invoice: cur.recon_invoice_no,
      status: cur.match_status,
      decision: cur.itc_decision,
    };
    if (cur.is_locked) {
      rp.ok = false;
      rp.locked = true;
      rp.errors.push(`${labelOf(cur.period)} is LOCKED — this row cannot be changed.`);
      plan.totals.locked++;
    }

    for (const [c, field] of colIndex) {
      if (field === 'id') continue;
      const raw2 = cell(raw[c]);
      const next = validateField(field, raw2, rp);
      if (next === null) continue;

      const prev = currentText(cur, field);
      if (next === prev) continue;
      rp.changes.push({ field, from: prev, to: next });
    }

    if (rp.changes.length) plan.totals.changes++;
    else plan.totals.unchanged++;
    if (rp.ok) plan.totals.valid++;
    else if (!rp.errors.length || rp.locked) plan.totals.invalid++;
    plan.rows.push(rp);
  });

  return plan;
}

/** Normalise one cell for the field it claims to fill, or explain why it cannot. */
function validateField(field: string, value: string, rp: ImportRowPlan): string | null {
  if (value === '') return null; // blank = "no opinion", leave the current value

  switch (field) {
    case 'recon_supplier_gstin': {
      const g = normGstin(value);
      if (!isValidGstin(g)) {
        rp.errors.push(`"${value}" is not a valid GSTIN.`);
        return null;
      }
      return g;
    }
    case 'recon_invoice_no':
      return value;
    case 'recon_invoice_date': {
      const d = normDate(value);
      if (!d) {
        rp.errors.push(`Could not read the date "${value}".`);
        return null;
      }
      return d;
    }
    case 'itc_decision': {
      if (!ITC_DECISIONS.includes(value as any)) {
        rp.errors.push(`"${value}" is not an ITC decision. Allowed: ${ITC_DECISIONS.join(', ')}.`);
        return null;
      }
      return value;
    }
    case 'itc_decision_month': {
      if (!/^\d{4}-\d{2}$/.test(value)) {
        const d = normDate(value);
        if (!d) {
          rp.errors.push(`"${value}" is not a month. Use YYYY-MM, for example 2026-04.`);
          return null;
        }
        return d.slice(0, 7);
      }
      return value;
    }
    case 'return_classification': {
      if (!RETURN_CLASSIFICATIONS.includes(value as any)) {
        rp.errors.push(`"${value}" is not a return classification. Allowed: ${RETURN_CLASSIFICATIONS.join(', ')}.`);
        return null;
      }
      return value;
    }
    case 'follow_up_date': {
      const d = normDate(value);
      if (!d) {
        rp.errors.push(`Could not read the follow-up date "${value}".`);
        return null;
      }
      return d;
    }
    default:
      return value;
  }
}

/**
 * The value as the report wrote it, so "has this changed?" compares like with
 * like.
 *
 * Note there is deliberately NO normalisation here. The export writes
 * `SCW/25-26/00049`; normalising both sides to `SCW252600049` would make every
 * unedited row look edited, and the re-upload would write history for changes
 * nobody made.
 */
function currentText(cur: any, field: string): string {
  const v = cur[field];
  if (v === null || v === undefined) return '';
  // pg returns DATE columns as Date objects in the local timezone, so
  // toISOString would shift them by a day and every re-upload would report a
  // spurious date change. Format from the local parts instead.
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (field.endsWith('_date') || field.endsWith('_at')) return String(v).slice(0, 10);
  return String(v).trim();
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
  applied: number;
  rows: Array<{ lineId: number; ok: boolean; changed: string[]; reason?: string }>;
  fields: string[];
}

/** Turn a confirmed plan into the edits that will be written. */
export function planToEdits(plan: ImportPlan): LineEdit[] {
  const edits: LineEdit[] = [];
  for (const r of plan.rows) {
    if (!r.ok || !r.lineId) continue;
    const e: LineEdit = { lineId: r.lineId };
    for (const c of r.changes) {
      switch (c.field) {
        case 'recon_supplier_gstin':
        case 'recon_invoice_no':
        case 'recon_invoice_date':
          (e.recon ??= {})[c.field as ReconField] = c.to;
          break;
        case 'itc_decision':
        case 'itc_decision_month':
        case 'decision_reason':
          (e.itc ??= {})[c.field === 'itc_decision' ? 'decision' : c.field === 'itc_decision_month' ? 'decisionMonth' : 'reason'] = c.to;
          break;
        case 'return_classification':
          e.classification = c.to;
          break;
        default:
          (e.followUp ??= {})[c.field as FollowUpField] = c.to;
      }
    }
    // More than just the id means there is at least one real change to make.
    if (Object.keys(e).length > 1) edits.push(e);
  }
  return edits;
}

/** The Invoice No, matched GSTIN and invoice total — the letters you post to a vendor. */
export function toCsv(rows: Array<Record<string, any>>, columns: Array<{ k: string; h: string }>): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map((c) => esc(c.h)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.k])).join(','))].join('\r\n');
}

export { r2 };