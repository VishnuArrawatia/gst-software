/**
 * Supplier Follow-up & Ready-to-Send Email / WhatsApp Draft Generator.
 *
 * Strictly drafts-only (NO live SMTP sending): generates invoice-wise
 * discrepancy tables, plain-text (Email/WhatsApp) copy, HTML email body,
 * mailto: link, RFC 5322 .eml draft (with X-Unsent: 1 so Outlook/Thunderbird/
 * Apple Mail opens directly in Compose mode), and single-supplier Excel export.
 */

import { withClient } from './store';
import { r2, normGstin } from '../engine/core';
import { toWorkbookBuffer, type Column, type ReportFilters } from './reports';

export interface SupplierDraftFilters extends ReportFilters {
  fy?: string;
  company?: string;
}

export interface SupplierDraftInvoice {
  source: 'BOOKS' | 'GSTR2B_ONLY';
  lineId: number | null;
  ourGstin: string;
  period: string;
  invoiceNo: string;
  invoiceDate: string;
  docType: string;
  matchStatus: string;
  reason: string;
  actionRequired: string;
  bookTaxable: number;
  bookIgst: number;
  bookCgst: number;
  bookSgst: number;
  bookUtgst: number;
  bookCess: number;
  bookTax: number;
  twobInvoiceNo: string;
  twobInvoiceDate: string;
  twobMonth: string;
  twobTaxable: number;
  twobIgst: number;
  twobCgst: number;
  twobSgst: number;
  twobUtgst: number;
  twobCess: number;
  twobTax: number;
  taxableDiff: number;
  taxDiff: number;
}

export interface SupplierDraftResult {
  supplierGstin: string;
  supplierName: string;
  ourGstin: string;
  companyName: string;
  periodLabel: string;
  toEmail: string;
  summary: {
    totalIssues: number;
    missingIn2bCount: number;
    mismatchCount: number;
    onlyIn2bCount: number;
    bookTaxable: number;
    bookTax: number;
    twobTaxable: number;
    twobTax: number;
    itcAtRisk: number;
  };
  invoices: SupplierDraftInvoice[];
  subject: string;
  plainText: string;
  htmlBody: string;
  mailtoUrl: string;
}

function fmtInr(n: number): string {
  const val = r2(Number(n || 0));
  const abs = Math.abs(val);
  const s = abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return val < 0 ? `-₹${s}` : `₹${s}`;
}

function fmtDateStr(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deriveActionRequired(status: string, taxDiff: number, taxableDiff: number): string {
  const st = (status || '').toLowerCase();
  if (st.includes('missing in 2b') || st === 'books only') {
    return 'Please file/report this invoice in your GSTR-1 / IFF immediately so ITC reflects in our GSTR-2B.';
  }
  if (st.includes('only in 2b') || st.includes('missing in books')) {
    return 'Invoice appears in GSTR-2B but not in our Purchase Register — please share invoice copy / confirm validity.';
  }
  if (st.includes('amount') || st.includes('tax') || Math.abs(taxDiff) > 1 || Math.abs(taxableDiff) > 1) {
    return 'Please verify Taxable Value / GST breakup and amend in GSTR-1 or issue Credit/Debit Note as applicable.';
  }
  if (st.includes('date')) {
    return 'Invoice date differs between Books and GSTR-2B — please verify and confirm/amend.';
  }
  if (st.includes('invoice') || st.includes('probable')) {
    return 'Invoice number format differs — please confirm exact invoice number reported in GSTR-1.';
  }
  return 'Please verify GSTR-1 filing and confirm status.';
}

export async function listPendingSuppliers(filters: SupplierDraftFilters): Promise<Array<{
  supplierGstin: string;
  supplierName: string;
  totalIssues: number;
  missingIn2bCount: number;
  mismatchCount: number;
  bookTax: number;
  twobTax: number;
  itcAtRisk: number;
}>> {
  const w: string[] = [`COALESCE(p.match_status, '') <> 'Matched'`, `COALESCE(p.book_supplier_gstin, '') <> ''`];
  const params: unknown[] = [];
  if (filters.gstin) {
    params.push(filters.gstin);
    w.push(`p.our_gstin = $${params.length}`);
  }
  if (filters.period) {
    params.push(filters.period);
    w.push(`p.period = $${params.length}`);
  } else if (filters.from && filters.to) {
    params.push(filters.from, filters.to);
    w.push(`p.period BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (filters.fy) {
    const y = Number(filters.fy.slice(0, 4));
    if (y >= 2017 && y <= 2099) {
      params.push(`${y}-04`, `${y + 1}-03`);
      w.push(`p.period BETWEEN $${params.length - 1} AND $${params.length}`);
    }
  }
  if (filters.company) {
    params.push(filters.company, filters.company);
    w.push(`p.our_gstin IN (SELECT g.gstin FROM gstins g JOIN companies c ON c.id = g.company_id WHERE c.code = $${params.length - 1} OR c.name = $${params.length})`);
  }

  const sql = `
    SELECT
      UPPER(TRIM(COALESCE(p.recon_supplier_gstin, p.book_supplier_gstin))) AS supplier_gstin,
      COALESCE(MAX(NULLIF(TRIM(p.party_name), '')), 'Unknown Supplier') AS supplier_name,
      COUNT(*)::int AS total_issues,
      COUNT(*) FILTER (WHERE p.match_status = 'Missing in 2B')::int AS missing_count,
      COUNT(*) FILTER (WHERE p.match_status <> 'Missing in 2B' AND p.match_status <> 'Matched')::int AS mismatch_count,
      ROUND(COALESCE(SUM(COALESCE(p.book_igst,0)+COALESCE(p.book_cgst,0)+COALESCE(p.book_sgst,0)+COALESCE(p.book_utgst,0)+COALESCE(p.book_cess,0)),0)::numeric, 2)::float8 AS book_tax,
      ROUND(COALESCE(SUM(COALESCE(p.twob_igst,0)+COALESCE(p.twob_cgst,0)+COALESCE(p.twob_sgst,0)+COALESCE(p.twob_utgst,0)+COALESCE(p.twob_cess,0)),0)::numeric, 2)::float8 AS twob_tax
    FROM purchase_lines p
    WHERE ${w.join(' AND ')}
    GROUP BY 1
    ORDER BY (COALESCE(SUM(COALESCE(p.book_igst,0)+COALESCE(p.book_cgst,0)+COALESCE(p.book_sgst,0)+COALESCE(p.book_utgst,0)+COALESCE(p.book_cess,0)),0)
              - COALESCE(SUM(COALESCE(p.twob_igst,0)+COALESCE(p.twob_cgst,0)+COALESCE(p.twob_sgst,0)+COALESCE(p.twob_utgst,0)+COALESCE(p.twob_cess,0)),0)) DESC,
             COUNT(*) DESC
  `;
  const res = await withClient((c) => c.query(sql, params));
  return res.rows.map((r: any) => ({
    supplierGstin: String(r.supplier_gstin || ''),
    supplierName: String(r.supplier_name || 'Unknown Supplier'),
    totalIssues: Number(r.total_issues || 0),
    missingIn2bCount: Number(r.missing_count || 0),
    mismatchCount: Number(r.mismatch_count || 0),
    bookTax: r2(Number(r.book_tax || 0)),
    twobTax: r2(Number(r.twob_tax || 0)),
    itcAtRisk: r2(Number(r.book_tax || 0) - Number(r.twob_tax || 0)),
  }));
}

export async function buildSupplierDraft(opts: {
  supplierGstin: string;
  filters: SupplierDraftFilters;
  toEmail?: string;
  includeOnlyIn2b?: boolean;
  includeAll?: boolean;
}): Promise<SupplierDraftResult> {
  return withClient(async (c) => {
  const supGstin = normGstin(opts.supplierGstin);
  if (!supGstin) throw new Error('Valid Supplier GSTIN is required');

  const f = opts.filters;
  const w: string[] = [
    `UPPER(TRIM(COALESCE(p.recon_supplier_gstin, p.book_supplier_gstin))) = $1`,
  ];
  const params: unknown[] = [supGstin];
  if (!opts.includeAll) {
    w.push(`COALESCE(p.match_status, '') <> 'Matched'`);
  }
  if (f.gstin) {
    params.push(f.gstin);
    w.push(`p.our_gstin = $${params.length}`);
  }
  if (f.period) {
    params.push(f.period);
    w.push(`p.period = $${params.length}`);
  } else if (f.from && f.to) {
    params.push(f.from, f.to);
    w.push(`p.period BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (f.fy) {
    // FY like 2026-27 -> Apr 2026 to Mar 2027
    const y = Number(f.fy.slice(0, 4));
    if (y >= 2017 && y <= 2099) {
      params.push(`${y}-04`, `${y + 1}-03`);
      w.push(`p.period BETWEEN $${params.length - 1} AND $${params.length}`);
    }
  }

  const pRes = await c.query(
    `SELECT p.id, p.our_gstin, p.period, p.party_name,
            COALESCE(p.recon_invoice_no, p.book_invoice_no) AS inv_no,
            COALESCE(p.recon_invoice_date, p.book_invoice_date) AS inv_date,
            COALESCE(p.book_document_type, 'Invoice') AS doc_type,
            COALESCE(p.match_status, 'Missing in 2B') AS match_status,
            COALESCE(p.mismatch_reason, '') AS match_reason,
            COALESCE(p.book_taxable_value, 0) + COALESCE(p.recon_extra_taxable, 0) AS eff_taxable,
            COALESCE(p.book_igst, 0) + COALESCE(p.recon_extra_igst, 0) AS eff_igst,
            COALESCE(p.book_cgst, 0) + COALESCE(p.recon_extra_cgst, 0) AS eff_cgst,
            COALESCE(p.book_sgst, 0) + COALESCE(p.recon_extra_sgst, 0) AS eff_sgst,
            COALESCE(p.book_utgst, 0) + COALESCE(p.recon_extra_utgst, 0) AS eff_utgst,
            COALESCE(p.book_cess, 0) + COALESCE(p.recon_extra_cess, 0) AS eff_cess,
            COALESCE(p.twob_invoice_no, '') AS twob_inv_no,
            p.twob_invoice_date,
            COALESCE(p.matched_2b_month, '') AS twob_month,
            COALESCE(p.twob_taxable_value, 0) AS twob_taxable,
            COALESCE(p.twob_igst, 0) AS twob_igst,
            COALESCE(p.twob_cgst, 0) AS twob_cgst,
            COALESCE(p.twob_sgst, 0) AS twob_sgst,
            COALESCE(p.twob_utgst, 0) AS twob_utgst,
            COALESCE(p.twob_cess, 0) AS twob_cess
       FROM purchase_lines p
      WHERE ${w.join(' AND ')}
      ORDER BY p.period ASC, p.book_invoice_date ASC NULLS LAST, p.id ASC`,
    params,
  );

  let supplierName = '';
  let ourGstin = f.gstin || '';
  const invoices: SupplierDraftInvoice[] = [];

  for (const r of pRes.rows) {
    if (!supplierName && r.party_name) supplierName = String(r.party_name).trim();
    if (!ourGstin && r.our_gstin) ourGstin = String(r.our_gstin).trim();
    const bookTaxable = r2(Number(r.eff_taxable || 0));
    const bookIgst = r2(Number(r.eff_igst || 0));
    const bookCgst = r2(Number(r.eff_cgst || 0));
    const bookSgst = r2(Number(r.eff_sgst || 0));
    const bookUtgst = r2(Number(r.eff_utgst || 0));
    const bookCess = r2(Number(r.eff_cess || 0));
    const bookTax = r2(bookIgst + bookCgst + bookSgst + bookUtgst + bookCess);

    const twobTaxable = r2(Number(r.twob_taxable || 0));
    const twobIgst = r2(Number(r.twob_igst || 0));
    const twobCgst = r2(Number(r.twob_cgst || 0));
    const twobSgst = r2(Number(r.twob_sgst || 0));
    const twobUtgst = r2(Number(r.twob_utgst || 0));
    const twobCess = r2(Number(r.twob_cess || 0));
    const twobTax = r2(twobIgst + twobCgst + twobSgst + twobUtgst + twobCess);

    const taxableDiff = r2(bookTaxable - twobTaxable);
    const taxDiff = r2(bookTax - twobTax);
    const status = String(r.match_status || 'Missing in 2B');

    invoices.push({
      source: 'BOOKS',
      lineId: Number(r.id),
      ourGstin: String(r.our_gstin || ''),
      period: String(r.period || ''),
      invoiceNo: String(r.inv_no || ''),
      invoiceDate: fmtDateStr(r.inv_date),
      docType: String(r.doc_type || 'Invoice'),
      matchStatus: status,
      reason: String(r.match_reason || status),
      actionRequired: deriveActionRequired(status, taxDiff, taxableDiff),
      bookTaxable,
      bookIgst,
      bookCgst,
      bookSgst,
      bookUtgst,
      bookCess,
      bookTax,
      twobInvoiceNo: String(r.twob_inv_no || ''),
      twobInvoiceDate: fmtDateStr(r.twob_invoice_date),
      twobMonth: String(r.twob_month || ''),
      twobTaxable,
      twobIgst,
      twobCgst,
      twobSgst,
      twobUtgst,
      twobCess,
      twobTax,
      taxableDiff,
      taxDiff,
    });
  }

  // Optionally also include GSTR-2B Only (Not in Books) lines for completeness
  if (opts.includeOnlyIn2b !== false) {
    const w2: string[] = [
      `UPPER(TRIM(t.supplier_gstin)) = $1`,
      `NOT EXISTS (SELECT 1 FROM purchase_lines p WHERE p.matched_2b_key = t.line_key AND p.our_gstin = t.our_gstin)`,
    ];
    const p2: unknown[] = [supGstin];
    if (f.gstin) {
      p2.push(f.gstin);
      w2.push(`t.our_gstin = $${p2.length}`);
    }
    if (f.period) {
      p2.push(f.period);
      w2.push(`t.twob_month = $${p2.length}`);
    } else if (f.fy) {
      const y = Number(f.fy.slice(0, 4));
      if (y >= 2017 && y <= 2099) {
        p2.push(`${y}-04`, `${y + 1}-03`);
        w2.push(`t.twob_month BETWEEN $${p2.length - 1} AND $${p2.length}`);
      }
    }
    const tRes = await c.query(
      `SELECT t.our_gstin, t.twob_month, t.supplier_name, t.invoice_no, t.invoice_date,
              COALESCE(t.document_type, 'Invoice') AS doc_type,
              COALESCE(t.taxable_value, 0) AS taxable_value,
              COALESCE(t.igst, 0) AS igst, COALESCE(t.cgst, 0) AS cgst,
              COALESCE(t.sgst, 0) AS sgst, COALESCE(t.utgst, 0) AS utgst,
              COALESCE(t.cess, 0) AS cess
         FROM gstr2b_lines t
        WHERE ${w2.join(' AND ')}
        ORDER BY t.twob_month ASC, t.invoice_date ASC NULLS LAST`,
      p2,
    );
    for (const r of tRes.rows) {
      if (!supplierName && r.supplier_name) supplierName = String(r.supplier_name).trim();
      if (!ourGstin && r.our_gstin) ourGstin = String(r.our_gstin).trim();
      const twobTaxable = r2(Number(r.taxable_value || 0));
      const twobIgst = r2(Number(r.igst || 0));
      const twobCgst = r2(Number(r.cgst || 0));
      const twobSgst = r2(Number(r.sgst || 0));
      const twobUtgst = r2(Number(r.utgst || 0));
      const twobCess = r2(Number(r.cess || 0));
      const twobTax = r2(twobIgst + twobCgst + twobSgst + twobUtgst + twobCess);
      invoices.push({
        source: 'GSTR2B_ONLY',
        lineId: null,
        ourGstin: String(r.our_gstin || ''),
        period: String(r.twob_month || ''),
        invoiceNo: String(r.invoice_no || ''),
        invoiceDate: fmtDateStr(r.invoice_date),
        docType: String(r.doc_type || 'Invoice'),
        matchStatus: 'Only in GSTR-2B',
        reason: 'Appears in GSTR-2B, not recorded in our Books',
        actionRequired: deriveActionRequired('Only in GSTR-2B', -twobTax, -twobTaxable),
        bookTaxable: 0,
        bookIgst: 0,
        bookCgst: 0,
        bookSgst: 0,
        bookUtgst: 0,
        bookCess: 0,
        bookTax: 0,
        twobInvoiceNo: String(r.invoice_no || ''),
        twobInvoiceDate: fmtDateStr(r.invoice_date),
        twobMonth: String(r.twob_month || ''),
        twobTaxable,
        twobIgst,
        twobCgst,
        twobSgst,
        twobUtgst,
        twobCess,
        twobTax,
        taxableDiff: r2(-twobTaxable),
        taxDiff: r2(-twobTax),
      });
    }
  }

  // Resolve our company name for professional signature
  let companyName = 'GST Accounts Team';
  if (ourGstin) {
    const cRes = await c.query(
      `SELECT c.name FROM gstins g JOIN companies c ON c.id = g.company_id WHERE g.gstin = $1 LIMIT 1`,
      [ourGstin],
    ).catch(() => ({ rows: [] as any[] }));
    if (cRes.rows[0]?.name) companyName = String(cRes.rows[0].name);
  }

  const periodLabel = f.period || (f.fy ? `FY ${f.fy}` : 'All Periods');
  const displaySupplier = supplierName || supGstin;
  const toEmail = String(opts.toEmail || '').trim();

  const missingIn2bCount = invoices.filter((i) => i.matchStatus === 'Missing in 2B').length;
  const onlyIn2bCount = invoices.filter((i) => i.source === 'GSTR2B_ONLY').length;
  const mismatchCount = invoices.filter((i) => i.source === 'BOOKS' && i.matchStatus !== 'Missing in 2B' && i.matchStatus !== 'Matched').length;

  const bookTaxable = r2(invoices.reduce((s, i) => s + i.bookTaxable, 0));
  const bookTax = r2(invoices.reduce((s, i) => s + i.bookTax, 0));
  const twobTaxable = r2(invoices.reduce((s, i) => s + i.twobTaxable, 0));
  const twobTax = r2(invoices.reduce((s, i) => s + i.twobTax, 0));
  const itcAtRisk = r2(invoices.filter((i) => i.source === 'BOOKS').reduce((s, i) => s + (i.bookTax - i.twobTax), 0));

  const subject = `GST GSTR-2B Reconciliation Discrepancy — ${displaySupplier} (${supGstin}) | ${periodLabel} | ITC Impact: ${fmtInr(itcAtRisk)}`;

  const lines: string[] = [
    `Dear ${displaySupplier} Accounts / GST Team,`,
    '',
    `During our Purchase Register vs GSTR-2B reconciliation for ${periodLabel}${ourGstin ? ` (Our GSTIN: ${ourGstin})` : ''}, we noticed ${invoices.length} invoice discrepancy(ies) requiring your urgent attention:`,
    '',
    `Summary:`,
    `• Supplier GSTIN: ${supGstin}`,
    `• Missing in GSTR-2B (Not filed / delayed in GSTR-1): ${missingIn2bCount}`,
    `• Value / Tax / Date Mismatch: ${mismatchCount}`,
    ...(onlyIn2bCount ? [`• Appearing in GSTR-2B Only (Not in our Books): ${onlyIn2bCount}`] : []),
    `• Total Books Tax: ${fmtInr(bookTax)} | Total GSTR-2B Tax: ${fmtInr(twobTax)} | ITC at Risk: ${fmtInr(itcAtRisk)}`,
    '',
    `Invoice-wise Details:`,
  ];

  invoices.forEach((inv, idx) => {
    lines.push(
      `${idx + 1}. Inv No: ${inv.invoiceNo} | Date: ${inv.invoiceDate || '-'} | Month: ${inv.period} | Status: ${inv.matchStatus}`,
      `   Books: Taxable ${fmtInr(inv.bookTaxable)}, Tax ${fmtInr(inv.bookTax)} | GSTR-2B: Taxable ${fmtInr(inv.twobTaxable)}, Tax ${fmtInr(inv.twobTax)} | Tax Diff: ${fmtInr(inv.taxDiff)}`,
      `   Action: ${inv.actionRequired}`,
    );
  });

  lines.push(
    '',
    'Request you to kindly verify the above invoices and file/amend the same in your upcoming GSTR-1 / IFF at the earliest so that our Input Tax Credit (Sec 16(2)(aa) CGST Act) is not impacted.',
    'Please share the filing acknowledgement / revised invoice details upon completion.',
    '',
    'Regards,',
    `GST Compliance & Accounts Team`,
    companyName,
    ...(ourGstin ? [`GSTIN: ${ourGstin}`] : []),
  );

  const plainText = lines.join('\n');

  const tableRowsHtml = invoices.map((inv, idx) => `
    <tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'}">
      <td style="padding:7px 9px;border:1px solid #e2e8f0">${idx + 1}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;font-family:monospace;font-weight:600">${escHtml(inv.invoiceNo)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;white-space:nowrap">${escHtml(inv.invoiceDate || '-')}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;white-space:nowrap">${escHtml(inv.period)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;font-weight:600;color:${inv.matchStatus === 'Missing in 2B' ? '#b45309' : '#be123c'}">${escHtml(inv.matchStatus)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;text-align:right">${escHtml(fmtInr(inv.bookTaxable))}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;text-align:right">${escHtml(fmtInr(inv.bookTax))}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;text-align:right">${escHtml(fmtInr(inv.twobTaxable))}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;text-align:right">${escHtml(fmtInr(inv.twobTax))}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;text-align:right;font-weight:700;color:#be123c">${escHtml(fmtInr(inv.taxDiff))}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;font-size:12px">${escHtml(inv.actionRequired)}</td>
    </tr>`).join('');

  const htmlBody = `<!doctype html>
<html>
<body style="font-family:Segoe UI,Inter,Arial,sans-serif;color:#0f172a;font-size:13.5px;line-height:1.55;margin:0;padding:18px;background:#f8fafc">
  <div style="max-width:940px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:22px">
    <h2 style="margin:0 0 8px;color:#1e1b4b;font-size:18px">GSTR-2B Reconciliation Discrepancy Notice</h2>
    <p style="margin:0 0 14px;color:#475569">Dear <b>${escHtml(displaySupplier)}</b> Accounts / GST Team,</p>
    <p style="margin:0 0 14px">During our Purchase Register vs GSTR-2B reconciliation for <b>${escHtml(periodLabel)}</b>${ourGstin ? ` (Our GSTIN: <b>${escHtml(ourGstin)}</b>)` : ''}, we observed <b>${invoices.length}</b> invoice discrepancy(ies) for Supplier GSTIN <b>${escHtml(supGstin)}</b>:</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:12.5px">
      <thead>
        <tr style="background:#f1f5f9;color:#334155;text-align:left">
          <th style="padding:8px 9px;border:1px solid #cbd5e1">#</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1">Invoice No</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1">Date</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1">Period</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1">Status</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">Books Taxable</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">Books Tax</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">2B Taxable</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">2B Tax</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">Tax Diff</th>
          <th style="padding:8px 9px;border:1px solid #cbd5e1">Action Required</th>
        </tr>
      </thead>
      <tbody>${tableRowsHtml}</tbody>
      <tfoot>
        <tr style="background:#eef2ff;font-weight:700">
          <td colspan="5" style="padding:8px 9px;border:1px solid #cbd5e1">Total (${invoices.length} invoices)</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">${escHtml(fmtInr(bookTaxable))}</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">${escHtml(fmtInr(bookTax))}</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">${escHtml(fmtInr(twobTaxable))}</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right">${escHtml(fmtInr(twobTax))}</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1;text-align:right;color:#be123c">${escHtml(fmtInr(itcAtRisk))}</td>
          <td style="padding:8px 9px;border:1px solid #cbd5e1">ITC at Risk</td>
        </tr>
      </tfoot>
    </table>
    <p style="margin:0 0 10px">Request you to kindly verify the above invoices and file/amend the same in your upcoming <b>GSTR-1 / IFF</b> at the earliest so that our Input Tax Credit (Sec 16(2)(aa) CGST Act) is not impacted.</p>
    <p style="margin:14px 0 0;color:#334155">Regards,<br/><b>GST Compliance &amp; Accounts Team</b><br/>${escHtml(companyName)}${ourGstin ? `<br/>GSTIN: ${escHtml(ourGstin)}` : ''}</p>
  </div>
</body>
</html>`;

  const mailtoBody = plainText.length > 1700
    ? plainText.slice(0, 1650) + '\n\n[... List truncated for mailto link. Please attach the downloaded Supplier Excel or open the .eml draft for the complete table.]'
    : plainText;
  const mailtoUrl = `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailtoBody)}`;

  return {
    supplierGstin: supGstin,
    supplierName: displaySupplier,
    ourGstin,
    companyName,
    periodLabel,
    toEmail,
    summary: {
      totalIssues: invoices.length,
      missingIn2bCount,
      mismatchCount,
      onlyIn2bCount,
      bookTaxable,
      bookTax,
      twobTaxable,
      twobTax,
      itcAtRisk,
    },
    invoices,
    subject,
    plainText,
    htmlBody,
    mailtoUrl,
  };
  });
}

/**
 * Generates an RFC 5322 MIME .eml draft (multipart/alternative: text/plain + text/html)
 * with X-Unsent: 1 so Outlook / Thunderbird / Apple Mail opens it directly in Compose mode.
 */
export function buildSupplierEml(draft: SupplierDraftResult, customSubject?: string, customPlainText?: string): string {
  const boundary = `----=_GST_ERP_DRAFT_${Date.now().toString(36)}`;
  const subj = (customSubject || draft.subject).replace(/[\r\n]+/g, ' ').trim();
  const toHeader = draft.toEmail ? draft.toEmail.replace(/[\r\n]+/g, '').trim() : '';
  const plain = (customPlainText || draft.plainText).replace(/\r?\n/g, '\r\n');
  const html = draft.htmlBody.replace(/\r?\n/g, '\r\n');

  const encodeBase64Lines = (str: string) => {
    const b64 = Buffer.from(str, 'utf8').toString('base64');
    return b64.match(/.{1,76}/g)?.join('\r\n') || '';
  };

  const subjEncoded = `=?UTF-8?B?${Buffer.from(subj, 'utf8').toString('base64')}?=`;

  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `To: ${toHeader}`,
    `Subject: ${subjEncoded}`,
    `X-Unsent: 1`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Lines(plain),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Lines(html),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const DRAFT_XLSX_COLS: Column[] = [
  { h: 'Source', k: 'source', t: 'text', w: 13 },
  { h: 'Our GSTIN', k: 'ourGstin', t: 'gstin', w: 19 },
  { h: 'Period', k: 'period', t: 'period', w: 10 },
  { h: 'Invoice No', k: 'invoiceNo', t: 'text', w: 20 },
  { h: 'Invoice Date', k: 'invoiceDate', t: 'date', w: 13 },
  { h: 'Doc Type', k: 'docType', t: 'text', w: 12 },
  { h: 'Status', k: 'matchStatus', t: 'text', w: 18 },
  { h: 'Books Taxable', k: 'bookTaxable', t: 'money', w: 14 },
  { h: 'Books IGST', k: 'bookIgst', t: 'money', w: 12 },
  { h: 'Books CGST', k: 'bookCgst', t: 'money', w: 12 },
  { h: 'Books SGST', k: 'bookSgst', t: 'money', w: 12 },
  { h: 'Books UTGST', k: 'bookUtgst', t: 'money', w: 12 },
  { h: 'Books Cess', k: 'bookCess', t: 'money', w: 11 },
  { h: 'Books Total Tax', k: 'bookTax', t: 'money', w: 15 },
  { h: '2B Invoice No', k: 'twobInvoiceNo', t: 'text', w: 20 },
  { h: '2B Month', k: 'twobMonth', t: 'period', w: 10 },
  { h: '2B Taxable', k: 'twobTaxable', t: 'money', w: 14 },
  { h: '2B Total Tax', k: 'twobTax', t: 'money', w: 14 },
  { h: 'Tax Diff (Books - 2B)', k: 'taxDiff', t: 'money', w: 16 },
  { h: 'Action Required', k: 'actionRequired', t: 'text', w: 46 },
];

export function buildSupplierDraftWorkbook(draft: SupplierDraftResult): Buffer {
  return toWorkbookBuffer(
    `Supplier Follow-up — ${draft.supplierName}`,
    DRAFT_XLSX_COLS,
    draft.invoices as unknown as Record<string, unknown>[],
    [
      `Supplier: ${draft.supplierName} (${draft.supplierGstin})`,
      `Period: ${draft.periodLabel}`,
      `Total Discrepancies: ${draft.summary.totalIssues}`,
      `ITC at Risk: ${fmtInr(draft.summary.itcAtRisk)}`,
    ],
  );
}
