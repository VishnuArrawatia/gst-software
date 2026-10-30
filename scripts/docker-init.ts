/**
 * Production / Coolify container startup initializer:
 *  1. Waits up to 30s for PostgreSQL to accept connections (and auto-creates
 *     the target database `gst_erp` if it does not exist yet on a shared
 *     Coolify PostgreSQL server).
 *  2. Applies all SQL migrations in `migrations/*.sql` idempotently.
 *  3. Seeds Company / Unit / GSTIN / Financial Year masters and company logos.
 *  4. Restores the authoritative baseline snapshot (`templates/gst-erp-seed-snapshot.json.gz`)
 *     on a fresh database (`purchase_lines = 0`), bringing all 9,641 purchase
 *     lines, 10,952 GSTR-2B lines, 4,099 sales invoices, and 443 GSTR-1 docs online.
 *  5. Initialises default team accounts (MASTER, USER-1, USER-2, USER-3) ONLY
 *     when a user still carries the sentinel `LOGIN_NOT_ENABLED` hash — never
 *     overwrites a password changed by the team.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { hashPassword } from '../src/app/auth';

loadEnv();

async function ensureDatabaseAndWait(maxWaitMs = 30000): Promise<boolean> {
  const cfg = pgConfig();
  if (!cfg.password) {
    console.warn('[docker-init] PGPASSWORD / DATABASE_URL is not set yet — skipping DB init until configured in Coolify.');
    return false;
  }
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < maxWaitMs) {
    const client = new Client(cfg);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log(`[docker-init] PostgreSQL ready at ${cfg.host}:${cfg.port}/${cfg.database}`);
      return true;
    } catch (e: any) {
      await client.end().catch(() => {});
      lastErr = e.message || String(e);
      if (e.code === '3D000' || /does not exist/i.test(lastErr)) {
        const adminClient = new Client({ ...cfg, database: 'postgres' });
        try {
          await adminClient.connect();
          const safeDb = cfg.database.replace(/[^a-zA-Z0-9_]/g, '');
          await adminClient.query(`CREATE DATABASE "${safeDb}"`);
          console.log(`[docker-init] Created database "${safeDb}" on ${cfg.host}:${cfg.port}`);
          await adminClient.end();
          continue;
        } catch (ce: any) {
          await adminClient.end().catch(() => {});
          lastErr = ce.message || String(ce);
        }
      }
      console.log(`[docker-init] Waiting for PostgreSQL (${cfg.host}:${cfg.port})... ${lastErr}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.warn(`[docker-init] PostgreSQL not reachable within ${maxWaitMs}ms (${lastErr}) — starting web server anyway.`);
  return false;
}

function runScript(scriptName: string): void {
  console.log(`[docker-init] Running npm run ${scriptName}...`);
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', scriptName], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`npm run ${scriptName} exited with code ${res.status}`);
  }
}

async function restoreBaselineSnapshotIfEmpty(): Promise<void> {
  const snapFile = path.join(process.cwd(), 'templates', 'gst-erp-seed-snapshot.json.gz');
  if (!fs.existsSync(snapFile)) return;

  const c = new Client(pgConfig());
  await c.connect();
  try {
    const chk = await c.query('SELECT count(*) AS n FROM purchase_lines');
    const existingCount = Number(chk.rows[0]?.n || 0);
    if (existingCount > 0) {
      console.log(`[docker-init] Database already has ${existingCount} purchase_lines — skipping baseline snapshot restore.`);
      return;
    }

    console.log(`[docker-init] Fresh database detected — restoring baseline snapshot from ${snapFile}...`);
    const rawJson = zlib.gunzipSync(fs.readFileSync(snapFile)).toString('utf8');
    const parsed = JSON.parse(rawJson);
    const tables: Record<string, any[]> = parsed.tables || {};

    const RESTORE_ORDER = [
      'companies',
      'units',
      'gstins',
      'financial_years',
      'periods',
      'users',
      'user_roles',
      'user_company_access',
      'gstr2b_files',
      'gstr2b_lines',
      'purchase_lines',
      'recon_corrections',
      'sales_invoices',
      'sales_invoice_items',
      'gstr1_documents',
      'pl_heads',
      'pl_gst_mapping',
    ];

    for (const table of RESTORE_ORDER) {
      const rows = tables[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const cols = Object.keys(rows[0]);
      const colList = cols.map((col) => `"${col}"`).join(', ');
      const batchSize = Math.max(1, Math.floor(40000 / cols.length));

      await c.query('BEGIN');
      try {
        for (let i = 0; i < rows.length; i += batchSize) {
          const chunk = rows.slice(i, i + batchSize);
          const params: unknown[] = [];
          const valueGroups: string[] = [];
          chunk.forEach((row, rIdx) => {
            const ph: string[] = [];
            cols.forEach((col, cIdx) => {
              params.push(row[col]);
              ph.push(`$${rIdx * cols.length + cIdx + 1}`);
            });
            valueGroups.push(`(${ph.join(',')})`);
          });

          await c.query(
            `INSERT INTO "${table}" (${colList}) VALUES ${valueGroups.join(',')} ON CONFLICT DO NOTHING`,
            params,
          );
        }

        if (cols.includes('id')) {
          await c.query(
            `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), true)`,
            [table],
          ).catch(() => {});
        }
        await c.query('COMMIT');
        console.log(`[docker-init]   restored ${table.padEnd(22)} : ${rows.length} rows`);
      } catch (e: any) {
        await c.query('ROLLBACK');
        console.warn(`[docker-init]   warning restoring ${table}: ${e.message}`);
      }
    }
  } finally {
    await c.end();
  }
}

async function ensureTeamAccounts(): Promise<void> {
  const defaults = [
    {
      username: 'MASTER',
      from: 'master',
      display: 'Vishnu',
      email: 'MASTER@sakar.local',
      password: process.env.MASTER_PASSWORD || 'sakar@123',
      role: 'SUPER ADMIN',
    },
    {
      username: 'USER-1',
      from: 'user-1',
      display: 'User-1',
      email: 'USER-1@sakar.local',
      password: process.env.USER1_PASSWORD || 'user1@123',
      role: 'ACCOUNTS USER',
    },
    {
      username: 'USER-2',
      from: 'user-2',
      display: 'User-2',
      email: 'USER-2@sakar.local',
      password: process.env.USER2_PASSWORD || 'user2@123',
      role: 'ACCOUNTS USER',
    },
    {
      username: 'USER-3',
      from: 'user-3',
      display: 'User-3',
      email: 'USER-3@sakar.local',
      password: process.env.USER3_PASSWORD || 'user3@123',
      role: 'ACCOUNTS USER',
    },
  ];

  const c = new Client(pgConfig());
  await c.connect();
  try {
    for (const t of defaults) {
      const oldPlain = t.from.replace(/-/g, '');
      const found = await c.query(
        `SELECT id, password_hash FROM users
          WHERE LOWER(username) IN (LOWER($1), LOWER($2))
             OR LOWER(email) IN (LOWER($3), LOWER($4), LOWER($5))
          ORDER BY id LIMIT 1`,
        [t.username, t.from, `${t.from}@sakar.local`, `${oldPlain}@sakar.local`, t.email],
      );

      const row = found.rows[0];
      if (row) {
        if (!row.password_hash || row.password_hash === 'LOGIN_NOT_ENABLED') {
          await c.query(
            `UPDATE users
                SET username = $1,
                    email = $2,
                    display_name = $3,
                    password_hash = $4,
                    status = 'active',
                    must_change_password = false,
                    updated_at = now()
              WHERE id = $5`,
            [t.username, t.email, t.display, hashPassword(t.password), row.id],
          );
          console.log(`[docker-init] Activated account ${t.username} (${t.role})`);
        } else {
          console.log(`[docker-init] Account ${t.username} already configured — keeping password.`);
        }
      } else {
        const ins = await c.query(
          `INSERT INTO users (username, email, display_name, password_hash, status, must_change_password)
           VALUES ($1, $2, $3, $4, 'active', false) RETURNING id`,
          [t.username, t.email, t.display, hashPassword(t.password)],
        );
        const uid = ins.rows[0]?.id;
        if (uid) {
          await c.query(
            `INSERT INTO user_roles (user_id, role_id)
             SELECT $1, id FROM roles WHERE LOWER(name) = LOWER($2)
             ON CONFLICT (user_id, role_id) DO NOTHING`,
            [uid, t.role],
          );
        }
        console.log(`[docker-init] Created account ${t.username} (${t.role})`);
      }
    }
  } finally {
    await c.end();
  }
}

async function main() {
  const ready = await ensureDatabaseAndWait();
  if (!ready) return;
  runScript('migrate');
  runScript('seed');
  await restoreBaselineSnapshotIfEmpty();
  runScript('seed:logos');
  await ensureTeamAccounts();
  console.log('[docker-init] Initialisation complete.');
}

main().catch((e) => {
  console.error('[docker-init] Warning during init:', e.message || e);
  process.exit(0);
});
