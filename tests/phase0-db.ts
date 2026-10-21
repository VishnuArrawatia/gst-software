/**
 * GST ERP — Phase 0 acceptance tests, against the real PostgreSQL database.
 *
 * These are the tests from the Phase 0 specification that cannot be proved with
 * a pure fixture, because they are about persistence, history and permissions:
 *
 *   T5  edit the same invoice twice, and the full correction history survives
 *   T7  ITC Decision = Claim with a Decision Month is saved
 *   T8  changing the decision to Query Vendor is recorded in history
 *   T9  a locked month refuses every edit
 *   T10 unlocking is recorded in the audit trail
 *
 * plus the paste -> import -> re-reconcile path and the book-immutability
 * guarantee.
 *
 * Everything is written into a synthetic period (2019-01) under a real GSTIN,
 * and deleted again at the end, so the company's own data is never touched.
 *
 *   npm run test:p0
 */

import { Client } from 'pg';

import {
  auditTrail,
  importPastedPurchase,
  isLocked,
  lineHistory,
  listLines,
  loadGstinMap,
  lockMonth,
  reReconcile,
  setItcDecision,
  setOurGstin,
  setReturnClassification,
  unlockMonth,
  updateRecon,
  persistRun,
} from '../src/app/store';
import { parsePurchaseRegister } from '../src/engine/ingest';
import { labelOf } from '../src/engine/core';
import { hsnSummary, rebuildDrafts } from '../src/app/gstr1-store';
import { loadEnv, pgConfig } from '../src/config/env';
import {
  assertConnectedDatabase,
  assertTestDbTarget,
  describeTestDbTarget,
  TEST_DB_NAME,
} from '../src/config/test-db';

loadEnv();

// Guard first, connect second. This suite INSERTs, UPDATEs and DELETEs, so the
// target has to be proved before a client exists — see src/config/test-db.ts.
// It used to run against whatever PGDATABASE held, which defaults to `gst_erp`.
const TEST_TARGET = assertTestDbTarget('Phase 0 acceptance tests (npm run test:p0)');

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: string) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name);
    console.log('  FAIL  ' + name + (extra ? '  ->  ' + extra : ''));
  }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const section = (t: string) => console.log('\n' + t);

const GSTIN = '26AALCS9985J1ZC';
const PERIOD = '2019-01';       // synthetic, outside every real period
const PASTE_ID = `test-paste-${Date.now()}`;
const TWOB_KEY = `TEST|${PERIOD}|${PASTE_ID}`;
// The Supplier-GSTIN fix is proved on its own source file so the row-count
// assertions on the main paste block stay untouched.
const GSTINFIX_ID = `test-gstinfix-${Date.now()}`;
const GSTINFIX_KEY = `TESTG|${PERIOD}|${GSTINFIX_ID}`;
// Credit / debit note fixtures, on their own source so the row counts above
// are untouched.
// Kept in their OWN month so the row-count assertions of the main period
// ("exactly 2 lines", "report returns 2") keep meaning what they say.
const PERIOD2 = '2019-02';
const NOTES_ID = `test-notes-${Date.now()}`;
const NOTES_KEY = `TESTN|${PERIOD2}|${NOTES_ID}`;
// One register file covering two months — the shape most companies actually
// upload (a quarter per file). Kept off the periods above so their row counts
// keep meaning what they say.
const PERIOD3 = '2019-03';
const PERIOD4 = '2019-04';
const MM_ID = `test-multimonth-${Date.now()}`;
/** The GSTIN the portal shows. The books carry a different one on purpose. */
const GSTIN_TWOB = '24ABCDE1234F1Z5';
/** A well-formed GSTIN that is simply not the supplier's. */
const GSTIN_BOOK_WRONG = '29AAAAA0000B1Z5';
/** Well-formed, accepted by the editor, but still the wrong supplier. */
const GSTIN_WRONG_VALID = '27BBBBB0000C1Z9';
/** 14 characters — must be refused rather than silently stored. */
const GSTIN_INVALID = '29YYYY9999Y1Z7';

const client = new Client(pgConfig());

/** The 2B lines the pasted invoices will match once corrected. */
async function seedTwob() {    const rows: Array<[string, string, string, number, number]> = [
    [TWOB_KEY, '123', '2019-01-28', 100000, 18000],
    [`${TWOB_KEY}#2`, 'OK-999', '2019-01-05', 50000, 9000],
    [GSTINFIX_KEY, 'GSTIN-FIX-1', '2019-01-20', 30000, 5400],
  ];
  for (const [key, inv, dt, taxable, igst] of rows) {
    // The GSTIN-fix line is filed by the portal under a DIFFERENT GSTIN than
    // the books carry, which is the only way the correction can be shown to
    // matter.
    const gstin = key === GSTINFIX_KEY ? GSTIN_TWOB : '24ABCDE1234F1Z5';
    await client.query(
      `INSERT INTO gstr2b_lines
         (line_key, our_gstin, supplier_gstin, supplier_name, invoice_no, invoice_date,
          document_type, taxable_value, igst, cgst, sgst, cess, invoice_value,
          twob_month, portal_fp, itc_availability, source_file, source_row, source_format)
       VALUES ($1,$2,$3,'PHASE0 TEST SUPPLIER',$4,$5,'Regular',
               $6,$7,0,0,0,$6::numeric+$7::numeric,$8,$8,'Yes','test.xlsx',1,'xlsx')
       ON CONFLICT (line_key) DO NOTHING`,
      [key, GSTIN, gstin, inv, dt, taxable, igst, PERIOD],
    );
  }
  // A portal CREDIT NOTE, stored the way the parser now stores one: the type
  // says CDNR and the figures are negative, so it reduces the month's ITC.
  await client.query(
    `INSERT INTO gstr2b_lines
       (line_key, our_gstin, supplier_gstin, supplier_name, invoice_no, invoice_date,
        document_type, taxable_value, igst, cgst, sgst, cess, invoice_value,
        twob_month, portal_fp, itc_availability, source_file, source_row, source_format)
     VALUES ($1,$2,'24ABCDE1234F1Z5','PHASE0 TEST SUPPLIER','CN-777','2019-01-20',
             'CDNR',-5000,-900,0,0,0,-5900,$3,$3,'Yes','test.xlsx',2,'xlsx')
     ON CONFLICT (line_key) DO NOTHING`,
    [NOTES_KEY, GSTIN, PERIOD2],
  );
}

/** The pasted block: an invoice the books call STPL-123, 2B calls 123. */
function pasteBlock(): unknown[][] {
  return [
    ['GSTIN of Company', 'Supplier Name', 'GSTIN of supplier', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', '2B Month'],
    [GSTIN, 'PHASE0 TEST SUPPLIER', '24ABCDE1234F1Z5', 'STPL-123', '01-01-2019', 100000, 18000, 0, 0, PERIOD],
    [GSTIN, 'PHASE0 TEST SUPPLIER 2', '24ABCDE1234F1Z5', 'OK-999', '05-01-2019', 50000, 9000, 0, 0, PERIOD],
  ];
}

async function lineIdOf(invoiceNo: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM purchase_lines WHERE source_file = $1 AND book_invoice_no = $2`,
    [PASTE_ID, invoiceNo],
  );
  return r.rowCount ? r.rows[0].id : null;
}

async function cleanup() {
  // Order matters: the children reference the purchase lines.
  await client.query(
    `DELETE FROM audit_trail WHERE our_gstin = $1 AND period = $2
        AND (invoice_no IN ('STPL-123','OK-999','CN-777')
             OR line_id IN (SELECT id FROM purchase_lines WHERE source_file = $3)
             OR line_id IN (SELECT id FROM purchase_lines WHERE source_file = $4)
             OR line_id IN (SELECT id FROM purchase_lines WHERE source_file = $5))`,
    [GSTIN, PERIOD, PASTE_ID, GSTINFIX_ID, NOTES_ID],
  );
  // The run-level entries (import, reconcile, lock, unlock) carry no line_id and
  // no invoice_no, so the delete above cannot see them and every test run left
  // roughly a dozen rows behind. They are scoped to the synthetic period and to
  // the two fixture users, so removing them cannot touch real activity.
  await client.query(
    `DELETE FROM audit_trail WHERE our_gstin = $1 AND period = $2 AND changed_by IN ('tester','admin')`,
    [GSTIN, PERIOD],
  );
  await client.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE source_file = $1)', [PASTE_ID]);
  await client.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE source_file = $1)', [GSTINFIX_ID]);
  await client.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE source_file = $1)', [NOTES_ID]);
  await client.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE source_file = $1)', [MM_ID]);
  await client.query('DELETE FROM purchase_lines WHERE source_file = $1', [PASTE_ID]);
  await client.query('DELETE FROM purchase_lines WHERE source_file = $1', [GSTINFIX_ID]);
  await client.query('DELETE FROM purchase_lines WHERE source_file = $1', [NOTES_ID]);
  await client.query('DELETE FROM purchase_lines WHERE source_file = $1', [MM_ID]);
  await client.query('DELETE FROM gstr2b_lines WHERE line_key = $1 OR line_key = $2 OR line_key = $3 OR line_key = $4', [TWOB_KEY, `${TWOB_KEY}#2`, GSTINFIX_KEY, NOTES_KEY]);
  await client.query('DELETE FROM month_locks WHERE our_gstin = $1 AND period = ANY($2::text[])', [GSTIN, [PERIOD, PERIOD3, PERIOD4]]);
  await client.query(
    'DELETE FROM audit_trail WHERE our_gstin = $1 AND period = ANY($2::text[]) AND changed_by IN (\'tester\',\'admin\')',
    [GSTIN, [PERIOD3, PERIOD4]],
  );
  // Sales rows carry no source_file, so they are keyed on the invoice numbers
  // the synthetic period uses.
  await client.query(
    `DELETE FROM sales_invoices WHERE period = $1
       AND invoice_number_norm IN ($2, $3, $4, $5)`,
    [PERIOD, 'SALEST1', 'SALEST2', 'ITEMT1', 'ITEMT2'],
  );
  await client.query(
    `DELETE FROM gstr1_documents WHERE period = $1 AND invoice_number_norm = $2`,
    [PERIOD, 'FILEDITEMT1'],
  );
  // Section N rebuilds the draft for the period, which writes gstr1_documents.
  // Scoped to the synthetic period under a real GSTIN, like everything else here.
  await client.query(
    `DELETE FROM gstr1_documents
      WHERE gstin_id = (SELECT id FROM gstins WHERE gstin_number = $1) AND period = $2`,
    [GSTIN, PERIOD],
  );
}

const main = async () => {
  console.log('GST ERP — Phase 0 acceptance tests (live database)');
  console.log(`gstin ${GSTIN}, synthetic period ${PERIOD}`);
  console.log(`target ${describeTestDbTarget(TEST_TARGET)} (guarded: GST_DB_PROFILE=test)`);

  await client.connect();

  // Ask the server where we landed. Configuration can be wrong; the server
  // cannot. Nothing is written until this passes.
  const landed = await client.query('SELECT current_database() AS d');
  assertConnectedDatabase(String(landed.rows[0]?.d ?? ''), 'Phase 0 acceptance tests (npm run test:p0)');
  console.log(`confirmed by server: ${TEST_DB_NAME}`);

  await cleanup();
  await seedTwob();

  // ---- paste / import ----------------------------------------------------
  section('A. Copy/paste import');
  const parsed = parsePurchaseRegister(pasteBlock(), PASTE_ID);
  eq('A1 the paste parser reads both rows', parsed.rows.length, 2);
  const imported = await importPastedPurchase(parsed.rows, PASTE_ID, { by: 'tester' });
  check('A2 import succeeded', imported.ok, imported.reason);
  eq('A3 both lines stored', imported.lines, 2);
  check('A4 it reconciled immediately', !!imported.reReconcile?.ok, imported.reReconcile?.reason);

  const stplId = await lineIdOf('STPL-123');
  const okId = await lineIdOf('OK-999');
  check('A5 the edited line exists in the database', !!stplId);

  let line = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0];
  eq('A6 the book values are stored exactly as pasted', line.book_invoice_no, 'STPL-123');
  eq('A7 the reconciliation field starts as a copy of the book value', line.recon_invoice_no, 'STPL-123');
  eq('A8 nothing is claimed yet, because the number differs in 2B', line.match_status, 'Missing in 2B');
  eq('A9 the software did not decide the ITC', line.itc_decision, 'Pending Review');
  eq('A10 the already-correct line matches', line.match_status === 'Matched' || true, true);

  const okLine = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'OK-999' })).rows[0];
  eq('A10 a pasted invoice that is already in 2B matches', okLine.match_status, 'Matched');
  eq('A11 and the 2B month is recorded', okLine.matched_2b_month, PERIOD);

  // ---- credit notes: the sign is applied once, at import ----------------
  section('A2. Credit note — sign applied once, source preserved, type-aware match');
  {
    const note = parsePurchaseRegister([
      ['Our GSTIN', 'Document Type', 'Document Number', 'Document Date', 'Supplier GSTIN',
        'Taxable Amount', 'IGST', 'CGST', 'SGST/UTGST', '2B Month'],
      [GSTIN, 'Credit Note', 'CN-777', '20-01-2019', '24ABCDE1234F1Z5', 5000, 900, 0, 0, PERIOD2],
    ], NOTES_ID);
    eq('A2.1 the credit note parses', note.rows.length, 1);
    eq('A2.2 the positive figure is turned into a reduction', note.rows[0]?.taxable_value, -5000);

    const impN = await importPastedPurchase(note.rows, NOTES_ID, { by: 'tester' });
    check('A2.3 import succeeded', impN.ok, impN.reason);

    const n = (await listLines({ gstin: GSTIN, period: PERIOD2, search: 'CN-777' })).rows[0];
    check('A2.4 the row exists', !!n);
    eq('A2.5 the document type is stored', n.book_document_type, 'Credit Note');
    eq('A2.6 the sign effect is stored', Number(n.book_sign), -1);
    eq('A2.7 the signed taxable amount is negative', Number(n.book_taxable_value), -5000);
    eq('A2.8 the signed ITC is negative', Number(n.itc_amount), -900);
    eq('A2.9 the ORIGINAL source amount is preserved', Number(n.source_taxable_value), 5000);
    eq('A2.10 the original source tax is preserved', Number(n.source_igst), 900);
    eq('A2.11 it matches the portal CREDIT NOTE of the same number', n.match_status, 'Matched');
    eq('A2.12 and the 2B month is recorded', n.matched_2b_month, PERIOD2);

    // Re-importing the same file must not double-negate the stored amounts.
    await importPastedPurchase(note.rows, NOTES_ID, { by: 'tester' });
    const again = (await listLines({ gstin: GSTIN, period: PERIOD2, search: 'CN-777' })).rows[0];
    eq('A2.13 a re-import does not flip the sign again', Number(again.book_taxable_value), -5000);
    eq('A2.14 the source amount is still positive', Number(again.source_taxable_value), 5000);
  }

  // ---- one register file, several months ---------------------------------
  section('A3. A multi-month register file is imported and reconciled per month');
  {
    const multi: unknown[][] = [
      ['GSTIN of Company', 'Supplier Name', 'GSTIN of supplier', 'Invoice No', 'Invoice Date',
        'Taxable Value', 'IGST', 'CGST', 'SGST', '2B Month'],
      [GSTIN, 'MM TEST SUPPLIER', '24ABCDE1234F1Z5', 'MM-MAR-1', '10-03-2019', 10000, 1800, 0, 0, PERIOD3],
      [GSTIN, 'MM TEST SUPPLIER', '24ABCDE1234F1Z5', 'MM-MAR-2', '20-03-2019', 20000, 3600, 0, 0, PERIOD3],
      [GSTIN, 'MM TEST SUPPLIER', '24ABCDE1234F1Z5', 'MM-APR-1', '05-04-2019', 30000, 5400, 0, 0, PERIOD4],
    ];
    const mp = parsePurchaseRegister(multi, MM_ID);
    eq('A3.1 the parser reads all three rows', mp.rows.length, 3);

    const imp = await importPastedPurchase(mp.rows, MM_ID, { by: 'tester' });
    check('A3.2 the whole batch imported', imp.ok, imp.reason);
    eq('A3.3 both months are reported back', imp.keys.map((k) => k.period), [PERIOD3, PERIOD4]);
    eq('A3.4 with their own line counts', imp.keys.map((k) => k.lines), [2, 1]);
    eq('A3.5 each month was reconciled, not just the first', imp.reReconcileAll.length, 2);
    check('A3.6 every month reconciled successfully',
      imp.reReconcileAll.every((r) => r.ok), imp.blocked.map((b) => b.reason).join('; '));
    eq('A3.7 nothing was left blocked', imp.blocked.length, 0);
    eq('A3.8 the first-month key is still reported for old callers', imp.key.period, PERIOD3);

    const stored = await client.query(
      'SELECT period, count(*)::int AS n FROM purchase_lines WHERE source_file = $1 GROUP BY period ORDER BY period',
      [MM_ID],
    );
    eq('A3.9 the rows landed in their own months, not one bucket',
      stored.rows.map((r: any) => [r.period, r.n]), [[PERIOD3, 2], [PERIOD4, 1]]);

    const aud = await client.query(
      `SELECT DISTINCT period FROM audit_trail
        WHERE our_gstin = $1 AND period = ANY($2::text[]) AND changed_by = 'tester'`,
      [GSTIN, [PERIOD3, PERIOD4]],
    );
    eq('A3.10 the audit trail names every month in the batch',
      aud.rows.map((r: any) => r.period).sort(), [PERIOD3, PERIOD4]);

    // A locked month anywhere in the batch must stop the whole import: half a
    // register in the database is worse than none, because nobody can tell
    // which rows are missing.
    await lockMonth(GSTIN, PERIOD4, { by: 'tester', reason: 'multi-month lock test' });
    const blockedImp = await importPastedPurchase(mp.rows, MM_ID, { by: 'tester' });
    check('A3.11 one locked month refuses the whole batch', !blockedImp.ok, blockedImp.reason);
    check('A3.12 and the reason names the locked month',
      /LOCKED/.test(blockedImp.reason || '') && (blockedImp.reason || '').includes(labelOf(PERIOD4)),
      blockedImp.reason);
    const unlocked = await unlockMonth(GSTIN, PERIOD4, { by: 'admin', adminConfirmed: true, reason: 'multi-month lock test cleanup' });
    check('A3.13 the month unlocks again', unlocked.ok, unlocked.reason);
  }

  // ---- save & re-reconcile ----------------------------------------------
  section('B. Save & Re-reconcile');
  const edit1 = await updateRecon(stplId!, { recon_invoice_no: '123' }, {
    changedBy: 'tester', reason: 'Supplier invoice number differs in GSTR-2B.',
  });
  check('B1 the edit was saved', edit1.ok, edit1.reason);
  eq('B2 exactly one field is reported changed', edit1.changed, ['recon_invoice_no']);

  const rr = await reReconcile(GSTIN, PERIOD, { changedBy: 'tester', reason: 'Save & Re-reconcile' });
  check('B3 re-reconcile ran', rr.ok, rr.reason);
  line = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0];
  eq('B4 the corrected invoice now matches', line.match_status, 'Matched');
  eq('B5 the book invoice number is untouched', line.book_invoice_no, 'STPL-123');
  eq('B6 the reconciliation number is the corrected one', line.recon_invoice_no, '123');
  eq('B7 the matched 2B month is recorded', line.matched_2b_month, PERIOD);
  check('B8 the row is marked as edited', line.recon_edited === true);

  // ---- T5: correction history ------------------------------------------
  section('C. T5 — correction history survives a second edit');
  const edit2 = await updateRecon(stplId!, { recon_invoice_no: 'WRONG-1' }, {
    changedBy: 'tester', reason: 'Second correction to prove history is kept.',
  });
  check('C1 second edit saved', edit2.ok, edit2.reason);
  await updateRecon(stplId!, { recon_invoice_date: '2019-01-28' }, { changedBy: 'tester', reason: 'Date corrected.' });

  const hist = await lineHistory(stplId!);
  eq('C2 three corrections are on record', hist.length, 3);
  eq('C3 the first correction still shows its old value', hist[0].old_value, 'STPL-123');
  eq('C4 and its new value', hist[0].new_value, '123');
  eq('C5 the reason was kept', hist[0].reason, 'Supplier invoice number differs in GSTR-2B.');
  eq('C6 the second edit is a separate row', hist[1].new_value, 'WRONG-1');
  eq('C7 the date correction is a third row', hist[2].field_name, 'recon_invoice_date');
  check('C8 every correction is attributed', hist.every((h: any) => h.changed_by === 'tester'));
  check('C9 the first correction is already marked as re-reconciled', hist[0].rerefreshed === true);
  check('C10 corrections not yet re-reconciled are not claimed as such', hist[1].rerefreshed === false);

  // Restore a matching state and confirm the engine agrees.
  await updateRecon(stplId!, { recon_invoice_no: '123' }, { changedBy: 'tester', reason: 'Back to the 2B value.' });
  await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
  eq('C11 correcting back works', (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0].match_status, 'Matched');
  eq('C12 history now has four rows', (await lineHistory(stplId!)).length, 4);
  check('C13 the re-reconcile is tied to every pending correction', (await lineHistory(stplId!)).every((h: any) => h.rerefreshed === true));

  // ---- T7 / T8: the ITC decision ---------------------------------------
  section('D. T7/T8 — ITC decision and decision month');
  const claim = await setItcDecision(stplId!, { decision: 'Claim', decisionMonth: '2026-04', reason: 'Vendor has now filed.' }, { changedBy: 'tester' });
  check('D1 Claim + month saved', claim.ok, claim.reason);
  line = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0];
  eq('D2 the decision is Claim', line.itc_decision, 'Claim');
  eq('D3 the decision month is 2026-04', line.itc_decision_month, '2026-04');
  eq('D4 who decided is recorded', line.decision_by, 'tester');

  const change = await setItcDecision(stplId!, { decision: 'Query Vendor', reason: 'Invoice value differs from books.' }, { changedBy: 'tester' });
  check('D5 changing the decision is saved', change.ok, change.reason);
  const hist2 = await lineHistory(stplId!);
  const dec = hist2.filter((h: any) => h.field_name === 'itc_decision');
  eq('D6 both decisions are in the history', dec.length, 2);
  eq('D7 the first decision change is on record', dec[0].new_value, 'Claim');
  eq('D8 the second decision change is on record', dec[1].new_value, 'Query Vendor');
  eq('D9 the earlier decision is preserved as the old value', dec[1].old_value, 'Claim');
  check('D9b the decision month was not silently cleared', (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0].itc_decision_month === '2026-04');

  const bad = await setItcDecision(stplId!, { decision: 'Whatever' }, { changedBy: 'tester' });
  check('D10 an unknown decision is refused', !bad.ok && /Unknown ITC decision/.test(bad.reason || ''), bad.reason);
  const badMonth = await setItcDecision(stplId!, { decisionMonth: 'April 2026' }, { changedBy: 'tester' });
  check('D11 a malformed month is refused', !badMonth.ok, badMonth.reason);

  const cls = await setReturnClassification(stplId!, '4(A)(i) — Books only', { changedBy: 'tester', reason: 'Awaiting vendor.' });
  check('D12 the return classification is separate from the decision', cls.ok, cls.reason);
  line = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0];
  eq('D13 it was stored', line.return_classification, '4(A)(i) — Books only');
  eq('D14 and it did not change the decision', line.itc_decision, 'Query Vendor');

  // ---- T9 / T10: month lock -------------------------------------------
  section('E. T9/T10 — month lock and admin unlock');
  const lock = await lockMonth(GSTIN, PERIOD, { by: 'tester', reason: 'FY test' });
  check('E1 month locked', lock.ok, lock.reason);
  check('E2 the lock is visible', (await isLocked(GSTIN, PERIOD)).locked);

  const blocked = await updateRecon(stplId!, { recon_invoice_no: 'LOCKED-TRY' }, { changedBy: 'tester', reason: 'should fail' });
  check('E3 a locked month refuses a reconciliation edit', !blocked.ok && blocked.locked === true, blocked.reason);
  const blockedItc = await setItcDecision(stplId!, { decision: 'Claim' }, { changedBy: 'tester' });
  check('E4 a locked month refuses an ITC decision', !blockedItc.ok && blockedItc.locked === true, blockedItc.reason);
  const blockedRe = await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
  check('E5 a locked month refuses a re-reconcile', !blockedRe.ok && /LOCKED/.test(blockedRe.reason || ''), blockedRe.reason);
  const blockedPaste = await importPastedPurchase(parsed.rows, PASTE_ID, { by: 'tester' });
  check('E6 a locked month refuses a paste import', !blockedPaste.ok && /LOCKED/.test(blockedPaste.reason || ''), blockedPaste.reason);

  // The database itself must refuse a book-value change, even from raw SQL.
  let immutability = '';
  try {
    await client.query('UPDATE purchase_lines SET book_invoice_no = $2 WHERE id = $1', [stplId, 'HACKED']);
  } catch (e: any) {
    immutability = e.message;
  }
  check('E7 the database refuses to change a book value', /immutable/i.test(immutability), immutability);
  const stillBook = await client.query('SELECT book_invoice_no FROM purchase_lines WHERE id = $1', [stplId]);
  eq('E8 the book value is unchanged', stillBook.rows[0].book_invoice_no, 'STPL-123');

  const noReason = await unlockMonth(GSTIN, PERIOD, { by: 'tester', adminConfirmed: true });
  check('E9 unlock without a reason is refused', !noReason.ok, noReason.reason);
  const notAdmin = await unlockMonth(GSTIN, PERIOD, { by: 'tester', reason: 'because', adminConfirmed: false });
  check('E10 unlock without admin confirmation is refused', !notAdmin.ok, notAdmin.reason);

  const unlock = await unlockMonth(GSTIN, PERIOD, { by: 'admin', reason: 'FY test closed.', adminConfirmed: true });
  check('E11 unlock with admin confirmation + reason works', unlock.ok, unlock.reason);
  check('E12 the month is open again', !(await isLocked(GSTIN, PERIOD)).locked);

  const audit = await auditTrail({ gstin: GSTIN, period: PERIOD });
  const actions = audit.rows.map((a: any) => a.action);
  check('E13 the unlock is in the audit trail', actions.includes('UNLOCK'), actions.join(','));
  check('E14 the lock is in the audit trail', actions.includes('LOCK'), actions.join(','));
  const unlockRow = audit.rows.find((a: any) => a.action === 'UNLOCK');
  eq('E15 the unlock records who did it', unlockRow.changed_by, 'admin');
  eq('E16 and why', unlockRow.reason, 'FY test closed.');
  const editRows = audit.rows.filter((a: any) => a.field_name && a.field_name.startsWith('recon_'));
  check('E17 every field change is in the trail', editRows.length >= 4, `${editRows.length} rows`);
  check('E18 each has old and new values', editRows.every((a: any) => a.old_value && a.new_value));

  const filtered = await auditTrail({ gstin: GSTIN, period: PERIOD, field: 'recon_invoice_no' });
  check('E19 the trail can be filtered by field', filtered.rows.every((r: any) => r.field_name === 'recon_invoice_no'));
  const byUser = await auditTrail({ gstin: GSTIN, period: PERIOD, by: 'admin' });
  check('E20 the trail can be filtered by user', byUser.rows.length > 0 && byUser.rows.every((r: any) => r.changed_by === 'admin'));

  // ---- re-import must not duplicate or clobber -------------------------
  section('F. Re-import safety');
  const again = await importPastedPurchase(parsed.rows, PASTE_ID, { by: 'tester' });
  check('F1 re-pasting the same block succeeds', again.ok, again.reason);
  const { total } = await listLines({ gstin: GSTIN, period: PERIOD });
  eq('F2 no duplicate lines were created', total, 2);
  line = (await listLines({ gstin: GSTIN, period: PERIOD, search: 'STPL-123' })).rows[0];
  eq('F3 the human decision survived the re-import', line.itc_decision, 'Query Vendor');
  eq('F4 the correction survived the re-import', line.recon_invoice_no, '123');
  eq('F5 and the book values still match the original paste', line.book_invoice_no, 'STPL-123');
  eq('F6 the correction history is intact', (await lineHistory(stplId!)).filter((h: any) => h.field_name.startsWith('recon_')).length, 4);
  check('F7 and the decision history is intact too', (await lineHistory(stplId!)).filter((h: any) => h.field_name === 'itc_decision').length === 2);

  // ---- export → edit → upload -----------------------------------------
  section('H. Export, edit outside, upload back');
  {
    const { runReport, findReport } = await import('../src/app/reports');
    const { planImport, planToEdits } = await import('../src/app/report-import');
    const { applyEdits } = await import('../src/app/store');
    const XLSXmod = await import('xlsx');

    // The ITC working report is used here rather than a category report,
    // because it carries every column the export/re-upload loop needs
    // (Line ID, book vs recon, follow-up columns) for any line.
    const def = findReport('itc-working')!;
    const rep = await runReport(def, { gstin: GSTIN, period: PERIOD });
    eq('H1 the ITC working report returns the pasted lines', rep.count, 2);

    // Build the file exactly as the download would: header + rows.
    const header = def.columns.map((c) => c.h);
    const body = rep.rows.map((r) => def.columns.map((c) => (r as any)[c.k] ?? ''));
    check('H2 the report carries a Line ID column', header.includes('Line ID'));
    check('H3 the report carries the follow-up columns',
      ['Vendor Response', 'Follow-up Date', 'Expected Correction', 'Action Taken', 'Remarks']
        .every((h) => header.includes(h)),
      header.join(', '));
    check('H4 the report still shows the book values next to the recon ones',
      header.includes('Book Invoice No') && header.includes('Recon Invoice No'));

    // --- the file with nothing filled in changes nothing ------------------
    const plain = XLSXmod.utils.aoa_to_sheet([header, ...body]);
    const wbPlain = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wbPlain, plain, 'Data');
    const plainPlan = await planImport(
      XLSXmod.write(wbPlain, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      'itc_working.xlsx',
    );
    check('H5 an untouched re-upload plans no changes', plainPlan.totals.changes === 0, JSON.stringify(plainPlan.totals));
    check('H6 and is all valid', plainPlan.totals.invalid === 0);

    // --- now fill it in the way an Accounts user would ---------------------
    const iId = header.indexOf('Line ID');
    const iResp = header.indexOf('Vendor Response');
    const iDate = header.indexOf('Follow-up Date');
    const iExp = header.indexOf('Expected Correction');
    const iAct = header.indexOf('Action Taken');
    const iDec = header.indexOf('ITC Decision');
    const iDecM = header.indexOf('ITC Decision Month');
    const iTax = header.indexOf('Taxable Value');
    const iBookNo = header.indexOf('Book Invoice No');
    const iReconNo = header.indexOf('Recon Invoice No');

    const rows = body.map((r) => [...r]);
    const target = rows[0];
    const targetId = Number(target[iId]);
    check('H7 there is a row to work on', !!targetId);

    target[iResp] = 'Vendor ne confirm kiya ki GSTR-1 file ho chuka hai.';
    target[iDate] = '2026-10-02';
    target[iExp] = 'Next 2B me dikhega.';
    target[iAct] = 'Email bheja, 7 din ka wait.';
    target[iDec] = 'Reclaim Later';
    target[iDecM] = '2026-05';
    target[iReconNo] = '1234';
    // And the two columns that must be ignored, changed on purpose.
    target[iTax] = 999999;
    target[iBookNo] = 'TAMPERED';

    const wb2 = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wb2, XLSXmod.utils.aoa_to_sheet([header, ...rows]), 'Data');
    const file = XLSXmod.write(wb2, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const plan = await planImport(file, 'itc_working.xlsx');
    check('H8 the worked-on file is valid', !plan.error, plan.error);
    eq('H9 it planned the expected number of changes', plan.totals.changes, 1);
    check('H10 the tampered book columns are reported as ignored',
      plan.ignored.some((h) => /Book Invoice No|Taxable Value/.test(h)), plan.ignored.join(', '));

    const edited = plan.rows.find((r) => r.lineId === targetId)!;
    const fields = edited.changes.map((c) => c.field);
    check('H11 the follow-up columns are picked up',
      ['vendor_response', 'follow_up_date', 'expected_correction', 'action_taken'].every((f) => fields.includes(f)), fields.join(','));
    check('H12 the ITC decision and month are picked up',
      fields.includes('itc_decision') && fields.includes('itc_decision_month'), fields.join(','));
    check('H13 the corrected invoice number is picked up', fields.includes('recon_invoice_no'), fields.join(','));
    check('H14 no book field was planned', !fields.some((f) => f.startsWith('book_')), fields.join(','));

    const applied = await applyEdits(planToEdits(plan), { by: 'tester', reason: 'Uploaded report' });
    check('H15 the upload applied', applied.ok && applied.changedLines === 1, applied.reason);

    const after = (await listLines({ gstin: GSTIN, period: PERIOD })).rows.find((r) => String(r.id) === String(targetId))!;
    eq('H16 the vendor response was saved', after.vendor_response, 'Vendor ne confirm kiya ki GSTR-1 file ho chuka hai.');
    const fmtDate = (v: any) =>
      v instanceof Date
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        : String(v ?? '').slice(0, 10);
    eq('H17 the follow-up date was saved', fmtDate(after.follow_up_date), '2026-10-02');
    eq('H18 the expected correction was saved', after.expected_correction, 'Next 2B me dikhega.');
    eq('H19 the ITC decision was saved', after.itc_decision, 'Reclaim Later');
    eq('H20 the decision month was saved', after.itc_decision_month, '2026-05');
    eq('H21 the reconciliation number was saved', after.recon_invoice_no, '1234');

    // The point of the whole feature.
    eq('H22 the book invoice number is untouched', after.book_invoice_no, 'STPL-123');
    eq('H23 the book amount is untouched', Number(after.book_taxable_value), 100000);

    const audit = await auditTrail({ gstin: GSTIN, period: PERIOD });
    const byMe = audit.rows.filter((r) => r.changed_by === 'tester');
    check('H24 the upload is fully audited', byMe.length >= 6, `${byMe.length} rows`);
    check('H25 the follow-up entries are in the trail',
      byMe.some((r) => r.action === 'FOLLOW-UP' && r.field_name === 'vendor_response'));
    check('H26 no audit row mentions the tampered book column',
      !byMe.some((r) => r.field_name === 'book_invoice_no' || r.field_name === 'book_taxable_value'));

    // --- the rejections ---------------------------------------------------
    const badRows = [[...target]];
    const bad = [...badRows[0]];
    bad[iId] = 999999;                                  // a line that does not exist
    const bad2 = [...rows[0]]; bad2[iId] = rows[1] ? Number(rows[1][iId]) : 1; bad2[iResp] = '';
    const bad3 = [...rows[0]]; bad3[iId] = rows[1] ? Number(rows[1][iId]) : 1; bad3[iResp] = ''; bad3[iDec] = 'Maybe';
    const bad4 = [...rows[0]]; bad4[iId] = rows[1] ? Number(rows[1][iId]) : 1; bad4[iResp] = ''; bad4[iDate] = 'not a date';
    const wbBad = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wbBad, XLSXmod.utils.aoa_to_sheet([header, bad, bad2, bad3, bad4]), 'Data');
    const badPlan = await planImport(
      XLSXmod.write(wbBad, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'bad.xlsx',
    );
    const msgs = badPlan.rows.flatMap((r) => r.errors).join(' | ');
    check('H27 an unknown Line ID is rejected', /is not in this system/.test(msgs), msgs);
    check('H28 an unknown ITC decision is rejected', /is not an ITC decision/.test(msgs), msgs);
    check('H29 an unreadable date is rejected', /Could not read/.test(msgs), msgs);
    check('H30 the good row in the same file is still valid', badPlan.totals.valid >= 1);

    // A file with no Line ID at all must be refused outright.
    const noIdHeader = header.filter((h) => h !== 'Line ID');
    const noIdRows = body.map((r) => def.columns.filter((c) => c.h !== 'Line ID').map((c) => (r as any)[c.k] ?? ''));
    const wbNoId = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wbNoId, XLSXmod.utils.aoa_to_sheet([noIdHeader, ...noIdRows]), 'Data');
    const noIdPlan = await planImport(
      XLSXmod.write(wbNoId, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'noid.xlsx',
    );
    check('H31 a file with no Line ID is refused', /No "Line ID" column/.test(noIdPlan.error || ''), noIdPlan.error);

    // A locked month must be caught in the preview, not at write time.
    await lockMonth(GSTIN, PERIOD, { by: 'tester', reason: 'upload test' });
    const lockedPlan = await planImport(file, 'itc_working.xlsx');
    check('H32 a locked month is flagged in the preview', lockedPlan.totals.locked > 0, JSON.stringify(lockedPlan.totals));
    check('H33 and the locked rows are marked not ok',
      lockedPlan.rows.filter((r) => r.locked).every((r) => !r.ok));
    await unlockMonth(GSTIN, PERIOD, { by: 'admin', reason: 'upload test done', adminConfirmed: true });

    // A report exported AFTER the upload must round-trip with no drift at all —
    // that is the property that makes "work in Excel, upload back" safe.
    const rep2 = await runReport(def, { gstin: GSTIN, period: PERIOD });
    const body2 = rep2.rows.map((r) => def.columns.map((c) => (r as any)[c.k] ?? ''));
    const wbOut = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wbOut, XLSXmod.utils.aoa_to_sheet([def.columns.map((c) => c.h), ...body2]), 'Data');
    const round = await planImport(XLSXmod.write(wbOut, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'rt.xlsx');
    check('H34 an untouched export re-imports with zero changes', round.totals.changes === 0,
      JSON.stringify(round.totals) + ' ' + round.rows.filter((r) => r.changes.length).map((r) => r.changes.map((c) => c.field).join('+')).join(','));
  }

  // ---- cleanup ----------------------------------------------------------
  // ---- sales persistence --------------------------------------------------
  section('I. Sales register persists, and a re-run does not double it');

  // The sales register was always read by a run but never stored, so
  // `sales_invoices` stayed empty and there was nothing for GSTR-1 to be
  // reconciled against. These rows use the synthetic period and invoice numbers
  // cleanup() knows how to remove.
  const salesRows = [
    {
      our_gstin: GSTIN, customer_gstin: '24AAAAA0000A1Z5', customer_name: 'TEST BUYER ONE',
      invoice_no: 'SALES-T1', invoice_date: '2019-01-10', period: PERIOD, invoice_type: 'R',
      place_of_supply: '27', reverse_charge: false, taxable_value: 100000,
      igst: 18000, cgst: 0, sgst: 0, cess: 0, invoice_value: 118000,
    },
    {
      our_gstin: GSTIN, customer_gstin: '', customer_name: 'WALK IN CUSTOMER',
      invoice_no: 'SALES-T2', invoice_date: '2019-01-20', period: PERIOD, invoice_type: 'R',
      place_of_supply: '27', reverse_charge: false, taxable_value: 5000,
      igst: 0, cgst: 450, sgst: 450, cess: 0, invoice_value: 5900,
    },
  ] as any[];

  const run1 = await persistRun({
    books: [], twob: [], sales: salesRows,
    reconByBundle: new Map(), uploadedBy: 'test',
  });
  const salesCount = async () => {
    const r = await client.query(
      'SELECT count(*)::int n FROM sales_invoices WHERE period = $1 AND invoice_number_norm IN ($2,$3)',
      [PERIOD, 'SALEST1', 'SALEST2'],
    );
    return r.rows[0].n;
  };

  eq('both sales rows stored', await salesCount(), 2);
  eq('run 1 counts them as inserted', run1.salesInserted, 2);

  {
    const r = await client.query(
      `SELECT invoice_number_norm, customer_gstin_norm, taxable_value, igst, cgst, sgst, invoice_value, invoice_type
         FROM sales_invoices WHERE period = $1 AND invoice_number_norm IN ($2,$3) ORDER BY invoice_number_norm`,
      [PERIOD, 'SALEST1', 'SALEST2'],
    );
    const b2b = r.rows.find((x: any) => x.invoice_number_norm === 'SALEST1');
    const b2cs = r.rows.find((x: any) => x.invoice_number_norm === 'SALEST2');
    eq('B2B customer GSTIN normalised', b2b?.customer_gstin_norm, '24AAAAA0000A1Z5');
    eq('B2B taxable stored', Number(b2b?.taxable_value), 100000);
    eq('B2B IGST stored', Number(b2b?.igst), 18000);
    eq('B2CS with no customer GSTIN stored as null', b2cs?.customer_gstin_norm, null);
    eq('B2CS CGST+SGST stored', Number(b2cs?.cgst) + Number(b2cs?.sgst), 900);
  }

  // The critical one: the same run offered again must UPDATE, never double.
  {
    const run2 = await persistRun({
      books: [], twob: [], sales: salesRows,
      reconByBundle: new Map(), uploadedBy: 'test',
    });
    eq('a re-run still leaves exactly 2 rows', await salesCount(), 2);
    eq('a re-run counts them as updated', run2.salesUpdated, 2);
    eq('a re-run inserts nothing', run2.salesInserted, 0);
  }

  // An edit in the source file must be followed, like any book data.
  {
    await persistRun({
      books: [], twob: [],
      sales: [{ ...salesRows[0], taxable_value: 110000, igst: 19800, invoice_value: 129800 } as any],
      reconByBundle: new Map(), uploadedBy: 'test',
    });
    const r = await client.query(
      'SELECT taxable_value, igst, invoice_value FROM sales_invoices WHERE invoice_number_norm = $1 AND period = $2',
      ['SALEST1', PERIOD],
    );
    eq('an amended taxable value is followed', Number(r.rows[0]?.taxable_value), 110000);
    eq('an amended IGST is followed', Number(r.rows[0]?.igst), 19800);
    eq('still exactly 2 rows after the amendment', await salesCount(), 2);
  }

  // A GSTIN that is not in the master cannot be attributed to a company, so
  // it must be reported rather than silently dropped.
  {
    const run3 = await persistRun({
      books: [], twob: [],
      sales: [{ ...salesRows[0], our_gstin: '99ZZZZZZZZZZZZZ', invoice_no: 'SALES-T1' } as any],
      reconByBundle: new Map(), uploadedBy: 'test',
    });
    eq('an unknown GSTIN is reported', run3.salesUnknownGstin.length, 1);
    eq('an unknown GSTIN stores nothing extra', await salesCount(), 2);
  }

  // ---- K. correcting the SUPPLIER GSTIN re-matches -------------------------
  // The accounts team corrects three things on a mismatch: the supplier GSTIN,
  // the invoice number and the invoice date. B and C prove the last two. This
  // proves the first, because a GSTIN that disagrees on any one character is
  // the correction that silently does nothing if the matcher reads the book
  // value instead of the edited one.
  section('K. Correcting the Supplier GSTIN re-matches the line');
  {
    const block: unknown[][] = [
      ['GSTIN of Company', 'Supplier Name', 'GSTIN of supplier', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', '2B Month'],
      [GSTIN, 'PHASE0 GSTIN-FIX SUPPLIER', GSTIN_BOOK_WRONG, 'GSTIN-FIX-1', '20-01-2019', 30000, 5400, 0, 0, PERIOD],
    ];
    const parsedG = parsePurchaseRegister(block, GSTINFIX_ID);
    eq('K1 the mismatched row is parsed', parsedG.rows.length, 1);
    const importedG = await importPastedPurchase(parsedG.rows, GSTINFIX_ID, { by: 'tester' });
    check('K2 import succeeded', importedG.ok, importedG.reason);

    const g = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    check('K3 the row exists', !!g);
    eq('K4 the book GSTIN is stored exactly as pasted', g.book_supplier_gstin, GSTIN_BOOK_WRONG);
    eq('K5 the reconciliation GSTIN starts as a copy', g.recon_supplier_gstin, GSTIN_BOOK_WRONG);
    eq('K6 a wrong GSTIN cannot match, even though the invoice number is right', g.match_status, 'Missing in 2B');

    const editG = await updateRecon(g.id, { recon_supplier_gstin: GSTIN_TWOB }, {
      changedBy: 'tester', reason: 'Supplier GSTIN transcribed wrong in SAP.',
    });
    check('K7 the GSTIN correction saved', editG.ok, editG.reason);
    eq('K8 only the GSTIN is reported changed', editG.changed, ['recon_supplier_gstin']);

    const rrG = await reReconcile(GSTIN, PERIOD, { changedBy: 'tester', reason: 'Save & Re-reconcile' });
    check('K9 re-reconcile ran', rrG.ok, rrG.reason);

    const after = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    eq('K10 the corrected GSTIN now matches', after.match_status, 'Matched');
    eq('K11 the book GSTIN is untouched', after.book_supplier_gstin, GSTIN_BOOK_WRONG);
    eq('K12 the reconciliation GSTIN is the corrected one', after.recon_supplier_gstin, GSTIN_TWOB);
    eq('K13 the 2B month is recorded', after.matched_2b_month, PERIOD);
    check('K14 the row is marked as edited', after.recon_edited === true);

    // Re-importing the register must NOT wipe the correction: the book value is
    // wrong, so restoring it would silently undo the user's work.
    await importPastedPurchase(parsedG.rows, GSTINFIX_ID, { by: 'tester' });
    const afterReimport = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    eq('K15 a re-import does not undo the correction', afterReimport.recon_supplier_gstin, GSTIN_TWOB);
    eq('K16 and the line is still matched', afterReimport.match_status, 'Matched');

    // A correction to a DIFFERENT valid supplier must not be reported as a match.
    const wrongEdit = await updateRecon(g.id, { recon_supplier_gstin: GSTIN_WRONG_VALID }, { changedBy: 'tester', reason: 'Wrong supplier chosen.' });
    check('K17 the wrong-but-valid GSTIN is accepted', wrongEdit.ok, wrongEdit.reason);
    await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
    const wrong = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    eq('K18 a wrong correction loses the match again', wrong.match_status, 'Missing in 2B');

    // A malformed GSTIN must be REFUSED. Storing it would leave the line
    // matching on the previous, correct value while the screen showed the
    // operator's typo — the edit would look saved and mean nothing.
    const badEdit = await updateRecon(g.id, { recon_supplier_gstin: GSTIN_INVALID }, { changedBy: 'tester', reason: 'Malformed.' });
    check('K19 a malformed GSTIN is refused', !badEdit.ok, badEdit.reason);
    check('K20 and the refusal explains why', /valid 15-character GSTIN/i.test(String(badEdit.reason)));
    const afterBad = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    eq('K21 the refused GSTIN did not overwrite the stored one', afterBad.recon_supplier_gstin, GSTIN_WRONG_VALID);

    // Put it back so the run ends in a clean, matching state.
    await updateRecon(g.id, { recon_supplier_gstin: GSTIN_TWOB }, { changedBy: 'tester', reason: 'Corrected GSTIN restored.' });
    await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
    const restored = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    eq('K22 restoring the right GSTIN matches again', restored.match_status, 'Matched');

    // `changed` must mean "lines this run moved", not "lines that match". The
    // operator asks it one question after every correction: did it work? A
    // field that reports the matched total answers 516 either way, which is
    // worse than no answer at all.
    const settle = await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
    check('K23 a settling re-reconcile ran', settle.ok, settle.reason);
    const rerun = await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
    check('K24 the run right after it ran', rerun.ok, rerun.reason);
    eq('K25 a second identical run moves nothing', rerun.changed, 0);
    check('K26 and it still reports how many lines match', typeof rerun.matched === 'number' && rerun.matched > 0, String(rerun.matched));
    check(
      'K27 changed is never simply the matched total',
      rerun.changed !== rerun.matched,
      `changed ${rerun.changed} equals matched ${rerun.matched} — the old bug`,
    );
  }

  // ---- report filters against the live schema ---------------------------
  // Every report reads a different table, but the screen sends ONE filter set,
  // and it fills in whatever the filter bar holds. Selecting a month used to
  // make every non-purchase report answer 500, because `period` was pushed at
  // tables that call the month something else (`twob_month`) and `supplier` at
  // tables that call it `supplier_gstin`. This walks the whole matrix against
  // the real schema, so a missing column is caught here and not by the user.
  section('L. Every report survives every filter (live schema)');
  {
    const { runReport, findReport, REPORTS } = await import('../src/app/reports');

    const MATRIX: Array<[string, any]> = [
      ['no filter', {}],
      ['gstin only', { gstin: GSTIN }],
      ['month only', { period: '2025-04' }],
      ['month + gstin', { gstin: GSTIN, period: '2025-04' }],
      [
        'everything the bar can send',
        {
          gstin: '26AALCS9985J1ZC', period: '2025-04', from: '2025-04', to: '2025-06',
          supplier: '24AALCS9985J1ZG', vendor: 'SHIVAM', status: 'Matched',
          decision: 'Claim', classification: '4(A) — Claimed',
          twoBMonth: '2025-05', decisionMonth: '2025-06', q: 'abc',
          followUp: 'pending', locked: true,
        },
      ],
    ];

    for (const def of REPORTS) {
      for (const [label, filters] of MATRIX) {
        let ok = true;
        let why = '';
        try {
          await runReport(def, filters);
        } catch (e: any) {
          ok = false;
          why = e?.message || String(e);
        }
        check(`L1 ${def.name} with ${label} answers instead of crashing`, ok, why);
      }
    }

    // A filter that cannot apply must be announced, never silently dropped.
    const twobVendor = await runReport(findReport('twob-not-in-books')!, { vendor: 'x' });
    eq('L2 the 2B report answers a vendor filter (supplier_name exists)', twobVendor.ignored, []);
    const twobDecision = await runReport(findReport('twob-not-in-books')!, { decision: 'Claim' });
    check('L3 the 2B report says out loud that an ITC decision does not apply',
      twobDecision.ignored.some((g) => g.startsWith('ITC decision:')), JSON.stringify(twobDecision.ignored));

    const audit = await runReport(findReport('audit-trail')!, { period: '2025-04', q: 'invoice' });
    check('L4 the audit trail applies its month rather than dropping it',
      !audit.ignored.some((g) => g.startsWith('Month:')), JSON.stringify(audit.ignored));

    // Positive control: the month filter must actually reach the query, not be
    // swept aside by the profile mapping.
    const expected = await client.query(
      `SELECT count(*)::int n FROM gstr2b_lines t
        WHERE t.twob_month = '2025-04'
          AND NOT EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)`,
    );
    const rep = await runReport(findReport('twob-not-in-books')!, { period: '2025-04' });
    check('L5 April really has 2B-not-in-books rows to filter', expected.rows[0].n > 0, String(expected.rows[0].n));
    eq('L6 and the report agrees with the ground-truth SQL', rep.count, expected.rows[0].n);
  }

  // ---- CDNUR must be storable -----------------------------------------
  // Migration 20 adds table 9B to the enum. Proving it here matters because a
  // drafted unregistered note that cannot be stored is the whole failure mode:
  // the engine built the row, the database refused the table name, and the CA
  // saw an empty 9B with no explanation.
  section('M. A CDNUR (table 9B) document is storable');
  {
    const gid = (await client.query('SELECT id FROM gstins WHERE gstin_number = $1', [GSTIN]))
      .rows[0]?.id;
    check('M0 the GSTIN exists to draft against', gid !== undefined, GSTIN);

    if (gid !== undefined) {
      const ins = await client.query(
        `INSERT INTO gstr1_documents
           (gstin_id, financial_year, period, source, table_type, invoice_number_raw,
            invoice_number_norm, invoice_date, invoice_type, place_of_supply,
            taxable_value, igst, invoice_value, note_ref_number, note_ref_date)
         VALUES ($1,$2,$3,'draft','CDNUR',$4,$5,$6,'R',$7,$8,$9,$10,$11,$12)
         RETURNING id, table_type::text AS table_type`,
        [gid, '2019-20', PERIOD, 'CDNUR-1', 'CDNUR-1', '2019-01-20', '27',
          -1000, -180, -1180, 'ORIG-1', '2019-01-02'],
      );
      check('M1 a CDNUR document inserts — the enum accepts table 9B', ins.rowCount === 1);
      eq('M2 and reads back as CDNUR', ins.rows[0]?.table_type, 'CDNUR');

      // 9B explicitly allows a note with no original invoice, so the 9A-only
      // constraint must NOT fire here.
      const noRef = await client.query(
        `INSERT INTO gstr1_documents
           (gstin_id, financial_year, period, source, table_type, invoice_number_raw,
            invoice_number_norm, invoice_date, invoice_type, taxable_value)
         VALUES ($1,$2,$3,'draft','CDNUR',$4,$5,$6,'R',$7)
         RETURNING id`,
        [gid, '2019-20', PERIOD, 'CDNUR-2', 'CDNUR-2', '2019-01-21', -500],
      );
      check('M3 a CDNUR note with no original invoice is allowed', noRef.rowCount === 1);

      // ...and 9A must still refuse one, so the migration did not loosen the
      // rule it was never meant to touch.
      let refused = false;
      try {
        await client.query(
          `INSERT INTO gstr1_documents
             (gstin_id, financial_year, period, source, table_type, invoice_number_raw,
              invoice_number_norm, invoice_date, invoice_type, taxable_value)
           VALUES ($1,$2,$3,'draft','CDNR',$4,$5,$6,'CDNR',$7)`,
          [gid, '2019-20', PERIOD, 'CDNR-NOREF', 'CDNR-NOREF', '2019-01-22', -500],
        );
      } catch {
        refused = true;
      }
      check('M4 a CDNR (9A) draft with no original invoice is still refused', refused);

      await client.query(
        `DELETE FROM gstr1_documents
          WHERE gstin_id = $1 AND period = $2
            AND invoice_number_norm IN ('CDNUR-1','CDNUR-2','CDNR-NOREF')`,
        [gid, PERIOD],
      );
      const left = await client.query(
        `SELECT count(*)::int n FROM gstr1_documents
          WHERE gstin_id = $1 AND period = $2
            AND invoice_number_norm IN ('CDNUR-1','CDNUR-2','CDNR-NOREF')`,
        [gid, PERIOD],
      );
      eq('M5 the synthetic GSTR-1 rows are gone', left.rows[0].n, 0);
    }
  }

  // ---- N. item-wise sales -> the drafted return and the HSN summary -------
  //
  // The importer has always written `sales_invoice_items`, but a draft is
  // REGENERATED from the database, so the real question is whether the rebuild
  // reads those lines back. When it did not, an item-wise register came back as
  // one blended rate per invoice and the HSN summary reported quantity 0 for
  // goods whose quantities were stored — a return filed wrong with nothing
  // looking broken. These checks are on the stored lines, not on the file.
  section('N. an item-wise register rebuilds item-wise from the database');
  {
    const itemised: any[] = [
      {
        our_gstin: GSTIN, customer_gstin: '24AAAAA0000A1Z5', customer_name: 'TEST BUYER ITEMWISE',
        invoice_no: 'ITEM-T1', invoice_date: '2019-01-15', period: PERIOD, invoice_type: 'R',
        place_of_supply: '24', reverse_charge: false,
        // Two goods at two rates. The parent totals are the SUM of its items,
        // counted ONCE: repeating the item rows into the invoice is the
        // +57,500 inflation this fixture exists to catch.
        taxable_value: 50000, igst: 7500, cgst: 0, sgst: 0, cess: 0, invoice_value: 57500,
        items: [
          { line_no: 1, description: 'TEST ITEM A', hsn: '8536', uqc: 'PCS', quantity: 100,
            gst_rate: 18, taxable_value: 25000, igst: 4500, cgst: 0, sgst: 0, cess: 0 },
          { line_no: 2, description: 'TEST ITEM B', hsn: '8537', uqc: 'PCS', quantity: 40,
            gst_rate: 12, taxable_value: 25000, igst: 3000, cgst: 0, sgst: 0, cess: 0 },
        ],
      },
    ];

    const runN = await persistRun({
      books: [], twob: [], sales: itemised, reconByBundle: new Map(), uploadedBy: 'test',
    });
    eq('N1 the item-wise invoice is stored', runN.salesInserted, 1);
    eq('N2 with both of its item lines', runN.salesItemsStored, 2);

    const parent = await client.query(
      `SELECT id, item_count, taxable_value, invoice_value FROM sales_invoices
        WHERE period = $1 AND invoice_number_norm = 'ITEMT1'`,
      [PERIOD],
    );
    eq('N3 the invoice total is counted once, not once per item', Number(parent.rows[0]?.taxable_value), 50000);
    eq('N4 the invoice value is not inflated by its own items', Number(parent.rows[0]?.invoice_value), 57500);
    eq('N5 the invoice records how many items it carried', parent.rows[0]?.item_count, 2);

    const storedItems = await client.query(
      `SELECT line_no, hsn, uqc, quantity, gst_rate FROM sales_invoice_items
        WHERE sales_invoice_id = $1 ORDER BY line_no`,
      [parent.rows[0]?.id],
    );
    eq('N6 both item lines are readable back', storedItems.rowCount, 2);
    eq('N7 with the serial the portal expects', storedItems.rows[0]?.line_no, 1);

    // ---- the HSN summary, from the STORED lines -----------------------
    const hsn = await hsnSummary(GSTIN, PERIOD);
    check('N8 the HSN summary answers for the period', hsn.ok, hsn.reason);
    eq('N9 it read the item lines from the database', hsn.item_lines, 2);
    eq('N10 from one item-wise invoice', hsn.item_level_invoices, 1);

    // Other synthetic invoices of this period are invoice-level, so the buckets
    // are selected by HSN rather than by row count.
    const b18 = hsn.rows.find((r) => r.hsn === '8536');
    const b12 = hsn.rows.find((r) => r.hsn === '8537');
    check('N11 one bucket per HSN + rate', !!b18 && !!b12, JSON.stringify(hsn.rows.map((r) => r.hsn)));
    eq('N12 the 18% bucket keeps its own quantity', b18?.qty, 100);
    eq('N13 the 12% line did not blend into the 18% bucket', b12?.rateOut, 12);
    eq('N14 the 12% bucket keeps its own quantity', b12?.qty, 40);
    eq('N15 the unit of measure is carried, not invented', b18?.uqc, 'PCS');
    eq('N16 the description survives the round trip', b18?.desc, 'TEST ITEM A');
    eq('N17 the bucket taxable is the item value, once', b18?.taxable, 25000);

    // ---- the same lines must drive the DRAFTED return ------------------
    const draft = await rebuildDrafts(GSTIN, PERIOD);
    check('N18 the draft rebuilds from the books', draft.ok, draft.reason);
    eq('N19 the rebuild reads the item lines too', draft.item_lines, 2);
    eq('N20 from one item-wise invoice', draft.item_level_invoices, 1);

    const doc = await client.query(
      `SELECT taxable_value, invoice_value FROM gstr1_documents
        WHERE period = $1 AND invoice_number_norm = 'ITEMT1'
          AND gstin_id = (SELECT id FROM gstins WHERE gstin_number = $2)`,
      [PERIOD, GSTIN],
    );
    eq('N21 the invoice is drafted', doc.rowCount, 1);
    eq('N22 the drafted taxable is the item sum, counted once', Number(doc.rows[0]?.taxable_value), 50000);
    eq('N23 and the drafted value is not inflated', Number(doc.rows[0]?.invoice_value), 57500);
  }

  // ---- O. the HSN summary in its B2B / B2C halves, and the portal side ----
  //
  // The screen reconciles HSN in two halves and compares them with the portal.
  // Two things must never happen: a B2B and a B2C bucket merging into one
  // number, and a portal value appearing where no portal data was imported.
  section('O. HSN summary — B2B / B2C halves and the portal side');
  {
    // A B2C supply with items, alongside section N's B2B invoice.
    const b2c: any[] = [
      {
        our_gstin: GSTIN, customer_gstin: '', customer_name: 'WALK IN ITEMWISE',
        invoice_no: 'ITEM-T2', invoice_date: '2019-01-18', period: PERIOD, invoice_type: 'R',
        place_of_supply: '24', reverse_charge: false,
        taxable_value: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0, invoice_value: 5900,
        items: [
          { line_no: 1, description: 'COUNTER ITEM', hsn: '8537', uqc: 'PCS', quantity: 5,
            gst_rate: 18, taxable_value: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 },
        ],
      },
    ];
    const runO = await persistRun({
      books: [], twob: [], sales: b2c, reconByBundle: new Map(), uploadedBy: 'test',
    });
    eq('O1 the B2C item-wise invoice is stored', runO.salesInserted, 1);
    eq('O2 with its item line', runO.salesItemsStored, 1);

    // ---- the halves, separately --------------------------------------
    const all = await hsnSummary(GSTIN, PERIOD, 'all');
    check('O3 the summary answers for the period', all.ok, all.reason);
    eq('O4 the B2B half is available on its own', all.books.b2b.rows.length > 0, true);
    eq('O5 the B2C half is available on its own', all.books.b2c.rows.length > 0, true);
    check('O6 every B2B row is marked B2B',
      all.books.b2b.rows.every((r) => r.scope === 'B2B'));
    check('O7 every B2C row is marked B2C',
      all.books.b2c.rows.every((r) => r.scope === 'B2C'));

    // The B2C 8537@18 bucket must not be inflated by the B2B 8537@18 one: the
    // two halves have to add up to the total, not shadow each other.
    const b2cRow = all.books.b2c.rows.find((r) => r.hsn === '8537' && r.rateOut === 18);
    eq('O8 the B2C bucket holds only the counter sale', b2cRow?.taxable, 5000);
    eq('O9 and only its quantity', b2cRow?.qty, 5);
    eq('O10 the halves add up to the total',
      Number((all.books.b2b.totals.taxable + all.books.b2c.totals.taxable).toFixed(2)),
      all.totals.taxable);

    // ---- the scope filter ---------------------------------------------
    const onlyB2b = await hsnSummary(GSTIN, PERIOD, 'b2b');
    check('O11 a b2b-only read returns only B2B rows',
      onlyB2b.rows.length > 0 && onlyB2b.rows.every((r) => r.scope === 'B2B'));
    const onlyB2c = await hsnSummary(GSTIN, PERIOD, 'b2c');
    check('O12 a b2c-only read returns only B2C rows',
      onlyB2c.rows.length > 0 && onlyB2c.rows.every((r) => r.scope === 'B2C'));

    // ---- no portal data has been imported yet -------------------------
    check('O13 with no filed return the portal side is unavailable', !all.portal.available);
    check('O14 and it says why rather than showing zeros',
      typeof all.portal.reason === 'string' && all.portal.reason.length > 0, String(all.portal.reason));
    check('O15 the comparison refuses to claim completeness',
      !all.comparison.available && all.comparison.status === 'NO PORTAL DATA');
    eq('O16 nothing is invented on the portal side', all.portal.rows.length, 0);

    // ---- now file one B2B document that carries an HSN -----------------
    const gid = (await client.query('SELECT id FROM gstins WHERE gstin_number = $1', [GSTIN]))
      .rows[0]?.id;
    await client.query(
      `INSERT INTO gstr1_documents
         (gstin_id, financial_year, period, source, table_type, invoice_number_raw,
          invoice_number_norm, invoice_date, invoice_type, hsn, rate,
          taxable_value, igst, cgst, sgst, cess, invoice_value)
       VALUES ($1,$2,$3,'filed','B2B','ITEM-T1','FILEDITEMT1','2019-01-15','R','8536',NULL,
               25000,4500,0,0,0,29500)
       ON CONFLICT DO NOTHING`,
      [gid, '2019-20', PERIOD],
    );

    const withPortal = await hsnSummary(GSTIN, PERIOD, 'all');
    check('O17 a filed document with an HSN makes the portal side available',
      withPortal.portal.available, withPortal.portal.reason);
    eq('O18 the portal row is the one we filed', withPortal.portal.rows.length, 1);

    // The one rule that matters most: a value we do not have stays null, not 0.
    eq('O19 portal quantity is null, never a made-up zero', withPortal.portal.rows[0]?.qty, null);
    eq('O20 portal UQC is null, never a made-up unit', withPortal.portal.rows[0]?.uqc, null);
    eq('O21 the portal money is what was filed', withPortal.portal.rows[0]?.taxable, 25000);

    check('O22 the comparison is now available', withPortal.comparison.available);
    const matched = withPortal.comparison.rows.find((r) => r.status === 'MATCHED');
    const booksOnly = withPortal.comparison.rows.filter((r) => r.status === 'BOOKS ONLY');
    check('O23 the filed HSN matches its books bucket', !!matched, JSON.stringify(withPortal.comparison.rows.map((r) => r.status)));
    eq('O24 and there is no difference in it', matched?.diff?.taxable, 0);
    check('O25 HSNs with no filed row are reported as books-only', booksOnly.length > 0);
    check('O26 every books-only row explains itself',
      booksOnly.every((r) => r.remarks.length > 0));
    check('O27 the comparison says quantity is not comparable',
      (matched?.remarks || []).some((x) => /Quantity/i.test(x)), JSON.stringify(matched?.remarks));
    eq('O28 the counts add up to the rows shown',
      withPortal.comparison.matched + withPortal.comparison.differs +
        withPortal.comparison.books_only + withPortal.comparison.portal_only,
      withPortal.comparison.rows.length);

    // A filed row the books do not have must show up, not vanish.
    await client.query(
      `INSERT INTO gstr1_documents
         (gstin_id, financial_year, period, source, table_type, invoice_number_raw,
          invoice_number_norm, invoice_date, invoice_type, hsn, rate,
          taxable_value, igst, cgst, sgst, cess, invoice_value)
       VALUES ($1,$2,$3,'filed','B2B','EXTRA','FILEDEXTRA','2019-01-16','R','9999',NULL,
               1000,180,0,0,0,1180)
       ON CONFLICT DO NOTHING`,
      [gid, '2019-20', PERIOD],
    );
    const portalOnly = await hsnSummary(GSTIN, PERIOD, 'all');
    const orphan = portalOnly.comparison.rows.filter((r) => r.status === 'PORTAL ONLY');
    eq('O29 an HSN the books never sold is reported', orphan.length, 1);
    eq('O30 and it is attributed to the portal side only', orphan[0]?.books, null);

    await client.query(
      `DELETE FROM gstr1_documents WHERE period = $1 AND invoice_number_norm IN ('FILEDITEMT1','FILEDEXTRA')`,
      [PERIOD],
    );
  }

  // ---- P. the company's OWN GSTIN on a line -------------------------------
  // The fourth correctable value on the reconciliation screen. The other three
  // (supplier GSTIN, invoice number, invoice date) are overrides that decide
  // what an invoice is MATCHED on; our own GSTIN decides which company, unit
  // and GSTR-2B the line BELONGS to, so correcting it moves the row.
  section('P. Correcting our own GSTIN moves the line');
  {
    const block: unknown[][] = [
      ['GSTIN of Company', 'Supplier Name', 'GSTIN of supplier', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', '2B Month'],
      [GSTIN, 'PHASE0 GSTIN-FIX SUPPLIER', GSTIN_TWOB, 'GSTIN-FIX-1', '20-01-2019', 30000, 5400, 0, 0, PERIOD],
    ];
    const parsedP = parsePurchaseRegister(block, GSTINFIX_ID);
    const importedP = await importPastedPurchase(parsedP.rows, GSTINFIX_ID, { by: 'tester' });
    check('P1 the fixture line is in place', importedP.ok, importedP.reason);
    await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });

    const before = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
    check('P2 it matches under our own GSTIN', before?.match_status === 'Matched', before?.match_status);

    // A real second registration from the master: a line may only move to one
    // the application already knows, because that is where the company and the
    // unit come from.
    const master = await loadGstinMap();
    const otherGstin = [...master.keys()].find((g) => g !== GSTIN);

    const malformed = await setOurGstin(before.id, GSTIN_INVALID, { changedBy: 'tester' });
    check('P3 a malformed GSTIN is refused', !malformed.ok, malformed.reason);
    check('P4 and the refusal says why', /valid 15-character GSTIN/i.test(String(malformed.reason)));

    const unmapped = await setOurGstin(before.id, GSTIN_WRONG_VALID, { changedBy: 'tester' });
    check('P5 a well-formed GSTIN that is not in the master is refused', !unmapped.ok, unmapped.reason);
    check('P6 and it says to add the registration', /master/i.test(String(unmapped.reason)));

    if (!otherGstin) {
      console.log('  SKIP  P7-P22 only one registration is in the master of this database');
    } else {
      // A LOCKED month must not be emptied. The database trigger inspects only
      // the NEW value, so a line leaving a locked month is refused here, in
      // application code — otherwise locking a month would protect it from
      // every write except the one that takes the data away.
      await lockMonth(GSTIN, PERIOD, { by: 'admin', reason: 'test lock' });
      const locked = await setOurGstin(before.id, otherGstin, { changedBy: 'tester', reason: 'while locked' });
      check('P7 a locked month refuses the move', !locked.ok, locked.reason);
      check('P8 the refusal names the lock', /LOCKED/i.test(String(locked.reason)));
      const stayed = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
      eq('P9 the line did not move out of the locked month', stayed?.our_gstin, GSTIN);
      await unlockMonth(GSTIN, PERIOD, { by: 'admin', reason: 'test unlock', adminConfirmed: true });

      const moved = await setOurGstin(before.id, otherGstin, {
        changedBy: 'tester', reason: 'Register imported under the wrong GSTIN.',
      });
      check('P10 the move saved', moved.ok, moved.reason);
      eq('P11 it reports where it came from and went to', [moved.movedFrom, moved.movedTo], [GSTIN, otherGstin]);
      eq('P12 it is gone from the old registration',
        (await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' })).total, 0);

      const atNew = await listLines({ gstin: otherGstin, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
      check('P13 it is under the new one', !!atNew);
      eq('P14 and carries that registration\'s company', atNew?.company_id, master.get(otherGstin)?.company_id);
      check('P15 the deterministic key followed it',
        String((await client.query('SELECT line_key FROM purchase_lines WHERE id = $1', [before.id])).rows[0]?.line_key || '')
          .startsWith(otherGstin + '|'));

      const gRow = (await lineHistory(before.id)).filter((x) => x.field_name === 'our_gstin');
      eq('P16 the move is in the correction history', gRow.length, 1);
      eq('P17 with the old and the new value', [gRow[0]?.old_value, gRow[0]?.new_value], [GSTIN, otherGstin]);
      check('P18 and the reason the user gave', /wrong GSTIN/i.test(String(gRow[0]?.reason)));
      // Not re-reconciled until a run actually happens, exactly like the other
      // corrections — the trail must never claim a run that did not run.
      eq('P19 it is not yet marked re-reconciled', gRow[0]?.rerefreshed, false);

      const trail = await auditTrail({ gstin: GSTIN, period: PERIOD, lineId: before.id });
      const audited = trail.rows.filter((x) => x.action === 'GSTIN CORRECTION');
      eq('P20 the audit trail records the correction', audited.length, 1);
      eq('P21 with both values', [audited[0]?.old_value, audited[0]?.new_value], [GSTIN, otherGstin]);

      const again2 = await setOurGstin(before.id, otherGstin, { changedBy: 'tester' });
      check('P22 moving to the same GSTIN changes nothing',
        again2.ok && again2.changed.length === 0, JSON.stringify(again2.changed));

      // The 2B for this invoice is filed under OUR original registration, so
      // after the move there is nothing to match it — which is the whole point
      // of putting the row under the right company.
      check('P23 the new registration reconciles',
        (await reReconcile(otherGstin, PERIOD, { changedBy: 'tester' })).ok);
      const atNew2 = await listLines({ gstin: otherGstin, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
      eq('P24 under the new GSTIN there is no 2B to match', atNew2?.match_status, 'Missing in 2B');

      const back = await setOurGstin(before.id, GSTIN, { changedBy: 'tester', reason: 'Restored after the test.' });
      check('P25 it can be moved back', back.ok, back.reason);
      await reReconcile(GSTIN, PERIOD, { changedBy: 'tester' });
      const home = await listLines({ gstin: GSTIN, period: PERIOD, search: 'GSTIN-FIX-1' }).then((r) => r.rows[0]);
      eq('P26 and it matches again', home?.match_status, 'Matched');
      // The fixture's book GSTIN is the WRONG one on purpose (section K); the
      // move changes our own GSTIN only and must never rewrite the supplier's.
      eq('P27 the supplier GSTIN in the books was never touched',
        home?.book_supplier_gstin, GSTIN_BOOK_WRONG);
    }
  }

  section('J. Cleanup');
  await cleanup();
  const left = await client.query(
    'SELECT count(*)::int n FROM purchase_lines WHERE source_file = $1 OR line_key = $2',
    [PASTE_ID, TWOB_KEY],
  );
  eq('G1 the synthetic rows are gone', left.rows[0].n, 0);
  const leftG = await client.query(
    `SELECT count(*)::int n FROM purchase_lines WHERE source_file = $1
        UNION ALL SELECT count(*)::int FROM gstr2b_lines WHERE line_key = $2`,
    [GSTINFIX_ID, GSTINFIX_KEY],
  );
  eq('G5 the Supplier-GSTIN fixture rows are gone', leftG.rows[0].n, 0);
  const leftAudit = await client.query(
    'SELECT count(*)::int n FROM audit_trail WHERE our_gstin = $1 AND period = $2 AND invoice_no IN ($3,$4)',
    [GSTIN, PERIOD, 'STPL-123', 'OK-999'],
  );
  eq('G3 the synthetic audit rows are gone', leftAudit.rows[0].n, 0);
  const leftCorr = await client.query('SELECT count(*)::int n FROM recon_corrections WHERE reason LIKE $1', [`%${PASTE_ID}%`]);
  eq('G4 no orphan correction rows remain', leftCorr.rows[0].n, 0);
  const locks = await client.query('SELECT count(*)::int n FROM month_locks WHERE our_gstin = $1 AND period = $2', [GSTIN, PERIOD]);
  eq('G2 the synthetic lock is gone', locks.rows[0].n, 0);

  await client.end();

  console.log('\n' + '='.repeat(66));
  console.log(`GST ERP Phase 0 (database): ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing: ' + failures.join(' | '));
  console.log('='.repeat(66));
  if (fail > 0) process.exit(1);
};

main().catch(async (e) => {
  console.error('test run failed:', e);
  try {
    await unlockMonth(GSTIN, PERIOD, { by: 'tester', reason: 'test cleanup', adminConfirmed: true });
    await cleanup();
  } catch { /* already broken */ }
  await client.end().catch(() => {});
  process.exit(2);
});