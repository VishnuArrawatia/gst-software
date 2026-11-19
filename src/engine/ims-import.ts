/**
 * GST ERP — Independent IMS Portal File Import Parser & Validator (Part 6).
 *
 * Completely independent from GSTR-2B! Supports GST Portal IMS exports in:
 *   - Excel (.xlsx / .xls / .xlsm / .xlsb) — single sheet or multi-sheet (B2B, B2BA, CDNR, CDNRA, ISD, ECO)
 *   - CSV (.csv)
 *   - JSON (.json) — GST Portal / middleware IMS payload
 *
 * Preserves exact portal `portal_matching_key`, original source signs, `source_*` amounts,
 * original GSTR-1/IMS reference dates/periods (never forcing return month onto IMS docs),
 * and validates structure, GSTIN permissions, document types, and multi-level duplicates.
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import {
  docAmount,
  inferDocType,
  isValidGstin,
  normDate,
  normDocType,
  normGstin,
  normInvoice,
  periodFromAny,
  r2,
  taxOf,
  type DocType,
} from './core';
import { normaliseHeader } from './columns';

export interface ParsedImsDocument {
  doc_key: string;
  our_gstin: string;
  supplier_gstin: string;
  supplier_name: string;
  doc_category: string;
  document_type: DocType;
  document_type_raw: string;
  document_no: string;
  document_no_norm: string;
  document_date: string;
  place_of_supply: string;
  reverse_charge: boolean;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_value: number;
  source_taxable_value: number;
  source_igst: number;
  source_cgst: number;
  source_sgst: number;
  source_cess: number;
  portal_matching_key: string;
  ims_source_action: string;
  ims_source_status: string;
  gstr1_filing_status: string;
  gstr1_period: string;
  itc_reduction_required: boolean;
  source_file: string;
  source_row: number;
  raw_payload: Record<string, unknown>;
  fingerprint: string;
}

export interface ImsImportValidationError {
  file: string;
  sheet?: string;
  row?: number;
  code:
    | 'INVALID_STRUCTURE'
    | 'MISSING_GSTIN'
    | 'INVALID_GSTIN'
    | 'UNAUTHORIZED_GSTIN'
    | 'MISSING_SUPPLIER'
    | 'MISSING_DOC_NO'
    | 'UNRECOGNIZED_DOC_TYPE';
  message: string;
}

export interface ImsFilePreview {
  fileName: string;
  fileSha256: string;
  fileFormat: 'xlsx' | 'csv' | 'json' | 'invalid';
  gstins: string[];
  categories: string[];
  totalRecords: number;
  acceptedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  totalTaxable: number;
  totalTax: number;
  validationErrors: ImsImportValidationError[];
  sample: Array<Record<string, unknown>>;
}

export interface ImsBatchPreview {
  files: ImsFilePreview[];
  gstins: string[];
  categories: string[];
  totalRecords: number;
  acceptedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  validationErrors: ImsImportValidationError[];
  acceptedDocs: ParsedImsDocument[];
  duplicateRows: Array<{ file: string; row: number; document_no: string; supplier_gstin: string; reason: string }>;
}

type ImsColKey =
  | 'our_gstin'
  | 'supplier_gstin'
  | 'supplier_name'
  | 'doc_category'
  | 'document_type'
  | 'document_no'
  | 'document_date'
  | 'place_of_supply'
  | 'reverse_charge'
  | 'taxable_value'
  | 'igst'
  | 'cgst'
  | 'sgst'
  | 'cess'
  | 'invoice_value'
  | 'portal_matching_key'
  | 'ims_source_action'
  | 'ims_source_status'
  | 'gstr1_filing_status'
  | 'gstr1_period'
  | 'itc_reduction_required';

const IMS_HEADER_PATTERNS: Array<[RegExp, ImsColKey]> = [
  [/^(our\s*gstin|our\s*gstn|recipient\s*gstin|gstin\s*of\s*recipient(\s*entity)?|gstin\s*of\s*company|company\s*gstin)$/, 'our_gstin'],
  [/^(supplier\s*gstin|gstin\s*of\s*supplier|gstin\s*of\s*the\s*supplier|ctin|gstin\s*uin|gstin\s*\/\s*uin)$/, 'supplier_gstin'],
  [/^(trade\s*\/?\s*legal\s*name|trade\s*legal\s*name|supplier\s*name|legal\s*name|trade\s*name|party\s*name|vendor\s*name|supplier)$/, 'supplier_name'],
  [/^(doc\s*category|document\s*category|section|table\s*type|ims\s*section|category)$/, 'doc_category'],
  [/^(document\s*type|doc\s*type|invoice\s*type|note\s*type|supply\s*type|type)$/, 'document_type'],
  [/^(document\s*number|doc\s*number|doc\s*no|invoice\s*number|invoice\s*no|note\s*number|note\s*no|inum|nt_num)$/, 'document_no'],
  [/^(document\s*date|doc\s*date|invoice\s*date|note\s*date|idt|nt_dt)$/, 'document_date'],
  [/^(place\s*of\s*supply|pos)$/, 'place_of_supply'],
  [/^(reverse\s*charge|rcm|supply\s*attract\s*reverse\s*charge|rchrg)$/, 'reverse_charge'],
  [/^(taxable\s*value|taxable\s*amount|txval)$/, 'taxable_value'],
  [/^(igst|integrated\s*tax|igst\s*amount|iamt)$/, 'igst'],
  [/^(cgst|central\s*tax|cgst\s*amount|camt)$/, 'cgst'],
  [/^(sgst(\s*\/\s*utgst)?|state\s*\/?\s*ut\s*tax|sgst\s*amount|samt)$/, 'sgst'],
  [/^(cess|cess\s*amount|csamt)$/, 'cess'],
  [/^(invoice\s*value|note\s*value|document\s*value|total\s*value|val)$/, 'invoice_value'],
  [/^(matching\s*key|portal\s*matching\s*key|ims\s*matching\s*key|ims\s*key|ref\s*key|doc\s*key|chksum)$/, 'portal_matching_key'],
  [/^(action|ims\s*action|action\s*taken|current\s*action|portal\s*action|src\s*action)$/, 'ims_source_action'],
  [/^(ims\s*status|action\s*status|status|doc\s*status)$/, 'ims_source_status'],
  [/^(gstr\s*-?\s*1\s*filing\s*status|filing\s*status|supplier\s*filing\s*status)$/, 'gstr1_filing_status'],
  [/^(gstr\s*-?\s*1\s*period|gstr\s*-?\s*1\s*\/?\s*iff\s*period|return\s*period|tax\s*period|period|fp)$/, 'gstr1_period'],
  [/^(itc\s*reduction\s*required(\s*by\s*recipient)?|itc\s*reduction)$/, 'itc_reduction_required'],
];

function mapImsHeader(cell: unknown): ImsColKey | null {
  const norm = normaliseHeader(cell).replace(/\s*\(rs\)|\(inr\)|\(₹\)/g, '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  for (const [re, key] of IMS_HEADER_PATTERNS) {
    if (re.test(norm)) return key;
  }
  return null;
}

function detectImsHeader(rows: unknown[][]): { rowIdx: number; colMap: Map<ImsColKey, number> } {
  let bestRow = -1;
  let bestScore = 0;
  let bestMap = new Map<ImsColKey, number>();

  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] || [];
    const cur = new Map<ImsColKey, number>();
    for (let c = 0; c < row.length; c++) {
      let k = mapImsHeader(row[c]);
      if (!k && r > 0) {
        const sub = String(row[c] ?? '').trim();
        const sup = String(rows[r - 1]?.[c] ?? '').trim();
        if (sub && sup) k = mapImsHeader(`${sup} ${sub}`);
      }
      if (k && !cur.has(k)) cur.set(k, c);
    }
    const score =
      cur.size * 10 +
      (cur.has('document_no') ? 25 : 0) +
      (cur.has('supplier_gstin') ? 25 : 0) +
      (cur.has('taxable_value') ? 20 : 0);
    if (cur.has('document_no') && cur.has('supplier_gstin') && cur.size >= 3 && score > bestScore) {
      bestScore = score;
      bestRow = r;
      bestMap = cur;
    }
  }
  return { rowIdx: bestRow, colMap: bestMap };
}

function numVal(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? r2(v) : 0;
  const s = String(v).replace(/[,₹\s]/g, '').trim();
  if (!s || s === '-' || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? r2(n) : 0;
}

function boolVal(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1';
}

export function imsFingerprintOf(d: Pick<
  ParsedImsDocument,
  | 'our_gstin'
  | 'supplier_gstin'
  | 'document_type'
  | 'document_no_norm'
  | 'document_date'
  | 'doc_category'
  | 'taxable_value'
  | 'igst'
  | 'cgst'
  | 'sgst'
  | 'cess'
  | 'portal_matching_key'
>): string {
  return [
    normGstin(d.our_gstin),
    normGstin(d.supplier_gstin),
    d.document_type,
    d.document_no_norm,
    d.document_date || '',
    d.doc_category || 'B2B',
    r2(d.taxable_value).toFixed(2),
    r2(d.igst).toFixed(2),
    r2(d.cgst).toFixed(2),
    r2(d.sgst).toFixed(2),
    r2(d.cess).toFixed(2),
    (d.portal_matching_key || '').trim(),
  ].join('|');
}

function categoryFromImsSheet(name: string): string | null {
  const s = name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (/^(read\s*me|instructions|summary|dashboard)$/.test(s)) return null;
  if (s === 'b2b' || s.startsWith('b2b ')) return 'B2B';
  if (s === 'b2ba') return 'B2BA';
  if (s === 'cdnr' || s.includes('credit')) return 'CDNR';
  if (s === 'cdnra') return 'CDNRA';
  if (s === 'isd') return 'ISD';
  if (s === 'isda') return 'ISDA';
  if (s === 'eco') return 'ECO';
  if (s === 'ecoa') return 'ECOA';
  return 'B2B';
}

export function normalizePortalActionLabel(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return 'NO ACTION';
  if (s === 'A' || s.startsWith('ACCEPT')) return 'ACCEPT';
  if (s === 'R' || s.startsWith('REJECT')) return 'REJECT';
  if (s === 'P' || s.startsWith('PEND')) return 'PENDING';
  if (s === 'N' || s.includes('NO ACTION') || s.includes('DO NOT')) return 'NO ACTION';
  return s;
}

export function parseImsFilesBatch(
  files: Array<{ name: string; buffer: Buffer }>,
  opts: {
    selectedGstin?: string;
    allowedGstins?: string[] | null;
    existingDbFingerprints?: Set<string>;
  } = {},
): ImsBatchPreview {
  const fallbackGstin = normGstin(opts.selectedGstin);
  const allowedSet = opts.allowedGstins ? new Set(opts.allowedGstins.map(normGstin)) : null;
  const seenFingerprints = new Set<string>(opts.existingDbFingerprints ?? []);

  const filesOut: ImsFilePreview[] = [];
  const allErrors: ImsImportValidationError[] = [];
  const acceptedDocs: ParsedImsDocument[] = [];
  const duplicateRows: ImsBatchPreview['duplicateRows'] = [];

  const processFlatRecords = (
    rawRecords: Array<{
      sheet: string;
      rowNo: number;
      defaultCategory: string;
      fields: Partial<Record<ImsColKey, unknown>>;
    }>,
    fileName: string,
    fileSha: string,
    format: 'xlsx' | 'csv' | 'json',
  ) => {
    const fErrors: ImsImportValidationError[] = [];
    const fGstins = new Set<string>();
    const fCats = new Set<string>();
    const sample: Array<Record<string, unknown>> = [];
    let totalRecords = 0;
    let acceptedRecords = 0;
    let duplicateRecords = 0;
    let rejectedRecords = 0;
    let totalTaxable = 0;
    let totalTax = 0;

    for (const item of rawRecords) {
      totalRecords++;
      const f = item.fields;
      const ourGstin = normGstin(f.our_gstin) || fallbackGstin;
      const supGstin = normGstin(f.supplier_gstin);
      const docNo = (f.document_no instanceof Date ? normDate(f.document_no) : String(f.document_no ?? '')).trim();

      if (!ourGstin) {
        rejectedRecords++;
        const err: ImsImportValidationError = {
          file: fileName, sheet: item.sheet, row: item.rowNo,
          code: 'MISSING_GSTIN', message: `Row ${item.rowNo}: Our GSTIN missing.`,
        };
        fErrors.push(err); allErrors.push(err);
        continue;
      }
      if (!isValidGstin(ourGstin)) {
        rejectedRecords++;
        const err: ImsImportValidationError = {
          file: fileName, sheet: item.sheet, row: item.rowNo,
          code: 'INVALID_GSTIN', message: `Row ${item.rowNo}: Invalid Our GSTIN "${ourGstin}".`,
        };
        fErrors.push(err); allErrors.push(err);
        continue;
      }
      if (allowedSet && !allowedSet.has(ourGstin)) {
        rejectedRecords++;
        const err: ImsImportValidationError = {
          file: fileName, sheet: item.sheet, row: item.rowNo,
          code: 'UNAUTHORIZED_GSTIN', message: `Row ${item.rowNo}: User not permitted for GSTIN ${ourGstin}.`,
        };
        fErrors.push(err); allErrors.push(err);
        continue;
      }
      if (!supGstin) {
        rejectedRecords++;
        const err: ImsImportValidationError = {
          file: fileName, sheet: item.sheet, row: item.rowNo,
          code: 'MISSING_SUPPLIER', message: `Row ${item.rowNo}: Supplier GSTIN missing.`,
        };
        fErrors.push(err); allErrors.push(err);
        continue;
      }
      if (!docNo) {
        rejectedRecords++;
        const err: ImsImportValidationError = {
          file: fileName, sheet: item.sheet, row: item.rowNo,
          code: 'MISSING_DOC_NO', message: `Row ${item.rowNo}: Document Number missing.`,
        };
        fErrors.push(err); allErrors.push(err);
        continue;
      }

      const rawTx = numVal(f.taxable_value);
      const rawIg = numVal(f.igst);
      const rawCg = numVal(f.cgst);
      const rawSg = numVal(f.sgst);
      const rawCe = numVal(f.cess);
      const rawIv = numVal(f.invoice_value);

      const rawDocType = String(f.document_type ?? '').trim();
      let docCat = String(f.doc_category ?? item.defaultCategory ?? 'B2B').trim().toUpperCase();
      if (/credit|cdnr|^\s*c\s*$|^\s*cn\s*$|debit|^\s*d\s*$|^\s*dn\s*$/i.test(rawDocType) && docCat === 'B2B') {
        docCat = 'CDNR';
      }

      const hintedType =
        rawDocType ||
        (docCat === 'CDNR' || docCat === 'CDNRA'
          ? (rawTx < 0 ? 'Credit Note' : 'Debit Note')
          : 'Tax Invoice');
      const docType: DocType = inferDocType(hintedType, [rawTx, rawIg, rawCg, rawSg, rawCe]);

      const taxable_value = docAmount(docType, rawTx);
      const igst = docAmount(docType, rawIg);
      const cgst = docAmount(docType, rawCg);
      const sgst = docAmount(docType, rawSg);
      const cess = docAmount(docType, rawCe);
      const rowTotalTax = taxOf({ igst, cgst, sgst, cess });
      const invoice_value = rawIv !== 0 ? docAmount(docType, rawIv) : r2(taxable_value + rowTotalTax);

      // Preserve EXACT portal matching key if supplied (do NOT synthesize into portal_matching_key)
      const portalMatchingKey = String(f.portal_matching_key ?? '').trim();
      const docDate = normDate(f.document_date);
      const docNoNorm = normInvoice(docNo);

      const partial: Omit<ParsedImsDocument, 'doc_key' | 'fingerprint'> = {
        our_gstin: ourGstin,
        supplier_gstin: supGstin,
        supplier_name: String(f.supplier_name ?? '').trim(),
        doc_category: docCat,
        document_type: docType,
        document_type_raw: rawDocType || docType,
        document_no: docNo,
        document_no_norm: docNoNorm,
        document_date: docDate,
        place_of_supply: String(f.place_of_supply ?? '').trim(),
        reverse_charge: boolVal(f.reverse_charge),
        taxable_value,
        igst,
        cgst,
        sgst,
        cess,
        invoice_value,
        source_taxable_value: rawTx,
        source_igst: rawIg,
        source_cgst: rawCg,
        source_sgst: rawSg,
        source_cess: rawCe,
        portal_matching_key: portalMatchingKey,
        ims_source_action: normalizePortalActionLabel(f.ims_source_action),
        ims_source_status: String(f.ims_source_status ?? 'Pending Action').trim(),
        gstr1_filing_status: String(f.gstr1_filing_status ?? '').trim(),
        gstr1_period: periodFromAny(f.gstr1_period) || String(f.gstr1_period ?? '').trim().slice(0, 7),
        itc_reduction_required: boolVal(f.itc_reduction_required),
        source_file: fileName,
        source_row: item.rowNo,
        raw_payload: f as Record<string, unknown>,
      };

      const fp = imsFingerprintOf(partial);
      fGstins.add(ourGstin);
      fCats.add(docCat);

      if (seenFingerprints.has(fp)) {
        duplicateRecords++;
        duplicateRows.push({
          file: fileName, row: item.rowNo, document_no: docNo, supplier_gstin: supGstin,
          reason: 'Duplicate IMS document (identical GSTIN, supplier, doc no, type, amounts & Matching Key)',
        });
        continue;
      }

      seenFingerprints.add(fp);
      const fpHash = crypto.createHash('sha1').update(fp).digest('hex').slice(0, 12);
      const doc_key = portalMatchingKey
        ? `IMS|${ourGstin}|PMK|${portalMatchingKey}|${fpHash}`
        : `IMS|${ourGstin}|${supGstin}|${docType}|${docNoNorm}|${fpHash}`;

      acceptedDocs.push({ ...partial, doc_key, fingerprint: fp });
      acceptedRecords++;
      totalTaxable = r2(totalTaxable + taxable_value);
      totalTax = r2(totalTax + rowTotalTax);

      if (sample.length < 25) {
        sample.push({
          our_gstin: ourGstin,
          supplier_gstin: supGstin,
          supplier_name: partial.supplier_name,
          doc_category: docCat,
          document_type: docType,
          document_no: docNo,
          document_date: docDate,
          taxable_value,
          total_tax: rowTotalTax,
          portal_matching_key: portalMatchingKey,
          ims_source_action: partial.ims_source_action,
        });
      }
    }

    filesOut.push({
      fileName,
      fileSha256: fileSha,
      fileFormat: format,
      gstins: [...fGstins].sort(),
      categories: [...fCats].sort(),
      totalRecords,
      acceptedRecords,
      duplicateRecords,
      rejectedRecords,
      validationErrors: fErrors,
      totalTaxable,
      totalTax,
      sample,
    });
  };

  for (const file of files) {
    const fileSha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const isJson = file.name.toLowerCase().endsWith('.json');
    const isCsv = file.name.toLowerCase().endsWith('.csv');

    if (isJson) {
      try {
        const parsed = JSON.parse(file.buffer.toString('utf8'));
        const root = (parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed) as Record<string, any>;
        const rootGstin = normGstin(root.gstin || root.recipient_gstin || fallbackGstin);
        const extracted: Array<{
          sheet: string; rowNo: number; defaultCategory: string; fields: Partial<Record<ImsColKey, unknown>>;
        }> = [];
        let seq = 0;

        if (Array.isArray(root.documents || root.ims || root.records)) {
          const list = (root.documents || root.ims || root.records) as any[];
          for (const d of list) {
            seq++;
            extracted.push({
              sheet: 'JSON',
              rowNo: seq,
              defaultCategory: String(d.doc_category || d.section || 'B2B').toUpperCase(),
              fields: {
                our_gstin: d.our_gstin || d.recipient_gstin || rootGstin,
                supplier_gstin: d.supplier_gstin || d.stin || d.ctin,
                supplier_name: d.supplier_name || d.cname || d.trdnm,
                doc_category: d.doc_category || d.section,
                document_type: d.document_type || d.inv_typ || d.ntty || 'Tax Invoice',
                document_no: d.document_no || d.inum || d.nt_num,
                document_date: d.document_date || d.idt || d.nt_dt,
                place_of_supply: d.place_of_supply || d.pos,
                reverse_charge: d.reverse_charge ?? d.rchrg,
                taxable_value: d.taxable_value ?? d.txval ?? 0,
                igst: d.igst ?? d.iamt ?? 0,
                cgst: d.cgst ?? d.camt ?? 0,
                sgst: d.sgst ?? d.samt ?? 0,
                cess: d.cess ?? d.csamt ?? 0,
                invoice_value: d.invoice_value ?? d.val ?? 0,
                portal_matching_key: d.portal_matching_key || d.matching_key || d.chksum || '',
                ims_source_action: d.ims_action || d.action || d.action_taken,
                ims_source_status: d.ims_status || d.status,
                gstr1_filing_status: d.gstr1_filing_status || d.cfs,
                gstr1_period: d.gstr1_period || d.fp || root.rtnprd,
                itc_reduction_required: d.itc_reduction_required ?? d.itcRedReq,
              },
            });
          }
        } else {
          for (const sec of ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda']) {
            const arr = Array.isArray(root[sec]) ? root[sec] : [];
            for (const item of arr) {
              seq++;
              extracted.push({
                sheet: sec.toUpperCase(),
                rowNo: seq,
                defaultCategory: sec.toUpperCase(),
                fields: {
                  our_gstin: item.our_gstin || rootGstin,
                  supplier_gstin: item.stin || item.ctin || item.supplier_gstin,
                  supplier_name: item.trdnm || item.supplier_name,
                  doc_category: sec.toUpperCase(),
                  document_type: item.ntty === 'C' ? 'Credit Note' : item.ntty === 'D' ? 'Debit Note' : (sec.startsWith('cdnr') ? 'Credit Note' : 'Tax Invoice'),
                  document_no: item.inum || item.nt_num || item.document_no,
                  document_date: item.idt || item.nt_dt || item.document_date,
                  place_of_supply: item.pos,
                  reverse_charge: item.rchrg,
                  taxable_value: item.txval ?? item.taxable_value ?? 0,
                  igst: item.iamt ?? item.igst ?? 0,
                  cgst: item.camt ?? item.cgst ?? 0,
                  sgst: item.samt ?? item.sgst ?? 0,
                  cess: item.csamt ?? item.cess ?? 0,
                  invoice_value: item.val ?? item.invoice_value ?? 0,
                  portal_matching_key: item.matching_key || item.portal_matching_key || item.chksum || '',
                  ims_source_action: item.action || item.ims_action,
                  ims_source_status: item.status || item.ims_status,
                  gstr1_filing_status: item.cfs || item.filing_status,
                  gstr1_period: item.rtnprd || item.fp || root.rtnprd,
                  itc_reduction_required: item.itcRedReq,
                },
              });
            }
          }
        }

        if (!extracted.length) {
          const err: ImsImportValidationError = {
            file: file.name, code: 'INVALID_STRUCTURE',
            message: `${file.name}: No supported IMS JSON documents array/sections found.`,
          };
          allErrors.push(err);
          filesOut.push({
            fileName: file.name, fileSha256: fileSha, fileFormat: 'invalid',
            gstins: [], categories: [], totalRecords: 0, acceptedRecords: 0,
            duplicateRecords: 0, rejectedRecords: 1, totalTaxable: 0, totalTax: 0,
            validationErrors: [err], sample: [],
          });
          continue;
        }
        processFlatRecords(extracted, file.name, fileSha, 'json');
      } catch (e: any) {
        const err: ImsImportValidationError = {
          file: file.name, code: 'INVALID_STRUCTURE', message: `${file.name}: Invalid JSON (${e?.message})`,
        };
        allErrors.push(err);
        filesOut.push({
          fileName: file.name, fileSha256: fileSha, fileFormat: 'invalid',
          gstins: [], categories: [], totalRecords: 0, acceptedRecords: 0,
          duplicateRecords: 0, rejectedRecords: 1, totalTaxable: 0, totalTax: 0,
          validationErrors: [err], sample: [],
        });
      }
      continue;
    }

    // Excel / CSV
    try {
      const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
      const extracted: Array<{
        sheet: string; rowNo: number; defaultCategory: string; fields: Partial<Record<ImsColKey, unknown>>;
      }> = [];
      let validSheets = 0;

      for (const sName of wb.SheetNames) {
        const defaultCat = categoryFromImsSheet(sName);
        if (defaultCat === null) continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sName], {
          header: 1, raw: true, defval: null, blankrows: false,
        }) as unknown[][];
        if (!rows.length) continue;

        const { rowIdx, colMap } = detectImsHeader(rows);
        if (rowIdx < 0) continue;
        validSheets++;

        for (let r = rowIdx + 1; r < rows.length; r++) {
          const row = rows[r] || [];
          if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
          const first = String(row[0] ?? '').trim();
          if (/^\s*(grand\s*total|total|subtotal)\b/i.test(first)) continue;

          const fields: Partial<Record<ImsColKey, unknown>> = {};
          for (const [k, cIdx] of colMap) fields[k] = row[cIdx];
          extracted.push({ sheet: sName, rowNo: r + 1, defaultCategory: defaultCat, fields });
        }
      }

      if (validSheets === 0) {
        const err: ImsImportValidationError = {
          file: file.name, code: 'INVALID_STRUCTURE',
          message: `${file.name}: Does not match any recognized IMS Excel/CSV structure (requires Document Number + Supplier GSTIN columns).`,
        };
        allErrors.push(err);
        filesOut.push({
          fileName: file.name, fileSha256: fileSha, fileFormat: 'invalid',
          gstins: [], categories: [], totalRecords: 0, acceptedRecords: 0,
          duplicateRecords: 0, rejectedRecords: 1, totalTaxable: 0, totalTax: 0,
          validationErrors: [err], sample: [],
        });
        continue;
      }

      processFlatRecords(extracted, file.name, fileSha, isCsv ? 'csv' : 'xlsx');
    } catch (e: any) {
      const err: ImsImportValidationError = {
        file: file.name, code: 'INVALID_STRUCTURE', message: `${file.name}: Unreadable file (${e?.message})`,
      };
      allErrors.push(err);
      filesOut.push({
        fileName: file.name, fileSha256: fileSha, fileFormat: 'invalid',
        gstins: [], categories: [], totalRecords: 0, acceptedRecords: 0,
        duplicateRecords: 0, rejectedRecords: 1, totalTaxable: 0, totalTax: 0,
        validationErrors: [err], sample: [],
      });
    }
  }

  return {
    files: filesOut,
    gstins: [...new Set(filesOut.flatMap((f) => f.gstins))].sort(),
    categories: [...new Set(filesOut.flatMap((f) => f.categories))].sort(),
    totalRecords: filesOut.reduce((s, f) => s + f.totalRecords, 0),
    acceptedRecords: acceptedDocs.length,
    duplicateRecords: duplicateRows.length,
    rejectedRecords: filesOut.reduce((s, f) => s + f.rejectedRecords, 0),
    validationErrors: allErrors,
    acceptedDocs,
    duplicateRows,
  };
}
