/**
 * Production / Coolify container startup initializer:
 *  1. Waits up to 45s for PostgreSQL to accept connections.
 *  2. Applies all SQL migrations in `migrations/*.sql` idempotently.
 *  3. Seeds Company / Unit / GSTIN / Financial Year masters and company logos.
 *  4. Initialises default team accounts (MASTER, USER-1, USER-2, USER-3) ONLY
 *     when a user still carries the sentinel `LOGIN_NOT_ENABLED` hash — never
 *     overwrites a password changed by the team.
 */

import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { hashPassword } from '../src/app/auth';

loadEnv();

async function waitForPostgres(maxWaitMs = 45000): Promise<void> {
  const cfg = pgConfig();
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < maxWaitMs) {
    const client = new Client(cfg);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log(`[docker-init] PostgreSQL ready at ${cfg.host}:${cfg.port}/${cfg.database}`);
      return;
    } catch (e: any) {
      lastErr = e.message || String(e);
      await client.end().catch(() => {});
      console.log(`[docker-init] Waiting for PostgreSQL (${cfg.host}:${cfg.port})... ${lastErr}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`PostgreSQL did not become ready within ${maxWaitMs}ms: ${lastErr}`);
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
  await waitForPostgres();
  runScript('migrate');
  runScript('seed');
  runScript('seed:logos');
  await ensureTeamAccounts();
  console.log('[docker-init] Initialisation complete.');
}

main().catch((e) => {
  console.error('[docker-init] Fatal error:', e.message || e);
  process.exit(1);
});
