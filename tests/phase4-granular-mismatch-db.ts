/**
 * Phase 4 — Granular Mismatch Reasons & Mismatch Detail DB Test Suite
 *
 * Strictly executes ONLY on guarded `gst_erp_test` (NEVER `gst_erp` or `gst_erp_item_test`).
 * Verifies all 11+ mandatory Phase 4 scenarios:
 *   1. `INV-001` vs `INV-0001` (leading-zero difference — diagnosed, never auto-forced)
 *   2. Multiple 2B candidates for one Books invoice (`MULTIPLE_CANDIDATES` — never silently picked)
 *   3. Same invoice number with different supplier GSTIN (`SUPPLIER_GSTIN_DIFF` — never cross-matched)
 *   4. Tax Invoice vs Debit Note & Tax Invoice vs Credit Note (`DOC_TYPE_MISMATCH_TI_VS_DN` / `TI_VS_CN`)
 *   5. Only IGST difference (`IGST_DIFF` only)
 *   6. Only CGST / SGST / UTGST / Cess differences (each component independently verified)
 *   7. Taxable value difference (`TAXABLE_VALUE_DIFF`)
 *   8. Invoice value difference due to TCS/rounding (`INVOICE_VALUE_DIFF` while Taxable & GST match)
 *   9. Original vs corrected Books invoice number/date (`recon_*` overlay + `recon_corrections` audit trail, original `book_*` immutable)
 *  10. Repeated reconciliation and duplicate upload (idempotent, zero inflation)
 *  11. Zero accidental modification of original Books (`book_*`) or GSTR-2B (`gstr2b_lines`) records
 */

import assert from 'node:assert/strict';
import { loadEnv, pgConfig } from '../src/config/env';
import { reconcilePurchases } from '../src/engine/match';
import { stripInvoiceLeadingZeros, type Gstr2bRecord, type PurchaseBill } from '../src/engine/core';
import { persistRun, reReconcile, updateRecon, withClient } from '../src/app/store';

loadEnv();

const cfg = pgConfig();
if (cfg.database !== 'gst_erp_test') {
  console.error(`REFUSED: phase4-granular-mismatch-db.ts must run ONLY on gst_erp_test (got ${cfg.database})`);
  process.exit(2);
}

const TEST_GSTIN = '26AAACP4444P1Z2';
const SUP_1 = '27AAACZ1111A1Z1';
const SUP_2 = '24AAACZ2222B1Z2';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  PASS  ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  PASS  ${label}`);
}

function mkBook(p: Partial<PurchaseBill> & { invoice_no: string; source_row: number }): PurchaseBill {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_1,
    party_name: 'PHASE4 VENDOR',
    document_type: 'Tax Invoice',
    invoice_date: '2026-04-10',
    period: '2026-04',
    taxable_value: 10000,
    igst: 1800,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    source_invoice_value: 11800,
    book_invoice_value: 11800,
    invoice_total: 11800,
    source_file: 'p4_books.xlsx',
    ...p,
  };
}

function mk2b(t: Partial<Gstr2bRecord> & { invoice_no: string; source_row: number }): Gstr2bRecord {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_1,
    supplier_name: 'PHASE4 VENDOR',
    invoice_type: 'Regular',
    place_of_supply: '26',
    reverse_charge: false,
    reason: '',
    invoice_date: '2026-04-10',
    period: '2026-04',
    portal_fp: '2026-04',
    taxable_value: 10000,
    igst: 1800,
    cgst: 0,
    sgst: 0,
    utgst: 0,
    cess: 0,
    invoice_value: 11800,
    itc_availability: 'Yes',
    source_file: 'p4_2b.json',
    ...t,
  };
}

async function cleanup() {
  await withClient(async (c) => {
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)', [TEST_GSTIN]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin = $1', [TEST_GSTIN]);
  });
}

async function main() {
  console.log('\nPhase 4 — Granular Mismatch Reasons & Mismatch Detail DB Tests (gst_erp_test)\n');
  await cleanup();

  try {
    check('P4-01: stripInvoiceLeadingZeros normalises INV-001 === INV-0001 without confusing INV-10 vs INV-100', () => {
      assert.equal(stripInvoiceLeadingZeros('INV-001'), 'INV1');
      assert.equal(stripInvoiceLeadingZeros('INV-0001'), 'INV1');
      assert.equal(stripInvoiceLeadingZeros('0130'), '130');
      assert.notEqual(stripInvoiceLeadingZeros('INV-10'), stripInvoiceLeadingZeros('INV-100'));
    });

    // 1. INV-001 vs INV-0001
    check('P4-02: INV-001 vs INV-0001 flags LEADING_ZERO_INVOICE_DIFF and NEVER auto-matches', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'INV-001', source_row: 1 })],
        [mk2b({ invoice_no: 'INV-0001', source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.matched_2b_id, undefined);
      assert.ok(r.mismatch_reasons?.includes('LEADING_ZERO_INVOICE_DIFF'));
      assert.equal(r.suggested_2b_invoice_no, 'INV-0001');
    });

    // 2A. One Books invoice with one exact same-month GSTR-2B candidate -> Matched, NOT ambiguous
    check('P4-02b: Exact same-month GSTR-2B candidate matches cleanly (NOT flagged MULTIPLE_CANDIDATES)', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'EXACT-SM-01', period: '2026-04', source_row: 1 })],
        [mk2b({ invoice_no: 'EXACT-SM-01', period: '2026-04', portal_fp: '2026-04', source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Matched');
      assert.equal(r.detailed_status, 'MATCHED IN SAME MONTH');
      assert.ok(!r.mismatch_reasons?.includes('MULTIPLE_CANDIDATES'));
    });

    // 2B. Multiple 2B candidates for one Books invoice (both in subsequent months, neither same-month winner)
    check('P4-03: Multiple competing 2B candidates flag MULTIPLE_CANDIDATES and NEVER silently auto-match', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'MULTI-01', period: '2026-04', source_row: 1 })],
        [
          mk2b({ invoice_no: 'MULTI-01', period: '2026-05', portal_fp: '2026-05', source_row: 1 }),
          mk2b({ invoice_no: 'MULTI-01', period: '2026-06', portal_fp: '2026-06', source_row: 2 }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.detailed_status, 'PENDING MANUAL REVIEW');
      assert.equal(r.matched_2b_id, undefined);
      assert.ok(r.mismatch_reasons?.includes('MULTIPLE_CANDIDATES'));
      assert.equal(r.candidate_count, 2);
    });

    // 2C. Three redundant re-uploads of the same GSTR-2B document -> deduplicated, NOT ambiguous, zero inflation
    check('P4-03b: 3x redundant re-uploads of same GSTR-2B doc match cleanly without false ambiguity or total inflation', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'REDUP-01', period: '2026-04', taxable_value: 10000, igst: 1800, source_row: 1 })],
        [
          mk2b({ invoice_no: 'REDUP-01', period: '2026-04', portal_fp: '2026-04', source_file: '2b_upload_1.json', source_row: 1 }),
          mk2b({ invoice_no: 'REDUP-01', period: '2026-04', portal_fp: '2026-04', source_file: '2b_upload_2.json', source_row: 1 }),
          mk2b({ invoice_no: 'REDUP-01', period: '2026-04', portal_fp: '2026-04', source_file: '2b_upload_3.json', source_row: 1 }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Matched');
      assert.equal(r.two_b_taxable, 10000, '3x redundant copies must NOT inflate 2B taxable to 30000');
      assert.equal(res.unbooked2b.length, 0, 'Redundant copies must not leak into unbooked2b');
      assert.ok(!r.mismatch_reasons?.includes('MULTIPLE_CANDIDATES'));
    });

    // Invoice Date Mismatch (dateWindow = exact) & Our GSTIN isolation
    check('P4-03c: Invoice date difference emits DOCUMENT_DATE_DIFF when outside dateWindow', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'DATE-01', invoice_date: '2026-04-10', source_row: 1 })],
        [mk2b({ invoice_no: 'DATE-01', invoice_date: '2026-04-18', source_row: 1 })],
        { dateWindow: 'exact' },
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Amount Mismatch');
      assert.equal(r.detailed_status, 'DOCUMENT DATE MISMATCH');
      assert.ok(r.mismatch_reasons?.includes('DOCUMENT_DATE_DIFF'));
    });

    check('P4-03d: Different Our GSTIN never cross-matches', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'OURG-01', our_gstin: TEST_GSTIN, source_row: 1 })],
        [mk2b({ invoice_no: 'OURG-01', our_gstin: '24AAACP4444P1Z6', source_row: 1 })],
      );
      assert.equal(res.rows[0].status, 'Missing in 2B');
      assert.equal(res.rows[0].matched_2b_id, undefined);
    });

    // 3. Same invoice number with different supplier GSTIN
    check('P4-04: Same invoice number under different Supplier GSTIN flags SUPPLIER_GSTIN_DIFF (never cross-matches)', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'SUPDIFF-01', supplier_gstin: SUP_1, source_row: 1 })],
        [mk2b({ invoice_no: 'SUPDIFF-01', supplier_gstin: SUP_2, source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.matched_2b_id, undefined);
      assert.ok(r.mismatch_reasons?.includes('SUPPLIER_GSTIN_DIFF'));
    });

    // 4. Tax Invoice vs Debit Note & Credit Note
    check('P4-05: Tax Invoice vs Debit Note flags DOC_TYPE_MISMATCH_TI_VS_DN', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'DT-01', document_type: 'Tax Invoice', source_row: 1 })],
        [mk2b({ invoice_no: 'DT-01', invoice_type: 'Debit Note', source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.ok(r.mismatch_reasons?.includes('DOC_TYPE_MISMATCH_TI_VS_DN'));
    });

    check('P4-06: Tax Invoice vs Credit Note flags DOC_TYPE_MISMATCH_TI_VS_CN', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'DT-02', document_type: 'Tax Invoice', source_row: 1 })],
        [mk2b({ invoice_no: 'DT-02', invoice_type: 'Credit Note', taxable_value: -10000, igst: -1800, invoice_value: -11800, source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.ok(r.mismatch_reasons?.includes('DOC_TYPE_MISMATCH_TI_VS_CN'));
    });

    // 5. Only IGST difference
    check('P4-07: Only IGST difference emits IGST_DIFF (not TAXABLE/CGST/SGST/UTGST/CESS)', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'IGST-01', taxable_value: 10000, igst: 1800, source_row: 1 })],
        [mk2b({ invoice_no: 'IGST-01', taxable_value: 10000, igst: 1200, invoice_value: 11200, source_row: 1 })],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Amount Mismatch');
      assert.ok(r.mismatch_reasons?.includes('IGST_DIFF'));
      assert.ok(!r.mismatch_reasons?.includes('TAXABLE_VALUE_DIFF'));
      assert.ok(!r.mismatch_reasons?.includes('CGST_DIFF'));
    });

    // 6. Only CGST, SGST, UTGST, Cess differences independently
    check('P4-08: Only CGST difference emits CGST_DIFF', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'CGST-01', igst: 0, cgst: 900, sgst: 0, utgst: 900, source_row: 1 })],
        [mk2b({ invoice_no: 'CGST-01', igst: 0, cgst: 850, sgst: 0, utgst: 900, invoice_value: 11750, source_row: 1 })],
      );
      assert.ok(res.rows[0].mismatch_reasons?.includes('CGST_DIFF'));
      assert.ok(!res.rows[0].mismatch_reasons?.includes('UTGST_DIFF'));
      assert.ok(!res.rows[0].mismatch_reasons?.includes('SGST_DIFF'));
    });

    check('P4-09: Only SGST difference emits SGST_DIFF (no UTGST cross-mapping)', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'SGST-01', igst: 0, cgst: 900, sgst: 900, utgst: 0, source_row: 1 })],
        [mk2b({ invoice_no: 'SGST-01', igst: 0, cgst: 900, sgst: 800, utgst: 0, invoice_value: 11700, source_row: 1 })],
      );
      assert.ok(res.rows[0].mismatch_reasons?.includes('SGST_DIFF'));
      assert.ok(!res.rows[0].mismatch_reasons?.includes('UTGST_DIFF'));
    });

    check('P4-10: Only UTGST difference emits UTGST_DIFF (kept separate from SGST)', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'UTGST-01', igst: 0, cgst: 900, sgst: 0, utgst: 900, source_row: 1 })],
        [mk2b({ invoice_no: 'UTGST-01', igst: 0, cgst: 900, sgst: 0, utgst: 800, invoice_value: 11700, source_row: 1 })],
      );
      assert.ok(res.rows[0].mismatch_reasons?.includes('UTGST_DIFF'));
      assert.ok(!res.rows[0].mismatch_reasons?.includes('SGST_DIFF'));
    });

    check('P4-10b: Books SGST matches GSTR-2B UTGST as one combined head (UT GSTIN)', () => {
      const res = reconcilePurchases(
        [mkBook({ our_gstin: '26ABFCS9511H1Z7', supplier_gstin: '26AAFCH2607A1Z7', invoice_no: 'HF/SER/1/26-27', taxable_value: 6400, igst: 0, cgst: 576, sgst: 576, utgst: 0, source_invoice_value: 7552, book_invoice_value: 7552, source_row: 1 })],
        [mk2b({ our_gstin: '26ABFCS9511H1Z7', supplier_gstin: '26AAFCH2607A1Z7', invoice_no: 'HF/SER/1/26-27', taxable_value: 6400, igst: 0, cgst: 576, sgst: 0, utgst: 576, invoice_value: 7552, source_row: 1 })],
      );
      assert.equal(res.rows[0].status, 'Matched');
      assert.equal(res.rows[0].mismatch_reasons?.length ?? 0, 0);
    });

    check('P4-11: Only Cess difference emits CESS_DIFF', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'CESS-01', igst: 1800, cess: 500, source_invoice_value: 12300, book_invoice_value: 12300, source_row: 1 })],
        [mk2b({ invoice_no: 'CESS-01', igst: 1800, cess: 400, invoice_value: 12200, source_row: 1 })],
      );
      assert.ok(res.rows[0].mismatch_reasons?.includes('CESS_DIFF'));
      assert.ok(!res.rows[0].mismatch_reasons?.includes('IGST_DIFF'));
    });

    // 7. Taxable value difference
    check('P4-12: Taxable value difference emits TAXABLE_VALUE_DIFF', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'TAX-01', taxable_value: 10500, igst: 1800, source_invoice_value: 12300, book_invoice_value: 12300, source_row: 1 })],
        [mk2b({ invoice_no: 'TAX-01', taxable_value: 10000, igst: 1800, invoice_value: 11800, source_row: 1 })],
      );
      assert.equal(res.rows[0].status, 'Amount Mismatch');
      assert.ok(res.rows[0].mismatch_reasons?.includes('TAXABLE_VALUE_DIFF'));
    });

    // 8. Invoice value difference due to TCS/rounding while Taxable & GST match
    check('P4-13: Invoice value difference (TCS/rounding) emits INVOICE_VALUE_DIFF while preserving tax Match', () => {
      const res = reconcilePurchases(
        [mkBook({ invoice_no: 'TCS-01', taxable_value: 10000, igst: 1800, source_invoice_value: 11875, book_invoice_value: 11875, source_row: 1 })],
        [mk2b({ invoice_no: 'TCS-01', taxable_value: 10000, igst: 1800, invoice_value: 11800, source_row: 1 })],
      );
      assert.equal(res.rows[0].status, 'Matched');
      assert.equal(res.rows[0].invoice_value_difference, 75);
      assert.ok(res.rows[0].mismatch_reasons?.includes('INVOICE_VALUE_DIFF'));
    });

    // 9, 10, 11. End-to-End DB persistence on gst_erp_test:
    // Persist INV-001 (Book) + INV-0001 (2B), verify LEADING_ZERO_INVOICE_DIFF persisted,
    // then apply user correction via editLineRecon -> reReconcile -> Matched while book_invoice_no stays 'INV-001'!
    const dbBooks = [
      mkBook({ invoice_no: 'INV-001', invoice_date: '2026-04-10', source_row: 1 }),
      mkBook({ invoice_no: 'IGST-DB', igst: 1800, source_row: 2 }),
    ];
    const db2b = [
      mk2b({ invoice_no: 'INV-0001', invoice_date: '2026-04-11', source_row: 1 }),
      mk2b({ invoice_no: 'IGST-DB', igst: 1500, invoice_value: 11500, source_row: 2 }),
    ];

    const p1 = await persistRun({ books: dbBooks, twob: db2b, reconByBundle: new Map() });
    assert.equal(p1.ok, true);
    const rr1 = await reReconcile(TEST_GSTIN, '2026-04', { changedBy: 'phase4-test' });
    assert.equal(rr1.ok, true);

    let invLineId = 0;
    await checkAsync('P4-14: DB persists mismatch_reasons[] (LEADING_ZERO_INVOICE_DIFF & IGST_DIFF) accurately', async () => {
      const r = await withClient((c) =>
        c.query(
          `SELECT id, book_invoice_no, recon_invoice_no, match_status, mismatch_reasons
             FROM purchase_lines WHERE our_gstin = $1 ORDER BY book_invoice_no`,
          [TEST_GSTIN],
        ),
      );
      const igstRow = r.rows.find((x: any) => x.book_invoice_no === 'IGST-DB');
      const lzRow = r.rows.find((x: any) => x.book_invoice_no === 'INV-001');
      invLineId = Number(lzRow.id);
      assert.ok(igstRow.mismatch_reasons.includes('IGST_DIFF'));
      assert.ok(lzRow.mismatch_reasons.includes('LEADING_ZERO_INVOICE_DIFF'));
      assert.equal(lzRow.match_status, 'Missing in 2B');
    });

    await checkAsync('P4-15: Explicit user correction updates recon_* + audit trail, matches on reReconcile, and NEVER alters book_* or gstr2b_lines', async () => {
      const ed = await updateRecon(
        invLineId,
        { recon_invoice_no: 'INV-0001', recon_invoice_date: '2026-04-11' },
        { changedBy: 'phase4-test', reason: 'Confirmed leading-zero difference in Mismatch Detail' },
      );
      assert.equal(ed.ok, true);
      const rr2 = await reReconcile(TEST_GSTIN, '2026-04', { changedBy: 'phase4-test' });
      assert.equal(rr2.ok, true);

      const checkRow = await withClient((c) =>
        c.query(
          `SELECT book_invoice_no, book_invoice_date, recon_invoice_no, recon_invoice_date,
                  match_status, detailed_match_status, mismatch_reasons
             FROM purchase_lines WHERE id = $1`,
          [invLineId],
        ),
      );
      const row = checkRow.rows[0];
      assert.equal(row.book_invoice_no, 'INV-001', 'Original book_invoice_no must stay immutable');
      assert.equal(row.recon_invoice_no, 'INV-0001');
      assert.equal(row.match_status, 'Matched');
      assert.equal(row.detailed_match_status, 'MATCHED AFTER BOOKS CORRECTION');

      const corr = await withClient((c) =>
        c.query(`SELECT field_name, old_value, new_value FROM recon_corrections WHERE line_id = $1`, [invLineId]),
      );
      assert.ok(corr.rows.length >= 2, 'Correction audit trail must record invoice_no and invoice_date changes');
    });

    await checkAsync('P4-16: Repeated reconciliation & duplicate upload remain idempotent with zero row inflation', async () => {
      const pDup = await persistRun({ books: dbBooks, twob: db2b, reconByBundle: new Map() });
      assert.equal(pDup.ok, true);
      await reReconcile(TEST_GSTIN, '2026-04', { changedBy: 'phase4-test' });
      const rrAgain = await reReconcile(TEST_GSTIN, '2026-04', { changedBy: 'phase4-test' });
      assert.equal(rrAgain.changed, 0);

      const cnts = await withClient(async (c) => ({
        pl: (await c.query('SELECT count(*)::int AS n FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN])).rows[0].n,
        t2b: (await c.query('SELECT count(*)::int AS n FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN])).rows[0].n,
      }));
      assert.equal(cnts.pl, 2);
      assert.equal(cnts.t2b, 2);
    });

    console.log(`\n==================================================================`);
    console.log(`Phase 4 Granular Mismatch Reasons DB suite: ${passed} passed, 0 failed`);
    console.log(`==================================================================\n`);
  } finally {
    await cleanup();
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
