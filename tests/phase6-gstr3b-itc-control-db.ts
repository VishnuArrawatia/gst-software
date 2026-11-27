/**
 * Phase 6 — GSTR-3B Table 4 Readiness & Strict Manual ITC Control DB Test Suite
 *
 * Strictly executes ONLY on guarded `gst_erp_test` (NEVER `gst_erp` or `gst_erp_item_test`).
 * Verifies all 10 mandatory Phase 6 scenarios:
 *   1. Normal eligible ITC -> Table 4(A)(5)
 *   2. IMPG ITC -> Table 4(A)(1)
 *   3. RCM ITC -> Table 4(A)(3)
 *   4. Section 17(5) blocked ITC -> Table 4(B)(1) (permanent; reclaim blocked)
 *   5. Other temporary reversal -> Table 4(B)(2) & subsequent manual reclaim -> Table 4(D)(1)
 *   6. UTGST kept strictly separate from SGST across all Table 4 rows
 *   7. Cross-month & cross-FY: Books Month, 2B Month, Decision Month, Claim Month strictly separate
 *   8. Duplicate records & repeated imports excluded from Table 4 (zero double-counting)
 *   9. Strict manual control: mandatory reason, locked-month guard, full audit trail (`recon_corrections` + `audit_trail`)
 *  10. GSTR-3B Table 4 mathematical parity & 2-sheet Excel export parity
 */

import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { loadEnv, pgConfig } from '../src/config/env';
import { type Gstr2bRecord, type PurchaseBill } from '../src/engine/core';
import { lockMonth, persistRun, reconcileFinancialYear, unlockMonth, withClient } from '../src/app/store';
import {
  buildGstr3bTable4ReportFromDb,
  exportGstr3bTable4Workbook,
  recordManualItcDecision,
  recordManualItcReclaim,
} from '../src/app/phase6-gstr3b-control';

loadEnv();

const cfg = pgConfig();
if (cfg.database !== 'gst_erp_test') {
  console.error(`REFUSED: phase6-gstr3b-itc-control-db.ts must run ONLY on gst_erp_test (got ${cfg.database})`);
  process.exit(2);
}

const TEST_GSTIN = '26AAACP6666P1Z4';
const SUP_A = '27AAACU1111A1Z1';
const SUP_UT = '26AAACU2222B1Z2';

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
    party_name: 'PHASE6 VENDOR',
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
    source_file: `p6_books_${p.period}.xlsx`,
    ...p,
  };
}

function mk2b(t: Partial<Gstr2bRecord> & { period: string; invoice_no: string; invoice_date: string; source_row: number }): Gstr2bRecord {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_A,
    supplier_name: 'PHASE6 VENDOR',
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
    source_file: `p6_2b_${t.period}.json`,
    ...t,
  };
}

async function cleanup() {
  await withClient(async (c) => {
    await c.query('DELETE FROM month_locks WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)', [TEST_GSTIN]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM audit_trail WHERE our_gstin = $1', [TEST_GSTIN]);
  });
}

async function main() {
  console.log('\nPhase 6 — GSTR-3B Table 4 Readiness & Strict Manual ITC Control DB Tests (gst_erp_test)\n');
  await cleanup();

  try {
    const books: PurchaseBill[] = [
      // 1. Normal eligible ITC with UT UTGST (State 26) -> 4(A)(5)
      mkBook({
        period: '2026-04', invoice_no: 'P6-ELIG-UT', invoice_date: '2026-04-05',
        supplier_gstin: SUP_UT, party_name: 'UT SUPPLIER',
        taxable_value: 20000, igst: 0, cgst: 1800, sgst: 0, utgst: 1800, cess: 0,
        source_invoice_value: 23600, book_invoice_value: 23600, invoice_total: 23600, source_row: 1,
      }),
      // 2. IMPG (Import of Goods BOE) -> 4(A)(1)
      mkBook({
        period: '2026-04', invoice_no: 'P6-BOE-001', invoice_date: '2026-04-08',
        taxable_value: 50000, igst: 9000, cess: 500,
        source_invoice_value: 59500, book_invoice_value: 59500, invoice_total: 59500, source_row: 2,
      }),
      // 3. RCM (Reverse Charge) -> 4(A)(3)
      mkBook({
        period: '2026-04', invoice_no: 'P6-RCM-001', invoice_date: '2026-04-10',
        supplier_gstin: SUP_UT, party_name: 'GTA TRANSPORTER',
        taxable_value: 10000, igst: 0, cgst: 250, sgst: 0, utgst: 250, cess: 0,
        source_invoice_value: 10500, book_invoice_value: 10500, invoice_total: 10500, source_row: 3,
      }),
      // 4. Section 17(5) Blocked Credit -> 4(B)(1)
      mkBook({
        period: '2026-04', invoice_no: 'P6-BLK-175', invoice_date: '2026-04-12',
        taxable_value: 15000, igst: 2700,
        source_invoice_value: 17700, book_invoice_value: 17700, invoice_total: 17700, source_row: 4,
      }),
      // 5. Temporary Reversal -> 4(B)(2) in Apr 2026, then manually reclaimed -> 4(D)(1) in May 2026
      mkBook({
        period: '2026-04', invoice_no: 'P6-REV-4B2', invoice_date: '2026-04-15',
        supplier_gstin: SUP_UT, party_name: 'UT SUPPLIER',
        taxable_value: 10000, igst: 0, cgst: 900, sgst: 0, utgst: 900, cess: 0,
        source_invoice_value: 11800, book_invoice_value: 11800, invoice_total: 11800, source_row: 5,
      }),
      // 6. Cross-FY bill (Mar 2026 Books -> Apr 2026 2B, manually claimed in May 2026)
      mkBook({
        period: '2026-03', invoice_no: 'P6-XFY-001', invoice_date: '2026-03-29',
        taxable_value: 12000, igst: 2160,
        source_invoice_value: 14160, book_invoice_value: 14160, invoice_total: 14160, source_row: 6,
      }),
      // 7. Duplicate in Books (must be excluded from Table 4!)
      mkBook({
        period: '2026-04', invoice_no: 'P6-DUP-001', invoice_date: '2026-04-20',
        taxable_value: 5000, igst: 900, source_row: 7,
      }),
      mkBook({
        period: '2026-04', invoice_no: 'P6-DUP-001', invoice_date: '2026-04-20',
        taxable_value: 5000, igst: 900, source_row: 8,
      }),
    ];

    const twob: Gstr2bRecord[] = [
      mk2b({
        period: '2026-04', invoice_no: 'P6-ELIG-UT', invoice_date: '2026-04-05',
        supplier_gstin: SUP_UT, supplier_name: 'UT SUPPLIER',
        taxable_value: 20000, igst: 0, cgst: 1800, sgst: 0, utgst: 1800, invoice_value: 23600, source_row: 1,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P6-BOE-001', invoice_date: '2026-04-08',
        doc_category: 'IMPG', taxable_value: 50000, igst: 9000, cess: 500, invoice_value: 59500, source_row: 2,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P6-RCM-001', invoice_date: '2026-04-10',
        supplier_gstin: SUP_UT, supplier_name: 'GTA TRANSPORTER', reverse_charge: true,
        taxable_value: 10000, igst: 0, cgst: 250, sgst: 0, utgst: 250, invoice_value: 10500, source_row: 3,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P6-BLK-175', invoice_date: '2026-04-12',
        taxable_value: 15000, igst: 2700, invoice_value: 17700, source_row: 4,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P6-REV-4B2', invoice_date: '2026-04-15',
        supplier_gstin: SUP_UT, supplier_name: 'UT SUPPLIER',
        taxable_value: 10000, igst: 0, cgst: 900, sgst: 0, utgst: 900, invoice_value: 11800, source_row: 5,
      }),
      mk2b({
        period: '2026-04', invoice_no: 'P6-XFY-001', invoice_date: '2026-03-29',
        taxable_value: 12000, igst: 2160, invoice_value: 14160, source_row: 6,
      }),
    ];

    const pRes = await persistRun({ books, twob, reconByBundle: new Map() });
    assert.equal(pRes.ok, true, `persistRun failed: ${pRes.reason}`);
    await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'phase6-test' });

    const idOf = async (inv: string) => {
      const r = await withClient((c) =>
        c.query(`SELECT id FROM purchase_lines WHERE our_gstin = $1 AND book_invoice_no = $2 LIMIT 1`, [TEST_GSTIN, inv]),
      );
      return Number(r.rows[0].id);
    };

    const idElig = await idOf('P6-ELIG-UT');
    const idImpg = await idOf('P6-BOE-001');
    const idRcm = await idOf('P6-RCM-001');
    const idBlk = await idOf('P6-BLK-175');
    const idRev = await idOf('P6-REV-4B2');
    const idXfy = await idOf('P6-XFY-001');

    await checkAsync('P6-01: Empty reason is rejected on manual ITC control decision', async () => {
      const r = await recordManualItcDecision(idElig, { decision: 'Claim', reason: '   ' }, { changedBy: 'ca-reviewer' });
      assert.equal(r.ok, false);
    });

    await checkAsync('P6-02: Manual ITC decisions record IMPG (4A1), RCM (4A3), Sec 17(5) (4B1), Reversal (4B2) & separate Claim Month', async () => {
      assert.equal((await recordManualItcDecision(idElig, { decision: 'Claim', decisionMonth: '2026-04', claimMonth: '2026-04', reason: 'Eligible UT input' }, { changedBy: 'ca-reviewer' })).ok, true);
      assert.equal((await recordManualItcDecision(idImpg, { decision: 'Claim', isImpg: true, decisionMonth: '2026-04', claimMonth: '2026-04', reason: 'BOE verified with ICEGATE' }, { changedBy: 'ca-reviewer' })).ok, true);
      assert.equal((await recordManualItcDecision(idRcm, { decision: 'Claim', isRcm: true, decisionMonth: '2026-04', claimMonth: '2026-04', reason: 'GTA RCM paid in cash' }, { changedBy: 'ca-reviewer' })).ok, true);
      assert.equal((await recordManualItcDecision(idBlk, { decision: 'Ineligible', reversalType: 'SEC_17_5_BLOCKED', decisionMonth: '2026-04', reason: 'Motor vehicle repair Sec 17(5)' }, { changedBy: 'ca-reviewer' })).ok, true);
      assert.equal((await recordManualItcDecision(idRev, { decision: 'Reversed', reversalType: 'OTHER_TEMPORARY', decisionMonth: '2026-04', reason: 'Rule 37 non-payment within 180 days' }, { changedBy: 'ca-reviewer' })).ok, true);
      // Cross-FY: Books=2026-03, 2B=2026-04, Decision=2026-04, Claim=2026-05 (all 4 kept separate!)
      assert.equal((await recordManualItcDecision(idXfy, { decision: 'Claim', decisionMonth: '2026-04', claimMonth: '2026-05', reason: 'Claimed in May 2026 GSTR-3B' }, { changedBy: 'ca-reviewer' })).ok, true);
    });

    await checkAsync('P6-03: Reclaiming Section 17(5) permanently blocked ITC is strictly refused', async () => {
      const r = await recordManualItcReclaim(idBlk, { reclaimMonth: '2026-05', reason: 'Attempt invalid reclaim' }, { changedBy: 'ca-reviewer' });
      assert.equal(r.ok, false);
      assert.ok(String(r.reason || '').includes('Section 17(5)'));
    });

    await checkAsync('P6-04: Reclaiming 4(B)(2) in same/earlier month is refused; subsequent month May 2026 succeeds', async () => {
      const bad = await recordManualItcReclaim(idRev, { reclaimMonth: '2026-04', reason: 'Same month invalid' }, { changedBy: 'ca-reviewer' });
      assert.equal(bad.ok, false);
      const ok = await recordManualItcReclaim(idRev, { reclaimMonth: '2026-05', reason: 'Vendor paid in May 2026 — Rule 37 reclaim' }, { changedBy: 'ca-reviewer' });
      assert.equal(ok.ok, true);
    });

    // Verify April 2026 GSTR-3B Table 4
    const repApr = await buildGstr3bTable4ReportFromDb({ gstin: TEST_GSTIN, period: '2026-04' });
    check('P6-05: April 2026 Table 4(A)(1) IMPG, 4(A)(3) RCM, 4(A)(5) Other, 4(B)(1) Sec 17(5), 4(B)(2) Reversal & UTGST exact', () => {
      assert.equal(repApr.parityOk, true, `Parity errors: ${repApr.parityErrors.join('; ')}`);
      // 4(A)(1) IMPG: IGST 9000, Cess 500 = 9500
      assert.equal(repApr.table4.table4A1_impg.igst, 9000);
      assert.equal(repApr.table4.table4A1_impg.cess, 500);
      assert.equal(repApr.table4.table4A1_impg.total, 9500);
      // 4(A)(3) RCM: CGST 250, UTGST 250, SGST 0 = 500
      assert.equal(repApr.table4.table4A3_rcm.cgst, 250);
      assert.equal(repApr.table4.table4A3_rcm.sgst, 0);
      assert.equal(repApr.table4.table4A3_rcm.utgst, 250);
      assert.equal(repApr.table4.table4A3_rcm.total, 500);
      // 4(A)(5) All Other: CGST 1800, UTGST 1800, SGST 0 = 3600 (Duplicates excluded!)
      assert.equal(repApr.table4.table4A5_allOther.cgst, 1800);
      assert.equal(repApr.table4.table4A5_allOther.sgst, 0);
      assert.equal(repApr.table4.table4A5_allOther.utgst, 1800);
      assert.equal(repApr.table4.table4A5_allOther.total, 3600);
      // 4(A) Total = 9500 + 500 + 3600 = 13600
      assert.equal(repApr.table4.table4A_total.total, 13600);
      // 4(B)(1) Sec 17(5) Blocked: IGST 2700
      assert.equal(repApr.table4.table4B1_sec17_5.igst, 2700);
      assert.equal(repApr.table4.table4B1_sec17_5.total, 2700);
      // 4(B)(2) Other Reversal: CGST 900, UTGST 900, SGST 0 = 1800
      assert.equal(repApr.table4.table4B2_otherReversal.cgst, 900);
      assert.equal(repApr.table4.table4B2_otherReversal.sgst, 0);
      assert.equal(repApr.table4.table4B2_otherReversal.utgst, 900);
      assert.equal(repApr.table4.table4B2_otherReversal.total, 1800);
      // 4(C) Net ITC = 13600 - 4500 = 9100
      assert.equal(repApr.table4.table4C_netItc.total, 9100);
      assert.equal(repApr.table4.table4C_netItc.sgst, 0);
      assert.equal(repApr.table4.table4C_netItc.utgst, 1150); // (1800+250) - 900 = 1150
    });

    // Verify May 2026 GSTR-3B Table 4: receives Reclaimed 4(D)(1) + Cross-FY bill claimed in May 2026
    const repMay = await buildGstr3bTable4ReportFromDb({ gstin: TEST_GSTIN, period: '2026-05' });
    check('P6-06: May 2026 Table 4(D)(1) captures reclaimed 4(B)(2) UTGST/CGST & Cross-FY bill claimed in May', () => {
      assert.equal(repMay.parityOk, true);
      assert.equal(repMay.table4.table4D1_reclaimed.cgst, 900);
      assert.equal(repMay.table4.table4D1_reclaimed.sgst, 0);
      assert.equal(repMay.table4.table4D1_reclaimed.utgst, 900);
      assert.equal(repMay.table4.table4D1_reclaimed.total, 1800);
      // 4(A)(5) in May includes Cross-FY IGST 2160 + Reclaimed 1800 = 3960
      assert.equal(repMay.table4.table4A5_allOther.igst, 2160);
      assert.equal(repMay.table4.table4A5_allOther.utgst, 900);
      assert.equal(repMay.table4.table4A5_allOther.total, 3960);
    });

    await checkAsync('P6-07: Books Month, 2B Month, Decision Month, Claim Month remain 4 distinct fields after re-reconciliation', async () => {
      // Re-run reconciliation & repeated upload — must NEVER overwrite manual ITC decisions or claim months!
      await persistRun({ books, twob, reconByBundle: new Map() });
      await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'phase6-test' });
      const r = await withClient((c) =>
        c.query(`SELECT period, matched_2b_month, itc_decision, itc_decision_month, itc_claim_month, itc_claim_fy FROM purchase_lines WHERE id = $1`, [idXfy]),
      );
      assert.equal(r.rows[0].period, '2026-03');
      assert.equal(r.rows[0].matched_2b_month, '2026-04');
      assert.equal(r.rows[0].itc_decision, 'Claim');
      assert.equal(r.rows[0].itc_decision_month, '2026-04');
      assert.equal(r.rows[0].itc_claim_month, '2026-05');
      assert.equal(r.rows[0].itc_claim_fy, '2026-27');
    });

    await checkAsync('P6-08: Full audit trail recorded in recon_corrections & audit_trail; locked month rejects manual ITC edits', async () => {
      const rc = await withClient((c) =>
        c.query(`SELECT field_name, old_value, new_value, reason, changed_by FROM recon_corrections WHERE line_id = $1`, [idRev]),
      );
      assert.ok(rc.rows.some((x: any) => x.field_name === 'itc_decision' && x.new_value === 'Reversed'));
      assert.ok(rc.rows.some((x: any) => x.field_name === 'itc_reclaimed' && x.new_value === 'true'));
      assert.ok(rc.rows.some((x: any) => x.field_name === 'itc_reclaim_month' && x.new_value === '2026-05'));

      await lockMonth(TEST_GSTIN, '2026-04', { by: 'admin', reason: 'Phase 6 lock test' });
      const blocked = await recordManualItcDecision(idElig, { decision: 'Do Not Claim', reason: 'Should fail on locked month' }, { changedBy: 'ca-reviewer' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.locked, true);
      await unlockMonth(TEST_GSTIN, '2026-04', { by: 'admin', reason: 'Cleanup after test', adminConfirmed: true });
    });

    check('P6-09: exportGstr3bTable4Workbook produces 2-sheet Excel agreeing with Table 4 totals', () => {
      const buf = exportGstr3bTable4Workbook(repApr);
      assert.ok(buf.length > 3000);
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert.deepEqual(wb.SheetNames, ['GSTR-3B Table 4 Summary', 'Table 4 Invoice Working']);
      const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets['GSTR-3B Table 4 Summary']);
      const netRow = rows.find((x) => x['Table 4 Row'] === '4(C)')!;
      assert.equal(Number(netRow['Total Tax']), repApr.table4.table4C_netItc.total);
      assert.equal(Number(netRow['UTGST']), repApr.table4.table4C_netItc.utgst);
    });

    await checkAsync('P6-10: Duplicate reclaim on already-reclaimed 4(B)(2) invoice is strictly blocked', async () => {
      const dup = await recordManualItcReclaim(idRev, { reclaimMonth: '2026-06', reason: 'Duplicate reclaim attempt' }, { changedBy: 'ca-reviewer' });
      assert.equal(dup.ok, false);
      assert.ok(String(dup.reason || '').includes('Duplicate reclaim blocked'));
    });

    await checkAsync('P6-11: Reclaim exceeding original reversed amount is strictly blocked', async () => {
      // Create a fresh temporary reversal on idElig (3600 total tax), attempt reclaim of 5000 -> rejected
      await recordManualItcDecision(idElig, { decision: 'Reversed', reversalType: 'OTHER_TEMPORARY', decisionMonth: '2026-04', reason: 'Temp reversal for cap test' }, { changedBy: 'ca-reviewer' });
      const over = await recordManualItcReclaim(idElig, { reclaimMonth: '2026-05', reclaimAmount: 5000, reason: 'Over-reclaim attempt' }, { changedBy: 'ca-reviewer' });
      assert.equal(over.ok, false);
      assert.ok(String(over.reason || '').includes('exceeds original reversed ITC'));
      // Restore idElig back to Claim
      await recordManualItcDecision(idElig, { decision: 'Claim', reversalType: null, decisionMonth: '2026-04', claimMonth: '2026-04', reason: 'Restored eligible claim' }, { changedBy: 'ca-reviewer' });
    });

    await checkAsync('P6-12: Deferred ITC (Reclaim Later) cannot be reclaimed via 4(D)(1) and is excluded from 4(A) until explicitly authorized', async () => {
      await recordManualItcDecision(idElig, { decision: 'Reclaim Later', decisionMonth: '2026-04', reason: 'Deferred pending goods receipt' }, { changedBy: 'ca-reviewer' });
      const badRec = await recordManualItcReclaim(idElig, { reclaimMonth: '2026-05', reason: 'Invalid reclaim of deferred' }, { changedBy: 'ca-reviewer' });
      assert.equal(badRec.ok, false);
      const repDef = await buildGstr3bTable4ReportFromDb({ gstin: TEST_GSTIN, period: '2026-04' });
      assert.equal(repDef.table4.table4A5_allOther.total, 0, 'Deferred ITC must NOT appear in 4(A)(5)');
      // Restore idElig back to Claim
      await recordManualItcDecision(idElig, { decision: 'Claim', decisionMonth: '2026-04', claimMonth: '2026-04', reason: 'Goods received — authorized' }, { changedBy: 'ca-reviewer' });
    });

    check('P6-13: 4(C) Net ITC === 4(A) - 4(B) and NEVER double-counts 4(D)(1) disclosure memo', () => {
      // In May 2026: 4(A)(5) = Cross-FY (2160) + Reclaimed (1800) = 3960; 4(B) = 0; 4(C) = 3960 (NOT 3960 + 1800 = 5760!)
      assert.equal(repMay.table4.table4A_total.total, 3960);
      assert.equal(repMay.table4.table4B_total.total, 0);
      assert.equal(repMay.table4.table4C_netItc.total, 3960);
      assert.equal(repMay.table4.table4D1_reclaimed.total, 1800);
      assert.notEqual(repMay.table4.table4C_netItc.total, repMay.table4.table4A_total.total + repMay.table4.table4D1_reclaimed.total);
    });

    console.log('\n--- SAMPLE TABLE 4 OUTPUT (2026-04, GSTIN ' + TEST_GSTIN + ') ---');
    console.log(JSON.stringify(repApr.table4, null, 2));
    console.log('--- SAMPLE TABLE 4 OUTPUT (2026-05 Reclaim Month, GSTIN ' + TEST_GSTIN + ') ---');
    console.log(JSON.stringify(repMay.table4, null, 2));

    console.log(`\n==================================================================`);
    console.log(`Phase 6 GSTR-3B Table 4 & ITC Control DB suite: ${passed} passed, 0 failed`);
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
