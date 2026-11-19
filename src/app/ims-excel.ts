/**
 * GST ERP — IMS Working Excel Download & Upload Validation (Part 7).
 *
 * Supports:
 *   1. DOWNLOAD IMS ACTION WORKING FILE — formatted Excel with AutoFilter, Frozen header,
 *      side-by-side Books vs IMS comparison, Portal Matching Key, Internal Match Key,
 *      Recommended Action, and dropdown-validated Proposed Action column.
 *   2. Upload validation & diff preview — strictly validates Doc ID, Our GSTIN, Supplier GSTIN,
 *      Document Type, unmodified Portal Matching Key, and category-supported Action values.
 *      NEVER auto-submits to the GST Portal.
 */

import XLSX from 'xlsx';
import { normDocType, normGstin, normInvoice, r2 } from '../engine/core';
import {
  IMS_ACTIONS,
  supportedActionsForIms,
  type ImsReconStatus,
  type ImsUserAction,
} from '../engine/ims-recon';
import { addListValidations, polishWorkbook } from './xlsx-format';

export interface ImsWorkingRow {
  ims_doc_id: number;
  our_gstin: string;
  portal_matching_key: string;
  internal_match_key: string;
  doc_category: string;
  document_type: string;
  supplier_gstin: string;
  supplier_name: string;
  ims_doc_no: string;
  ims_doc_date: string;
  ims_taxable: number;
  ims_igst: number;
  ims_cgst: number;
  ims_sgst: number;
  ims_cess: number;
  ims_total_tax: number;
  books_doc_no: string;
  books_doc_date: string;
  books_taxable: number | null;
  books_total_tax: number | null;
  taxable_diff: number | null;
  total_tax_diff: number | null;
  recon_status: string;
  current_portal_action: string;
  recommended_action: string;
  proposed_action: string;
  user_remarks: string;
  workflow_status?: string;
}

const WORKING_HEADERS: Array<{ h: string; k: keyof ImsWorkingRow; t: 'text' | 'int' | 'money'; w: number }> = [
  { h: 'IMS Doc ID', k: 'ims_doc_id', t: 'int', w: 12 },
  { h: 'Our GSTIN', k: 'our_gstin', t: 'text', w: 18 },
  { h: 'Portal Matching Key', k: 'portal_matching_key', t: 'text', w: 28 },
  { h: 'Internal Match Key', k: 'internal_match_key', t: 'text', w: 32 },
  { h: 'Document Category', k: 'doc_category', t: 'text', w: 16 },
  { h: 'Document Type', k: 'document_type', t: 'text', w: 15 },
  { h: 'Supplier GSTIN', k: 'supplier_gstin', t: 'text', w: 18 },
  { h: 'Supplier Name', k: 'supplier_name', t: 'text', w: 28 },
  { h: 'IMS Doc No', k: 'ims_doc_no', t: 'text', w: 20 },
  { h: 'IMS Doc Date', k: 'ims_doc_date', t: 'text', w: 14 },
  { h: 'IMS Taxable', k: 'ims_taxable', t: 'money', w: 15 },
  { h: 'IMS IGST', k: 'ims_igst', t: 'money', w: 14 },
  { h: 'IMS CGST', k: 'ims_cgst', t: 'money', w: 14 },
  { h: 'IMS SGST', k: 'ims_sgst', t: 'money', w: 14 },
  { h: 'IMS Cess', k: 'ims_cess', t: 'money', w: 12 },
  { h: 'IMS Total Tax', k: 'ims_total_tax', t: 'money', w: 15 },
  { h: 'Books Doc No', k: 'books_doc_no', t: 'text', w: 20 },
  { h: 'Books Doc Date', k: 'books_doc_date', t: 'text', w: 14 },
  { h: 'Books Taxable', k: 'books_taxable', t: 'money', w: 15 },
  { h: 'Books Total Tax', k: 'books_total_tax', t: 'money', w: 15 },
  { h: 'Taxable Diff', k: 'taxable_diff', t: 'money', w: 14 },
  { h: 'Total Tax Diff', k: 'total_tax_diff', t: 'money', w: 14 },
  { h: 'IMS Recon Status', k: 'recon_status', t: 'text', w: 30 },
  { h: 'Current Portal Action', k: 'current_portal_action', t: 'text', w: 18 },
  { h: 'Recommended Action', k: 'recommended_action', t: 'text', w: 22 },
  { h: 'Proposed Action', k: 'proposed_action', t: 'text', w: 24 },
  { h: 'User Remarks', k: 'user_remarks', t: 'text', w: 30 },
];

export function buildImsWorkingWorkbook(rows: ImsWorkingRow[]): Buffer {
  const wb = XLSX.utils.book_new();
  const aoa: unknown[][] = [WORKING_HEADERS.map((c) => c.h)];

  for (const r of rows) {
    aoa.push(
      WORKING_HEADERS.map((c) => {
        const v = r[c.k];
        if (v === null || v === undefined || v === '') return null;
        if (c.t === 'money') return r2(v);
        if (c.t === 'int') return Math.round(Number(v));
        return String(v);
      }),
    );
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = WORKING_HEADERS.map((c) => ({ wch: c.w }));
  const lastRow = Math.max(1, rows.length) + 1;
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(1, rows.length), c: WORKING_HEADERS.length - 1 } }),
  };

  for (let rIdx = 1; rIdx <= rows.length; rIdx++) {
    for (let cIdx = 0; cIdx < WORKING_HEADERS.length; cIdx++) {
      const col = WORKING_HEADERS[cIdx];
      const addr = XLSX.utils.encode_cell({ r: rIdx, c: cIdx });
      const cell = (ws as any)[addr];
      if (!cell) continue;
      if (col.t === 'money') cell.z = '#,##0.00';
      else if (col.t === 'int') cell.z = '#,##0';
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'IMS Action Working');
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const polished = polishWorkbook(raw, { freezeRows: 1, headerRow: 1, styleHeader: true });
  const propIdx = WORKING_HEADERS.findIndex((c) => c.k === 'proposed_action');
  const colLetter = XLSX.utils.encode_col(propIdx);
  return addListValidations(polished, [
    {
      sheet: 'IMS Action Working',
      sqref: `${colLetter}2:${colLetter}${Math.max(50, lastRow + 100)}`,
      values: [...IMS_ACTIONS],
      title: 'IMS Proposed Action',
      prompt: 'Select ACCEPT, REJECT, PENDING, or DO NOT TAKE ANY ACTION',
    },
  ]);
}

export interface StoredImsDocForValidation {
  id: number;
  our_gstin: string;
  supplier_gstin: string;
  doc_category: string;
  document_type: string;
  document_no: string;
  portal_matching_key: string | null;
  ims_source_action: string | null;
  recon_status: string | null;
  itc_reduction_required: boolean;
  existing_user_action: string | null;
  existing_remarks: string | null;
  existing_workflow_status: string | null;
}

export interface ImsWorkingUploadChange {
  ims_doc_id: number;
  our_gstin: string;
  supplier_gstin: string;
  document_no: string;
  portal_matching_key: string;
  old_action: string;
  new_action: ImsUserAction;
  remarks: string;
}

export interface ImsWorkingUploadRejection {
  row: number;
  ims_doc_id: string;
  document_no: string;
  code:
    | 'INVALID_STRUCTURE'
    | 'UNKNOWN_DOC'
    | 'UNAUTHORIZED_GSTIN'
    | 'IDENTITY_MISMATCH'
    | 'MODIFIED_MATCHING_KEY'
    | 'INVALID_ACTION'
    | 'UNSUPPORTED_CATEGORY_ACTION'
    | 'ALREADY_LOCKED_PORTAL_UPLOAD';
  message: string;
}

export interface ImsWorkingUploadPreview {
  totalRows: number;
  validChanges: ImsWorkingUploadChange[];
  unchangedCount: number;
  rejectedRows: ImsWorkingUploadRejection[];
}

export function parseAndValidateImsWorkingUpload(
  buf: Buffer,
  docsById: Map<number, StoredImsDocForValidation>,
  allowedGstins?: string[] | null,
): ImsWorkingUploadPreview {
  const allowSet = allowedGstins ? new Set(allowedGstins.map(normGstin)) : null;
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e: any) {
    return {
      totalRows: 0,
      validChanges: [],
      unchangedCount: 0,
      rejectedRows: [{
        row: 1, ims_doc_id: '', document_no: '',
        code: 'INVALID_STRUCTURE', message: `Invalid Excel file: ${e?.message}`,
      }],
    };
  }

  const sheetName =
    wb.SheetNames.find((n) => n.toLowerCase().includes('ims')) || wb.SheetNames[0];
  const aoa = sheetName
    ? (XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][])
    : [];

  if (!aoa.length) {
    return {
      totalRows: 0,
      validChanges: [],
      unchangedCount: 0,
      rejectedRows: [{
        row: 1, ims_doc_id: '', document_no: '',
        code: 'INVALID_STRUCTURE', message: 'Working Excel file contains no rows.',
      }],
    };
  }

  const headers = (aoa[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const colIdx = (name: string) => headers.findIndex((h) => h === name.toLowerCase() || h.includes(name.toLowerCase()));
  const iDocId = colIdx('ims doc id');
  const iAction = colIdx('proposed action');
  if (iDocId < 0 || iAction < 0) {
    return {
      totalRows: 0,
      validChanges: [],
      unchangedCount: 0,
      rejectedRows: [{
        row: 1, ims_doc_id: '', document_no: '',
        code: 'INVALID_STRUCTURE',
        message: 'Working Excel must contain "IMS Doc ID" and "Proposed Action" columns.',
      }],
    };
  }

  const iGstin = colIdx('our gstin');
  const iPmk = colIdx('portal matching key');
  const iSupGstin = colIdx('supplier gstin');
  const iDocType = colIdx('document type');
  const iDocNo = colIdx('ims doc no');
  const iRemarks = colIdx('user remarks');

  const validChanges: ImsWorkingUploadChange[] = [];
  const rejectedRows: ImsWorkingUploadRejection[] = [];
  let unchangedCount = 0;
  let totalRows = 0;

  const validActionSet = new Set<string>(IMS_ACTIONS);

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    totalRows++;

    const rawId = String(row[iDocId] ?? '').trim();
    const docId = Number(rawId);
    const excelDocNo = iDocNo >= 0 ? String(row[iDocNo] ?? '').trim() : '';

    if (!Number.isInteger(docId) || docId <= 0 || !docsById.has(docId)) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: excelDocNo,
        code: 'UNKNOWN_DOC', message: `Row ${r + 1}: IMS Doc ID "${rawId}" does not exist in database.`,
      });
      continue;
    }

    const doc = docsById.get(docId)!;
    if (allowSet && !allowSet.has(normGstin(doc.our_gstin))) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
        code: 'UNAUTHORIZED_GSTIN', message: `Row ${r + 1}: User not authorized for GSTIN ${doc.our_gstin}.`,
      });
      continue;
    }

    // Verify immutable identity columns if present
    const excelOurGstin = iGstin >= 0 ? normGstin(row[iGstin]) : '';
    const excelSupGstin = iSupGstin >= 0 ? normGstin(row[iSupGstin]) : '';
    const excelDocType = iDocType >= 0 ? normDocType(row[iDocType]) : null;
    if (
      (excelOurGstin && excelOurGstin !== normGstin(doc.our_gstin)) ||
      (excelSupGstin && excelSupGstin !== normGstin(doc.supplier_gstin)) ||
      (excelDocNo && normInvoice(excelDocNo) !== normInvoice(doc.document_no)) ||
      (excelDocType && excelDocType !== normDocType(doc.document_type))
    ) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
        code: 'IDENTITY_MISMATCH',
        message: `Row ${r + 1}: Document GSTIN / Supplier GSTIN / Doc Type / Doc No modified relative to immutable DB record.`,
      });
      continue;
    }

    // Strict Matching Key check (Test Case #38)
    if (iPmk >= 0) {
      const excelPmk = String(row[iPmk] ?? '').trim();
      const dbPmk = String(doc.portal_matching_key ?? '').trim();
      if (excelPmk !== dbPmk) {
        rejectedRows.push({
          row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
          code: 'MODIFIED_MATCHING_KEY',
          message: `Row ${r + 1}: Portal Matching Key was modified ("${excelPmk}" vs original "${dbPmk}"). Rejected.`,
        });
        continue;
      }
    }

    const proposedRaw = String(row[iAction] ?? '').trim().toUpperCase();
    const newRemarks = iRemarks >= 0 ? String(row[iRemarks] ?? '').trim() : '';

    if (!proposedRaw) {
      unchangedCount++;
      continue;
    }

    if (!validActionSet.has(proposedRaw)) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
        code: 'INVALID_ACTION',
        message: `Row ${r + 1}: Invalid Proposed Action "${proposedRaw}". Allowed: ${IMS_ACTIONS.join(', ')}.`,
      });
      continue;
    }

    const action = proposedRaw as ImsUserAction;
    const supported = supportedActionsForIms({
      docCategory: doc.doc_category,
      documentType: doc.document_type,
      itcReductionRequired: doc.itc_reduction_required,
      reconStatus: (doc.recon_status || 'IMS ONLY') as ImsReconStatus,
      hasImsDoc: true,
    });
    if (!supported.includes(action)) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
        code: 'UNSUPPORTED_CATEGORY_ACTION',
        message: `Row ${r + 1}: Action "${action}" is not supported for ${doc.doc_category} / ${doc.document_type}. Supported: ${supported.join(', ')}.`,
      });
      continue;
    }

    if (
      doc.existing_workflow_status === 'SUCCESS' ||
      doc.existing_workflow_status === 'UPLOAD PENDING' ||
      doc.existing_workflow_status === 'PROCESSING'
    ) {
      rejectedRows.push({
        row: r + 1, ims_doc_id: rawId, document_no: doc.document_no,
        code: 'ALREADY_LOCKED_PORTAL_UPLOAD',
        message: `Row ${r + 1}: Document is in "${doc.existing_workflow_status}" state — blind re-submission blocked.`,
      });
      continue;
    }

    const oldAction = doc.existing_user_action || doc.ims_source_action || '';
    if (oldAction === action && (doc.existing_remarks || '') === newRemarks) {
      unchangedCount++;
      continue;
    }

    validChanges.push({
      ims_doc_id: docId,
      our_gstin: doc.our_gstin,
      supplier_gstin: doc.supplier_gstin,
      document_no: doc.document_no,
      portal_matching_key: doc.portal_matching_key || '',
      old_action: oldAction,
      new_action: action,
      remarks: newRemarks,
    });
  }

  return { totalRows, validChanges, unchangedCount, rejectedRows };
}
