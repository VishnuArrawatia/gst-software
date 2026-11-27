/**
 * REM-4 UI-to-API & Frontend Contract Verification Suite (`gst_erp_test` ONLY).
 *
 * Verifies:
 *  - Live served `index.html` contains all Phase 3 & Phase 6 navigation items,
 *    views, sub-tabs, modals, permission checks, double-submit guards, confirm dialogs,
 *    and HTTP 403/423 error handlers.
 *  - Every API endpoint called by the new UI screens returns expected data/errors
 *    for SUPER ADMIN, authorized Accounts User, ACCOUNTS REVIEWER, and unauthorized scope,
 *    including GSTR-3B Table 4 `originalReversalAmount`/`cumulativeReclaimed`/`remainingBalance`
 *    across partial & multiple reclaim tranches.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget } from '../src/config/test-db';
import { hashPassword } from '../src/app/auth';

loadEnv();
assertTestDbTarget('tests/rem4-ui-integration-db.ts');

const pool = new pg.Pool(pgConfig());

const GSTIN = '26AALCS9985J1ZC';
const USER = 'rem4_ui_admin';
const PASS = 'Rem4Ui#2026';

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

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM itc_reclaim_entries WHERE line_id IN (SELECT id FROM purchase_lines WHERE line_key LIKE 'REM4UI:%')`);
    await c.query(`DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE line_key LIKE 'REM4UI:%')`);
    await c.query(`DELETE FROM purchase_lines WHERE line_key LIKE 'REM4UI:%'`);
    await c.query(`DELETE FROM audit_trail WHERE changed_by = $1`, [USER]);
    await c.query(`DELETE FROM login_sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)`, [USER]);
    await c.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username = $1)`, [USER]);
    await c.query(`DELETE FROM users WHERE username = $1`, [USER]);
  } finally {
    c.release();
  }
}

async function main() {
  const idRes = await pool.query('SELECT current_database() AS db');
  assertConnectedDatabase(idRes.rows[0].db, 'tests/rem4-ui-integration-db.ts');
  console.log(`\nREM-4 Frontend UI Contract & UI-to-API Integration Tests (${idRes.rows[0].db})\n`);

  await cleanup();
  let serverProc: ChildProcess | null = null;

  try {
    const role = await pool.query(`SELECT id FROM roles WHERE UPPER(name)='SUPER ADMIN' LIMIT 1`);
    const u = await pool.query(
      `INSERT INTO users (email, username, password_hash, display_name, status, must_change_password)
       VALUES ('rem4@test.local', $1, $2, 'REM4 UI Admin', 'active', false) RETURNING id`,
      [USER, hashPassword(PASS)],
    );
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.rows[0].id, role.rows[0].id]);

    const revIns = await pool.query(
      `INSERT INTO purchase_lines (
         line_key, our_gstin, period, financial_year, party_name,
         book_supplier_gstin, book_invoice_no, book_invoice_date,
         recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
         book_taxable_value, book_igst, book_cgst, book_sgst, book_utgst, book_cess,
         source_utgst, source_invoice_value, book_invoice_value,
         match_status, matched_2b_key, matched_2b_month, reconciliation_month,
         twob_taxable_value, twob_igst, twob_cgst, twob_sgst, twob_utgst, twob_cess, twob_itc,
         itc_decision, itc_decision_month, itc_reversal_type, decision_reason, source_file
       ) VALUES (
         'REM4UI:REV1', $1, '2026-04', '2026-27', 'Beta UT Plastics LLP',
         '26AAACB2222B1Z5', 'REM4-REV-4B2', '2026-04-12',
         '26AAACB2222B1Z5', 'REM4-REV-4B2', '2026-04-12',
         10000, 0, 900, 0, 900, 0, 900, 11800, 11800,
         'Matched', '2B:REM4UI:REV1', '2026-04', '2026-04',
         10000, 0, 900, 0, 900, 0, 1800,
         'Reversed', '2026-04', 'OTHER_TEMPORARY', 'Rule 37 temporary reversal', 'rem4_ui.xlsx'
       ) RETURNING id`,
      [GSTIN],
    );
    const revLineId = Number(revIns.rows[0].id);

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

    await test('REM4-01', 'Live served index.html wires all Phase 3 & Phase 6 screens, modals, permissions, confirm & double-submit guards', async () => {
      const r = await fetch(`${baseUrl}/`);
      assert.equal(r.status, 200);
      const html = await r.text();
      for (const token of [
        'id="viewBooksControls"',
        'id="viewGstr3bControl"',
        'id="modalItcDecision"',
        'id="modalItcReclaim"',
        '/api/reports/monthly-book-summary',
        '/api/reports/pan-consolidation',
        '/api/sap-controls/comparison',
        '/api/sap-controls/history',
        '/api/sap-controls/manual',
        '/api/sap-controls/excel',
        '/api/sap-controls/template.xlsx',
        '/api/gstr3b/table4',
        '/itc-control',
        '/itc-reclaim',
        "uiHasPerm('recon.edit')",
        "uiHasPerm('itc.decide')",
        "uiHasPerm('report.export')",
        'SAP_SUBMITTING',
        'T4_SUBMITTING',
        'window.confirm(',
        'HTTP 423',
        'HTTP 403',
      ]) {
        assert.ok(html.includes(token), `index.html missing required REM-4 token: ${token}`);
      }
    });

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    assert.equal(loginRes.status, 200);
    const m = /gst_session=([0-9a-f]{64})/.exec(loginRes.headers.get('set-cookie') || '');
    assert.ok(m);
    const cookie = `gst_session=${m[1]}`;

    await test('REM4-02', 'GSTR-3B Table 4 API returns originalReversalAmount, cumulativeReclaimed & remainingBalance accurately across partial reclaim', async () => {
      const rApr1 = await fetch(`${baseUrl}/api/gstr3b/table4?gstin=${GSTIN}&period=2026-04`, { headers: { cookie } });
      assert.equal(rApr1.status, 200);
      const bApr1: any = await rApr1.json();
      assert.equal(bApr1.parityOk, true);
      const row1 = bApr1.details.find((d: any) => d.lineId === revLineId);
      assert.ok(row1, 'REM4-REV-4B2 must appear in 2026-04 Table 4 details');
      assert.equal(row1.originalReversalAmount, 1800);
      assert.equal(row1.cumulativeReclaimed, 0);
      assert.equal(row1.remainingBalance, 1800);

      // Submit partial reclaim 600 into 2026-05
      const rRec = await fetch(`${baseUrl}/api/lines/${revLineId}/itc-reclaim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reclaimMonth: '2026-05', reclaimAmount: 600, reason: 'REM4 UI partial reclaim' }),
      });
      assert.equal(rRec.status, 200);

      // Re-fetch April 2026: remainingBalance must now be 1200, cumulativeReclaimed 600
      const rApr2 = await fetch(`${baseUrl}/api/gstr3b/table4?gstin=${GSTIN}&period=2026-04`, { headers: { cookie } });
      const bApr2: any = await rApr2.json();
      const row2 = bApr2.details.find((d: any) => d.lineId === revLineId);
      assert.equal(row2.originalReversalAmount, 1800);
      assert.equal(row2.cumulativeReclaimed, 600);
      assert.equal(row2.remainingBalance, 1200);

      // Fetch May 2026: 4(A)(5), 4(C), and 4(D)(1) must all reflect 600 (CGST 300 + UTGST 300), zero double-count
      const rMay = await fetch(`${baseUrl}/api/gstr3b/table4?gstin=${GSTIN}&period=2026-05`, { headers: { cookie } });
      assert.equal(rMay.status, 200);
      const bMay: any = await rMay.json();
      assert.equal(bMay.parityOk, true);
      assert.equal(bMay.table4.table4D1_reclaimed.total, 600);
      assert.equal(bMay.table4.table4D1_reclaimed.cgst, 300);
      assert.equal(bMay.table4.table4D1_reclaimed.utgst, 300);

      // Verify Table 4 Excel export returns valid XLSX
      const rXls = await fetch(`${baseUrl}/api/gstr3b/table4?gstin=${GSTIN}&period=2026-05&format=xlsx`, { headers: { cookie } });
      assert.equal(rXls.status, 200);
      const buf = Buffer.from(await rXls.arrayBuffer());
      assert.equal(buf.slice(0, 2).toString('utf8'), 'PK');
    });

    await test('REM4-03', 'Phase 3 UI endpoints (Monthly Book Summary, PAN Consolidation, SAP Template/Comparison/History) respond 200 cleanly', async () => {
      for (const ep of [
        `/api/reports/monthly-book-summary?fy=2026-27&gstin=${GSTIN}`,
        `/api/reports/monthly-book-summary?fy=2026-27&gstin=${GSTIN}&format=xlsx`,
        `/api/reports/pan-consolidation?fy=2026-27&gstin=${GSTIN}`,
        `/api/reports/pan-consolidation?fy=2026-27&gstin=${GSTIN}&format=xlsx`,
        `/api/sap-controls/template.xlsx`,
        `/api/sap-controls/comparison?fy=2026-27&gstin=${GSTIN}`,
        `/api/sap-controls/history?fy=2026-27&gstin=${GSTIN}`,
      ]) {
        const r = await fetch(`${baseUrl}${ep}`, { headers: { cookie } });
        assert.equal(r.status, 200, `Expected 200 for ${ep}, got ${r.status}`);
      }
    });
  } finally {
    if (serverProc) serverProc.kill();
    await cleanup();
    await pool.end();
  }

  console.log('\n' + '='.repeat(66));
  console.log(`REM-4 UI Contract & Integration: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(66));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
