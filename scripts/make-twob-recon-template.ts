/**
 * Write the GSTR-2B vs Books invoice-to-invoice reconciliation template to disk.
 *
 * The same two files the server hands out from `/api/template/twob-recon.xlsx`
 * (blank skeleton) and `.csv`. Kept as a script so the file on the team's desktop
 * can be regenerated the moment a column changes — `npm run template:twob-recon`.
 *
 * The skeleton carries EXAMPLE rows, not the team's data: the real, pre-filled
 * working sheet is downloaded from the app with a GSTIN and a month, because it
 * is built from the reconciliation the software just ran.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  TWOB_RECON_LINE_COLUMNS,
  TWOB_RECON_INVOICE_COLUMNS,
  TWOB_RECON_WRITABLE_HEADERS,
  twobReconTemplateBuffer,
  twobReconTemplateCsv,
} from '../src/app/twob-recon-template';

const dir = path.join(process.cwd(), 'templates');
fs.mkdirSync(dir, { recursive: true });

const xlsxPath = path.join(dir, 'GSTR-2B vs Books - Invoice-wise Reconciliation Template.xlsx');
const csvPath = path.join(dir, 'GSTR-2B vs Books - Invoice-wise Reconciliation Template.csv');

fs.writeFileSync(xlsxPath, twobReconTemplateBuffer({}));
// No BOM is added here: `twobReconTemplateCsv()` already starts with one (the
// report layer puts it there), and prefixing a second would reach Excel as a
// stray character in the first header. This file is written byte-for-byte as the
// server sends it — a test compares the two.
fs.writeFileSync(csvPath, twobReconTemplateCsv());

console.log(`wrote ${xlsxPath} (${fs.statSync(xlsxPath).size} bytes)`);
console.log(`wrote ${csvPath} (${fs.statSync(csvPath).size} bytes)`);
console.log(`sheet 1 (invoice-wise): ${TWOB_RECON_INVOICE_COLUMNS.length} columns`);
console.log(`sheet 2 (line-wise):    ${TWOB_RECON_LINE_COLUMNS.length} columns, ` +
  `${TWOB_RECON_WRITABLE_HEADERS.length} fillable/uploadable`);
