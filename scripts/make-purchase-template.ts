/**
 * Write the Purchase Register template to disk.
 *
 * The same two files the server hands out from
 * `/api/template/purchase-register.xlsx` and `.csv`. Kept as a script so the
 * file the accounts team fills in can be regenerated the moment a column
 * changes — `npm run template:purchase`.
 *
 * The header list lives in `src/app/template.ts` and is asserted against the
 * parser's own aliases by the test suite, so the file on disk can never drift
 * away from what the importer actually reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  purchaseTemplateBuffer,
  purchaseTemplateCsv,
  PURCHASE_TEMPLATE_COLUMNS,
} from '../src/app/template';

const dir = path.join(process.cwd(), 'templates');
fs.mkdirSync(dir, { recursive: true });

const xlsxPath = path.join(dir, 'Purchase Register Template.xlsx');
const csvPath = path.join(dir, 'Purchase Register Template.csv');

fs.writeFileSync(xlsxPath, purchaseTemplateBuffer({}));
// Excel needs the BOM to read a UTF-8 CSV as UTF-8.
fs.writeFileSync(csvPath, '\uFEFF' + purchaseTemplateCsv());

console.log(`wrote ${xlsxPath} (${fs.statSync(xlsxPath).size} bytes)`);
console.log(`wrote ${csvPath} (${fs.statSync(csvPath).size} bytes)`);
console.log(`${PURCHASE_TEMPLATE_COLUMNS.length} columns, ` +
  `${PURCHASE_TEMPLATE_COLUMNS.filter((c) => c.required).length} compulsory`);
