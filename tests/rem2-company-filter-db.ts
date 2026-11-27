/**
 * REM-2 Integration Tests — SQL Company Filter Column Fixes (`HIGH-01`) on `gst_erp_test` ONLY.
 *
 * Verifies:
 *  - Valid company filters (`short_name`, `name`, `id`) across Monthly Book Summary,
 *    PAN Consolidation, Historical Reconciliation Report (JSON, Excel, PDF)
 *  - Multi-GSTIN company aggregation (2 GSTINs under Company A, 0 leakage from Company B)
 *  - Invalid/unknown company filters (0 rows, zero PostgreSQL 42703 errors, 403 for scoped users)
 *  - Authorized company + single GSTIN narrowing & unauthorized company/GSTIN combinations (403)
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget } from '../src/config/test-db';
import { hashPassword } from '../src/app/auth';
import { getMonthlyBookSummary, getPanSupplierConsolidation } from '../src/app/phase3-reports';
import { buildHistoricalReconReport } from '../src/app/historical-recon-report';

loadEnv();
assertTestDbTarget('tests/rem2-company-filter-db.ts');

const pool = new pg.Pool(pgConfig());

const CO_A_NAME = 'REM2_MULTI_GSTIN_CO_A';
const CO_A_SHORT = 'REM2A';
const CO_B_NAME = 'REM2_OTHER_CO_B';
const CO_B_SHORT = 'REM2B';
const GSTIN_A1 = '26AAACR3111A1Z5';
const GSTIN_A2 = '27AAACR3112A1Z5';
const GSTIN_B1 = '29AAACR3222B1Z5';
const PERIOD = '2026-04';
const PASS = 'Rem2Audit#2026';

const USERS = {
  superAll: 'rem2_super_all',
  acctA: 'rem2_acct_a',
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

async function loginAs(baseUrl: string, username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  });
  assert.equal(res.status, 200, `Login failed for ${username}`);
  const m = /gst_session=([0-9a-f]{64})/.exec(res.headers.get('set-cookie') || '');
  assert.ok(m, `Missing session cookie for ${username}`);
  return `gst_session=${m[1]}`;
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM purchase_lines WHERE our_gstin IN ($1, $2, $3)`, [GSTIN_A1, GSTIN_A2, GSTIN_B1]);
    await client.query(`DELETE FROM gstr2b_lines WHERE our_gstin IN ($1, $2, $3)`, [GSTIN_A1, GSTIN_A2, GSTIN_B1]);
    await client.query(`DELETE FROM audit_trail WHERE our_gstin IN ($1, $2, $3) OR changed_by LIKE 'rem2_%'`, [GSTIN_A1, GSTIN_A2, GSTIN_B1]);
    const uRes = await client.query(`SELECT id FROM users WHERE username = ANY($1::text[])`, [Object.values(USERS)]);
    const uids = uRes.rows.map((r: any) => Number(r.id));
    if (uids.length) {
      await client.query(`DELETE FROM login_sessions WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_company_access WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_gstin_access WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM user_roles WHERE user_id = ANY($1::int[])`, [uids]);
      await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [uids]);
    }
    await client.query(`DELETE FROM gstins WHERE gstin_number IN ($1, $2, $3)`, [GSTIN_A1, GSTIN_A2, GSTIN_B1]);
    await client.query(`DELETE FROM companies WHERE name IN ($1, $2)`, [CO_A_NAME, CO_B_NAME]);
  } finally {
    client.release();
  }
}

async function main() {
  const idRes = await pool.query('SELECT current_database() AS db');
  assertConnectedDatabase(idRes.rows[0].db, 'tests/rem2-company-filter-db.ts');
  console.log(`\nREM-2 Company Filter SQL & Multi-GSTIN Integration Tests (${idRes.rows[0].db})\n`);

  await cleanupFixtures();
  let serverProc: ChildProcess | null = null;

  try {
    const coA = await pool.query(
      `INSERT INTO companies (name, legal_name, short_name, status) VALUES ($1, $1, $2, 1) RETURNING id`,
      [CO_A_NAME, CO_A_SHORT],
    );
    const coB = await pool.query(
      `INSERT INTO companies (name, legal_name, short_name, status) VALUES ($1, $1, $2, 1) RETURNING id`,
      [CO_B_NAME, CO_B_SHORT],
    );
    const coAId = Number(coA.rows[0].id);
    const coBId = Number(coB.rows[0].id);

    await pool.query(
      `INSERT INTO gstins (company_id, gstin_number, legal_name, state_code, status)
       VALUES ($1, $2, $3, '26', 1), ($1, $4, $3, '27', 1), ($5, $6, $7, '29', 1)`,
      [coAId, GSTIN_A1, CO_A_NAME, GSTIN_A2, coBId, GSTIN_B1, CO_B_NAME],
    );

    const rolesRes = await pool.query(`SELECT id, name FROM roles`);
    const roleId = (name: string) => {
      const hit = rolesRes.rows.find((r: any) => String(r.name).toUpperCase() === name.toUpperCase());
      assert.ok(hit, `Role "${name}" not found`);
      return Number(hit.id);
    };

    const pwHash = hashPassword(PASS);
    const createUser = async (username: string, roleName: string, restrictCoId: number | null) => {
      const u = await pool.query(
        `INSERT INTO users (email, username, password_hash, display_name, status, must_change_password)
         VALUES ($1, $2, $3, $2, 'active', false) RETURNING id`,
        [`${username}@rem2.test`, username, pwHash],
      );
      const uid = Number(u.rows[0].id);
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [uid, roleId(roleName)]);
      if (restrictCoId !== null) {
        await pool.query(`INSERT INTO user_company_access (user_id, company_id) VALUES ($1, $2)`, [uid, restrictCoId]);
      }
      return uid;
    };

    await createUser(USERS.superAll, 'SUPER ADMIN', null);
    await createUser(USERS.acctA, 'Accounts User', coAId);

    const insLine = async (ourGstin: string, invNo: string, taxable: number, igst: number) => {
      await pool.query(
        `INSERT INTO purchase_lines (
           line_key, our_gstin, period, financial_year, party_name,
           book_supplier_gstin, book_invoice_no, book_invoice_date,
           recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
           book_taxable_value, book_igst, book_cgst, book_sgst, book_utgst, book_cess,
           match_status, matched_2b_key, matched_2b_month, reconciliation_month,
           twob_taxable_value, twob_igst, twob_cgst, twob_sgst, twob_utgst, twob_cess, twob_itc,
           itc_decision, source_file
         ) VALUES (
           $1, $2, $3, '2026-27', 'REM2 Supplier',
           '27AAACV5555F1Z5', $4, '2026-04-12',
           '27AAACV5555F1Z5', $4, '2026-04-12',
           $5, $6, 0, 0, 0, 0,
           'Matched', $7, $3, $3,
           $5, $6, 0, 0, 0, 0, $6,
           'Pending Review', 'rem2_fixture.xlsx'
         )`,
        [`REM2:${ourGstin}:${invNo}`, ourGstin, PERIOD, invNo, taxable, igst, `2B:${ourGstin}:${invNo}`],
      );
      await pool.query(
        `INSERT INTO gstr2b_lines (
           line_key, our_gstin, twob_month, portal_fp, supplier_gstin, supplier_name,
           invoice_no, invoice_date, document_type, taxable_value, igst, cgst, sgst, utgst, cess,
           itc_availability, source_file
         ) VALUES (
           $1, $2, $3, $3, '27AAACV5555F1Z5', 'REM2 Supplier',
           $4, '2026-04-12', 'Tax Invoice', $5, $6, 0, 0, 0, 0,
           'Yes', 'rem2_2b.json'
         )`,
        [`2B:${ourGstin}:${invNo}`, ourGstin, PERIOD, invNo, taxable, igst],
      );
    };

    // Company A has 2 GSTINs: 10,000 + 25,000 = 35,000 taxable (6,300 IGST)
    await insLine(GSTIN_A1, 'REM2-A1-001', 10000, 1800);
    await insLine(GSTIN_A2, 'REM2-A2-001', 25000, 4500);
    // Company B has 1 GSTIN: 99,000 taxable (17,820 IGST) — must NEVER leak into Co A
    await insLine(GSTIN_B1, 'REM2-B1-001', 99000, 17820);

    // Start ephemeral server on random port (never port 4310)
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

    const cookieSuper = await loginAs(baseUrl, USERS.superAll);
    const cookieAcctA = await loginAs(baseUrl, USERS.acctA);

    const api = (urlPath: string, cookie: string) =>
      fetch(`${baseUrl}${urlPath}`, { headers: { cookie } });

    await test('REM2-01', 'Direct DB calls resolve multi-GSTIN company by short_name, name & id with zero 42703 errors', async () => {
      for (const coKey of [CO_A_SHORT, CO_A_NAME, String(coAId)]) {
        const mbs = await getMonthlyBookSummary({ fy: '2026-27', company: coKey });
        assert.equal(mbs.annualTotal.invoiceCount, 2, `MBS(${coKey}) expected 2 docs`);
        assert.equal(mbs.annualTotal.taxableValue, 35000, `MBS(${coKey}) expected 35000 taxable`);
        assert.equal(mbs.annualTotal.totalGst, 6300, `MBS(${coKey}) expected 6300 GST`);

        const pan = await getPanSupplierConsolidation({ period: PERIOD, company: coKey });
        assert.equal(pan.grandTotal.invoiceCount, 2, `PAN(${coKey}) expected 2 docs`);
        assert.equal(pan.grandTotal.taxableValue, 35000, `PAN(${coKey}) expected 35000 taxable`);

        const hist = await buildHistoricalReconReport({ period: PERIOD, company: coKey });
        assert.equal(hist.booksSummary.docs, 2, `Hist(${coKey}) expected 2 docs`);
        assert.equal(hist.booksSummary.taxableValue, 35000, `Hist(${coKey}) expected 35000 taxable`);
        assert.equal(hist.allParityOk, true, `Hist(${coKey}) parity must be true`);
        assert.ok(hist.booksRegister.every((r) => r.ourGstin === GSTIN_A1 || r.ourGstin === GSTIN_A2));
      }
    });

    await test('REM2-02', 'HTTP ?company= works across Monthly Book, PAN, Historical JSON, Excel (.xlsx) & PDF (.pdf)', async () => {
      for (const cookie of [cookieSuper, cookieAcctA]) {
        const rMbs = await api(`/api/reports/monthly-book-summary?fy=2026-27&company=${CO_A_SHORT}`, cookie);
        assert.equal(rMbs.status, 200);
        const mbs: any = await rMbs.json();
        assert.equal(mbs.annualTotal.taxableValue, 35000);

        const rPan = await api(`/api/reports/pan-consolidation?period=${PERIOD}&company=${CO_A_NAME}`, cookie);
        assert.equal(rPan.status, 200);
        const pan: any = await rPan.json();
        assert.equal(pan.grandTotal.taxableValue, 35000);

        const rHist = await api(`/api/reports/historical-recon?period=${PERIOD}&company=${CO_A_SHORT}`, cookie);
        assert.equal(rHist.status, 200);
        const hist: any = await rHist.json();
        assert.equal(hist.booksSummary.docs, 2);
        assert.equal(hist.booksSummary.taxableValue, 35000);
        assert.equal(hist.allParityOk, true);

        const rXls = await api(`/api/reports/historical-recon/export.xlsx?period=${PERIOD}&company=${CO_A_SHORT}`, cookie);
        assert.equal(rXls.status, 200);
        const xlsBuf = Buffer.from(await rXls.arrayBuffer());
        assert.equal(xlsBuf.slice(0, 2).toString('utf8'), 'PK', 'Excel export must be valid ZIP/XLSX');

        const rPdf = await api(`/api/reports/historical-recon/export.pdf?period=${PERIOD}&company=${CO_A_SHORT}`, cookie);
        assert.equal(rPdf.status, 200);
        const pdfBuf = Buffer.from(await rPdf.arrayBuffer());
        assert.equal(pdfBuf.slice(0, 5).toString('utf8'), '%PDF-', 'PDF export must be valid PDF');
      }
    });

    await test('REM2-03', 'Invalid/unknown company returns 0 rows (no 42703 & no data leak) for SUPER ADMIN, 403 for scoped user', async () => {
      const mbs = await getMonthlyBookSummary({ fy: '2026-27', company: 'NON_EXISTENT_CORP_999' });
      assert.equal(mbs.annualTotal.invoiceCount, 0);

      const hist = await buildHistoricalReconReport({ period: PERIOD, company: 'NON_EXISTENT_CORP_999' });
      assert.equal(hist.booksSummary.docs, 0);

      const rSuper = await api(`/api/reports/historical-recon?period=${PERIOD}&company=NON_EXISTENT_CORP_999`, cookieSuper);
      assert.equal(rSuper.status, 200);
      const body: any = await rSuper.json();
      assert.equal(body.booksSummary.docs, 0, 'Unknown company must return 0 rows, never all companies');

      const rScoped = await api(`/api/reports/historical-recon?period=${PERIOD}&company=NON_EXISTENT_CORP_999`, cookieAcctA);
      assert.equal(rScoped.status, 403, 'Scoped user must get 403 on unknown company');
    });

    await test('REM2-04', 'Unauthorized ?company=REM2B denied (403) across Monthly Book, PAN, Historical JSON, Excel & PDF', async () => {
      for (const ep of [
        `/api/reports/monthly-book-summary?fy=2026-27&company=${CO_B_SHORT}`,
        `/api/reports/pan-consolidation?period=${PERIOD}&company=${CO_B_NAME}`,
        `/api/reports/historical-recon?period=${PERIOD}&company=${CO_B_SHORT}`,
        `/api/reports/historical-recon/export.xlsx?period=${PERIOD}&company=${CO_B_SHORT}`,
        `/api/reports/historical-recon/export.pdf?period=${PERIOD}&company=${CO_B_SHORT}`,
      ]) {
        const r = await api(ep, cookieAcctA);
        assert.equal(r.status, 403, `Expected 403 for unauthorized company on ${ep}, got ${r.status}`);
      }
    });

    await test('REM2-05', 'Authorized ?company=REM2A + single GSTIN narrows cleanly; authorized company + unauthorized GSTIN returns 403', async () => {
      const rNarrow = await api(`/api/reports/historical-recon?period=${PERIOD}&company=${CO_A_SHORT}&gstin=${GSTIN_A1}`, cookieAcctA);
      assert.equal(rNarrow.status, 200);
      const narrow: any = await rNarrow.json();
      assert.equal(narrow.booksSummary.docs, 1);
      assert.equal(narrow.booksSummary.taxableValue, 10000);

      const rCross = await api(`/api/reports/historical-recon?period=${PERIOD}&company=${CO_A_SHORT}&gstin=${GSTIN_B1}`, cookieAcctA);
      assert.equal(rCross.status, 403, 'Authorized company + unauthorized GSTIN must return 403');

      const rCrossSuper = await api(`/api/reports/historical-recon?period=${PERIOD}&company=${CO_A_SHORT}&gstin=${GSTIN_B1}`, cookieSuper);
      assert.equal(rCrossSuper.status, 200);
      const crossBody: any = await rCrossSuper.json();
      assert.equal(crossBody.booksSummary.docs, 0, 'Mismatched company+gstin intersection must yield 0 rows');
    });
  } finally {
    if (serverProc) serverProc.kill();
    await cleanupFixtures();
    await pool.end();
  }

  console.log('\n' + '='.repeat(66));
  console.log(`REM-2 Company Filter Integration: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(66));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
