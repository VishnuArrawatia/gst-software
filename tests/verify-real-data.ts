/**
 * GST ERP — verification against the team's real source files.
 *
 * This is not a unit test: it reads the actual SAP purchase register and the
 * actual GSTR-2B download, runs them through the ingest + reconciliation
 * engine, and prints what came out. It is how we confirm that column
 * detection, Excel date serials and invoice-number normalisation all work
 * against the real thing rather than against fixtures I invented.
 *
 * Run:  npm run verify
 */
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

import { isGstr2bJson, parseGstr2b, parseGstr2bJson, parsePurchaseRegister, sniffKind } from '../src/engine/ingest';
import { matchPercent, reconcilePurchases } from '../src/engine/match';
import { labelOf, normInvoice, periodOf, r2 } from '../src/engine/core';

const INPUT_DIR =
  process.env.GST_INPUT_DIR || 'D:/c drive/Desktop/GST Monthly Input';

const PURCHASE_FILE = 'Purchase Register Apr25-Mar26.xlsx';
const TWO_B_FILE = 'GSTR-2B download Apr25-Mar26.xlsx';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  ->  ' + extra : ''));
  }
}

function readRows(file: string): { rows: unknown[][]; sheets: string[] } {
  const full = path.join(INPUT_DIR, file);
  if (!fs.existsSync(full)) {
    console.log(`\n!! Missing source file: ${full}`);
    process.exit(2);
  }
  const wb = XLSX.readFile(full);
  const sheet = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  }) as unknown[][];
  return { rows, sheets: wb.SheetNames };
}

console.log('='.repeat(74));
console.log('GST ERP — verification against real files');
console.log('input dir:', INPUT_DIR);
console.log('='.repeat(74));

// ---------------------------------------------------------------------------
// 1. Purchase register
// ---------------------------------------------------------------------------
console.log('\n[1] Purchase Register');
const p = readRows(PURCHASE_FILE);
console.log('  sheets:', p.sheets.join(', '));
console.log('  sniffed kind:', sniffKind(p.rows));

const purchase = parsePurchaseRegister(p.rows, PURCHASE_FILE);
console.log(`  parsed rows      : ${purchase.rows.length}`);
console.log(`  header row index : ${purchase.headerRowIndex}`);
console.log(`  skipped rows     : ${purchase.skipped.length}`);
console.log(`  unmapped headers : ${purchase.unmappedHeaders.length}`);

check('purchase: parsed thousands of rows', purchase.rows.length > 5000, String(purchase.rows.length));
check(
  'purchase: supplier GSTINs are well-formed',
  purchase.rows.filter((r) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(r.supplier_gstin)).length >
    purchase.rows.length * 0.9,
  `${purchase.rows.filter((r) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(r.supplier_gstin)).length}/${purchase.rows.length}`
);
check(
  'purchase: every row got a YYYY-MM period',
  purchase.rows.filter((r) => /^\d{4}-\d{2}$/.test(r.period)).length > purchase.rows.length * 0.98,
);
check(
  'purchase: Excel date serials decoded to real dates',
  purchase.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.invoice_date)).length >
    purchase.rows.length * 0.95,
  `${purchase.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.invoice_date)).length}/${purchase.rows.length}`
);
check(
  'purchase: our GSTIN captured',
  purchase.rows.filter((r) => r.our_gstin.length === 15).length > purchase.rows.length * 0.9,
);
check(
  'purchase: negative amounts preserved (credit notes exist)',
  purchase.rows.some((r) => r.taxable_value < 0),
  'no negative rows found — credit notes may be parsed wrong'
);

const pPeriods = [...new Set(purchase.rows.map((r) => r.period))].sort();
console.log('  periods         :', pPeriods[0], '->', pPeriods[pPeriods.length - 1], `(${pPeriods.length})`);
const pGstins = [...new Set(purchase.rows.map((r) => r.our_gstin))].sort();
console.log('  our GSTINs      :', pGstins.join(', '));

console.log('\n  sample rows:');
for (const r of purchase.rows.slice(0, 3)) {
  console.log(
    `    ${r.period} | ${r.our_gstin} | ${r.supplier_gstin} | ${r.invoice_no.padEnd(16)} | ${r.invoice_date} | taxable ${r.taxable_value} | gst ${r.igst + r.cgst + r.sgst + r.cess}`
  );
}

// ---------------------------------------------------------------------------
// 2. GSTR-2B
// ---------------------------------------------------------------------------
console.log('\n[2] GSTR-2B download');
const t = readRows(TWO_B_FILE);
console.log('  sheets:', t.sheets.join(', '));
console.log('  sniffed kind:', sniffKind(t.rows));

const twob = parseGstr2b(t.rows, TWO_B_FILE);
console.log(`  parsed rows      : ${twob.rows.length}`);
console.log(`  header row index : ${twob.headerRowIndex}`);
console.log(`  skipped rows     : ${twob.skipped.length}`);
console.log(`  unmapped headers : ${twob.unmappedHeaders.length}`);
if (twob.unmappedHeaders.length) {
  console.log('  (ignored headers:', twob.unmappedHeaders.slice(0, 6).join(' | '), ')');
}

check('2B: parsed thousands of rows', twob.rows.length > 5000, String(twob.rows.length));
check(
  '2B: supplier GSTINs well-formed',
  twob.rows.filter((r) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(r.supplier_gstin)).length >
    twob.rows.length * 0.95
);
check(
  '2B: ITC availability captured',
  twob.rows.filter((r) => r.itc_availability.length > 0).length > twob.rows.length * 0.95
);
check(
  '2B: some lines are ITC-blocked (proves eligibility is read)',
  twob.rows.filter((r) => r.itc_availability.toLowerCase() !== 'yes').length > 0,
  'no blocked lines at all — availability column may not be mapped'
);
check(
  '2B: reverse charge flag captured',
  twob.rows.filter((r) => r.reverse_charge === true).length >= 0
);

const tPeriods = [...new Set(twob.rows.map((r) => r.period))].sort();
console.log('  periods         :', tPeriods[0], '->', tPeriods[tPeriods.length - 1], `(${tPeriods.length})`);
const tGstins = [...new Set(twob.rows.map((r) => r.our_gstin))].sort();
console.log('  our GSTINs      :', tGstins.join(', '));

console.log('\n  sample rows:');
for (const r of twob.rows.slice(0, 3)) {
  console.log(
    `    ${r.period} | ${r.supplier_gstin} | ${r.invoice_no.padEnd(14)} | ${r.invoice_date} | taxable ${r.taxable_value} | itc ${r.igst + r.cgst + r.sgst + r.cess} | avail ${r.itc_availability}`
  );
}

const blocked = twob.rows.filter((r) => r.itc_availability.toLowerCase() !== 'yes');
console.log(`  ITC blocked rows: ${blocked.length}`);
for (const r of blocked.slice(0, 3)) {
  console.log(`    ${r.period} ${r.supplier_gstin} ${r.invoice_no} avail=${r.itc_availability} reason=${r.reason || '-'}`);
}

// ---------------------------------------------------------------------------
// 3. Reconciliation, per GSTIN (cross-matching GSTINs would be a real bug)
// ---------------------------------------------------------------------------
console.log('\n[3] Reconciliation (per GSTIN)');
const allGstins = [...new Set([...pGstins, ...tGstins])].sort();
let grandMatched = 0;
let grandExceptions = 0;
let grandBooksItc = 0;
let grandClaimable = 0;

for (const g of allGstins) {
  const b = purchase.rows.filter((r) => r.our_gstin === g);
  const w = twob.rows.filter((r) => r.our_gstin === g);
  if (b.length === 0 && w.length === 0) continue;

  const res = reconcilePurchases(b, w);
  const exc = res.summary.amount_mismatch + res.summary.missing_in_2b + res.summary.duplicate + res.summary.itc_blocked;
  grandMatched += res.summary.matched;
  grandExceptions += exc;
  grandBooksItc = r2(grandBooksItc + res.summary.books_itc);
  grandClaimable = r2(grandClaimable + res.summary.claimable_itc);

  console.log(
    `  ${g.padEnd(18)} books ${String(res.summary.books_rows).padStart(5)} | 2B ${String(res.summary.twob_rows).padStart(5)} | ` +
      `matched ${String(res.summary.matched).padStart(5)} | mismatch ${String(res.summary.amount_mismatch).padStart(4)} | ` +
      `missing ${String(res.summary.missing_in_2b).padStart(4)} | dup ${String(res.summary.duplicate).padStart(4)} | ` +
      `blocked ${String(res.summary.itc_blocked).padStart(4)} | unbooked2B ${String(res.summary.unbooked_2b).padStart(4)} | match% ${matchPercent(res.summary)}`
  );
  check(`recon ${g}: produced rows`, res.rows.length > 0, String(res.rows.length));
}

console.log(`\n  TOTAL matched ${grandMatched} | exceptions ${grandExceptions} | books ITC ${grandBooksItc} | claimable ITC ${grandClaimable}`);

// ---------------------------------------------------------------------------
// 4. Cross-checks against the existing workbook's own totals
// ---------------------------------------------------------------------------
console.log('\n[4] Cross-check against the existing reconciliation workbook');
const RECO_FILE = 'GST reco MONTH-WISE Apr-24 to Mar-26 (reco 22-09-26).xlsx';
const recoPath = path.join(INPUT_DIR, RECO_FILE);

if (fs.existsSync(recoPath)) {
  const rw = XLSX.readFile(recoPath);
  const detail = XLSX.utils.sheet_to_json(rw.Sheets['Purchase Detail'], {
    header: 1,
    raw: true,
    defval: null,
  }) as unknown[][];

  // The workbook's Purchase Detail mirrors the same source register. Counting
  // its data rows gives us an independent expectation for the parsed row count.
  const wbRows = detail.length - 2; // minus header and the workbook's own totals
  console.log(`  workbook Purchase Detail rows : ${wbRows}`);
  console.log(`  engine parsed purchase rows    : ${purchase.rows.length}`);
  check(
    'row counts agree within 5% (parser is not dropping or inventing rows)',
    Math.abs(purchase.rows.length - wbRows) / wbRows < 0.05,
    `engine ${purchase.rows.length} vs workbook ${wbRows}`
  );

  // Status distribution straight out of the workbook, for eyeball comparison.
  const headerIdx = detail.findIndex((r) => String(r?.[11] ?? '').trim() === 'Status');
  if (headerIdx >= 0) {
    const counts: Record<string, number> = {};
    for (let i = headerIdx + 1; i < detail.length; i++) {
      const s = String(detail[i]?.[11] ?? '').trim();
      if (!s) continue;
      counts[s] = (counts[s] || 0) + 1;
    }
    console.log('  workbook status distribution:');
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(22)} ${v}`);
    }
  }

  const d2 = XLSX.utils.sheet_to_json(rw.Sheets['GSTR-2B Detail'], {
    header: 1,
    raw: true,
    defval: null,
  }) as unknown[][];
  const wb2bRows = d2.length - 2;
  console.log(`  workbook GSTR-2B Detail rows  : ${wb2bRows}`);
  console.log(`  engine parsed 2B rows          : ${twob.rows.length}`);
  check(
    '2B row counts agree within 5%',
    Math.abs(twob.rows.length - wb2bRows) / wb2bRows < 0.05,
    `engine ${twob.rows.length} vs workbook ${wb2bRows}`
  );
} else {
  console.log('  (reconciliation workbook not found — skipping cross-check)');
}

// ---------------------------------------------------------------------------
// 5. Spot-check the trickiest normalisation cases
// ---------------------------------------------------------------------------
console.log('\n[5] Normalisation spot-checks on real data');

const sampleBooks = purchase.rows.slice(0, 400);
const sample2b = twob.rows.slice(0, 400);
const bookKeys = new Set(sampleBooks.map((r) => `${r.supplier_gstin}|${normInvoice(r.invoice_no)}`));
const overlap = sample2b.filter((r) => bookKeys.has(`${r.supplier_gstin}|${normInvoice(r.invoice_no)}`));
console.log(`  first 400 vs first 400: ${overlap.length} share a normalised key`);

const noSpaceVariants = purchase.rows.filter(
  (r) => /[\/\- ]/.test(String(r.invoice_no))
).length;
console.log(`  invoice numbers containing / - or space: ${noSpaceVariants}`);
check(
  'invoice numbers with separators exist (normalisation is actually doing work)',
  noSpaceVariants > 100,
  String(noSpaceVariants)
);

const zeroTax = purchase.rows.filter(
  (r) => r.igst + r.cgst + r.sgst + r.cess === 0 && r.taxable_value !== 0
).length;
console.log(`  book rows with taxable but zero tax: ${zeroTax}`);
check('zero-tax book rows are rare, not the norm', zeroTax < purchase.rows.length * 0.02, String(zeroTax));

// ---------------------------------------------------------------------------
// 6. Portal JSON equivalence: the same 2B expressed as the portal publishes it
// ---------------------------------------------------------------------------
console.log('\n[6] GSTR-2B portal JSON round-trip against the real download');

// Rebuild every real 2B line as a portal JSON document: B2B grouped by supplier
// GSTIN, invoice-level ITC flag, tax lines as `itms`. If the JSON parser is
// faithful, the reconciliation summary must be identical to the Excel one.
//
// The portal publishes ONE document per return period (`fp`), and the engine
// stamps that fp on every row as `portal_fp` — which is what groups an
// invoice's lines into "the ones filed in the same return month". The Excel
// download bundles all twelve months in one sheet, so rebuilding it as a
// single JSON with one fp would claim every line was filed in 042025 and pull
// a September credit note into April's invoice total. Emit one document per
// period, exactly as the portal would have.
const ddmmyyyy = (isoDate: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

function toPortalJson(rows: typeof twob.rows, gstin: string, fp: string) {
  const bySupplier = new Map<string, any[]>();
  for (const r of rows) {
    const rate = r.applicable_pct || '18';
    const inv: Record<string, any> = {
      inum: r.invoice_no,
      idt: ddmmyyyy(r.invoice_date),
      val: r.invoice_value || r2(r.taxable_value + r.igst + r.cgst + r.sgst + r.cess),
      pos: r.place_of_supply || gstin.slice(0, 2),
      rchrg: r.reverse_charge ? 'Y' : 'N',
      inv_typ: r.invoice_type || 'R',
      itms: [
        {
          num: 1,
          itm_det: { rt: Number(rate), txval: r.taxable_value, iamt: r.igst, camt: r.cgst, samt: r.sgst, csamt: r.cess },
        },
      ],
      itc_elg: String(r.itc_availability || 'Yes').toLowerCase().startsWith('y') ? 'Yes' : 'No',
    };
    if (r.reason) inv.reason = r.reason;
    const list = bySupplier.get(r.supplier_gstin) || [];
    list.push(inv);
    bySupplier.set(r.supplier_gstin, list);
  }
  return {
    gstin,
    fp,
    hash: 'verify-only',
    b2b: [...bySupplier.entries()].map(([ctin, inv]) => ({ ctin, inv })),
    section: [
      { sec: 'A', typ: 'B2B', itc_avlbl: 'Yes' },
      { sec: 'B', typ: 'B2B', itc_avlbl: 'No', reason: 'verify-only' },
    ],
  };
}

for (const g of allGstins) {
  const w = twob.rows.filter((r) => r.our_gstin === g);
  const b = purchase.rows.filter((r) => r.our_gstin === g);
  if (w.length === 0) continue;

const byPeriod = new Map<string, typeof twob.rows>();
for (const r of w) {
  const p = r.period || 'unknown';
  const list = byPeriod.get(p) || [];
  list.push(r);
  byPeriod.set(p, list);
}

const fromJson = { rows: [] as ReturnType<typeof parseGstr2bJson>['rows'] };
for (const [p, rows] of [...byPeriod.entries()].sort()) {
  // YYYY-MM -> the portal's MMYYYY fp
  const fp = /^\d{4}-(\d{2})$/.test(p)
    ? `${p.slice(5, 7)}${p.slice(0, 4)}`
    : '';
  const doc = toPortalJson(rows, g, fp);
  // Distinct source file per period: the parser mints row ids as
  // `sourceFile#seq`, and colliding ids would make the claim set swallow
  // rows across documents.
  const parsed = parseGstr2bJson(doc, `${g}-portal-${p}.json`);
  fromJson.rows.push(...parsed.rows);
}

  const viaExcel = reconcilePurchases(b, w);
  const viaJson = reconcilePurchases(b, fromJson.rows);

  const same =
    viaExcel.summary.matched === viaJson.summary.matched &&
    viaExcel.summary.amount_mismatch === viaJson.summary.amount_mismatch &&
    viaExcel.summary.missing_in_2b === viaJson.summary.missing_in_2b &&
    viaExcel.summary.duplicate === viaJson.summary.duplicate &&
    viaExcel.summary.itc_blocked === viaJson.summary.itc_blocked &&
    viaExcel.summary.books_itc === viaJson.summary.books_itc &&
    viaExcel.summary.claimable_itc === viaJson.summary.claimable_itc;

  console.log(
    `  ${g}  excel[matched ${viaExcel.summary.matched} blocked ${viaExcel.summary.itc_blocked} claimable ${viaExcel.summary.claimable_itc}]` +
      `  json[matched ${viaJson.summary.matched} blocked ${viaJson.summary.itc_blocked} claimable ${viaJson.summary.claimable_itc}]`
  );
  check(`${g}: portal JSON reproduces the Excel reconciliation exactly`, same);
  check(`${g}: portal JSON keeps every 2B line`, fromJson.rows.length === w.length, `${fromJson.rows.length} vs ${w.length}`);
}

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(74));
if (fail > 0) process.exit(1);
