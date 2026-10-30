/**
 * Load .env into process.env.
 *
 * Deliberately hand-rolled rather than pulling in dotenv for six keys. Keys
 * already present in the environment win, so a shell override still works —
 * except that `PORT` is handled by the server itself, because `PORT=0` is a
 * common environment default that means "any free port" and would move the
 * app somewhere nobody can find.
 */

import fs from 'fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Read DATE columns as the plain `YYYY-MM-DD` string PostgreSQL sent.
 *
 * node-pg's default turns a DATE into a JavaScript Date at LOCAL midnight. In
 * IST that is 18:30 UTC the previous day, so anything that then formats it as
 * UTC — `toISOString()`, `JSON.stringify`, the default `toString()` in a
 * browser — silently reports the invoice a day EARLIER than the date the
 * business actually recorded.
 *
 * That is not hypothetical: it put every invoice date on the purchase
 * reconciliation screen one day early, and it stopped any drafted GSTR-1
 * invoice from ever matching its filed counterpart, because both sides of the
 * comparison were shifted.
 *
 * A DATE carries no timezone and no time of day, so there is nothing a Date
 * object adds here that the string does not already say exactly. Making the
 * parser return the string removes the entire class of bug instead of fixing
 * one call site at a time — and the few places that genuinely need components
 * out of a date already guard on `instanceof Date`, so they simply take the
 * string path.
 *
 * TIMESTAMPTZ (OID 1184) is deliberately left alone: it really is an instant,
 * and it should keep behaving like one.
 */
pg.types.setTypeParser(1082, (v: string) => v);

export function loadEnv(file = path.join(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

/** PostgreSQL connection built from the environment (supports DATABASE_URL or PG* vars). */
export function pgConfig() {
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (!process.env.PGHOST && u.hostname) process.env.PGHOST = u.hostname;
      if (!process.env.PGPORT && u.port) process.env.PGPORT = u.port;
      if (!process.env.PGUSER && u.username) process.env.PGUSER = decodeURIComponent(u.username);
      if (!process.env.PGPASSWORD && u.password) process.env.PGPASSWORD = decodeURIComponent(u.password);
      const dbPath = u.pathname.replace(/^\//, '');
      if (!process.env.PGDATABASE && dbPath) process.env.PGDATABASE = dbPath;
    } catch {
      // Ignore malformed DATABASE_URL and fall back to PG* variables
    }
  }
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'gst_erp',
  };
}