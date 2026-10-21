/**
 * Run one database-writing script against the isolated TEST database.
 *
 * Why a wrapper instead of `GST_DB_PROFILE=test PGDATABASE=gst_erp_test tsx …`
 * inside package.json: npm runs scripts through cmd.exe on Windows, where the
 * `VAR=value command` prefix is not valid syntax — the script would fail to
 * start with a confusing error, and a script that fails to start is exactly the
 * one an operator is tempted to run "the old way". This wrapper sets both
 * variables in-process, so the guard is armed no matter which shell invoked it.
 *
 * It deliberately does NOT accept a database name. There is one test database;
 * making it a parameter would rebuild the mistake this exists to prevent.
 *
 *   npm run test:p0:test                          # tests/phase0-db.ts
 *   npm run migrate:test                          # migrations -> gst_erp_test
 *   npm run seed:test                             # masters -> gst_erp_test
 *   npm run e2e:test -- --input <dir> --out <dir> # monthly pipeline -> gst_erp_test
 *
 * Extra arguments after the target are passed straight through to it, which is
 * what lets `e2e:test` take the CLI's own `--input` / `--out` flags.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TEST_DB_NAME, TEST_DB_PROFILE } from '../src/config/test-db';

const target = process.argv[2];
if (!target) {
  console.error('');
  console.error('  usage: tsx scripts/test-db.ts <script.ts> [args…]');
  console.error('');
  console.error('    npm run test:p0:test | migrate:test | seed:test | e2e:test');
  console.error('');
  process.exit(2);
}

// Armed before the target module is loaded, so its own `loadEnv()` cannot
// overwrite them: loadEnv only fills keys that are not already set.
process.env.GST_DB_PROFILE = TEST_DB_PROFILE;
process.env.PGDATABASE = TEST_DB_NAME;

const file = path.resolve(process.cwd(), target);
console.log(`test-db: GST_DB_PROFILE=${TEST_DB_PROFILE} PGDATABASE=${TEST_DB_NAME} -> ${target}`);

// Dynamic import so the environment is already set when the target's top-level
// code runs. The path goes through pathToFileURL because the dynamic import
// loader rejects a bare `F:\…` specifier on Windows — it needs `file:///F:/…`.
// Anything the target exits with becomes this process's exit code.
await import(pathToFileURL(file).href);
