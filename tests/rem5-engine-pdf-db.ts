/**
 * REM-5 — Backend Engine & Historical Recon PDF Perfection DB Test Suite
 *
 * Strictly executes ONLY on guarded `gst_erp_test` (`GST_DB_PROFILE=test PGDATABASE=gst_erp_test`).
 * Verifies:
 *   1. UT tax-only Credit Note (`utgst < 0`, other heads 0) classifies as `Credit Note`.
 *   2. `MULTIPLE_CANDIDATES` row retains its multi-candidate `match_hint` even when
 *      an unbooked 2B row has identical amount.
 *   3. Unbooked Debit Note does NOT produce a probable match hint on a Missing-in-2B Tax Invoice.
 *   4. Historical Recon PDF Section 6 includes `Inv Val` & `Cess` and renders cleanly.
 */

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadEnv } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget } from '../src/config/test-db';
import { reconcilePurchases } from '../src/engine/match';
import type { Gstr2bRecord, PurchaseBill } from '../src/engine/core';
import { persistRun, reconcileFinancialYear, withClient } from '../src/app/store';
import { buildHistoricalReconReport } from '../src/app/historical-recon-report';
import { buildHistoricalReconPdf } from '../src/app/historical-recon-pdf';

loadEnv();
assertTestDbTarget('tests/rem5-engine-pdf-db.ts');

const TEST_GSTIN = '26AAACR5555R1Z5';
const SUP_1 = '26AAACR1111A1Z1';
const SUP_2 = '27AAACR2222B1Z2';

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
    party_name: 'REM5 VENDOR',
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
    source_file: 'rem5_books.xlsx',
    ...p,
  };
}

function mk2b(t: Partial<Gstr2bRecord> & { invoice_no: string; source_row: number }): Gstr2bRecord {
  return {
    our_gstin: TEST_GSTIN,
    supplier_gstin: SUP_1,
    supplier_name: 'REM5 VENDOR',
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
    source_file: 'rem5_2b.json',
    ...t,
  };
}

/** Extract readable text from all FlateDecode streams inside a pdfkit PDF buffer. */
function extractPdfStreamText(pdfBuf: Buffer): string {
  const raw = pdfBuf.toString('latin1');
  const out: string[] = [];
  let pos = 0;
  while (true) {
    const startIdx = raw.indexOf('stream', pos);
    if (startIdx === -1) break;
    let dataStart = startIdx + 'stream'.length;
    if (raw[dataStart] === '\r' && raw[dataStart + 1] === '\n') dataStart += 2;
    else if (raw[dataStart] === '\n') dataStart += 1;
    else {
      pos = dataStart;
      continue;
    }
    const endIdx = raw.indexOf('endstream', dataStart);
    if (endIdx === -1) break;
    let dataEnd = endIdx;
    if (dataEnd > dataStart && raw[dataEnd - 1] === '\n') dataEnd--;
    if (dataEnd > dataStart && raw[dataEnd - 1] === '\r') dataEnd--;
    const slice = pdfBuf.subarray(dataStart, dataEnd);
    let text = '';
    try {
      text = zlib.inflateSync(slice).toString('latin1');
    } catch {
      text = slice.toString('latin1');
    }
    // Decode pdfkit TJ arrays (e.g. `[<496e76> -20 <2056616c>] TJ`) & Tj strings
    for (const m of text.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const inner = m[1];
      let decoded = '';
      for (const tok of inner.matchAll(/<([0-9a-fA-F]+)>|\(([^)]*)\)/g)) {
        if (tok[1]) decoded += Buffer.from(tok[1], 'hex').toString('latin1');
        else if (tok[2]) decoded += tok[2];
      }
      if (decoded) out.push(decoded);
    }
    for (const m of text.matchAll(/(?:<([0-9a-fA-F]+)>|\(([^)]*)\))\s*Tj/g)) {
      if (m[1]) out.push(Buffer.from(m[1], 'hex').toString('latin1'));
      else if (m[2]) out.push(m[2]);
    }
    pos = endIdx + 'endstream'.length;
  }
  return out.join('\n');
}

async function cleanup() {
  await withClient(async (c) => {
    const dbRes = await c.query('SELECT current_database() AS db');
    assertConnectedDatabase(dbRes.rows[0]?.db, 'tests/rem5-engine-pdf-db.ts cleanup');
    await c.query('DELETE FROM recon_corrections WHERE line_id IN (SELECT id FROM purchase_lines WHERE our_gstin = $1)', [TEST_GSTIN]);
    await c.query('DELETE FROM purchase_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_lines WHERE our_gstin = $1', [TEST_GSTIN]);
    await c.query('DELETE FROM gstr2b_files WHERE our_gstin = $1', [TEST_GSTIN]);
  });
}

async function main() {
  console.log('\nREM-5 — Backend Engine & Historical Recon PDF Perfection DB Tests (gst_erp_test)\n');

  await withClient(async (c) => {
    const dbRes = await c.query('SELECT current_database() AS db');
    assertConnectedDatabase(dbRes.rows[0]?.db, 'tests/rem5-engine-pdf-db.ts startup');
  });

  await cleanup();

  try {
    // 1. UT tax-only Credit Note (`utgst < 0`, other heads 0) classifies as Credit Note
    check('REM5-01: UT tax-only Credit Note (utgst < 0, other heads 0) classifies as Credit Note on both Books and 2B sides', () => {
      const res = reconcilePurchases(
        [
          mkBook({
            invoice_no: 'UT-CN-ONLY-01',
            document_type: 'Tax Invoice', // mislabelled as Tax Invoice, only utgst is negative
            taxable_value: 0,
            igst: 0,
            cgst: 0,
            sgst: 0,
            utgst: -450,
            cess: 0,
            source_invoice_value: -450,
            book_invoice_value: -450,
            invoice_total: -450,
            source_row: 1,
          }),
        ],
        [
          mk2b({
            invoice_no: 'UT-CN-ONLY-01',
            invoice_type: 'Regular', // mislabelled as Regular, only utgst is negative
            taxable_value: 0,
            igst: 0,
            cgst: 0,
            sgst: 0,
            utgst: -450,
            cess: 0,
            invoice_value: -450,
            source_row: 1,
          }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.document_type, 'Credit Note', 'Books UT tax-only negative line must classify as Credit Note');
      assert.equal(r.status, 'Matched', 'Matching 2B UT tax-only negative line must also classify as Credit Note and match');
      assert.equal(res.summary.books_docs.credit, 1);
      assert.equal(res.summary.books_itc_credit, 450);
      assert.equal(res.summary.twob_itc_credit, 450);
    });

    // 2. MULTIPLE_CANDIDATES row retains its multi-candidate match_hint even when unbooked 2B row has identical amount
    check('REM5-02: MULTIPLE_CANDIDATES row retains multi-candidate match_hint even with identical-amount unbooked 2B row', () => {
      const res = reconcilePurchases(
        [
          mkBook({
            invoice_no: 'MULTI-AMB-01',
            period: '2026-04',
            taxable_value: 10000,
            igst: 1800,
            source_row: 1,
          }),
        ],
        [
          mk2b({ invoice_no: 'MULTI-AMB-01', period: '2026-05', portal_fp: '2026-05', taxable_value: 10000, igst: 1800, source_row: 1 }),
          mk2b({ invoice_no: 'MULTI-AMB-01', period: '2026-06', portal_fp: '2026-06', taxable_value: 10000, igst: 1800, source_row: 2 }),
          // Another unbooked 2B Tax Invoice from same supplier with identical amount & exact date
          mk2b({ invoice_no: 'UNBOOKED-SAME-AMT', period: '2026-04', portal_fp: '2026-04', taxable_value: 10000, igst: 1800, source_row: 3 }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.detailed_status, 'PENDING MANUAL REVIEW');
      assert.ok(r.mismatch_reasons?.includes('MULTIPLE_CANDIDATES'));
      assert.ok(
        r.match_hint?.startsWith('Multiple candidates (2):'),
        `Expected multi-candidate hint to be preserved, got: ${r.match_hint}`,
      );
      assert.equal(r.suggested_2b_invoice_no, 'MULTI-AMB-01', 'suggested_2b_invoice_no must NOT be overwritten by UNBOOKED-SAME-AMT');
    });

    // 3. Unbooked Debit Note does NOT produce a probable match hint on a Missing-in-2B Tax Invoice
    check('REM5-03: Unbooked Debit Note does NOT produce a probable match hint on a Missing-in-2B Tax Invoice', () => {
      const res = reconcilePurchases(
        [
          mkBook({
            invoice_no: 'TI-MISSING-01',
            document_type: 'Tax Invoice',
            taxable_value: 15000,
            igst: 2700,
            source_invoice_value: 17700,
            book_invoice_value: 17700,
            invoice_total: 17700,
            source_row: 1,
          }),
        ],
        [
          mk2b({
            invoice_no: 'DN-UNBOOKED-99',
            invoice_type: 'Debit Note',
            taxable_value: 15000,
            igst: 2700,
            invoice_value: 17700,
            source_row: 1,
          }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.detailed_status, 'BOOKS ONLY');
      assert.equal(r.match_hint, undefined, 'Unbooked Debit Note must NEVER produce a probable match hint on a Tax Invoice');
      assert.equal(r.suggested_2b_invoice_no, undefined);
    });

    // 3b. Sanity check: Unbooked Tax Invoice with same amount still produces a probable match hint on a Missing-in-2B Tax Invoice
    check('REM5-03b: Unbooked Tax Invoice of same supplier & amount still produces probable match hint on Missing-in-2B Tax Invoice', () => {
      const res = reconcilePurchases(
        [
          mkBook({
            invoice_no: 'TI-MISSING-02',
            document_type: 'Tax Invoice',
            taxable_value: 15000,
            igst: 2700,
            source_invoice_value: 17700,
            book_invoice_value: 17700,
            invoice_total: 17700,
            source_row: 1,
          }),
        ],
        [
          mk2b({
            invoice_no: 'TI-UNBOOKED-99',
            invoice_type: 'Regular',
            taxable_value: 15000,
            igst: 2700,
            invoice_value: 17700,
            source_row: 1,
          }),
        ],
      );
      const r = res.rows[0];
      assert.equal(r.status, 'Missing in 2B');
      assert.equal(r.suggested_2b_invoice_no, 'TI-UNBOOKED-99');
      assert.ok(r.match_hint?.includes('Probable 2B match: "TI-UNBOOKED-99"'));
    });

    // 4. Historical Recon PDF Section 6 includes Inv Val & Cess and renders cleanly on gst_erp_test
    await checkAsync('REM5-04: Historical Recon PDF Section 6 includes Inv Val & Cess columns with matching totals', async () => {
      const books: PurchaseBill[] = [
        mkBook({
          invoice_no: 'REM5-CESS-01',
          supplier_gstin: SUP_1,
          party_name: 'REM5 UT CESS VENDOR',
          taxable_value: 20000,
          igst: 0,
          cgst: 1800,
          sgst: 0,
          utgst: 1800,
          cess: 750,
          source_invoice_value: 24350,
          book_invoice_value: 24350,
          invoice_total: 24350,
          source_row: 1,
        }),
        mkBook({
          invoice_no: 'REM5-IGST-02',
          supplier_gstin: SUP_2,
          party_name: 'REM5 IGST VENDOR',
          taxable_value: 10000,
          igst: 1800,
          cgst: 0,
          sgst: 0,
          utgst: 0,
          cess: 250,
          source_invoice_value: 12050,
          book_invoice_value: 12050,
          invoice_total: 12050,
          source_row: 2,
        }),
      ];
      const twob: Gstr2bRecord[] = [
        mk2b({
          invoice_no: 'REM5-CESS-01',
          supplier_gstin: SUP_1,
          supplier_name: 'REM5 UT CESS VENDOR',
          taxable_value: 20000,
          igst: 0,
          cgst: 1800,
          sgst: 0,
          utgst: 1800,
          cess: 750,
          invoice_value: 24350,
          source_row: 1,
        }),
        mk2b({
          invoice_no: 'REM5-IGST-02',
          supplier_gstin: SUP_2,
          supplier_name: 'REM5 IGST VENDOR',
          taxable_value: 10000,
          igst: 1800,
          cgst: 0,
          sgst: 0,
          utgst: 0,
          cess: 250,
          invoice_value: 12050,
          source_row: 2,
        }),
      ];

      const pRes = await persistRun({ books, twob, reconByBundle: new Map() });
      assert.equal(pRes.ok, true, `persistRun failed: ${pRes.reason}`);
      await reconcileFinancialYear({ gstin: TEST_GSTIN, includeHistoricalPending: true, changedBy: 'rem5-test' });

      const report = await buildHistoricalReconReport({ gstin: TEST_GSTIN, periodMode: 'all', reportingDate: '2026-07-01' });
      assert.equal(report.allParityOk, true, 'All 10 parity checks must pass');
      assert.equal(report.booksSummary.invoiceValue, 36400);
      assert.equal(report.booksSummary.cess, 1000);

      const pdfBuf = await buildHistoricalReconPdf(report);
      assert.ok(pdfBuf.length > 3000, `PDF buffer too small: ${pdfBuf.length}`);
      assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-', 'Must start with %PDF-');
      assert.ok(pdfBuf.subarray(pdfBuf.length - 32).toString('ascii').includes('%%EOF'), 'Must end with %%EOF');

      const streamText = extractPdfStreamText(pdfBuf);
      // pdfkit encodes ASCII text as hex strings in some cases or literal strings; check hex or ascii
      const hasText = (needle: string): boolean => {
        if (streamText.includes(needle)) return true;
        const hex = Buffer.from(needle, 'ascii').toString('hex');
        return streamText.toLowerCase().includes(hex);
      };
      assert.ok(hasText('6. Complete Historical Books Bill-wise Register'), 'PDF must contain Section 6 heading');
      assert.ok(hasText('Inv Val'), 'Section 6 must include Inv Val column header');
      assert.ok(hasText('Cess'), 'Section 6 must include Cess column header');
      assert.ok(hasText('24,350.00'), 'Section 6 must render row Inv Val 24,350.00');
      assert.ok(hasText('750.00'), 'Section 6 must render row Cess 750.00');
      assert.ok(hasText('36,400.00'), 'Section 6 TOTAL row must render Inv Val total 36,400.00');
      assert.ok(hasText('1,000.00'), 'Section 6 TOTAL row must render Cess total 1,000.00');
    });

    console.log(`\n==================================================================`);
    console.log(`REM-5 Engine & PDF Perfection DB suite: ${passed} passed, 0 failed`);
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
