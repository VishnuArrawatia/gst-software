/**
 * Phase 5 — Professional Historical Bill-wise Reconciliation Report,
 * 7-Sheet Excel, `pdfkit` Executive PDF, Extended 1-Sheet Complete Export,
 * and 10-Point Mathematical Parity DB Test Suite.
 *
 * Strictly runs ONLY on guarded `gst_erp_test` (NEVER `gst_erp` or `gst_erp_item_test`).
 */

import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { loadEnv, pgConfig } from '../src/config/env';
import { type Gstr2bRecord, type PurchaseBill } from '../src/engine/core';
import { persistRun, reconcileFinancialYear, updateRecon, withClient } from '../src/app/store';
import {
  buildHistoricalReconExcel,
  buildHistoricalReconReport,
  signedMatchedAmount,
} from '../src/app/historical-recon-report';
import { buildHistoricalReconPdf } from '../src/app/historical-recon-pdf';
import {
  buildCompleteReconWorkbook,
  queryCompleteReconDataset,
} from '../src/app/complete-recon-export';

loadEnv();

const cfg = pgConfig();
if (cfg.database !== 'gst_erp_test') {
  console.error(`REFUSED: phase5-historical-report-db.ts must run ONLY on gst_erp_test (got ${cfg.database})`);
  process.exit(2);
}

const TEST_GSTIN = '26AAACP5555P1Z1';
const SUP_A = '27AAACW1111A1Z1';
const SUP_B = '26AAACW2222B1Z2';

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

function mkBook(p: Partial<PurchaseBill> & { period: string; invoice_no: string; invoice_date: string; source_row: number }): PurchaseBill {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_A,
    party_name: 'PHASE5 SUPPLIER A',
    document_type: 'Tax Invoice',
    taxable_value: 10000,
    igst: 1800,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    source_invoice_value: 11800,
    book_invoice_value: 11800,
    invoice_total: 11800,
    source_file: `p5_books_${p.period}.xlsx`,
    ...p,
  };
}

function mk2b(t: Partial<Gstr2bRecord> & { period: string; invoice_no: string; invoice_date: string; source_row: number }): Gstr2bRecord {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_A,
    supplier_name: 'PHASE5 SUPPLIER A',
    invoice_type: 'Regular',
    place_of_supply: '26',
    reverse_charge: false,
    reason: '',
    portal_fp: t.period,
    taxable_value: 10000,
    igst: 1800,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    invoice_value: 11800,
    itc_availability: 'Yes',
    source_file: `p5_2b_${t.period}.json`,
    ...t,
  };
}

async function cleanup() {
  await withClient(async (c) => {
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)', [TEST_GSTIN]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin = $1', [TEST_GSTIN]);
  });
}

async function main() {
  console.log('\nPhase 5 — Professional Historical Bill-wise Reconciliation Report, 7-Sheet Excel & PDFkap/pdfkit Tests (gst_erp_test)\n');
  await cleanup();

  try {
    // 1. Unit check: Signed Matched Amount for Tax Invoice, Debit Note & Negative Credit Note
    check('P5-01: signedMatchedAmount handles positive TI/DN and negative Credit Notes without sign inversion', () => {
      assert.equal(signedMatchedAmount(10000, 10000, true), 10000);
      assert.equal(signedMatchedAmount(10000, 8000, true), 8000);
      assert.equal(signedMatchedAmount(-5000, -5000, true), -5000);
      assert.equal(signedMatchedAmount(-5000, -4000, true), -4000);
      assert.equal(signedMatchedAmount(10000, 0, false), 0);
    });

    // 2. Seed rich multi-month, cross-FY, UT-UTGST, CN, DN, Correction, Mismatch, Only-in-Books, Future-2B & Only-in-2B scenario
    const books: PurchaseBill[] = [
      // Cross-FY: Mar 2026 Books -> Apr 2026 2B
      mkBook({ period: '2026-03', invoice_no: 'P5-CROSSFY-01', invoice_date: '2026-03-28', source_row: 1 }),
      // Same Month Apr 2026 with separated UTGST (State 26)
      mkBook({
        period: '2026-04', invoice_no: 'P5-SAME-UT', invoice_date: '2026-04-05',
        supplier_gstin: SUP_B, party_name: 'PHASE5 UT VENDOR',
        taxable_value: 20000, igst: 0, cgst: 1800, sgst: 0, utgst: 1800, cess: 0,
        source_invoice_value: 23600, book_invoice_value: 23600, invoice_total: 23600, source_row: 2,
      }),
      // Negative Credit Note matched in Same Month Apr 2026
      mkBook({
        period: '2026-04', invoice_no: 'P5-CN-01', invoice_date: '2026-04-12',
        document_type: 'Credit Note', sign_effect: -1,
        source_taxable_value: 3000, source_igst: 540,
        taxable_value: -3000, igst: -540, cgst: 0, sgst: 0, utgst: 0, cess: 0,
        source_invoice_value: 3540, book_invoice_value: -3540, invoice_total: -3540, source_row: 3,
      }),
      // Subsequent Month: Apr 2026 Books -> May 2026 2B
      mkBook({ period: '2026-04', invoice_no: 'P5-SUBSEQ-01', invoice_date: '2026-04-18', source_row: 4 }),
      // Matched after Books Correction (leading-zero fix applied by user)
      mkBook({ period: '2026-04', invoice_no: 'P5-CORR-01', invoice_date: '2026-04-20', source_row: 5 }),
      // Matched with Tax Difference (IGST diff 200)
      mkBook({ period: '2026-04', invoice_no: 'P5-TAXDIFF-01', invoice_date: '2026-04-22', taxable_value: 10000, igst: 1800, source_row: 6 }),
      // Only in Books (period <= latest 2B month 2026-05)
      mkBook({ period: '2026-04', invoice_no: 'P5-BOOKSONLY-01', invoice_date: '2026-04-25', taxable_value: 15000, igst: 2700, source_invoice_value: 17700, book_invoice_value: 17700, source_row: 7 }),
      // Pending for Future GSTR-2B (period 2026-06 > latest 2B month 2026-05)
      mkBook({ period: '2026-06', invoice_no: 'P5-FUTURE-01', invoice_date: '2026-06-05', taxable_value: 8000, igst: 1440, source_invoice_value: 9440, book_invoice_value: 9440, source_row: 8 }),
    ];

    const twob: Gstr2bRecord[] = [
      mk2b({ period: '2026-04', invoice_no: 'P5-CROSSFY-01', invoice_date: '2026-03-28', source_row: 1 }),
      mk2b({
        period: '2026-04', invoice_no: 'P5-SAME-UT', invoice_date: '2026-04-05',
        supplier_gstin: SUP_B, supplier_name: 'PHASE5 UT VENDOR',
        taxable_value: 20000, igst: 0, cgst: 1800, sgst: 0, utgst: 1800, cess: 0, invoice_value: 23600, source_row: 2,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P5-CN-01', invoice_date: '2026-04-12',
        invoice_type: 'Credit Note', taxable_value: -3000, igst: -540, invoice_value: -3540, source_row: 3,
      }),
      mk2b({ period: '2026-05', invoice_no: 'P5-SUBSEQ-01', invoice_date: '2026-04-18', source_row: 4 }),
      mk2b({ period: '2026-04', invoice_no: 'P5-CORR-0001', invoice_date: '2026-04-20', source_row: 5 }),
      mk2b({ period: '2026-04', invoice_no: 'P5-TAXDIFF-01', invoice_date: '2026-04-22', taxable_value: 10000, igst: 1600, invoice_value: 11600, source_row: 6 }),
      // GSTR-2B Only (multi-rate 2 rows for same invoice -> must deduplicate to 1 doc!)
      mk2b({ period: '2026-04', invoice_no: 'P5-2BONLY-MR', invoice_date: '2026-04-27', supplier_gstin: SUP_B, supplier_name: 'PHASE5 UT VENDOR', taxable_value: 6000, igst: 0, cgst: 540, sgst: 0, utgst: 540, invoice_value: 14160, source_row: 7 }),
      mk2b({ period: '2026-04', invoice_no: 'P5-2BONLY-MR', invoice_date: '2026-04-27', supplier_gstin: SUP_B, supplier_name: 'PHASE5 UT VENDOR', taxable_value: 6000, igst: 0, cgst: 540, sgst: 0, utgst: 540, invoice_value: 14160, source_row: 8 }),
    ];

    const pRes = await persistRun({ books, twob, reconByBundle: new Map() });
    assert.equal(pRes.ok, true, `persistRun failed: ${pRes.reason}`);
    await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'phase5-test' });

    // Apply authorized Books correction on P5-CORR-01 -> P5-CORR-0001
    const corrIdRes = await withClient((c) =>
      c.query(`SELECT id FROM purchase_lines WHERE our_gstin = $1 AND book_invoice_no = 'P5-CORR-01'`, [TEST_GSTIN]),
    );
    const corrLineId = Number(corrIdRes.rows[0].id);
    await updateRecon(corrLineId, { recon_invoice_no: 'P5-CORR-0001' }, { changedBy: 'phase5-test', reason: 'Leading-zero confirmed by vendor' });
    await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'phase5-test' });

    // 3. Build Complete Historical Reconciliation Report (all historical periods)
    const report = await buildHistoricalReconReport({ gstin: TEST_GSTIN, periodMode: 'all', reportingDate: '2026-07-01' });

    check('P5-02: All 10 automated mathematical parity checks pass (allParityOk === true)', () => {
      for (const pc of report.parityChecks) {
        assert.equal(pc.ok, true, `Parity #${pc.id} (${pc.name}) failed: ${pc.detail}`);
      }
      assert.equal(report.parityChecks.length, 10);
      assert.equal(report.allParityOk, true);
    });

    check('P5-03: Books & GSTR-2B population totals reconcile with separated UTGST & signed CN', () => {
      assert.equal(report.booksSummary.docs, 8);
      // 10000 + 20000 - 3000 + 10000 + 10000 + 10000 + 15000 + 8000 = 80000
      assert.equal(report.booksSummary.taxableValue, 80000);
      assert.equal(report.booksSummary.sgst, 0);
      assert.equal(report.booksSummary.utgst, 1800);
      assert.equal(report.booksSummary.cgst, 1800);
      assert.equal(report.twobSummary.docs, 7, 'Multi-rate 2B Only deduplicates 8 raw rows into 7 canonical docs');
      assert.equal(report.twobOnlyRegister.length, 1);
      assert.equal(report.twobOnlyRegister[0].taxableValue, 12000);
      assert.equal(report.twobOnlyRegister[0].utgst, 1080);
    });

    check('P5-04: Cross-FY, Subsequent-Month, After-Correction, Tax-Diff, Books-Only & Future-2B buckets are mutually exclusive', () => {
      const bk = (name: string) => report.reconciliationSummary.find((x) => x.bucket === name)!;
      assert.equal(bk('Matched in Same Month').docs, 2); // P5-SAME-UT + P5-CN-01
      assert.equal(bk('Matched in Subsequent Month').docs, 1); // P5-SUBSEQ-01
      assert.equal(bk('Matched in Subsequent Financial Year').docs, 1); // P5-CROSSFY-01
      assert.equal(bk('Matched after Books Correction').docs, 1); // P5-CORR-01
      assert.equal(bk('Fully Matched (Subtotal)').docs, 5);
      assert.equal(bk('Matched with Tax Difference').docs, 1); // P5-TAXDIFF-01
      assert.equal(bk('Partly Matched').docs, 0);
      assert.equal(bk('Only in Books').docs, 1); // P5-BOOKSONLY-01
      assert.equal(bk('Pending for Future GSTR-2B').docs, 1); // P5-FUTURE-01
      assert.equal(bk('Only in GSTR-2B').docs, 1); // P5-2BONLY-MR
    });

    check('P5-05: Cross-FY bill (Mar 2026 -> Apr 2026) stays grouped under Original Books Month 2026-03 & preserves FYs separately', () => {
      const cf = report.booksRegister.find((b) => b.originalBooksInvNo === 'P5-CROSSFY-01')!;
      assert.equal(cf.booksMonth, '2026-03');
      assert.equal(cf.booksFy, '2025-26');
      assert.equal(cf.actual2bMonth, '2026-04');
      assert.equal(cf.actual2bFy, '2026-27');
      assert.equal(cf.itcClaimMonth, '', 'ITC Claim Month must NOT auto-change');
      const mvMar = report.monthMovement.find((m) => m.booksMonth === '2026-03')!;
      assert.equal(mvMar.totalDocs, 1);
      assert.equal(mvMar.subseqFyDocs, 1);
    });

    check('P5-06: Negative Credit Note preserves signed Matched Taxable (-3000) & zero Diff', () => {
      const cn = report.booksRegister.find((b) => b.originalBooksInvNo === 'P5-CN-01')!;
      assert.equal(cn.taxableValue, -3000);
      assert.equal(cn.twobTaxable, -3000);
      assert.equal(cn.matchedTaxable, -3000);
      assert.equal(cn.diffTaxable, 0);
      assert.equal(cn.diffGst, 0);
    });

    check('P5-07: Correction & Audit History sheet captures authorized overlay edit', () => {
      assert.ok(report.correctionHistory.length >= 1);
      assert.equal(report.correctionHistory[0].originalInvNo, 'P5-CORR-01');
      assert.equal(report.correctionHistory[0].newValue, 'P5-CORR-0001');
    });

    check('P5-08: Supplier-wise Summary computes oldest pending invoice age accurately', () => {
      const supA = report.supplierSummary.find((s) => s.supplierGstin === SUP_A)!;
      assert.equal(supA.pendingCount, 3); // TAXDIFF, BOOKSONLY, FUTURE
      assert.equal(supA.oldestPendingDate, '2026-04-22');
      assert.equal(supA.oldestPendingAgeDays, 70); // 2026-04-22 to 2026-07-01
    });

    // 4. Filter verification
    const filteredSup = await buildHistoricalReconReport({ gstin: TEST_GSTIN, supplier: SUP_B, periodMode: 'all' });
    check('P5-09: Supplier filter isolates SUP_B cleanly with allParityOk === true', () => {
      assert.equal(filteredSup.booksSummary.docs, 1);
      assert.equal(filteredSup.twobOnlyRegister.length, 1);
      assert.equal(filteredSup.allParityOk, true);
    });

    // 5. 7-Sheet Professional Excel verification
    check('P5-10: buildHistoricalReconExcel generates exact 7-sheet workbook agreeing with report totals', () => {
      const xlsxBuf = buildHistoricalReconExcel(report);
      assert.ok(xlsxBuf.length > 5000);
      const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
      assert.deepEqual(wb.SheetNames, [
        'Executive Summary',
        'Books Bill-wise Recon',
        'GSTR-2B Only Register',
        'Month-wise Movement',
        'Supplier-wise Summary',
        'Mismatch & Pending Details',
        'Correction & Audit History',
      ]);
      const s2Rows = XLSX.utils.sheet_to_json<any>(wb.Sheets['Books Bill-wise Recon']);
      assert.equal(s2Rows.length, report.booksSummary.docs);
      const s2TaxSum = Math.round(s2Rows.reduce((s, r) => s + Number(r['Taxable Value'] || 0), 0) * 100) / 100;
      assert.equal(s2TaxSum, report.booksSummary.taxableValue);
    });

    // 6. pdfkit Executive PDF verification
    await checkAsync('P5-11: buildHistoricalReconPdf renders valid multi-section PDF with pdfkit cleanly & fast', async () => {
      const t0 = Date.now();
      const pdfBuf = await buildHistoricalReconPdf(report);
      const ms = Date.now() - t0;
      assert.ok(pdfBuf.length > 3000, `PDF buffer too small: ${pdfBuf.length}`);
      assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-', 'Must start with %PDF- header');
      assert.ok(pdfBuf.subarray(pdfBuf.length - 32).toString('ascii').includes('%%EOF'), 'Must end with %%EOF');
      assert.ok(ms < 5000, `PDF generation should be fast (took ${ms}ms)`);
      console.log(`        (pdfkit generated ${pdfBuf.length} bytes in ${ms}ms)`);
    });

    // 7. Extended 1-Sheet Complete Reconciliation Export parity check
    await checkAsync('P5-12: Extended 1-Sheet Complete Recon Export includes UTGST, Invoice Value, PAN, Reconciliation Month & matches Books totals', async () => {
      const ds = await queryCompleteReconDataset({ gstin: TEST_GSTIN, periodMode: 'all' });
      const booksRows = ds.rows.filter((r) => r.books_taxable !== null);
      assert.equal(booksRows.length, report.booksSummary.docs);
      const utRow = booksRows.find((r) => r.books_doc_no === 'P5-SAME-UT')!;
      assert.equal(utRow.books_utgst, 1800);
      assert.equal(utRow.twob_utgst, 1800);
      assert.equal(utRow.books_invoice_value, 23600);
      assert.equal(utRow.supplier_pan, 'AAACW2222B');
      const cfRow = booksRows.find((r) => r.books_doc_no === 'P5-CROSSFY-01')!;
      assert.equal(cfRow.reconciliation_month, '2026-04');
      const wbBuf = buildCompleteReconWorkbook(ds);
      const wb = XLSX.read(wbBuf, { type: 'buffer' });
      assert.deepEqual(wb.SheetNames, ['Complete Reconciliation']);
    });

    console.log(`\n==================================================================`);
    console.log(`Phase 5 Historical Report, 7-Sheet Excel & PDF suite: ${passed} passed, 0 failed`);
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
