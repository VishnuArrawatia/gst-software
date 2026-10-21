/**
 * P&L versus GSTR-1 — storage.
 *
 * Everything the comparison needs is loaded here and handed to the pure engine
 * in `engine/pl-recon.ts`, which knows nothing about the database. That split
 * is what makes the comparison testable and keeps one place responsible for the
 * arithmetic.
 *
 * Two rules are enforced by the database rather than here, because they must
 * hold even if some future caller forgets:
 *   - pl_entries refuses UPDATE and DELETE (append-only source data);
 *   - a non-zero difference cannot be stored without a reason.
 */

import { withClient } from './store';
import { readAllSheets } from './sheets';
import { fyOf, r2 } from '../engine/core';
import { normaliseHeader } from '../engine/columns';
import {
  reconcilePlVsGstr1,
  type Gstr1DocLite,
  type PlHeadDef,
  type PlReconResult,
} from '../engine/pl-recon';

/** ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Header spellings the P&L file is allowed to use, per field. */
const PL_ALIASES: Record<string, string[]> = {
  head_name: ['pl head', 'p&l head', 'head', 'head name', 'particulars', 'p&l line', 'line item', 'account name', 'description'],
  period: ['period', 'month', '2b month', 'return period', 'tax period'],
  amount: ['amount', 'taxable value', 'taxable amount', 'value', 'turnover', 'figure', 'amt', 'amount (rs)', 'amount(rs)'],
  remark: ['remark', 'remarks', 'note', 'notes'],
};

const PL_LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [field, aliases] of Object.entries(PL_ALIASES)) {
    for (const a of aliases) {
      const k = normaliseHeader(a);
      if (!m.has(k)) m.set(k, field);
    }
  }
  return m;
})();

export interface PlLine {
  headName: string;
  period: string;
  amount: number;
  rawAmount: string;
  remark?: string;
  /** 1-based row in the uploaded file, so the immutable key can tell two lines apart. */
  sourceRow: number;
}

export interface PlParseResult {
  rows: PlLine[];
  skipped: Array<{ row: number; reason: string }>;
  unmappedHeaders: string[];
  headerRowIndex: number;
}

/** '1,00,000.00' -> 100000, '(1,234)' -> -1234, '18,000' -> 18000 */
function plNumber(v: unknown): number {
  let s = String(v ?? '').trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.]/g, '');
  const n = Number(s || 0);
  return neg ? -n : n;
}

/** Accepts a Date, or YYYY-MM, MM-YYYY, YYYYMM and 'Apr-25' as text. */
export function plPeriod(v: unknown): string {
  // The workbook reader is configured with `cellDates: true`, so a CSV cell
  // reading "2026-03" arrives as a Date, not as text. Without this branch every
  // period in a CSV upload is reported as missing while the very same file
  // uploaded as .xlsx works — the kind of difference that reads as a data
  // problem when it is really a reader one.
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = /^(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^([a-z]{3,})[-\s](\d{2,4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const y = m[2].length === 2 ? `20${m[2]}` : m[2];
      return `${y}-${String(mi + 1).padStart(2, '0')}`;
    }
  }
  return '';
}

const looksLikeTotal = (row: unknown[]): boolean =>
  row.some((c) => /^(total|grand\s*total|sub\s*total|net total)/i.test(String(c ?? '').trim()));

/**
 * Pick the sheet that actually holds the P&L.
 *
 * The generic picker scores on purchase headers, which a P&L file does not
 * have, so it would happily return an Instructions sheet. This scores on the
 * P&L's own vocabulary instead.
 */
export function readPlFile(buf: Buffer, name: string): { rows: unknown[][]; sheetName: string } {
  const sheets = readAllSheets(buf);
  if (!sheets.length) throw new Error(`${name}: file me koi sheet nahi mili.`);
  let best = sheets[0];
  let bestScore = -1;
  for (const s of sheets) {
    let score = 0;
    for (let i = 0; i < Math.min(s.rows.length, 15); i++) {
      const fields = new Set<string>();
      for (const c of s.rows[i] || []) {
        const f = PL_LOOKUP.get(normaliseHeader(c));
        if (f) fields.add(f);
      }
      const rowScore = (fields.has('head_name') ? 10 : 0) + (fields.has('amount') ? 5 : 0) + fields.size;
      if (rowScore > score) score = rowScore;
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { rows: best.rows, sheetName: best.name };
}

/**
 * Parse an uploaded P&L.
 *
 * A totals row is skipped rather than becoming a head: it would otherwise add
 * the whole turnover a second time and every comparison would show a fake
 * difference.
 */
export function parsePlUpload(rows: unknown[][], sourceFile = 'pl-upload'): PlParseResult {
  const unmapped: string[] = [];

  // Find the header row: the first row that recognises at least a head and an
  // amount, within the usual 15-row banner allowance.
  let headerRowIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] || [];
    const fields = new Set<string>();
    for (const cell of row) {
      const f = PL_LOOKUP.get(normaliseHeader(cell));
      if (f) fields.add(f);
    }
    const score = (fields.has('head_name') ? 2 : 0) + (fields.has('amount') ? 1 : 0) + fields.size;
    if (score > bestScore) { bestScore = score; headerRowIndex = i; }
  }

  const header = rows[headerRowIndex] || [];
  const map = new Map<number, string>();
  header.forEach((cell, idx) => {
    const f = PL_LOOKUP.get(normaliseHeader(cell));
    if (!f) { const t = String(cell ?? '').trim(); if (t) unmapped.push(t); return; }
    if (!map.has(idx)) map.set(idx, f);
  });
  // A duplicate column for the same field must not silently win over the first.
  const seen = new Set<string>();
  for (const idx of [...map.keys()].sort((a, b) => a - b)) {
    const f = map.get(idx)!;
    if (seen.has(f)) { map.delete(idx); unmapped.push(`${String(header[idx]).trim()} (duplicate)`); }
    else seen.add(f);
  }

  if (!seen.has('head_name') || !seen.has('amount')) {
    return {
      rows: [], headerRowIndex, unmappedHeaders: unmapped,
      skipped: [{ row: headerRowIndex + 1, reason: 'header row me "P&L Head" aur "Amount" chahiye' }],
    };
  }

  const pick = (row: unknown[], field: string): unknown => {
    for (const [idx, f] of map) if (f === field) return row[idx];
    return undefined;
  };

  const out: PlLine[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    if (looksLikeTotal(row)) continue;

    const headName = String(pick(row, 'head_name') ?? '').trim();
    if (!headName) continue;
    const amountRaw = String(pick(row, 'amount') ?? '').trim();
    if (!amountRaw) { skipped.push({ row: i + 1, reason: `amount missing on "${headName}"` }); continue; }
    const amount = plNumber(amountRaw);
    if (!Number.isFinite(amount)) { skipped.push({ row: i + 1, reason: `amount "${amountRaw}" parha nahi ja saka` }); continue; }

    const period = plPeriod(pick(row, 'period'));
    if (!period) { skipped.push({ row: i + 1, reason: `period missing or unclear on "${headName}"` }); continue; }

    out.push({
      headName,
      period,
      amount: r2(amount),
      rawAmount: amountRaw,
      remark: String(pick(row, 'remark') ?? '').trim() || undefined,
      sourceRow: i + 1,
    });
  }

  return { rows: out, skipped, unmappedHeaders: unmapped, headerRowIndex };
}

/** ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export async function loadPlHeads(companyId: number): Promise<PlHeadDef[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT h.id, h.name, h.group_name, h.sequence, h.head_kind, h.is_mandatory,
              coalesce(m.gst_applicable, true) AS gst_applicable,
              coalesce(m.taxable_type, 'Taxable') AS taxable_type,
              m.return_mapping, m.gstr1_table,
              coalesce(m.include_in_gstr1, true) AS include_in_gstr1
         FROM pl_heads h
         LEFT JOIN pl_gst_mapping m ON m.pl_head_id = h.id AND m.status = 1
        WHERE h.company_id = $1 AND h.status = 1
        ORDER BY h.sequence, h.name`,
      [companyId],
    );
    return r.rows.map((x) => ({
      id: x.id, name: x.name, group_name: x.group_name, sequence: x.sequence,
      head_kind: x.head_kind, is_mandatory: x.is_mandatory === 1,
      gst_applicable: x.gst_applicable === true, taxable_type: x.taxable_type,
      return_mapping: x.return_mapping, gstr1_table: x.gstr1_table,
      include_in_gstr1: x.include_in_gstr1 === true,
    })) as PlHeadDef[];
  });
}

/**
 * The GSTR-1 DRAFT documents for every GSTIN of a company.
 *
 * One period is read at a time because the draft is rebuilt per month; reading
 * across months would let an invoice booked in April appear in the May
 * reconciliation, which is the timing error this module exists to catch.
 */
export async function loadGstr1DraftDocs(companyId: number, period: string): Promise<Gstr1DocLite[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT g.gstin_number AS gstin, d.table_type, d.taxable_value, d.rate,
              d.igst, d.cgst, d.sgst, d.cess
         FROM gstr1_documents d
         JOIN gstins g ON g.id = d.gstin_id
        WHERE g.company_id = $1 AND d.source = 'draft' AND d.period = $2
        ORDER BY d.id`,
      [companyId, period],
    );
    return r.rows.map((x) => ({
      gstin: x.gstin, table_type: x.table_type,
      taxable_value: Number(x.taxable_value || 0),
      rate: x.rate === null ? null : Number(x.rate),
      igst: Number(x.igst || 0), cgst: Number(x.cgst || 0),
      sgst: Number(x.sgst || 0), cess: Number(x.cess || 0),
    })) as Gstr1DocLite[];
  });
}

export async function loadPlAmounts(companyId: number, period: string): Promise<Array<{ head_id: number; amount: number; amendment_no: number }>> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT pl_head_id, sum(amount)::numeric AS amount, max(amendment_no)::int AS amendment_no
         FROM pl_entries
        WHERE company_id = $1 AND period = $2
        GROUP BY pl_head_id`,
      [companyId, period],
    );
    return r.rows.map((x) => ({ head_id: x.pl_head_id, amount: Number(x.amount), amendment_no: x.amendment_no }));
  });
}

/** ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export interface PlImportResult {
  ok: boolean;
  reason?: string;
  inserted: number;
  lines: number;
  periods: string[];
  unmappedHeads: string[];
  skipped: Array<{ row: number; reason: string }>;
}

/**
 * Append a parsed P&L.
 *
 * `ON CONFLICT DO NOTHING`, never DO UPDATE: the entries table is immutable
 * and a corrected P&L is imported as a new amendment. Re-uploading the same
 * file therefore collides instead of double counting.
 */
export async function importPl(
  companyId: number,
  parsed: PlParseResult,
  sourceFile: string,
  opts: { by?: string; amendmentNo?: number } = {},
): Promise<PlImportResult> {
  const out: PlImportResult = {
    ok: false, inserted: 0, lines: 0, periods: [],
    unmappedHeads: [], skipped: parsed.skipped,
  };
  if (!parsed.rows.length) {
    out.reason = parsed.skipped[0]?.reason || 'koi row samajh nahi aayi';
    return out;
  }

  const heads = await loadPlHeads(companyId);
  const byName = new Map<string, PlHeadDef>();
  for (const h of heads) byName.set(h.name.trim().toLowerCase(), h);

  const unmapped = new Set<string>();
  const resolvable = parsed.rows.filter((l) => {
    const h = byName.get(l.headName.trim().toLowerCase());
    if (!h) { unmapped.add(l.headName); return false; }
    return true;
  });
  out.unmappedHeads = [...unmapped];
  if (!resolvable.length) {
    out.reason = `koi bhi P&L head match nahi hui. Master list: ${heads.map((h) => h.name).join(', ')}`;
    return out;
  }

  const amendment = opts.amendmentNo ?? 0;
  const periods = [...new Set(resolvable.map((l) => l.period))].sort();

  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const l of resolvable) {
        const head = byName.get(l.headName.trim().toLowerCase())!;
        const r = await c.query(
          `INSERT INTO pl_entries
             (company_id, pl_head_id, period, financial_year, amount, source_file, source_row, amendment_no, raw_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (company_id, pl_head_id, period, source_file, source_row, amendment_no)
           DO NOTHING`,
          [companyId, head.id, l.period, fyOf(l.period), l.amount, sourceFile, l.sourceRow, amendment, l.amount],
        );
        out.inserted += r.rowCount || 0;
      }
      for (const p of periods) {
        await c.query(
          `INSERT INTO pl_month_status (company_id, financial_year, period, pl_uploaded, pl_uploaded_at, pl_source_file, pl_entry_count)
           VALUES ($1,$2,$3,true, now(), $4, 1)
           ON CONFLICT (company_id, period) DO UPDATE SET
             pl_uploaded = true, pl_uploaded_at = now(),
             pl_source_file = EXCLUDED.pl_source_file,
             pl_entry_count = (SELECT count(*)::int FROM pl_entries e
                                WHERE e.company_id = $1 AND e.period = $3),
             updated_at = now()`,
          [companyId, fyOf(p), p, sourceFile],
        );
      }
      await c.query('COMMIT');
    } catch (e: any) {
      await c.query('ROLLBACK');
      out.reason = e.message;
      throw e;
    }
  });

  out.ok = true;
  out.lines = resolvable.length;
  out.periods = periods;
  return out;
}

/** ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

export interface PlReconRunResult {
  ok: boolean;
  reason?: string;
  companyId: number;
  period: string;
  result: PlReconResult;
  persisted: number;
}

/**
 * Compare the P&L with the GSTR-1 draft and write the result.
 *
 * The stored outcome is replaced wholesale rather than merged, because the
 * source of truth is the engine and a hand-edited result would disagree with
 * the data on the next run. Explanations live in the reason column, which the
 * database refuses to let be empty when there is a difference.
 */
export async function runPlRecon(
  companyId: number,
  period: string,
  opts: { by?: string; amendmentNo?: number } = {},
): Promise<PlReconRunResult> {
  const out: PlReconRunResult = {
    ok: false, companyId, period,
    result: { rows: [], totalPl: 0, totalGstr1Taxable: 0, totalDifference: 0, outsideGstAmount: 0, gstinCount: 0, matchedHeads: 0, pendingHeads: 0, unmappedHeads: 0 },
    persisted: 0,
  };

  const heads = await loadPlHeads(companyId);
  if (!heads.length) { out.reason = 'is company ke liye koi P&L head nahi hai'; return out; }

  const [amounts, docs] = await Promise.all([
    loadPlAmounts(companyId, period),
    loadGstr1DraftDocs(companyId, period),
  ]);

  const result = reconcilePlVsGstr1(heads, amounts, docs);
  out.result = result;

  if (!docs.length) {
    out.reason = 'is mahine ka GSTR-1 draft nahi bana hai — pehle "GSTR-1 Reconciliation" par draft banaiye';
    return out;
  }

  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const row of result.rows) {
        // A difference with no reason yet stays Pending Review, which the CHECK
        // constraint allows because its difference is explained later.
        const status = row.status === 'Reconciled' ? 'Reconciled' : row.status === 'Not Mapped' ? 'Not Mapped' : 'Pending Review';
        await c.query(
          `INSERT INTO pl_reconciliation
             (company_id, financial_year, period, pl_head_id, gstr1_table, amendment_no,
              pl_amount, gstr1_amount, difference, gstin_breakdown, gstin_count,
              difference_reason, remarks, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
           ON CONFLICT (company_id, period, pl_head_id, amendment_no) DO UPDATE SET
             gstr1_table = EXCLUDED.gstr1_table,
             pl_amount = EXCLUDED.pl_amount,
             gstr1_amount = EXCLUDED.gstr1_amount,
             difference = EXCLUDED.difference,
             gstin_breakdown = EXCLUDED.gstin_breakdown,
             gstin_count = EXCLUDED.gstin_count,
             status = EXCLUDED.status,
             updated_at = now()
           -- An explanation a person gave is never thrown away by a re-run;
           -- the numbers move underneath it and the reason is still theirs.
           WHERE pl_reconciliation.status <> 'Difference Explained'`,
          [
            companyId, fyOf(period), period, row.head_id, row.gstr1_table,
            opts.amendmentNo ?? 0,
            row.pl_amount, row.gstr1_taxable, row.difference,
            JSON.stringify(row.gstin_breakdown), row.gstin_count,
            null, null, status,
          ],
        );
        out.persisted += 1;
      }
      const gstinCount = result.gstinCount;
      await c.query(
        `INSERT INTO pl_month_status (company_id, financial_year, period, gstr1_covered, gstr1_draft_count, recon_run_at, recon_run_by, total_difference, updated_at)
         VALUES ($1,$2,$3,true,$4, now(), $5, $6, now())
         ON CONFLICT (company_id, period) DO UPDATE SET
           gstr1_covered = true, gstr1_draft_count = EXCLUDED.gstr1_draft_count,
           recon_run_at = now(), recon_run_by = EXCLUDED.recon_run_by,
           total_difference = EXCLUDED.total_difference, updated_at = now()`,
        [companyId, fyOf(period), period, docs.length, opts.by || 'system', result.totalDifference],
      );
      await c.query('COMMIT');
    } catch (e: any) {
      await c.query('ROLLBACK');
      out.reason = e.message;
      throw e;
    }
  });

  out.ok = true;
  return out;
}

/**
 * Record why a difference exists.
 *
 * The database CHECK is the real guard: it rejects any difference left without
 * a reason, so this function cannot quietly write an unexplained one.
 */
export async function setPlDifferenceReason(
  reconId: number,
  reasonCode: string | null,
  remarks?: string,
  opts: { by?: string } = {},
): Promise<{ ok: boolean; reason?: string }> {
  return withClient(async (c) => {
    const cur = await c.query(
      `SELECT r.difference, r.company_id, r.period, r.financial_year, r.pl_head_id, r.amendment_no
         FROM pl_reconciliation r WHERE r.id = $1`,
      [reconId],
    );
    if (!cur.rowCount) return { ok: false, reason: 'row nahi mili' };
    const row = cur.rows[0];
    const difference = Number(row.difference);
    if (Number(difference) !== 0 && !reasonCode) {
      return { ok: false, reason: 'difference ko explain karne ke liye ek reason chahiye' };
    }
    if (reasonCode) {
      const valid = await c.query('SELECT 1 FROM recon_difference_reasons WHERE code = $1', [reasonCode]);
      if (!valid.rowCount) return { ok: false, reason: `"${reasonCode}" ek valid reason nahi hai` };
    }
    const status = Number(difference) === 0 ? 'Reconciled' : 'Difference Explained';
    const r = await c.query(
      `UPDATE pl_reconciliation
          SET difference_reason = $2, remarks = $3, status = $4,
              reconciled_by = $5, reconciled_at = now(), updated_at = now()
        WHERE id = $1`,
      [reconId, reasonCode || null, remarks || null, status, opts.by || null],
    );
    if (Number(difference) !== 0) {
      await c.query(
        `UPDATE pl_month_status SET total_difference = (
            SELECT coalesce(sum(difference),0) FROM pl_reconciliation
             WHERE company_id = $1 AND period = $2 AND status <> 'Reconciled'
         ), updated_at = now()
          WHERE company_id = $1 AND period = $2`,
        [row.company_id, row.period],
      );
    }
    return { ok: true, reason: r.rowCount ? undefined : 'row update nahi hui' };
  });
}

/** Everything the screen shows, from the one view so it cannot disagree with itself. */
export async function loadPlRecon(companyId: number, period: string): Promise<{
  rows: Array<Record<string, unknown>>;
  summary: { pl: number; gstr1: number; difference: number; unexplained: number; matched: number; pending: number; unmapped: number };
  reasons: Array<{ code: string; label: string; category: string; requires_note: boolean }>;
}> {
  const { rows, reasons } = await withClient(async (c) => {
    const [v, r] = await Promise.all([
      c.query(
        `SELECT * FROM v_pl_vs_books
          WHERE company_id = $1 AND period = $2
          ORDER BY sequence, pl_head`,
        [companyId, period],
      ),
      c.query('SELECT code, label, category, requires_note FROM recon_difference_reasons ORDER BY sequence, code'),
    ]);
    return { rows: v.rows, reasons: r.rows };
  });

  // The view carries no GSTIN slices for the money summary, so the headline is
  // recomputed from the same rows rather than stored twice.
  const mapped = rows.filter((r) => r.status !== 'Not Mapped');
  let pl = 0, gstr1 = 0;
  for (const r of mapped) { pl = r2(pl + Number(r.pl_amount || 0)); gstr1 = r2(gstr1 + Number(r.gstr1_amount || 0)); }
  let outside = 0;
  for (const r of rows) if (r.status === 'Not Mapped') outside = r2(outside + Number(r.pl_amount || 0));
  // Explaining a difference does not make the money go away, so the total and
  // the still-unexplained part are reported separately. Showing one figure for
  // both would let a fully explained month still look like money is missing.
  let unexplained = 0;
  for (const r of rows) if (r.status === 'Pending Review') unexplained = r2(unexplained + Number(r.difference || 0));

  return {
    rows,
    summary: {
      pl, gstr1,
      difference: r2(pl - gstr1),
      unexplained,
      matched: rows.filter((r) => r.status === 'Reconciled').length,
      pending: rows.filter((r) => r.status === 'Pending Review').length,
      unmapped: rows.filter((r) => r.status === 'Not Mapped').length,
    },
    reasons,
  };
}