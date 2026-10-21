/**
 * GST ERP — apply the SQL migrations.
 *
 * Reads .env, connects to PostgreSQL, and runs every migrations/*.sql file in
 * name order inside a transaction. Already-applied files are skipped via a
 * schema_migrations table, so this is safe to re-run.
 *
 * Usage:  npm run migrate
 */

import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

import { loadEnv, pgConfig } from '../src/config/env';

loadEnv();
const cfg = pgConfig();

if (!cfg.password) {
  console.error('PGPASSWORD is empty in .env — fill it in and re-run.');
  process.exit(2);
}

const main = async () => {
  const client = new Client(cfg);
  try {
    await client.connect();
  } catch (e: any) {
    console.error(`Cannot connect to ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    console.error(`  ${e.message}`);
    console.error('Check PGPASSWORD in .env. Is the database created?');
    process.exit(3);
  }

  console.log(`connected: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(process.cwd(), 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const already = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [f]);
    if (already.rowCount) {
      console.log(`  skip    ${f} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Each migration is atomic: a half-applied schema is worse than none,
    // because the next run would skip it and leave broken tables behind.
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`  applied ${f}`);
    } catch (e: any) {
      await client.query('ROLLBACK');
      console.error(`  FAILED  ${f}\n    ${e.message}`);
      process.exit(4);
    }
  }

  const tables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  console.log(`\ntables in ${cfg.database}:`);
  for (const t of tables.rows) console.log('  - ' + t.tablename);

  await client.end();
};

main();
