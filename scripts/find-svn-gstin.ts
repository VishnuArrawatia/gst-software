/**
 * One-off utility: find where "SVN" appears and what GSTIN sits near it, so
 * SVN's GSTIN can be seeded into the masters.
 *
 *   npx tsx scripts/find-svn-gstin.ts "D:\c drive\Desktop\GST Monthly Input"
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';

const dir = process.argv[2] || '.';
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/;
const SVN = /svn/i;

const files: string[] = [];
for (const e of readdirSync(dir)) {
  const p = join(dir, e);
  if (statSync(p).isDirectory()) continue;
  if (/\.(xlsx|xlsm|xlsb)$/i.test(e)) files.push(p);
}

const nearby = new Map<string, Set<string>>(); // gstin -> context strings

for (const file of files) {
  const wb = XLSX.readFile(file, { cellDates: true });
  const base = file.split(/[\\/]/).pop()!;
  let printed = 0;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || sheet['!ref'] === undefined) continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false, defval: '' });

    for (let i = 0; i < rows.length; i++) {
      const cells = (rows[i] || []).map((c) => String(c ?? '').trim());
      const joined = cells.join(' | ');
      if (!SVN.test(joined)) continue;

      // GSTINs in this row, this column, and the row above/below (labels often
      // sit in a merged title row rather than the data row).
      const window = [rows[i - 1], rows[i], rows[i + 1]]
        .filter(Boolean)
        .flat()
        .map((c) => String(c ?? '').trim());
      for (const w of window) {
        const m = w.match(GSTIN);
        if (!m) continue;
        if (!nearby.has(m[0])) nearby.set(m[0], new Set());
        nearby.get(m[0])!.add(`${base} :: ${sheetName} :: ${joined.slice(0, 160)}`);
      }
      if (printed < 12) {
        console.log(`[${base}] row ${i + 1} (${sheetName}): ${joined.slice(0, 200)}`);
        printed++;
      }
    }
  }
}

console.log('\n=== GSTINs seen within 1 row of an "SVN" mention ===');
for (const [g, ctx] of nearby) {
  console.log(`\n${g}   (${ctx.size} contexts)`);
  for (const c of [...ctx].slice(0, 4)) console.log(`    ${c}`);
}