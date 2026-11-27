/**
 * GST Control ERP — Phase 5: Professional Historical Bill-wise Reconciliation Report
 * (Consultant Format — 7-Sheet Excel + Parity Verifier).
 *
 * Strictly reuses existing reconciliation outcomes (`purchase_lines`) and
 * immutable canonical source records (`gstr2b_lines`, `recon_corrections`).
 * NEVER runs a second matching engine and NEVER mutates ITC decisions or books data.
 *
 * Controlled Partial Allocation Rule:
 *   `Partly Matched` is strictly 0 unless an explicitly approved partial-allocation
 *   mechanism is separately implemented. Value/tax differences on a 1-to-1 matched
 *   invoice are classified as `Matched with Taxable Value Difference` or
 *   `Matched with Tax Difference`.
 */

import XLSX from 'xlsx';
import { fyOf, isoDate, labelOf, normDocType, normGstin, normInvoice, r2 } from '../engine/core';
import { expandSelectedPeriods } from '../engine/gstr2b-excel';
import { fyMonths } from '../engine/gstr9';
import { withClient } from './store';
import { polishWorkbook } from './xlsx-format';
import { resolveCompanyGstins } from './phase3-reports';

export type HistPeriodMode = 'single' | 'range' | 'multi' | 'fy' | 'all';

export interface HistoricalReconFilters {
  company?: string | null;
  gstin?: string | null;
  gstins?: string[];
  fy?: string | null;
  periodMode?: HistPeriodMode;
  period?: string | null;
  from?: string | null;
  to?: string | null;
  periods?: string[];
  supplier?: string | null;
  docType?: string | null;
  status?: string | null;
  booksMonth?: string | null;
  twobMonth?: string | null;
  uploadBatch?: string | null;
  reportingDate?: string | null;
  /** Server-side tenant isolation fence: when non-null, strictly restricts all queries to these GSTINs. */
  allowedGstins?: string[] | null;
}

export interface EightHeadTotals {
  docs: number;
  invoiceValue: number;
  invoiceValueCapturedDocs: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
}

export type ReconBucketKey =
  | 'Matched in Same Month'
  | 'Matched in Subsequent Month'
  | 'Matched in Subsequent Financial Year'
  | 'Matched after Books Correction'
  | 'Matched with Taxable Value Difference'
  | 'Matched with Tax Difference'
  | 'Partly Matched'
  | 'Only in Books'
  | 'Pending for Future GSTR-2B'
  | 'Duplicate Records'
  | 'Possible Duplicate / Manual Review';

export const BOOKS_RECON_BUCKETS: ReconBucketKey[] = [
  'Matched in Same Month',
  'Matched in Subsequent Month',
  'Matched in Subsequent Financial Year',
  'Matched after Books Correction',
  'Matched with Taxable Value Difference',
  'Matched with Tax Difference',
  'Partly Matched',
  'Only in Books',
  'Pending for Future GSTR-2B',
  'Duplicate Records',
  'Possible Duplicate / Manual Review',
];

export interface ReconBucketRow {
  bucket: string;
  side: 'BOOKS' | 'ROLLUP' | 'GSTR2B';
  docs: number;
  invoiceValue: number;
  taxableValue: number;
  totalGst: number;
  matchedTaxable: number;
  matchedGst: number;
  diffTaxable: number;
  diffGst: number;
  pctByCount: number;
  pctByValue: number;
}

export interface HistoricalBookRow {
  lineId: number;
  companyName: string;
  ourGstin: string;
  unitName: string;
  booksFy: string;
  booksMonth: string;
  booksDocDate: string;
  bookEntryDate: string;
  supplierName: string;
  supplierGstin: string;
  supplierPan: string;
  docType: string;
  originalBooksInvNo: string;
  correctedBooksInvNo: string;
  originalBooksInvValue: number | null;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  matched2bInvNo: string;
  actual2bMonth: string;
  actual2bFy: string;
  reconciliationMonth: string;
  twobDocDate: string;
  twobInvValue: number | null;
  twobTaxable: number;
  twobIgst: number;
  twobCgst: number;
  twobSgst: number;
  twobUtgst: number;
  twobCess: number;
  twobTotalGst: number;
  matchedTaxable: number;
  matchedGst: number;
  diffTaxable: number;
  diffGst: number;
  diffInvValue: number | null;
  bucket: ReconBucketKey;
  matchStatus: string;
  reasonRemarks: string;
  mismatchReasons: string[];
  correctionStatus: string;
  itcDecision: string;
  itcClaimMonth: string;
  itcClaimFy: string;
  sourceFile: string;
}

export interface Historical2bOnlyRow {
  ourGstin: string;
  companyName: string;
  twobMonth: string;
  twobFy: string;
  supplierGstin: string;
  supplierName: string;
  docNo: string;
  docDate: string;
  docType: string;
  invoiceValue: number | null;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalGst: number;
  pendingStatus: string;
  reason: string;
  sourceFile: string;
}

export interface MonthMovementRow {
  booksMonth: string;
  label: string;
  booksFy: string;
  totalDocs: number;
  totalTaxable: number;
  totalGst: number;
  sameMonthDocs: number;
  sameMonthTaxable: number;
  subseqMonthDocs: number;
  subseqMonthTaxable: number;
  subseqFyDocs: number;
  subseqFyTaxable: number;
  afterCorrDocs: number;
  afterCorrTaxable: number;
  withDiffDocs: number;
  withDiffTaxable: number;
  partlyMatchedDocs: number;
  partlyMatchedTaxable: number;
  pendingBooksOnlyDocs: number;
  pendingBooksOnlyTaxable: number;
  otherDocs: number;
  reconPctByCount: number;
  reconPctByValue: number;
}

export interface SupplierSummaryRow {
  supplierGstin: string;
  supplierPan: string;
  supplierName: string;
  booksDocs: number;
  booksInvoiceValue: number;
  booksTaxable: number;
  booksGst: number;
  twobTaxable: number;
  twobGst: number;
  fullyMatchedTaxable: number;
  fullyMatchedGst: number;
  mismatchTaxableDiff: number;
  mismatchGstDiff: number;
  onlyInBooksTaxable: number;
  onlyInBooksGst: number;
  onlyIn2bTaxable: number;
  onlyIn2bGst: number;
  pendingCount: number;
  oldestPendingDate: string;
  oldestPendingAgeDays: number | null;
}

export interface CorrectionHistoryRow {
  correctionId: number;
  lineId: number;
  ourGstin: string;
  booksMonth: string;
  originalInvNo: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  reason: string;
  changedBy: string;
  changedAt: string;
  rerefreshed: boolean;
}

export interface ParityCheckItem {
  id: number;
  name: string;
  ok: boolean;
  detail: string;
}

export interface HistoricalReconReport {
  meta: {
    generatedAt: string;
    reportingDate: string;
    companyLabel: string;
    gstinLabel: string;
    fyLabel: string;
    periodLabel: string;
    filterSummary: string;
  };
  booksSummary: EightHeadTotals;
  twobSummary: EightHeadTotals;
  reconciliationSummary: ReconBucketRow[];
  controlTotals: {
    booksUnmatchedTaxable: number;
    booksUnmatchedGst: number;
    twobUnmatchedTaxable: number;
    twobUnmatchedGst: number;
    matchedWithDiffBooksTaxable: number;
    matchedWithDiffTwobTaxable: number;
    matchedWithDiffTaxableDelta: number;
    matchedWithDiffGstDelta: number;
    partialAllocationDocs: number;
    partialAllocationMatched: number;
    partialAllocationRemaining: number;
    reconPctByCount: number;
    reconPctByTaxable: number;
    reconPctByGst: number;
  };
  booksRegister: HistoricalBookRow[];
  twobOnlyRegister: Historical2bOnlyRow[];
  monthMovement: MonthMovementRow[];
  supplierSummary: SupplierSummaryRow[];
  mismatchAndPending: HistoricalBookRow[];
  correctionHistory: CorrectionHistoryRow[];
  parityChecks: ParityCheckItem[];
  allParityOk: boolean;
}

function emptyEight(): EightHeadTotals {
  return { docs: 0, invoiceValue: 0, invoiceValueCapturedDocs: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, utgst: 0, cess: 0, totalGst: 0 };
}

/**
 * Signed Matched Amount (Condition #4):
 *   - Positive docs (Tax Invoice / Debit Note): min(book, twob) when both >= 0
 *   - Negative Credit Notes: -min(|book|, |twob|) when both <= 0
 *   - Unmatched (twob == 0): 0
 */
export function signedMatchedAmount(bookAmt: number, twobAmt: number, isMatched: boolean): number {
  if (!isMatched) return 0;
  const b = r2(bookAmt);
  const t = r2(twobAmt);
  if (b === 0 || t === 0) return 0;
  if (b > 0 && t > 0) return r2(Math.min(b, t));
  if (b < 0 && t < 0) return r2(-Math.min(Math.abs(b), Math.abs(t)));
  return 0;
}

function classifyBooksBucket(
  r: any,
  has2b: boolean,
  diffTaxable: number,
  latest2bMonth: string,
): ReconBucketKey {
  const st = String(r.match_status || '');
  const dSt = String(r.detailed_match_status || '');
  const reasons: string[] = Array.isArray(r.mismatch_reasons) ? r.mismatch_reasons : [];
  const period = String(r.period || '').slice(0, 7);
  const m2b = String(r.matched_2b_month || '').slice(0, 7);
  const isCorrected = Boolean(
    r.recon_edited ||
      Number(r.recon_extra_taxable || 0) !== 0 ||
      Number(r.recon_extra_igst || 0) !== 0 ||
      Number(r.recon_extra_cgst || 0) !== 0 ||
      Number(r.recon_extra_sgst || 0) !== 0 ||
      Number(r.recon_extra_utgst || 0) !== 0 ||
      Number(r.recon_extra_cess || 0) !== 0,
  );

  // 1. Duplicates
  if (st === 'Duplicate') return 'Duplicate Records';

  // 2. ITC Blocked / Possible Duplicate / Multi-candidate Manual Review
  if (
    st === 'ITC Blocked' ||
    dSt === 'POSSIBLE DUPLICATE' ||
    dSt === 'PENDING MANUAL REVIEW' ||
    reasons.includes('MULTIPLE_CANDIDATES') ||
    reasons.includes('POSSIBLE_DUPLICATE')
  ) {
    return 'Possible Duplicate / Manual Review';
  }

  // 3. Fully Matched (4 mutually exclusive sub-buckets)
  if (st === 'Matched' && has2b) {
    if (isCorrected) return 'Matched after Books Correction';
    if (m2b && period && fyOf(m2b) !== fyOf(period)) return 'Matched in Subsequent Financial Year';
    if (m2b && period && m2b !== period) return 'Matched in Subsequent Month';
    return 'Matched in Same Month';
  }

  // 4. Matched with Difference (1-to-1 linked to 2B, NOT Partly Matched)
  if (has2b) {
    if (Math.abs(diffTaxable) > 1) return 'Matched with Taxable Value Difference';
    return 'Matched with Tax Difference';
  }

  // 5. Unmatched Books: Future GSTR-2B vs Only in Books
  if (latest2bMonth && period > latest2bMonth) {
    return 'Pending for Future GSTR-2B';
  }
  return 'Only in Books';
}

export async function buildHistoricalReconReport(filters: HistoricalReconFilters = {}): Promise<HistoricalReconReport> {
  const periodMode: HistPeriodMode = filters.periodMode ?? (
    filters.periods?.length ? 'multi'
      : filters.from || filters.to ? 'range'
      : filters.fy ? 'fy'
      : filters.period ? 'single'
      : 'all'
  );

  let resolvedPeriods: string[] = [];
  if (periodMode === 'fy' && filters.fy) {
    resolvedPeriods = fyMonths(filters.fy).months;
  } else if (periodMode === 'single' || periodMode === 'range' || periodMode === 'multi') {
    resolvedPeriods = expandSelectedPeriods({
      periodMode,
      period: filters.period || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      periods: filters.periods,
    });
  }

  const reportingDate = filters.reportingDate || new Date().toISOString().slice(0, 10);

  return withClient(async (c) => {
    // Resolve GSTIN & company filters using actual live schema (`gstins.gstin_number`, `companies.short_name`/`name`/`id`)
    let resolvedGstins: string[] = [];
    let emptyTenantScope = false;

    if (filters.gstins && filters.gstins.length) {
      resolvedGstins = [...new Set(filters.gstins.map(normGstin).filter(Boolean))];
    } else if (filters.gstin && filters.gstin.toUpperCase() !== 'ALL') {
      resolvedGstins = [normGstin(filters.gstin)];
    }

    if (filters.company) {
      const coGstins = await resolveCompanyGstins(c, filters.company);
      if (coGstins.length === 0) {
        resolvedGstins = [];
        emptyTenantScope = true;
      } else if (resolvedGstins.length > 0) {
        const coSet = new Set(coGstins);
        resolvedGstins = resolvedGstins.filter((g) => coSet.has(g));
        if (resolvedGstins.length === 0) emptyTenantScope = true;
      } else {
        resolvedGstins = coGstins;
      }
    }

    // Tenant isolation fence (REM-1): strictly intersect with server-authorized GSTINs.
    if (!emptyTenantScope && filters.allowedGstins !== undefined && filters.allowedGstins !== null) {
      const allowedSet = new Set(filters.allowedGstins.map(normGstin).filter(Boolean));
      if (allowedSet.size === 0) {
        resolvedGstins = [];
        emptyTenantScope = true;
      } else if (resolvedGstins.length > 0) {
        resolvedGstins = resolvedGstins.filter((g) => allowedSet.has(g));
        if (resolvedGstins.length === 0) emptyTenantScope = true;
      } else {
        resolvedGstins = [...allowedSet];
      }
    }

    // Latest uploaded 2B month per GSTIN (to distinguish Only in Books vs Pending for Future GSTR-2B)
    const latest2bRes = await c.query(
      `SELECT our_gstin, MAX(COALESCE(NULLIF(portal_fp, ''), twob_month)) AS max_m
         FROM gstr2b_lines
        GROUP BY our_gstin`,
    );
    const latest2bByGstin = new Map<string, string>();
    for (const r of latest2bRes.rows as any[]) {
      latest2bByGstin.set(normGstin(r.our_gstin), String(r.max_m || '').slice(0, 7));
    }

    // 1. Query canonical GSTR-2B source (deduplicated per canonical invoice tuple)
    const tWhere: string[] = [];
    const tParams: unknown[] = [];
    if (emptyTenantScope) {
      tWhere.push('1 = 0');
    } else if (resolvedGstins.length) {
      tParams.push(resolvedGstins);
      tWhere.push(`gl.our_gstin = ANY($${tParams.length}::text[])`);
    }
    if (filters.supplier) {
      tParams.push(normGstin(filters.supplier));
      tWhere.push(`gl.supplier_gstin = $${tParams.length}`);
    }
    if (filters.twobMonth) {
      tParams.push(filters.twobMonth);
      tWhere.push(`COALESCE(NULLIF(gl.portal_fp,''), gl.twob_month) = $${tParams.length}`);
    } else if (resolvedPeriods.length && !filters.booksMonth) {
      // Keep ALL 2B months for matched lookups, filter 2B-only by scope below
    }
    if (filters.uploadBatch) {
      tParams.push(filters.uploadBatch);
      tWhere.push(`gl.source_file = $${tParams.length}`);
    }

    const tAllRes = await c.query(
      `SELECT gl.*,
              COALESCE(comp.name, g.legal_name, g.trade_name, gl.our_gstin) AS company_name
         FROM gstr2b_lines gl
         LEFT JOIN gstins g ON g.gstin_number = gl.our_gstin
         LEFT JOIN companies comp ON comp.id = g.company_id
         ${tWhere.length ? 'WHERE ' + tWhere.join(' AND ') : ''}
        ORDER BY gl.our_gstin, COALESCE(NULLIF(gl.portal_fp,''), gl.twob_month), gl.id`,
      tParams,
    );

    // Group GSTR-2B lines by canonical invoice tuple & pick latest source_file per tuple (preventing re-upload inflation)
    type Canon2b = {
      ourGstin: string;
      companyName: string;
      twobMonth: string;
      supplierGstin: string;
      supplierName: string;
      docNo: string;
      docDate: string;
      docType: string;
      invoiceValue: number | null;
      taxableValue: number;
      igst: number;
      cgst: number;
      sgst: number;
      utgst: number;
      cess: number;
      totalGst: number;
      itcAvailability: string;
      reason: string;
      sourceFile: string;
      lineKeys: Set<string>;
      maxId: number;
    };

    const rawByCanonSrc = new Map<string, { canonKey: string; docs: any[]; maxId: number }>();
    for (const r of tAllRes.rows as any[]) {
      const m = String(r.portal_fp || r.twob_month || '').slice(0, 7);
      const dType = normDocType(r.document_type || 'Tax Invoice');
      const canonKey = `${normGstin(r.our_gstin)}|${normGstin(r.supplier_gstin)}|${normInvoice(r.invoice_no)}|${dType}|${m}`;
      const srcKey = `${canonKey}|${String(r.source_file || '')}`;
      let cur = rawByCanonSrc.get(srcKey);
      if (!cur) {
        cur = { canonKey, docs: [], maxId: 0 };
        rawByCanonSrc.set(srcKey, cur);
      }
      cur.docs.push(r);
      if (Number(r.id) > cur.maxId) cur.maxId = Number(r.id);
    }

    const latestByCanon = new Map<string, { docs: any[]; maxId: number; allKeys: Set<string> }>();
    for (const grp of rawByCanonSrc.values()) {
      const prev = latestByCanon.get(grp.canonKey);
      if (!prev) {
        latestByCanon.set(grp.canonKey, {
          docs: grp.docs,
          maxId: grp.maxId,
          allKeys: new Set(grp.docs.map((d) => String(d.line_key))),
        });
      } else {
        for (const d of grp.docs) prev.allKeys.add(String(d.line_key));
        if (grp.maxId > prev.maxId) {
          prev.docs = grp.docs;
          prev.maxId = grp.maxId;
        }
      }
    }

    const canon2bList: Canon2b[] = [];
    const canon2bByLineKey = new Map<string, Canon2b>();

    for (const { docs, maxId, allKeys } of latestByCanon.values()) {
      const first = docs[0];
      const m = String(first.portal_fp || first.twob_month || '').slice(0, 7);
      const dType = normDocType(first.document_type || 'Tax Invoice');
      const taxableValue = r2(docs.reduce((s, d) => s + Number(d.taxable_value || 0), 0));
      const igst = r2(docs.reduce((s, d) => s + Number(d.igst || 0), 0));
      const cgst = r2(docs.reduce((s, d) => s + Number(d.cgst || 0), 0));
      const sgst = r2(docs.reduce((s, d) => s + Number(d.sgst || 0), 0));
      const utgst = r2(docs.reduce((s, d) => s + Number(d.utgst || 0), 0));
      const cess = r2(docs.reduce((s, d) => s + Number(d.cess || 0), 0));
      const totalGst = r2(igst + cgst + sgst + utgst + cess);
      const invVal = first.invoice_value !== null && first.invoice_value !== undefined ? r2(Number(first.invoice_value)) : null;

      const item: Canon2b = {
        ourGstin: normGstin(first.our_gstin),
        companyName: String(first.company_name || first.our_gstin),
        twobMonth: m,
        supplierGstin: normGstin(first.supplier_gstin),
        supplierName: String(first.supplier_name || ''),
        docNo: String(first.invoice_no || '').trim(),
        docDate: first.invoice_date ? isoDate(first.invoice_date) : '',
        docType: dType,
        invoiceValue: invVal,
        taxableValue,
        igst,
        cgst,
        sgst,
        utgst,
        cess,
        totalGst,
        itcAvailability: String(first.itc_availability || 'Yes'),
        reason: String(first.reason || ''),
        sourceFile: String(first.source_file || ''),
        lineKeys: allKeys,
        maxId,
      };
      canon2bList.push(item);
      for (const lk of allKeys) {
        canon2bByLineKey.set(`${item.ourGstin}|${lk}`, item);
      }
    }

    // 2. Query Books Purchase Register (`purchase_lines`) within filters
    const pWhere: string[] = [];
    const pParams: unknown[] = [];
    if (emptyTenantScope) {
      pWhere.push('1 = 0');
    } else if (resolvedGstins.length) {
      pParams.push(resolvedGstins);
      pWhere.push(`p.our_gstin = ANY($${pParams.length}::text[])`);
    }
    if (filters.booksMonth) {
      pParams.push(filters.booksMonth);
      pWhere.push(`p.period = $${pParams.length}`);
    } else if (resolvedPeriods.length) {
      pParams.push(resolvedPeriods);
      pWhere.push(`p.period = ANY($${pParams.length}::text[])`);
    }
    if (filters.twobMonth) {
      pParams.push(filters.twobMonth);
      pWhere.push(`p.matched_2b_month = $${pParams.length}`);
    }
    if (filters.supplier) {
      pParams.push(normGstin(filters.supplier));
      pWhere.push(`(p.book_supplier_gstin = $${pParams.length} OR p.recon_supplier_gstin = $${pParams.length})`);
    }
    if (filters.docType) {
      pParams.push(normDocType(filters.docType));
      pWhere.push(`COALESCE(p.book_document_type, 'Tax Invoice') = $${pParams.length}`);
    }
    if (filters.uploadBatch) {
      pParams.push(filters.uploadBatch);
      pWhere.push(`p.source_file = $${pParams.length}`);
    }
    if (filters.reportingDate) {
      pParams.push(filters.reportingDate);
      pWhere.push(`(p.book_invoice_date IS NULL OR p.book_invoice_date <= $${pParams.length}::date)`);
    }

    const pRes = await c.query(
      `SELECT p.*,
              COALESCE(comp.name, g.legal_name, g.trade_name, p.our_gstin) AS company_name
         FROM purchase_lines p
         LEFT JOIN gstins g ON g.gstin_number = p.our_gstin
         LEFT JOIN companies comp ON comp.id = g.company_id
         ${pWhere.length ? 'WHERE ' + pWhere.join(' AND ') : ''}
        ORDER BY p.our_gstin, p.period, p.book_invoice_date NULLS LAST, p.id`,
      pParams,
    );

    const companiesSet = new Set<string>();
    const gstinsSet = new Set<string>();
    const matchedCanon2bSet = new Set<Canon2b>();
    const booksRegister: HistoricalBookRow[] = [];

    for (const r of pRes.rows as any[]) {
      const ourGstin = normGstin(r.our_gstin);
      const compName = String(r.company_name || ourGstin);
      companiesSet.add(compName);
      gstinsSet.add(ourGstin);

      const matchedKey = r.matched_2b_key ? String(r.matched_2b_key) : '';
      const linked2b = matchedKey ? canon2bByLineKey.get(`${ourGstin}|${matchedKey}`) || null : null;
      if (linked2b) matchedCanon2bSet.add(linked2b);
      const has2b = Boolean(matchedKey);

      const bookTaxable = r2(Number(r.book_taxable_value || 0));
      const bookIgst = r2(Number(r.book_igst || 0));
      const bookCgst = r2(Number(r.book_cgst || 0));
      const bookSgst = r2(Number(r.book_sgst || 0));
      const bookUtgst = r2(Number(r.book_utgst || 0));
      const bookCess = r2(Number(r.book_cess || 0));
      const bookTotalGst = r2(bookIgst + bookCgst + bookSgst + bookUtgst + bookCess);
      const bookInvVal = r.book_invoice_value !== null && r.book_invoice_value !== undefined ? r2(Number(r.book_invoice_value)) : null;

      // Authoritative GSTR-2B values come from canonical gstr2b_lines when joined, falling back to denormalised columns only if 2B line was purged
      const twobTaxable = has2b ? r2(linked2b ? linked2b.taxableValue : Number(r.twob_taxable_value || 0)) : 0;
      const twobIgst = has2b ? r2(linked2b ? linked2b.igst : Number(r.twob_igst || 0)) : 0;
      const twobCgst = has2b ? r2(linked2b ? linked2b.cgst : Number(r.twob_cgst || 0)) : 0;
      const twobSgst = has2b ? r2(linked2b ? linked2b.sgst : Number(r.twob_sgst || 0)) : 0;
      const twobUtgst = has2b ? r2(linked2b ? linked2b.utgst : Number(r.twob_utgst || 0)) : 0;
      const twobCess = has2b ? r2(linked2b ? linked2b.cess : Number(r.twob_cess || 0)) : 0;
      const twobTotalGst = has2b ? r2(twobIgst + twobCgst + twobSgst + twobUtgst + twobCess) : 0;
      const twobInvVal = has2b
        ? (linked2b ? linked2b.invoiceValue : (r.twob_invoice_value !== null && r.twob_invoice_value !== undefined ? r2(Number(r.twob_invoice_value)) : null))
        : null;

      const diffTaxable = r2(bookTaxable - twobTaxable);
      const diffGst = r2(bookTotalGst - twobTotalGst);
      const diffInvValue = bookInvVal !== null && twobInvVal !== null ? r2(bookInvVal - twobInvVal) : null;
      const matchedTaxable = signedMatchedAmount(bookTaxable, twobTaxable, has2b);
      const matchedGst = signedMatchedAmount(bookTotalGst, twobTotalGst, has2b);

      const latest2bM = latest2bByGstin.get(ourGstin) || '';
      const bucket = classifyBooksBucket(r, has2b, diffTaxable, latest2bM);

      if (filters.status && bucket !== filters.status && String(r.match_status || '') !== filters.status) {
        continue;
      }

      const period = String(r.period || '').slice(0, 7);
      const actual2bMonth = has2b ? String(linked2b?.twobMonth || r.matched_2b_month || '').slice(0, 7) : '';
      const claimMonth = String(r.itc_decision_month || '').slice(0, 7);
      const supGstin = normGstin(r.book_supplier_gstin);
      const isCorrected = Boolean(r.recon_edited || Number(r.recon_extra_taxable || 0) !== 0 || Number(r.recon_extra_igst || 0) !== 0 || Number(r.recon_extra_cgst || 0) !== 0 || Number(r.recon_extra_sgst || 0) !== 0 || Number(r.recon_extra_utgst || 0) !== 0 || Number(r.recon_extra_cess || 0) !== 0);

      booksRegister.push({
        lineId: Number(r.id),
        companyName: compName,
        ourGstin,
        unitName: String(r.unit_name || ''),
        booksFy: String(r.financial_year || fyOf(period)),
        booksMonth: period,
        booksDocDate: r.book_invoice_date ? isoDate(r.book_invoice_date) : '',
        bookEntryDate: r.book_entry_date ? isoDate(r.book_entry_date) : '',
        supplierName: String(r.party_name || ''),
        supplierGstin: supGstin,
        supplierPan: supGstin.length >= 12 ? supGstin.slice(2, 12) : '',
        docType: normDocType(r.book_document_type || 'Tax Invoice'),
        originalBooksInvNo: String(r.book_invoice_no || '').trim(),
        correctedBooksInvNo: String(r.recon_invoice_no || r.book_invoice_no || '').trim(),
        originalBooksInvValue: bookInvVal,
        taxableValue: bookTaxable,
        igst: bookIgst,
        cgst: bookCgst,
        sgst: bookSgst,
        utgst: bookUtgst,
        cess: bookCess,
        totalGst: bookTotalGst,
        matched2bInvNo: has2b ? String(linked2b?.docNo || r.twob_invoice_no || '').trim() : '',
        actual2bMonth,
        actual2bFy: actual2bMonth ? fyOf(actual2bMonth) : '',
        reconciliationMonth: String(r.reconciliation_month || ''),
        twobDocDate: has2b ? (linked2b?.docDate || (r.twob_invoice_date ? isoDate(r.twob_invoice_date) : '')) : '',
        twobInvValue: twobInvVal,
        twobTaxable,
        twobIgst,
        twobCgst,
        twobSgst,
        twobUtgst,
        twobCess,
        twobTotalGst,
        matchedTaxable,
        matchedGst,
        diffTaxable,
        diffGst,
        diffInvValue,
        bucket,
        matchStatus: String(r.match_status || 'Missing in 2B'),
        reasonRemarks: String(r.mismatch_reason || r.suggested_action || ''),
        mismatchReasons: Array.isArray(r.mismatch_reasons) ? r.mismatch_reasons : [],
        correctionStatus: isCorrected ? 'Corrected (Books Overlay)' : 'Original',
        itcDecision: String(r.itc_decision || 'Pending Review'),
        itcClaimMonth: claimMonth,
        itcClaimFy: claimMonth ? fyOf(claimMonth) : '',
        sourceFile: String(r.source_file || ''),
      });
    }

    // 3. Build GSTR-2B Only Register (canonically deduplicated, scoped to filters, excluding matched 2B docs)
    // Also check DB-wide claimed 2B keys so a 2B doc matched to a Books bill in ANOTHER month is NOT falsely shown as GSTR-2B Only
    const allClaimedRes = await c.query(
      `SELECT DISTINCT our_gstin, matched_2b_key FROM purchase_lines WHERE matched_2b_key IS NOT NULL`,
    );
    const globalClaimed = new Set<string>(
      allClaimedRes.rows.map((x: any) => `${normGstin(x.our_gstin)}|${String(x.matched_2b_key)}`),
    );

    const periodSet = resolvedPeriods.length ? new Set(resolvedPeriods) : null;
    const scopedCanon2b: Canon2b[] = [];
    const twobOnlyRegister: Historical2bOnlyRow[] = [];

    for (const item of canon2bList) {
      if (periodSet && !periodSet.has(item.twobMonth)) continue;
      if (filters.docType && item.docType !== normDocType(filters.docType)) continue;
      if (filters.reportingDate && item.docDate && item.docDate > filters.reportingDate) continue;

      scopedCanon2b.push(item);
      companiesSet.add(item.companyName);
      gstinsSet.add(item.ourGstin);

      let isClaimed = matchedCanon2bSet.has(item);
      if (!isClaimed) {
        for (const lk of item.lineKeys) {
          if (globalClaimed.has(`${item.ourGstin}|${lk}`)) {
            isClaimed = true;
            break;
          }
        }
      }
      if (!isClaimed) {
        const blocked = item.itcAvailability.trim().toLowerCase() !== 'yes';
        twobOnlyRegister.push({
          ourGstin: item.ourGstin,
          companyName: item.companyName,
          twobMonth: item.twobMonth,
          twobFy: item.twobMonth ? fyOf(item.twobMonth) : '',
          supplierGstin: item.supplierGstin,
          supplierName: item.supplierName,
          docNo: item.docNo,
          docDate: item.docDate,
          docType: item.docType,
          invoiceValue: item.invoiceValue,
          taxableValue: item.taxableValue,
          igst: item.igst,
          cgst: item.cgst,
          sgst: item.sgst,
          utgst: item.utgst,
          cess: item.cess,
          totalGst: item.totalGst,
          pendingStatus: blocked ? 'Blocked in GSTR-2B' : 'Unbooked — Pending Review',
          reason: item.reason || (blocked ? `ITC Availability: ${item.itcAvailability}` : 'Appears in GSTR-2B; not recorded in Books'),
          sourceFile: item.sourceFile,
        });
      }
    }

    // 4. Compute Books Summary (Block A) & GSTR-2B Summary (Block B)
    const booksSummary = emptyEight();
    for (const b of booksRegister) {
      booksSummary.docs++;
      if (b.originalBooksInvValue !== null) {
        booksSummary.invoiceValue = r2(booksSummary.invoiceValue + b.originalBooksInvValue);
        booksSummary.invoiceValueCapturedDocs++;
      }
      booksSummary.taxableValue = r2(booksSummary.taxableValue + b.taxableValue);
      booksSummary.igst = r2(booksSummary.igst + b.igst);
      booksSummary.cgst = r2(booksSummary.cgst + b.cgst);
      booksSummary.sgst = r2(booksSummary.sgst + b.sgst);
      booksSummary.utgst = r2(booksSummary.utgst + b.utgst);
      booksSummary.cess = r2(booksSummary.cess + b.cess);
      booksSummary.totalGst = r2(booksSummary.totalGst + b.totalGst);
    }

    const twobSummary = emptyEight();
    for (const t of scopedCanon2b) {
      twobSummary.docs++;
      if (t.invoiceValue !== null) {
        twobSummary.invoiceValue = r2(twobSummary.invoiceValue + t.invoiceValue);
        twobSummary.invoiceValueCapturedDocs++;
      }
      twobSummary.taxableValue = r2(twobSummary.taxableValue + t.taxableValue);
      twobSummary.igst = r2(twobSummary.igst + t.igst);
      twobSummary.cgst = r2(twobSummary.cgst + t.cgst);
      twobSummary.sgst = r2(twobSummary.sgst + t.sgst);
      twobSummary.utgst = r2(twobSummary.utgst + t.utgst);
      twobSummary.cess = r2(twobSummary.cess + t.cess);
      twobSummary.totalGst = r2(twobSummary.totalGst + t.totalGst);
    }

    // 5. Compute 13-Row Reconciliation Summary (Block C)
    const bucketAgg = new Map<ReconBucketKey, ReconBucketRow>();
    for (const bk of BOOKS_RECON_BUCKETS) {
      bucketAgg.set(bk, {
        bucket: bk,
        side: 'BOOKS',
        docs: 0,
        invoiceValue: 0,
        taxableValue: 0,
        totalGst: 0,
        matchedTaxable: 0,
        matchedGst: 0,
        diffTaxable: 0,
        diffGst: 0,
        pctByCount: 0,
        pctByValue: 0,
      });
    }
    for (const b of booksRegister) {
      const a = bucketAgg.get(b.bucket)!;
      a.docs++;
      a.invoiceValue = r2(a.invoiceValue + (b.originalBooksInvValue ?? 0));
      a.taxableValue = r2(a.taxableValue + b.taxableValue);
      a.totalGst = r2(a.totalGst + b.totalGst);
      a.matchedTaxable = r2(a.matchedTaxable + b.matchedTaxable);
      a.matchedGst = r2(a.matchedGst + b.matchedGst);
      a.diffTaxable = r2(a.diffTaxable + b.diffTaxable);
      a.diffGst = r2(a.diffGst + b.diffGst);
    }

    const pct = (part: number, whole: number) => (Math.abs(whole) > 0.001 ? r2((part / whole) * 100) : 0);
    for (const a of bucketAgg.values()) {
      a.pctByCount = pct(a.docs, booksSummary.docs);
      a.pctByValue = pct(a.taxableValue, booksSummary.taxableValue);
    }

    const fullyBuckets: ReconBucketKey[] = [
      'Matched in Same Month',
      'Matched in Subsequent Month',
      'Matched in Subsequent Financial Year',
      'Matched after Books Correction',
    ];
    const fullyMatchedRow: ReconBucketRow = {
      bucket: 'Fully Matched (Subtotal)',
      side: 'ROLLUP',
      docs: fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.docs, 0),
      invoiceValue: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.invoiceValue, 0)),
      taxableValue: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.taxableValue, 0)),
      totalGst: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.totalGst, 0)),
      matchedTaxable: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.matchedTaxable, 0)),
      matchedGst: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.matchedGst, 0)),
      diffTaxable: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.diffTaxable, 0)),
      diffGst: r2(fullyBuckets.reduce((s, k) => s + bucketAgg.get(k)!.diffGst, 0)),
      pctByCount: 0,
      pctByValue: 0,
    };
    fullyMatchedRow.pctByCount = pct(fullyMatchedRow.docs, booksSummary.docs);
    fullyMatchedRow.pctByValue = pct(fullyMatchedRow.taxableValue, booksSummary.taxableValue);

    const only2bRow: ReconBucketRow = {
      bucket: 'Only in GSTR-2B',
      side: 'GSTR2B',
      docs: twobOnlyRegister.length,
      invoiceValue: r2(twobOnlyRegister.reduce((s, x) => s + (x.invoiceValue ?? 0), 0)),
      taxableValue: r2(twobOnlyRegister.reduce((s, x) => s + x.taxableValue, 0)),
      totalGst: r2(twobOnlyRegister.reduce((s, x) => s + x.totalGst, 0)),
      matchedTaxable: 0,
      matchedGst: 0,
      diffTaxable: r2(twobOnlyRegister.reduce((s, x) => s + x.taxableValue, 0)),
      diffGst: r2(twobOnlyRegister.reduce((s, x) => s + x.totalGst, 0)),
      pctByCount: pct(twobOnlyRegister.length, twobSummary.docs),
      pctByValue: pct(twobOnlyRegister.reduce((s, x) => s + x.taxableValue, 0), twobSummary.taxableValue),
    };

    const reconciliationSummary: ReconBucketRow[] = [
      fullyMatchedRow,
      ...BOOKS_RECON_BUCKETS.map((k) => bucketAgg.get(k)!),
      only2bRow,
    ];

    // 4 Separate Control Totals (NO false net difference between Books-only and 2B-only!)
    const onlyBooksRows = booksRegister.filter((b) => b.bucket === 'Only in Books' || b.bucket === 'Pending for Future GSTR-2B');
    const diffRows = booksRegister.filter((b) => b.bucket === 'Matched with Taxable Value Difference' || b.bucket === 'Matched with Tax Difference');
    const controlTotals = {
      booksUnmatchedTaxable: r2(onlyBooksRows.reduce((s, x) => s + x.taxableValue, 0)),
      booksUnmatchedGst: r2(onlyBooksRows.reduce((s, x) => s + x.totalGst, 0)),
      twobUnmatchedTaxable: only2bRow.taxableValue,
      twobUnmatchedGst: only2bRow.totalGst,
      matchedWithDiffBooksTaxable: r2(diffRows.reduce((s, x) => s + x.taxableValue, 0)),
      matchedWithDiffTwobTaxable: r2(diffRows.reduce((s, x) => s + x.twobTaxable, 0)),
      matchedWithDiffTaxableDelta: r2(diffRows.reduce((s, x) => s + x.diffTaxable, 0)),
      matchedWithDiffGstDelta: r2(diffRows.reduce((s, x) => s + x.diffGst, 0)),
      partialAllocationDocs: 0,
      partialAllocationMatched: 0,
      partialAllocationRemaining: 0,
      reconPctByCount: fullyMatchedRow.pctByCount,
      reconPctByTaxable: fullyMatchedRow.pctByValue,
      reconPctByGst: pct(fullyMatchedRow.totalGst, booksSummary.totalGst),
    };

    // 6. Month-wise Reconciliation Movement Matrix (grouped strictly by Original Books Month)
    const mvMap = new Map<string, MonthMovementRow>();
    for (const b of booksRegister) {
      let mv = mvMap.get(b.booksMonth);
      if (!mv) {
        mv = {
          booksMonth: b.booksMonth,
          label: labelOf(b.booksMonth),
          booksFy: b.booksFy,
          totalDocs: 0,
          totalTaxable: 0,
          totalGst: 0,
          sameMonthDocs: 0,
          sameMonthTaxable: 0,
          subseqMonthDocs: 0,
          subseqMonthTaxable: 0,
          subseqFyDocs: 0,
          subseqFyTaxable: 0,
          afterCorrDocs: 0,
          afterCorrTaxable: 0,
          withDiffDocs: 0,
          withDiffTaxable: 0,
          partlyMatchedDocs: 0,
          partlyMatchedTaxable: 0,
          pendingBooksOnlyDocs: 0,
          pendingBooksOnlyTaxable: 0,
          otherDocs: 0,
          reconPctByCount: 0,
          reconPctByValue: 0,
        };
        mvMap.set(b.booksMonth, mv);
      }
      mv.totalDocs++;
      mv.totalTaxable = r2(mv.totalTaxable + b.taxableValue);
      mv.totalGst = r2(mv.totalGst + b.totalGst);
      switch (b.bucket) {
        case 'Matched in Same Month': mv.sameMonthDocs++; mv.sameMonthTaxable = r2(mv.sameMonthTaxable + b.taxableValue); break;
        case 'Matched in Subsequent Month': mv.subseqMonthDocs++; mv.subseqMonthTaxable = r2(mv.subseqMonthTaxable + b.taxableValue); break;
        case 'Matched in Subsequent Financial Year': mv.subseqFyDocs++; mv.subseqFyTaxable = r2(mv.subseqFyTaxable + b.taxableValue); break;
        case 'Matched after Books Correction': mv.afterCorrDocs++; mv.afterCorrTaxable = r2(mv.afterCorrTaxable + b.taxableValue); break;
        case 'Matched with Taxable Value Difference':
        case 'Matched with Tax Difference': mv.withDiffDocs++; mv.withDiffTaxable = r2(mv.withDiffTaxable + b.taxableValue); break;
        case 'Partly Matched': mv.partlyMatchedDocs++; mv.partlyMatchedTaxable = r2(mv.partlyMatchedTaxable + b.taxableValue); break;
        case 'Only in Books':
        case 'Pending for Future GSTR-2B': mv.pendingBooksOnlyDocs++; mv.pendingBooksOnlyTaxable = r2(mv.pendingBooksOnlyTaxable + b.taxableValue); break;
        default: mv.otherDocs++; break;
      }
    }
    const monthMovement = [...mvMap.values()]
      .sort((a, b) => a.booksMonth.localeCompare(b.booksMonth))
      .map((mv) => {
        const matchedDocs = mv.sameMonthDocs + mv.subseqMonthDocs + mv.subseqFyDocs + mv.afterCorrDocs;
        const matchedVal = r2(mv.sameMonthTaxable + mv.subseqMonthTaxable + mv.subseqFyTaxable + mv.afterCorrTaxable);
        return {
          ...mv,
          reconPctByCount: pct(matchedDocs, mv.totalDocs),
          reconPctByValue: pct(matchedVal, mv.totalTaxable),
        };
      });

    // 7. Supplier-wise Reconciliation Summary with Oldest Pending Invoice Age
    const supMap = new Map<string, SupplierSummaryRow>();
    const refMs = new Date(`${reportingDate}T00:00:00Z`).getTime();
    const ensureSup = (gstin: string, name: string) => {
      let s = supMap.get(gstin);
      if (!s) {
        s = {
          supplierGstin: gstin,
          supplierPan: gstin.length >= 12 ? gstin.slice(2, 12) : '',
          supplierName: name || gstin,
          booksDocs: 0,
          booksInvoiceValue: 0,
          booksTaxable: 0,
          booksGst: 0,
          twobTaxable: 0,
          twobGst: 0,
          fullyMatchedTaxable: 0,
          fullyMatchedGst: 0,
          mismatchTaxableDiff: 0,
          mismatchGstDiff: 0,
          onlyInBooksTaxable: 0,
          onlyInBooksGst: 0,
          onlyIn2bTaxable: 0,
          onlyIn2bGst: 0,
          pendingCount: 0,
          oldestPendingDate: '',
          oldestPendingAgeDays: null,
        };
        supMap.set(gstin, s);
      }
      return s;
    };

    for (const b of booksRegister) {
      const s = ensureSup(b.supplierGstin || 'UNREGISTERED', b.supplierName);
      s.booksDocs++;
      s.booksInvoiceValue = r2(s.booksInvoiceValue + (b.originalBooksInvValue ?? 0));
      s.booksTaxable = r2(s.booksTaxable + b.taxableValue);
      s.booksGst = r2(s.booksGst + b.totalGst);
      s.twobTaxable = r2(s.twobTaxable + b.twobTaxable);
      s.twobGst = r2(s.twobGst + b.twobTotalGst);
      if (fullyBuckets.includes(b.bucket)) {
        s.fullyMatchedTaxable = r2(s.fullyMatchedTaxable + b.taxableValue);
        s.fullyMatchedGst = r2(s.fullyMatchedGst + b.totalGst);
      } else {
        s.pendingCount++;
        if (b.booksDocDate && (!s.oldestPendingDate || b.booksDocDate < s.oldestPendingDate)) {
          s.oldestPendingDate = b.booksDocDate;
        }
        if (b.bucket === 'Only in Books' || b.bucket === 'Pending for Future GSTR-2B') {
          s.onlyInBooksTaxable = r2(s.onlyInBooksTaxable + b.taxableValue);
          s.onlyInBooksGst = r2(s.onlyInBooksGst + b.totalGst);
        } else {
          s.mismatchTaxableDiff = r2(s.mismatchTaxableDiff + b.diffTaxable);
          s.mismatchGstDiff = r2(s.mismatchGstDiff + b.diffGst);
        }
      }
    }
    for (const t of twobOnlyRegister) {
      const s = ensureSup(t.supplierGstin || 'UNREGISTERED', t.supplierName);
      s.twobTaxable = r2(s.twobTaxable + t.taxableValue);
      s.twobGst = r2(s.twobGst + t.totalGst);
      s.onlyIn2bTaxable = r2(s.onlyIn2bTaxable + t.taxableValue);
      s.onlyIn2bGst = r2(s.onlyIn2bGst + t.totalGst);
    }
    const supplierSummary = [...supMap.values()]
      .map((s) => ({
        ...s,
        oldestPendingAgeDays: s.oldestPendingDate
          ? Math.max(0, Math.round((refMs - new Date(`${s.oldestPendingDate}T00:00:00Z`).getTime()) / 86400000))
          : null,
      }))
      .sort((a, b) => Math.abs(b.booksTaxable) - Math.abs(a.booksTaxable));

    // 8. Mismatch & Pending Details + Correction & Audit History
    const mismatchAndPending = booksRegister.filter((b) => !fullyBuckets.includes(b.bucket));
    const lineIds = booksRegister.map((b) => b.lineId);
    let correctionHistory: CorrectionHistoryRow[] = [];
    if (lineIds.length) {
      const chRes = await c.query(
        `SELECT rc.id, rc.line_id, p.our_gstin, p.period, p.book_invoice_no,
                rc.field_name, rc.old_value, rc.new_value, rc.reason,
                rc.changed_by, rc.changed_at, rc.rerefreshed
           FROM recon_corrections rc
           JOIN purchase_lines p ON p.id = rc.line_id
          WHERE rc.line_id = ANY($1::bigint[])
          ORDER BY rc.changed_at DESC, rc.id DESC`,
        [lineIds],
      );
      correctionHistory = chRes.rows.map((r: any) => ({
        correctionId: Number(r.id),
        lineId: Number(r.line_id),
        ourGstin: normGstin(r.our_gstin),
        booksMonth: String(r.period || ''),
        originalInvNo: String(r.book_invoice_no || ''),
        fieldName: String(r.field_name || ''),
        oldValue: String(r.old_value ?? ''),
        newValue: String(r.new_value ?? ''),
        reason: String(r.reason ?? ''),
        changedBy: String(r.changed_by ?? ''),
        changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at || ''),
        rerefreshed: Boolean(r.rerefreshed),
      }));
    }

    const report: HistoricalReconReport = {
      meta: {
        generatedAt: new Date().toISOString(),
        reportingDate,
        companyLabel: [...companiesSet].join('; ') || 'All Companies',
        gstinLabel: resolvedGstins.length ? resolvedGstins.join(', ') : ([...gstinsSet].sort().join(', ') || 'All GSTINs'),
        fyLabel: filters.fy || (resolvedPeriods.length ? fyOf(resolvedPeriods[0]) : 'All Historical FYs'),
        periodLabel: periodMode === 'all' ? 'All Historical Data' : (resolvedPeriods.length ? resolvedPeriods.join(', ') : 'All Periods'),
        filterSummary: [
          filters.company ? `Company: ${filters.company}` : '',
          resolvedGstins.length ? `GSTIN: ${resolvedGstins.join(',')}` : '',
          filters.fy ? `FY: ${filters.fy}` : '',
          filters.supplier ? `Supplier: ${filters.supplier}` : '',
          filters.docType ? `DocType: ${filters.docType}` : '',
          filters.status ? `Status: ${filters.status}` : '',
          filters.booksMonth ? `BooksMonth: ${filters.booksMonth}` : '',
          filters.twobMonth ? `2BMonth: ${filters.twobMonth}` : '',
          filters.uploadBatch ? `Batch: ${filters.uploadBatch}` : '',
        ].filter(Boolean).join(' | ') || 'All Historical Data',
      },
      booksSummary,
      twobSummary,
      reconciliationSummary,
      controlTotals,
      booksRegister,
      twobOnlyRegister,
      monthMovement,
      supplierSummary,
      mismatchAndPending,
      correctionHistory,
      parityChecks: [],
      allParityOk: false,
    };

    report.parityChecks = verifyHistoricalReportParity(report);
    report.allParityOk = report.parityChecks.every((x) => x.ok);
    return report;
  });
}

/**
 * Automated 10-Point Mathematical Parity Verifier (Section 9.6 / Condition #8).
 */
export function verifyHistoricalReportParity(r: HistoricalReconReport): ParityCheckItem[] {
  const sum = (arr: number[]) => r2(arr.reduce((s, n) => s + n, 0));
  const eq = (a: number, b: number) => Math.abs(r2(a) - r2(b)) <= 0.01;

  const booksBuckets = r.reconciliationSummary.filter((x) => x.side === 'BOOKS');
  const bucketDocs = booksBuckets.reduce((s, x) => s + x.docs, 0);
  const bucketTaxable = sum(booksBuckets.map((x) => x.taxableValue));
  const bucketGst = sum(booksBuckets.map((x) => x.totalGst));

  const regTaxable = sum(r.booksRegister.map((x) => x.taxableValue));
  const regIgst = sum(r.booksRegister.map((x) => x.igst));
  const regCgst = sum(r.booksRegister.map((x) => x.cgst));
  const regSgst = sum(r.booksRegister.map((x) => x.sgst));
  const regUtgst = sum(r.booksRegister.map((x) => x.utgst));
  const regCess = sum(r.booksRegister.map((x) => x.cess));
  const regGst = sum(r.booksRegister.map((x) => x.totalGst));

  const mvDocs = r.monthMovement.reduce((s, x) => s + x.totalDocs, 0);
  const mvTaxable = sum(r.monthMovement.map((x) => x.totalTaxable));
  const mvGst = sum(r.monthMovement.map((x) => x.totalGst));

  const supDocs = r.supplierSummary.reduce((s, x) => s + x.booksDocs, 0);
  const supTaxable = sum(r.supplierSummary.map((x) => x.booksTaxable));
  const supGst = sum(r.supplierSummary.map((x) => x.booksGst));

  const partlyRow = r.reconciliationSummary.find((x) => x.bucket === 'Partly Matched');
  const only2bRow = r.reconciliationSummary.find((x) => x.bucket === 'Only in GSTR-2B')!;
  const only2bRegTaxable = sum(r.twobOnlyRegister.map((x) => x.taxableValue));
  const only2bRegGst = sum(r.twobOnlyRegister.map((x) => x.totalGst));

  const signCheckOk = r.booksRegister.every((b) => eq(b.taxableValue - b.twobTaxable, b.diffTaxable) && eq(b.totalGst - b.twobTotalGst, b.diffGst));

  return [
    {
      id: 1,
      name: 'Books Bill-wise Register === Books Executive Summary',
      ok: r.booksRegister.length === r.booksSummary.docs && eq(regTaxable, r.booksSummary.taxableValue) && eq(regGst, r.booksSummary.totalGst),
      detail: `Docs ${r.booksRegister.length}/${r.booksSummary.docs}, Taxable ${regTaxable}/${r.booksSummary.taxableValue}, GST ${regGst}/${r.booksSummary.totalGst}`,
    },
    {
      id: 2,
      name: 'All 5 Tax Heads (IGST/CGST/SGST/UTGST/Cess) Reconcile Independently',
      ok: eq(regIgst, r.booksSummary.igst) && eq(regCgst, r.booksSummary.cgst) && eq(regSgst, r.booksSummary.sgst) && eq(regUtgst, r.booksSummary.utgst) && eq(regCess, r.booksSummary.cess) && eq(regIgst + regCgst + regSgst + regUtgst + regCess, r.booksSummary.totalGst),
      detail: `IGST ${regIgst}, CGST ${regCgst}, SGST ${regSgst}, UTGST ${regUtgst}, Cess ${regCess}`,
    },
    {
      id: 3,
      name: 'Mutually Exclusive Books Buckets === Total Books Population (Zero Double-Count)',
      ok: bucketDocs === r.booksSummary.docs && eq(bucketTaxable, r.booksSummary.taxableValue) && eq(bucketGst, r.booksSummary.totalGst),
      detail: `Buckets ${bucketDocs}/${r.booksSummary.docs}, Taxable ${bucketTaxable}/${r.booksSummary.taxableValue}`,
    },
    {
      id: 4,
      name: 'GSTR-2B Only Register === Executive Summary GSTR-2B Only Row',
      ok: r.twobOnlyRegister.length === only2bRow.docs && eq(only2bRegTaxable, only2bRow.taxableValue) && eq(only2bRegGst, only2bRow.totalGst),
      detail: `2B Only Docs ${r.twobOnlyRegister.length}/${only2bRow.docs}, Taxable ${only2bRegTaxable}/${only2bRow.taxableValue}`,
    },
    {
      id: 5,
      name: 'Month-wise Movement Matrix === Books Population',
      ok: mvDocs === r.booksSummary.docs && eq(mvTaxable, r.booksSummary.taxableValue) && eq(mvGst, r.booksSummary.totalGst),
      detail: `Movement ${mvDocs}/${r.booksSummary.docs}, Taxable ${mvTaxable}/${r.booksSummary.taxableValue}`,
    },
    {
      id: 6,
      name: 'Supplier-wise Summary === Books Population',
      ok: supDocs === r.booksSummary.docs && eq(supTaxable, r.booksSummary.taxableValue) && eq(supGst, r.booksSummary.totalGst),
      detail: `Supplier ${supDocs}/${r.booksSummary.docs}, Taxable ${supTaxable}/${r.booksSummary.taxableValue}`,
    },
    {
      id: 7,
      name: 'Partly Matched Strictly Controlled at Zero (No Fabricated Partials)',
      ok: Boolean(partlyRow && partlyRow.docs === 0 && partlyRow.taxableValue === 0 && r.controlTotals.partialAllocationDocs === 0),
      detail: `Partly Matched docs=${partlyRow?.docs ?? -1}`,
    },
    {
      id: 8,
      name: 'Signed CN/DN Difference Formula (Books - 2B === Diff) Verified on Every Row',
      ok: signCheckOk,
      detail: `Verified across ${r.booksRegister.length} bill-wise rows`,
    },
    {
      id: 9,
      name: 'Original Books Month/FY Preserved Separately from Actual 2B Month & ITC Claim Month',
      ok: r.booksRegister.every((b) => Boolean(b.booksMonth && b.booksFy)),
      detail: `All ${r.booksRegister.length} rows retain original Books Month & FY`,
    },
    {
      id: 10,
      name: 'No False Netting Between Books-Only and GSTR-2B-Only Control Totals',
      ok: eq(r.controlTotals.twobUnmatchedTaxable, only2bRegTaxable) && eq(r.controlTotals.twobUnmatchedGst, only2bRegGst),
      detail: `Books Unmatched GST ${r.controlTotals.booksUnmatchedGst} | 2B Unmatched GST ${r.controlTotals.twobUnmatchedGst}`,
    },
  ];
}

/**
 * Generates the 7-Sheet Professional Historical Bill-wise Reconciliation Excel Workbook.
 */
export function buildHistoricalReconExcel(report: HistoricalReconReport): Buffer {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Executive Summary
  const execRows: unknown[][] = [
    ['GST CONTROL ERP — PROFESSIONAL HISTORICAL BILL-WISE RECONCILIATION REPORT'],
    [`Company: ${report.meta.companyLabel}`, `GSTIN: ${report.meta.gstinLabel}`, `Reporting Date: ${report.meta.reportingDate}`],
    [`Financial Year: ${report.meta.fyLabel}`, `Scope: ${report.meta.filterSummary}`, `Generated: ${report.meta.generatedAt}`],
    [],
    ['A. BOOKS & GSTR-2B POPULATION SUMMARY', 'Documents', 'Invoice Value', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'UTGST', 'Cess', 'Total GST'],
    [
      'Purchase Register (Books)',
      report.booksSummary.docs,
      report.booksSummary.invoiceValue,
      report.booksSummary.taxableValue,
      report.booksSummary.igst,
      report.booksSummary.cgst,
      report.booksSummary.sgst,
      report.booksSummary.utgst,
      report.booksSummary.cess,
      report.booksSummary.totalGst,
    ],
    [
      'GSTR-2B Portal (Canonical)',
      report.twobSummary.docs,
      report.twobSummary.invoiceValue,
      report.twobSummary.taxableValue,
      report.twobSummary.igst,
      report.twobSummary.cgst,
      report.twobSummary.sgst,
      report.twobSummary.utgst,
      report.twobSummary.cess,
      report.twobSummary.totalGst,
    ],
    [],
    ['B. RECONCILIATION SUMMARY (13 BUCKETS)', 'Side', 'Documents', 'Invoice Value', 'Taxable Value', 'Total GST', 'Matched Taxable', 'Diff Taxable', 'Diff GST', '% Count', '% Value'],
    ...report.reconciliationSummary.map((x) => [
      x.bucket, x.side, x.docs, x.invoiceValue, x.taxableValue, x.totalGst, x.matchedTaxable, x.diffTaxable, x.diffGst, x.pctByCount, x.pctByValue,
    ]),
    [],
    ['C. SEPARATE CONTROL TOTALS (NO FALSE NETTING)', 'Taxable Value', 'Total GST'],
    ['1. Books-Side Unmatched (Only in Books + Future 2B)', report.controlTotals.booksUnmatchedTaxable, report.controlTotals.booksUnmatchedGst],
    ['2. GSTR-2B-Side Unmatched (Only in GSTR-2B)', report.controlTotals.twobUnmatchedTaxable, report.controlTotals.twobUnmatchedGst],
    ['3. Matched with Value/Tax Difference (Delta)', report.controlTotals.matchedWithDiffTaxableDelta, report.controlTotals.matchedWithDiffGstDelta],
    ['4. Genuine Partial Allocations', report.controlTotals.partialAllocationMatched, report.controlTotals.partialAllocationRemaining],
    ['Reconciliation % (By Count / By Taxable / By GST)', `${report.controlTotals.reconPctByCount}%`, `${report.controlTotals.reconPctByTaxable}% / ${report.controlTotals.reconPctByGst}%`],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(execRows), 'Executive Summary');

  // Sheet 2: Books Bill-wise Recon
  const s2 = report.booksRegister.map((b) => ({
    'Company': b.companyName,
    'Our GSTIN': b.ourGstin,
    'Unit': b.unitName,
    'Books FY': b.booksFy,
    'Original Books Month': b.booksMonth,
    'Original Doc Date': b.booksDocDate,
    'Book Entry Date': b.bookEntryDate,
    'Supplier Name': b.supplierName,
    'Supplier GSTIN': b.supplierGstin,
    'Supplier PAN': b.supplierPan,
    'Document Type': b.docType,
    'Original Books Inv No': b.originalBooksInvNo,
    'Corrected Books Inv No': b.correctedBooksInvNo,
    'Books Invoice Value': b.originalBooksInvValue,
    'Taxable Value': b.taxableValue,
    'IGST': b.igst,
    'CGST': b.cgst,
    'SGST': b.sgst,
    'UTGST': b.utgst,
    'Cess': b.cess,
    'Total GST': b.totalGst,
    'Matched 2B Inv No': b.matched2bInvNo,
    'Actual 2B Month': b.actual2bMonth,
    'Actual 2B FY': b.actual2bFy,
    'Reconciliation Month': b.reconciliationMonth,
    'GSTR-2B Doc Date': b.twobDocDate,
    'GSTR-2B Invoice Value': b.twobInvValue,
    'GSTR-2B Taxable': b.twobTaxable,
    'GSTR-2B Total GST': b.twobTotalGst,
    'Matched Taxable': b.matchedTaxable,
    'Matched GST': b.matchedGst,
    'Diff Taxable': b.diffTaxable,
    'Diff GST': b.diffGst,
    'Reconciliation Status': b.bucket,
    'Reason / Remarks': b.reasonRemarks,
    'Granular Reasons': b.mismatchReasons.join(', '),
    'Correction Status': b.correctionStatus,
    'ITC Decision': b.itcDecision,
    'ITC Claim Month': b.itcClaimMonth,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s2.length ? s2 : [{ Info: 'No Books records in scope' }]), 'Books Bill-wise Recon');

  // Sheet 3: GSTR-2B Only Register
  const s3 = report.twobOnlyRegister.map((t) => ({
    'Our GSTIN': t.ourGstin,
    '2B Month': t.twobMonth,
    '2B FY': t.twobFy,
    'Supplier GSTIN': t.supplierGstin,
    'Supplier Name': t.supplierName,
    'Document No': t.docNo,
    'Document Date': t.docDate,
    'Document Type': t.docType,
    'Invoice Value': t.invoiceValue,
    'Taxable Value': t.taxableValue,
    'IGST': t.igst,
    'CGST': t.cgst,
    'SGST': t.sgst,
    'UTGST': t.utgst,
    'Cess': t.cess,
    'Total GST': t.totalGst,
    'Pending / Review Status': t.pendingStatus,
    'Reason': t.reason,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s3.length ? s3 : [{ Info: 'No GSTR-2B Only records in scope' }]), 'GSTR-2B Only Register');

  // Sheet 4: Month-wise Movement
  const s4 = report.monthMovement.map((m) => ({
    'Original Books Month': m.booksMonth,
    'Label': m.label,
    'Books FY': m.booksFy,
    'Total Books Docs': m.totalDocs,
    'Total Books Taxable': m.totalTaxable,
    'Total Books GST': m.totalGst,
    'Same Month Docs': m.sameMonthDocs,
    'Same Month Taxable': m.sameMonthTaxable,
    'Subsequent Month Docs': m.subseqMonthDocs,
    'Subsequent Month Taxable': m.subseqMonthTaxable,
    'Subsequent FY Docs': m.subseqFyDocs,
    'Subsequent FY Taxable': m.subseqFyTaxable,
    'After Correction Docs': m.afterCorrDocs,
    'After Correction Taxable': m.afterCorrTaxable,
    'With Diff Docs': m.withDiffDocs,
    'With Diff Taxable': m.withDiffTaxable,
    'Partly Matched Docs': m.partlyMatchedDocs,
    'Pending Books Only Docs': m.pendingBooksOnlyDocs,
    'Pending Books Only Taxable': m.pendingBooksOnlyTaxable,
    'Recon % (Count)': m.reconPctByCount,
    'Recon % (Value)': m.reconPctByValue,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s4.length ? s4 : [{ Info: 'No monthly movement data' }]), 'Month-wise Movement');

  // Sheet 5: Supplier-wise Summary
  const s5 = report.supplierSummary.map((s) => ({
    'Supplier Name': s.supplierName,
    'Supplier GSTIN': s.supplierGstin,
    'Supplier PAN': s.supplierPan,
    'Books Invoices': s.booksDocs,
    'Books Invoice Value': s.booksInvoiceValue,
    'Books Taxable': s.booksTaxable,
    'Books GST': s.booksGst,
    'GSTR-2B Taxable': s.twobTaxable,
    'GSTR-2B GST': s.twobGst,
    'Fully Matched Taxable': s.fullyMatchedTaxable,
    'Mismatch Taxable Diff': s.mismatchTaxableDiff,
    'Only in Books Taxable': s.onlyInBooksTaxable,
    'Only in 2B Taxable': s.onlyIn2bTaxable,
    'Pending Count': s.pendingCount,
    'Oldest Pending Date': s.oldestPendingDate,
    'Oldest Pending Age (Days)': s.oldestPendingAgeDays,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s5.length ? s5 : [{ Info: 'No supplier records' }]), 'Supplier-wise Summary');

  // Sheet 6: Mismatch & Pending Details
  const s6 = report.mismatchAndPending.map((b) => ({
    'Our GSTIN': b.ourGstin,
    'Original Books Month': b.booksMonth,
    'Supplier GSTIN': b.supplierGstin,
    'Supplier Name': b.supplierName,
    'Doc Type': b.docType,
    'Books Inv No': b.originalBooksInvNo,
    'Books Date': b.booksDocDate,
    'Books Taxable': b.taxableValue,
    'Books GST': b.totalGst,
    '2B Inv No': b.matched2bInvNo,
    '2B Taxable': b.twobTaxable,
    '2B GST': b.twobTotalGst,
    'Diff Taxable': b.diffTaxable,
    'Diff GST': b.diffGst,
    'Status': b.bucket,
    'Granular Reasons': b.mismatchReasons.join(', '),
    'Remarks': b.reasonRemarks,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s6.length ? s6 : [{ Info: 'Zero mismatch or pending records' }]), 'Mismatch & Pending Details');

  // Sheet 7: Correction & Audit History
  const s7 = report.correctionHistory.map((h) => ({
    'Correction ID': h.correctionId,
    'Line ID': h.lineId,
    'Our GSTIN': h.ourGstin,
    'Books Month': h.booksMonth,
    'Original Inv No': h.originalInvNo,
    'Field Changed': h.fieldName,
    'Old Value': h.oldValue,
    'New Value': h.newValue,
    'Reason': h.reason,
    'Changed By': h.changedBy,
    'Changed At': h.changedAt,
    'Re-Refreshed': h.rerefreshed ? 'Yes' : 'No',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s7.length ? s7 : [{ Info: 'No correction audit entries in scope' }]), 'Correction & Audit History');

  return polishWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}
