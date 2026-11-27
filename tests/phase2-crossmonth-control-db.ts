/**
 * Phase 2 — Monthly, Cross-Month & Cross-FY Reconciliation Control DB Test Suite
 *
 * Strictly executes on guarded `gst_erp_test` (NEVER production `gst_erp`).
 * Verifies all 9 mandatory Phase 2 scenarios:
 *   1. April Books vs April GSTR-2B (same month)
 *   2. April pending invoices appearing in May and June GSTR-2B
 *   3. March 2026 Books appearing in April 2026 GSTR-2B (cross-FY)
 *   4. Historical pending invoices appearing up to November 2026 + Apr 2B <-> Nov Books
 *   5. One-to-one matching and prevention of double matching
 *   6. Repeated uploads, duplicate prevention, and idempotency
 *   7. Original Books Month (`period`), Actual GSTR-2B Month (`matched_2b_month`),
 *      and `reconciliation_month` separately identifiable
 *   8. ITC Claim Month (`itc_decision_month`) & `itc_decision` NEVER auto-changed
 *   9. `monthControl()`, `dashboard()`, and `twob-not-in-books` canonical accuracy
 */

import assert from 'node:assert/strict';
import { loadEnv, pgConfig } from '../src/config/env';
import {
  dashboard,
  monthControl,
  persistRun,
  reconcileFinancialYear,
  withClient,
} from '../src/app/store';
import { runReportNamed } from '../src/app/reports';
import { type Gstr2bRecord, type PurchaseBill } from '../src/engine/core';

loadEnv();

const cfg = pgConfig();
if (cfg.database !== 'gst_erp_test') {
  console.error(`REFUSED: phase2-crossmonth-control-db.ts must run ONLY on gst_erp_test (got ${cfg.database})`);
  process.exit(2);
}

const TEST_GSTIN = '24AAACP2222P1Z5';
const SUP_A = '27AAACV1111A1Z1';
const SUP_B = '24AAACV2222B1Z2';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  PASS  ${label}`);
}

function mkBook(p: Partial<PurchaseBill> & { period: string; invoice_no: string; invoice_date: string; source_row: number }): PurchaseBill {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_A,
    party_name: 'PHASE2 TEST VENDOR',
    document_type: 'Tax Invoice',
    taxable_value: 10000,
    igst: 1800,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    invoice_total: 11800,
    source_file: `p2_books_${p.period}.xlsx`,
    ...p,
  };
}

function mk2b(t: Partial<Gstr2bRecord> & { period: string; invoice_no: string; invoice_date: string; source_row: number }): Gstr2bRecord {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_A,
    supplier_name: 'PHASE2 TEST VENDOR',
    invoice_type: 'Regular',
    place_of_supply: '24',
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
    source_file: `p2_2b_${t.period}.json`,
    ...t,
  };
}

async function cleanup() {
  await withClient(async (c) => {
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)', [TEST_GSTIN]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM month_locks WHERE our_gstin = $1', [TEST_GSTIN]);
  });
}

async function main() {
  console.log('\nPhase 2 — Monthly, Cross-Month & Cross-FY Reconciliation DB Tests (gst_erp_test)\n');
  await cleanup();

  try {
    // 1. Seed Purchase Register across Mar 2026 (FY 25-26), Apr 2026, May 2026, Nov 2026
    const books: PurchaseBill[] = [
      // Cross-FY: March 2026 Books -> will match April 2026 GSTR-2B
      mkBook({ period: '2026-03', invoice_no: 'P2-MAR-001', invoice_date: '2026-03-28', source_row: 1 }),
      // April Books -> same-month April 2B
      mkBook({ period: '2026-04', invoice_no: 'P2-APR-001', invoice_date: '2026-04-05', source_row: 2 }),
      // April Books -> pending in Apr, appears in May 2B
      mkBook({ period: '2026-04', invoice_no: 'P2-APR-002', invoice_date: '2026-04-12', source_row: 3 }),
      // April Books -> pending in Apr, appears in June 2B
      mkBook({ period: '2026-04', invoice_no: 'P2-APR-003', invoice_date: '2026-04-18', source_row: 4 }),
      // April Books -> pending all the way until November 2026 2B
      mkBook({ period: '2026-04', invoice_no: 'P2-APR-004', invoice_date: '2026-04-25', source_row: 5 }),
      // April Books -> Amount Mismatch (must NOT count as Matched in monthControl/dashboard!)
      mkBook({ period: '2026-04', invoice_no: 'P2-APR-MISM', invoice_date: '2026-04-20', taxable_value: 20000, igst: 3600, invoice_total: 23600, source_row: 6 }),
      // 1-to-1 competition: May 2026 Books has SAME invoice number as April 2026 P2-APR-001 -> must NOT double-match!
      mkBook({ period: '2026-05', invoice_no: 'P2-APR-001', invoice_date: '2026-04-05', source_row: 7 }),
      // Reverse cross-month: November 2026 Books -> matches April 2026 GSTR-2B!
      mkBook({ period: '2026-11', invoice_no: 'P2-REV-NOV', invoice_date: '2026-04-10', supplier_gstin: SUP_B, source_row: 8 }),
    ];

    const twob: Gstr2bRecord[] = [
      mk2b({ period: '2026-04', invoice_no: 'P2-MAR-001', invoice_date: '2026-03-28', source_row: 1 }),
      mk2b({ period: '2026-04', invoice_no: 'P2-APR-001', invoice_date: '2026-04-05', source_row: 2 }),
      // Mismatch in 2B (taxable 19000 vs book 20000)
      mk2b({ period: '2026-04', invoice_no: 'P2-APR-MISM', invoice_date: '2026-04-20', taxable_value: 19000, igst: 3420, invoice_value: 22420, source_row: 3 }),
      // April 2B invoice that matches November 2026 Books
      mk2b({ period: '2026-04', invoice_no: 'P2-REV-NOV', invoice_date: '2026-04-10', supplier_gstin: SUP_B, source_row: 4 }),
      // Multi-rate UNBOOKED 2B invoice (2 rows for same invoice -> must deduplicate to 1 in twob-not-in-books & monthControl!)
      mk2b({ period: '2026-04', invoice_no: 'P2-UNBOOK-MR', invoice_date: '2026-04-15', supplier_gstin: SUP_B, taxable_value: 5000, igst: 900, invoice_value: 11800, source_row: 5 }),
      mk2b({ period: '2026-04', invoice_no: 'P2-UNBOOK-MR', invoice_date: '2026-04-15', supplier_gstin: SUP_B, taxable_value: 5000, igst: 900, invoice_value: 11800, source_row: 6 }),
      // May, June, November 2B for April pending books
      mk2b({ period: '2026-05', invoice_no: 'P2-APR-002', invoice_date: '2026-04-12', source_row: 7 }),
      mk2b({ period: '2026-06', invoice_no: 'P2-APR-003', invoice_date: '2026-04-18', source_row: 8 }),
      mk2b({ period: '2026-11', invoice_no: 'P2-APR-004', invoice_date: '2026-04-25', source_row: 9 }),
    ];

    // Persist initial books & 2B
    const p1 = await persistRun({ books, twob, reconByBundle: new Map() });
    assert.equal(p1.ok, true, `persistRun failed: ${p1.reason}`);

    // Run chronological FY / historical reconciliation
    const run1 = await reconcileFinancialYear({
      gstin: TEST_GSTIN,
      includeHistoricalPending: true,
      changedBy: 'phase2-test',
    });
    assert.equal(run1.ok, true);

    // Fetch all persisted rows
    const rows = await withClient(async (c) => {
      const r = await c.query(
        `SELECT period, book_invoice_no, match_status, detailed_match_status,
                matched_2b_key, matched_2b_month, reconciliation_month,
                itc_decision, itc_decision_month
           FROM purchase_lines
          WHERE our_gstin = $1
          ORDER BY period, book_invoice_no`,
        [TEST_GSTIN],
      );
      return r.rows as any[];
    });

    const byInv = (period: string, inv: string) =>
      rows.find((r) => r.period === period && r.book_invoice_no === inv);

    check('TC-P2-01: April Books vs April GSTR-2B (same month)', () => {
      const r = byInv('2026-04', 'P2-APR-001');
      assert.equal(r.match_status, 'Matched');
      assert.equal(r.period, '2026-04');
      assert.equal(r.matched_2b_month, '2026-04');
      assert.equal(r.reconciliation_month, '2026-04');
    });

    check('TC-P2-02: April pending bills matched in May & June GSTR-2B', () => {
      const may = byInv('2026-04', 'P2-APR-002');
      const jun = byInv('2026-04', 'P2-APR-003');
      assert.equal(may.match_status, 'Matched');
      assert.equal(may.period, '2026-04');
      assert.equal(may.matched_2b_month, '2026-05');
      assert.equal(may.reconciliation_month, '2026-05');
      assert.equal(jun.match_status, 'Matched');
      assert.equal(jun.period, '2026-04');
      assert.equal(jun.matched_2b_month, '2026-06');
      assert.equal(jun.reconciliation_month, '2026-06');
    });

    check('TC-P2-03: March 2026 Books matched in April 2026 GSTR-2B (Cross-FY)', () => {
      const mar = byInv('2026-03', 'P2-MAR-001');
      assert.equal(mar.match_status, 'Matched');
      assert.equal(mar.period, '2026-03');
      assert.equal(mar.matched_2b_month, '2026-04');
      assert.equal(mar.reconciliation_month, '2026-04');
    });

    check('TC-P2-04: Historical pending up to Nov 2026 + Apr 2B <-> Nov Books', () => {
      const aprToNov = byInv('2026-04', 'P2-APR-004');
      assert.equal(aprToNov.match_status, 'Matched');
      assert.equal(aprToNov.period, '2026-04');
      assert.equal(aprToNov.matched_2b_month, '2026-11');
      assert.equal(aprToNov.reconciliation_month, '2026-11');

      const novToApr = byInv('2026-11', 'P2-REV-NOV');
      assert.equal(novToApr.match_status, 'Matched');
      assert.equal(novToApr.period, '2026-11');
      assert.equal(novToApr.matched_2b_month, '2026-04');
      assert.equal(novToApr.reconciliation_month, '2026-11');
    });

    check('TC-P2-05: Strict 1-to-1 matching prevents cross-month double-claim', () => {
      const mayDup = byInv('2026-05', 'P2-APR-001');
      assert.equal(mayDup.match_status, 'Missing in 2B');
      assert.equal(mayDup.matched_2b_key, null);
      assert.equal(mayDup.reconciliation_month, null);
    });

    check('TC-P2-06: ITC Claim Month & Decision NEVER auto-changed on cross-month/cross-FY match', () => {
      for (const r of rows) {
        assert.equal(r.itc_decision, 'Pending Review', `Expected Pending Review for ${r.book_invoice_no}, got ${r.itc_decision}`);
        assert.equal(r.itc_decision_month, null, `Expected null itc_decision_month for ${r.book_invoice_no}, got ${r.itc_decision_month}`);
      }
    });

    // Idempotency & repeated upload check
    const p2 = await persistRun({ books, twob, reconByBundle: new Map() });
    assert.equal(p2.ok, true);
    await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'phase2-test' });
    const runIdemp = await reconcileFinancialYear({
      gstin: TEST_GSTIN,
      includeHistoricalPending: true,
      changedBy: 'phase2-test',
    });

    const countAfter = await withClient((c) =>
      c.query('SELECT count(*)::int AS n FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]),
    );
    check('TC-P2-07: Repeated upload & re-run is idempotent (0 duplicates, 0 moved)', () => {
      assert.equal(countAfter.rows[0].n, books.length);
      assert.equal(runIdemp.totalChanged, 0);
    });

    // monthControl() & dashboard() accuracy
    const mc = await monthControl({ gstin: TEST_GSTIN });
    const mcApr = mc.find((m) => m.period === '2026-04')!;
    check('TC-P2-08: monthControl() excludes Amount Mismatch from matched & deduplicates 2B docs', () => {
      assert.ok(mcApr, '2026-04 row missing in monthControl');
      assert.equal(mcApr.lines, 5);
      assert.equal(mcApr.matched, 4, 'Matched must exclude the 1 Amount Mismatch row');
      assert.equal(mcApr.mismatch, 1);
      assert.equal(mcApr.twobDocs, 5, '5 canonical 2B docs in 2026-04 (multi-rate unbooked counts as 1)');
      assert.equal(mcApr.unmatched2b, 1, 'Exactly 1 canonical unbooked 2B doc in 2026-04');
      assert.equal(mcApr.taxableDiff, 1000, '20000 - 19000 = 1000 taxable diff');
      assert.equal(mcApr.gstDiff, 180, '3600 - 3420 = 180 GST diff');
    });

    const dashApr = await dashboard({ gstin: TEST_GSTIN, period: '2026-04' });
    const dashMay = await dashboard({ gstin: TEST_GSTIN, period: '2026-05' });
    check('TC-P2-09: dashboard() scopes twobLines by period & excludes Amount Mismatch from itcMatched', () => {
      assert.equal(dashApr.twobLines, 6, 'Raw gstr2b_lines in 2026-04 = 6');
      assert.equal(dashMay.twobLines, 1, 'Raw gstr2b_lines in 2026-05 = 1');
      assert.equal(dashApr.itcMatched, 7200, '4 matched * 1800 = 7200 (excludes 3600 Amount Mismatch)');
    });

    const unbookedReport = await runReportNamed('twob-not-in-books', { gstin: TEST_GSTIN, period: '2026-04' });
    check('TC-P2-10: reports.ts twob-not-in-books deduplicates multi-rate 2B lines into 1 doc', () => {
      assert.ok(unbookedReport);
      assert.equal(unbookedReport!.count, 1);
      assert.equal(Number(unbookedReport!.rows[0].taxable_value), 10000);
      assert.equal(Number(unbookedReport!.rows[0].igst), 1800);
    });

    console.log(`\n==================================================================`);
    console.log(`Phase 2 Cross-Month & Monthly Control DB suite: ${passed} passed, 0 failed`);
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
