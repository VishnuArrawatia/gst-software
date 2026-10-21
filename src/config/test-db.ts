/**
 * Fail-closed guard for anything that WRITES to a database.
 *
 * The Phase 0 acceptance tests are real integration tests: they INSERT, UPDATE
 * and DELETE. They were safe by care (a synthetic period, a cleanup at both
 * ends) but not safe by construction — they wrote into whatever `PGDATABASE`
 * held, and `PGDATABASE` defaults to `gst_erp`, the live books. Forgetting to
 * export one variable was enough to write test rows into production.
 *
 * So the target is now proved in two independent places before a single row is
 * written:
 *
 *   1. `assertTestDbTarget()` — called by the test runner before it connects.
 *      It requires BOTH an explicit opt-in (`GST_DB_PROFILE=test`) AND the exact
 *      database name. Either one alone is not enough, because a profile set on a
 *      shell that kept `PGDATABASE` (or a name set with the profile forgotten)
 *      must not be treated as consent.
 *
 *   2. `assertConnectedDatabase()` — called on every connection while the test
 *      profile is active, and it asks the SERVER what database it is in. A stale
 *      pool, a mistyped `.env` or a proxy cannot satisfy this, because the
 *      answer comes from PostgreSQL itself rather than from our configuration.
 *
 * Both refuse by exiting non-zero. Nothing is downgraded to a warning, and
 * there is no override flag: a test that cannot prove where it is running does
 * not run at all. Printing the host/port/database is deliberate — the operator
 * needs to see the target — but never a password.
 */

/** The one database a guarded run may write to. */
export const TEST_DB_NAME = 'gst_erp_test';

/** The one profile value that arms the guard. */
export const TEST_DB_PROFILE = 'test';

const EXIT_WRONG_TARGET = 9;

export interface TestDbTarget {
  database: string;
  host: string;
  port: number;
}

/** Is the guard armed? Only the exact string counts. */
export function isTestProfile(): boolean {
  return process.env.GST_DB_PROFILE === TEST_DB_PROFILE;
}

function targetFromEnv(): TestDbTarget {
  return {
    database: process.env.PGDATABASE ?? '',
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
  };
}

/**
 * Refuse to continue unless we are explicitly pointed at the test database.
 * Call this BEFORE creating a client. Exits 9 on any doubt.
 */
export function assertTestDbTarget(what: string): TestDbTarget {
  const profile = process.env.GST_DB_PROFILE ?? '';
  const target = targetFromEnv();
  const problems: string[] = [];

  if (profile !== TEST_DB_PROFILE) {
    problems.push(
      `GST_DB_PROFILE must be exactly "${TEST_DB_PROFILE}" (got ${profile ? `"${profile}"` : 'unset'})`,
    );
  }
  if (target.database !== TEST_DB_NAME) {
    problems.push(
      `PGDATABASE must be exactly "${TEST_DB_NAME}" (got ${target.database ? `"${target.database}"` : 'unset'})`,
    );
  }

  if (problems.length) {
    console.error('');
    console.error('  REFUSED — this writes to a database and the target is not the test database.');
    console.error(`  ${what}`);
    console.error('');
    for (const p of problems) console.error(`    - ${p}`);
    console.error('');
    console.error('  A refused run has written nothing. To run it against the test database,');
    console.error('  set both variables explicitly, e.g.');
    console.error('');
    console.error(`    GST_DB_PROFILE=${TEST_DB_PROFILE} PGDATABASE=${TEST_DB_NAME} npm run test:p0`);
    console.error('');
    console.error('  There is no override. A test that cannot prove its target does not run.');
    console.error('');
    process.exit(EXIT_WRONG_TARGET);
  }

  return target;
}

/**
 * Ask PostgreSQL which database this connection is really in, and refuse to
 * continue on any answer but the test database. Exits 9.
 */
export function assertConnectedDatabase(current: string, what: string): void {
  if (current === TEST_DB_NAME) return;
  console.error('');
  console.error('  REFUSED — the connection landed in the wrong database.');
  console.error(`  ${what}`);
  console.error('');
  console.error(`    server reports: ${current || '(unknown)'}`);
  console.error(`    required      : ${TEST_DB_NAME}`);
  console.error('');
  console.error('  No statement was run. Check PGDATABASE, any shell override, and the');
  console.error('  PostgreSQL cluster the client actually reached.');
  console.error('');
  process.exit(EXIT_WRONG_TARGET);
}

/**
 * The target's name for a log line. Never includes a password.
 */
export function describeTestDbTarget(t: TestDbTarget): string {
  return `${t.host}:${t.port}/${t.database}`;
}
