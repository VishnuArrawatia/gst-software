/**
 * Synthetic fixture for the L5 positive control in tests/phase0-db.ts.
 *
 * L5 asserts that the April-2025 dataset really has 2B-not-in-books rows for the
 * month filter to bite on:
 *
 *   FAIL  L5 April really has 2B-not-in-books rows to filter  ->  0
 *
 * On the live books it passes because the real GSTR-2B download supplies the
 * rows. On a fresh `gst_erp_test` there is nothing to find, so the control has
 * no data — and the honest fix is to give the test database the minimum data it
 * assumes, never to weaken the assertion.
 *
 * What is seeded, and why exactly this much:
 *
 *   * two `gstr2b_lines` rows for 2025-04 under the seeded Sakar-I GSTIN. Two,
 *     not one, so the report's count is compared against a total rather than a
 *     single row (L6 compares the report to the ground-truth SQL).
 *   * NO purchase rows. The report is
 *     `NOT EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)`,
 *     and in this database the book side is empty, so both 2B rows are
 *     genuinely "not in books" — that is the filter being exercised. Adding a
 *     purchase row would mean inventing book data, which is more than the
 *     control needs.
 *
 * Safety, in layers:
 *   1. `assertTestDbTarget()` refuses unless GST_DB_PROFILE=test AND
 *      PGDATABASE=gst_erp_test, before a client exists. Exit 9.
 *   2. `assertConnectedDatabase()` asks the server where the connection really
 *      landed, before the first INSERT. Exit 9.
 *   3. Every row carries the `TESTFIX|` key prefix, so cleanup is exact and can
 *      only ever delete this fixture — never a real book line.
 *
 * Repeatable: keys are fixed, inserts are `ON CONFLICT (line_key) DO UPDATE`, so
 * running it twice changes nothing. `--clean` removes exactly the fixture.
 *
 *   npm run fixture:test          # seed (idempotent)
 *   npm run fixture:test:clean    # remove the fixture
 */

import { Client } from 'pg';

import { loadEnv, pgConfig } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget, describeTestDbTarget } from '../src/config/test-db';

loadEnv();

const TARGET = assertTestDbTarget('synthetic test fixtures (scripts/seed-test-fixtures.ts)');

/** The seeded Sakar-I registration, from scripts/seed-masters.ts. */
const OUR_GSTIN = '26AALCS9985J1ZC';
const MONTH = '2025-04';
/** Marks every row this script owns. Cleanup matches on this and nothing else. */
const KEY_PREFIX = 'TESTFIX|';

interface Fixture {
  invoice_no: string;
  invoice_date: string;
  supplier_gstin: string;
  supplier_name: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
}

/**
 * Named as fixtures, and shaped so the money columns exercise the report's
 * ITC total (`igst + cgst + sgst + cess`) rather than sitting at zero.
 */
const FIXTURES: Fixture[] = [
  {
    invoice_no: 'TESTFIX/L5/0001', invoice_date: '2025-04-11',
    supplier_gstin: '29AAAAA0000A1Z5', supplier_name: 'TESTFIX SUPPLIER ONE',
    taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0,
  },
  {
    invoice_no: 'TESTFIX/L5/0002', invoice_date: '2025-04-23',
    supplier_gstin: '27BBBBB0000B1Z6', supplier_name: 'TESTFIX SUPPLIER TWO',
    taxable_value: 20000, igst: 0, cgst: 1800, sgst: 1800,
  },
];

const keyOf = (f: Fixture) => `${KEY_PREFIX}${MONTH}|${f.invoice_no}`;

/** The exact count L5 asserts is greater than zero, and L6 compares the report to. */
async function notInBooksCount(c: Client): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int n FROM gstr2b_lines t
      WHERE t.twob_month = $1
        AND NOT EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)`,
    [MONTH],
  );
  return r.rows[0].n;
}

async function seededCount(c: Client): Promise<number> {
  const r = await c.query(
    'SELECT count(*)::int n FROM gstr2b_lines WHERE line_key LIKE $1',
    [`${KEY_PREFIX}%`],
  );
  return r.rows[0].n;
}

const main = async () => {
  const clean = process.argv.includes('--clean');
  const c = new Client(pgConfig());
  await c.connect();

  // Ask the server, not our own configuration, before touching anything.
  const landed = await c.query('SELECT current_database() AS d');
  assertConnectedDatabase(String(landed.rows[0]?.d ?? ''), 'synthetic test fixtures');
  console.log(`fixtures target ${describeTestDbTarget(TARGET)} (confirmed by server)`);

  if (clean) {
    const del = await c.query('DELETE FROM gstr2b_lines WHERE line_key LIKE $1', [`${KEY_PREFIX}%`]);
    console.log(`  cleaned  ${del.rowCount} fixture row(s); ${await seededCount(c)} remaining`);
  } else {
    for (const f of FIXTURES) {
      await c.query(
        `INSERT INTO gstr2b_lines
           (line_key, our_gstin, supplier_gstin, supplier_name, invoice_no, invoice_date,
            document_type, taxable_value, igst, cgst, sgst, cess, invoice_value,
            twob_month, portal_fp, itc_availability, source_file, source_row, source_format)
         VALUES ($1,$2,$3,$4,$5,$6,'Regular',$7,$8,$9,$10,0,$7::numeric+$8::numeric+$9::numeric+$10::numeric,
                 $11,$11,'Yes','TESTFIX',1,'xlsx')
         ON CONFLICT (line_key) DO UPDATE SET
           supplier_gstin = EXCLUDED.supplier_gstin,
           supplier_name  = EXCLUDED.supplier_name,
           invoice_date   = EXCLUDED.invoice_date,
           taxable_value  = EXCLUDED.taxable_value,
           igst = EXCLUDED.igst, cgst = EXCLUDED.cgst, sgst = EXCLUDED.sgst,
           invoice_value  = EXCLUDED.invoice_value,
           twob_month = EXCLUDED.twob_month`,
        [keyOf(f), OUR_GSTIN, f.supplier_gstin, f.supplier_name, f.invoice_no, f.invoice_date,
         f.taxable_value, f.igst, f.cgst, f.sgst, MONTH],
      );
    }
    console.log(`  seeded   ${await seededCount(c)} fixture row(s) under ${OUR_GSTIN} ${MONTH}`);
  }

  const n = await notInBooksCount(c);
  console.log(`  L5 control: gstr2b_lines for ${MONTH} with no book match = ${n}` +
    (n > 0 ? ' (the control has data)' : ' (WARNING: the control still has nothing to find)'));

  await c.end();
  // A control with no rows would fail L5 again; make that a failed script, not a
  // shrug in a log nobody reads.
  if (!clean && n <= 0) process.exit(1);
};

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
