/**
 * One-off utility: for each GSTIN we care about, list the party names it is
 * filed under across the input folder. Confirms the master names before seeding.
 *
 *   npx tsx scripts/probe-pans.ts "D:\c drive\Desktop\GST Monthly Input"
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';

const dir = process.argv[2] || '.';
const TARGETS = ['26AALCS9985J1ZC', '24AALCS9985J1ZG', '26ABFCS9511H1Z7', '24AALFN8258J1ZR'];
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/;

const names = new Map<string, Map<string, number>>();
const pans = new Map<string, Set<string>>();
const states = new Map<string, Set<string>>();

const files: string[] = [];
for (const e of readdirSync(dir)) {
  const p = join(dir, e);
  if (statSync(p).isDirectory()) continue;
  if (/\.(xlsx|xlsm|xlsb|csv)$/i.test(e)) files.push(p);
}

for (const file of files) {
  const wb = XLSX.readFile(file, { cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || sheet['!ref'] === undefined) continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false, defval: '' });

    for (const row of rows) {
      const cells = (row || []).map((c) => String(c ?? '').trim());
      const g = cells.find((c) => TARGETS.includes(c));
      if (!g) continue;

      const nameIdx = cells.findIndex((c) => /[A-Za-z]{4}/.test(c) && !GSTIN.test(c) && !PAN.test(c) && c.length > 4 && c.length < 70);
      const label = nameIdx >= 0 ? cells[nameIdx] : '';
      if (label) {
        if (!names.has(g)) names.set(g, new Map());
        const m = names.get(g)!;
        m.set(label, (m.get(label) ?? 0) + 1);
      }
      for (const c of cells) {
        const p = c.match(PAN);
        if (p && TARGETS.some((t) => t.includes(p[0]))) {
          if (!pans.has(g)) pans.set(g, new Set());
          pans.get(g)!.add(p[0]);
        }
      }
      // Place of supply / state name mentions on the same row.
      const pos = cells.find((c) => /Gujarat|Madhya Pradesh|Dadra|Daman|Diu|Nagar Haveli/i.test(c));
      if (pos) {
        if (!states.has(g)) states.set(g, new Set());
        states.get(g)!.add(pos);
      }
    }
  }
}

for (const g of TARGETS) {
  console.log(`\n===== ${g}`);
  console.log(`  PAN(s): ${[...(pans.get(g) ?? [])].join(', ') || '(none)'}`);
  console.log(`  state mentions: ${[...(states.get(g) ?? [])].slice(0, 5).join(' | ') || '(none)'}`);
  const m = names.get(g);
  if (m) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log('  names:');
    for (const [n, c] of top) console.log(`    ${c}x  ${n}`);
  } else {
    console.log('  names: (none found)');
  }
}