/**
 * GST Control ERP — Phase 3 Module:
 *   1. Monthly Book Summary (April–March) with Excel export & invoice drill-down.
 *   2. PAN-wise Supplier Consolidation with GSTIN-level breakdown & PAN conflict detection.
 *   3. SAP Business One Control Totals (Manual Entry + Excel Upload, versioned history,
 *      accidental-overwrite protection, duplicate-file protection, and 3-way comparison:
 *      SAP Control Totals vs Purchase Register vs GSTR-2B).
 *
 * Strictly preserves immutable book_* data, existing reconciliation outcomes, and ITC decisions.
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { fyOf, labelOf, normGstin, periodFromAny, r2 } from '../engine/core';
import { fyMonths } from '../engine/gstr9';
import { isLocked, withClient } from './store';
import { toWorkbookBuffer, type Column } from './reports';
import { polishWorkbook } from './xlsx-format';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * REM-2 Shared Company -> GSTIN Resolver.
 * Queries the actual live schema columns (`gstins.gstin_number`, `companies.short_name`,
 * `companies.name`, `companies.id`) so Phase 3 and Phase 5 never drift from PostgreSQL.
 */
export async function resolveCompanyGstins(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  companyKey: string,
): Promise<string[]> {
  const key = String(companyKey || '').trim();
  if (!key) return [];
  const res = await client.query(
    `SELECT DISTINCT UPPER(TRIM(g.gstin_number)) AS gstin_number
       FROM gstins g
       JOIN companies co ON co.id = g.company_id
      WHERE LOWER(COALESCE(co.short_name, '')) = LOWER($1)
         OR LOWER(co.name) = LOWER($1)
         OR co.id::text = $1`,
    [key],
  );
  return res.rows.map((r: any) => normGstin(r.gstin_number)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. MONTHLY BOOK SUMMARY (APRIL–MARCH)
// ---------------------------------------------------------------------------

export interface MonthlyBookRow {
  period: string;
  label: string;
  fy: string;
  invoiceCount: number;
  taxInvoiceCount: number;
  debitNoteCount: number;
  creditNoteCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  invoiceValue: number;
  invoiceValueCapturedCount: number;
  missingInvoiceValueCount: number;
}

export interface MonthlyBookSummaryResult {
  fy: string;
  gstin: string | null;
  company: string | null;
  months: MonthlyBookRow[];
  annualTotal: MonthlyBookRow;
  mathVerified: boolean;
}

function emptyMonthRow(period: string, fy: string): MonthlyBookRow {
  return {
    period,
    label: labelOf(period),
    fy,
    invoiceCount: 0,
    taxInvoiceCount: 0,
    debitNoteCount: 0,
    creditNoteCount: 0,
    taxableValue: 0,
    igst: 0,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    totalGst: 0,
    invoiceValue: 0,
    invoiceValueCapturedCount: 0,
    missingInvoiceValueCount: 0,
  };
}

export async function getMonthlyBookSummary(opts: {
  fy?: string | null;
  gstin?: string | null;
  company?: string | null;
  allowedGstins?: string[] | null;
}): Promise<MonthlyBookSummaryResult> {
  return withClient(async (c) => {
    let fy = String(opts.fy || '').trim();
    if (!fy) {
      const latest = await c.query(
        `SELECT period FROM purchase_lines ORDER BY period DESC LIMIT 1`,
      );
      fy = latest.rows[0]?.period ? fyOf(String(latest.rows[0].period)) : fyOf(new Date().toISOString().slice(0, 7));
    }
    const monthsList = fyMonths(fy).months;
    const startP = monthsList[0];
    const endP = monthsList[monthsList.length - 1];

    const params: unknown[] = [startP, endP];
    const w: string[] = ['p.period BETWEEN $1 AND $2'];
    if (opts.allowedGstins !== undefined && opts.allowedGstins !== null) {
      const scoped = [...new Set(opts.allowedGstins.map(normGstin).filter(Boolean))];
      if (scoped.length === 0) {
        w.push('1 = 0');
      } else {
        params.push(scoped);
        w.push(`p.our_gstin = ANY($${params.length}::text[])`);
      }
    }
    if (opts.gstin) {
      params.push(normGstin(opts.gstin));
      w.push(`p.our_gstin = $${params.length}`);
    }
    if (opts.company) {
      const coGstins = await resolveCompanyGstins(c, opts.company);
      if (coGstins.length === 0) {
        w.push('1 = 0');
      } else {
        params.push(coGstins);
        w.push(`p.our_gstin = ANY($${params.length}::text[])`);
      }
    }

    const res = await c.query(
      `SELECT p.period,
              COUNT(*)::int AS invoice_count,
              COUNT(*) FILTER (WHERE COALESCE(p.book_document_type, 'Tax Invoice') = 'Tax Invoice')::int AS ti_count,
              COUNT(*) FILTER (WHERE p.book_document_type = 'Debit Note')::int AS dn_count,
              COUNT(*) FILTER (WHERE p.book_document_type = 'Credit Note')::int AS cn_count,
              ROUND(COALESCE(SUM(p.book_taxable_value), 0)::numeric, 2)::float8 AS taxable_value,
              ROUND(COALESCE(SUM(p.book_igst), 0)::numeric, 2)::float8 AS igst,
              ROUND(COALESCE(SUM(p.book_cgst), 0)::numeric, 2)::float8 AS cgst,
              ROUND(COALESCE(SUM(p.book_sgst), 0)::numeric, 2)::float8 AS sgst,
              ROUND(COALESCE(SUM(COALESCE(p.book_utgst, 0)), 0)::numeric, 2)::float8 AS utgst,
              ROUND(COALESCE(SUM(p.book_cess), 0)::numeric, 2)::float8 AS cess,
              ROUND(COALESCE(SUM(p.book_invoice_value), 0)::numeric, 2)::float8 AS invoice_value,
              COUNT(*) FILTER (WHERE p.book_invoice_value IS NOT NULL)::int AS inv_val_captured,
              COUNT(*) FILTER (WHERE p.book_invoice_value IS NULL)::int AS inv_val_missing
         FROM purchase_lines p
        WHERE ${w.join(' AND ')}
        GROUP BY p.period
        ORDER BY p.period ASC`,
      params,
    );

    const byPeriod = new Map<string, MonthlyBookRow>();
    for (const r of res.rows as any[]) {
      const igst = r2(Number(r.igst || 0));
      const cgst = r2(Number(r.cgst || 0));
      const sgst = r2(Number(r.sgst || 0));
      const utgst = r2(Number(r.utgst || 0));
      const cess = r2(Number(r.cess || 0));
      byPeriod.set(String(r.period), {
        period: String(r.period),
        label: labelOf(String(r.period)),
        fy,
        invoiceCount: Number(r.invoice_count || 0),
        taxInvoiceCount: Number(r.ti_count || 0),
        debitNoteCount: Number(r.dn_count || 0),
        creditNoteCount: Number(r.cn_count || 0),
        taxableValue: r2(Number(r.taxable_value || 0)),
        igst,
        cgst,
        sgst,
        utgst,
        cess,
        totalGst: r2(igst + cgst + sgst + utgst + cess),
        invoiceValue: r2(Number(r.invoice_value || 0)),
        invoiceValueCapturedCount: Number(r.inv_val_captured || 0),
        missingInvoiceValueCount: Number(r.inv_val_missing || 0),
      });
    }

    const months = monthsList.map((p) => byPeriod.get(p) ?? emptyMonthRow(p, fy));
    const annualTotal = months.reduce<MonthlyBookRow>(
      (acc, m) => ({
        period: fy,
        label: `Total FY ${fy}`,
        fy,
        invoiceCount: acc.invoiceCount + m.invoiceCount,
        taxInvoiceCount: acc.taxInvoiceCount + m.taxInvoiceCount,
        debitNoteCount: acc.debitNoteCount + m.debitNoteCount,
        creditNoteCount: acc.creditNoteCount + m.creditNoteCount,
        taxableValue: r2(acc.taxableValue + m.taxableValue),
        igst: r2(acc.igst + m.igst),
        cgst: r2(acc.cgst + m.cgst),
        sgst: r2(acc.sgst + m.sgst),
        utgst: r2(acc.utgst + m.utgst),
        cess: r2(acc.cess + m.cess),
        totalGst: r2(acc.totalGst + m.totalGst),
        invoiceValue: r2(acc.invoiceValue + m.invoiceValue),
        invoiceValueCapturedCount: acc.invoiceValueCapturedCount + m.invoiceValueCapturedCount,
        missingInvoiceValueCount: acc.missingInvoiceValueCount + m.missingInvoiceValueCount,
      }),
      emptyMonthRow(fy, fy),
    );

    const recomputedTotalGst = r2(annualTotal.igst + annualTotal.cgst + annualTotal.sgst + annualTotal.utgst + annualTotal.cess);
    const mathVerified =
      Math.abs(recomputedTotalGst - annualTotal.totalGst) <= 0.01 &&
      annualTotal.invoiceCount === annualTotal.taxInvoiceCount + annualTotal.debitNoteCount + annualTotal.creditNoteCount &&
      annualTotal.invoiceCount === annualTotal.invoiceValueCapturedCount + annualTotal.missingInvoiceValueCount;

    return {
      fy,
      gstin: opts.gstin ? normGstin(opts.gstin) : null,
      company: opts.company || null,
      months,
      annualTotal,
      mathVerified,
    };
  });
}

const MONTHLY_BOOK_COLS: Column[] = [
  { h: 'Period', k: 'period', t: 'text', w: 11 },
  { h: 'Month', k: 'label', t: 'text', w: 15 },
  { h: 'Invoices', k: 'invoiceCount', t: 'int', w: 10 },
  { h: 'Tax Inv', k: 'taxInvoiceCount', t: 'int', w: 9 },
  { h: 'Debit Notes', k: 'debitNoteCount', t: 'int', w: 11 },
  { h: 'Credit Notes', k: 'creditNoteCount', t: 'int', w: 12 },
  { h: 'Taxable Value', k: 'taxableValue', t: 'money', w: 16 },
  { h: 'IGST', k: 'igst', t: 'money', w: 14 },
  { h: 'CGST', k: 'cgst', t: 'money', w: 14 },
  { h: 'SGST', k: 'sgst', t: 'money', w: 14 },
  { h: 'UTGST', k: 'utgst', t: 'money', w: 14 },
  { h: 'Cess', k: 'cess', t: 'money', w: 12 },
  { h: 'Total GST', k: 'totalGst', t: 'money', w: 16 },
  { h: 'Captured Invoice Value', k: 'invoiceValue', t: 'money', w: 18 },
];

export function exportMonthlyBookSummaryWorkbook(summary: MonthlyBookSummaryResult): Buffer {
  const rows = [...summary.months, summary.annualTotal] as unknown as Record<string, unknown>[];
  return toWorkbookBuffer(
    `Monthly Book Summary — FY ${summary.fy}`,
    MONTHLY_BOOK_COLS,
    rows,
    [
      `Financial Year: ${summary.fy}`,
      `GSTIN: ${summary.gstin || 'All GSTINs'}`,
      `Total Invoices: ${summary.annualTotal.invoiceCount} | Total Taxable: ${summary.annualTotal.taxableValue.toFixed(2)} | Total GST: ${summary.annualTotal.totalGst.toFixed(2)}`,
    ],
  );
}

// ---------------------------------------------------------------------------
// 2. PAN-WISE SUPPLIER CONSOLIDATION WITH GSTIN-LEVEL DETAILS
// ---------------------------------------------------------------------------

export interface PanGstinDetail {
  supplierGstin: string;
  stateCode: string;
  gstinValid: boolean;
  supplierNames: string[];
  invoiceCount: number;
  matchedCount: number;
  missingCount: number;
  mismatchCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  invoiceValue: number;
  twobTax: number;
  itcDiff: number;
}

export interface PanConsolidationRow {
  pan: string;
  primaryName: string;
  gstinCount: number;
  conflicts: string[];
  hasConflict: boolean;
  invoiceCount: number;
  matchedCount: number;
  missingCount: number;
  mismatchCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  invoiceValue: number;
  twobTax: number;
  itcDiff: number;
  gstins: PanGstinDetail[];
}

export interface PanConsolidationResult {
  scope: { gstin: string | null; company: string | null; fy: string | null; period: string | null };
  panCount: number;
  gstinCount: number;
  conflictPanCount: number;
  grandTotal: {
    invoiceCount: number;
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    utgst: number;
    cess: number;
    totalGst: number;
    invoiceValue: number;
    twobTax: number;
    itcDiff: number;
  };
  pans: PanConsolidationRow[];
  mathVerified: boolean;
}

function normVendorKey(name: string): string {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function getPanSupplierConsolidation(opts: {
  gstin?: string | null;
  company?: string | null;
  fy?: string | null;
  period?: string | null;
  q?: string | null;
  allowedGstins?: string[] | null;
}): Promise<PanConsolidationResult> {
  return withClient(async (c) => {
    const params: unknown[] = [];
    const w: string[] = [];
    if (opts.allowedGstins !== undefined && opts.allowedGstins !== null) {
      const scoped = [...new Set(opts.allowedGstins.map(normGstin).filter(Boolean))];
      if (scoped.length === 0) {
        w.push('1 = 0');
      } else {
        params.push(scoped);
        w.push(`p.our_gstin = ANY($${params.length}::text[])`);
      }
    }
    if (opts.gstin) {
      params.push(normGstin(opts.gstin));
      w.push(`p.our_gstin = $${params.length}`);
    }
    if (opts.company) {
      const coGstins = await resolveCompanyGstins(c, opts.company);
      if (coGstins.length === 0) {
        w.push('1 = 0');
      } else {
        params.push(coGstins);
        w.push(`p.our_gstin = ANY($${params.length}::text[])`);
      }
    }
    if (opts.period) {
      params.push(opts.period);
      w.push(`p.period = $${params.length}`);
    } else if (opts.fy) {
      const m = fyMonths(opts.fy).months;
      params.push(m[0], m[m.length - 1]);
      w.push(`p.period BETWEEN $${params.length - 1} AND $${params.length}`);
    }
    if (opts.q) {
      params.push(`%${opts.q.trim()}%`);
      w.push(`(p.book_supplier_gstin ILIKE $${params.length} OR p.party_name ILIKE $${params.length})`);
    }
    const whereSql = w.length ? `WHERE ${w.join(' AND ')}` : '';

    const res = await c.query(
      `SELECT UPPER(TRIM(COALESCE(p.book_supplier_gstin, ''))) AS supplier_gstin,
              ARRAY_AGG(DISTINCT NULLIF(TRIM(p.party_name), '')) FILTER (WHERE NULLIF(TRIM(p.party_name), '') IS NOT NULL) AS names,
              COUNT(*)::int AS invoice_count,
              COUNT(*) FILTER (WHERE p.match_status = 'Matched')::int AS matched_count,
              COUNT(*) FILTER (WHERE p.match_status = 'Missing in 2B')::int AS missing_count,
              COUNT(*) FILTER (WHERE p.match_status IS NOT NULL AND p.match_status NOT IN ('Matched', 'Missing in 2B'))::int AS mismatch_count,
              ROUND(COALESCE(SUM(p.book_taxable_value), 0)::numeric, 2)::float8 AS taxable_value,
              ROUND(COALESCE(SUM(p.book_igst), 0)::numeric, 2)::float8 AS igst,
              ROUND(COALESCE(SUM(p.book_cgst), 0)::numeric, 2)::float8 AS cgst,
              ROUND(COALESCE(SUM(p.book_sgst), 0)::numeric, 2)::float8 AS sgst,
              ROUND(COALESCE(SUM(COALESCE(p.book_utgst, 0)), 0)::numeric, 2)::float8 AS utgst,
              ROUND(COALESCE(SUM(p.book_cess), 0)::numeric, 2)::float8 AS cess,
              ROUND(COALESCE(SUM(p.book_invoice_value), 0)::numeric, 2)::float8 AS invoice_value,
              ROUND(COALESCE(SUM(COALESCE(p.twob_igst,0)+COALESCE(p.twob_cgst,0)+COALESCE(p.twob_sgst,0)+COALESCE(p.twob_utgst,0)+COALESCE(p.twob_cess,0)), 0)::numeric, 2)::float8 AS twob_tax
         FROM purchase_lines p
         ${whereSql}
        GROUP BY 1
        ORDER BY SUM(p.book_taxable_value) DESC`,
      params,
    );

    const panMap = new Map<string, PanConsolidationRow>();

    for (const r of res.rows as any[]) {
      const sg = String(r.supplier_gstin || '').trim();
      const valid = GSTIN_RE.test(sg);
      const pan = sg.length >= 12 ? sg.slice(2, 12) : (sg || 'UNREGISTERED');
      const stateCode = sg.length >= 2 && /^\d{2}/.test(sg) ? sg.slice(0, 2) : '';
      const names: string[] = Array.isArray(r.names) ? r.names.filter(Boolean) : [];
      const igst = r2(Number(r.igst || 0));
      const cgst = r2(Number(r.cgst || 0));
      const sgst = r2(Number(r.sgst || 0));
      const utgst = r2(Number(r.utgst || 0));
      const cess = r2(Number(r.cess || 0));
      const totalGst = r2(igst + cgst + sgst + utgst + cess);
      const twobTax = r2(Number(r.twob_tax || 0));

      const detail: PanGstinDetail = {
        supplierGstin: sg || 'UNREGISTERED',
        stateCode,
        gstinValid: valid,
        supplierNames: names,
        invoiceCount: Number(r.invoice_count || 0),
        matchedCount: Number(r.matched_count || 0),
        missingCount: Number(r.missing_count || 0),
        mismatchCount: Number(r.mismatch_count || 0),
        taxableValue: r2(Number(r.taxable_value || 0)),
        igst,
        cgst,
        sgst,
        utgst,
        cess,
        totalGst,
        invoiceValue: r2(Number(r.invoice_value || 0)),
        twobTax,
        itcDiff: r2(totalGst - twobTax),
      };

      let cur = panMap.get(pan);
      if (!cur) {
        cur = {
          pan,
          primaryName: names[0] || sg || 'Unknown Supplier',
          gstinCount: 0,
          conflicts: [],
          hasConflict: false,
          invoiceCount: 0,
          matchedCount: 0,
          missingCount: 0,
          mismatchCount: 0,
          taxableValue: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          utgst: 0,
          cess: 0,
          totalGst: 0,
          invoiceValue: 0,
          twobTax: 0,
          itcDiff: 0,
          gstins: [],
        };
        panMap.set(pan, cur);
      }
      cur.gstins.push(detail);
      cur.gstinCount = cur.gstins.length;
      cur.invoiceCount += detail.invoiceCount;
      cur.matchedCount += detail.matchedCount;
      cur.missingCount += detail.missingCount;
      cur.mismatchCount += detail.mismatchCount;
      cur.taxableValue = r2(cur.taxableValue + detail.taxableValue);
      cur.igst = r2(cur.igst + detail.igst);
      cur.cgst = r2(cur.cgst + detail.cgst);
      cur.sgst = r2(cur.sgst + detail.sgst);
      cur.utgst = r2(cur.utgst + detail.utgst);
      cur.cess = r2(cur.cess + detail.cess);
      cur.totalGst = r2(cur.totalGst + detail.totalGst);
      cur.invoiceValue = r2(cur.invoiceValue + detail.invoiceValue);
      cur.twobTax = r2(cur.twobTax + detail.twobTax);
      cur.itcDiff = r2(cur.totalGst - cur.twobTax);
    }

    const pans = [...panMap.values()];
    for (const p of pans) {
      const conflicts: string[] = [];
      const invalidGstins = p.gstins.filter((g) => !g.gstinValid);
      if (invalidGstins.length) {
        conflicts.push(`INVALID_GSTIN_FORMAT (${invalidGstins.map((g) => g.supplierGstin).join(', ')})`);
      }
      const distinctNormNames = new Map<string, string>();
      for (const g of p.gstins) {
        for (const nm of g.supplierNames) {
          const nk = normVendorKey(nm);
          if (nk && !distinctNormNames.has(nk)) distinctNormNames.set(nk, nm);
        }
      }
      if (distinctNormNames.size > 1) {
        conflicts.push(`MULTIPLE_NAMES_SAME_PAN (${[...distinctNormNames.values()].join(' vs ')})`);
      }
      p.conflicts = conflicts;
      p.hasConflict = conflicts.length > 0;
    }

    pans.sort((a, b) => b.taxableValue - a.taxableValue);

    const grandTotal = pans.reduce(
      (acc, p) => ({
        invoiceCount: acc.invoiceCount + p.invoiceCount,
        taxableValue: r2(acc.taxableValue + p.taxableValue),
        igst: r2(acc.igst + p.igst),
        cgst: r2(acc.cgst + p.cgst),
        sgst: r2(acc.sgst + p.sgst),
        utgst: r2(acc.utgst + p.utgst),
        cess: r2(acc.cess + p.cess),
        totalGst: r2(acc.totalGst + p.totalGst),
        invoiceValue: r2(acc.invoiceValue + p.invoiceValue),
        twobTax: r2(acc.twobTax + p.twobTax),
        itcDiff: r2(acc.itcDiff + p.itcDiff),
      }),
      { invoiceCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, utgst: 0, cess: 0, totalGst: 0, invoiceValue: 0, twobTax: 0, itcDiff: 0 },
    );

    const gstinSumTaxable = r2(pans.reduce((s, p) => s + p.gstins.reduce((gs, g) => gs + g.taxableValue, 0), 0));
    const mathVerified = Math.abs(gstinSumTaxable - grandTotal.taxableValue) <= 0.01;

    return {
      scope: {
        gstin: opts.gstin ? normGstin(opts.gstin) : null,
        company: opts.company || null,
        fy: opts.fy || null,
        period: opts.period || null,
      },
      panCount: pans.length,
      gstinCount: pans.reduce((s, p) => s + p.gstinCount, 0),
      conflictPanCount: pans.filter((p) => p.hasConflict).length,
      grandTotal,
      pans,
      mathVerified,
    };
  });
}

export function exportPanConsolidationWorkbook(data: PanConsolidationResult): Buffer {
  const wb = XLSX.utils.book_new();
  const panRows = data.pans.map((p) => ({
    PAN: p.pan,
    'Primary Supplier Name': p.primaryName,
    'GSTINs Count': p.gstinCount,
    'Conflicts': p.conflicts.join('; '),
    'Invoices': p.invoiceCount,
    'Taxable Value': p.taxableValue,
    IGST: p.igst,
    CGST: p.cgst,
    SGST: p.sgst,
    UTGST: p.utgst,
    Cess: p.cess,
    'Total GST': p.totalGst,
    '2B Tax': p.twobTax,
    'ITC Diff': p.itcDiff,
  }));
  const gstinRows: Record<string, unknown>[] = [];
  for (const p of data.pans) {
    for (const g of p.gstins) {
      gstinRows.push({
        PAN: p.pan,
        'Supplier GSTIN': g.supplierGstin,
        'State Code': g.stateCode,
        'Valid GSTIN': g.gstinValid ? 'Yes' : 'NO',
        'Supplier Names': g.supplierNames.join(' | '),
        Invoices: g.invoiceCount,
        Matched: g.matchedCount,
        'Missing in 2B': g.missingCount,
        Mismatch: g.mismatchCount,
        'Taxable Value': g.taxableValue,
        IGST: g.igst,
        CGST: g.cgst,
        SGST: g.sgst,
        UTGST: g.utgst,
        Cess: g.cess,
        'Total GST': g.totalGst,
        '2B Tax': g.twobTax,
        'ITC Diff': g.itcDiff,
      });
    }
  }
  const wsPan = XLSX.utils.json_to_sheet(panRows.length ? panRows : [{ PAN: 'No records' }]);
  const wsGstin = XLSX.utils.json_to_sheet(gstinRows.length ? gstinRows : [{ PAN: 'No records' }]);
  XLSX.utils.book_append_sheet(wb, wsPan, 'PAN Consolidation');
  XLSX.utils.book_append_sheet(wb, wsGstin, 'GSTIN Breakdown');
  return polishWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

// ---------------------------------------------------------------------------
// 3. SAP BUSINESS ONE CONTROL TOTALS — MANUAL + EXCEL + 3-WAY COMPARISON
// ---------------------------------------------------------------------------

export interface SapControlInput {
  ourGstin: string;
  period: string;
  invoiceCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst?: number;
  invoiceValue: number;
  remarks?: string;
}

export interface SapControlSaveResult {
  ok: boolean;
  code?: 'INVALID_INPUT' | 'OVERWRITE_PROTECTED' | 'OVERWRITE_REASON_REQUIRED' | 'DUPLICATE_FILE' | 'EXCEL_VALIDATION_FAILED' | 'PERIOD_LOCKED';
  error?: string;
  conflict?: boolean;
  locked?: boolean;
  existing?: any;
  batchId?: number;
  batchUid?: string;
  savedCount?: number;
  rows?: any[];
  validationErrors?: string[];
}

function validateSapRow(raw: SapControlInput, rowLabel: string): { ok: true; clean: SapControlInput & { financialYear: string; totalGst: number } } | { ok: false; error: string } {
  const ourGstin = normGstin(raw.ourGstin);
  if (!GSTIN_RE.test(ourGstin)) {
    return { ok: false, error: `${rowLabel}: Invalid GSTIN "${raw.ourGstin}" (expected 15-char Indian GSTIN).` };
  }
  const period = periodFromAny(raw.period) || String(raw.period || '').trim();
  if (!PERIOD_RE.test(period)) {
    return { ok: false, error: `${rowLabel}: Invalid period "${raw.period}" (expected YYYY-MM or Mon-YYYY).` };
  }
  const invoiceCount = Number(raw.invoiceCount);
  if (!Number.isInteger(invoiceCount) || invoiceCount < 0) {
    return { ok: false, error: `${rowLabel}: Invoice count must be a non-negative integer.` };
  }
  const nums = {
    taxableValue: Number(raw.taxableValue),
    igst: Number(raw.igst ?? 0),
    cgst: Number(raw.cgst ?? 0),
    sgst: Number(raw.sgst ?? 0),
    utgst: Number(raw.utgst ?? 0),
    cess: Number(raw.cess ?? 0),
    invoiceValue: Number(raw.invoiceValue ?? 0),
  };
  for (const [k, v] of Object.entries(nums)) {
    if (!Number.isFinite(v)) {
      return { ok: false, error: `${rowLabel}: Field "${k}" must be a valid number.` };
    }
  }
  const computedGst = r2(nums.igst + nums.cgst + nums.sgst + nums.utgst + nums.cess);
  if (raw.totalGst !== undefined && raw.totalGst !== null && String(raw.totalGst) !== '') {
    const providedGst = Number(raw.totalGst);
    if (!Number.isFinite(providedGst) || Math.abs(r2(providedGst) - computedGst) > 1.0) {
      return {
        ok: false,
        error: `${rowLabel}: Provided Total GST (${raw.totalGst}) does not match IGST+CGST+SGST+UTGST+Cess (${computedGst}).`,
      };
    }
  }
  return {
    ok: true,
    clean: {
      ourGstin,
      period,
      financialYear: fyOf(period),
      invoiceCount,
      taxableValue: r2(nums.taxableValue),
      igst: r2(nums.igst),
      cgst: r2(nums.cgst),
      sgst: r2(nums.sgst),
      utgst: r2(nums.utgst),
      cess: r2(nums.cess),
      totalGst: computedGst,
      invoiceValue: r2(nums.invoiceValue),
      remarks: raw.remarks ? String(raw.remarks).trim() : undefined,
    },
  };
}

export async function saveSapControlTotalManual(
  input: SapControlInput,
  opts: { enteredBy: string; allowOverwrite?: boolean; overwriteReason?: string },
): Promise<SapControlSaveResult> {
  const v = validateSapRow(input, 'Manual Entry');
  if (v.ok === false) return { ok: false, code: 'INVALID_INPUT', error: v.error };
  const row = v.clean;

  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const existingRes = await c.query(
        `SELECT * FROM sap_book_control_totals WHERE our_gstin = $1 AND period = $2 AND is_active = true LIMIT 1`,
        [row.ourGstin, row.period],
      );
      const existing = existingRes.rows[0] || null;
      const periodLk = await isLocked(row.ourGstin, row.period);
      if (periodLk.locked) {
        await c.query('ROLLBACK');
        return {
          ok: false,
          locked: true,
          code: 'PERIOD_LOCKED',
          error: `Period ${row.period} for ${row.ourGstin} is LOCKED. Unlock the period before modifying SAP control totals.`,
          existing,
        };
      }
      if (existing?.is_locked) {
        await c.query('ROLLBACK');
        return {
          ok: false,
          locked: true,
          code: 'PERIOD_LOCKED',
          error: `SAP control total for ${row.ourGstin} / ${row.period} (v${existing.version_no}) is LOCKED and cannot be overwritten.`,
          existing,
        };
      }
      if (existing) {
        if (!opts.allowOverwrite) {
          await c.query('ROLLBACK');
          return {
            ok: false,
            conflict: true,
            code: 'OVERWRITE_PROTECTED',
            error: `SAP control total already exists for ${row.ourGstin} / ${row.period} (v${existing.version_no}). Enable explicit overwrite with a reason to archive the previous version.`,
            existing,
          };
        }
        if (!String(opts.overwriteReason || '').trim()) {
          await c.query('ROLLBACK');
          return {
            ok: false,
            conflict: true,
            code: 'OVERWRITE_REASON_REQUIRED',
            error: 'An explicit overwriteReason is required to supersede an existing SAP control total.',
            existing,
          };
        }
        await c.query(
          `UPDATE sap_book_control_totals SET is_active = false, updated_at = now() WHERE id = $1`,
          [existing.id],
        );
      }

      const batchUid = `SAP-MAN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const bRes = await c.query(
        `INSERT INTO sap_control_upload_batches (batch_uid, source_type, row_count, uploaded_by, notes)
         VALUES ($1, 'MANUAL', 1, $2, $3) RETURNING id`,
        [batchUid, opts.enteredBy || 'system', row.remarks || opts.overwriteReason || null],
      );
      const batchId = Number(bRes.rows[0].id);
      const nextVersion = existing ? Number(existing.version_no) + 1 : 1;

      const ins = await c.query(
        `INSERT INTO sap_book_control_totals
           (our_gstin, financial_year, period, invoice_count, taxable_value,
            igst, cgst, sgst, utgst, cess, total_gst, invoice_value,
            source_type, batch_id, version_no, is_active, entered_by, remarks, overwrite_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'MANUAL',$13,$14,true,$15,$16,$17)
         RETURNING *`,
        [
          row.ourGstin, row.financialYear, row.period, row.invoiceCount, row.taxableValue,
          row.igst, row.cgst, row.sgst, row.utgst, row.cess, row.totalGst, row.invoiceValue,
          batchId, nextVersion, opts.enteredBy || 'system', row.remarks || null,
          existing ? String(opts.overwriteReason || '').trim() : null,
        ],
      );

      await c.query('COMMIT');
      return { ok: true, batchId, batchUid, savedCount: 1, rows: [ins.rows[0]] };
    } catch (e: any) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

function normHdr(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SAP_EXCEL_ALIASES: Record<string, string[]> = {
  ourGstin: ['ourgstin', 'gstin', 'companygstin', 'gstinnumber', 'gstno'],
  period: ['period', 'month', 'returnmonth', 'returnperiod', 'booksmonth', 'yyyymm'],
  invoiceCount: ['invoicecount', 'invoiceno', 'docs', 'doccount', 'billcount', 'count', 'noofinvoices', 'totalinvoices'],
  taxableValue: ['taxablevalue', 'taxable', 'taxableamount', 'taxableamt', 'baseamount'],
  igst: ['igst', 'igstamount', 'igstamt', 'inputigst'],
  cgst: ['cgst', 'cgstamount', 'cgstamt', 'inputcgst'],
  sgst: ['sgst', 'sgstamount', 'sgstamt', 'inputsgst'],
  utgst: ['utgst', 'utgstamount', 'utgstamt', 'inpututgst'],
  cess: ['cess', 'cessamount', 'cessamt'],
  totalGst: ['totalgst', 'totalgstamount', 'totaltax', 'gsttotal'],
  invoiceValue: ['invoicevalue', 'invoicetotal', 'doctotal', 'grossamount', 'totalinvoicevalue', 'billvalue'],
  remarks: ['remarks', 'remark', 'notes', 'note'],
};

export function parseSapControlExcel(buffer: Buffer, fileName = 'sap-control.xlsx'): {
  ok: boolean;
  fileHash: string;
  rows: Array<SapControlInput & { financialYear: string; totalGst: number }>;
  errors: string[];
} {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  if (!wb.SheetNames.length) {
    return { ok: false, fileHash, rows: [], errors: [`${fileName}: Workbook has no sheets.`] };
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (matrix.length < 2) {
    return { ok: false, fileHash, rows: [], errors: [`${fileName}: Sheet must contain a header row and at least one data row.`] };
  }

  // Locate header row within first 5 rows
  let headerIdx = -1;
  let colMap: Record<string, number> = {};
  for (let r = 0; r < Math.min(5, matrix.length); r++) {
    const row = matrix[r] || [];
    const candidate: Record<string, number> = {};
    for (let c = 0; c < row.length; c++) {
      const h = normHdr(row[c]);
      if (!h) continue;
      for (const [field, aliases] of Object.entries(SAP_EXCEL_ALIASES)) {
        if (candidate[field] === undefined && aliases.includes(h)) {
          candidate[field] = c;
        }
      }
    }
    if (candidate.ourGstin !== undefined && candidate.period !== undefined && candidate.taxableValue !== undefined) {
      headerIdx = r;
      colMap = candidate;
      break;
    }
  }

  if (headerIdx < 0) {
    return {
      ok: false,
      fileHash,
      rows: [],
      errors: [`${fileName}: Required columns missing. Expected headers including GSTIN, Period/Month, and Taxable Value.`],
    };
  }

  const cleanRows: Array<SapControlInput & { financialYear: string; totalGst: number }> = [];
  const errors: string[] = [];
  const seenKeys = new Set<string>();

  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const raw = matrix[r] || [];
    const nonEmpty = raw.some((v) => String(v ?? '').trim() !== '');
    if (!nonEmpty) continue;
    const firstCell = String(raw[colMap.ourGstin] ?? '').trim();
    if (/^(total|grand\s*total|sub\s*total)/i.test(firstCell)) continue;

    const pick = (k: string) => (colMap[k] !== undefined ? raw[colMap[k]] : undefined);
    const numOr = (v: unknown, def = 0) => {
      if (v === null || v === undefined || String(v).trim() === '') return def;
      const n = Number(String(v).replace(/,/g, '').trim());
      return n;
    };

    const rawPeriod = pick('period');
    const periodStr = rawPeriod instanceof Date
      ? `${rawPeriod.getFullYear()}-${String(rawPeriod.getMonth() + 1).padStart(2, '0')}`
      : String(rawPeriod ?? '').trim();

    const parsed = validateSapRow(
      {
        ourGstin: String(pick('ourGstin') ?? '').trim(),
        period: periodStr,
        invoiceCount: numOr(pick('invoiceCount'), 0),
        taxableValue: numOr(pick('taxableValue'), NaN),
        igst: numOr(pick('igst'), 0),
        cgst: numOr(pick('cgst'), 0),
        sgst: numOr(pick('sgst'), 0),
        utgst: numOr(pick('utgst'), 0),
        cess: numOr(pick('cess'), 0),
        totalGst: pick('totalGst') !== undefined && String(pick('totalGst')).trim() !== '' ? numOr(pick('totalGst'), NaN) : undefined,
        invoiceValue: numOr(pick('invoiceValue'), 0),
        remarks: pick('remarks') ? String(pick('remarks')).trim() : undefined,
      },
      `Row ${r + 1}`,
    );

    if (parsed.ok === false) {
      errors.push(parsed.error);
      continue;
    }

    const key = `${parsed.clean.ourGstin}|${parsed.clean.period}`;
    if (seenKeys.has(key)) {
      errors.push(`Row ${r + 1}: Duplicate GSTIN + Period (${parsed.clean.ourGstin} / ${parsed.clean.period}) inside the same Excel file.`);
      continue;
    }
    seenKeys.add(key);
    cleanRows.push(parsed.clean);
  }

  if (!cleanRows.length && !errors.length) {
    errors.push(`${fileName}: No valid data rows found.`);
  }

  return { ok: errors.length === 0 && cleanRows.length > 0, fileHash, rows: cleanRows, errors };
}

export async function importSapControlExcel(
  buffer: Buffer,
  fileName: string,
  opts: { uploadedBy: string; allowOverwrite?: boolean; overwriteReason?: string; allowDuplicateFile?: boolean },
): Promise<SapControlSaveResult> {
  const parsed = parseSapControlExcel(buffer, fileName);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'EXCEL_VALIDATION_FAILED',
      error: parsed.errors[0] || 'Excel validation failed',
      validationErrors: parsed.errors,
    };
  }

  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      if (!opts.allowDuplicateFile) {
        const dupFile = await c.query(
          `SELECT id, batch_uid, file_name, uploaded_at FROM sap_control_upload_batches WHERE file_hash = $1 LIMIT 1`,
          [parsed.fileHash],
        );
        if (dupFile.rows.length) {
          await c.query('ROLLBACK');
          return {
            ok: false,
            conflict: true,
            code: 'DUPLICATE_FILE',
            error: `This exact SAP Control Excel file was already uploaded in batch ${dupFile.rows[0].batch_uid} (${dupFile.rows[0].file_name}).`,
            existing: dupFile.rows[0],
          };
        }
      }

      // Check period locks, row-level SAP locks, and accidental overwrites before mutating anything
      const conflicts: any[] = [];
      for (const row of parsed.rows) {
        const periodLk = await isLocked(row.ourGstin, row.period);
        if (periodLk.locked) {
          await c.query('ROLLBACK');
          return {
            ok: false,
            locked: true,
            code: 'PERIOD_LOCKED',
            error: `Period ${row.period} for ${row.ourGstin} is LOCKED. SAP Excel upload rejected.`,
          };
        }
        const ex = await c.query(
          `SELECT * FROM sap_book_control_totals WHERE our_gstin = $1 AND period = $2 AND is_active = true LIMIT 1`,
          [row.ourGstin, row.period],
        );
        if (ex.rows.length) {
          if (ex.rows[0].is_locked) {
            await c.query('ROLLBACK');
            return {
              ok: false,
              locked: true,
              code: 'PERIOD_LOCKED',
              error: `SAP control total for ${row.ourGstin} / ${row.period} (v${ex.rows[0].version_no}) is LOCKED. SAP Excel upload rejected.`,
              existing: ex.rows[0],
            };
          }
          conflicts.push(ex.rows[0]);
        }
      }

      if (conflicts.length && !opts.allowOverwrite) {
        await c.query('ROLLBACK');
        return {
          ok: false,
          conflict: true,
          code: 'OVERWRITE_PROTECTED',
          error: `${conflicts.length} GSTIN/month control total(s) already exist (${conflicts.map((x) => `${x.our_gstin}/${x.period}`).join(', ')}). Enable explicit overwrite with a reason to archive prior versions.`,
          existing: conflicts,
        };
      }
      if (conflicts.length && !String(opts.overwriteReason || '').trim()) {
        await c.query('ROLLBACK');
        return {
          ok: false,
          conflict: true,
          code: 'OVERWRITE_REASON_REQUIRED',
          error: 'An explicit overwriteReason is required when superseding existing SAP control totals.',
          existing: conflicts,
        };
      }

      const batchUid = `SAP-XLS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const bRes = await c.query(
        `INSERT INTO sap_control_upload_batches (batch_uid, source_type, file_name, file_hash, row_count, uploaded_by, notes)
         VALUES ($1, 'EXCEL', $2, $3, $4, $5, $6) RETURNING id`,
        [batchUid, fileName, parsed.fileHash, parsed.rows.length, opts.uploadedBy || 'system', opts.overwriteReason || null],
      );
      const batchId = Number(bRes.rows[0].id);

      const savedRows: any[] = [];
      for (const row of parsed.rows) {
        const exRes = await c.query(
          `SELECT id, version_no FROM sap_book_control_totals WHERE our_gstin = $1 AND period = $2 AND is_active = true LIMIT 1`,
          [row.ourGstin, row.period],
        );
        const ex = exRes.rows[0] || null;
        if (ex) {
          await c.query(`UPDATE sap_book_control_totals SET is_active = false, updated_at = now() WHERE id = $1`, [ex.id]);
        }
        const nextVersion = ex ? Number(ex.version_no) + 1 : 1;
        const ins = await c.query(
          `INSERT INTO sap_book_control_totals
             (our_gstin, financial_year, period, invoice_count, taxable_value,
              igst, cgst, sgst, utgst, cess, total_gst, invoice_value,
              source_type, batch_id, version_no, is_active, entered_by, remarks, overwrite_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'EXCEL',$13,$14,true,$15,$16,$17)
           RETURNING *`,
          [
            row.ourGstin, row.financialYear, row.period, row.invoiceCount, row.taxableValue,
            row.igst, row.cgst, row.sgst, row.utgst, row.cess, row.totalGst, row.invoiceValue,
            batchId, nextVersion, opts.uploadedBy || 'system', row.remarks || null,
            ex ? String(opts.overwriteReason || '').trim() : null,
          ],
        );
        savedRows.push(ins.rows[0]);
      }

      await c.query('COMMIT');
      return { ok: true, batchId, batchUid, savedCount: savedRows.length, rows: savedRows };
    } catch (e: any) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

export interface ThreeWayTotals {
  invoiceCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  invoiceValue: number;
}

export interface SapComparisonRow {
  ourGstin: string;
  period: string;
  label: string;
  fy: string;
  sapStatus: 'SAP_VERIFIED' | 'SAP_VARIANCE' | 'SAP_MISSING';
  sapVersion: number | null;
  sapSourceType: string | null;
  sap: ThreeWayTotals | null;
  books: ThreeWayTotals;
  twob: ThreeWayTotals;
  sapVsBooks: ThreeWayTotals | null;
  booksVs2b: ThreeWayTotals;
}

function zeroTotals(): ThreeWayTotals {
  return { invoiceCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, utgst: 0, cess: 0, totalGst: 0, invoiceValue: 0 };
}

function diffTotals(a: ThreeWayTotals, b: ThreeWayTotals): ThreeWayTotals {
  return {
    invoiceCount: a.invoiceCount - b.invoiceCount,
    taxableValue: r2(a.taxableValue - b.taxableValue),
    igst: r2(a.igst - b.igst),
    cgst: r2(a.cgst - b.cgst),
    sgst: r2(a.sgst - b.sgst),
    utgst: r2(a.utgst - b.utgst),
    cess: r2(a.cess - b.cess),
    totalGst: r2(a.totalGst - b.totalGst),
    invoiceValue: r2(a.invoiceValue - b.invoiceValue),
  };
}

export async function getSapControlComparison(opts: {
  gstin?: string | null;
  fy?: string | null;
  period?: string | null;
  allowedGstins?: string[] | null;
}): Promise<{
  rows: SapComparisonRow[];
  summary: { total: number; verified: number; variance: number; missing: number };
}> {
  return withClient(async (c) => {
    const buildFilter = (gstinCol: string, periodCol: string) => {
      const params: unknown[] = [];
      const w: string[] = [];
      if (opts.allowedGstins !== undefined && opts.allowedGstins !== null) {
        const scoped = [...new Set(opts.allowedGstins.map(normGstin).filter(Boolean))];
        if (scoped.length === 0) {
          w.push('1 = 0');
        } else {
          params.push(scoped);
          w.push(`${gstinCol} = ANY($${params.length}::text[])`);
        }
      }
      if (opts.gstin) {
        params.push(normGstin(opts.gstin));
        w.push(`${gstinCol} = $${params.length}`);
      }
      if (opts.period) {
        params.push(opts.period);
        w.push(`${periodCol} = $${params.length}`);
      } else if (opts.fy) {
        const m = fyMonths(opts.fy).months;
        params.push(m[0], m[m.length - 1]);
        w.push(`${periodCol} BETWEEN $${params.length - 1} AND $${params.length}`);
      }
      return { params, where: w.length ? `WHERE ${w.join(' AND ')}` : '' };
    };

    const fSap = buildFilter('our_gstin', 'period');
    const sapRes = await c.query(
      `SELECT our_gstin, period, invoice_count, taxable_value, igst, cgst, sgst, utgst, cess, total_gst, invoice_value, version_no, source_type
         FROM sap_book_control_totals
         ${fSap.where ? `${fSap.where} AND is_active = true` : 'WHERE is_active = true'}`,
      fSap.params,
    );

    const fBook = buildFilter('our_gstin', 'period');
    const bookRes = await c.query(
      `SELECT our_gstin, period,
              COUNT(*)::int AS invoice_count,
              ROUND(COALESCE(SUM(book_taxable_value), 0)::numeric, 2)::float8 AS taxable_value,
              ROUND(COALESCE(SUM(book_igst), 0)::numeric, 2)::float8 AS igst,
              ROUND(COALESCE(SUM(book_cgst), 0)::numeric, 2)::float8 AS cgst,
              ROUND(COALESCE(SUM(book_sgst), 0)::numeric, 2)::float8 AS sgst,
              ROUND(COALESCE(SUM(COALESCE(book_utgst, 0)), 0)::numeric, 2)::float8 AS utgst,
              ROUND(COALESCE(SUM(book_cess), 0)::numeric, 2)::float8 AS cess,
              ROUND(COALESCE(SUM(book_invoice_value), 0)::numeric, 2)::float8 AS invoice_value
         FROM purchase_lines
         ${fBook.where}
        GROUP BY our_gstin, period`,
      fBook.params,
    );

    const f2b = buildFilter('our_gstin', 'twob_month');
    const twobRes = await c.query(
      `WITH canon AS (
         SELECT our_gstin,
                MIN(twob_month) AS period,
                ROUND(SUM(COALESCE(taxable_value, 0))::numeric, 2)::float8 AS taxable_value,
                ROUND(SUM(COALESCE(igst, 0))::numeric, 2)::float8 AS igst,
                ROUND(SUM(COALESCE(cgst, 0))::numeric, 2)::float8 AS cgst,
                ROUND(SUM(COALESCE(sgst, 0))::numeric, 2)::float8 AS sgst,
                ROUND(SUM(COALESCE(utgst, 0))::numeric, 2)::float8 AS utgst,
                ROUND(SUM(COALESCE(cess, 0))::numeric, 2)::float8 AS cess,
                ROUND(MAX(COALESCE(invoice_value, 0))::numeric, 2)::float8 AS invoice_value
           FROM gstr2b_lines
           ${f2b.where}
          GROUP BY our_gstin, UPPER(TRIM(supplier_gstin)),
                   UPPER(REGEXP_REPLACE(TRIM(invoice_no), '[^A-Za-z0-9]', '', 'g')),
                   COALESCE(NULLIF(TRIM(document_type), ''), 'Tax Invoice')
       )
       SELECT our_gstin, period,
              COUNT(*)::int AS invoice_count,
              ROUND(COALESCE(SUM(taxable_value), 0)::numeric, 2)::float8 AS taxable_value,
              ROUND(COALESCE(SUM(igst), 0)::numeric, 2)::float8 AS igst,
              ROUND(COALESCE(SUM(cgst), 0)::numeric, 2)::float8 AS cgst,
              ROUND(COALESCE(SUM(sgst), 0)::numeric, 2)::float8 AS sgst,
              ROUND(COALESCE(SUM(utgst), 0)::numeric, 2)::float8 AS utgst,
              ROUND(COALESCE(SUM(cess), 0)::numeric, 2)::float8 AS cess,
              ROUND(COALESCE(SUM(invoice_value), 0)::numeric, 2)::float8 AS invoice_value
         FROM canon
        GROUP BY our_gstin, period`,
      f2b.params,
    );

    const sapMap = new Map<string, { totals: ThreeWayTotals; version: number; sourceType: string }>();
    for (const r of sapRes.rows as any[]) {
      const k = `${normGstin(r.our_gstin)}|${r.period}`;
      sapMap.set(k, {
        version: Number(r.version_no || 1),
        sourceType: String(r.source_type || 'MANUAL'),
        totals: {
          invoiceCount: Number(r.invoice_count || 0),
          taxableValue: r2(Number(r.taxable_value || 0)),
          igst: r2(Number(r.igst || 0)),
          cgst: r2(Number(r.cgst || 0)),
          sgst: r2(Number(r.sgst || 0)),
          utgst: r2(Number(r.utgst || 0)),
          cess: r2(Number(r.cess || 0)),
          totalGst: r2(Number(r.total_gst || 0)),
          invoiceValue: r2(Number(r.invoice_value || 0)),
        },
      });
    }

    const toTotals = (r: any): ThreeWayTotals => {
      const igst = r2(Number(r.igst || 0));
      const cgst = r2(Number(r.cgst || 0));
      const sgst = r2(Number(r.sgst || 0));
      const utgst = r2(Number(r.utgst || 0));
      const cess = r2(Number(r.cess || 0));
      return {
        invoiceCount: Number(r.invoice_count || 0),
        taxableValue: r2(Number(r.taxable_value || 0)),
        igst,
        cgst,
        sgst,
        utgst,
        cess,
        totalGst: r2(igst + cgst + sgst + utgst + cess),
        invoiceValue: r2(Number(r.invoice_value || 0)),
      };
    };

    const bookMap = new Map<string, ThreeWayTotals>();
    for (const r of bookRes.rows as any[]) bookMap.set(`${normGstin(r.our_gstin)}|${r.period}`, toTotals(r));

    const twobMap = new Map<string, ThreeWayTotals>();
    for (const r of twobRes.rows as any[]) twobMap.set(`${normGstin(r.our_gstin)}|${r.period}`, toTotals(r));

    const allKeys = [...new Set([...sapMap.keys(), ...bookMap.keys(), ...twobMap.keys()])].sort();
    const rows: SapComparisonRow[] = allKeys.map((k) => {
      const [ourGstin, period] = k.split('|');
      const sapEntry = sapMap.get(k) || null;
      const books = bookMap.get(k) || zeroTotals();
      const twob = twobMap.get(k) || zeroTotals();
      const sapVsBooks = sapEntry ? diffTotals(sapEntry.totals, books) : null;
      const booksVs2b = diffTotals(books, twob);

      let sapStatus: 'SAP_VERIFIED' | 'SAP_VARIANCE' | 'SAP_MISSING' = 'SAP_MISSING';
      if (sapVsBooks) {
        const ok =
          sapVsBooks.invoiceCount === 0 &&
          Math.abs(sapVsBooks.taxableValue) <= 1 &&
          Math.abs(sapVsBooks.igst) <= 1 &&
          Math.abs(sapVsBooks.cgst) <= 1 &&
          Math.abs(sapVsBooks.sgst) <= 1 &&
          Math.abs(sapVsBooks.utgst) <= 1 &&
          Math.abs(sapVsBooks.cess) <= 1 &&
          Math.abs(sapVsBooks.totalGst) <= 1;
        sapStatus = ok ? 'SAP_VERIFIED' : 'SAP_VARIANCE';
      }

      return {
        ourGstin,
        period,
        label: labelOf(period),
        fy: fyOf(period),
        sapStatus,
        sapVersion: sapEntry ? sapEntry.version : null,
        sapSourceType: sapEntry ? sapEntry.sourceType : null,
        sap: sapEntry ? sapEntry.totals : null,
        books,
        twob,
        sapVsBooks,
        booksVs2b,
      };
    });

    return {
      rows,
      summary: {
        total: rows.length,
        verified: rows.filter((r) => r.sapStatus === 'SAP_VERIFIED').length,
        variance: rows.filter((r) => r.sapStatus === 'SAP_VARIANCE').length,
        missing: rows.filter((r) => r.sapStatus === 'SAP_MISSING').length,
      },
    };
  });
}

export async function listSapControlHistory(opts: {
  gstin?: string | null;
  fy?: string | null;
  period?: string | null;
  allowedGstins?: string[] | null;
}) {
  return withClient(async (c) => {
    const params: unknown[] = [];
    const w: string[] = [];
    if (opts.allowedGstins !== undefined && opts.allowedGstins !== null) {
      const scoped = [...new Set(opts.allowedGstins.map(normGstin).filter(Boolean))];
      if (scoped.length === 0) {
        w.push('1 = 0');
      } else {
        params.push(scoped);
        w.push(`t.our_gstin = ANY($${params.length}::text[])`);
      }
    }
    if (opts.gstin) { params.push(normGstin(opts.gstin)); w.push(`t.our_gstin = $${params.length}`); }
    if (opts.period) { params.push(opts.period); w.push(`t.period = $${params.length}`); }
    else if (opts.fy) { params.push(opts.fy); w.push(`t.financial_year = $${params.length}`); }
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const res = await c.query(
      `SELECT t.*, b.batch_uid, b.file_name, b.uploaded_at
         FROM sap_book_control_totals t
         LEFT JOIN sap_control_upload_batches b ON b.id = t.batch_id
         ${where}
        ORDER BY t.period DESC, t.our_gstin ASC, t.version_no DESC`,
      params,
    );
    return res.rows;
  });
}

export function buildSapControlTemplateWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const sample = [
    {
      'Our GSTIN': '26AALCS9985J1ZC',
      Period: '2026-04',
      'Invoice Count': 125,
      'Taxable Value': 1500000,
      IGST: 180000,
      CGST: 45000,
      SGST: 0,
      UTGST: 45000,
      Cess: 0,
      'Total GST': 270000,
      'Invoice Value': 1770000,
      Remarks: 'SAP B1 Monthly Purchase Summary',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(sample);
  XLSX.utils.book_append_sheet(wb, ws, 'SAP Control Totals');
  return polishWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}
