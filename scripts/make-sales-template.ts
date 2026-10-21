/**
 * Write the Sales Register (GSTR-1 input) template to disk.
 *
 * The same two files the server hands out from
 * `/api/template/sales-register.xlsx` and `.csv`. Kept as a script so the file
 * on the team's desktop can be regenerated the moment a column changes —
 * `npm run template:sales`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { salesTemplateBuffer, salesTemplateCsv, SALES_TEMPLATE_COLUMNS } from '../src/app/sales-template';

const dir = path.join(process.cwd(), 'templates');
fs.mkdirSync(dir, { recursive: true });

const xlsxPath = path.join(dir, 'Sales Register Template.xlsx');
const csvPath = path.join(dir, 'Sales Register Template.csv');

fs.writeFileSync(xlsxPath, salesTemplateBuffer({}));
// Excel needs the BOM to read a UTF-8 CSV as UTF-8.
fs.writeFileSync(csvPath, '\uFEFF' + salesTemplateCsv());

console.log(`wrote ${xlsxPath} (${fs.statSync(xlsxPath).size} bytes)`);
console.log(`wrote ${csvPath} (${fs.statSync(csvPath).size} bytes)`);
console.log(`${SALES_TEMPLATE_COLUMNS.length} columns, ` +
  `${SALES_TEMPLATE_COLUMNS.filter((c) => c.required).length} compulsory`);
