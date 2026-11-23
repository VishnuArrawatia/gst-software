/**
 * Phase 1 — Critical Reconciliation Correctness Test Suite (gst_erp_test ONLY).
 *
 * Verifies:
 *   1. Strict document-type matching (Tax Invoice vs Debit Note vs Credit Note never cross-match)
 *   2. Tax Invoice + Debit Note with same number are NOT falsely flagged as Duplicate
 *   3. UTGST separation (UT state 26 vs State 24), component-wise mismatch, and DB immutability trigger
 *   4. GSTR-2B JSON parses BOTH cdnr + cdnra and impg + impga without dropping amendments
 *   5. Purchase Register sign-conflict preserves printed amounts (matching warning)
 *   6. Multi-file persistRun + multi-rate 2B summed tax persistence
 *   7. 1:1 GSTR-2B exclusivity across months (even for Amount Mismatch rows)
 *   8. Our-GSTIN isolation inside pure reconcilePurchases()
 */

import { reconcilePurchases } from '../src/engine/match';
import { parsePurchaseRegister, parseGstr2bJson } from '../src/engine/ingest';
import {
  withClient,
  importPastedPurchase,
  persistRun,
  reReconcile,
  getLine,
  reconMapOf,
} from '../src/app/store';
import type { PurchaseBill, Gstr2bRecord } from '../src/engine/core';

const UT_GSTIN = '26AALCS9985J1ZC'; // Dadra & Nagar Haveli and Daman & Diu (UTGST)
const STATE_GSTIN = '24AALCS9985J1ZG'; // Gujarat (SGST)
const SUP_A = '27AAACS1234A1Z5';
const SUP_UT = '26AAACS1234A1Z7';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.error(`  FAIL: ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function mkBook(p: Partial<PurchaseBill> & { invoice_no: string }): PurchaseBill {
  return {
    id: p.id || `B-${p.invoice_no}`,
    our_gstin: p.our_gstin ?? UT_GSTIN,
    party_name: p.party_name ?? 'Vendor A',
    supplier_gstin: p.supplier_gstin ?? SUP_A,
    invoice_no: p.invoice_no,
    document_type: p.document_type ?? 'Tax Invoice',
    invoice_date: p.invoice_date ?? '2026-04-10',
    period: p.period ?? '2026-04',
    taxable_value: p.taxable_value ?? 10000,
    igst: p.igst ?? 1800,
    cgst: p.cgst ?? 0,
    sgst: p.sgst ?? 0,
    utgst: p.utgst ?? 0,
    cess: p.cess ?? 0,
    source_file: p.source_file ?? 'books.xlsx',
    source_row: p.source_row ?? 2,
  };
}

function mk2b(p: Partial<Gstr2bRecord> & { invoice_no: string }): Gstr2bRecord {
  return {
    id: p.id || `2B-${p.invoice_no}`,
    our_gstin: p.our_gstin ?? UT_GSTIN,
    supplier_gstin: p.supplier_gstin ?? SUP_A,
    supplier_name: p.supplier_name ?? 'Vendor A',
    invoice_no: p.invoice_no,
    invoice_type: p.invoice_type ?? 'Regular',
    invoice_date: p.invoice_date ?? '2026-04-10',
    invoice_value: (p.taxable_value ?? 10000) + (p.igst ?? 1800) + (p.cgst ?? 0) + (p.sgst ?? 0) + (p.utgst ?? 0) + (p.cess ?? 0),
    place_of_supply: p.place_of_supply ?? '26',
    reverse_charge: false,
    taxable_value: p.taxable_value ?? 10000,
    igst: p.igst ?? 1800,
    cgst: p.cgst ?? 0,
    sgst: p.sgst ?? 0,
    utgst: p.utgst ?? 0,
    cess: p.cess ?? 0,
    period: p.period ?? '2026-04',
    portal_fp: p.portal_fp ?? p.period ?? '2026-04',
    itc_availability: p.itc_availability ?? 'Yes',
    source_file: p.source_file ?? '2b.json',
    source_row: p.source_row ?? 1,
  };
}

async function main() {
  const db = (await withClient((c) => c.query('SELECT current_database() d'))).rows[0].d;
  if (db !== 'gst_erp_test') throw new Error(`ABORT: Must run strictly on gst_erp_test, got ${db}`);
  console.log(`=== PHASE 1 CORRECTNESS SUITE (${db}) ===`);

  // 1. Strict Document-Type Matching
  {
    const rTiDn = reconcilePurchases(
      [mkBook({ invoice_no: 'DN55', document_type: 'Tax Invoice' })],
      [mk2b({ invoice_no: 'DN55', invoice_type: 'Debit Note' })],
    );
    check(
      'P1-01: Tax Invoice NEVER matches Debit Note (strictDocType default true)',
      rTiDn.rows[0].status === 'Missing in 2B' && rTiDn.rows[0].detailed_status === 'DOCUMENT TYPE MISMATCH' && !rTiDn.rows[0].matched_2b_id,
      rTiDn.rows[0],
    );

    const rTiCn = reconcilePurchases(
      [mkBook({ invoice_no: 'CN55', document_type: 'Tax Invoice' })],
      [mk2b({ invoice_no: 'CN55', invoice_type: 'Credit Note', taxable_value: -10000, igst: -1800 })],
    );
    check(
      'P1-02: Tax Invoice NEVER matches Credit Note',
      rTiCn.rows[0].status === 'Missing in 2B' && rTiCn.rows[0].detailed_status === 'DOCUMENT TYPE MISMATCH',
      rTiCn.rows[0],
    );

    const rNegDnCn = reconcilePurchases(
      [mkBook({ invoice_no: 'RET55', document_type: 'Debit Note', taxable_value: -5000, igst: -900 })],
      [mk2b({ invoice_no: 'RET55', invoice_type: 'Credit Note', taxable_value: -5000, igst: -900 })],
    );
    check(
      'P1-03: Negative Books Debit Note NEVER auto-matches GSTR-2B Credit Note',
      rNegDnCn.rows[0].status === 'Missing in 2B' && rNegDnCn.rows[0].detailed_status === 'DOCUMENT TYPE MISMATCH',
      rNegDnCn.rows[0],
    );

    const rSameNoDiffDoc = reconcilePurchases(
      [
        mkBook({ invoice_no: 'DOC-99', document_type: 'Tax Invoice', source_row: 2 }),
        mkBook({ invoice_no: 'DOC-99', document_type: 'Debit Note', source_row: 3 }),
      ],
      [
        mk2b({ id: '2b-ti', invoice_no: 'DOC-99', invoice_type: 'Regular' }),
        mk2b({ id: '2b-dn', invoice_no: 'DOC-99', invoice_type: 'Debit Note' }),
      ],
    );
    check(
      'P1-04: Tax Invoice & Debit Note sharing same number are NOT flagged Duplicate and each matches its own type',
      rSameNoDiffDoc.summary.matched === 2 && rSameNoDiffDoc.summary.duplicate === 0,
      rSameNoDiffDoc.summary,
    );
  }

  // 2. Our-GSTIN isolation inside pure engine
  {
    const rCrossG = reconcilePurchases(
      [mkBook({ invoice_no: 'ISO-1', our_gstin: UT_GSTIN })],
      [mk2b({ invoice_no: 'ISO-1', our_gstin: STATE_GSTIN })],
    );
    check(
      'P1-05: reconcilePurchases() NEVER cross-matches different Our GSTINs',
      rCrossG.rows[0].status === 'Missing in 2B' && !rCrossG.rows[0].matched_2b_id,
      rCrossG.rows[0],
    );
  }

  // 3. UTGST separation & component-wise matching
  {
    const prUt = parsePurchaseRegister([
      ['Our GSTIN', 'Supplier GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Document Type', 'Taxable Value', 'CGST', 'SGST', 'UTGST'],
      [UT_GSTIN, SUP_UT, 'UT Vendor', 'UT-001', '10-04-2026', 'Tax Invoice', 10000, 900, 0, 900],
      [STATE_GSTIN, SUP_A, 'GJ Vendor', 'GJ-001', '10-04-2026', 'Tax Invoice', 10000, 900, 900, 0],
    ], 'ut_test.xlsx');
    check(
      'P1-06: Purchase Register preserves UTGST separately from SGST',
      prUt.rows[0].utgst === 900 && prUt.rows[0].sgst === 0 && prUt.rows[1].sgst === 900 && prUt.rows[1].utgst === 0,
      prUt.rows.map((r) => ({ inv: r.invoice_no, sgst: r.sgst, utgst: r.utgst })),
    );

    const rUtMismatch = reconcilePurchases(
      [mkBook({ invoice_no: 'UT-DIFF', our_gstin: UT_GSTIN, igst: 0, cgst: 900, sgst: 900, utgst: 0 })],
      [mk2b({ invoice_no: 'UT-DIFF', our_gstin: UT_GSTIN, igst: 0, cgst: 900, sgst: 0, utgst: 900 })],
    );
    check(
      'P1-07: SGST vs UTGST component mismatch triggers Amount Mismatch (never silent Matched)',
      rUtMismatch.rows[0].status === 'Amount Mismatch' && rUtMismatch.rows[0].detailed_status === 'MATCHED WITH TAX DIFFERENCE',
      rUtMismatch.rows[0],
    );

    const rUtMatch = reconcilePurchases(
      [mkBook({ invoice_no: 'UT-OK', our_gstin: UT_GSTIN, igst: 0, cgst: 900, sgst: 0, utgst: 900 })],
      [mk2b({ invoice_no: 'UT-OK', our_gstin: UT_GSTIN, igst: 0, cgst: 900, sgst: 0, utgst: 900 })],
    );
    check(
      'P1-08: Exact CGST + UTGST matches cleanly',
      rUtMatch.rows[0].status === 'Matched' && rUtMatch.rows[0].two_b_utgst === 900,
      rUtMatch.rows[0],
    );
  }

  // 4. GSTR-2B JSON parses BOTH cdnr + cdnra and impg + impga + separates UT UTGST
  {
    const jsonRes = parseGstr2bJson({
      gstin: UT_GSTIN,
      fp: '042026',
      b2b: [{ ctin: SUP_UT, inv: [{ inum: 'UT-2B-1', idt: '10-04-2026', pos: '26', val: 11800, itms: [{ itm_det: { txval: 10000, camt: 900, samt: 900 } }] }] }],
      cdnr: [{ ctin: SUP_A, nt: [{ nt_num: 'CN-ORIG', nt_dt: '11-04-2026', ntty: 'C', val: 1180, itms: [{ itm_det: { txval: 1000, iamt: 180 } }] }] }],
      cdnra: [{ ctin: SUP_A, nt: [{ nt_num: 'CN-AMEND', nt_dt: '12-04-2026', oinum: 'CN-OLD', oidt: '15-03-2026', ntty: 'C', val: 2360, itms: [{ itm_det: { txval: 2000, iamt: 360 } }] }] }],
      impg: [{ boenum: '1001', boedt: '14-04-2026', portcode: 'INNSA1', txval: 50000, iamt: 9000 }],
      impga: [{ boenum: '1002', boedt: '15-04-2026', portcode: 'INNSA1', txval: 60000, iamt: 10800 }],
    }, 'full_2b.json');
    const b2bRow = jsonRes.rows.find((r) => r.invoice_no === 'UT-2B-1');
    const cdnraRow = jsonRes.rows.find((r) => r.invoice_no === 'CN-AMEND');
    const impgaRow = jsonRes.rows.find((r) => r.invoice_no === 'BOE-1002');
    check(
      'P1-09: GSTR-2B JSON ingests b2b + cdnr + cdnra + impg + impga (5 rows, zero dropped)',
      jsonRes.rows.length === 5 &&
        cdnraRow?.doc_category === 'CDNRA' &&
        cdnraRow?.original_doc_no === 'CN-OLD' &&
        impgaRow?.doc_category === 'IMPGA',
      jsonRes.rows.map((r) => ({ inv: r.invoice_no, cat: r.doc_category, orig: r.original_doc_no })),
    );
    check(
      'P1-10: GSTR-2B JSON classifies UT state 26 State/UT tax into utgst while preserving source_sgst',
      b2bRow?.utgst === 900 && b2bRow?.sgst === 0 && b2bRow?.source_sgst === 900,
      b2bRow,
    );
  }

  // 5. Purchase Register sign-conflict preserves printed amounts (matching warning)
  {
    const prMix = parsePurchaseRegister([
      ['Our GSTIN', 'Supplier GSTIN', 'Party Name', 'Invoice No', 'Invoice Date', 'Document Type', 'Taxable Value', 'IGST'],
      [UT_GSTIN, SUP_A, 'Vendor A', 'CN-MIX', '10-04-2026', 'Credit Note', 5000, -900],
    ], 'mix.xlsx');
    check(
      'P1-11: Mixed-sign Credit Note preserves printed amounts (+5000, -900) matching warning text',
      prMix.rows[0].taxable_value === 5000 && prMix.rows[0].igst === -900 && (prMix.warnings?.length ?? 0) === 1,
      { row: prMix.rows[0], warnings: prMix.warnings },
    );
  }

  // 6. DB-backed tests on gst_erp_test: UTGST persistence, immutability trigger, multi-rate 2B, & 1:1 exclusivity
  const P1 = '2018-06';
  const P2 = '2018-07';
  const TAG = `P1TEST_${Date.now()}`;
  try {
    const twobMultiRate = [
      mk2b({ id: `${TAG}#mr1`, our_gstin: UT_GSTIN, period: P1, portal_fp: P1, invoice_no: 'MR-UT-1', igst: 0, cgst: 450, sgst: 0, utgst: 450, taxable_value: 5000, source_file: `${TAG}.json`, source_row: 1 }),
      mk2b({ id: `${TAG}#mr2`, our_gstin: UT_GSTIN, period: P1, portal_fp: P1, invoice_no: 'MR-UT-1', igst: 0, cgst: 450, sgst: 0, utgst: 450, taxable_value: 5000, source_file: `${TAG}.json`, source_row: 2 }),
      mk2b({ id: `${TAG}#excl`, our_gstin: UT_GSTIN, period: P1, portal_fp: P1, invoice_no: 'EXCL-1', igst: 1800, taxable_value: 10000, source_file: `${TAG}.json`, source_row: 3 }),
    ];
    const bookMr = mkBook({ our_gstin: UT_GSTIN, period: P1, invoice_no: 'MR-UT-1', igst: 0, cgst: 900, sgst: 0, utgst: 900, taxable_value: 10000, source_file: `${TAG}_b1.xlsx`, source_row: 2 });
    const bookExcl1 = mkBook({ our_gstin: UT_GSTIN, period: P1, invoice_no: 'EXCL-1', igst: 1500, taxable_value: 10000, source_file: `${TAG}_b1.xlsx`, source_row: 3 });
    const recon1 = reconcilePurchases([bookMr, bookExcl1], twobMultiRate);

    await persistRun({
      books: [bookMr, bookExcl1],
      twob: twobMultiRate,
      reconByBundle: reconMapOf([{ gstin: UT_GSTIN, period: P1, result: recon1 }]),
      uploadedBy: 'p1test',
    });

    const p1Rows = (await withClient((c) => c.query('SELECT * FROM purchase_lines WHERE our_gstin=$1 AND period=$2 ORDER BY source_row', [UT_GSTIN, P1]))).rows;
    const mrRow = p1Rows[0];
    const exclRow1 = p1Rows[1];
    check(
      'P1-12: persistRun stores summed multi-rate 2B UTGST (900) & CGST (900) and matches cleanly',
      mrRow.match_status === 'Matched' && Number(mrRow.book_utgst) === 900 && Number(mrRow.twob_utgst) === 900 && Number(mrRow.twob_cgst) === 900,
      { st: mrRow.match_status, bu: mrRow.book_utgst, tu: mrRow.twob_utgst, tc: mrRow.twob_cgst },
    );

    // Immutability trigger blocks direct UPDATE on book_utgst
    let immBlocked = false;
    try {
      await withClient((c) => c.query('UPDATE purchase_lines SET book_utgst = 1234 WHERE id = $1', [mrRow.id]));
    } catch (e: any) {
      immBlocked = /immutable/i.test(String(e.message));
    }
    check('P1-13: trg_pl_book_immutable blocks direct UPDATE to book_utgst', immBlocked);

    // 1:1 GSTR-2B exclusivity: EXCL-1 matched in P1 as Amount Mismatch MUST NOT be double-claimed in P2!
    const bookExcl2 = mkBook({ our_gstin: UT_GSTIN, period: P2, invoice_no: 'EXCL-1', igst: 1500, taxable_value: 10000, source_row: 2 });
    await importPastedPurchase([bookExcl2], `paste:${TAG}`, { by: 'p1test' });
    const p2Row = (await withClient((c) => c.query('SELECT * FROM purchase_lines WHERE our_gstin=$1 AND period=$2', [UT_GSTIN, P2]))).rows[0];
    check(
      'P1-14: GSTR-2B doc matched as Amount Mismatch in Month 1 CANNOT be double-claimed in Month 2',
      exclRow1.match_status === 'Amount Mismatch' && p2Row.match_status === 'Missing in 2B' && !p2Row.matched_2b_key,
      { p1Status: exclRow1.match_status, p2Status: p2Row.match_status, p2Key: p2Row.matched_2b_key },
    );
  } finally {
    await withClient(async (c) => {
      await c.query('DELETE FROM purchase_lines WHERE our_gstin=$1 AND period IN ($2,$3)', [UT_GSTIN, P1, P2]);
      await c.query('DELETE FROM gstr2b_lines WHERE line_key LIKE $1', [`${TAG}%`]);
      await c.query('DELETE FROM audit_trail WHERE our_gstin=$1 AND period IN ($2,$3)', [UT_GSTIN, P1, P2]);
    });
  }

  console.log(`\n==================================================================`);
  console.log(`PHASE 1 SUITE: ${passed} passed, ${failed} failed`);
  console.log(`==================================================================`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
