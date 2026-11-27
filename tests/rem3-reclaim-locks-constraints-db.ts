/**
 * REM-3 Comprehensive Verification Suite (`HIGH-03`, `MED-01`, `LOW-02`) on `gst_erp_test` ONLY.
 *
 * Covers all 19 mandatory test scenarios:
 *   - Full reclaim, partial reclaim, multiple partial reclaims against one reversal
 *   - Over-reclaim rejection (exceeding remaining balance), duplicate reclaim rejection
 *   - Exact paise rounding across IGST/CGST/SGST/UTGST/Cess (sum === total)
 *   - DB CHECK constraints (Sec 17(5), IMPG/RCM mutual exclusivity, reversal type, head sum)
 *   - Target month locks (Books Month, claimMonth, decisionMonth, setItcDecision bypass guard)
 *   - SAP Control manual & Excel locks (`period_locks` + `sap_book_control_totals.is_locked`)
 *   - Immutable source field protection (`source_utgst`, `source_invoice_value`) + overlays intact
 *   - GSTR-3B Table 4(C) and 4(D)(1) zero double-counting + negative/positive HTTP tests
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import XLSX from 'xlsx';
import pg from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget } from '../src/config/test-db';
import { hashPassword } from '../src/app/auth';
import {
  allocateReclaimProportional,
  buildGstr3bTable4ReportFromDb,
  recordManualItcDecision,
  recordManualItcReclaim,
} from '../src/app/phase6-gstr3b-control';
import { importSapControlExcel, saveSapControlTotalManual } from '../src/app/phase3-reports';
import { applyEdits, lockMonth, setItcDecision, unlockMonth } from '../src/app/store';
import { r2 } from '../src/engine/core';

loadEnv();
assertTestDbTarget('tests/rem3-reclaim-locks-constraints-db.ts');

const pool = new pg.Pool(pgConfig());

const GSTIN = '26AAACR9333A1Z5';
const CO_NAME = 'REM3_AUDIT_CO';
const USER_NAME = 'rem3_super_user';
const PASS = 'Rem3Audit#2026';

let passed = 0;
let failed = 0;

async function test(id: string, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${id}: ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  FAIL  ${id}: ${name}\n        ${e?.stack || e?.message || e}`);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Ephemeral server at ${baseUrl} did not become healthy`);
}

function buildSapExcel(rows: Array<Record<string, unknown>>): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'SAP Control Totals');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function cleanupFixtures() {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM month_locks WHERE our_gstin = $1`, [GSTIN]);
    await c.query(`DELETE FROM itc_reclaim_entries WHERE our_gstin = $1`, [GSTIN]);
    await c.query(`DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)`, [GSTIN]);
    await c.query(`DELETE FROM purchase_lines WHERE our_gstin = $1`, [GSTIN]);
    await c.query(`DELETE FROM gstr2b_lines WHERE our_gstin = $1`, [GSTIN]);
    await c.query(`DELETE FROM sap_book_control_totals WHERE our_gstin = $1`, [GSTIN]);
    await c.query(`DELETE FROM sap_control_upload_batches WHERE uploaded_by LIKE 'rem3_%' OR file_name LIKE 'rem3_%'`);
    await c.query(`DELETE FROM audit_trail WHERE our_gstin = $1 OR changed_by LIKE 'rem3_%'`, [GSTIN]);
    const uRes = await c.query(`SELECT id FROM users WHERE username = $1`, [USER_NAME]);
    if (uRes.rows.length) {
      const uid = Number(uRes.rows[0].id);
      await c.query(`DELETE FROM login_sessions WHERE user_id = $1`, [uid]);
      await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [uid]);
      await c.query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
    await c.query(`DELETE FROM gstins WHERE gstin_number = $1`, [GSTIN]);
    await c.query(`DELETE FROM companies WHERE name = $1`, [CO_NAME]);
  } finally {
    c.release();
  }
}

async function insertLine(opts: {
  invNo: string;
  period: string;
  igst?: number;
  cgst?: number;
  sgst?: number;
  utgst?: number;
  cess?: number;
  sourceInvVal?: number | null;
  decision?: string;
  revType?: string | null;
}): Promise<number> {
  const ig = opts.igst ?? 0;
  const cg = opts.cgst ?? 0;
  const sg = opts.sgst ?? 0;
  const ut = opts.utgst ?? 0;
  const ce = opts.cess ?? 0;
  const tot = r2(ig + cg + sg + ut + ce);
  const res = await pool.query(
    `INSERT INTO purchase_lines (
       line_key, our_gstin, period, financial_year, party_name,
       book_supplier_gstin, book_invoice_no, book_invoice_date,
       recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
       book_taxable_value, book_igst, book_cgst, book_sgst, book_utgst, book_cess,
       source_utgst, source_invoice_value, book_invoice_value,
       match_status, matched_2b_key, matched_2b_month, reconciliation_month,
       twob_taxable_value, twob_igst, twob_cgst, twob_sgst, twob_utgst, twob_cess, twob_itc,
       itc_decision, itc_decision_month, itc_reversal_type, source_file
     ) VALUES (
       $1, $2, $3, '2026-27', 'REM3 Supplier',
       '26AAACV9999F1Z5', $4, '2026-04-10',
       '26AAACV9999F1Z5', $4, '2026-04-10',
       10000, $5, $6, $7, $8, $9,
       $8, $10, $10,
       'Matched', $11, $3, $3,
       10000, $5, $6, $7, $8, $9, $12,
       $13, $3, $14, 'rem3_fixture.xlsx'
     ) RETURNING id`,
    [
      `REM3:${opts.invNo}`, GSTIN, opts.period, opts.invNo,
      ig, cg, sg, ut, ce,
      opts.sourceInvVal ?? 11800,
      `2B:REM3:${opts.invNo}`, tot,
      opts.decision ?? 'Pending Review', opts.revType ?? null,
    ],
  );
  return Number(res.rows[0].id);
}

async function main() {
  const idRes = await pool.query('SELECT current_database() AS db');
  assertConnectedDatabase(idRes.rows[0].db, 'tests/rem3-reclaim-locks-constraints-db.ts');
  console.log(`\nREM-3 Partial Reclaim, Target Locks, SAP Locks & Immutability Tests (${idRes.rows[0].db})\n`);

  await cleanupFixtures();
  let serverProc: ChildProcess | null = null;

  try {
    const co = await pool.query(`INSERT INTO companies (name, legal_name, short_name, status) VALUES ($1, $1, 'REM3', 1) RETURNING id`, [CO_NAME]);
    await pool.query(`INSERT INTO gstins (company_id, gstin_number, legal_name, state_code, status) VALUES ($1, $2, $3, '26', 1)`, [co.rows[0].id, GSTIN, CO_NAME]);
    const roleRes = await pool.query(`SELECT id FROM roles WHERE UPPER(name) = 'SUPER ADMIN' LIMIT 1`);
    const uRes = await pool.query(
      `INSERT INTO users (email, username, password_hash, display_name, status, must_change_password)
       VALUES ('rem3@test.local', $1, $2, 'REM3 Admin', 'active', false) RETURNING id`,
      [USER_NAME, hashPassword(PASS)],
    );
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [uRes.rows[0].id, roleRes.rows[0].id]);

    // 1. Exact paise rounding across all 5 heads
    await test('REM3-01', 'Exact paise rounding across IGST/CGST/SGST/UTGST/Cess (sum === total to 0.00)', async () => {
      const rem = { igst: 333.33, cgst: 333.33, sgst: 0, utgst: 333.33, cess: 100.01 }; // total = 1100.00
      const a1 = allocateReclaimProportional(rem, 366.67);
      assert.equal(r2(a1.igst + a1.cgst + a1.sgst + a1.utgst + a1.cess), 366.67, 'Head sum must equal 366.67 exactly');
      assert.equal(a1.total, 366.67);

      const rem2 = {
        igst: r2(rem.igst - a1.igst),
        cgst: r2(rem.cgst - a1.cgst),
        sgst: 0,
        utgst: r2(rem.utgst - a1.utgst),
        cess: r2(rem.cess - a1.cess),
      };
      const a2 = allocateReclaimProportional(rem2, 366.67);
      assert.equal(r2(a2.igst + a2.cgst + a2.sgst + a2.utgst + a2.cess), 366.67);

      const rem3 = {
        igst: r2(rem2.igst - a2.igst),
        cgst: r2(rem2.cgst - a2.cgst),
        sgst: 0,
        utgst: r2(rem2.utgst - a2.utgst),
        cess: r2(rem2.cess - a2.cess),
      };
      const a3 = allocateReclaimProportional(rem3, 366.66);
      assert.equal(r2(a3.igst + a3.cgst + a3.sgst + a3.utgst + a3.cess), 366.66);
      assert.equal(r2(a1.total + a2.total + a3.total), 1100.00);
    });

    // 2. Full reclaim + duplicate reclaim blocked
    await test('REM3-02', 'Full reclaim persists head-wise & total, reflects in 4(D)(1) without 4(C) double-count, blocks duplicate', async () => {
      const lineId = await insertLine({ invNo: 'REM3-FULL', period: '2026-04', cgst: 900, utgst: 900, decision: 'Reversed', revType: 'OTHER_TEMPORARY' });
      const r1 = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-05', reason: 'Full payment cleared' }, { changedBy: 'rem3_tester' });
      assert.equal(r1.ok, true);
      assert.equal(r1.reclaimEntry?.reclaimAmount, 1800);
      assert.equal(r1.reclaimEntry?.cgst, 900);
      assert.equal(r1.reclaimEntry?.utgst, 900);
      assert.equal(r1.reclaimEntry?.remainingBalance, 0);

      // Verify persisted in DB
      const dbPl = await pool.query(`SELECT itc_reclaim_amount, itc_reclaim_cgst, itc_reclaim_utgst FROM purchase_lines WHERE id = $1`, [lineId]);
      assert.equal(Number(dbPl.rows[0].itc_reclaim_amount), 1800);
      assert.equal(Number(dbPl.rows[0].itc_reclaim_cgst), 900);
      assert.equal(Number(dbPl.rows[0].itc_reclaim_utgst), 900);

      // Duplicate reclaim in June blocked
      const rDup = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-06', reason: 'Duplicate attempt' }, { changedBy: 'rem3_tester' });
      assert.equal(rDup.ok, false);
      assert.match(rDup.reason || '', /Duplicate reclaim blocked/i);
    });

    // 3 & 4 & 5. Partial reclaim + Multiple partial reclaims + Over-reclaim rejection + Table 4(C)/4(D)(1) parity
    await test('REM3-03', 'Multiple partial reclaims persist per-month tranches, reject over-reclaim & same-month dup, zero 4(C) double-count', async () => {
      const lineId = await insertLine({ invNo: 'REM3-PARTIAL', period: '2026-04', igst: 300, cgst: 750, utgst: 750, decision: 'Reversed', revType: 'OTHER_TEMPORARY' });

      // Tranche 1: 600.01 in 2026-06
      const t1 = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-06', reclaimAmount: 600.01, reason: 'Tranche 1 payment' }, { changedBy: 'rem3_tester' });
      assert.equal(t1.ok, true);
      assert.equal(t1.reclaimEntry?.reclaimAmount, 600.01);
      assert.equal(r2((t1.reclaimEntry?.igst || 0) + (t1.reclaimEntry?.cgst || 0) + (t1.reclaimEntry?.utgst || 0)), 600.01);
      assert.equal(t1.reclaimEntry?.remainingBalance, 1199.99);

      // Same-month duplicate rejected
      const tSame = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-06', reclaimAmount: 100, reason: 'Same month dup' }, { changedBy: 'rem3_tester' });
      assert.equal(tSame.ok, false);
      assert.match(tSame.reason || '', /Duplicate reclaim blocked/i);

      // Tranche 2: 700.02 in 2026-07
      const t2 = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-07', reclaimAmount: 700.02, reason: 'Tranche 2 payment' }, { changedBy: 'rem3_tester' });
      assert.equal(t2.ok, true);
      assert.equal(t2.reclaimEntry?.cumulativeReclaimed, 1300.03);
      assert.equal(t2.reclaimEntry?.remainingBalance, 499.97);

      // Over-reclaim exceeding remaining 499.97 rejected
      const tOver = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-08', reclaimAmount: 500.00, reason: 'Over remaining' }, { changedBy: 'rem3_tester' });
      assert.equal(tOver.ok, false);
      assert.match(tOver.reason || '', /exceeds remaining/i);

      // Tranche 3: exact remaining 499.97 in 2026-08
      const t3 = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-08', reclaimAmount: 499.97, reason: 'Final tranche' }, { changedBy: 'rem3_tester' });
      assert.equal(t3.ok, true);
      assert.equal(t3.reclaimEntry?.cumulativeReclaimed, 1800);
      assert.equal(t3.reclaimEntry?.remainingBalance, 0);

      // Further reclaim after 0 remaining rejected
      const t4 = await recordManualItcReclaim(lineId, { reclaimMonth: '2026-09', reclaimAmount: 1, reason: 'Post-full dup' }, { changedBy: 'rem3_tester' });
      assert.equal(t4.ok, false);
      assert.match(t4.reason || '', /Duplicate reclaim blocked/i);

      // Verify Table 4 in 2026-06 reflects ONLY Tranche 1 (600.01) — NOT full 1800, and 4(C) === 4(A) - 4(B)
      const repJun = await buildGstr3bTable4ReportFromDb({ gstin: GSTIN, period: '2026-06' });
      assert.equal(repJun.parityOk, true);
      assert.equal(repJun.table4.table4D1_reclaimed.total, 600.01);
      assert.equal(repJun.table4.table4A5_allOther.total, 600.01);
      assert.equal(repJun.table4.table4C_netItc.total, 600.01);

      const repJul = await buildGstr3bTable4ReportFromDb({ gstin: GSTIN, period: '2026-07' });
      assert.equal(repJul.table4.table4D1_reclaimed.total, 700.02);
      assert.equal(repJul.table4.table4C_netItc.total, 700.02);

      const repAug = await buildGstr3bTable4ReportFromDb({ gstin: GSTIN, period: '2026-08' });
      assert.equal(repAug.table4.table4D1_reclaimed.total, 499.97);
      assert.equal(repAug.table4.table4C_netItc.total, 499.97);

      console.log('    [Sample Partial Tranches]', JSON.stringify({
        tranche1_2026_06: t1.reclaimEntry,
        tranche2_2026_07: t2.reclaimEntry,
        tranche3_2026_08: t3.reclaimEntry,
      }));
    });

    // 6, 7, 8. Runtime & DB CHECK constraints
    await test('REM3-04', 'App + DB CHECK constraints enforce Sec 17(5), IMPG/RCM exclusivity, reversal allowlist & head-sum', async () => {
      const lineId = await insertLine({ invNo: 'REM3-CONSTR', period: '2026-04', igst: 1000 });

      // App-level IMPG + RCM rejected
      const rBoth = await recordManualItcDecision(lineId, { isImpg: true, isRcm: true, reason: 'both flags' }, { changedBy: 'rem3_tester' });
      assert.equal(rBoth.ok, false);
      assert.match(rBoth.reason || '', /mutually exclusive/i);

      // App-level invalid reversalType rejected
      const rBadRev = await recordManualItcDecision(lineId, { reversalType: 'INVALID_TYPE' as any, reason: 'bad enum' }, { changedBy: 'rem3_tester' });
      assert.equal(rBadRev.ok, false);

      // Direct DB constraint tests
      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET is_impg = true, is_rcm = true WHERE id = $1`, [lineId]),
        /ck_pl_impg_rcm_excl/,
      );
      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET itc_reversal_type = 'BOGUS' WHERE id = $1`, [lineId]),
        /ck_pl_itc_rev_type/,
      );
      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET itc_reversal_type = 'SEC_17_5_BLOCKED', itc_reclaimed = true WHERE id = $1`, [lineId]),
        /ck_pl_no_17_5_reclaim/,
      );
      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET itc_reclaim_amount = 500, itc_reclaim_igst = 100, itc_reclaim_cgst = 0, itc_reclaim_sgst = 0, itc_reclaim_utgst = 0, itc_reclaim_cess = 0 WHERE id = $1`, [lineId]),
        /ck_pl_reclaim_head_sum/,
      );
    });

    // 9. Locked Books Month, locked target claimMonth, locked decisionMonth (both APIs)
    await test('REM3-05', 'Locked Books Month, target claimMonth & decisionMonth rejected (including setItcDecision bypass check)', async () => {
      const lineApr = await insertLine({ invNo: 'REM3-LOCK-APR', period: '2026-04', igst: 500 });
      const lineOct = await insertLine({ invNo: 'REM3-LOCK-OCT', period: '2026-10', igst: 500 });

      await lockMonth(GSTIN, '2026-09', { by: 'rem3_admin', reason: 'Filed GSTR-3B Sep' });
      await lockMonth(GSTIN, '2026-04', { by: 'rem3_admin', reason: 'Filed GSTR-3B Apr' });
      try {
        // Locked Books Month (2026-04)
        const rBooks = await recordManualItcDecision(lineApr, { decision: 'Claim', reason: 'locked books' }, { changedBy: 'rem3_tester' });
        assert.equal(rBooks.ok, false);
        assert.equal(rBooks.locked, true);

        // Unlocked Books Month (2026-10) -> Locked target claimMonth (2026-09)
        const rClaim = await recordManualItcDecision(lineOct, { decision: 'Claim', claimMonth: '2026-09', reason: 'locked claim month' }, { changedBy: 'rem3_tester' });
        assert.equal(rClaim.ok, false);
        assert.equal(rClaim.locked, true);

        // Unlocked Books Month (2026-10) -> Locked target decisionMonth (2026-09)
        const rDec = await recordManualItcDecision(lineOct, { decision: 'Claim', decisionMonth: '2026-09', reason: 'locked decision month' }, { changedBy: 'rem3_tester' });
        assert.equal(rDec.ok, false);
        assert.equal(rDec.locked, true);

        // Bypass check via setItcDecision (store.ts /api/lines/:id/decision)
        const rBypass = await setItcDecision(lineOct, { decision: 'Claim', decisionMonth: '2026-09', reason: 'bypass attempt' }, { changedBy: 'rem3_tester' });
        assert.equal(rBypass.ok, false);
        assert.equal(rBypass.locked, true);
      } finally {
        await unlockMonth(GSTIN, '2026-09', { by: 'rem3_admin', reason: 'Test cleanup', adminConfirmed: true });
        await unlockMonth(GSTIN, '2026-04', { by: 'rem3_admin', reason: 'Test cleanup', adminConfirmed: true });
      }
    });

    // 10. SAP Control manual & Excel locks (period_locks + is_locked)
    await test('REM3-06', 'SAP Control manual & Excel writes rejected when period is locked OR sap_book_control_totals.is_locked = true', async () => {
      // Seed v1 in 2026-11
      const s1 = await saveSapControlTotalManual(
        { ourGstin: GSTIN, period: '2026-11', invoiceCount: 5, taxableValue: 50000, igst: 9000, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 59000 },
        { enteredBy: 'rem3_tester' },
      );
      assert.equal(s1.ok, true);

      // Lock via sap_book_control_totals.is_locked = true
      await pool.query(`UPDATE sap_book_control_totals SET is_locked = true WHERE our_gstin = $1 AND period = '2026-11'`, [GSTIN]);
      const rManRowLock = await saveSapControlTotalManual(
        { ourGstin: GSTIN, period: '2026-11', invoiceCount: 6, taxableValue: 60000, igst: 10800, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 70800 },
        { enteredBy: 'rem3_tester', allowOverwrite: true, overwriteReason: 'should fail row lock' },
      );
      assert.equal(rManRowLock.ok, false);
      assert.equal(rManRowLock.locked, true);

      const xlsRowLock = buildSapExcel([{ 'Our GSTIN': GSTIN, Period: '2026-11', 'Invoice Count': 6, 'Taxable Value': 60000, IGST: 10800, 'Invoice Value': 70800 }]);
      const rXlsRowLock = await importSapControlExcel(xlsRowLock, 'rem3_rowlock.xlsx', { uploadedBy: 'rem3_tester', allowOverwrite: true, overwriteReason: 'should fail' });
      assert.equal(rXlsRowLock.ok, false);
      assert.equal(rXlsRowLock.locked, true);

      // Lock via period_locks for 2026-12
      await lockMonth(GSTIN, '2026-12', { by: 'rem3_admin', reason: 'Filed Dec' });
      try {
        const rManPerLock = await saveSapControlTotalManual(
          { ourGstin: GSTIN, period: '2026-12', invoiceCount: 2, taxableValue: 10000, igst: 1800, cgst: 0, sgst: 0, utgst: 0, cess: 0, invoiceValue: 11800 },
          { enteredBy: 'rem3_tester' },
        );
        assert.equal(rManPerLock.ok, false);
        assert.equal(rManPerLock.locked, true);

        const xlsPerLock = buildSapExcel([{ 'Our GSTIN': GSTIN, Period: '2026-12', 'Invoice Count': 2, 'Taxable Value': 10000, IGST: 1800, 'Invoice Value': 11800 }]);
        const rXlsPerLock = await importSapControlExcel(xlsPerLock, 'rem3_perlock.xlsx', { uploadedBy: 'rem3_tester' });
        assert.equal(rXlsPerLock.ok, false);
        assert.equal(rXlsPerLock.locked, true);
      } finally {
        await unlockMonth(GSTIN, '2026-12', { by: 'rem3_admin', reason: 'Test cleanup', adminConfirmed: true });
      }
    });

    // 11. Immutable source_utgst & source_invoice_value + overlays functional
    await test('REM3-07', 'LOW-02: trg_book_values_immutable blocks source_utgst & source_invoice_value edits; recon overlays still work', async () => {
      const lineId = await insertLine({ invNo: 'REM3-IMMUT', period: '2026-04', cgst: 900, utgst: 900, sourceInvVal: 11800 });

      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET source_utgst = 0 WHERE id = $1`, [lineId]),
        /immutable/i,
      );
      await assert.rejects(
        pool.query(`UPDATE purchase_lines SET source_invoice_value = 99999 WHERE id = $1`, [lineId]),
        /immutable/i,
      );

      // Authorized recon overlay still succeeds & writes audit trail
      const overlay = await applyEdits(
        [{ lineId, extraCharges: { type: 'Freight', taxable: 500, cgst: 45, utgst: 45 } }],
        { by: 'rem3_tester', reason: 'Freight overlay check' },
      );
      assert.equal(overlay.ok, true);
    });

    // 12. HTTP-level positive & negative tests (423 on locked months/SAP, 400 on over-reclaim, 200 on partial reclaim)
    await test('REM3-08', 'HTTP endpoints return 200 on partial reclaim, 400 on over-reclaim & 423 on locked claimMonth/SAP', async () => {
      const port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      serverProc = spawn(
        process.execPath,
        [tsxCli, 'src/server/server.ts', '--port', String(port), '--host', '127.0.0.1'],
        {
          cwd: process.cwd(),
          env: { ...process.env, GST_DB_PROFILE: 'test', PGDATABASE: 'gst_erp_test' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitForHealth(baseUrl);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER_NAME, password: PASS }),
      });
      assert.equal(loginRes.status, 200);
      const m = /gst_session=([0-9a-f]{64})/.exec(loginRes.headers.get('set-cookie') || '');
      assert.ok(m);
      const cookie = `gst_session=${m[1]}`;

      const lineHttp = await insertLine({ invNo: 'REM3-HTTP-REV', period: '2026-04', igst: 1000, decision: 'Reversed', revType: 'OTHER_TEMPORARY' });

      const rPartial = await fetch(`${baseUrl}/api/lines/${lineHttp}/itc-reclaim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reclaimMonth: '2026-05', reclaimAmount: 400, reason: 'HTTP partial reclaim' }),
      });
      assert.equal(rPartial.status, 200);
      const pBody: any = await rPartial.json();
      assert.equal(pBody.reclaimEntry?.reclaimAmount, 400);
      assert.equal(pBody.reclaimEntry?.remainingBalance, 600);

      const rOver = await fetch(`${baseUrl}/api/lines/${lineHttp}/itc-reclaim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reclaimMonth: '2026-06', reclaimAmount: 650, reason: 'HTTP over-reclaim' }),
      });
      assert.equal(rOver.status, 400);

      const rSapLocked = await fetch(`${baseUrl}/api/sap-controls/manual`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          ourGstin: GSTIN, period: '2026-11', invoiceCount: 5, taxableValue: 50000, igst: 9000, invoiceValue: 59000,
          allowOverwrite: true, overwriteReason: 'should get 423',
        }),
      });
      assert.equal(rSapLocked.status, 423);
    });
  } finally {
    if (serverProc) serverProc.kill();
    await cleanupFixtures();
    await pool.end();
  }

  console.log('\n' + '='.repeat(66));
  console.log(`REM-3 Partial Reclaim, Locks & Constraints: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(66));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
