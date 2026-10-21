/**
 * One-off utility: dump distinct values of unit/company/GSTIN-ish columns so
 * the masters can be seeded from what the source files actually say.
 *
 *   npx tsx scripts/dump-unit-columns.ts "D:\c drive\Desktop\GST Monthly Input"
 */

import XLSX from 'xlsx';

const dir = process.argv[2] || '.';
const WANT = /(gstin|gst no|company|unit|entity|plant|division|schedule)/i;

const files = [
  'GSTR-2B download Apr25-Mar26.xlsx',
  'Purchase Register Apr25-Mar26.xlsx',
  'Sakar -TB.xlsx',
  '26 AS Reconcilation.xlsx',
  'IGST Payable Reconcilation.xlsx',
];

for (const name of files) {
  const wb = XLSX.readFile(`${dir}\\${name}`, { cellDates: true });
  console.log(`\n########## ${name} :: ${wb.SheetNames.join(' | ')}`);

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || sheet['!ref'] === undefined) continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false, defval: '' });
    if (rows.length === 0) continue;

    // Column index -> the header texts seen in the first 25 rows.
    const header = new Map<number, Set<string>>();
    rows.slice(0, 25).forEach((r) =>
      r.forEach((c, i) => {
        const t = String(c ?? '').trim();
        if (t) (header.get(i) ?? header.set(i, new Set()).get(i)!).add(t);
      }),
    );

    const interesting = [...header.entries()]
      .filter(([, hs]) => [...hs].some((h) => WANT.test(h)))
      .map(([i]) => i);
    if (interesting.length === 0) continue;

    console.log(`\n--- sheet "${sheetName}" (${rows.length} rows)`);
    for (const i of interesting) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = String(r[i] ?? '').trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`  col[${i}] ${[...(header.get(i) ?? [])].join(' / ')}`);
      for (const [v, n] of top) console.log(`      ${n}x  ${v}`);
    }
  }
}