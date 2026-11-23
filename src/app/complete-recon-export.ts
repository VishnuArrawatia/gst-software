/**
 * GST ERP — Complete GSTR-2B vs Purchase Register Consolidated Excel Export (Part 4).
 *
 * Produces ONE consolidated worksheet named `Complete Reconciliation` directly from the
 * full PostgreSQL result set (ZERO frontend pagination truncation), containing:
 *   - All Tax Invoices, Debit Notes, and Credit Notes in ONE sheet (zero separate tabs)
 *   - All reconciliation statuses: Matched, Subsequent Month, Cross-FY, After Correction,
 *     Tax/Taxable Difference, Books Only, GSTR-2B Only, Mismatches, Duplicates, Possible Duplicates, Pending
 *   - All Group A–G columns (Original + Corrected Books values, GSTR-2B values, Differences, ITC Review)
 *   - AutoFilter, Freeze Panes on the single header row, true numeric (#,##0.00) & date formats
 *   - Zero merged cells in the data range, zero blank separator rows
 *   - Export audit history (`recon_export_history`) without modifying any source/recon data
 */

import XLSX from 'xlsx';
import {
  fyOf,
  isoDate,
  labelOf,
  normDocType,
  normGstin,
  normInvoice,
  periodFromAny,
  r2,
  type DetailedReconStatus,
} from '../engine/core';
import { expandSelectedPeriods } from '../engine/gstr2b-excel';
import { withClient } from './store';
import { polishWorkbook } from './xlsx-format';

export type CompleteExportPeriodMode = 'single' | 'range' | 'multi' | 'fy' | 'all';

export interface CompleteExportFilters {
  periodMode?: CompleteExportPeriodMode;
  period?: string;
  from?: string;
  to?: string;
  periods?: string[];
  fy?: string;
  gstin?: string;
  gstins?: string[];
  status?: string;
  detailedStatus?: string;
  docType?: string;
  supplier?: string;
  q?: string;
  allowedGstins?: string[] | null;
}

export interface CompleteReconExportRow {
  // Group A — Company and Period Information
  company_name: string;
  our_gstin: string;
  books_fy: string;
  books_month: string;
  books_doc_date: string;
  books_entry_date: string;
  actual_2b_month: string;
  actual_2b_fy: string;

  // Group B — Document Identity
  doc_category: string;
  document_type: string;
  books_doc_no: string;
  recon_books_doc_no: string;
  twob_doc_no: string;
  books_supplier_gstin: string;
  recon_supplier_gstin: string;
  twob_supplier_gstin: string;
  supplier_name: string;
  matching_key: string;

  // Group C — Purchase Register / Books Values (blank for GSTR-2B Only)
  books_taxable: number | null;
  books_igst: number | null;
  books_cgst: number | null;
  books_sgst: number | null;
  books_cess: number | null;
  books_total_tax: number | null;

  // Group D — GSTR-2B Values (blank for Books Only)
  twob_taxable: number | null;
  twob_igst: number | null;
  twob_cgst: number | null;
  twob_sgst: number | null;
  twob_cess: number | null;
  twob_total_tax: number | null;

  // Group E — Difference Analysis
  taxable_diff: number | null;
  igst_diff: number | null;
  cgst_diff: number | null;
  sgst_diff: number | null;
  cess_diff: number | null;
  total_tax_diff: number | null;
  doc_date_diff_days: number | null;
  doc_no_diff: string;

  // Group F — Reconciliation Result
  reconciliation_status: string;
  summary_status: string;
  match_type: string;
  original_books_month: string;
  actual_2b_month_result: string;
  subsequent_month_match: string;
  cross_fy_match: string;
  matched_after_correction: string;
  correction_remarks: string;
  pending_reason: string;
  duplicate_reference: string;

  // Group G — ITC and Review Information
  itc_decision: string;
  itc_claim_month: string;
  itc_claim_fy: string;
  manual_review_status: string;
  user_remarks: string;
}

export interface CompleteReconDataset {
  rows: CompleteReconExportRow[];
  resolvedPeriods: string[];
  resolvedGstins: string[];
  periodLabel: string;
  companyLabel: string;
  filterSummary: string;
  summary: {
    totalRecords: number;
    byDocType: Record<string, number>;
    byStatus: Record<string, number>;
    booksTaxable: number;
    booksTotalTax: number;
    twobTaxable: number;
    twobTotalTax: number;
    taxableDiff: number;
    taxDiff: number;
  };
}

function expandFyMonths(fy: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || '').trim());
  if (!m) return [];
  const y1 = Number(m[1]);
  const y2 = y1 + 1;
  return [
    `${y1}-04`, `${y1}-05`, `${y1}-06`, `${y1}-07`, `${y1}-08`, `${y1}-09`,
    `${y1}-10`, `${y1}-11`, `${y1}-12`, `${y2}-01`, `${y2}-02`, `${y2}-03`,
  ];
}

function daysGapSigned(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  const mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!ma || !mb) return null;
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((ta - tb) / 86400000);
}

function deriveDetailedStatus(r: any): DetailedReconStatus {
  if (r.detailed_match_status) return r.detailed_match_status as DetailedReconStatus;
  const st = String(r.match_status || '');
  const booksPeriod = String(r.period || '').slice(0, 7);
  const twobMonth = String(r.matched_2b_month || '').slice(0, 7);
  const crossFy = Boolean(booksPeriod && twobMonth && fyOf(booksPeriod) !== fyOf(twobMonth));
  const subMonth = Boolean(booksPeriod && twobMonth && booksPeriod !== twobMonth);

  if (st === 'Duplicate') return 'DUPLICATE';
  if (st === 'ITC Blocked') return 'PENDING MANUAL REVIEW';
  if (st === 'Missing in 2B') {
    if (String(r.suggested_action || '').includes('Probable 2B match')) return 'DOCUMENT NUMBER MISMATCH';
    return 'BOOKS ONLY';
  }
  if (st === 'Amount Mismatch') {
    const tDiff = Math.abs(Number(r.taxable_difference ?? 0));
    if (/date mismatch/i.test(String(r.mismatch_reason || ''))) return 'DOCUMENT DATE MISMATCH';
    if (tDiff > 1) return 'MATCHED WITH TAXABLE DIFFERENCE';
    return 'MATCHED WITH TAX DIFFERENCE';
  }
  if (st === 'Matched') {
    if (r.recon_edited) return 'MATCHED AFTER BOOKS CORRECTION';
    if (crossFy) return 'MATCHED IN SUBSEQUENT FINANCIAL YEAR';
    if (subMonth) return 'MATCHED IN SUBSEQUENT MONTH';
    return 'MATCHED IN SAME MONTH';
  }
  return 'PENDING MANUAL REVIEW';
}

export async function resolveExportScope(f: CompleteExportFilters): Promise<{
  periodMode: CompleteExportPeriodMode;
  resolvedPeriods: string[];
  resolvedGstins: string[];
  periodLabel: string;
}> {
  const periodMode: CompleteExportPeriodMode = f.periodMode ?? (
    f.periods?.length ? 'multi' : f.from || f.to ? 'range' : f.fy ? 'fy' : f.period ? 'single' : 'all'
  );

  let resolvedPeriods: string[] = [];
  if (periodMode === 'fy' && f.fy) {
    resolvedPeriods = expandFyMonths(f.fy);
  } else if (periodMode === 'single' || periodMode === 'range' || periodMode === 'multi') {
    resolvedPeriods = expandSelectedPeriods({
      periodMode,
      period: f.period,
      from: f.from,
      to: f.to,
      periods: f.periods,
    });
  }

  let resolvedGstins: string[] = [];
  if (f.gstins && f.gstins.length) {
    resolvedGstins = [...new Set(f.gstins.map(normGstin).filter(Boolean))];
  } else if (f.gstin && f.gstin.toUpperCase() !== 'ALL') {
    resolvedGstins = [normGstin(f.gstin)];
  }
  if (f.allowedGstins !== undefined && f.allowedGstins !== null) {
    const allow = new Set(f.allowedGstins.map(normGstin));
    resolvedGstins = resolvedGstins.length
      ? resolvedGstins.filter((g) => allow.has(g))
      : [...allow];
  }

  const periodLabel =
    periodMode === 'all'
      ? 'All Available Periods'
      : periodMode === 'fy'
        ? `Financial Year ${f.fy || ''}`
        : resolvedPeriods.length
          ? resolvedPeriods.map((p) => `${labelOf(p)} (${p})`).join(', ')
          : 'All Periods';

  return { periodMode, resolvedPeriods, resolvedGstins, periodLabel };
}

/**
 * Query the FULL Books + GSTR-2B reconciliation dataset without any pagination cap.
 * Avoids double-counting unbooked 2B copies across repeated uploads by picking latest
 * `(id)` per canonical unbooked tuple `(our_gstin, supplier_gstin, normInv, docType, month)`
 * and excluding tuples/keys already claimed in `purchase_lines`.
 */
export async function queryCompleteReconDataset(
  filters: CompleteExportFilters,
): Promise<CompleteReconDataset> {
  const { resolvedPeriods, resolvedGstins, periodLabel } = await resolveExportScope(filters);

  return withClient(async (c) => {
    const pWhere: string[] = [];
    const pParams: unknown[] = [];

    if (resolvedGstins.length) {
      pParams.push(resolvedGstins);
      pWhere.push(`p.our_gstin = ANY($${pParams.length}::text[])`);
    } else if (filters.allowedGstins && filters.allowedGstins.length === 0) {
      pWhere.push('FALSE');
    }
    if (resolvedPeriods.length) {
      pParams.push(resolvedPeriods);
      pWhere.push(`p.period = ANY($${pParams.length}::text[])`);
    }
    if (filters.supplier) {
      pParams.push(normGstin(filters.supplier));
      pWhere.push(`(p.book_supplier_gstin = $${pParams.length} OR p.recon_supplier_gstin = $${pParams.length})`);
    }
    if (filters.q) {
      pParams.push(`%${filters.q.toLowerCase()}%`);
      pWhere.push(
        `(LOWER(COALESCE(p.party_name,'')) LIKE $${pParams.length}
          OR LOWER(p.book_invoice_no) LIKE $${pParams.length}
          OR LOWER(p.recon_invoice_no) LIKE $${pParams.length}
          OR LOWER(COALESCE(p.twob_invoice_no,'')) LIKE $${pParams.length}
          OR LOWER(p.book_supplier_gstin) LIKE $${pParams.length})`,
      );
    }

    const pSql = `
      SELECT p.*,
             COALESCE(comp.name, g.legal_name, g.trade_name, p.our_gstin) AS company_name,
             (SELECT string_agg(rc.field_name || ': ' || rc.old_value || ' -> ' || rc.new_value ||
                                CASE WHEN rc.reason IS NOT NULL AND rc.reason <> '' THEN ' (' || rc.reason || ')' ELSE '' END,
                                '; ' ORDER BY rc.changed_at)
                FROM recon_corrections rc
               WHERE rc.line_id = p.id
                 AND rc.field_name IN (
                   'recon_supplier_gstin','recon_invoice_no','recon_invoice_date','our_gstin',
                   'recon_extra_charges_type','recon_extra_taxable','recon_extra_igst',
                   'recon_extra_cgst','recon_extra_sgst','recon_extra_cess'
                 )
             ) AS corr_audit_summary,
             COALESCE(g2.doc_category,
               CASE WHEN p.book_document_type = 'Credit Note' THEN 'CDNR'
                    WHEN p.book_document_type = 'Debit Note' THEN 'CDNR'
                    ELSE 'B2B' END
             ) AS matched_doc_category
        FROM purchase_lines p
        LEFT JOIN companies comp ON comp.id = p.company_id
        LEFT JOIN gstins g ON g.gstin_number = p.our_gstin
        LEFT JOIN gstr2b_lines g2 ON g2.line_key = p.matched_2b_key
       ${pWhere.length ? 'WHERE ' + pWhere.join(' AND ') : ''}
       ORDER BY p.our_gstin, p.period, p.book_supplier_gstin, p.book_invoice_no, p.id`;

    const pRes = await c.query(pSql, pParams);

    // Fetch claimed 2B line_keys AND claimed canonical tuples across entire purchase_lines
    // for the active GSTIN scope so no already-matched 2B bill ever reappears as "GSTR-2B ONLY".
    const claimParams: unknown[] = [];
    let claimWhere = 'WHERE matched_2b_key IS NOT NULL';
    if (resolvedGstins.length) {
      claimParams.push(resolvedGstins);
      claimWhere += ` AND our_gstin = ANY($${claimParams.length}::text[])`;
    }
    const claimRes = await c.query(
      `SELECT our_gstin, matched_2b_key, matched_2b_month,
              COALESCE(twob_supplier_gstin, recon_supplier_gstin) AS s_gstin,
              COALESCE(twob_invoice_no, recon_invoice_no) AS inv_no,
              book_document_type
         FROM purchase_lines ${claimWhere}`,
      claimParams,
    );
    const claimedKeys = new Set<string>();
    const claimedTuples = new Set<string>();
    for (const cr of claimRes.rows) {
      if (cr.matched_2b_key) claimedKeys.add(String(cr.matched_2b_key));
      const tup = [
        normGstin(cr.our_gstin),
        normGstin(cr.s_gstin),
        normInvoice(cr.inv_no),
        normDocType(cr.book_document_type || 'Tax Invoice'),
        String(cr.matched_2b_month || '').slice(0, 7),
      ].join('|');
      claimedTuples.add(tup);
    }

    // Fetch unbooked GSTR-2B lines within scope
    const tWhere: string[] = [];
    const tParams: unknown[] = [];
    if (resolvedGstins.length) {
      tParams.push(resolvedGstins);
      tWhere.push(`gl.our_gstin = ANY($${tParams.length}::text[])`);
    } else if (filters.allowedGstins && filters.allowedGstins.length === 0) {
      tWhere.push('FALSE');
    }
    if (resolvedPeriods.length) {
      tParams.push(resolvedPeriods);
      tWhere.push(`COALESCE(NULLIF(gl.portal_fp,''), gl.twob_month) = ANY($${tParams.length}::text[])`);
    }
    if (filters.supplier) {
      tParams.push(normGstin(filters.supplier));
      tWhere.push(`gl.supplier_gstin = $${tParams.length}`);
    }
    if (filters.q) {
      tParams.push(`%${filters.q.toLowerCase()}%`);
      tWhere.push(
        `(LOWER(COALESCE(gl.supplier_name,'')) LIKE $${tParams.length}
          OR LOWER(gl.invoice_no) LIKE $${tParams.length}
          OR LOWER(gl.supplier_gstin) LIKE $${tParams.length})`,
      );
    }

    const tSql = `
      SELECT gl.*,
             COALESCE(comp.name, g.legal_name, g.trade_name, gl.our_gstin) AS company_name
        FROM gstr2b_lines gl
        LEFT JOIN gstins g ON g.gstin_number = gl.our_gstin
        LEFT JOIN companies comp ON comp.id = g.company_id
       ${tWhere.length ? 'WHERE ' + tWhere.join(' AND ') : ''}
       ORDER BY gl.our_gstin, COALESCE(NULLIF(gl.portal_fp,''), gl.twob_month), gl.id`;

    const tRes = await c.query(tSql, tParams);

    const exportRows: CompleteReconExportRow[] = [];
    const companies = new Set<string>();
    const gstinSet = new Set<string>();

    // Map Books rows
    for (const r of pRes.rows) {
      const compName = String(r.company_name || r.our_gstin);
      const gstin = normGstin(r.our_gstin);
      companies.add(compName);
      gstinSet.add(gstin);

      const docType = normDocType(r.book_document_type || 'Tax Invoice');
      const detailedStatus = deriveDetailedStatus(r);
      const summaryStatus = String(r.match_status || 'Pending Review');
      const has2b = Boolean(r.matched_2b_key);

      const bTaxable = r2(r.book_taxable_value);
      const bIgst = r2(r.book_igst);
      const bCgst = r2(r.book_cgst);
      const bSgst = r2(r.book_sgst);
      const bCess = r2(r.book_cess);
      const bTotalTax = r2(bIgst + bCgst + bSgst + bCess);

      const tTaxable = has2b && r.twob_taxable_value !== null ? r2(r.twob_taxable_value) : null;
      const tIgst = has2b && r.twob_igst !== null ? r2(r.twob_igst) : null;
      const tCgst = has2b && r.twob_cgst !== null ? r2(r.twob_cgst) : null;
      const tSgst = has2b && r.twob_sgst !== null ? r2(r.twob_sgst) : null;
      const tCess = has2b && r.twob_cess !== null ? r2(r.twob_cess) : null;
      const tTotalTax = has2b ? r2((tIgst ?? 0) + (tCgst ?? 0) + (tSgst ?? 0) + (tCess ?? 0)) : null;

      const bDate = r.book_invoice_date ? isoDate(r.book_invoice_date) : '';
      const rDate = r.recon_invoice_date ? isoDate(r.recon_invoice_date) : bDate;
      const tDate = has2b && r.twob_invoice_date ? isoDate(r.twob_invoice_date) : '';
      const entryDate = r.book_entry_date ? isoDate(r.book_entry_date) : r.imported_at ? isoDate(r.imported_at) : '';
      const booksPeriod = String(r.period || '').slice(0, 7);
      const twobMonth = has2b ? String(r.matched_2b_month || '').slice(0, 7) : '';

      const subMatch = Boolean(has2b && twobMonth && booksPeriod && twobMonth !== booksPeriod);
      const crossFy = Boolean(has2b && twobMonth && booksPeriod && fyOf(twobMonth) !== fyOf(booksPeriod));
      const edited = Boolean(r.recon_edited);
      const claimMonth = String(r.itc_decision_month || '').slice(0, 7);

      const booksNo = String(r.book_invoice_no || '').trim();
      const reconNo = String(r.recon_invoice_no || booksNo).trim();
      const twobNo = has2b ? String(r.twob_invoice_no || '').trim() : '';

      const row: CompleteReconExportRow = {
        company_name: compName,
        our_gstin: gstin,
        books_fy: String(r.financial_year || fyOf(booksPeriod)),
        books_month: booksPeriod,
        books_doc_date: bDate,
        books_entry_date: entryDate,
        actual_2b_month: twobMonth,
        actual_2b_fy: twobMonth ? fyOf(twobMonth) : '',

        doc_category: String(r.matched_doc_category || (docType === 'Tax Invoice' ? 'B2B' : 'CDNR')),
        document_type: docType,
        books_doc_no: booksNo,
        recon_books_doc_no: reconNo,
        twob_doc_no: twobNo,
        books_supplier_gstin: normGstin(r.book_supplier_gstin),
        recon_supplier_gstin: normGstin(r.recon_supplier_gstin || r.book_supplier_gstin),
        twob_supplier_gstin: has2b ? normGstin(r.twob_supplier_gstin) : '',
        supplier_name: String(r.party_name || ''),
        matching_key: r.matched_2b_key ? String(r.matched_2b_key) : `BOOK|${r.line_key}`,

        books_taxable: bTaxable,
        books_igst: bIgst,
        books_cgst: bCgst,
        books_sgst: bSgst,
        books_cess: bCess,
        books_total_tax: bTotalTax,

        twob_taxable: tTaxable,
        twob_igst: tIgst,
        twob_cgst: tCgst,
        twob_sgst: tSgst,
        twob_cess: tCess,
        twob_total_tax: tTotalTax,

        taxable_diff: has2b && tTaxable !== null ? r2(tTaxable - bTaxable) : null,
        igst_diff: has2b && tIgst !== null ? r2(tIgst - bIgst) : null,
        cgst_diff: has2b && tCgst !== null ? r2(tCgst - bCgst) : null,
        sgst_diff: has2b && tSgst !== null ? r2(tSgst - bSgst) : null,
        cess_diff: has2b && tCess !== null ? r2(tCess - bCess) : null,
        total_tax_diff: has2b && tTotalTax !== null ? r2(tTotalTax - bTotalTax) : null,
        doc_date_diff_days: has2b ? daysGapSigned(rDate, tDate) : null,
        doc_no_diff: has2b && normInvoice(reconNo) !== normInvoice(twobNo) ? `${reconNo} vs ${twobNo}` : '',

        reconciliation_status: detailedStatus,
        summary_status: summaryStatus,
        match_type: has2b
          ? edited
            ? 'Matched After Books Correction'
            : crossFy
              ? 'Cross Financial Year Match'
              : subMatch
                ? 'Subsequent Month Match'
                : 'Same Month Match'
          : summaryStatus === 'Duplicate'
            ? 'Duplicate Check'
            : 'Unmatched Books',
        original_books_month: booksPeriod,
        actual_2b_month_result: twobMonth,
        subsequent_month_match: has2b ? (subMatch ? 'Yes' : 'No') : '',
        cross_fy_match: has2b ? (crossFy ? 'Yes' : 'No') : '',
        matched_after_correction: has2b ? (edited ? 'Yes' : 'No') : edited ? 'Yes (Unmatched)' : 'No',
        correction_remarks: String(r.corr_audit_summary || ''),
        pending_reason: String(r.mismatch_reason || r.suggested_action || ''),
        duplicate_reference:
          summaryStatus === 'Duplicate' || Number(r.duplicate_count || 0) > 1
            ? `DUP:${normGstin(r.recon_supplier_gstin || r.book_supplier_gstin)}|${reconNo} (Count ${r.duplicate_count || 2})`
            : '',

        itc_decision: String(r.itc_decision || 'Pending Review'),
        itc_claim_month: claimMonth,
        itc_claim_fy: claimMonth ? fyOf(claimMonth) : '',
        manual_review_status: String(r.return_classification || r.action_taken || (r.recon_edited ? 'Reviewed' : 'Pending')),
        user_remarks: [r.remarks, r.vendor_response, r.decision_reason].filter(Boolean).join(' | '),
      };
      exportRows.push(row);
    }

    // Aggregate & deduplicate unbooked 2B lines (newest source_file per canonical tuple)
    const grouped2b = new Map<string, { maxId: number; docs: any[] }>();
    for (const r of tRes.rows) {
      const lk = String(r.line_key);
      if (claimedKeys.has(lk)) continue;
      const gstin = normGstin(r.our_gstin);
      const sup = normGstin(r.supplier_gstin);
      const dType = normDocType(r.document_type || 'Tax Invoice');
      const month = String(r.portal_fp || r.twob_month || '').slice(0, 7);
      const canon = `${gstin}|${sup}|${normInvoice(r.invoice_no)}|${dType}|${month}`;
      if (claimedTuples.has(canon)) continue;
      const fileCanon = `${canon}|${String(r.source_file || '')}`;
      const existing = grouped2b.get(fileCanon);
      const rid = Number(r.id);
      if (!existing) grouped2b.set(fileCanon, { maxId: rid, docs: [r] });
      else {
        existing.maxId = Math.max(existing.maxId, rid);
        existing.docs.push(r);
      }
    }
    const newest2bByCanon = new Map<string, { maxId: number; docs: any[] }>();
    for (const [fc, grp] of grouped2b) {
      const canon = fc.split('|').slice(0, 5).join('|');
      const prev = newest2bByCanon.get(canon);
      if (!prev || grp.maxId > prev.maxId) newest2bByCanon.set(canon, grp);
    }

    for (const { docs } of newest2bByCanon.values()) {
      const first = docs[0];
      const compName = String(first.company_name || first.our_gstin);
      const gstin = normGstin(first.our_gstin);
      companies.add(compName);
      gstinSet.add(gstin);

      const dType = normDocType(first.document_type || 'Tax Invoice');
      const twobMonth = String(first.portal_fp || first.twob_month || '').slice(0, 7);
      const tTaxable = r2(docs.reduce((s, d) => s + Number(d.taxable_value || 0), 0));
      const tIgst = r2(docs.reduce((s, d) => s + Number(d.igst || 0), 0));
      const tCgst = r2(docs.reduce((s, d) => s + Number(d.cgst || 0), 0));
      const tSgst = r2(docs.reduce((s, d) => s + Number(d.sgst || 0), 0));
      const tCess = r2(docs.reduce((s, d) => s + Number(d.cess || 0), 0));
      const tTotalTax = r2(tIgst + tCgst + tSgst + tCess);
      const blocked = String(first.itc_availability || 'Yes').trim().toLowerCase() !== 'yes';

      exportRows.push({
        company_name: compName,
        our_gstin: gstin,
        books_fy: '',
        books_month: '',
        books_doc_date: '',
        books_entry_date: '',
        actual_2b_month: twobMonth,
        actual_2b_fy: twobMonth ? fyOf(twobMonth) : '',

        doc_category: String(first.doc_category || (dType === 'Tax Invoice' ? 'B2B' : 'CDNR')),
        document_type: dType,
        books_doc_no: '',
        recon_books_doc_no: '',
        twob_doc_no: String(first.invoice_no || '').trim(),
        books_supplier_gstin: '',
        recon_supplier_gstin: '',
        twob_supplier_gstin: normGstin(first.supplier_gstin),
        supplier_name: String(first.supplier_name || ''),
        matching_key: String(first.line_key),

        books_taxable: null,
        books_igst: null,
        books_cgst: null,
        books_sgst: null,
        books_cess: null,
        books_total_tax: null,

        twob_taxable: tTaxable,
        twob_igst: tIgst,
        twob_cgst: tCgst,
        twob_sgst: tSgst,
        twob_cess: tCess,
        twob_total_tax: tTotalTax,

        taxable_diff: r2(tTaxable),
        igst_diff: r2(tIgst),
        cgst_diff: r2(tCgst),
        sgst_diff: r2(tSgst),
        cess_diff: r2(tCess),
        total_tax_diff: r2(tTotalTax),
        doc_date_diff_days: null,
        doc_no_diff: '',

        reconciliation_status: blocked ? 'PENDING MANUAL REVIEW' : 'GSTR-2B ONLY',
        summary_status: blocked ? 'ITC Blocked' : 'Missing in Books',
        match_type: 'Unmatched GSTR-2B',
        original_books_month: '',
        actual_2b_month_result: twobMonth,
        subsequent_month_match: '',
        cross_fy_match: '',
        matched_after_correction: '',
        correction_remarks: '',
        pending_reason: first.reason
          ? String(first.reason)
          : blocked
            ? `Portal blocked (${first.itc_availability})`
            : 'Present in GSTR-2B; not booked in Purchase Register',
        duplicate_reference: '',

        itc_decision: 'Not Booked',
        itc_claim_month: '',
        itc_claim_fy: '',
        manual_review_status: blocked ? 'Blocked in 2B' : 'Pending Review',
        user_remarks: `2B Source: ${first.source_file || 'portal'}`,
      });
    }

    // Apply optional narrowing filters uniformly across combined rows
    const filtered = exportRows.filter((row) => {
      if (filters.docType && row.document_type !== filters.docType) return false;
      if (filters.status && row.summary_status !== filters.status && row.reconciliation_status !== filters.status) {
        return false;
      }
      if (filters.detailedStatus && row.reconciliation_status !== filters.detailedStatus) return false;
      return true;
    });

    // Required deterministic sorting: GSTIN, Books Month (or 2B month), Supplier, Document Number
    filtered.sort((a, b) => {
      const gCmp = a.our_gstin.localeCompare(b.our_gstin);
      if (gCmp !== 0) return gCmp;
      const mA = a.books_month || a.actual_2b_month || '';
      const mB = b.books_month || b.actual_2b_month || '';
      const mCmp = mA.localeCompare(mB);
      if (mCmp !== 0) return mCmp;
      const sA = a.books_supplier_gstin || a.twob_supplier_gstin || a.supplier_name || '';
      const sB = b.books_supplier_gstin || b.twob_supplier_gstin || b.supplier_name || '';
      const sCmp = sA.localeCompare(sB);
      if (sCmp !== 0) return sCmp;
      const dA = a.books_doc_no || a.twob_doc_no || '';
      const dB = b.books_doc_no || b.twob_doc_no || '';
      return dA.localeCompare(dB);
    });

    // Compute exact aggregate reconciliation summary
    const byDocType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let booksTaxable = 0;
    let booksTotalTax = 0;
    let twobTaxable = 0;
    let twobTotalTax = 0;

    for (const r of filtered) {
      byDocType[r.document_type] = (byDocType[r.document_type] || 0) + 1;
      byStatus[r.reconciliation_status] = (byStatus[r.reconciliation_status] || 0) + 1;
      if (r.books_taxable !== null) booksTaxable = r2(booksTaxable + r.books_taxable);
      if (r.books_total_tax !== null) booksTotalTax = r2(booksTotalTax + r.books_total_tax);
      if (r.twob_taxable !== null) twobTaxable = r2(twobTaxable + r.twob_taxable);
      if (r.twob_total_tax !== null) twobTotalTax = r2(twobTotalTax + r.twob_total_tax);
    }

    const filterParts: string[] = [];
    filterParts.push(`Period: ${periodLabel}`);
    filterParts.push(`GSTIN: ${resolvedGstins.length ? resolvedGstins.join(', ') : 'All Permitted GSTINs'}`);
    if (filters.status) filterParts.push(`Status: ${filters.status}`);
    if (filters.detailedStatus) filterParts.push(`Detailed Status: ${filters.detailedStatus}`);
    if (filters.docType) filterParts.push(`Doc Type: ${filters.docType}`);
    if (filters.supplier) filterParts.push(`Supplier: ${filters.supplier}`);
    if (filters.q) filterParts.push(`Search: ${filters.q}`);

    return {
      rows: filtered,
      resolvedPeriods,
      resolvedGstins: resolvedGstins.length ? resolvedGstins : [...gstinSet].sort(),
      periodLabel,
      companyLabel: [...companies].join('; ') || (resolvedGstins.join(', ') || 'All Companies'),
      filterSummary: filterParts.join(' | '),
      summary: {
        totalRecords: filtered.length,
        byDocType,
        byStatus,
        booksTaxable,
        booksTotalTax,
        twobTaxable,
        twobTotalTax,
        taxableDiff: r2(twobTaxable - booksTaxable),
        taxDiff: r2(twobTotalTax - booksTotalTax),
      },
    };
  });
}

interface ExportCol {
  h: string;
  k: keyof CompleteReconExportRow;
  t: 'text' | 'date' | 'money' | 'int';
  w: number;
}

export const COMPLETE_RECON_COLUMNS: ExportCol[] = [
  // A. Company & Period
  { h: 'Company Name', k: 'company_name', t: 'text', w: 28 },
  { h: 'GSTIN', k: 'our_gstin', t: 'text', w: 18 },
  { h: 'Books Financial Year', k: 'books_fy', t: 'text', w: 16 },
  { h: 'Books Month', k: 'books_month', t: 'text', w: 13 },
  { h: 'Books Document Date', k: 'books_doc_date', t: 'date', w: 15 },
  { h: 'Books Entry Date', k: 'books_entry_date', t: 'date', w: 15 },
  { h: 'Actual GSTR-2B Month', k: 'actual_2b_month', t: 'text', w: 15 },
  { h: 'Actual GSTR-2B Financial Year', k: 'actual_2b_fy', t: 'text', w: 18 },
  // B. Document Identity
  { h: 'Document Category', k: 'doc_category', t: 'text', w: 14 },
  { h: 'Document Type', k: 'document_type', t: 'text', w: 15 },
  { h: 'Books Document Number', k: 'books_doc_no', t: 'text', w: 22 },
  { h: 'Corrected Books Document Number', k: 'recon_books_doc_no', t: 'text', w: 22 },
  { h: 'GSTR-2B Document Number', k: 'twob_doc_no', t: 'text', w: 22 },
  { h: 'Books Supplier GSTIN', k: 'books_supplier_gstin', t: 'text', w: 18 },
  { h: 'Corrected Supplier GSTIN', k: 'recon_supplier_gstin', t: 'text', w: 18 },
  { h: 'GSTR-2B Supplier GSTIN', k: 'twob_supplier_gstin', t: 'text', w: 18 },
  { h: 'Supplier Name', k: 'supplier_name', t: 'text', w: 32 },
  { h: 'Matching Key / Internal Match Reference', k: 'matching_key', t: 'text', w: 34 },
  // C. Purchase Register / Books Values
  { h: 'Books Taxable Value', k: 'books_taxable', t: 'money', w: 17 },
  { h: 'Books IGST', k: 'books_igst', t: 'money', w: 15 },
  { h: 'Books CGST', k: 'books_cgst', t: 'money', w: 15 },
  { h: 'Books SGST', k: 'books_sgst', t: 'money', w: 15 },
  { h: 'Books Cess', k: 'books_cess', t: 'money', w: 13 },
  { h: 'Books Total Tax', k: 'books_total_tax', t: 'money', w: 17 },
  // D. GSTR-2B Values
  { h: 'GSTR-2B Taxable Value', k: 'twob_taxable', t: 'money', w: 17 },
  { h: 'GSTR-2B IGST', k: 'twob_igst', t: 'money', w: 15 },
  { h: 'GSTR-2B CGST', k: 'twob_cgst', t: 'money', w: 15 },
  { h: 'GSTR-2B SGST', k: 'twob_sgst', t: 'money', w: 15 },
  { h: 'GSTR-2B Cess', k: 'twob_cess', t: 'money', w: 13 },
  { h: 'GSTR-2B Total Tax', k: 'twob_total_tax', t: 'money', w: 17 },
  // E. Difference Analysis
  { h: 'Taxable Difference', k: 'taxable_diff', t: 'money', w: 16 },
  { h: 'IGST Difference', k: 'igst_diff', t: 'money', w: 15 },
  { h: 'CGST Difference', k: 'cgst_diff', t: 'money', w: 15 },
  { h: 'SGST Difference', k: 'sgst_diff', t: 'money', w: 15 },
  { h: 'Cess Difference', k: 'cess_diff', t: 'money', w: 13 },
  { h: 'Total Tax Difference', k: 'total_tax_diff', t: 'money', w: 17 },
  { h: 'Document Date Difference', k: 'doc_date_diff_days', t: 'int', w: 15 },
  { h: 'Document Number Difference', k: 'doc_no_diff', t: 'text', w: 22 },
  // F. Reconciliation Result
  { h: 'Reconciliation Status', k: 'reconciliation_status', t: 'text', w: 30 },
  { h: 'Match Category Status', k: 'summary_status', t: 'text', w: 18 },
  { h: 'Match Type', k: 'match_type', t: 'text', w: 24 },
  { h: 'Original Books Month', k: 'original_books_month', t: 'text', w: 15 },
  { h: 'Actual 2B Month', k: 'actual_2b_month_result', t: 'text', w: 15 },
  { h: 'Subsequent Month Match (Yes/No)', k: 'subsequent_month_match', t: 'text', w: 18 },
  { h: 'Cross Financial Year Match (Yes/No)', k: 'cross_fy_match', t: 'text', w: 20 },
  { h: 'Matched After Books Correction (Yes/No)', k: 'matched_after_correction', t: 'text', w: 22 },
  { h: 'Correction Remarks', k: 'correction_remarks', t: 'text', w: 34 },
  { h: 'Pending Reason', k: 'pending_reason', t: 'text', w: 36 },
  { h: 'Duplicate Reference', k: 'duplicate_reference', t: 'text', w: 26 },
  // G. ITC and Review Information
  { h: 'ITC Decision', k: 'itc_decision', t: 'text', w: 18 },
  { h: 'ITC Claim Month', k: 'itc_claim_month', t: 'text', w: 15 },
  { h: 'ITC Claim Financial Year', k: 'itc_claim_fy', t: 'text', w: 16 },
  { h: 'Manual Review Status', k: 'manual_review_status', t: 'text', w: 20 },
  { h: 'User Remarks', k: 'user_remarks', t: 'text', w: 32 },
];

function parseIsoUtcDate(s: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
}

/**
 * Build the SINGLE-WORKSHEET `Complete Reconciliation` Excel workbook.
 * Guarantees:
 *   - Exactly ONE worksheet named `Complete Reconciliation`
 *   - Metadata rows 1–5 (zero merged cells)
 *   - Single styled & frozen header row on row 6
 *   - Zero blank separator rows across all Tax Invoices, Debit Notes & Credit Notes
 *   - AutoFilter enabled from row 6 through last row
 *   - Numeric cells written strictly as numbers with #,##0.00 format (negatives intact)
 */
export function buildCompleteReconWorkbook(
  dataset: CompleteReconDataset,
  exportedAt = new Date(),
): Buffer {
  const wb = XLSX.utils.book_new();
  const exportStamp = exportedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const totalRecords = dataset.summary?.totalRecords ?? dataset.rows.length;
  const companyLabel = dataset.companyLabel || (dataset as any).gstinLabel || 'Company';
  const gstinsStr = dataset.resolvedGstins?.length ? dataset.resolvedGstins.join(', ') : (dataset as any).gstinLabel || 'ALL';
  const filterSummary = dataset.filterSummary || (dataset as any).filterDescription || dataset.periodLabel;

  const aoa: unknown[][] = [
    ['Report Title', 'Complete GST Reconciliation — Purchase Register (Books) vs GSTR-2B (Invoices, Debit Notes & Credit Notes)'],
    ['Company / GSTIN', `${companyLabel} | GSTIN(s): ${gstinsStr}`],
    ['Selected Reporting Period', dataset.periodLabel],
    ['Export Date & Time', exportStamp],
    ['Record Count & Filters', `Total Records: ${totalRecords} | Filters: ${filterSummary}`],
    COMPLETE_RECON_COLUMNS.map((c) => c.h),
  ];

  for (const row of dataset.rows) {
    aoa.push(
      COMPLETE_RECON_COLUMNS.map((col) => {
        const val = row[col.k];
        if (val === null || val === undefined || val === '') return null;
        if (col.t === 'date') return parseIsoUtcDate(String(val));
        if (col.t === 'money') {
          const n = typeof val === 'number' ? val : Number(val);
          return Number.isFinite(n) ? r2(n) : null;
        }
        if (col.t === 'int') {
          const n = typeof val === 'number' ? val : Number(val);
          return Number.isFinite(n) ? Math.round(n) : null;
        }
        return String(val);
      }),
    );
  }

  const HEADER_ROW_0 = 5; // 0-based (Row 6 in Excel)
  const HEADER_ROW_1 = 6; // 1-based
  const lastRow0 = HEADER_ROW_0 + dataset.rows.length;
  const lastCol0 = COMPLETE_RECON_COLUMNS.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws['!cols'] = COMPLETE_RECON_COLUMNS.map((c) => ({ wch: c.w }));
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: HEADER_ROW_0, c: 0 }, e: { r: lastRow0, c: lastCol0 } }),
  };

  for (let r0 = HEADER_ROW_0 + 1; r0 <= lastRow0; r0++) {
    for (let c0 = 0; c0 <= lastCol0; c0++) {
      const col = COMPLETE_RECON_COLUMNS[c0];
      const addr = XLSX.utils.encode_cell({ r: r0, c: c0 });
      const cell = (ws as any)[addr];
      if (!cell) continue;
      if (col.t === 'money') cell.z = '#,##0.00';
      else if (col.t === 'int') cell.z = '#,##0';
      else if (col.t === 'date') cell.z = 'dd-mmm-yyyy';
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Complete Reconciliation');
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
  return polishWorkbook(raw, { freezeRows: HEADER_ROW_1, headerRow: HEADER_ROW_1, styleHeader: true });
}

export async function logReconExportHistory(entry: {
  exportType?: string;
  exportedBy: string;
  ourGstin?: string | null;
  selectedGstins: string[];
  periodMode: string;
  selectedPeriods: string[];
  filters: Record<string, unknown>;
  recordCount: number;
  fileName: string;
}): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO recon_export_history
         (export_type, exported_by, our_gstin, selected_gstins, period_mode,
          selected_periods, filters, record_count, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id::int`,
      [
        entry.exportType || 'gstr2b_complete',
        entry.exportedBy || 'system',
        entry.ourGstin || null,
        entry.selectedGstins,
        entry.periodMode,
        entry.selectedPeriods,
        JSON.stringify(entry.filters),
        entry.recordCount,
        entry.fileName,
      ],
    );
    return Number(r.rows[0]?.id ?? 0);
  });
}

export async function listReconExportHistory(allowed?: string[] | null) {
  return withClient(async (c) => {
    const params: unknown[] = [];
    let where = '';
    if (allowed && allowed.length) {
      params.push(allowed.map(normGstin));
      where = 'WHERE our_gstin = ANY($1::text[]) OR selected_gstins && $1::text[]';
    } else if (allowed && allowed.length === 0) {
      return [];
    }
    const r = await c.query(
      `SELECT id::int, export_type, exported_by, exported_at, our_gstin,
              selected_gstins, period_mode, selected_periods, filters, record_count, file_name
         FROM recon_export_history
         ${where}
        ORDER BY exported_at DESC LIMIT 50`,
      params,
    );
    return r.rows;
  });
}
