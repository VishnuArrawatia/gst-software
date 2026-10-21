/**
 * Build a realistic GSTR-1 portal export for testing the import route.
 *
 * Shaped like the actual portal download: a cover sheet, a rate-WISE b2b sheet
 * where one invoice occupies several rows with the invoice value repeated, a
 * b2cs sheet with no invoice numbers at all, and negative figures in Indian
 * digit grouping. Four deliberate defects are planted so the comparison has
 * something to find.
 */

import { loadEnv, pgConfig } from '../src/config/env';
loadEnv();

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { Client } from 'pg';
import { isoDate } from '../src/engine/core';

const GSTIN = process.env.G || '26AALCS9985J1ZC';
const PERIOD = process.env.P || '2026-03';
const OUT = path.join(process.cwd(), 'output', 'gstr1-export-sample.xlsx');

async function main() {
  // Connection comes from .env like every other entry point. This script used
  // to carry a hardcoded password and a hardcoded `gst_erp`, so it could never
  // be pointed anywhere else — and a credential belonged in a file that is not
  // even git-ignored.
  const c = new Client(pgConfig());
  await c.connect();
  const r = await c.query(
    `SELECT table_type::text, invoice_number_raw, invoice_number_norm, invoice_date, invoice_type,
            recipient_gstin_raw, recipient_name, place_of_supply, taxable_value, igst, cgst, sgst, cess, invoice_value
       FROM gstr1_documents
      WHERE gstin_id=(SELECT id FROM gstins WHERE gstin_number=$1) AND period=$2 AND source='draft'
      ORDER BY id`,
    [GSTIN, PERIOD],
  );
  await c.end();

  const docs = r.rows;
  if (!docs.length) throw new Error(`no draft rows for ${GSTIN} ${PERCENT_FOR_PERIOD()}`);

  // Plant four defects.
  const b2b = docs.filter((d) => d.table_type === 'B2B');
  const dropIdx = 5;                       // -> Not Declared
  const amountIdx = 9;                     // -> Amount Mismatch (shave 100 off)
  const tableIdx = 12;                     // -> Table Mismatch (move B2B -> B2CL)
  const kept = b2b.filter((_, i) => i !== dropIdx);

  const B2B_HEADERS = ['GSTIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice Date',
    'Invoice Value(₹)', 'Place Of Supply', 'Reverse Charge', 'Rate',
    'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'];

  const inrFmt = (n: number) => {
    const s = Math.abs(n).toFixed(2);
    const [i, d] = s.split('.');
    const last3 = i.slice(-3);
    const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + (rest ? rest + ',' : '') + last3 + '.' + d;
  };

  const b2bRows: unknown[][] = [B2B_HEADERS];
  kept.forEach((doc, i) => {
    const rate = 18;
    const half = Number(doc.taxable_value) / 2;
    const ig = Number(doc.igst) / 2;
    const cg = Number(doc.cgst) / 2;
    const sg = Number(doc.sgst) / 2;
    // The planted difference has to hit the tax as well as the taxable value.
    // A document whose taxable is short but whose tax is untouched is not a
    // document the portal would ever hold — and it would make the rupee
    // headline read zero on a row that is genuinely short.
    const shaved = i === amountIdx;
    const value = Number(doc.invoice_value) - (shaved ? 100 : 0);
    const taxShave = shaved ? 9 : 0;
    const push = (t: number, a: number, b: number, s: number) => {
      b2bRows.push([
        doc.recipient_gstin_raw || '', doc.recipient_name || '', doc.invoice_number_raw,
        isoDate(doc.invoice_date), inrFmt(value), doc.place_of_supply || '', 'N', rate,
        inrFmt(t), inrFmt(a), inrFmt(b), inrFmt(s), '0.00',
      ]);
    };
    if (shaved) {
      push(half - 100, ig - taxShave, cg, sg);
      push(Number(doc.taxable_value) - half, Number(doc.igst) - ig, Number(doc.cgst) - cg, Number(doc.sgst) - sg);
      return;
    }
    push(half, ig, cg, sg);
    push(Number(doc.taxable_value) - half, Number(doc.igst) - ig, Number(doc.cgst) - cg, Number(doc.sgst) - sg);
  });

  // The planted table mismatch: an invoice the books draft into B2B but which
  // was actually filed as B2CL. It has to live on its OWN sheet, because the
  // portal names the table in the tab name — appending the row to b2b would
  // just fold it into the existing invoice.
  const moved = kept[tableIdx];
  const B2CL_HEADERS = ['GSTIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice Date',
    'Invoice Value(₹)', 'Place Of Supply', 'Reverse Charge', 'Rate',
    'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'];
  const b2clRows: unknown[][] = [B2CL_HEADERS];
  if (moved) {
    b2clRows.push([
      '', moved.recipient_name || '', moved.invoice_number_raw,
      isoDate(moved.invoice_date), inrFmt(Number(moved.invoice_value)), moved.place_of_supply || '', 'N', 18,
      inrFmt(Number(moved.taxable_value)), inrFmt(Number(moved.igst)), inrFmt(Number(moved.cgst)),
      inrFmt(Number(moved.sgst)), '0.00',
    ]);
  }

  const B2CS_HEADERS = ['Type', 'Supply Attract Reverse Charge', 'Place Of Supply', 'Rate',
    'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'];
  const b2csRows: unknown[][] = [B2CS_HEADERS,
    ['B2CS', 'N', '24', '18', inrFmt(50000), inrFmt(9000), '0.00', '0.00', '0.00']];

  const wb = XLSX.utils.book_new();
  // A cover sheet first, because the real download has one and a parser that
  // trusts SheetNames[0] would return nothing from this file.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['GSTR-1 — sample export'],
    ['This file was generated to exercise the import route. It is not a real return.'],
    ['GSTIN of Recipient / Invoice Number / Taxable Value are all mentioned here,'],
    ['so a parser that reads note text instead of headers will look fine and be wrong.'],
  ]), 'Read me');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2bRows), 'b2b');
  if (b2clRows.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2clRows), 'b2cl');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2csRows), 'b2cs');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  console.log('written', OUT);
  console.log('  b2b rate lines :', b2bRows.length - 1, 'for', kept.length, 'invoices');
  console.log('  planted: dropped invoice at index', dropIdx,
    '| shaved 100 off index', amountIdx,
    '| moved index', tableIdx, 'onto its own b2cl sheet',
    '| one B2CS row with no invoice number');
}
function PERCENT_FOR_PERIOD() { return PERIOD; }

main().catch((e) => { console.error(e); process.exit(1); });