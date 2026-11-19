/**
 * GST ERP — Independent IMS vs Purchase Register Matching & Recommendation Engine (Parts 6 & 11).
 *
 * Completely independent from GSTR-2B!
 *   - Never touches GSTR-2B statuses or ITC decisions.
 *   - Never matches across different Our GSTINs or Supplier GSTINs.
 *   - Never matches across Document Types (Tax Invoice ↔ Tax Invoice, DN ↔ DN, CN ↔ CN).
 *   - Never matches by amount alone; never auto-matches 1 Books bill to multiple IMS docs.
 *   - Preserves verbatim `portal_matching_key` and labels `internal_match_key` separately.
 */

import {
  normDocType,
  normGstin,
  normInvoice,
  r2,
  taxOf,
  withinTolerance,
  type DocType,
} from './core';

export const IMS_RECON_STATUSES = [
  'MATCHED — IMS vs BOOKS',
  'MATCHED WITH TAX DIFFERENCE',
  'MATCHED WITH TAXABLE DIFFERENCE',
  'MATCHED WITH DOCUMENT DATE DIFFERENCE',
  'IMS ONLY',
  'BOOKS ONLY',
  'DOCUMENT NUMBER MISMATCH',
  'SUPPLIER GSTIN MISMATCH',
  'DOCUMENT TYPE MISMATCH',
  'POSSIBLE DUPLICATE',
  'DUPLICATE REJECTED',
  'PENDING MANUAL REVIEW',
  'MANUALLY LINKED AFTER CONFIRMATION',
] as const;
export type ImsReconStatus = (typeof IMS_RECON_STATUSES)[number];

export const IMS_ACTIONS = [
  'ACCEPT',
  'REJECT',
  'PENDING',
  'DO NOT TAKE ANY ACTION',
] as const;
export type ImsUserAction = (typeof IMS_ACTIONS)[number];

export const IMS_WORKFLOW_STATES = [
  'NOT READY',
  'READY FOR REVIEW',
  'APPROVED BY USER',
  'UPLOAD PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'NOT UPLOADED',
  'ERROR REVIEW REQUIRED',
] as const;
export type ImsWorkflowState = (typeof IMS_WORKFLOW_STATES)[number];

export interface ImsSourceDocForRecon {
  id: number;
  our_gstin: string;
  supplier_gstin: string;
  supplier_name: string;
  doc_category: string;
  document_type: DocType;
  document_no: string;
  document_date: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  portal_matching_key: string;
  ims_source_action: string;
  ims_source_status: string;
  gstr1_period?: string;
  itc_reduction_required?: boolean;
}

export interface BookLineForImsRecon {
  id: number;
  our_gstin: string;
  period: string;
  supplier_gstin: string;
  recon_supplier_gstin: string;
  party_name: string;
  document_type: DocType;
  invoice_no: string;
  recon_invoice_no: string;
  invoice_date: string;
  recon_invoice_date: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface ImsMatchOutcomeRow {
  our_gstin: string;
  books_period: string | null;
  ims_doc_id: number | null;
  purchase_line_id: number | null;
  recon_status: ImsReconStatus;
  portal_matching_key: string;
  internal_match_key: string;
  taxable_diff: number | null;
  igst_diff: number | null;
  cgst_diff: number | null;
  sgst_diff: number | null;
  cess_diff: number | null;
  total_tax_diff: number | null;
  date_diff_days: number | null;
  recommended_action: ImsUserAction;
  supported_actions: ImsUserAction[];
  recommendation_reason: string;
  remarks: string;
}

export interface ImsReconcileOutput {
  results: ImsMatchOutcomeRow[];
  summary: {
    total_ims: number;
    total_books: number;
    matched: number;
    tax_or_taxable_mismatch: number;
    date_or_doc_mismatch: number;
    ims_only: number;
    books_only: number;
    duplicates: number;
  };
}

function daysBetweenIso(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a));
  const mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b));
  if (!ma || !mb) return null;
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round(Math.abs(ta - tb) / 86400000);
}

export function internalKeyOf(
  ourGstin: string,
  supGstin: string,
  docType: DocType,
  docNo: string,
): string {
  return `INT|${normGstin(ourGstin)}|${normGstin(supGstin)}|${docType}|${normInvoice(docNo)}`;
}

/** Determine which IMS portal actions are legally/workflow supported for this document. */
export function supportedActionsForIms(opts: {
  docCategory?: string;
  documentType?: DocType | string;
  itcReductionRequired?: boolean;
  reconStatus: ImsReconStatus;
  hasImsDoc: boolean;
}): ImsUserAction[] {
  if (!opts.hasImsDoc || opts.reconStatus === 'BOOKS ONLY') {
    return ['DO NOT TAKE ANY ACTION'];
  }
  const cat = String(opts.docCategory || 'B2B').toUpperCase();
  const dt = normDocType(opts.documentType || 'Tax Invoice');
  // Per GST Portal IMS workflow rules: recipient cannot mark Credit Notes / certain amended records
  // requiring ITC reduction or B2BA/CDNRA upward revisions as PENDING; only ACCEPT/REJECT/NO ACTION apply.
  const pendingRestricted =
    Boolean(opts.itcReductionRequired) ||
    dt === 'Credit Note' ||
    cat === 'B2BA' ||
    cat === 'CDNRA' ||
    cat === 'CDNR';

  return pendingRestricted
    ? ['ACCEPT', 'REJECT', 'DO NOT TAKE ANY ACTION']
    : ['ACCEPT', 'REJECT', 'PENDING', 'DO NOT TAKE ANY ACTION'];
}

/** Generate transparent, rule-based IMS recommendation (`GET IMS SECTION RECOMMENDATION`). */
export function recommendImsAction(input: {
  docCategory?: string;
  documentType?: DocType | string;
  itcReductionRequired?: boolean;
  reconStatus: ImsReconStatus;
  hasImsDoc: boolean;
  taxableDiff?: number | null;
  totalTaxDiff?: number | null;
  dateDiffDays?: number | null;
}): {
  recommendedAction: ImsUserAction;
  supportedActions: ImsUserAction[];
  reason: string;
} {
  const supported = supportedActionsForIms(input);
  const pickSupported = (pref: ImsUserAction, fallback: ImsUserAction): ImsUserAction =>
    supported.includes(pref) ? pref : supported.includes(fallback) ? fallback : supported[0];

  if (!input.hasImsDoc || input.reconStatus === 'BOOKS ONLY') {
    return {
      recommendedAction: 'DO NOT TAKE ANY ACTION',
      supportedActions: supported,
      reason: 'Document exists in Books only (absent from IMS portal). Follow up with supplier to report in GSTR-1/IFF.',
    };
  }

  switch (input.reconStatus) {
    case 'MATCHED — IMS vs BOOKS':
    case 'MANUALLY LINKED AFTER CONFIRMATION':
      return {
        recommendedAction: 'ACCEPT',
        supportedActions: supported,
        reason: 'Matched with Purchase Register on GSTIN, Doc Type, Doc No, Date & all Tax components. Final ITC eligibility remains separate.',
      };

    case 'MATCHED WITH DOCUMENT DATE DIFFERENCE': {
      const rec = pickSupported('PENDING', 'ACCEPT');
      return {
        recommendedAction: rec,
        supportedActions: supported,
        reason: `Amounts match but Document Date differs by ${input.dateDiffDays ?? '?'} day(s). Verify date before accepting.`,
      };
    }

    case 'MATCHED WITH TAX DIFFERENCE':
    case 'MATCHED WITH TAXABLE DIFFERENCE': {
      const rec = pickSupported('PENDING', 'REJECT');
      return {
        recommendedAction: rec,
        supportedActions: supported,
        reason: `Value/Tax variance (Taxable diff: ${input.taxableDiff ?? 0}, Tax diff: ${input.totalTaxDiff ?? 0}). Hold Pending or Reject per supplier reconciliation.`,
      };
    }

    case 'DUPLICATE REJECTED':
    case 'DOCUMENT TYPE MISMATCH':
    case 'SUPPLIER GSTIN MISMATCH':
      return {
        recommendedAction: 'REJECT',
        supportedActions: supported,
        reason: `${input.reconStatus} — Reject or resolve discrepancy on GST Portal before taking ITC.`,
      };

    case 'POSSIBLE DUPLICATE':
    case 'DOCUMENT NUMBER MISMATCH':
    case 'PENDING MANUAL REVIEW': {
      const rec = pickSupported('PENDING', 'DO NOT TAKE ANY ACTION');
      return {
        recommendedAction: rec,
        supportedActions: supported,
        reason: `${input.reconStatus} — Requires accounts team manual verification prior to final Accept/Reject.`,
      };
    }

    case 'IMS ONLY':
    default: {
      const rec = pickSupported('PENDING', 'DO NOT TAKE ANY ACTION');
      return {
        recommendedAction: rec,
        supportedActions: supported,
        reason: input.itcReductionRequired
          ? 'IMS Only document with ITC reduction flag — verify credit note / inward supply in Books before Reject/Accept.'
          : 'Document present in IMS Portal but not in selected Purchase Register period(s). Hold Pending or check unbooked bills.',
      };
    }
  }
}

export function reconcileImsVsBooks(
  imsDocs: ImsSourceDocForRecon[],
  bookLines: BookLineForImsRecon[],
  opts: { tolerance?: number } = {},
): ImsReconcileOutput {
  const tolerance = opts.tolerance ?? 1;
  const results: ImsMatchOutcomeRow[] = [];

  // Index Books by strict tuple: our_gstin | supplier_gstin | docType | normDocNo
  const booksByStrictKey = new Map<string, BookLineForImsRecon[]>();
  const booksByInvOnly = new Map<string, BookLineForImsRecon[]>();
  const booksBySupplierType = new Map<string, BookLineForImsRecon[]>();

  for (const b of bookLines) {
    const og = normGstin(b.our_gstin);
    const sg = normGstin(b.recon_supplier_gstin || b.supplier_gstin);
    const dt = normDocType(b.document_type);
    const dn = normInvoice(b.recon_invoice_no || b.invoice_no);
    const sk = internalKeyOf(og, sg, dt, dn);
    if (!booksByStrictKey.has(sk)) booksByStrictKey.set(sk, []);
    booksByStrictKey.get(sk)!.push(b);

    const invK = `${og}|${dt}|${dn}`;
    if (!booksByInvOnly.has(invK)) booksByInvOnly.set(invK, []);
    booksByInvOnly.get(invK)!.push(b);

    const supK = `${og}|${sg}|${dt}`;
    if (!booksBySupplierType.has(supK)) booksBySupplierType.set(supK, []);
    booksBySupplierType.get(supK)!.push(b);
  }

  // Track duplicate IMS occurrences sharing same strict key + GSTIN
  const imsStrictCount = new Map<string, number>();
  const imsSoftCount = new Map<string, number>();
  for (const d of imsDocs) {
    const sk = internalKeyOf(d.our_gstin, d.supplier_gstin, d.document_type, d.document_no);
    imsStrictCount.set(sk, (imsStrictCount.get(sk) || 0) + 1);
    const softK = `${normGstin(d.our_gstin)}|${normGstin(d.supplier_gstin)}|${d.document_type}|${d.document_date}|${r2(d.taxable_value).toFixed(2)}|${taxOf(d).toFixed(2)}`;
    imsSoftCount.set(softK, (imsSoftCount.get(softK) || 0) + 1);
  }

  const claimedBookIds = new Set<number>();

  for (const ims of imsDocs) {
    const og = normGstin(ims.our_gstin);
    const sg = normGstin(ims.supplier_gstin);
    const dt = normDocType(ims.document_type);
    const dn = normInvoice(ims.document_no);
    const ik = internalKeyOf(og, sg, dt, dn);
    const pmk = String(ims.portal_matching_key || '');

    // Duplicate IMS doc check (multiple un-claimed IMS entries with exact same strict key)
    const strictCands = (booksByStrictKey.get(ik) || []).filter((b) => !claimedBookIds.has(b.id));

    if (strictCands.length > 0) {
      // Pick closest match (exact amounts first, then closest date) without auto-matching 1-to-many
      const scored = strictCands.map((b) => {
        const txDiff = r2(ims.taxable_value - b.taxable_value);
        const igDiff = r2(ims.igst - b.igst);
        const cgDiff = r2(ims.cgst - b.cgst);
        const sgDiff = r2(ims.sgst - b.sgst);
        const ceDiff = r2(ims.cess - b.cess);
        const totTaxIms = taxOf(ims);
        const totTaxBook = taxOf(b);
        const totDiff = r2(totTaxIms - totTaxBook);
        const bDate = b.recon_invoice_date || b.invoice_date;
        const gap = daysBetweenIso(bDate, ims.document_date);
        const exactAmt =
          withinTolerance(txDiff, 0, tolerance) &&
          withinTolerance(totDiff, 0, tolerance) &&
          withinTolerance(igDiff, 0, tolerance) &&
          withinTolerance(cgDiff, 0, tolerance) &&
          withinTolerance(sgDiff, 0, tolerance) &&
          withinTolerance(ceDiff, 0, tolerance);
        return {
          b, txDiff, igDiff, cgDiff, sgDiff, ceDiff, totDiff, gap, exactAmt,
          score: (exactAmt ? 0 : 100000) + (gap ?? 999) + Math.abs(txDiff) + Math.abs(totDiff),
        };
      }).sort((x, y) => x.score - y.score);

      const best = scored[0];
      claimedBookIds.add(best.b.id);

      const taxableBad = !withinTolerance(best.txDiff, 0, tolerance);
      const taxBad =
        !withinTolerance(best.totDiff, 0, tolerance) ||
        !withinTolerance(best.igDiff, 0, tolerance) ||
        !withinTolerance(best.cgDiff, 0, tolerance) ||
        !withinTolerance(best.sgDiff, 0, tolerance) ||
        !withinTolerance(best.ceDiff, 0, tolerance);
      const dateBad = best.gap !== null && best.gap > 0;

      let reconStatus: ImsReconStatus = 'MATCHED — IMS vs BOOKS';
      if (taxableBad) reconStatus = 'MATCHED WITH TAXABLE DIFFERENCE';
      else if (taxBad) reconStatus = 'MATCHED WITH TAX DIFFERENCE';
      else if (dateBad) reconStatus = 'MATCHED WITH DOCUMENT DATE DIFFERENCE';

      const rec = recommendImsAction({
        docCategory: ims.doc_category,
        documentType: dt,
        itcReductionRequired: ims.itc_reduction_required,
        reconStatus,
        hasImsDoc: true,
        taxableDiff: best.txDiff,
        totalTaxDiff: best.totDiff,
        dateDiffDays: best.gap,
      });

      results.push({
        our_gstin: og,
        books_period: best.b.period || null,
        ims_doc_id: ims.id,
        purchase_line_id: best.b.id,
        recon_status: reconStatus,
        portal_matching_key: pmk,
        internal_match_key: ik,
        taxable_diff: best.txDiff,
        igst_diff: best.igDiff,
        cgst_diff: best.cgDiff,
        sgst_diff: best.sgDiff,
        cess_diff: best.ceDiff,
        total_tax_diff: best.totDiff,
        date_diff_days: best.gap,
        recommended_action: rec.recommendedAction,
        supported_actions: rec.supportedActions,
        recommendation_reason: rec.reason,
        remarks: pmk ? `Matched with Portal Matching Key ${pmk}` : 'Matched on strict Books + IMS identity',
      });
      continue;
    }

    // No strict 1-to-1 candidate remaining: diagnose without auto-matching!
    const wasDuplicateIms = (imsStrictCount.get(ik) || 0) > 1 && (booksByStrictKey.get(ik)?.length || 0) > 0;
    const sameSupplierSameKeyDiffType = bookLines.find(
      (b) =>
        normGstin(b.our_gstin) === og &&
        normGstin(b.recon_supplier_gstin || b.supplier_gstin) === sg &&
        normInvoice(b.recon_invoice_no || b.invoice_no) === dn &&
        normDocType(b.document_type) !== dt,
    );
    const sameInvDiffGstin = (booksByInvOnly.get(`${og}|${dt}|${dn}`) || []).find(
      (b) =>
        !claimedBookIds.has(b.id) &&
        withinTolerance(ims.taxable_value, b.taxable_value, Math.max(2, tolerance)) &&
        withinTolerance(taxOf(ims), taxOf(b), Math.max(2, tolerance)),
    );
    const sameSupSameAmtDiffNo = (booksBySupplierType.get(`${og}|${sg}|${dt}`) || []).find(
      (b) =>
        !claimedBookIds.has(b.id) &&
        withinTolerance(ims.taxable_value, b.taxable_value, Math.max(2, tolerance)) &&
        withinTolerance(taxOf(ims), taxOf(b), Math.max(2, tolerance)),
    );
    const softK = `${og}|${sg}|${dt}|${ims.document_date}|${r2(ims.taxable_value).toFixed(2)}|${taxOf(ims).toFixed(2)}`;
    const possibleDup = (imsSoftCount.get(softK) || 0) > 1;

    let status: ImsReconStatus = 'IMS ONLY';
    let note = 'Present in IMS portal only; absent from selected Purchase Register.';
    if (wasDuplicateIms) {
      status = 'DUPLICATE REJECTED';
      note = 'Duplicate IMS entry for already-matched Books invoice.';
    } else if (sameSupplierSameKeyDiffType) {
      status = 'DOCUMENT TYPE MISMATCH';
      note = `Books has ${sameSupplierSameKeyDiffType.document_type} vs IMS ${dt} for same document no ${ims.document_no}.`;
    } else if (sameInvDiffGstin) {
      status = 'SUPPLIER GSTIN MISMATCH';
      note = `Doc No ${ims.document_no} & amount match Books bill of Supplier GSTIN ${sameInvDiffGstin.recon_supplier_gstin || sameInvDiffGstin.supplier_gstin}.`;
    } else if (sameSupSameAmtDiffNo) {
      status = 'DOCUMENT NUMBER MISMATCH';
      note = `Same supplier & amounts match Books Doc No ${sameSupSameAmtDiffNo.recon_invoice_no || sameSupSameAmtDiffNo.invoice_no}.`;
    } else if (possibleDup) {
      status = 'POSSIBLE DUPLICATE';
      note = 'Multiple IMS documents share supplier, date & identical amounts.';
    }

    const rec = recommendImsAction({
      docCategory: ims.doc_category,
      documentType: dt,
      itcReductionRequired: ims.itc_reduction_required,
      reconStatus: status,
      hasImsDoc: true,
    });

    results.push({
      our_gstin: og,
      books_period: null,
      ims_doc_id: ims.id,
      purchase_line_id: null,
      recon_status: status,
      portal_matching_key: pmk,
      internal_match_key: ik,
      taxable_diff: r2(ims.taxable_value),
      igst_diff: r2(ims.igst),
      cgst_diff: r2(ims.cgst),
      sgst_diff: r2(ims.sgst),
      cess_diff: r2(ims.cess),
      total_tax_diff: taxOf(ims),
      date_diff_days: null,
      recommended_action: rec.recommendedAction,
      supported_actions: rec.supportedActions,
      recommendation_reason: rec.reason,
      remarks: note,
    });
  }

  // Remaining unbooked Books lines -> BOOKS ONLY
  for (const b of bookLines) {
    if (claimedBookIds.has(b.id)) continue;
    const og = normGstin(b.our_gstin);
    const sg = normGstin(b.recon_supplier_gstin || b.supplier_gstin);
    const dt = normDocType(b.document_type);
    const inv = b.recon_invoice_no || b.invoice_no;
    const ik = internalKeyOf(og, sg, dt, inv);

    const rec = recommendImsAction({
      documentType: dt,
      reconStatus: 'BOOKS ONLY',
      hasImsDoc: false,
    });

    results.push({
      our_gstin: og,
      books_period: b.period,
      ims_doc_id: null,
      purchase_line_id: b.id,
      recon_status: 'BOOKS ONLY',
      portal_matching_key: '',
      internal_match_key: ik,
      taxable_diff: r2(-b.taxable_value),
      igst_diff: r2(-b.igst),
      cgst_diff: r2(-b.cgst),
      sgst_diff: r2(-b.sgst),
      cess_diff: r2(-b.cess),
      total_tax_diff: r2(-taxOf(b)),
      date_diff_days: null,
      recommended_action: rec.recommendedAction,
      supported_actions: rec.supportedActions,
      recommendation_reason: rec.reason,
      remarks: 'Booked in Purchase Register; not present in imported IMS data.',
    });
  }

  const matched = results.filter((r) => r.recon_status === 'MATCHED — IMS vs BOOKS' || r.recon_status === 'MANUALLY LINKED AFTER CONFIRMATION').length;
  const tax_or_taxable_mismatch = results.filter((r) => r.recon_status === 'MATCHED WITH TAX DIFFERENCE' || r.recon_status === 'MATCHED WITH TAXABLE DIFFERENCE').length;
  const date_or_doc_mismatch = results.filter((r) =>
    r.recon_status === 'MATCHED WITH DOCUMENT DATE DIFFERENCE' ||
    r.recon_status === 'DOCUMENT NUMBER MISMATCH' ||
    r.recon_status === 'SUPPLIER GSTIN MISMATCH' ||
    r.recon_status === 'DOCUMENT TYPE MISMATCH',
  ).length;
  const ims_only = results.filter((r) => r.recon_status === 'IMS ONLY').length;
  const books_only = results.filter((r) => r.recon_status === 'BOOKS ONLY').length;
  const duplicates = results.filter((r) => r.recon_status === 'POSSIBLE DUPLICATE' || r.recon_status === 'DUPLICATE REJECTED').length;

  return {
    results,
    summary: {
      total_ims: imsDocs.length,
      total_books: bookLines.length,
      matched,
      tax_or_taxable_mismatch,
      date_or_doc_mismatch,
      ims_only,
      books_only,
      duplicates,
    },
  };
}
