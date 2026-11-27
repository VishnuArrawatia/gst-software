/**
 * Phase 3 — Monthly Book Summary (Apr–Mar), book_invoice_value Capture,
 * PAN-wise Supplier Consolidation & SAP Business One Control Totals DB Test Suite.
 *
 * Strictly runs ONLY on guarded `gst_erp_test` (NEVER `gst_erp` or `gst_erp_item_test`).
 * Covers 45 assertions across all 4 Phase 3 deliverables + immutability + duplicate/conflict guards.
 */

import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { loadEnv, pgConfig } from '../src/config/env';
import { parsePurchaseRegister } from '../src/engine/ingest';
import { reconcilePurchases } from '../src/engine/match';
import { type Gstr2bRecord, type PurchaseBill } from '../src/engine/core';
import { persistRun, reReconcile, withClient } from '../src/app/store';
import {
  buildSapControlTemplateWorkbook,
  exportMonthlyBookSummaryWorkbook,
  exportPanConsolidationWorkbook,
  getMonthlyBookSummary,
  getPanSupplierConsolidation,
  getSapControlComparison,
  importSapControlExcel,
  listSapControlHistory,
  parseSapControlExcel,
  saveSapControlTotalManual,
} from '../src/app/phase3-reports';

loadEnv();

const cfg = pgConfig();
if (cfg.database !== 'gst_erp_test') {
  console.error(`REFUSED: phase3-books-pan-sap-db.ts must run ONLY on gst_erp_test (got ${cfg.database})`);
  process.exit(2);
}

const TEST_GSTIN = '26AAACP3333P1Z9';
const TEST_GSTIN_2 = '24AAACP3333P1Z3';
const SUP_PAN1_MH = '27AAACX1234A1Z1';
const SUP_PAN1_GJ = '24AAACX1234A1Z7';
const SUP_PAN2_VALID = '27BBBCC5678B1Z2';
const SUP_BAD_GSTIN = 'INVALIDGSTIN99';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  PASS  ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  PASS  ${label}`);
}

async function cleanup() {
  await withClient(async (c) => {
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin IN ($1, $2))', [TEST_GSTIN, TEST_GSTIN_2]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin IN ($1, $2)', [TEST_GSTIN, TEST_GSTIN_2]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin IN ($1, $2)', [TEST_GSTIN, TEST_GSTIN_2]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin IN ($1, $2)', [TEST_GSTIN, TEST_GSTIN_2]);
    await c.query('DELETE FROM sap_book_control_totals WHERE our_gstin IN ($1, $2)', [TEST_GSTIN, TEST_GSTIN_2]);
    await c.query(`DELETE FROM sap_control_upload_batches WHERE uploaded_by = 'phase3-test'`);
  });
}

function makeExcelBuf(rows: Record<string, unknown>[]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'SAP Summary');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function main() {
  console.log('\nPhase 3 — Monthly Book Summary, book_invoice_value, PAN Consolidation & SAP B1 Controls (gst_erp_test)\n');
  await cleanup();

  try {
    // =========================================================================
    // SECTION A — book_invoice_value Capture, Immutability & Comparison (10 tests)
    // =========================================================================
    const rawWithInvVal: unknown[][] = [
      ['Our GSTIN', 'Supplier Name', 'Supplier GSTIN', 'Invoice No', 'Invoice Date', 'Document Type', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'UTGST', 'Cess', 'Invoice Value'],
      [TEST_GSTIN, 'ALPHA CORP', SUP_PAN1_MH, 'P3-TI-001', '2026-04-10', 'Tax Invoice', 10000, 1800, 0, 0, 0, 0, 11850],
      [TEST_GSTIN, 'ALPHA CORP', SUP_PAN1_MH, 'P3-CN-001', '2026-04-12', 'Credit Note', 2000, 360, 0, 0, 0, 0, 2360],
      [TEST_GSTIN, 'ALPHA CORP', SUP_PAN1_MH, 'P3-DN-001', '2026-04-14', 'Debit Note', 1000, 180, 0, 0, 0, 0, 1185],
    ];
    const parsedWith = parsePurchaseRegister(rawWithInvVal, 'p3_with_invval.xlsx');

    check('P3-01: parsePurchaseRegister captures actual source_invoice_value & book_invoice_value (with TCS/rounding)', () => {
      assert.equal(parsedWith.rows.length, 3);
      assert.equal(parsedWith.rows[0].source_invoice_value, 11850);
      assert.equal(parsedWith.rows[0].book_invoice_value, 11850);
      assert.equal(parsedWith.rows[0].invoice_total, 11850);
    });

    const rawNoInvVal: unknown[][] = [
      ['Our GSTIN', 'Supplier Name', 'Supplier GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'UTGST', 'Cess'],
      [TEST_GSTIN, 'BETA SUPPLIES', SUP_PAN2_VALID, 'P3-NOINV-001', '2026-04-15', 5000, 0, 450, 0, 450, 0],
    ];
    const parsedWithout = parsePurchaseRegister(rawNoInvVal, 'p3_without_invval.xlsx');

    check('P3-02: parsePurchaseRegister keeps source_invoice_value & book_invoice_value NULL when absent (never fabricates)', () => {
      assert.equal(parsedWithout.rows.length, 1);
      assert.equal(parsedWithout.rows[0].source_invoice_value, null);
      assert.equal(parsedWithout.rows[0].book_invoice_value, null);
    });

    check('P3-03: Credit Note book_invoice_value is signed negative while source_invoice_value stays printed positive', () => {
      assert.equal(parsedWith.rows[1].source_invoice_value, 2360);
      assert.equal(parsedWith.rows[1].book_invoice_value, -2360);
    });

    check('P3-04: Debit Note book_invoice_value is signed positive', () => {
      assert.equal(parsedWith.rows[2].source_invoice_value, 1185);
      assert.equal(parsedWith.rows[2].book_invoice_value, 1185);
    });

    const twobInvVal: Gstr2bRecord[] = [
      {
        our_gstin: TEST_GSTIN, supplier_gstin: SUP_PAN1_MH, supplier_name: 'ALPHA CORP',
        invoice_no: 'P3-TI-001', invoice_type: 'Regular', invoice_date: '2026-04-10',
        period: '2026-04', portal_fp: '2026-04', place_of_supply: '26', reverse_charge: false,
        taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0, utgst: 0, cess: 0,
        invoice_value: 11800, itc_availability: 'Yes', reason: '', source_file: 'p3_2b_apr.json', source_row: 1,
      },
      {
        our_gstin: TEST_GSTIN, supplier_gstin: SUP_PAN2_VALID, supplier_name: 'BETA SUPPLIES',
        invoice_no: 'P3-NOINV-001', invoice_type: 'Regular', invoice_date: '2026-04-15',
        period: '2026-04', portal_fp: '2026-04', place_of_supply: '26', reverse_charge: false,
        taxable_value: 5000, igst: 0, cgst: 450, sgst: 0, utgst: 450, cess: 0,
        invoice_value: 5900, itc_availability: 'Yes', reason: '', source_file: 'p3_2b_apr.json', source_row: 2,
      },
    ];

    const reconTest = reconcilePurchases([...parsedWith.rows, ...parsedWithout.rows], twobInvVal);
    const tiRow = reconTest.rows.find((r) => r.invoice_no === 'P3-TI-001')!;
    const noInvRow = reconTest.rows.find((r) => r.invoice_no === 'P3-NOINV-001')!;

    check('P3-05: reconcilePurchases computes exact invoice_value_difference when both Books & 2B have invoice value', () => {
      assert.equal(tiRow.status, 'Matched');
      assert.equal(tiRow.book_invoice_value, 11850);
      assert.equal(tiRow.two_b_invoice_value, 11800);
      assert.equal(tiRow.invoice_value_difference, 50);
    });

    check('P3-06: reconcilePurchases flags Total invoice value difference note when TCS/rounding differs', () => {
      assert.ok(String(tiRow.reason || '').includes('Total invoice value difference'));
    });

    check('P3-07: reconcilePurchases leaves invoice_value_difference NULL when book_invoice_value is NULL', () => {
      assert.equal(noInvRow.status, 'Matched');
      assert.equal(noInvRow.book_invoice_value, null);
      assert.equal(noInvRow.two_b_invoice_value, 5900);
      assert.equal(noInvRow.invoice_value_difference, null);
    });

    // Add more rows across FY 2026-27 (May 2026, Mar 2027, PAN conflicts, 2nd GSTIN) and persist to gst_erp_test
    const extraBooks: PurchaseBill[] = [
      // Same PAN (AAACX1234A) in Gujarat with DIFFERENT vendor name -> triggers MULTIPLE_NAMES_SAME_PAN
      {
        our_gstin: TEST_GSTIN, supplier_gstin: SUP_PAN1_GJ, party_name: 'ALPHA INDUSTRIES GUJARAT',
        invoice_no: 'P3-GJ-001', invoice_date: '2026-05-10', period: '2026-05', document_type: 'Tax Invoice',
        taxable_value: 20000, igst: 3600, cgst: 0, sgst: 0, utgst: 0, cess: 0,
        source_invoice_value: 23600, book_invoice_value: 23600, invoice_total: 23600,
        source_file: 'p3_may.xlsx', source_row: 1,
      },
      // Invalid GSTIN format -> triggers INVALID_GSTIN_FORMAT
      {
        our_gstin: TEST_GSTIN, supplier_gstin: SUP_BAD_GSTIN, party_name: 'UNREGISTERED PARTY',
        invoice_no: 'P3-BAD-001', invoice_date: '2027-03-15', period: '2027-03', document_type: 'Tax Invoice',
        taxable_value: 3000, igst: 0, cgst: 270, sgst: 0, utgst: 270, cess: 0,
        source_invoice_value: 3540, book_invoice_value: 3540, invoice_total: 3540,
        source_file: 'p3_mar27.xlsx', source_row: 1,
      },
      // Second Our GSTIN (Gujarat) to verify GSTIN filtering
      {
        our_gstin: TEST_GSTIN_2, supplier_gstin: SUP_PAN2_VALID, party_name: 'BETA SUPPLIES',
        invoice_no: 'P3-G2-001', invoice_date: '2026-04-20', period: '2026-04', document_type: 'Tax Invoice',
        taxable_value: 8000, igst: 1440, cgst: 0, sgst: 0, utgst: 0, cess: 0,
        source_invoice_value: 9440, book_invoice_value: 9440, invoice_total: 9440,
        source_file: 'p3_g2_apr.xlsx', source_row: 1,
      },
    ];

    const allBooks = [...parsedWith.rows, ...parsedWithout.rows, ...extraBooks];
    const pRes = await persistRun({ books: allBooks, twob: twobInvVal, reconByBundle: new Map() });
    assert.equal(pRes.ok, true, `persistRun failed: ${pRes.reason}`);

    // Reconcile April 2026 for TEST_GSTIN
    const rrApr = await reReconcile(TEST_GSTIN, '2026-04', { changedBy: 'phase3-test' });
    assert.equal(rrApr.ok, true);

    await checkAsync('P3-08: persistRun + reReconcile store source/book/twob invoice_value & diff in DB', async () => {
      const r = await withClient((c) =>
        c.query(
          `SELECT source_invoice_value, book_invoice_value, twob_invoice_value, invoice_value_difference
             FROM purchase_lines WHERE our_gstin = $1 AND book_invoice_no = 'P3-TI-001'`,
          [TEST_GSTIN],
        ),
      );
      assert.equal(Number(r.rows[0].source_invoice_value), 11850);
      assert.equal(Number(r.rows[0].book_invoice_value), 11850);
      assert.equal(Number(r.rows[0].twob_invoice_value), 11800);
      assert.equal(Number(r.rows[0].invoice_value_difference), 50);
    });

    await checkAsync('P3-09: trg_pl_book_immutable blocks direct UPDATE to book_invoice_value', async () => {
      let blocked = false;
      try {
        await withClient((c) =>
          c.query(
            `UPDATE purchase_lines SET book_invoice_value = 99999 WHERE our_gstin = $1 AND book_invoice_no = 'P3-TI-001'`,
            [TEST_GSTIN],
          ),
        );
      } catch (e: any) {
        blocked = String(e.message || '').includes('Book values are immutable');
      }
      assert.equal(blocked, true, 'Expected trg_pl_book_immutable to reject book_invoice_value mutation');
    });

    await checkAsync('P3-10: reReconcile preserves NULL book_invoice_value while storing twob_invoice_value', async () => {
      const r = await withClient((c) =>
        c.query(
          `SELECT book_invoice_value, twob_invoice_value, invoice_value_difference
             FROM purchase_lines WHERE our_gstin = $1 AND book_invoice_no = 'P3-NOINV-001'`,
          [TEST_GSTIN],
        ),
      );
      assert.equal(r.rows[0].book_invoice_value, null);
      assert.equal(Number(r.rows[0].twob_invoice_value), 5900);
      assert.equal(r.rows[0].invoice_value_difference, null);
    });

    // =========================================================================
    // SECTION B — Monthly Book Summary April–March (9 tests)
    // =========================================================================
    const mbs = await getMonthlyBookSummary({ fy: '2026-27', gstin: TEST_GSTIN });

    check('P3-11: Monthly Book Summary returns all 12 months (2026-04 to 2027-03)', () => {
      assert.equal(mbs.months.length, 12);
      assert.equal(mbs.months[0].period, '2026-04');
      assert.equal(mbs.months[11].period, '2027-03');
    });

    const aprRow = mbs.months[0];
    const mayRow = mbs.months[1];
    const junRow = mbs.months[2];
    const marRow = mbs.months[11];

    check('P3-12: April 2026 counts (2 Tax Inv, 1 DN, 1 CN = 4 docs)', () => {
      assert.equal(aprRow.invoiceCount, 4);
      assert.equal(aprRow.taxInvoiceCount, 2);
      assert.equal(aprRow.debitNoteCount, 1);
      assert.equal(aprRow.creditNoteCount, 1);
    });

    check('P3-13: Credit Note reduces April Taxable (10000 - 2000 + 1000 + 5000 = 14000) & Captured Invoice Value', () => {
      assert.equal(aprRow.taxableValue, 14000);
      assert.equal(aprRow.igst, 1620); // 1800 - 360 + 180
      assert.equal(aprRow.invoiceValue, 10675); // 11850 - 2360 + 1185 (P3-NOINV-001 is null)
    });

    check('P3-14: UTGST kept strictly separate from SGST in Monthly Book Summary', () => {
      assert.equal(aprRow.cgst, 450);
      assert.equal(aprRow.sgst, 0);
      assert.equal(aprRow.utgst, 450);
      assert.equal(aprRow.totalGst, 2520); // 1620 + 450 + 0 + 450
    });

    check('P3-15: invoiceValueCapturedCount + missingInvoiceValueCount === invoiceCount', () => {
      assert.equal(aprRow.invoiceValueCapturedCount, 3);
      assert.equal(aprRow.missingInvoiceValueCount, 1);
      assert.equal(aprRow.invoiceValueCapturedCount + aprRow.missingInvoiceValueCount, aprRow.invoiceCount);
    });

    check('P3-16: Annual FY Total mathematically reconciles with sum of 12 months (mathVerified=true)', () => {
      assert.equal(mbs.mathVerified, true);
      assert.equal(mbs.annualTotal.invoiceCount, 6);
      assert.equal(mbs.annualTotal.taxableValue, 37000); // 14000 + 20000 + 3000
      assert.equal(mbs.annualTotal.igst, 5220); // 1620 + 3600
      assert.equal(mbs.annualTotal.cgst, 720); // 450 + 270
      assert.equal(mbs.annualTotal.sgst, 0);
      assert.equal(mbs.annualTotal.utgst, 720); // 450 + 270
      assert.equal(mbs.annualTotal.totalGst, 6660);
      assert.equal(mayRow.taxableValue, 20000);
      assert.equal(marRow.taxableValue, 3000);
    });

    check('P3-17: Empty months (e.g. June 2026) appear with clean zero totals', () => {
      assert.equal(junRow.period, '2026-06');
      assert.equal(junRow.invoiceCount, 0);
      assert.equal(junRow.taxableValue, 0);
      assert.equal(junRow.totalGst, 0);
    });

    const mbsG2 = await getMonthlyBookSummary({ fy: '2026-27', gstin: TEST_GSTIN_2 });
    check('P3-18: GSTIN filter isolates second GSTIN accurately', () => {
      assert.equal(mbsG2.annualTotal.invoiceCount, 1);
      assert.equal(mbsG2.annualTotal.taxableValue, 8000);
      assert.equal(mbsG2.annualTotal.igst, 1440);
    });

    check('P3-19: exportMonthlyBookSummaryWorkbook generates valid Excel with 12 months + annual total', () => {
      const buf = exportMonthlyBookSummaryWorkbook(mbs);
      assert.ok(buf.length > 3000);
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert.ok(wb.SheetNames.length >= 1);
    });

    // =========================================================================
    // SECTION C — PAN-wise Supplier Consolidation & PAN Conflicts (10 tests)
    // =========================================================================
    const panData = await getPanSupplierConsolidation({ gstin: TEST_GSTIN, fy: '2026-27' });
    const panAlpha = panData.pans.find((p) => p.pan === 'AAACX1234A')!;
    const panBeta = panData.pans.find((p) => p.pan === 'BBBCC5678B')!;
    const panBad = panData.pans.find((p) => p.gstins.some((g) => g.supplierGstin === SUP_BAD_GSTIN))!;

    check('P3-20: Consolidates MH & GJ GSTINs sharing PAN AAACX1234A into one PAN row', () => {
      assert.ok(panAlpha);
      assert.equal(panAlpha.gstinCount, 2);
      assert.equal(panAlpha.gstins.length, 2);
    });

    check('P3-21: PAN AAACX1234A totals equal exact sum of its 2 GSTINs', () => {
      assert.equal(panAlpha.invoiceCount, 4); // 3 MH + 1 GJ
      assert.equal(panAlpha.taxableValue, 29000); // (10000-2000+1000) + 20000
      assert.equal(panAlpha.igst, 5220); // 1620 + 3600
      assert.equal(panAlpha.totalGst, 5220);
    });

    check('P3-22: Nested GSTIN breakdown preserves state codes & per-GSTIN numbers', () => {
      const mh = panAlpha.gstins.find((g) => g.supplierGstin === SUP_PAN1_MH)!;
      const gj = panAlpha.gstins.find((g) => g.supplierGstin === SUP_PAN1_GJ)!;
      assert.equal(mh.stateCode, '27');
      assert.equal(mh.taxableValue, 9000);
      assert.equal(gj.stateCode, '24');
      assert.equal(gj.taxableValue, 20000);
    });

    check('P3-23: Grand total across all PANs equals Monthly Book Summary annual total (mathVerified=true)', () => {
      assert.equal(panData.mathVerified, true);
      assert.equal(panData.grandTotal.invoiceCount, mbs.annualTotal.invoiceCount);
      assert.equal(panData.grandTotal.taxableValue, mbs.annualTotal.taxableValue);
      assert.equal(panData.grandTotal.totalGst, mbs.annualTotal.totalGst);
      assert.equal(panData.grandTotal.utgst, mbs.annualTotal.utgst);
    });

    check('P3-24: Detects MULTIPLE_NAMES_SAME_PAN conflict for AAACX1234A', () => {
      assert.equal(panAlpha.hasConflict, true);
      assert.ok(panAlpha.conflicts.some((c) => c.startsWith('MULTIPLE_NAMES_SAME_PAN')));
    });

    check('P3-25: Detects INVALID_GSTIN_FORMAT conflict for malformed supplier GSTIN', () => {
      assert.ok(panBad);
      assert.equal(panBad.hasConflict, true);
      assert.ok(panBad.conflicts.some((c) => c.startsWith('INVALID_GSTIN_FORMAT')));
    });

    check('P3-26: Valid single-name PAN (BBBCC5678B) has zero conflicts', () => {
      assert.ok(panBeta);
      assert.equal(panBeta.hasConflict, false);
      assert.equal(panBeta.conflicts.length, 0);
    });

    check('P3-27: conflictPanCount accurately counts 2 conflicted PANs', () => {
      assert.equal(panData.conflictPanCount, 2);
    });

    const panSearch = await getPanSupplierConsolidation({ gstin: TEST_GSTIN, fy: '2026-27', q: 'BETA' });
    check('P3-28: Search filter q isolates matching PAN/vendor', () => {
      assert.equal(panSearch.panCount, 1);
      assert.equal(panSearch.pans[0].pan, 'BBBCC5678B');
    });

    check('P3-29: exportPanConsolidationWorkbook produces valid 2-sheet Excel', () => {
      const buf = exportPanConsolidationWorkbook(panData);
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert.deepEqual(wb.SheetNames, ['PAN Consolidation', 'GSTIN Breakdown']);
    });

    // =========================================================================
    // SECTION D — SAP Business One Control Totals (16 tests)
    // =========================================================================
    await checkAsync('P3-30: Manual entry saves valid SAP control total (v1, active)', async () => {
      const r = await saveSapControlTotalManual(
        {
          ourGstin: TEST_GSTIN, period: '2026-04', invoiceCount: 4,
          taxableValue: 14000, igst: 1620, cgst: 450, sgst: 0, utgst: 450, cess: 0,
          totalGst: 2520, invoiceValue: 10675, remarks: 'Apr SAP B1',
        },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, true);
      assert.equal(r.rows![0].version_no, 1);
      assert.equal(r.rows![0].is_active, true);
      assert.equal(r.rows![0].source_type, 'MANUAL');
    });

    await checkAsync('P3-31: Manual entry rejects invalid GSTIN format', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: 'BAD123', period: '2026-04', invoiceCount: 1, taxableValue: 100, igst: 18, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 118 },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, 'INVALID_INPUT');
    });

    await checkAsync('P3-32: Manual entry rejects invalid period format', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-19', invoiceCount: 1, taxableValue: 100, igst: 18, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 118 },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, 'INVALID_INPUT');
    });

    await checkAsync('P3-33: Manual entry rejects negative invoice count', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-05', invoiceCount: -2, taxableValue: 100, igst: 18, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 118 },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, 'INVALID_INPUT');
    });

    await checkAsync('P3-34: Manual entry rejects mismatched totalGst vs tax heads sum', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-05', invoiceCount: 1, taxableValue: 1000, igst: 180, cgst: 0, sgst: 0, utgst: 0, cess: 0, totalGst: 500, invoiceValue: 1180 },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, 'INVALID_INPUT');
    });

    await checkAsync('P3-35: Accidental overwrite protection blocks silent overwrite for existing GSTIN+period', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-04', invoiceCount: 5, taxableValue: 15000, igst: 1800, cgst: 450, sgst: 0, utgst: 450, cess: 0, invoiceValue: 17700 },
        { enteredBy: 'phase3-test' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.conflict, true);
      assert.equal(r.code, 'OVERWRITE_PROTECTED');
    });

    await checkAsync('P3-36: Overwrite without explicit overwriteReason is rejected', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-04', invoiceCount: 4, taxableValue: 14000, igst: 1620, cgst: 450, sgst: 0, utgst: 450, cess: 0, invoiceValue: 10675 },
        { enteredBy: 'phase3-test', allowOverwrite: true, overwriteReason: '   ' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, 'OVERWRITE_REASON_REQUIRED');
    });

    await checkAsync('P3-37: Controlled overwrite archives v1 and inserts active v2 with reason', async () => {
      const r = await saveSapControlTotalManual(
        { ourGstin: TEST_GSTIN, period: '2026-04', invoiceCount: 4, taxableValue: 14000, igst: 1620, cgst: 450, sgst: 0, utgst: 450, cess: 0, invoiceValue: 10675, remarks: 'Revised Apr' },
        { enteredBy: 'phase3-test', allowOverwrite: true, overwriteReason: 'Confirmed SAP post-closing entry' },
      );
      assert.equal(r.ok, true);
      assert.equal(r.rows![0].version_no, 2);
      assert.equal(r.rows![0].is_active, true);
    });

    check('P3-38: buildSapControlTemplateWorkbook produces valid parseable SAP Excel', () => {
      const tpl = buildSapControlTemplateWorkbook();
      const parsed = parseSapControlExcel(tpl, 'template.xlsx');
      assert.equal(parsed.ok, true);
      assert.equal(parsed.rows.length, 1);
    });

    check('P3-39: parseSapControlExcel rejects workbook missing required columns', () => {
      const badBuf = makeExcelBuf([{ Foo: 'Bar', Baz: 123 }]);
      const parsed = parseSapControlExcel(badBuf, 'bad.xlsx');
      assert.equal(parsed.ok, false);
      assert.ok(parsed.errors.length > 0);
    });

    check('P3-40: parseSapControlExcel rejects duplicate GSTIN+period rows inside same Excel', () => {
      const dupBuf = makeExcelBuf([
        { 'Our GSTIN': TEST_GSTIN, Period: '2026-05', 'Invoice Count': 1, 'Taxable Value': 20000, IGST: 3600, CGST: 0, SGST: 0, UTGST: 0, Cess: 0, 'Invoice Value': 23600 },
        { 'Our GSTIN': TEST_GSTIN, Period: '2026-05', 'Invoice Count': 2, 'Taxable Value': 21000, IGST: 3780, CGST: 0, SGST: 0, UTGST: 0, Cess: 0, 'Invoice Value': 24780 },
      ]);
      const parsed = parseSapControlExcel(dupBuf, 'dup-rows.xlsx');
      assert.equal(parsed.ok, false);
      assert.ok(parsed.errors.some((e) => e.includes('Duplicate GSTIN + Period')));
    });

    const sapExcelBuf = makeExcelBuf([
      // May 2026: exact match with Books (20000 taxable, 3600 IGST) -> SAP_VERIFIED
      { 'Our GSTIN': TEST_GSTIN, Period: '2026-05', 'Invoice Count': 1, 'Taxable Value': 20000, IGST: 3600, CGST: 0, SGST: 0, UTGST: 0, Cess: 0, 'Total GST': 3600, 'Invoice Value': 23600 },
      // Mar 2027: intentional ₹500 variance vs Books (3500 vs 3000) -> SAP_VARIANCE
      { 'Our GSTIN': TEST_GSTIN, Period: '2027-03', 'Invoice Count': 1, 'Taxable Value': 3500, IGST: 0, CGST: 315, SGST: 0, UTGST: 315, Cess: 0, 'Total GST': 630, 'Invoice Value': 4130 },
    ]);

    await checkAsync('P3-41: importSapControlExcel persists batch + 2 rows atomically', async () => {
      const r = await importSapControlExcel(sapExcelBuf, 'sap_fy2627.xlsx', { uploadedBy: 'phase3-test' });
      assert.equal(r.ok, true);
      assert.equal(r.savedCount, 2);
      assert.ok(r.batchUid && r.batchUid.startsWith('SAP-XLS-'));
    });

    await checkAsync('P3-42: Duplicate Excel upload of identical file is blocked (DUPLICATE_FILE)', async () => {
      const r = await importSapControlExcel(sapExcelBuf, 'sap_fy2627_copy.xlsx', { uploadedBy: 'phase3-test' });
      assert.equal(r.ok, false);
      assert.equal(r.conflict, true);
      assert.equal(r.code, 'DUPLICATE_FILE');
    });

    const comp = await getSapControlComparison({ gstin: TEST_GSTIN, fy: '2026-27' });
    const cmpApr = comp.rows.find((r) => r.period === '2026-04')!;
    const cmpMay = comp.rows.find((r) => r.period === '2026-05')!;
    const cmpMar = comp.rows.find((r) => r.period === '2027-03')!;

    check('P3-43: 3-Way Comparison marks April & May as SAP_VERIFIED with ₹0.00 SAP-vs-Books variance (while keeping Books-vs-2B separate)', () => {
      assert.equal(cmpApr.sapStatus, 'SAP_VERIFIED');
      assert.equal(cmpApr.sapVersion, 2);
      assert.equal(cmpApr.sapVsBooks!.taxableValue, 0);
      assert.equal(cmpApr.sapVsBooks!.totalGst, 0);
      assert.equal(cmpApr.sapVsBooks!.utgst, 0);
      assert.equal(cmpApr.twob.taxableValue, 15000); // 10000 + 5000 from 2B
      assert.equal(cmpApr.booksVs2b.taxableValue, -1000); // 14000 - 15000
      assert.equal(cmpMay.sapStatus, 'SAP_VERIFIED');
    });

    check('P3-44: 3-Way Comparison flags Mar 2027 as SAP_VARIANCE with exact ₹500 taxable & ₹90 GST diff', () => {
      assert.equal(cmpMar.sapStatus, 'SAP_VARIANCE');
      assert.equal(cmpMar.sapVsBooks!.taxableValue, 500);
      assert.equal(cmpMar.sapVsBooks!.cgst, 45);
      assert.equal(cmpMar.sapVsBooks!.utgst, 45);
      assert.equal(cmpMar.sapVsBooks!.totalGst, 90);
      assert.equal(comp.summary.verified, 2);
      assert.equal(comp.summary.variance, 1);
    });

    await checkAsync('P3-45: listSapControlHistory preserves v1+v2 archive AND purchase_lines recon/ITC remain untouched', async () => {
      const hist = await listSapControlHistory({ gstin: TEST_GSTIN, fy: '2026-27' });
      const aprVersions = hist.filter((h: any) => h.period === '2026-04');
      assert.equal(aprVersions.length, 2, 'Both v1 (archived) and v2 (active) must be preserved');
      assert.equal(aprVersions[0].version_no, 2);
      assert.equal(aprVersions[0].is_active, true);
      assert.equal(aprVersions[1].version_no, 1);
      assert.equal(aprVersions[1].is_active, false);

      // Verify ITC decisions & reconciliation statuses untouched
      const plCheck = await withClient((c) =>
        c.query(`SELECT match_status, itc_decision, itc_decision_month FROM purchase_lines WHERE our_gstin = $1 AND book_invoice_no = 'P3-TI-001'`, [TEST_GSTIN]),
      );
      assert.equal(plCheck.rows[0].match_status, 'Matched');
      assert.equal(plCheck.rows[0].itc_decision, 'Pending Review');
      assert.equal(plCheck.rows[0].itc_decision_month, null);
    });

    console.log(`\n==================================================================`);
    console.log(`Phase 3 Books / PAN / SAP Controls DB suite: ${passed} passed, 0 failed`);
    console.log(`==================================================================\n`);
  } finally {
    await cleanup();
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
