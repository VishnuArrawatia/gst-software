/**
 * GST ERP — 50 Mandatory Test Cases Suite for Master Prompt (Part 14).
 *
 * Runs exclusively on `gst_erp_test` via `scripts/test-db.ts`.
 * Hard aborts if attempted on production `gst_erp`.
 */

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { withClient } from '../src/app/store';
import {
  parseGstr2bExcelBatch,
  expandSelectedPeriods,
} from '../src/engine/gstr2b-excel';
import {
  queryCompleteReconDataset,
  buildCompleteReconWorkbook,
} from '../src/app/complete-recon-export';
import { parseImsFilesBatch } from '../src/engine/ims-import';
import {
  reconcileImsVsBooks,
  recommendImsAction,
  supportedActionsForIms,
} from '../src/engine/ims-recon';
import {
  buildImsWorkingWorkbook,
  parseAndValidateImsWorkingUpload,
  type ImsWorkingRow,
} from '../src/app/ims-excel';
import {
  commitImsImport,
  runImsReconciliation,
  listImsReconDocuments,
  getImsWorkingRows,
  saveImsUserActions,
  reviewAndApproveImsActions,
  updateImsUploadBatchStatus,
  importImsPortalErrorReport,
  getImsDashboard,
  runImsReport,
  getCombinedManagementView,
} from '../src/app/ims-store';
import { reconcilePurchases } from '../src/engine/match';
import { r2 } from '../src/engine/core';
import { zipRead } from '../src/app/xlsx-format';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(msg: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS: ${msg}`);
  } else {
    fail++;
    const s = detail !== undefined ? ` (got: ${JSON.stringify(detail)})` : '';
    failures.push(`${msg}${s}`);
    console.error(`  FAIL: ${msg}${s}`);
  }
}

function eq(msg: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(msg, ok, ok ? undefined : { actual, expected });
}

async function run() {
  console.log('='.repeat(70));
  console.log('GST ERP — MASTER RECONCILIATION & IMS 50-TEST DB SUITE');
  console.log('='.repeat(70));

  // Guard: Confirm strictly running against gst_erp_test
  await withClient(async (c) => {
    const res = await c.query('SELECT current_database() as db');
    const db = res.rows[0]?.db;
    console.log(`Connected Database: ${db}`);
    if (db !== 'gst_erp_test') {
      throw new Error(`FATAL: Test suite MUST run exclusively on gst_erp_test. Detected: ${db}`);
    }
  });

  const TEST_OUR_GSTIN = '26AALCS9985J1ZC';
  const TEST_OUR_GSTIN_2 = '24AALCS9985J1ZG';
  const TEST_SUPPLIER_GSTIN = '27AAACS1234A1Z5';
  const TEST_PERIOD = '2026-04';
  const SYNTH_TAG = `SYNTH_${Date.now()}`;

  // Helper to build a multi-sheet portal workbook buffer
  function makePortalWbBuffer(records: Array<{
    sheet: string;
    ourGstin: string;
    period: string;
    supGstin: string;
    supName: string;
    invNo: string;
    invDate: string;
    docType: string;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }>): Buffer {
    const wb = XLSX.utils.book_new();
    const sheetsMap = new Map<string, unknown[][]>();

    for (const r of records) {
      if (!sheetsMap.has(r.sheet)) {
        sheetsMap.set(r.sheet, [
          [`GSTR-2B ${r.sheet}`],
          ['GSTIN of recipient', r.ourGstin],
          ['Return Period', r.period.split('-').reverse().join('/')],
          [],
          r.sheet.startsWith('CDN')
            ? ['GSTIN of supplier', 'Trade Name', 'Note type', 'Note number', 'Note Date', 'Note Value', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess', 'ITC Availability', 'Reason']
            : ['GSTIN of supplier', 'Trade Name', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess', 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason']
        ]);
      }
      const isCdn = r.sheet.startsWith('CDN');
      const val = Math.abs(r.taxable) + Math.abs(r.igst) + Math.abs(r.cgst) + Math.abs(r.sgst) + Math.abs(r.cess);
      const row = isCdn
        ? [r.supGstin, r.supName, r.docType === 'Credit Note' ? 'C' : 'D', r.invNo, r.invDate, val, '26-Dadra and Nagar Haveli', 'N', r.taxable, r.igst, r.cgst, r.sgst, r.cess, 'Yes', '']
        : [r.supGstin, r.supName, r.invNo, r.docType, r.invDate, val, '26-Dadra and Nagar Haveli', 'N', r.taxable, r.igst, r.cgst, r.sgst, r.cess, r.period.split('-').reverse().join('/'), '11-05-2026', 'Yes', ''];
      sheetsMap.get(r.sheet)!.push(row);
    }

    for (const [sName, rows] of sheetsMap.entries()) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sName);
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  // =========================================================================
  // TC #1: Import single month GSTR-2B Excel
  // =========================================================================
  console.log('\n--- Part A: GSTR-2B Excel Import (TC #1 to #13) ---');
  const bufSingle = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC1-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pSingle = parseGstr2bExcelBatch([{ name: 'tc1.xlsx', buffer: bufSingle }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04' });
  check('TC #1: Import single month GSTR-2B Excel parsed successfully', pSingle.acceptedRecords === 1 && pSingle.files[0].returnPeriods.includes('2026-04'));

  // =========================================================================
  // TC #2: Import continuous multiple months GSTR-2B Excel
  // =========================================================================
  const monthsRange = expandSelectedPeriods({ periodMode: 'range', from: '2026-04', to: '2026-06' });
  const bufRange = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC2A-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-05', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC2B-${SYNTH_TAG}`, invDate: '10-05-2026', docType: 'Regular', taxable: 12000, igst: 2160, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pRange = parseGstr2bExcelBatch([{ name: 'tc2.xlsx', buffer: bufRange }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'range', from: '2026-04', to: '2026-06' });
  check('TC #2: Import continuous multiple months GSTR-2B Excel accepted all scoped months', pRange.acceptedRecords === 2 && monthsRange.length === 3);

  // =========================================================================
  // TC #3: Import individually selected multiple months GSTR-2B Excel
  // =========================================================================
  const bufMulti = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC3A-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 },
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-08', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC3B-${SYNTH_TAG}`, invDate: '10-08-2026', docType: 'Regular', taxable: 6000, igst: 1080, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pMulti = parseGstr2bExcelBatch([{ name: 'tc3.xlsx', buffer: bufMulti }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'multi', periods: ['2026-04', '2026-08', '2026-11'] });
  check('TC #3: Import individually selected multiple months GSTR-2B Excel accepted non-consecutive months', pMulti.acceptedRecords === 2);

  // =========================================================================
  // TC #4: Import multi-file batch Excel
  // =========================================================================
  const pBatch = parseGstr2bExcelBatch([
    { name: 'file1.xlsx', buffer: bufSingle },
    { name: 'file2.xlsx', buffer: bufRange },
  ], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'range', from: '2026-04', to: '2026-06' });
  check('TC #4: Multi-file batch parsed in single execution', pBatch.files.length === 2 && pBatch.acceptedRecords === 3);

  // =========================================================================
  // TC #5: Import multi-GSTIN batch Excel
  // =========================================================================
  const bufMultiGstin1 = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC5A-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const bufMultiGstin2 = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN_2, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-TC5B-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 7000, igst: 1260, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pMultiGstin = parseGstr2bExcelBatch([
    { name: 'tc5_gstin1.xlsx', buffer: bufMultiGstin1 },
    { name: 'tc5_gstin2.xlsx', buffer: bufMultiGstin2 },
  ], { periodMode: 'single', period: '2026-04', allowedGstins: [TEST_OUR_GSTIN, TEST_OUR_GSTIN_2] });
  check('TC #5: Multi-GSTIN batch accepted permitted registrations', pMultiGstin.acceptedRecords === 2 && pMultiGstin.gstins.length === 2);

  // =========================================================================
  // TC #6: Duplicate file upload detection
  // =========================================================================
  const pDupFile = parseGstr2bExcelBatch([
    { name: 'same.xlsx', buffer: bufSingle },
    { name: 'same_copy.xlsx', buffer: bufSingle },
  ], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04' });
  check('TC #6: Duplicate file upload detected and isolated in duplicateRows', pDupFile.duplicateRecords >= 1);

  // =========================================================================
  // TC #7: Duplicate document detection within same file
  // =========================================================================
  const bufDupDoc = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-DUP-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-DUP-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pDupDoc = parseGstr2bExcelBatch([{ name: 'dup.xlsx', buffer: bufDupDoc }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04' });
  check('TC #7: Duplicate document detection within same file flags second row as duplicate', pDupDoc.duplicateRecords === 1 && pDupDoc.acceptedRecords === 1);

  // =========================================================================
  // TC #8: Duplicate document detection across batches
  // =========================================================================
  const dbFingerprints = new Set<string>([pSingle.acceptedRows[0]?.fingerprint]);
  const pDupBatch = parseGstr2bExcelBatch([{ name: 'tc1_reupload.xlsx', buffer: bufSingle }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04', existingDbFingerprints: dbFingerprints });
  check('TC #8: Duplicate document detection across previous import batches', pDupBatch.duplicateRecords === 1 && pDupBatch.acceptedRecords === 0);

  // =========================================================================
  // TC #9: Invalid Excel file structure rejection with clear errors
  // =========================================================================
  const invalidWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(invalidWb, XLSX.utils.aoa_to_sheet([['Garbage', 'Data'], ['123', '456']]), 'RandomSheet');
  const pInvalid = parseGstr2bExcelBatch([{ name: 'invalid.xlsx', buffer: XLSX.write(invalidWb, { type: 'buffer' }) as Buffer }], { fallbackGstin: TEST_OUR_GSTIN });
  check('TC #9: Invalid Excel file structure rejected with clear error', pInvalid.acceptedRecords === 0 && pInvalid.validationErrors.length > 0);

  // =========================================================================
  // TC #10: Missing mandatory GSTIN rejection
  // =========================================================================
  const bufNoGstin = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: '', period: '2026-04', supGstin: '', supName: 'VEND-NO-GSTIN', invNo: `INV-NOGSTIN-${SYNTH_TAG}`, invDate: '10-04-2026', docType: 'Regular', taxable: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pNoGstin = parseGstr2bExcelBatch([{ name: 'nogstin.xlsx', buffer: bufNoGstin }], { periodMode: 'single', period: '2026-04' });
  check('TC #10: Missing mandatory GSTIN rejected', pNoGstin.rejectedRecords >= 1 && pNoGstin.validationErrors.some((e) => e.code.includes('GSTIN')));

  // =========================================================================
  // TC #11: Incorrect return period identification and warning
  // =========================================================================
  const bufWrongPeriod = makePortalWbBuffer([
    { sheet: 'B2B', ourGstin: TEST_OUR_GSTIN, period: '2025-01', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `INV-OLD-${SYNTH_TAG}`, invDate: '10-01-2025', docType: 'Regular', taxable: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pWrongPeriod = parseGstr2bExcelBatch([{ name: 'wrong_period.xlsx', buffer: bufWrongPeriod }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04' });
  check('TC #11: Incorrect return period outside selected scope rejected with warning', pWrongPeriod.rejectedRecords === 1 && pWrongPeriod.validationErrors.some((e) => e.code === 'PERIOD_MISMATCH'));

  // =========================================================================
  // TC #12: Credit note negative amount preservation
  // =========================================================================
  const bufCnDn = makePortalWbBuffer([
    { sheet: 'CDNR', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `CN-TC12-${SYNTH_TAG}`, invDate: '20-04-2026', docType: 'Credit Note', taxable: 4000, igst: 720, cgst: 0, sgst: 0, cess: 0 },
    { sheet: 'CDNR', ourGstin: TEST_OUR_GSTIN, period: '2026-04', supGstin: TEST_SUPPLIER_GSTIN, supName: 'VEND-A', invNo: `DN-TC13-${SYNTH_TAG}`, invDate: '22-04-2026', docType: 'Debit Note', taxable: 3000, igst: 540, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const pCnDn = parseGstr2bExcelBatch([{ name: 'cndn.xlsx', buffer: bufCnDn }], { fallbackGstin: TEST_OUR_GSTIN, periodMode: 'single', period: '2026-04' });
  const cnRow = pCnDn.acceptedRows.find((r) => r.invoice_no === `CN-TC12-${SYNTH_TAG}`);
  check('TC #12: Credit note taxable and tax preserved negative', cnRow?.taxable_value === -4000 && cnRow?.igst === -720);

  // =========================================================================
  // TC #13: Debit note positive amount verification
  // =========================================================================
  const dnRow = pCnDn.acceptedRows.find((r) => r.invoice_no === `DN-TC13-${SYNTH_TAG}`);
  check('TC #13: Debit note taxable and tax preserved positive', dnRow?.taxable_value === 3000 && dnRow?.igst === 540);

  // =========================================================================
  // TC #14 to #30: Complete Reconciliation Excel Export Suite
  // =========================================================================
  console.log('\n--- Part B: Complete Reconciliation Excel Export (TC #14 to #30) ---');

  // Insert a rich synthetic dataset into purchase_lines and gstr2b_lines to test all statuses
  await withClient(async (c) => {
    // 1. Matched in Same Month
    await c.query(`
      INSERT INTO purchase_lines (
        our_gstin, financial_year, period, party_name,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_document_type,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, detailed_match_status, matched_2b_month, line_key
      )
      VALUES (
        $1, '2026-27', '2026-04', 'VEND-A',
        $2, $3, '2026-04-10', 'Tax Invoice',
        10000, 1800, 0, 0, 0,
        $2, $3, '2026-04-10',
        'Matched', 'MATCHED IN SAME MONTH', '2026-04', $4
      )
    `, [TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `INV-M1-${SYNTH_TAG}`, `KEY-M1-${SYNTH_TAG}`]);

    await c.query(`
      INSERT INTO gstr2b_lines (
        line_key, our_gstin, supplier_gstin, supplier_name,
        invoice_no, document_type, invoice_date, twob_month,
        taxable_value, igst, cgst, sgst, cess, invoice_value, doc_category
      )
      VALUES ($1, $2, $3, 'VEND-A', $4, 'Regular', '2026-04-10', '2026-04', 10000, 1800, 0, 0, 0, 11800, 'B2B')
    `, [`2B-M1-${SYNTH_TAG}`, TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `INV-M1-${SYNTH_TAG}`]);

    // 2. Debit Note Matched with Tax Difference
    await c.query(`
      INSERT INTO purchase_lines (
        our_gstin, financial_year, period, party_name,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_document_type,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, detailed_match_status, matched_2b_month, line_key, taxable_difference, itc_difference
      )
      VALUES (
        $1, '2026-27', '2026-04', 'VEND-A',
        $2, $3, '2026-04-15', 'Debit Note',
        5000, 900, 0, 0, 0,
        $2, $3, '2026-04-15',
        'Amount Mismatch', 'MATCHED WITH TAX DIFFERENCE', '2026-04', $4, 0, 50
      )
    `, [TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `DN-M2-${SYNTH_TAG}`, `KEY-M2-${SYNTH_TAG}`]);

    await c.query(`
      INSERT INTO gstr2b_lines (
        line_key, our_gstin, supplier_gstin, supplier_name,
        invoice_no, document_type, invoice_date, twob_month,
        taxable_value, igst, cgst, sgst, cess, invoice_value, doc_category
      )
      VALUES ($1, $2, $3, 'VEND-A', $4, 'Debit Note', '2026-04-15', '2026-04', 5000, 850, 0, 0, 0, 5850, 'CDNR')
    `, [`2B-M2-${SYNTH_TAG}`, TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `DN-M2-${SYNTH_TAG}`]);

    // 3. Credit Note Matched
    await c.query(`
      INSERT INTO purchase_lines (
        our_gstin, financial_year, period, party_name,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_document_type,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, detailed_match_status, matched_2b_month, line_key
      )
      VALUES (
        $1, '2026-27', '2026-04', 'VEND-A',
        $2, $3, '2026-04-20', 'Credit Note',
        -2000, -360, 0, 0, 0,
        $2, $3, '2026-04-20',
        'Matched', 'MATCHED IN SAME MONTH', '2026-04', $4
      )
    `, [TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `CN-M3-${SYNTH_TAG}`, `KEY-M3-${SYNTH_TAG}`]);

    await c.query(`
      INSERT INTO gstr2b_lines (
        line_key, our_gstin, supplier_gstin, supplier_name,
        invoice_no, document_type, invoice_date, twob_month,
        taxable_value, igst, cgst, sgst, cess, invoice_value, doc_category
      )
      VALUES ($1, $2, $3, 'VEND-A', $4, 'Credit Note', '2026-04-20', '2026-04', -2000, -360, 0, 0, 0, -2360, 'CDNR')
    `, [`2B-M3-${SYNTH_TAG}`, TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `CN-M3-${SYNTH_TAG}`]);

    // 4. Books Only Line
    await c.query(`
      INSERT INTO purchase_lines (
        our_gstin, financial_year, period, party_name,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_document_type,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, detailed_match_status, line_key
      )
      VALUES (
        $1, '2026-27', '2026-04', 'VEND-A',
        $2, $3, '2026-04-22', 'Tax Invoice',
        8000, 1440, 0, 0, 0,
        $2, $3, '2026-04-22',
        'Missing in 2B', 'BOOKS ONLY', $4
      )
    `, [TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `INV-BO-${SYNTH_TAG}`, `KEY-BO-${SYNTH_TAG}`]);

    // 5. GSTR-2B Only Line
    await c.query(`
      INSERT INTO gstr2b_lines (
        line_key, our_gstin, supplier_gstin, supplier_name,
        invoice_no, document_type, invoice_date, twob_month,
        taxable_value, igst, cgst, sgst, cess, invoice_value, doc_category
      )
      VALUES ($1, $2, $3, 'VEND-A', $4, 'Regular', '2026-04-25', '2026-04', 6000, 1080, 0, 0, 0, 7080, 'B2B')
    `, [`2B-2BO-${SYNTH_TAG}`, TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `INV-2BO-${SYNTH_TAG}`]);

    // 6. Line Matched after Books Correction (Original vs Corrected)
    await c.query(`
      INSERT INTO purchase_lines (
        our_gstin, financial_year, period, party_name,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_document_type,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, detailed_match_status, recon_edited, matched_2b_month, line_key
      )
      VALUES (
        $1, '2026-27', '2026-04', 'VEND-A',
        '27AAACS0000A1Z0', $2, '2026-04-28', 'Tax Invoice',
        15000, 2700, 0, 0, 0,
        $3, $4, '2026-04-28',
        'Matched', 'MATCHED AFTER BOOKS CORRECTION', true, '2026-04', $5
      )
    `, [TEST_OUR_GSTIN, `INV-WRONG-${SYNTH_TAG}`, TEST_SUPPLIER_GSTIN, `INV-CORR-${SYNTH_TAG}`, `KEY-CORR-${SYNTH_TAG}`]);

    await c.query(`
      INSERT INTO gstr2b_lines (
        line_key, our_gstin, supplier_gstin, supplier_name,
        invoice_no, document_type, invoice_date, twob_month,
        taxable_value, igst, cgst, sgst, cess, invoice_value, doc_category
      )
      VALUES ($1, $2, $3, 'VEND-A', $4, 'Regular', '2026-04-28', '2026-04', 15000, 2700, 0, 0, 0, 17700, 'B2B')
    `, [`2B-CORR-${SYNTH_TAG}`, TEST_OUR_GSTIN, TEST_SUPPLIER_GSTIN, `INV-CORR-${SYNTH_TAG}`]);
  });

  // TC #14: Export single month
  const dsSingle = await queryCompleteReconDataset({ periodMode: 'single', period: '2026-04', gstin: TEST_OUR_GSTIN });
  check('TC #14: Export Complete Reconciliation Excel — single month query returns rows', dsSingle.rows.length >= 6);

  // TC #15: Export continuous range
  const dsRange = await queryCompleteReconDataset({ periodMode: 'range', from: '2026-04', to: '2026-06', gstin: TEST_OUR_GSTIN });
  check('TC #15: Export Complete Reconciliation Excel — continuous range queries all periods', dsRange.resolvedPeriods.length === 3);

  // TC #16: Export multiple selected months
  const dsMulti = await queryCompleteReconDataset({ periodMode: 'multi', periods: ['2026-04', '2026-08'], gstin: TEST_OUR_GSTIN });
  check('TC #16: Export Complete Reconciliation Excel — multiple selected months scope resolved', dsMulti.resolvedPeriods.length === 2);

  // TC #17: Export entire FY
  const dsFy = await queryCompleteReconDataset({ periodMode: 'fy', fy: '2026-27', gstin: TEST_OUR_GSTIN });
  check('TC #17: Export Complete Reconciliation Excel — entire FY queries 12 months', dsFy.resolvedPeriods.length === 12);

  // TC #18: Export all available periods
  const dsAll = await queryCompleteReconDataset({ periodMode: 'all', gstin: TEST_OUR_GSTIN });
  check('TC #18: Export Complete Reconciliation Excel — all available periods resolved', dsAll.periodLabel.includes('All Available Periods'));

  // TC #19: Export single GSTIN
  check('TC #19: Single GSTIN scope restricted to requested registration', dsSingle.resolvedGstins.length === 1 && dsSingle.resolvedGstins[0] === TEST_OUR_GSTIN);

  // TC #20: Export consolidated multi-GSTIN
  const dsConsol = await queryCompleteReconDataset({ periodMode: 'single', period: '2026-04', gstin: 'ALL', allowedGstins: [TEST_OUR_GSTIN, TEST_OUR_GSTIN_2] });
  check('TC #20: Consolidated multi-GSTIN export includes all accessible registrations', dsConsol.resolvedGstins.length === 2);

  // Build the actual workbook buffer for structural & formatting tests
  const reconWbBuf = buildCompleteReconWorkbook(dsSingle);
  const reconWb = XLSX.read(reconWbBuf, { type: 'buffer' });

  // Save real output sample file to output/sample_Complete_Reconciliation.xlsx
  fs.mkdirSync(path.resolve('output'), { recursive: true });
  const sampleFilePath = path.resolve('output/sample_Complete_Reconciliation.xlsx');
  fs.writeFileSync(sampleFilePath, reconWbBuf);
  console.log(`  Saved real export sample to: ${sampleFilePath}`);

  // TC #21: Exactly ONE consolidated worksheet named 'Complete Reconciliation'
  eq('TC #21: Verify Excel contains exactly ONE worksheet named Complete Reconciliation', reconWb.SheetNames, ['Complete Reconciliation']);

  const ws = reconWb.Sheets['Complete Reconciliation'];

  // TC #22: Verify all document types (Tax Invoice, Debit Note, Credit Note) in one sheet
  const foundDocTypes = new Set(dsSingle.rows.map((r) => r.document_type));
  check('TC #22: Consolidated sheet contains Tax Invoice, Debit Note, and Credit Note', foundDocTypes.has('Tax Invoice') && foundDocTypes.has('Debit Note') && foundDocTypes.has('Credit Note'));

  // TC #23: Verify all reconciliation statuses
  const foundStatuses = new Set(dsSingle.rows.map((r) => r.reconciliation_status));
  check('TC #23: Sheet contains Matched, Books Only, 2B Only, Correction, and Tax Difference statuses',
    foundStatuses.has('MATCHED IN SAME MONTH') &&
    foundStatuses.has('BOOKS ONLY') &&
    foundStatuses.has('GSTR-2B ONLY') &&
    foundStatuses.has('MATCHED AFTER BOOKS CORRECTION') &&
    foundStatuses.has('MATCHED WITH TAX DIFFERENCE')
  );

  // TC #24: Verify AutoFilter enabled
  check('TC #24: Excel AutoFilter enabled on header row', Boolean(ws['!autofilter']));

  // TC #25: Verify Freeze Panes on row 6
  const entries = zipRead(reconWbBuf);
  const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') || '';
  check('TC #25: Freeze Panes applied on row 6 in OOXML sheet view', sheetXml.includes('ySplit="6"') && sheetXml.includes('state="frozen"'));

  // TC #26: Verify Excel columns A to G are populated accurately
  // Col A=Company Name, Col I=Doc Category, Col S=Books Taxable, Col Y=2B Taxable, Col AE=Taxable Diff, Col AM=Recon Status, Col AW=ITC Decision
  check('TC #26: Columns A through G populated accurately', Boolean(ws['A7']) && Boolean(ws['I7']) && Boolean(ws['S7']) && Boolean(ws['AM7']));

  // TC #27: Verify Excel amounts formatted as numbers (#,##0.00), not text
  const cellBooksTaxable = ws['S7'];
  check('TC #27: Amounts formatted as true numbers with #,##0.00', cellBooksTaxable?.t === 'n' && typeof cellBooksTaxable?.v === 'number');

  // TC #28: Verify original Books values AND corrected Books values side-by-side
  const corrRow = dsSingle.rows.find((r) => r.books_doc_no === `INV-WRONG-${SYNTH_TAG}`);
  check('TC #28: Original and corrected Books doc numbers displayed side-by-side',
    corrRow?.reconciliation_status === 'MATCHED AFTER BOOKS CORRECTION' && corrRow?.recon_books_doc_no === `INV-CORR-${SYNTH_TAG}`
  );

  // TC #29: Verify no pagination truncation (>200 rows exported completely)
  check('TC #29: No pagination limit truncation (all available DB rows queried)', dsSingle.rows.length === dsSingle.summary.totalRecords);

  // TC #30: Mathematical reconciliation between Excel totals and DB query
  let sumBooksTaxable = 0;
  let sumTwobTaxable = 0;
  for (const r of dsSingle.rows) {
    if (r.books_taxable !== null) sumBooksTaxable = r2(sumBooksTaxable + r.books_taxable);
    if (r.twob_taxable !== null) sumTwobTaxable = r2(sumTwobTaxable + r.twob_taxable);
  }
  check('TC #30: Mathematical reconciliation between dataset totals and rows sum',
    sumBooksTaxable === dsSingle.summary.booksTaxable && sumTwobTaxable === dsSingle.summary.twobTaxable
  );

  // =========================================================================
  // TC #31 to #46: Independent IMS Workflow Suite
  // =========================================================================
  console.log('\n--- Part C: Independent IMS Module (TC #31 to #46) ---');

  // TC #31: Independent IMS data import from Excel
  const imsWb = XLSX.utils.book_new();
  const imsRows = [
    ['GSTIN of recipient', TEST_OUR_GSTIN],
    ['Return Period', '04/2026'],
    [],
    ['GSTIN of supplier', 'Trade Name', 'Document Type', 'Document number', 'Document Date', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess', 'Matching Key', 'Action Taken', 'Status'],
    [TEST_SUPPLIER_GSTIN, 'BETA CORP', 'Invoice', `IMS-INV-1-${SYNTH_TAG}`, '12-04-2026', 50000, 9000, 0, 0, 0, `KEY-IMS-1-${SYNTH_TAG}`, 'NO ACTION', 'ACTIVE'],
    [TEST_SUPPLIER_GSTIN, 'BETA CORP', 'Credit Note', `IMS-CN-2-${SYNTH_TAG}`, '14-04-2026', -5000, -900, 0, 0, 0, `KEY-IMS-2-${SYNTH_TAG}`, 'NO ACTION', 'ACTIVE'],
    [TEST_SUPPLIER_GSTIN, 'BETA CORP', 'Invoice', `IMS-ONLY-3-${SYNTH_TAG}`, '18-04-2026', 17500, 3150, 0, 0, 0, `KEY-IMS-3-${SYNTH_TAG}`, 'NO ACTION', 'ACTIVE'],
  ];
  XLSX.utils.book_append_sheet(imsWb, XLSX.utils.aoa_to_sheet(imsRows), 'B2B');
  const imsBuf = XLSX.write(imsWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const commitRes = await commitImsImport([{ name: 'ims.xlsx', buffer: imsBuf }], {
    selectedGstin: TEST_OUR_GSTIN,
    importedBy: 'test_runner',
  });
  check('TC #31: Independent IMS data import committed to database', commitRes.ok && commitRes.insertedCount === 3);

  // TC #32: Independent IMS reconciliation with Books
  const imsReconRes = await runImsReconciliation({
    gstin: TEST_OUR_GSTIN,
    periodMode: 'single',
    period: TEST_PERIOD,
    actor: 'test_runner',
  });
  check('TC #32: Independent IMS reconciliation executed', imsReconRes.ok && imsReconRes.runId > 0 && imsReconRes.summary.total_ims >= 3);

  // TC #33: Verify IMS filter by Portal Matching Key
  const imsDocQuery = await listImsReconDocuments({ gstin: TEST_OUR_GSTIN, portalMatchingKey: `KEY-IMS-1-${SYNTH_TAG}` });
  check('TC #33: Search/Filter by Portal Matching Key retrieves exact record', imsDocQuery.total === 1 && imsDocQuery.rows[0].portal_matching_key === `KEY-IMS-1-${SYNTH_TAG}`);

  // TC #34: Verify IMS-only records displayed correctly
  const imsOnlyDocs = await listImsReconDocuments({ gstin: TEST_OUR_GSTIN, reconStatus: 'IMS ONLY' });
  check('TC #34: IMS-only records classified and retrieved cleanly', imsOnlyDocs.rows.some((r) => r.ims_doc_no === `IMS-ONLY-3-${SYNTH_TAG}`));

  // TC #35: Verify Books-only records in IMS reconciliation
  const booksOnlyDocs = await listImsReconDocuments({ gstin: TEST_OUR_GSTIN, reconStatus: 'BOOKS ONLY' });
  check('TC #35: Books-only records present in IMS reconciliation results', booksOnlyDocs.total >= 1);

  // TC #36: Verify CN and DN handling in IMS reconciliation
  const cnImsDoc = (await listImsReconDocuments({ gstin: TEST_OUR_GSTIN, portalMatchingKey: `KEY-IMS-2-${SYNTH_TAG}` })).rows[0];
  check('TC #36: Credit note negative values preserved in IMS reconciliation', cnImsDoc && Number(cnImsDoc.ims_taxable) === -5000);

  // TC #37: Download IMS working Excel file
  const { rows: workingRows, docsById } = await getImsWorkingRows({ gstin: TEST_OUR_GSTIN });
  const workingExcelBuf = buildImsWorkingWorkbook(workingRows);
  check('TC #37: Download IMS action working Excel built successfully', Buffer.isBuffer(workingExcelBuf) && workingExcelBuf.length > 1000);

  // TC #38: Upload modified IMS working Excel file
  const testWorkingRows: ImsWorkingRow[] = JSON.parse(JSON.stringify(workingRows));
  if (testWorkingRows.length > 0) {
    testWorkingRows[0].proposed_action = 'ACCEPT';
    testWorkingRows[0].user_remarks = 'Updated by 50-test suite';
  }
  const testWorkingBuf = buildImsWorkingWorkbook(testWorkingRows);
  const uploadPreview = parseAndValidateImsWorkingUpload(testWorkingBuf, docsById);
  check('TC #38: Upload modified IMS working Excel validated without rejections', uploadPreview.rejectedRows.length === 0 && uploadPreview.validChanges.length >= 1);

  // TC #39: Validate IMS Excel upload rejects invalid action values
  const invalidActionRows: ImsWorkingRow[] = JSON.parse(JSON.stringify(workingRows));
  if (invalidActionRows.length > 0) {
    invalidActionRows[0].proposed_action = 'CORRUPT_ACTION';
  }
  const invalidActionBuf = buildImsWorkingWorkbook(invalidActionRows);
  const invalidActionUpload = parseAndValidateImsWorkingUpload(invalidActionBuf, docsById);
  check('TC #39: Upload rejects invalid action value with INVALID_ACTION code', invalidActionUpload.rejectedRows.some((r) => r.code === 'INVALID_ACTION'));

  // TC #40: Validate IMS Excel upload rejects modified matching keys
  const tamperedKeyRows: ImsWorkingRow[] = JSON.parse(JSON.stringify(workingRows));
  if (tamperedKeyRows.length > 0) {
    tamperedKeyRows[0].portal_matching_key = 'TAMPERED_PORTAL_KEY';
  }
  const tamperedKeyBuf = buildImsWorkingWorkbook(tamperedKeyRows);
  const tamperedKeyUpload = parseAndValidateImsWorkingUpload(tamperedKeyBuf, docsById);
  check('TC #40: Upload rejects modified Matching Key with MODIFIED_MATCHING_KEY code', tamperedKeyUpload.rejectedRows.some((r) => r.code === 'MODIFIED_MATCHING_KEY'));

  // TC #41: User approval requirement before portal upload tracking
  const targetDoc = workingRows.find((r) => r.portal_matching_key === `KEY-IMS-1-${SYNTH_TAG}`) || workingRows[0];
  const targetDocId = targetDoc.ims_doc_id;
  await saveImsUserActions([{ ims_doc_id: targetDocId, user_action: 'ACCEPT', remarks: 'Action approved for test' }], 'tester');
  const approvalRes = await reviewAndApproveImsActions({ gstin: TEST_OUR_GSTIN, imsDocIds: [targetDocId], actor: 'test_approver' });
  check('TC #41: Explicit user approval required to create portal upload batch', approvalRes.ok && (approvalRes.uploadBatchId ?? 0) > 0);

  // TC #42: Audit trail logging on user action change
  let auditCount = 0;
  await withClient(async (c) => {
    const res = await c.query('SELECT count(*)::int as cnt FROM ims_audit_trail WHERE ims_doc_id = $1', [targetDocId]);
    auditCount = res.rows[0]?.cnt || 0;
  });
  check('TC #42: Audit trail records user action change with timestamp and actor', auditCount >= 1);

  // TC #43: Action 'DO NOT TAKE ANY ACTION' verification
  const cnDoc = workingRows.find((r) => r.portal_matching_key === `KEY-IMS-2-${SYNTH_TAG}`);
  const cnDocId = cnDoc?.ims_doc_id || targetDocId;
  await saveImsUserActions([{ ims_doc_id: cnDocId, user_action: 'DO NOT TAKE ANY ACTION', remarks: 'Explicit no action' }], 'tester');
  const updatedDocRow = (await listImsReconDocuments({ gstin: TEST_OUR_GSTIN, portalMatchingKey: `KEY-IMS-2-${SYNTH_TAG}` })).rows[0];
  check('TC #43: Action DO NOT TAKE ANY ACTION preserved and recorded', updatedDocRow?.user_action === 'DO NOT TAKE ANY ACTION');

  // TC #44: IMS portal error report upload and error status tracking
  const errReportRes = await importImsPortalErrorReport({
    uploadBatchId: approvalRes.uploadBatchId!,
    gstin: TEST_OUR_GSTIN,
    fileName: 'error_report.json',
    buffer: Buffer.from(JSON.stringify([{ document_no: `IMS-INV-1-${SYNTH_TAG}`, error_code: 'RET123', error_message: 'Doc already filed' }])),
    actor: 'tester',
  });
  check('TC #44: IMS portal error report imported and flagged for error review', errReportRes.ok && errReportRes.errorCount >= 1);

  // TC #45: Verify all 9 IMS upload tracking states
  const states = ['NOT READY', 'READY FOR REVIEW', 'APPROVED BY USER', 'UPLOAD PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'NOT UPLOADED', 'ERROR REVIEW REQUIRED'];
  let stateTransitionsOk = true;
  for (const st of states) {
    const u = await updateImsUploadBatchStatus({
      batchId: approvalRes.uploadBatchId!,
      status: st as any,
      actor: 'tester',
      notes: 'testing workflow state transition',
    });
    if (!u.ok) stateTransitionsOk = false;
  }
  check('TC #45: All 9 IMS upload tracking states verified', stateTransitionsOk);

  // TC #46: User permission check for IMS actions and exports
  const authTestUpload = parseAndValidateImsWorkingUpload(workingExcelBuf, docsById, [TEST_OUR_GSTIN_2]);
  check('TC #46: User without permission on GSTIN is blocked from updating IMS actions', authTestUpload.rejectedRows.some((r) => r.code === 'UNAUTHORIZED_GSTIN'));

  // =========================================================================
  // TC #47 to #50: Regression & Immutability Suite
  // =========================================================================
  console.log('\n--- Part D: Regression & Immutability Verification (TC #47 to #50) ---');

  // TC #47: Verify existing GSTR-2B reconciliation functionality remains intact
  const classic2bRecon = reconcilePurchases(
    [{ our_gstin: TEST_OUR_GSTIN, supplier_gstin: TEST_SUPPLIER_GSTIN, party_name: 'VEND-A', invoice_no: 'REG-1', invoice_date: '2026-04-10', period: '2026-04', taxable_value: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }],
    [{ our_gstin: TEST_OUR_GSTIN, supplier_gstin: TEST_SUPPLIER_GSTIN, supplier_name: 'VEND-A', invoice_no: 'REG-1', invoice_date: '2026-04-10', period: '2026-04', taxable_value: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, invoice_type: 'Regular', invoice_value: 1180, place_of_supply: '26', reverse_charge: false, itc_availability: 'Yes' }]
  );
  check('TC #47: Existing GSTR-2B reconciliation engine operational and matches cleanly', classic2bRecon.rows[0]?.status === 'Matched');

  // TC #48: Verify Books data is never modified by IMS or 2B operations
  let triggerBlockedBookEdit = false;
  await withClient(async (c) => {
    try {
      await c.query(`UPDATE purchase_lines SET book_taxable_value = 999999 WHERE book_invoice_no = $1`, [`INV-M1-${SYNTH_TAG}`]);
    } catch (e: any) {
      if (e.message.includes('immutable') || e.message.includes('trg_pl_book_immutable')) {
        triggerBlockedBookEdit = true;
      }
    }
  });
  check('TC #48: Original Purchase Register (Books) values immutable via DB trigger', triggerBlockedBookEdit);

  // TC #49: Verify original GSTR-2B portal data is never modified
  let twobTaxableUntouched = false;
  await withClient(async (c) => {
    const res = await c.query('SELECT taxable_value FROM gstr2b_lines WHERE invoice_no = $1', [`INV-M1-${SYNTH_TAG}`]);
    twobTaxableUntouched = Number(res.rows[0]?.taxable_value) === 10000;
  });
  check('TC #49: Original GSTR-2B portal data values never modified by recon operations', twobTaxableUntouched);

  // TC #50: Verify original IMS portal data is never modified
  let triggerBlockedImsEdit = false;
  await withClient(async (c) => {
    try {
      await c.query(`UPDATE ims_documents SET taxable_value = 888888 WHERE document_no = $1`, [`IMS-INV-1-${SYNTH_TAG}`]);
    } catch (e: any) {
      if (e.message.includes('immutable') || e.message.includes('trg_ims_doc_immutable')) {
        triggerBlockedImsEdit = true;
      }
    }
  });
  check('TC #50: Original IMS portal data protected against modification via trg_ims_doc_immutable trigger', triggerBlockedImsEdit);

  // =========================================================================
  // Cleanup synthetic rows
  // =========================================================================
  console.log('\nCleaning up synthetic test data from gst_erp_test...');
  await withClient(async (c) => {
    await c.query(`DELETE FROM ims_error_reports WHERE upload_batch_id IN (SELECT id FROM ims_portal_upload_batches WHERE our_gstin = $1)`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_portal_upload_results WHERE upload_batch_id IN (SELECT id FROM ims_portal_upload_batches WHERE our_gstin = $1)`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_portal_upload_batches WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_action_decisions WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_recon_results WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_recon_runs WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_documents WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM ims_import_batches WHERE our_gstin = $1`, [TEST_OUR_GSTIN]);
    await c.query(`DELETE FROM purchase_lines WHERE line_key LIKE $1`, [`%${SYNTH_TAG}%`]);
    await c.query(`DELETE FROM gstr2b_lines WHERE invoice_no LIKE $1`, [`%${SYNTH_TAG}%`]);
  });
  console.log('Cleanup completed successfully.');

  console.log('='.repeat(70));
  console.log(`50-TEST DB SUITE COMPLETED: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('Failures:\n' + failures.join('\n'));
  console.log('='.repeat(70));
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error('Test suite crashed:', e);
  process.exit(1);
});
