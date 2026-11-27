/**
 * REM-1 HTTP-Level RBAC & Multi-Tenant Isolation Integration Tests (`gst_erp_test` ONLY).
 *
 * Verifies CRIT-01, CRIT-02, and LOW-01 over real HTTP against an ephemeral
 * Express server instance bound to a random port on 127.0.0.1 (never port 4310).
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

loadEnv();
assertTestDbTarget('tests/rem1-tenant-rbac-http-db.ts');

const pool = new pg.Pool(pgConfig());

const CO_A_NAME = 'REM1_AUDIT_CO_A';
const CO_B_NAME = 'REM1_AUDIT_CO_B';
const GSTIN_A = '26AAACR1111A1Z5';
const GSTIN_B = '27AAACR2222B1Z5';
const PERIOD = '2026-04';
const RECLAIM_PERIOD = '2026-05';
const PASS = 'Rem1Audit#2026';

const USERS = {
  superAll: 'rem1_super_all',
  superScopedA: 'rem1_super_scoped_a',
  acctA: 'rem1_acct_a',
  revA: 'rem1_rev_a',
};

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
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Ephemeral server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

function buildSapExcel(rows: Array<Record<string, unknown>>): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'SAP Control Totals');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function loginAs(baseUrl: string, username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  });
  assert.equal(res.status, 200, `Login failed for ${username}: status ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = /gst_session=([0-9a-f]{64})/.exec(setCookie);
  assert.ok(m, `Missing gst_session cookie for ${username}`);
  return `gst_session=${m[1]}`;
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin IN ($1, $2))`, [GSTIN_A, GSTIN_B]);
    await client.query(`DELETE FROM purchase_lines WHERE our_gstin IN ($1, $2)`, [GSTIN_A, GSTIN_B]);
    await client.query(`DELETE FROM gstr2b_lines WHERE our_gstin IN ($1, $2)`, [GSTIN_A, GSTIN_B]);
    await client.query(`DELETE FROM sap_book_control_totals WHERE our_gstin IN ($1, $2)`, [GSTIN_A, GSTIN_B]);
    await client.query(`DELETE FROM sap_control_upload_batches WHERE uploaded_by LIKE 'rem1_%' OR file_name LIKE 'rem1_%'`);
    await client.query(`DELETE FROM audit_trail WHERE our_gstin IN ($1, $2) OR changed_by LIKE 'rem1_%'`, [GSTIN_A, GSTIN_B]);
    const uRes = await client.query(`SELECT id FROM users WHERE username = ANY($1::text[])`, [Object.values(USERS)]);
    const uids = uRes.rows.map((r: any) => Number(r.id));
    if (uids.length) {
      await client.query(`DELETE FROM login_sessions WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_company_access WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_gstin_access WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_roles WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [uids]);
    }
    await client.query(`DELETE FROM gstins WHERE gstin_number IN ($1, $2)`, [GSTIN_A, GSTIN_B]);
    await client.query(`DELETE FROM companies WHERE name IN ($1, $2)`, [CO_A_NAME, CO_B_NAME]);
  } finally {
    client.release();
  }
}

async function main() {
  const idRes = await pool.query('SELECT current_database() AS db');
  assertConnectedDatabase(idRes.rows[0].db, 'tests/rem1-tenant-rbac-http-db.ts');
  console.log(`\nREM-1 HTTP RBAC & Multi-Tenant Isolation Tests (${idRes.rows[0].db})\n`);

  await cleanupFixtures();

  let serverProc: ChildProcess | null = null;
  let lineAId = 0;
  let lineARevId = 0;
  let lineBId = 0;
  let lineBRevId = 0;

  try {
    // 1. Seed isolated companies, GSTINs, users, roles, company access & purchase_lines
    const coA = await pool.query(
      `INSERT INTO companies (name, legal_name, short_name, status) VALUES ($1, $1, 'REM1A', 1) RETURNING id`,
      [CO_A_NAME],
    );
    const coB = await pool.query(
      `INSERT INTO companies (name, legal_name, short_name, status) VALUES ($1, $1, 'REM1B', 1) RETURNING id`,
      [CO_B_NAME],
    );
    const coAId = Number(coA.rows[0].id);
    const coBId = Number(coB.rows[0].id);

    await pool.query(
      `INSERT INTO gstins (company_id, gstin_number, legal_name, state_code, status)
       VALUES ($1, $2, $3, '26', 1), ($4, $5, $6, '27', 1)`,
      [coAId, GSTIN_A, CO_A_NAME, coBId, GSTIN_B, CO_B_NAME],
    );

    const rolesRes = await pool.query(`SELECT id, name FROM roles`);
    const roleId = (name: string) => {
      const hit = rolesRes.rows.find((r: any) => String(r.name).toUpperCase() === name.toUpperCase());
      assert.ok(hit, `Role "${name}" not found in gst_erp_test`);
      return Number(hit.id);
    };

    const pwHash = hashPassword(PASS);
    const createUser = async (username: string, roleName: string, restrictCoId: number | null) => {
      const u = await pool.query(
        `INSERT INTO users (email, username, password_hash, display_name, status, must_change_password)
         VALUES ($1, $2, $3, $2, 'active', false) RETURNING id`,
        [`${username}@rem1.test`, username, pwHash],
      );
      const uid = Number(u.rows[0].id);
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [uid, roleId(roleName)]);
      if (restrictCoId !== null) {
        await pool.query(`INSERT INTO user_company_access (user_id, company_id) VALUES ($1, $2)`, [uid, restrictCoId]);
      }
      return uid;
    };

    await createUser(USERS.superAll, 'SUPER ADMIN', null);
    await createUser(USERS.superScopedA, 'SUPER ADMIN', coAId);
    await createUser(USERS.acctA, 'Accounts User', coAId);
    await createUser(USERS.revA, 'ACCOUNTS REVIEWER', coAId);

    const insLine = async (
      ourGstin: string,
      invNo: string,
      itcDecision: string | null,
      revType: string | null,
    ) => {
      const r = await pool.query(
        `INSERT INTO purchase_lines (
           line_key, our_gstin, period, financial_year, party_name,
           book_supplier_gstin, book_invoice_no, book_invoice_date,
           recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
           book_taxable_value, book_igst, book_cgst, book_sgst, book_utgst, book_cess,
           match_status, matched_2b_key, matched_2b_month, reconciliation_month,
           twob_taxable_value, twob_igst, twob_cgst, twob_sgst, twob_utgst, twob_cess, twob_itc,
           itc_decision, itc_decision_month, itc_reversal_type, source_file
         ) VALUES (
           $1, $2, $3, '2026-27', 'REM1 Vendor',
           '27AAACV1234F1Z5', $4, '2026-04-10',
           '27AAACV1234F1Z5', $4, '2026-04-10',
           10000, 1800, 0, 0, 0, 0,
           'Matched', $5, $3, $3,
           10000, 1800, 0, 0, 0, 0, 1800,
           $6, $3, $7, 'rem1_fixture.xlsx'
         ) RETURNING id`,
        [`REM1:${ourGstin}:${invNo}`, ourGstin, PERIOD, invNo, `2B:${ourGstin}:${invNo}`, itcDecision, revType],
      );
      return Number(r.rows[0].id);
    };

    lineAId = await insLine(GSTIN_A, 'REM1-INV-A1', 'Pending Review', null);
    lineARevId = await insLine(GSTIN_A, 'REM1-INV-A2-REV', 'Reversed', 'OTHER_TEMPORARY');
    lineBId = await insLine(GSTIN_B, 'REM1-INV-B1', 'Pending Review', null);
    lineBRevId = await insLine(GSTIN_B, 'REM1-INV-B2-REV', 'Reversed', 'OTHER_TEMPORARY');

    // 2. Start ephemeral HTTP server on random 127.0.0.1 port (NEVER port 4310)
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

    let srvErr = '';
    serverProc.stderr?.on('data', (d) => { srvErr += d.toString(); });
    await waitForHealth(baseUrl);

    const cookieSuperAll = await loginAs(baseUrl, USERS.superAll);
    const cookieSuperScopedA = await loginAs(baseUrl, USERS.superScopedA);
    const cookieAcctA = await loginAs(baseUrl, USERS.acctA);
    const cookieRevA = await loginAs(baseUrl, USERS.revA);

    const api = (urlPath: string, opts: { method?: string; cookie?: string; body?: any; raw?: Buffer } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.cookie) headers['cookie'] = opts.cookie;
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.raw !== undefined) headers['content-type'] = 'application/octet-stream';
      return fetch(`${baseUrl}${urlPath}`, {
        method: opts.method || 'GET',
        headers,
        body: opts.raw !== undefined ? new Uint8Array(opts.raw) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    };

    // --- TESTS ---

    await test('REM1-01', 'Unauthenticated requests return HTTP 401 across Phase 3, 5 & 6 routes', async () => {
      for (const ep of [
        '/api/reports/historical-recon',
        '/api/reports/historical-recon/export.xlsx',
        '/api/reports/historical-recon/export.pdf',
        `/api/gstr3b/table4?gstin=${GSTIN_A}&period=${PERIOD}`,
        '/api/reports/monthly-book-summary',
        '/api/reports/pan-consolidation',
        '/api/sap-controls/comparison',
        '/api/sap-controls/history',
      ]) {
        const r = await api(ep);
        assert.equal(r.status, 401, `Expected 401 for unauthenticated ${ep}, got ${r.status}`);
      }
    });

    await test('REM1-02', 'CRIT-01: SUPER ADMIN succeeds (200) on POST /api/sap-controls/manual & /excel (recon.edit)', async () => {
      const rMan = await api('/api/sap-controls/manual', {
        method: 'POST',
        cookie: cookieSuperAll,
        body: {
          ourGstin: GSTIN_B,
          period: PERIOD,
          invoiceCount: 2,
          taxableValue: 20000,
          igst: 3600,
          cgst: 0,
          sgst: 0,
          utgst: 0,
          cess: 0,
          invoiceValue: 23600,
          remarks: 'rem1 super manual',
        },
      });
      assert.equal(rMan.status, 200, `SUPER ADMIN manual SAP expected 200, got ${rMan.status}: ${await rMan.text()}`);

      const xlsBuf = buildSapExcel([{
        'Our GSTIN': GSTIN_B,
        Period: '2026-05',
        'Invoice Count': 1,
        'Taxable Value': 10000,
        IGST: 1800,
        CGST: 0,
        SGST: 0,
        UTGST: 0,
        Cess: 0,
        'Invoice Value': 11800,
      }]);
      const rXls = await api('/api/sap-controls/excel?name=rem1_super.xlsx', {
        method: 'POST',
        cookie: cookieSuperAll,
        raw: xlsBuf,
      });
      assert.equal(rXls.status, 200, `SUPER ADMIN excel SAP expected 200, got ${rXls.status}: ${await rXls.text()}`);
    });

    await test('REM1-03', 'CRIT-01: Accounts User (Co A) succeeds (200) on SAP Control manual & excel for Co A', async () => {
      const rMan = await api('/api/sap-controls/manual', {
        method: 'POST',
        cookie: cookieAcctA,
        body: {
          ourGstin: GSTIN_A,
          period: PERIOD,
          invoiceCount: 2,
          taxableValue: 20000,
          igst: 3600,
          cgst: 0,
          sgst: 0,
          utgst: 0,
          cess: 0,
          invoiceValue: 23600,
          remarks: 'rem1 acctA manual',
        },
      });
      assert.equal(rMan.status, 200, `Accounts User manual SAP expected 200, got ${rMan.status}: ${await rMan.text()}`);

      const xlsBuf = buildSapExcel([{
        'Our GSTIN': GSTIN_A,
        Period: '2026-05',
        'Invoice Count': 1,
        'Taxable Value': 5000,
        IGST: 900,
        CGST: 0,
        SGST: 0,
        UTGST: 0,
        Cess: 0,
        'Invoice Value': 5900,
      }]);
      const rXls = await api('/api/sap-controls/excel?name=rem1_acctA.xlsx', {
        method: 'POST',
        cookie: cookieAcctA,
        raw: xlsBuf,
      });
      assert.equal(rXls.status, 200, `Accounts User excel SAP expected 200, got ${rXls.status}: ${await rXls.text()}`);
    });

    await test('REM1-04', 'CRIT-02: Accounts User (Co A) denied (403) on SAP Control manual & excel for Co B GSTIN', async () => {
      const rMan = await api('/api/sap-controls/manual', {
        method: 'POST',
        cookie: cookieAcctA,
        body: {
          ourGstin: GSTIN_B,
          period: '2026-06',
          invoiceCount: 1,
          taxableValue: 1000,
          igst: 180,
          invoiceValue: 1180,
        },
      });
      assert.equal(rMan.status, 403, `Expected 403 for cross-company SAP manual, got ${rMan.status}`);

      const xlsBuf = buildSapExcel([
        { 'Our GSTIN': GSTIN_A, Period: '2026-06', 'Invoice Count': 1, 'Taxable Value': 1000, IGST: 180, 'Invoice Value': 1180 },
        { 'Our GSTIN': GSTIN_B, Period: '2026-06', 'Invoice Count': 1, 'Taxable Value': 1000, IGST: 180, 'Invoice Value': 1180 },
      ]);
      const rXls = await api('/api/sap-controls/excel?name=rem1_mixed.xlsx', {
        method: 'POST',
        cookie: cookieAcctA,
        raw: xlsBuf,
      });
      assert.equal(rXls.status, 403, `Expected 403 for mixed-company SAP excel, got ${rXls.status}`);
    });

    await test('REM1-05', 'RBAC: ACCOUNTS REVIEWER denied (403) on SAP write, ITC control & ITC reclaim endpoints', async () => {
      const r1 = await api('/api/sap-controls/manual', {
        method: 'POST',
        cookie: cookieRevA,
        body: { ourGstin: GSTIN_A, period: '2026-07', invoiceCount: 1, taxableValue: 1000, igst: 180, invoiceValue: 1180 },
      });
      assert.equal(r1.status, 403, `Reviewer SAP manual expected 403, got ${r1.status}`);

      const r2 = await api(`/api/lines/${lineAId}/itc-control`, {
        method: 'POST',
        cookie: cookieRevA,
        body: { decision: 'Claim', reason: 'reviewer should fail' },
      });
      assert.equal(r2.status, 403, `Reviewer ITC control expected 403, got ${r2.status}`);

      const r3 = await api(`/api/lines/${lineARevId}/itc-reclaim`, {
        method: 'POST',
        cookie: cookieRevA,
        body: { reclaimMonth: RECLAIM_PERIOD, reason: 'reviewer should fail' },
      });
      assert.equal(r3.status, 403, `Reviewer ITC reclaim expected 403, got ${r3.status}`);
    });

    await test('REM1-06', 'CRIT-02: Omitted gstin filter scopes strictly to Co A (zero Co B leakage across all reports)', async () => {
      const rHist = await api(`/api/reports/historical-recon?period=${PERIOD}`, { cookie: cookieAcctA });
      assert.equal(rHist.status, 200);
      const hist: any = await rHist.json();
      assert.ok(hist.booksRegister.length > 0, 'Expected Co A books rows');
      assert.ok(hist.booksRegister.every((r: any) => r.ourGstin === GSTIN_A), `Leaked non-CoA GSTIN in historical-recon!`);

      const rMbs = await api(`/api/reports/monthly-book-summary?fy=2026-27`, { cookie: cookieAcctA });
      assert.equal(rMbs.status, 200);
      const mbs: any = await rMbs.json();
      assert.equal(mbs.annualTotal.invoiceCount, 2, `Expected only Co A's 2 invoices in monthly-book-summary, got ${mbs.annualTotal.invoiceCount}`);

      const rPan = await api(`/api/reports/pan-consolidation?period=${PERIOD}`, { cookie: cookieAcctA });
      assert.equal(rPan.status, 200);
      const pan: any = await rPan.json();
      assert.equal(pan.grandTotal.invoiceCount, 2, `Expected only Co A's 2 invoices in pan-consolidation, got ${pan.grandTotal.invoiceCount}`);

      const rCmp = await api(`/api/sap-controls/comparison?fy=2026-27`, { cookie: cookieAcctA });
      assert.equal(rCmp.status, 200);
      const cmp: any = await rCmp.json();
      assert.ok(cmp.rows.length > 0 && cmp.rows.every((r: any) => r.ourGstin === GSTIN_A), 'Leaked non-CoA GSTIN in sap comparison!');

      const rHis = await api(`/api/sap-controls/history?fy=2026-27`, { cookie: cookieAcctA });
      assert.equal(rHis.status, 200);
      const his: any = await rHis.json();
      assert.ok(his.rows.length > 0 && his.rows.every((r: any) => r.our_gstin === GSTIN_A), 'Leaked non-CoA GSTIN in sap history!');
    });

    await test('REM1-07', 'CRIT-02: Unauthorized singular ?gstin=<CoB> returns 403 on all Phase 3, 5 & 6 GET/export routes', async () => {
      for (const ep of [
        `/api/reports/historical-recon?gstin=${GSTIN_B}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.xlsx?gstin=${GSTIN_B}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.pdf?gstin=${GSTIN_B}&period=${PERIOD}`,
        `/api/gstr3b/table4?gstin=${GSTIN_B}&period=${PERIOD}`,
        `/api/reports/monthly-book-summary?gstin=${GSTIN_B}&fy=2026-27`,
        `/api/reports/pan-consolidation?gstin=${GSTIN_B}&period=${PERIOD}`,
        `/api/sap-controls/comparison?gstin=${GSTIN_B}&fy=2026-27`,
        `/api/sap-controls/history?gstin=${GSTIN_B}&fy=2026-27`,
      ]) {
        const r = await api(ep, { cookie: cookieAcctA });
        assert.equal(r.status, 403, `Expected 403 for ${ep}, got ${r.status}`);
      }
    });

    await test('REM1-08', 'CRIT-02: Plural ?gstins=<CoA>,<CoB> manipulation returns 403 on historical-recon & exports', async () => {
      for (const ep of [
        `/api/reports/historical-recon?gstins=${GSTIN_A},${GSTIN_B}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.xlsx?gstins=${GSTIN_A},${GSTIN_B}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.pdf?gstins=${GSTIN_A},${GSTIN_B}&period=${PERIOD}`,
      ]) {
        const r = await api(ep, { cookie: cookieAcctA });
        assert.equal(r.status, 403, `Expected 403 for plural manipulation ${ep}, got ${r.status}`);
      }
    });

    await test('REM1-09', 'CRIT-02: Unauthorized ?company=<CoB> and unknown company return 403 for scoped user', async () => {
      for (const ep of [
        `/api/reports/historical-recon?company=${CO_B_NAME}&period=${PERIOD}`,
        `/api/reports/historical-recon?company=REM1B&period=${PERIOD}`,
        `/api/reports/monthly-book-summary?company=${CO_B_NAME}&fy=2026-27`,
        `/api/reports/pan-consolidation?company=REM1B&period=${PERIOD}`,
        `/api/sap-controls/comparison?company=${CO_B_NAME}&fy=2026-27`,
        `/api/reports/historical-recon?company=UNKNOWN_CORP_XYZ&period=${PERIOD}`,
      ]) {
        const r = await api(ep, { cookie: cookieAcctA });
        assert.equal(r.status, 403, `Expected 403 for company manipulation ${ep}, got ${r.status}`);
      }
    });

    await test('REM1-10', 'CRIT-02 IDOR: Accounts User (Co A) denied (403) on Co B line /itc-control & /itc-reclaim', async () => {
      const rCtrl = await api(`/api/lines/${lineBId}/itc-control`, {
        method: 'POST',
        cookie: cookieAcctA,
        body: { decision: 'Ineligible', reversalType: 'SEC_17_5_BLOCKED', reason: 'idor attempt' },
      });
      assert.equal(rCtrl.status, 403, `Expected 403 for IDOR itc-control, got ${rCtrl.status}`);

      const rRec = await api(`/api/lines/${lineBRevId}/itc-reclaim`, {
        method: 'POST',
        cookie: cookieAcctA,
        body: { reclaimMonth: RECLAIM_PERIOD, reason: 'idor reclaim attempt' },
      });
      assert.equal(rRec.status, 403, `Expected 403 for IDOR itc-reclaim, got ${rRec.status}`);

      // Verify Co B DB rows were completely untouched
      const chk = await pool.query(`SELECT id, itc_decision, itc_reclaimed FROM purchase_lines WHERE id IN ($1, $2) ORDER BY id`, [lineBId, lineBRevId]);
      assert.equal(chk.rows[0].itc_decision, 'Pending Review', 'Co B lineBId must remain untouched');
      assert.equal(chk.rows[1].itc_reclaimed, false, 'Co B lineBRevId must remain untouched');
    });

    await test('REM1-11', 'Authorized line ownership: Accounts User (Co A) succeeds (200) on Co A /itc-control & /itc-reclaim', async () => {
      const rCtrl = await api(`/api/lines/${lineAId}/itc-control`, {
        method: 'POST',
        cookie: cookieAcctA,
        body: { decision: 'Claim', claimMonth: PERIOD, reason: 'authorized Co A claim' },
      });
      assert.equal(rCtrl.status, 200, `Expected 200 for authorized Co A itc-control, got ${rCtrl.status}: ${await rCtrl.text()}`);

      const rRec = await api(`/api/lines/${lineARevId}/itc-reclaim`, {
        method: 'POST',
        cookie: cookieAcctA,
        body: { reclaimMonth: RECLAIM_PERIOD, reason: 'authorized Co A reclaim' },
      });
      assert.equal(rRec.status, 200, `Expected 200 for authorized Co A itc-reclaim, got ${rRec.status}: ${await rRec.text()}`);
    });

    await test('REM1-12', 'Scoped SUPER ADMIN (Co A grant) respects authorized scope: 403 on Co B, 200 on Co A', async () => {
      const rDeniedGstin = await api(`/api/reports/historical-recon?gstin=${GSTIN_B}&period=${PERIOD}`, { cookie: cookieSuperScopedA });
      assert.equal(rDeniedGstin.status, 403, `Scoped SUPER ADMIN must get 403 on Co B gstin, got ${rDeniedGstin.status}`);

      const rDeniedPlural = await api(`/api/reports/historical-recon?gstins=${GSTIN_A},${GSTIN_B}&period=${PERIOD}`, { cookie: cookieSuperScopedA });
      assert.equal(rDeniedPlural.status, 403, `Scoped SUPER ADMIN must get 403 on Co B plural gstins, got ${rDeniedPlural.status}`);

      const rDeniedCo = await api(`/api/reports/monthly-book-summary?company=${CO_B_NAME}&fy=2026-27`, { cookie: cookieSuperScopedA });
      assert.equal(rDeniedCo.status, 403, `Scoped SUPER ADMIN must get 403 on Co B company, got ${rDeniedCo.status}`);

      const rDeniedIdor = await api(`/api/lines/${lineBId}/itc-control`, {
        method: 'POST',
        cookie: cookieSuperScopedA,
        body: { decision: 'Claim', reason: 'scoped super idor' },
      });
      assert.equal(rDeniedIdor.status, 403, `Scoped SUPER ADMIN must get 403 on Co B line IDOR, got ${rDeniedIdor.status}`);

      const rDeniedSap = await api('/api/sap-controls/manual', {
        method: 'POST',
        cookie: cookieSuperScopedA,
        body: { ourGstin: GSTIN_B, period: '2026-08', invoiceCount: 1, taxableValue: 1000, igst: 180, invoiceValue: 1180 },
      });
      assert.equal(rDeniedSap.status, 403, `Scoped SUPER ADMIN must get 403 on Co B SAP write, got ${rDeniedSap.status}`);

      const rOkA = await api(`/api/reports/historical-recon?gstin=${GSTIN_A}&period=${PERIOD}`, { cookie: cookieSuperScopedA });
      assert.equal(rOkA.status, 200, `Scoped SUPER ADMIN must get 200 on Co A, got ${rOkA.status}`);
    });

    await test('REM1-13', 'LOW-01: Authorized ACCOUNTS REVIEWER succeeds (200) on Co A GET reports & exports', async () => {
      for (const ep of [
        `/api/reports/historical-recon?gstin=${GSTIN_A}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.xlsx?gstin=${GSTIN_A}&period=${PERIOD}`,
        `/api/reports/historical-recon/export.pdf?gstin=${GSTIN_A}&period=${PERIOD}`,
        `/api/gstr3b/table4?gstin=${GSTIN_A}&period=${PERIOD}`,
        `/api/reports/monthly-book-summary?gstin=${GSTIN_A}&fy=2026-27`,
        `/api/reports/pan-consolidation?gstin=${GSTIN_A}&period=${PERIOD}`,
        `/api/sap-controls/comparison?gstin=${GSTIN_A}&fy=2026-27`,
        `/api/sap-controls/history?gstin=${GSTIN_A}&fy=2026-27`,
        `/api/sap-controls/template.xlsx`,
      ]) {
        const r = await api(ep, { cookie: cookieRevA });
        assert.equal(r.status, 200, `Reviewer expected 200 for authorized ${ep}, got ${r.status}`);
      }
    });

    await test('REM1-14', 'Authorized plural ?gstins=<CoA> succeeds (200) for Accounts User (Co A)', async () => {
      const r = await api(`/api/reports/historical-recon?gstins=${GSTIN_A}&period=${PERIOD}`, { cookie: cookieAcctA });
      assert.equal(r.status, 200, `Expected 200 for authorized plural gstins, got ${r.status}`);
      const body: any = await r.json();
      assert.ok(body.booksRegister.every((row: any) => row.ourGstin === GSTIN_A));
    });

    if (srvErr.trim() && failed > 0) {
      console.error('\nServer stderr:\n', srvErr.slice(0, 1500));
    }
  } finally {
    if (serverProc) {
      serverProc.kill();
    }
    await cleanupFixtures();
    await pool.end();
  }

  console.log('\n' + '='.repeat(66));
  console.log(`REM-1 HTTP RBAC & Tenant Isolation: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(66));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
