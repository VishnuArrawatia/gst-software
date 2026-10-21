/**
 * One-off utility: hunt GSTIN-shaped strings and unit/company labels across the
 * input folder so the masters get seeded from real data instead of guesses.
 *
 *   npx tsx scripts/scan-gstins.ts "D:\c drive\Desktop\GST Monthly Input"
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';

const dir = process.argv[2] || '.';
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/g;

function walk(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(xlsx|xlsm|xlsb|csv)$/i.test(e)) out.push(p);
    } catch {}
  }
  return out;
}

const found = new Map<string, Set<string>>(); // gstin -> files
const labelHits: Array<{ file: string; text: string }> = [];

for (const file of walk(dir)) {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(file, { cellDates: true });
  } catch {
    continue;
  }
  const texts: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
    for (const r of rows) for (const c of r) if (c !== '' && c != null) texts.push(String(c));
    texts.push(name);
  }
  for (const t of texts) {
    for (const m of t.matchAll(GSTIN)) {
      const g = m[0];
      if (!found.has(g)) found.set(g, new Set());
      found.get(g)!.add(file.split(/[\\/]/).pop()!);
    }
  }
  // Labels worth eyeballing: rows that mention a company name near a GSTIN word.
  const joined = texts.join('\n');
  if (/(GSTIN|GST No|GSTIN of Company)/i.test(joined)) {
    for (const t of texts) {
      if (/(GSTIN|GST No)/i.test(t) && t.length < 120) {
        labelHits.push({ file: file.split(/[\\/]/).pop()!, text: t.trim() });
        break;
      }
    }
  }
}

console.log('=== GSTINs found ===');
for (const [g, files] of [...found.entries()].sort()) {
  console.log(`\n${g}`);
  for (const f of files) console.log(`    ${f}`);
}

console.log('\n=== header-ish labels mentioning GSTIN ===');
const seen = new Set<string>();
for (const h of labelHits) {
  const k = `${h.file}|${h.text}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`  [${h.file}] ${h.text}`);
}