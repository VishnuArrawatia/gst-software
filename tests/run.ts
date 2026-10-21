/**
 * GST ERP — unit tests for the engine.
 *
 * These use hand-built fixtures so each rule is pinned to a specific expected
 * number. The real-data check lives in verify-real-data.ts; this file is the one
 * that fails loudly when a rule changes.
 */
import {
  excelSerialToIso,
  effectiveRate,
  fyOf,
  isValidGstin,
  isoDate,
  labelOf,
  monthRange,
  normDate,
  normGstin,
  normInvoice,
  normPos,
  periodFromAny,
  r2,
  supplyType,
  taxOf,
  type Gstr2bRecord,
  type PurchaseBill,
  type SalesInvoice,
} from '../src/engine/core';
import { detectField, findHeaderRow, mapHeaders, normaliseHeader } from '../src/engine/columns';
import { isGstr2bJson, parseGstr2b, parseGstr2bJson, parsePurchaseRegister, parseSalesRegister, sniffKind } from '../src/engine/ingest';
import { reconcilePurchases } from '../src/engine/match';
import { summarisePurchaseDocuments } from '../src/app/purchase-summary';
import { buildGstr1, gstr1PortalJson, gstr1SheetRows } from '../src/engine/gstr1';
import {
  GSTR1_TABLES,
  TABLE_LABEL,
  b2csKey,
  classifyFiled,
  classifyFiledRows,
  countOutcomes,
  draftDocuments,
  foldFiledB2cs,
  parseTableType,
  reconcile,
  summarise,
  type Gstr1Document,
} from '../src/engine/gstr1-recon';
import { detectTable, parseFiledWorkbook, parseMoney } from '../src/engine/gstr1-import';
import { buildGstr3b, gstr3bWorkingRows, itcDetailFromRecon } from '../src/engine/gstr3b';
import XLSX from 'xlsx';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra?: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name);
    console.log('  FAIL  ' + name + (extra ? '  ->  ' + extra : ''));
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(title: string) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------------------
section('1. normalisation');
// ---------------------------------------------------------------------------
eq('GSTIN strips spaces and case', normGstin(' 24 aa cs 9012 j1z3 '), '24AACS9012J1Z3');
check('GSTIN format check passes', isValidGstin('24AAACS9012J1Z3'), 'fixture GSTIN is malformed');
check('bad GSTIN length rejected', !isValidGstin('24AAACS9012J1Z3X'));
check('GSTIN with Z position wrong rejected', !isValidGstin('24AAACS9012ZJ1'));

eq('invoice strips slash', normInvoice('INV/001'), 'INV001');
eq('invoice strips space', normInvoice('INV 001'), 'INV001');
eq('invoice strips dash and case', normInvoice('inv-001'), 'INV001');
eq('all four spellings are the same key', new Set([normInvoice('INV/001'), normInvoice('INV 001'), normInvoice('inv001'), normInvoice('INV001')]).size, 1);

eq('Excel serial 45748 -> 2025-04-01', excelSerialToIso(45748), '2025-04-01');
eq('Excel serial 45383 -> 2024-04-01', excelSerialToIso(45383), '2024-04-01');
eq('date dd/mm/yyyy', normDate('15/04/2025'), '2025-04-15');
eq('date yyyy-mm-dd', normDate('2025-04-15'), '2025-04-15');
eq('date d-Mon-yyyy', normDate('02-Sep-2025'), '2025-09-02');
eq('date serial as string', normDate('45748'), '2025-04-01');
eq('bare 2-digit year is not a date', normDate('24'), '');
eq('blank stays blank', normDate(''), '');
eq('month 13 rejected', normDate('15/13/2025'), '');

eq('period from YYYY-MM', periodFromAny('2025-04'), '2025-04');
eq('period from Apr-25', periodFromAny('Apr-25'), '2025-04');
eq("period from Apr'25", periodFromAny("Apr'25"), '2025-04');
eq('period from serial', periodFromAny(45748), '2025-04');
eq('period from blank', periodFromAny(''), '');
eq('period from junk', periodFromAny('n/a'), '');

eq('place of supply name -> code', normPos('Gujarat'), '24');
eq('place of supply code passthrough', normPos('27'), '27');
eq('place of supply long form', normPos('Dadra and Nagar Haveli and Daman and Diu'), '26');

eq('supply type intra-state', supplyType('24AAAAA0000A1Z3', '24BBBBB0000B1Z3').isInterState, false);
eq('supply type inter-state', supplyType('24AAAAA0000A1Z3', '27BBBBB0000B1Z3').isInterState, true);
eq('POS fallback used when customer GSTIN absent', supplyType('24AAAAA0000A1Z3', '', 'Maharashtra').pos, '27');
eq('defaults to inter-state when nothing known', supplyType('24AAAAA0000A1Z3', '').isInterState, true);

eq('taxOf sums components', taxOf({ igst: 100, cgst: 50, sgst: 50, cess: 2 }), 202);
eq('r2 handles junk', r2('abc'), 0);
eq('r2 rounds half up', r2(1.005), 1.01);

eq('effective rate 18% IGST', effectiveRate(100000, 18000), 18);
eq('effective rate 18% split into CGST + SGST', effectiveRate(100000, 9000 + 9000), 18);
eq('effective rate 12% split', effectiveRate(100000, 6000 + 6000), 12);
eq('effective rate snaps an odd amount to the nearest slab', effectiveRate(100000, 18010), 18);
eq('effective rate on negative credit note uses absolute', effectiveRate(-100000, -18000), 18);
eq('zero taxable -> zero rate', effectiveRate(0, 0), 0);

eq('label Apr-25', labelOf('2025-04'), 'Apr-25');
eq('fy of Apr-25', fyOf('2025-04'), '2025-26');
eq('fy of Mar-26', fyOf('2026-03'), '2025-26');
eq('monthRange across FY', monthRange('2025-04', '2025-07'), ['2025-04', '2025-05', '2025-06', '2025-07']);
eq('monthRange across year boundary', monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);

// ---------------------------------------------------------------------------
section('2. column detection');
// ---------------------------------------------------------------------------
eq('detects "GSTIN of supplier"', detectField('GSTIN of supplier'), 'supplier_gstin');
eq('detects "Our GSTN"', detectField('Our GSTN'), 'our_gstin');
eq('detects "IGST Input"', detectField('IGST Input'), 'igst');
eq('detects "2B Month"', detectField('2B Month'), 'period');
eq('detects "ITC Availability"', detectField('ITC Availability'), 'itc_availability');
eq('detects "Invoice Value (Rs)" style header', detectField('Invoice Value (₹)'), 'invoice_value');
eq('unknown header returns null', detectField('Coding'), null);
eq('header normalisation strips punctuation', normaliseHeader('Taxable  Value  (₹)'), 'taxable value');

eq('2B Month beats Month for period', mapHeaders(['Month', '2B Month']).map.get(1), 'period');
eq('month column is superseded, not first-wins', [...mapHeaders(['Month', '2B Month']).map.values()].filter((v) => v === 'period').length, 1);

eq('header row detection skips a title banner', findHeaderRow([['GST Report 2025'], ['Invoice No', 'GSTIN'], ['A', 'B']], ['invoice_no', 'supplier_gstin']), 1);

// A bare "GSTIN" column means a different thing on each side of the ledger.
eq('bare GSTIN in a sales file means the CUSTOMER', detectField('GSTIN', { profile: 'sales' }), 'customer_gstin');
eq('bare GSTIN in a purchase file means the SUPPLIER', detectField('GSTIN', { profile: 'purchase' }), 'supplier_gstin');
eq('bare GSTIN in a 2B file means the SUPPLIER', detectField('GSTIN', { profile: 'twob' }), 'supplier_gstin');
eq('an explicit "GSTIN of recipient" is always the customer', detectField('GSTIN of recipient', { profile: 'sales' }), 'customer_gstin');
eq('"Our GSTN" is never reassigned', detectField('Our GSTN', { profile: 'sales' }), 'our_gstin');

// ---------------------------------------------------------------------------
section('3. parsing (totals rows must be rejected)');
// ---------------------------------------------------------------------------
const sapRows = [
  ['Month', 'Our GSTN', 'Supplier Invoice', 'Supplier Invoice Date', 'GSTIN/UIN', 'Taxable Value', 'IGST Input', 'CGST Input', 'UTGST Input', '2B Month'],
  [45748, '26AALCS9985J1ZC', 'INV-1', 45762, '24AAACS9012J1Z3', 10000, 0, 900, 900, "Apr'25"],
  [45748, '26AALCS9985J1ZC', 'CN-2', 45762, '24AAACS9012J1Z3', -500, 0, -45, -45, ''],
  ['Grand Total', '', '', '', '', 9500, 0, 855, 855, ''],
];
const parsed = parsePurchaseRegister(sapRows, 'test.xlsx');
eq('purchase: 2 data rows (totals rejected)', parsed.rows.length, 2);
eq('purchase: period from 2B Month label', parsed.rows[0].period, '2025-04');
eq('purchase: falls back to invoice date when 2B Month blank', parsed.rows[1].period, '2025-04');
eq('purchase: credit note keeps negative taxable', parsed.rows[1].taxable_value, -500);
eq('purchase: rows get a stable id', parsed.rows[0].id, 'test.xlsx#2');

const twobRows = [
  ['GSTIN of Company', 'GSTIN of supplier', 'Trade/Legal name', 'Invoice number', 'Invoice Date', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'ITC Availability', 'Reason'],
  ['26AALCS9985J1ZC', '24AAACS9012J1Z3', 'ABC Ltd', 'INV-1', 45762, 10000, 0, 900, 900, 'Yes', ''],
  ['26AALCS9985J1ZC', '27AAXYZ1234C1Z5', 'DEF Ltd', 'INV-9', 45762, 1000, 180, 0, 0, 'No', 'POS mismatch'],
];
const parsed2b = parseGstr2b(twobRows, '2b.xlsx');
eq('2B: 2 rows', parsed2b.rows.length, 2);
eq('2B: eligibility captured', parsed2b.rows[1].itc_availability, 'No');
eq('2B: reason captured', parsed2b.rows[1].reason, 'POS mismatch');

const salesRows = [
  ['Invoice Date', 'Invoice No', 'Customer Name', 'GSTIN', 'Taxable Amount', 'IGST AMT', 'CGST AMT', 'UTGST AMT', 'Invoice Value'],
  [45762, 'SVN/2526/10', 'PANASONIC', '27AAECA2190C1Z3', 177120, 31881.6, 0, 0, 209001.6],
];
const parsedSales = parseSalesRegister(salesRows, 'sales.xlsx');
eq('sales: 1 row', parsedSales.rows.length, 1);
eq('sales: period from date', parsedSales.rows[0].period, '2025-04');
eq('sales: customer gstin', parsedSales.rows[0].customer_gstin, '27AAECA2190C1Z3');

// CHANGES EXPRESSLY FOR THE REAL SAP EXPORT (test-input/…/SAP Sales Register…):
// CardCode Name -> CARD_CODE, Customer Name -> CUSTOMER_NAME, ToLocation -> POS.
const sapHead = ['Invoice Date', 'Invoice No', 'CardCode Name', 'Customer Name', 'GSTIN',
  'ToLocation', 'Taxable Amount', 'IGST AMT', 'CGST AMT', 'UTGST AMT', 'Invoice Value'];
eq('SAP: CardCode Name is the customer CODE, not the legal name',
  detectField('CardCode Name', { profile: 'sales' }), 'card_code');
eq('SAP: Customer Name is the customer name', detectField('Customer Name', { profile: 'sales' }), 'customer_name');
eq('SAP: ToLocation is the place of supply', detectField('ToLocation', { profile: 'sales' }), 'place_of_supply');
eq('SAP: UTGST AMT feeds SGST/UTGST (it was dropped and every intra-state value check failed by exactly the UTGST amount)',
  detectField('UTGST AMT', { profile: 'sales' }), 'sgst');

{
  const rows = [
    sapHead,
    [45756, 'SVN/2526/10', 'C00001', 'PANASONIC LIFE SOLUTIONS INDIA PVT LTD', '27AAECA2190C1Z3',
      'Bhiwandi', 344083, 0, 30967.47, 30967.47, 406017.94],
  ];
  const p = parseSalesRegister(rows, 'sap sales.xlsx');
  eq('SAP: 1 row parsed', p.rows.length, 1);
  eq('SAP: customer name (NOT the card code)', p.rows[0].customer_name, 'PANASONIC LIFE SOLUTIONS INDIA PVT LTD');
  eq('SAP: card code carries the C00001', (p.rows[0] as any).card_code, 'C00001');
  eq('SAP: POS column lands in place_of_supply (city name kept verbatim — Bhiwandi is a city and must not be guessed to a state)',
    p.rows[0].place_of_supply, 'Bhiwandi');
  eq('SAP: UTGST captured as SGST so invoice value adds UP', p.rows[0].sgst, 30967.47);
  eq('SAP: invoice amount checks', (p.rows[0].taxable_value + (p.rows[0].igst + p.rows[0].cgst + p.rows[0].sgst + p.rows[0].cess)) === p.rows[0].invoice_value, true);
  eq('SAP: not item-level (no item columns present)', p.itemLevel, false);
  eq('SAP: no unmapped headers', p.unmappedHeaders.length, 0);
}

// ---------------------------------------------------------------------------
section('4. reconciliation rules');
// ---------------------------------------------------------------------------
const BILL = (o: Partial<PurchaseBill> & { invoice_no: string }): PurchaseBill => ({
  our_gstin: '26AALCS9985J1ZC',
  party_name: 'Vendor',
  invoice_date: '2025-04-10',
  period: '2025-04',
  taxable_value: 10000,
  igst: 1800,
  cgst: 0,
  sgst: 0,
  cess: 0,
  ...o,
  supplier_gstin: o.supplier_gstin ?? '24AAACS9012J1Z3',
});
const TWO = (o: Partial<Gstr2bRecord> & { invoice_no: string }): Gstr2bRecord => ({
  our_gstin: '26AALCS9985J1ZC',
  supplier_name: 'Vendor',
  invoice_type: 'Regular',
  invoice_date: '2025-04-10',
  invoice_value: 11800,
  place_of_supply: '27',
  reverse_charge: false,
  taxable_value: 10000,
  igst: 1800,
  cgst: 0,
  sgst: 0,
  cess: 0,
  period: '2025-04',
  itc_availability: 'Yes',
  ...o,
  supplier_gstin: o.supplier_gstin ?? '24AAACS9012J1Z3',
});

{
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'INV/1', supplier_gstin: '24AAACS9012J1Z3' })],
    [TWO({ invoice_no: 'INV-1', supplier_gstin: '24AAACS9012J1Z3' })]
  );
  eq('separator difference still matches (normalisation works)', r.summary.matched, 1);
}

{
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1' })],
    [TWO({ invoice_no: 'A1', taxable_value: 12000, igst: 2160 })]
  );
  eq('amount difference is flagged, not silently matched', r.summary.amount_mismatch, 1);
  eq('mismatch carries the 2B amount for claiming', r.rows[0].two_b_itc, 2160);
  eq('mismatch records the difference', r.rows[0].itc_difference, 360);
}

{
  const r = reconcilePurchases([BILL({ invoice_no: 'A1' })], []);
  eq('books-only line is Missing in 2B', r.summary.missing_in_2b, 1);
}

{
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1' })],
    [TWO({ invoice_no: 'A1', itc_availability: 'No', reason: 'cl.16(4)' })]
  );
  eq('portal-blocked line is ITC Blocked', r.summary.itc_blocked, 1);
  eq('blocked line is not Matched', r.summary.matched, 0);
  eq('blocked line never enters claimable ITC', r.summary.claimable_itc, 0);
}

{
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1' }), BILL({ invoice_no: 'A1' })],
    [TWO({ invoice_no: 'A1' })]
  );
  eq('duplicate in books is flagged', r.summary.duplicate, 2);
  // claimable_itc describes what the PORTAL supports, so it is unaffected by a
  // books-side duplicate. What must not happen is the duplicate reaching 4(A) —
  // that is asserted through the GSTR-3B builder below.
  const dup3b = itcDetailFromRecon(r.rows);
  eq('duplicate contributes nothing to GSTR-3B table 4(A)', dup3b.available.availed, 0);
}

{
  const r = reconcilePurchases([], [TWO({ invoice_no: 'A1' }), TWO({ invoice_no: 'A2' })]);
  eq('2B-only lines reported as unbooked', r.summary.unbooked_2b, 2);
}

{
  // A matched line must NOT also show up as unbooked — this is the bug that
  // once marked every portal line as unmatched.
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1' }), BILL({ invoice_no: 'A2' })],
    [TWO({ invoice_no: 'A1' }), TWO({ invoice_no: 'A2' })]
  );
  eq('matched lines are claimed exactly once', r.summary.matched, 2);
  eq('nothing is double-counted as unbooked', r.summary.unbooked_2b, 0);
}

{
  // Same invoice number, different supplier GSTIN: must not match.
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1', supplier_gstin: '24AAACS9012J1Z3' })],
    [TWO({ invoice_no: 'A1', supplier_gstin: '27AAXYZ1234C1Z5' })]
  );
  eq('GSTIN is part of the key', r.summary.matched, 0);
}

{
  // Rupee of rounding must still count as matched.
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1', igst: 1800.5 })],
    [TWO({ invoice_no: 'A1', igst: 1800 })]
  );
  eq('sub-rupee rounding stays Matched', r.summary.matched, 1);
}

{
  const r = reconcilePurchases(
    [BILL({ invoice_no: 'A1', igst: 1805 })],
    [TWO({ invoice_no: 'A1', igst: 1800 })]
  );
  eq('a rupee over tolerance is a real mismatch', r.summary.amount_mismatch, 1);
}

// ---------------------------------------------------------------------------
section('5. GSTR-3B');
// ---------------------------------------------------------------------------
{
  const recon = reconcilePurchases(
    [
      BILL({ invoice_no: 'M1' }),
      BILL({ invoice_no: 'AM1' }),
      BILL({ invoice_no: 'BL1' }),
      BILL({ invoice_no: 'D1' }),
      BILL({ invoice_no: 'UP1' }),
    ],
    [
      TWO({ invoice_no: 'M1' }),
      TWO({ invoice_no: 'AM1', taxable_value: 12000, igst: 2160 }),
      TWO({ invoice_no: 'BL1', itc_availability: 'No' }),
      TWO({ invoice_no: 'D1' }),
      TWO({ invoice_no: 'D2' }),
    ]
  );
  const sales: SalesInvoice[] = [
    {
      our_gstin: '26AALCS9985J1ZC',
      customer_name: 'Cust',
      customer_gstin: '27AAECA2190C1Z3',
      invoice_no: 'S1',
      invoice_date: '2025-04-15',
      period: '2025-04',
      invoice_type: 'R',
      place_of_supply: '27',
      reverse_charge: false,
      taxable_value: 100000,
      igst: 18000,
      cgst: 0,
      sgst: 0,
      cess: 0,
      invoice_value: 118000,
    },
  ];

  const m = buildGstr3b({ gstin: '26AALCS9985J1ZC', period: '2025-04', reconRows: recon.rows, sales });

  eq('3B: outward taxable', m.outward.taxable, 100000);
  eq('3B: outward IGST', m.outward.igst, 18000);
  eq('3B: total output tax', m.totalOutputTax, 18000);

  // Supported by 2B and claimable: M1 (1800) + AM1 (2160 at the 2B amount)
  // + D1 (1800). BL1 is blocked. D2 is 2B-only so no book row carries it.
  eq('3B: 4(A) takes the 2B amount for a mismatch row', m.itcAvailable, 5760);
  eq('3B: 4(B) holds the blocked credit', m.itcReversed, 1800);
  // 4(C) is the NET credit: 4(A) 5760 minus 4(B) 1800 = 3960. It used to be
  // 4(A) + 4(B), which counted the blocked credit as claimable and so understated
  // the tax payable by 1800.
  eq('3B: 4(C) = 4A - 4B (net credit), not 4A + 4B', m.itcAvailed, 3960);
  eq('3B: total ITC availed is the net figure', m.totalItcAvailed, 3960);
  eq('3B: tax payable', m.taxPayable, 14040);
  eq('3B: ITC utilised capped at liability', m.itcUtilised, 3960);
  eq('3B: cash payable', m.cashPayable, 14040);
  eq('3B: books-only ITC is quarantined into the 4A(i) memo', m.reconciliation.pending_4ai, 1800);
  check(
    '3B: 4(A) excludes the 4A(i) pending amount',
    m.itcAvailable === 5760 && m.reconciliation.pending_4ai === 1800,
    `${m.itcAvailable} / ${m.reconciliation.pending_4ai}`
  );

  const rows = gstr3bWorkingRows(m);
  check('3B: working rows include the 4A(i) memo', rows.some((r) => r.table === '4A(i)'), 'memo row missing');

  // The form's own numbering. This used to be 3.1(b) = exempt, (c) = nil,
  // (d) = non-GST, (e) = zero rated — every value one row above where the portal
  // puts it, so a CA copying the sheet into the return would fill the wrong line.
  const b3 = rows.find((r) => r.table === '3.1(b)');
  check('3B: 3.1(b) is the zero-rated line', !!b3 && /zero rated/i.test(b3.description), b3?.description);
  const c3 = rows.find((r) => r.table === '3.1(c)');
  check('3B: 3.1(c) is nil rated + exempt', !!c3 && /nil rated/i.test(c3.description), c3?.description);
  const e3 = rows.find((r) => r.table === '3.1(e)');
  check('3B: 3.1(e) is the non-GST line', !!e3 && /non-GST/i.test(e3.description), e3?.description);
  check('3B: no invented portal table number 6', !rows.some((r) => r.table === '6'),
    rows.map((r) => r.table).join(','));
}

{
  // Credit-balance month: output below ITC must carry forward, not go negative.
  const recon = reconcilePurchases(
    [BILL({ invoice_no: 'M1', igst: 5000 })],
    [TWO({ invoice_no: 'M1', igst: 5000 })]
  );
  const m = buildGstr3b({ gstin: 'G', period: '2025-04', reconRows: recon.rows, sales: [] });
  eq('3B: credit month shows negative payable', m.taxPayable, -5000);
  eq('3B: nothing is utilised in a credit month', m.itcUtilised, 0);
  eq('3B: nothing payable in cash', m.cashPayable, 0);
  eq('3B: excess ITC carries forward', m.itcCarryForward, 5000);
}

// ---------------------------------------------------------------------------
section('6. GSTR-1');
// ---------------------------------------------------------------------------
{
  const sales: SalesInvoice[] = [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'B2B Cust', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'SVN/2526/10', invoice_date: '2025-04-15', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 177120, igst: 31881.6, cgst: 0, sgst: 0, cess: 0, invoice_value: 209001.6 },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Intra B2B', customer_gstin: '26AAECS9012J1Z3', invoice_no: 'SVN-11', invoice_date: '2025-04-15', period: '2025-04', invoice_type: 'R', place_of_supply: '26', reverse_charge: false, taxable_value: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0, invoice_value: 11800 },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Unregistered', customer_gstin: '', invoice_no: 'CASH-1', invoice_date: '2025-04-16', period: '2025-04', invoice_type: 'R', place_of_supply: '', reverse_charge: false, taxable_value: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0, invoice_value: 5900 },
  ];

  const m = buildGstr1('26AALCS9985J1ZC', sales);
  eq('GSTR-1: registered customers go to B2B', m.b2b.length, 2);
  eq('GSTR-1: customer without GSTIN falls to B2CS', m.b2cs.length, 1);
  eq('GSTR-1: B2CS bucketed by rate', m.b2cs[0].rate, 18);
  eq('GSTR-1: 18% sale splits into CGST + SGST in B2CS', m.b2cs[0].cgst, 450);
  // This row has no place of supply in the file. The resolver answers from how
  // the tax was charged — CGST + SGST means the supply did not cross a state
  // line, so the POS is our own state, not an invention and not empty.
  eq('GSTR-1: a B2CS row with no POS falls to our own state, not empty', m.b2cs[0].pos, '26');
  eq('GSTR-1: HSN summary produced', m.hsn.length > 0, true);
  eq('GSTR-1: no validation errors on clean data', m.validation.length, 0);
  eq('GSTR-1: invoice total', m.totals.invoiceValue, 226701.6);

  const json = gstr1PortalJson(m) as any;
  eq('portal JSON: version tag', json.version, 'GST1.1');
  eq('portal JSON: fp without dash', json.fp, '202504');
  // The portal groups b2b by the recipient's GSTIN; a flat invoice list is not
  // the schema the offline utility validates against.
  eq('portal JSON: b2b grouped by recipient GSTIN', json.b2b.length, 2);
  eq('portal JSON: each group carries an inv array', json.b2b[0].inv.length, 1);
  eq('portal JSON: items nest under itm_det', json.b2b[0].inv[0].itms[0].itm_det.rt, 18);
  eq('portal JSON: invoice date is DD-MM-YYYY', json.b2b[0].inv[0].idt, '15-04-2025');
  // Amendment tables used to hold a copy of every regular row — uploading this
  // would have declared each invoice twice, once fresh and once as its own
  // amendment — and b2ba held a fabricated grand total.
  eq('portal JSON: no amendment table is pre-filled',
    json.b2ba.length + json.b2bqa.length + json.b2cla.length + json.b2csa.length + json.cdnra.length, 0);
  check('portal JSON: HSN block present', Array.isArray(json.hsn.data));
  eq('portal JSON: HSN rows use the JSON field name', json.hsn.data[0].hsn_sc !== undefined, true);
}

{
  // Table 7 (B2CS) is reported STATE-WISE. Bucketing by rate alone merged two
  // states' supplies into a single row, and the portal JSON then carried no
  // `pos` at all — a row the return cannot declare. The importer already
  // requires a place of supply for an unregistered recipient (spec V13) for
  // exactly this reason, so the value was available and being thrown away.
  const m = buildGstr1('26AALCS9985J1ZC', [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'UP walk-in', customer_gstin: '', invoice_no: 'CASH-UP', invoice_date: '2025-04-10', period: '2025-04', invoice_type: 'R', place_of_supply: '09', reverse_charge: false, taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, invoice_value: 11800 },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Gujarat walk-in', customer_gstin: '', invoice_no: 'CASH-GJ', invoice_date: '2025-04-11', period: '2025-04', invoice_type: 'R', place_of_supply: '24', reverse_charge: false, taxable_value: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0, invoice_value: 5900 },
  ]);

  eq('B2CS: the same rate in two states is two rows, not one', m.b2cs.length, 2);
  eq('B2CS: each row carries its own place of supply',
    m.b2cs.map((b) => b.pos).sort().join(','), '09,24');
  eq('B2CS: the inter-state amount stays in its own state',
    m.b2cs.find((b) => b.pos === '09')?.taxable, 10000);
  eq('B2CS: the intra-state amount stays in its own state',
    m.b2cs.find((b) => b.pos === '24')?.taxable, 5000);

  const json = gstr1PortalJson(m) as any;
  eq('portal JSON: every B2CS row declares pos',
    json.b2cs.map((b: any) => b.pos).sort().join(','), '09,24');
  eq('portal JSON: an inter-state B2CS row is INTER',
    json.b2cs.find((b: any) => b.pos === '09')?.sply_ty, 'INTER');
  eq('portal JSON: an intra-state B2CS row is INTRA',
    json.b2cs.find((b: any) => b.pos === '24')?.sply_ty, 'INTRA');

  // The workbook sheet must read the same value, so the screen and the file
  // cannot disagree about which state a bucket belongs to.
  const sheetRows = gstr1SheetRows(m).filter((r: any) => r.table === 'B2CS');
  eq('workbook sheet: B2CS rows show their POS',
    sheetRows.map((r: any) => r.pos).sort().join(','), '09,24');
}

{
  // The HSN summary reconciled in two halves. The same HSN at the same rate
  // sold once to a registered customer and once over the counter is two buckets
  // to the Accounts team — merging them hides a B2C shortfall inside a healthy
  // B2B number — while the FILED table 12 must stay one row per HSN + rate.
  const items = (hsn: string, qty: number, taxable: number, igst: number) => ([
    { line_no: 1, description: 'SHARED ITEM', hsn, uqc: 'PCS', quantity: qty,
      gst_rate: 18, taxable_value: taxable, igst, cgst: 0, sgst: 0, cess: 0 },
  ]);
  const m = buildGstr1('26AALCS9985J1ZC', [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Registered', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'REG-1', invoice_date: '2025-04-10', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, invoice_value: 11800, items: items('8536', 10, 10000, 1800) },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Walk-in', customer_gstin: '', invoice_no: 'UNREG-1', invoice_date: '2025-04-11', period: '2025-04', invoice_type: 'R', place_of_supply: '26', reverse_charge: false, taxable_value: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0, invoice_value: 5900, items: items('8536', 5, 5000, 0) },
  ]);

  eq('HSN split: one B2B bucket', m.hsnB2b.length, 1);
  eq('HSN split: one B2C bucket', m.hsnB2c.length, 1);
  eq('HSN split: the B2B bucket is marked B2B', m.hsnB2b[0].scope, 'B2B');
  eq('HSN split: the B2C bucket is marked B2C', m.hsnB2c[0].scope, 'B2C');
  eq('HSN split: B2B keeps its own quantity', m.hsnB2b[0].qty, 10);
  eq('HSN split: B2C keeps its own quantity', m.hsnB2c[0].qty, 5);
  eq('HSN split: B2B keeps its own taxable value', m.hsnB2b[0].taxable, 10000);
  eq('HSN split: B2C keeps its own taxable value', m.hsnB2c[0].taxable, 5000);

  // ...and the FILED table stays merged: one row per HSN + UQC + rate. The
  // portal does not split B2B from B2C, so the JSON must not either.
  eq('filed HSN table: the two halves merge back into one row', m.hsn.length, 1);
  eq('filed HSN table: quantity is the sum of both', m.hsn[0].qty, 15);
  eq('filed HSN table: taxable value is the sum of both', m.hsn[0].taxable, 15000);
  eq('filed HSN table: no scope leaks into the filed row',
    Object.prototype.hasOwnProperty.call(m.hsn[0], 'scope'), false);

  const json = gstr1PortalJson(m) as any;
  eq('portal JSON: table 12 stays one row per HSN + rate', json.hsn.data.length, 1);
  eq('portal JSON: and carries the combined quantity', json.hsn.data[0].qty, 15);
  check('portal JSON: no scope field is sent to the portal',
    json.hsn.data[0].scope === undefined);
}

{
  // A credit note must land in CDNR with the linked original.
  const m = buildGstr1('26AALCS9985J1ZC', [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'C', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'CN-1', invoice_date: '2025-04-20', period: '2025-04', invoice_type: 'CDNR', place_of_supply: '27', reverse_charge: false, taxable_value: -1000, igst: -180, cgst: 0, sgst: 0, cess: 0, invoice_value: -1180, note_ref_no: 'SVN-9', note_ref_date: '2025-04-02' },
  ]);
  eq('credit note routed to CDNR', m.cdnr.length, 1);
  eq('credit note is not counted as a B2B invoice', m.b2b.length, 0);
  eq('credit note keeps the linked original', m.cdnr[0].noteRefNo, 'SVN-9');
  eq('clean credit note raises no error', m.validation.filter((v) => v.severity === 'ERROR').length, 0);

  const json = gstr1PortalJson(m) as any;
  eq('portal JSON: cdnr grouped by recipient GSTIN', json.cdnr.length, 1);
  eq('portal JSON: CDNR uses type C', json.cdnr[0].nt[0].ntty, 'C');
  eq('portal JSON: the note declares its OWN number', json.cdnr[0].nt[0].nt_num, 'CN-1');
  eq('portal JSON: the note\u2019s own date', json.cdnr[0].nt[0].nt_dt, '20-04-2025'.replace(/(\d{4})-(\d{2})-(\d{2})/, '$3-$2-$1'));
  eq('portal JSON: CDNR carries the original invoice number', json.cdnr[0].nt[0].inum, 'SVN-9');
  eq('portal JSON: original invoice date is DD-MM-YYYY', json.cdnr[0].nt[0].idt, '02-04-2025');
}

{
  // A credit note WITHOUT the linked original must be an error, not a silent bad return.
  const m = buildGstr1('26AALCS9985J1ZC', [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'C', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'CN-2', invoice_date: '2025-04-20', period: '2025-04', invoice_type: 'CDNR', place_of_supply: '27', reverse_charge: false, taxable_value: -1000, igst: -180, cgst: 0, sgst: 0, cess: 0, invoice_value: -1180 },
  ]);
  eq('credit note without original reference is an ERROR', m.validation.filter((v) => v.severity === 'ERROR').length, 1);
}

{
  // Inter-state sale carrying CGST/SGST instead of IGST must be flagged.
  const m = buildGstr1('26AALCS9985J1ZC', [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'C', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'X-1', invoice_date: '2025-04-20', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0, invoice_value: 11800 },
  ]);
  eq('wrong IGST split on inter-state sale is an ERROR', m.validation.filter((v) => v.severity === 'ERROR').length, 1);
}

{
  // Duplicate invoice inside one return would be rejected by the portal.
  const dup: SalesInvoice = { our_gstin: '26AALCS9985J1ZC', customer_name: 'C', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'DUP-1', invoice_date: '2025-04-20', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 100, igst: 18, cgst: 0, sgst: 0, cess: 0, invoice_value: 118 };
  const m = buildGstr1('26AALCS9985J1ZC', [dup, { ...dup }]);
  eq('duplicate invoice inside a return is an ERROR', m.validation.filter((v) => v.severity === 'ERROR').length, 1);
}

{
  const m = buildGstr1('26AALCS9985J1ZC', []);
  eq('empty period returns an empty return, not a crash', m.b2b.length, 0);
  eq('empty return sheet is empty', gstr1SheetRows(m).length, 0);
}

// ---------------------------------------------------------------------------
section('12. GSTR-2B portal JSON');
// ---------------------------------------------------------------------------

const portal2b = {
  gstin: '26AALCS9985J1ZC',
  fp: '042025',
  hash: 'c0ffee',
  b2b: [
    {
      ctin: '26ABFCS9511H1Z7',
      inv: [
        {
          inum: 'SVN/2526/1001', idt: '05-04-2025', val: 14450, pos: '26', rchrg: 'N', inv_typ: 'R',
          itms: [{ num: 1, itm_det: { rt: 18, txval: 12245.76, iamt: 2204.24, camt: 0, samt: 0, csamt: 0 } }],
          itc_elg: 'Yes',
        },
        {
          inum: 'SVN2/25/600011', idt: '08-04-2025', val: 23000, pos: '26', rchrg: 'N', inv_typ: 'R',
          itms: [
            { num: 1, itm_det: { rt: 18, txval: 10000, iamt: 900, camt: 0, samt: 0, csamt: 0 } },
            { num: 2, itm_det: { rt: 12, txval: 10535.09, iamt: 632.11, camt: 0, samt: 0, csamt: 0 } },
          ],
          itc_elg: 'No',
          reason: 'Rule 16(2)(b) - GSTR-1 not filed by supplier',
        },
      ],
    },
  ],
  b2cl: [
    {
      pos: '24',
      inv: [
        {
          ctin: '24ABHCS2586C1ZE',
          inum: 'B2CL-24-00077', idt: '22-04-2025', val: 11800, pos: '24', rchrg: 'N', inv_typ: 'R',
          itms: [{ num: 1, itm_det: { rt: 18, txval: 10000, iamt: 900, camt: 0, samt: 0, csamt: 0 } }],
          itc_elg: 'Yes',
        },
      ],
    },
  ],
  b2cs: [{ sply_ty: 'R', pos: '26', typ: 'OE', itms: [{ txval: 31800, iamt: 2862, camt: 0, samt: 0 }] }],
  cdnr: [
    {
      ctin: '26ABFCS9511H1Z7', nt_num: 'CN/2526/500', nt_dt: '18-04-2025', ntty: 'C', val: -2950,
      itms: [
        { num: 1, itm_det: { rt: 18, txval: -2500, iamt: -225, camt: 0, samt: 0, csamt: 0 } },
        { num: 2, itm_det: { rt: 18, txval: -200, iamt: -225, camt: 0, samt: 0, csamt: 0 } },
      ],
      itc_elg: 'Yes',
    },
  ],
  isd: [
    {
      ctin: '27AAECA2190C1Z3', inum: 'ISD/25-26/01', idt: '02-04-2025', val: 4720, pos: '26', rchrg: 'N',
      itms: [{ num: 1, itm_det: { rt: 18, txval: 4000, iamt: 360, camt: 0, samt: 0, csamt: 0 } }],
      itc_elg: 'No',
    },
  ],
  section: [{ sec: 'A', typ: 'B2B', itc_avlbl: 'Yes' }, { sec: 'B', typ: 'B2B', itc_avlbl: 'No', reason: 'blocked' }],
};

{
  const r = parseGstr2bJson(portal2b, 'portal.json');
  check('portal JSON is recognised', isGstr2bJson(portal2b));
  // 2 B2B + 1 B2CL + 1 CDNR + 1 ISD. B2CS has no invoice number and is not ingestable.
  eq('every invoice-level row is flattened', r.rows.length, 5);
  eq('B2CS summary rows are reported, not ingested', r.rows.filter((x) => x.invoice_no.startsWith('B2CL')).length, 1);

  const first = r.rows[0];
  eq('root gstin becomes our_gstin', first.our_gstin, '26AALCS9985J1ZC');
  eq('supplier GSTIN comes from the B2B group', first.supplier_gstin, '26ABFCS9511H1Z7');
  eq('invoice number is kept verbatim', first.invoice_no, 'SVN/2526/1001');
  eq('dd-mm-yyyy portal date normalises', first.invoice_date, '2025-04-05');
  eq('period comes from the invoice date', first.period, '2025-04');
  eq('portal fp is retained', first.portal_fp, '2025-04');
  eq('taxable value is read from itms', first.taxable_value, 12245.76);
  eq('igst is read from itms', first.igst, 2204.24);
  eq('invoice value comes from val', first.invoice_value, 14450);
  eq('ITC available line is not blocked', first.itc_availability, 'Yes');

  const multi = r.rows[1];
  eq('multiple itms are summed into one row', multi.taxable_value, 20535.09);
  eq('summed igst across rates', multi.igst, 1532.11);
  eq('all rates are listed', multi.applicable_pct, '18,12');
  eq('blocked line keeps ITC = No', multi.itc_availability, 'No');
  check('blocked line carries the portal reason', /GSTR-1 not filed/.test(multi.reason || ''), multi.reason);
}

{
  const r = parseGstr2bJson(portal2b, 'portal.json');
  const cdnr = r.rows.find((x) => x.invoice_no === 'CN/2526/500')!;
  eq('credit note keeps its note number', cdnr.invoice_no, 'CN/2526/500');
  eq('credit note typed CDNR', cdnr.invoice_type, 'CDNR');
  eq('credit note tax stays negative', cdnr.taxable_value, -2700);
  eq('credit note igst stays negative', cdnr.igst, -450);
  eq('credit note period from nt_dt', cdnr.period, '2025-04');

  const isd = r.rows.find((x) => x.invoice_no === 'ISD/25-26/01')!;
  eq('ISD invoice is ingested', isd.supplier_gstin, '27AAECA2190C1Z3');
  eq('ISD credit reversed is blocked', isd.itc_availability, 'No');

  const b2cl = r.rows.find((x) => x.invoice_no === 'B2CL-24-00077')!;
  eq('B2CL place of supply comes from the group', b2cl.place_of_supply, '24');
  eq('B2CL reverse charge stays false', b2cl.reverse_charge, false);
}

{
  // The reason ITC defaults to Yes is the one dangerous assumption in this
  // parser, so it must never happen silently.
  const noFlag = parseGstr2bJson(
    { gstin: '26AALCS9985J1ZC', fp: '202504', b2b: [{ ctin: '26ABFCS9511H1Z7', inv: [{ inum: 'X-1', idt: '05-04-2025', itms: [{ itm_det: { rt: 18, txval: 100, iamt: 18 } }] }] }] },
    'noflag.json',
  );
  eq('missing ITC flag still yields a row', noFlag.rows.length, 1);
  check('missing ITC flag raises a warning', (noFlag.warnings || []).length > 0, JSON.stringify(noFlag.warnings));
}

{
  // Section-level flags are the fallback when the invoice carries none.
  const secOnly = parseGstr2bJson(
    {
      gstin: '26AALCS9985J1ZC',
      b2b: [{ ctin: '26ABFCS9511H1Z7', inv: [{ inum: 'Y-1', idt: '05-04-2025', itms: [{ itm_det: { rt: 18, txval: 100, iamt: 18 } }] }] }],
      section: [{ sec: 'B', itc_avlbl: 'No', reason: 'PO mismatch' }],
    },
    'seconly.json',
  );
  eq('section-level ITC flag is applied', secOnly.rows[0].itc_availability, 'No');
  eq('section letter is recorded', /Section B/.test(secOnly.rows[0].reason || ''), true);
}

{
  check('an unrelated JSON file is not mistaken for a 2B', !isGstr2bJson({ hello: 'world', list: [1, 2] }));
  check('an array is not a 2B', !isGstr2bJson([]));
  check('an xlsx parsed as {} is not a 2B', !isGstr2bJson({}));
}

{
  // The JSON path must produce the same reconciliation outcome as the Excel
  // path — that is the whole point of accepting both.
  const parsed = parseGstr2bJson(portal2b, 'portal.json');
  const booksRows: unknown[][] = [
    ['GSTIN of Company', 'GSTIN of supplier', 'Supplier Name', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Invoice Value', 'ITC Availability'],
    ['26AALCS9985J1ZC', '26ABFCS9511H1Z7', 'SVN OPTO ELECTRONICS PVT.LTD.', 'SVN/2526/1001', '2025-04-05', 12245.76, 2204.24, 0, 0, 14450, 'Yes'],
    ['26AALCS9985J1ZC', '26ABFCS9511H1Z7', 'SVN OPTO ELECTRONICS PVT.LTD.', 'SVN2/25/600011', '2025-04-08', 20535.09, 1532.11, 0, 0, 23000, 'No'],
    ['26AALCS9985J1ZC', '26ABFCS9511H1Z7', 'SVN OPTO ELECTRONICS PVT.LTD.', 'CN/2526/500', '2025-04-18', -2700, -450, 0, 0, -2950, 'Yes'],
  ];
  const parsedBooks = parsePurchaseRegister(booksRows, 'books.xlsx');
  const recon = reconcilePurchases(parsedBooks.rows, parsed.rows);
  eq('books match the portal JSON one-to-one', recon.summary.matched, 2);
  eq('blocked ITC is reported as blocked', recon.summary.itc_blocked, 1);
}

// ---------------------------------------------------------------------------
section('13. Phase 0 — reconciliation overrides and 2B month');
// ---------------------------------------------------------------------------

// The fixtures below are the worked example from the spec: the books booked
// STPL-123 dated 01-03-2026, and GSTR-2B has the same invoice as 123 dated
// 28-02-2026 under a different GSTIN.
{
  const OUR = '26AALCS9985J1ZC';
  const VENDOR = '24ABCDE1234F1Z5';
  const VENDOR_TYPO = '24ABCDE9876F1Z2';

  // Books: supplier GSTIN VENDOR, invoice STPL-123 dated 01-03-2026.
  const books: PurchaseBill[] = [
    {
      id: 'books.xlsx#2',
      our_gstin: OUR,
      party_name: 'Supplier Co',
      supplier_gstin: VENDOR,
      invoice_no: 'STPL-123',
      invoice_date: '2026-03-01',
      period: '2026-03',
      taxable_value: 100000,
      igst: 18000, cgst: 0, sgst: 0, cess: 0,
      source_file: 'books.xlsx',
      source_row: 2,
    },
  ];

  // GSTR-2B: same supplier, invoice 123, dated 28-02-2026, filed under
  // February. This is the spec's worked example.
  const twob: Gstr2bRecord[] = [
    {
      id: '2b.xlsx#9',
      our_gstin: OUR,
      supplier_gstin: VENDOR,
      supplier_name: 'Supplier Co',
      invoice_no: '123',
      invoice_type: 'Regular',
      invoice_date: '2026-02-28',
      invoice_value: 118000,
      place_of_supply: '26',
      reverse_charge: false,
      taxable_value: 100000,
      igst: 18000, cgst: 0, sgst: 0, cess: 0,
      period: '2026-02',
      portal_fp: '2026-02',
      itc_availability: 'Yes',
      source_file: '2b.xlsx',
      source_row: 9,
    },
    // The same invoice number under a DIFFERENT GSTIN — the "GSTIN differs"
    // case, where the books carry the wrong GSTIN.
    {
      id: '2b.xlsx#11',
      our_gstin: OUR,
      supplier_gstin: VENDOR_TYPO,
      supplier_name: 'Supplier Co',
      invoice_no: 'STPL-123',
      invoice_type: 'Regular',
      invoice_date: '2026-02-28',
      invoice_value: 118000,
      place_of_supply: '26',
      reverse_charge: false,
      taxable_value: 100000,
      igst: 18000, cgst: 0, sgst: 0, cess: 0,
      period: '2026-02',
      portal_fp: '2026-02',
      itc_availability: 'Yes',
      source_file: '2b.xlsx',
      source_row: 11,
    },
  ];

  // Test 1 — exact match on all three values.
  {
    const exact: PurchaseBill[] = [
      { ...books[0], supplier_gstin: VENDOR, invoice_no: '123', invoice_date: '2026-02-28' },
    ];
    const r = reconcilePurchases(exact, twob);
    eq('T1 exact GSTIN + invoice + date matches', r.rows[0].status, 'Matched');
    eq('T1 no exception is raised', r.summary.missing_in_2b + r.summary.amount_mismatch, 0);
  }

  // Nothing is edited yet, so the book values drive the match exactly as before.
  // STPL-123 as booked does not exist in 2B (it is filed there as 123), which is
  // precisely the case the reconciliation fields exist to fix.
  {
    const r = reconcilePurchases(books, twob);
    eq('unedited: book values decide the match', r.rows[0].status, 'Missing in 2B');
    eq('unedited row is not flagged as edited', r.rows[0].matched_on_recon, undefined);
    eq('unedited: nothing was claimed from 2B', r.rows[0].matched_2b_id, undefined);
  }

  // Test 2 — the invoice number differs; the user corrects it.
  {
    const r = reconcilePurchases([{ ...books[0], recon_invoice_no: '123' }], twob);
    eq('T2 recon invoice number makes it match', r.rows[0].status, 'Matched');
    eq('T2 the row records that an override was used', r.rows[0].matched_on_recon, true);
    eq('T2 the 2B line it claimed is recorded', r.rows[0].matched_2b_id, '2b.xlsx#9');
  }

  // Test 3 — the date differs; the user corrects it. Correcting the date alone
  // must NOT produce a match, because the invoice number still disagrees. A
  // match has to be earned on the whole key, never on one field.
  {
    const r = reconcilePurchases([{ ...books[0], recon_invoice_date: '2026-02-28' }], twob);
    eq('T3 date correction alone does not silently match', r.rows[0].status, 'Missing in 2B');
    eq('T3 it claims no 2B line', r.rows[0].matched_2b_id, undefined);
    const both = reconcilePurchases(
      [{ ...books[0], recon_invoice_no: '123', recon_invoice_date: '2026-02-28' }],
      twob,
    );
    eq('T3 date + number correction matches', both.rows[0].status, 'Matched');
    eq('T3 and prefers the 2B line with the same date', both.rows[0].matched_2b_id, '2b.xlsx#9');
  }

  // Test 4 — the GSTIN in the books is wrong; the user corrects it.
  {
    const r = reconcilePurchases([{ ...books[0], recon_supplier_gstin: VENDOR_TYPO }], twob);
    eq('T4 recon GSTIN makes it match', r.rows[0].status, 'Matched');
    eq('T4 it claims the other GSTIN line', r.rows[0].matched_2b_id, '2b.xlsx#11');
  }

  // Test 4b — a GSTIN correction must not be able to claim a line that has
  // already been claimed by another book row.
  {
    const r = reconcilePurchases(
      [books[0], { ...books[0], source_row: 3, recon_supplier_gstin: VENDOR_TYPO }],
      twob,
    );
    eq('T4b both book rows cannot claim the same 2B line', r.unbooked2b.length, 1);
  }

  // Test 6 — the matched 2B month comes from the 2B file, not the books.
  {
    const r = reconcilePurchases([{ ...books[0], recon_invoice_no: '123' }], twob);
    eq('T6 matched 2B month is the portal month', r.rows[0].matched_2b_month, '2026-02');
    check('T6 it is not the book month', r.rows[0].matched_2b_month !== books[0].period);
  }

  // Test 6b — an unbooked 2B line still reports the month it came from.
  {
    const r = reconcilePurchases([], twob);
    eq('T6b unbooked 2B line carries its own month', r.unbooked2b[0].matched_2b_month, '2026-02');
  }

  // The guarantee that matters most: an override never rewrites what the books
  // said. The engine reports the book values on the row it returns.
  {
    const b: PurchaseBill = {
      ...books[0],
      recon_invoice_no: '123',
      recon_invoice_date: '2026-02-28',
    };
    const r = reconcilePurchases([b], twob);
    eq('book GSTIN survives the override', r.rows[0].supplier_gstin, VENDOR);
    eq('book invoice number survives the override', r.rows[0].invoice_no, 'STPL-123');
    eq('book invoice date survives the override', r.rows[0].invoice_date, '2026-03-01');
    eq('the matched 2B amounts are carried through', r.rows[0].two_b_taxable, 100000);
    eq('the 2B ITC is carried through', r.rows[0].two_b_itc, 18000);
  }

  // A 2B month that is blank must not become "today".
  {
    const noFp = twob.map((t) => ({ ...t, portal_fp: '', period: '' }));
    const r = reconcilePurchases([{ ...books[0], recon_invoice_no: '123' }], noFp);
    eq('a 2B line with no period reports no month', r.rows[0].matched_2b_month, undefined);
  }

  // An override must not let one invoice claim two 2B lines.
  {
    const two = [
      twob[0],
      { ...twob[0], id: '2b.xlsx#10', invoice_date: '2026-03-05', period: '2026-03', portal_fp: '2026-03' },
    ];
    const r = reconcilePurchases([{ ...books[0], recon_invoice_no: '123' }], two);
    eq('one book row claims exactly one 2B line', r.unbooked2b.length, 1);
    eq('the duplicate 2B line is reported unbooked', r.unbooked2b[0].matched_2b_id, '2b.xlsx#10');
  }
}

section('14. purchase register template agrees with the parser');

{
  // Every header the template prints must be an alias the parser recognises.
  // If someone renames a template column without adding the alias, the parser
  // would silently drop that column and the import would quietly lose data.
  const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
  const { FIELD_ALIASES } = await import('../src/engine/columns');

  for (const col of PURCHASE_TEMPLATE_COLUMNS) {
    // Calculated columns are for the human; the importer recomputes the sign
    // from Document Type and must NOT read them back.
    if (col.derived) continue;
    const key = normaliseHeader(col.header);
    const field = detectField(key, { profile: 'purchase' });
    check(`template header "${col.header}" is recognised`, field !== null && field !== undefined);
  }

  // The two columns the template goes out of its way to separate really are
  // separate fields — otherwise a file carrying both would file the reference
  // number as the invoice number.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const { map } = mapHeaders(headers, { profile: 'purchase' });
    const invIdx = headers.indexOf('Document Number');
    const refIdx = headers.indexOf('Reference No');
    eq('invoice_no maps to the Document Number column', map.get(invIdx), 'invoice_no');
    eq('reference_no maps to the Reference No column', map.get(refIdx), 'reference_no');
  }

  // And the template's own headers parse: sample row round-trips.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const sample = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample);
    const r = parsePurchaseRegister([headers, sample], 'template.xlsx');
    eq('template sample row parses', r.rows.length, 1);
    const b = r.rows[0];
    eq('sample invoice number', b?.invoice_no, 'INV-889012');
    eq('sample reference number', b?.reference_no, 'PO-4500123456');
    eq('sample location', b?.unit_name, 'Sakar-I');
    eq('sample our gstin', b?.our_gstin, '26AALCS9985J1ZC');
    eq('sample period from the Period column', b?.period, '2026-04');
    check('sample taxable value parsed', Number(b?.taxable_value) === 100000);
  }

  // Exactly ONE column may claim the period. Two would mean the template asks
  // the same question twice and the file decides by column order.
  {
    const periodCols = PURCHASE_TEMPLATE_COLUMNS.filter((c) =>
      !c.derived && detectField(normaliseHeader(c.header), { profile: 'purchase' }) === 'period');
    eq('the template carries exactly one period column', periodCols.length, 1);
    eq('...and it is called Period', periodCols[0]?.header, 'Period');
  }

  // "Period" names the month the row is reported in, so it must beat the SAP
  // file's "2B Month" — otherwise adding the column changes nothing and a
  // twelve-month register still lands in one month.
  {
    const H = ['Our GSTIN', 'Document Number', 'Document Date', 'Supplier GSTIN',
      'Taxable Amount', '2B Month', 'Period'];
    const p = parsePurchaseRegister([
      H,
      ['26AALCS9985J1ZC', 'X-1', '2026-04-10', '27AAFCC9473R1ZP', '1000', '2026-06', '2026-04'],
    ], 'priority.xlsx');
    eq('an explicit Period beats 2B Month', p.rows[0]?.period, '2026-04');
  }

  // The whole point of the column: one file, several months, each row in its
  // own month. A blank Period still falls back to the document date, and a
  // text month ("Apr-25") is understood, because that is what SAP writes.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const base: Record<string, string> = {
      'Our GSTIN': '26AALCS9985J1ZC', 'Supplier GSTIN': '27AAFCC9473R1ZP',
      'Document Type': 'Tax Invoice', 'Taxable Amount': '1000', 'IGST': '180',
    };
    const row = (over: Record<string, string>) => {
      const all = { ...base, ...over };
      return headers.map((h) => all[h] ?? '');
    };
    const multi = parsePurchaseRegister([
      headers,
      row({ 'Document Number': 'A-1', 'Document Date': '2026-04-05', 'Period': '2026-04' }),
      row({ 'Document Number': 'A-2', 'Document Date': '2026-04-09', 'Period': '2026-05' }),
      row({ 'Document Number': 'A-3', 'Document Date': '2026-05-10' }),
      row({ 'Document Number': 'A-4', 'Document Date': '2025-04-01', 'Period': 'Apr-25' }),
    ], 'multi.xlsx');

    eq('all four rows parse', multi.rows.length, 4);
    eq('month from an explicit Period', multi.rows[0]?.period, '2026-04');
    eq('a second month in the same file', multi.rows[1]?.period, '2026-05');
    eq('a blank Period falls back to the document date', multi.rows[2]?.period, '2026-05');
    eq('a text month is understood', multi.rows[3]?.period, '2025-04');
    eq('the file spans three months',
      new Set(multi.rows.map((r) => r.period)).size, 3);

    // Month-wise totals must add up to the file total: that is what the
    // preview shows and what the import reconciles per month.
    const byPeriod = new Map<string, number>();
    for (const r of multi.rows) byPeriod.set(r.period, r2((byPeriod.get(r.period) ?? 0) + r.taxable_value));
    eq('April holds only the row that says April', byPeriod.get('2026-04'), 1000);
    eq('May holds the explicit May row plus the one dated May', byPeriod.get('2026-05'), 2000);
    eq('FY 2025-26 April holds its row', byPeriod.get('2025-04'), 1000);
  }

  // A totals row must still be rejected, template or not.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const total = headers.map((h) =>
      /Taxable|IGST|CGST|SGST/.test(h) ? '999999' : '');
    const r = parsePurchaseRegister([headers, total], 'template.xlsx');
    eq('a totals row in the template layout is skipped', r.rows.length, 0);
  }
}

// ---------------------------------------------------------------------------
// Credit / debit notes: one sign, applied exactly once
// ---------------------------------------------------------------------------
section('14b. credit notes reduce, debit notes add, and a sign is never applied twice');

{
  const H = ['Our GSTIN', 'Document Type', 'Document Number', 'Document Date', 'Supplier GSTIN',
    'Taxable Amount', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'];
  const row = (type: string, no: string, taxable: number, igst: number, cgst = 0, sgst = 0) =>
    ['26AALCS9985J1ZC', type, no, '2026-04-15', '27AAFCC9473R1ZP', taxable, igst, cgst, sgst, 0];

  const parsed = parsePurchaseRegister([
    H,
    row('Tax Invoice', 'INV-1', 100000, 18000),
    row('Debit Note', 'DN-1', 10000, 1800),
    row('Credit Note', 'CN-1', 5000, 900),
  ], 'notes.xlsx');

  eq('three documents parse', parsed.rows.length, 3);
  eq('tax invoice is unchanged', parsed.rows[0].taxable_value, 100000);
  eq('tax invoice sign effect', parsed.rows[0].sign_effect, 1);
  eq('debit note ADDS', parsed.rows[1].taxable_value, 10000);
  eq('debit note sign effect', parsed.rows[1].sign_effect, 1);
  eq('credit note REDUCES', parsed.rows[2].taxable_value, -5000);
  eq('credit note tax also reduces', parsed.rows[2].igst, -900);
  eq('credit note sign effect', parsed.rows[2].sign_effect, -1);
  eq('the source amount is preserved untouched', parsed.rows[2].source_taxable_value, 5000);
  eq('net taxable is 105000',
    r2(parsed.rows.reduce((a, b) => a + b.taxable_value, 0)), 105000);
  eq('no warnings for a clean file', (parsed.warnings || []).length, 0);

  // The aliases the team actually types must all land on the three values.
  for (const [alias, want] of [
    ['Invoice', 'Tax Invoice'], ['Purchase Invoice', 'Tax Invoice'], ['INV', 'Tax Invoice'],
    ['DN', 'Debit Note'], ['Debit Note', 'Debit Note'],
    ['CN', 'Credit Note'], ['credit note', 'Credit Note'], ['CDNR', 'Credit Note'],
  ] as const) {
    const p = parsePurchaseRegister([H, row(alias, 'A-1', 1000, 180)], 'alias.xlsx');
    eq(`document type "${alias}" normalises to ${want}`, p.rows[0]?.document_type, want);
  }

  // An already-negative credit note must NOT become positive, and must not be
  // negated twice into a positive. This is the whole duplicate-sign rule.
  {
    const p = parsePurchaseRegister([H, row('Credit Note', 'CN-NEG', -5000, -900)], 'neg.xlsx');
    eq('an already-negative credit note stays negative', p.rows[0]?.taxable_value, -5000);
    eq('...and its tax stays negative', p.rows[0]?.igst, -900);
    eq('...no conflicting-sign warning for the normal case', (p.warnings || []).length, 0);
  }

  // An unknown type must be REFUSED, not filed as an invoice that adds ITC.
  {
    const p = parsePurchaseRegister([H, row('Sales Return', 'SR-1', 5000, 900)], 'bad.xlsx');
    eq('an unknown document type imports no row', p.rows.length, 0);
    check('...and the skip explains the three allowed values',
      /document type .*not recognised/i.test(p.skipped[0]?.reason || ''), p.skipped[0]?.reason);
  }

  // A blank type with negative amounts is still recognised, with a warning —
  // that is what every register produced before the dropdown existed.
  {
    const p = parsePurchaseRegister([H, row('', 'OLD-CN', -5000, -900)], 'blank.xlsx');
    eq('blank type + negative amounts is a credit note', p.rows[0]?.document_type, 'Credit Note');
    check('...and it says so', (p.warnings || []).some((w) => /Credit Note/.test(w)), JSON.stringify(p.warnings));
  }

  // A Tax Invoice with a negative amount is a conflict: preserve the figure,
  // report it, never silently re-sign it.
  {
    const p = parsePurchaseRegister([H, row('Tax Invoice', 'ODD-1', -5000, -900)], 'conflict.xlsx');
    eq('a negative tax invoice keeps its negative amount', p.rows[0]?.taxable_value, -5000);
    check('...and is warned about', (p.warnings || []).some((w) => /sign NOT applied/.test(w)), JSON.stringify(p.warnings));
  }

  // ---- matching: type is part of the identity ----------------------------
  const twobRec = (over: Partial<Gstr2bRecord> = {}): Gstr2bRecord => ({
    our_gstin: '26AALCS9985J1ZC', supplier_gstin: '27AAFCC9473R1ZP', supplier_name: 'SUP',
    invoice_no: 'CN-1', invoice_type: 'CDNR', invoice_date: '2026-04-15', invoice_value: -5900,
    place_of_supply: '27', reverse_charge: false, taxable_value: -5000, igst: -900,
    cgst: 0, sgst: 0, cess: 0, period: '2026-04', itc_availability: 'Yes',
    ...over,
  });
  const bookOf = (over: Partial<PurchaseBill> = {}): PurchaseBill => ({
    our_gstin: '26AALCS9985J1ZC', party_name: 'SUP', supplier_gstin: '27AAFCC9473R1ZP',
    invoice_no: 'CN-1', document_type: 'Credit Note', invoice_date: '2026-04-15', period: '2026-04',
    taxable_value: -5000, igst: -900, cgst: 0, sgst: 0, cess: 0,
    source_file: 'x', source_row: 1, ...over,
  });

  {
    const r = reconcilePurchases([bookOf()], [twobRec()]);
    eq('a credit note matches the portal credit note', r.rows[0]?.status, 'Matched');
    eq('...and the row says which document it is', r.rows[0]?.document_type, 'Credit Note');
  }
  {
    // Same number, opposite document: must NOT match merely because the number
    // and the amount line up.
    const r = reconcilePurchases([bookOf({ document_type: 'Tax Invoice', taxable_value: 5000, igst: 900 })], [twobRec()]);
    eq('an invoice does not match a credit note of the same number', r.rows[0]?.status, 'Missing in 2B');
  }
  {
    const r = reconcilePurchases([bookOf()], [twobRec({ invoice_type: 'Regular', taxable_value: 5000, igst: 900, invoice_value: 5900 })]);
    eq('a credit note does not match an invoice of the same number', r.rows[0]?.status, 'Missing in 2B');
  }

  // ---- summaries keep gross, reduction and net apart --------------------
  {
    const invoice = bookOf({
      invoice_no: 'INV-1', document_type: 'Tax Invoice',
      taxable_value: 100000, igst: 18000,
    });
    const r = reconcilePurchases([invoice, bookOf()], [
      twobRec({ invoice_no: 'INV-1', invoice_type: 'Regular', taxable_value: 100000, igst: 18000, invoice_value: 118000 }),
      twobRec(),
    ]);
    eq('books gross excludes the credit note', r.summary.books_taxable_gross, 100000);
    eq('books credit is the reduction', r.summary.books_taxable_credit, 5000);
    eq('books net is gross minus credit', r.summary.books_taxable_net, 95000);
    eq('2B gross excludes the credit note', r.summary.twob_taxable_gross, 100000);
    eq('2B credit is the reduction', r.summary.twob_taxable_credit, 5000);
    eq('2B net is gross minus credit', r.summary.twob_taxable_net, 95000);
    eq('document counts', JSON.stringify(r.summary.books_docs), JSON.stringify({ invoice: 1, debit: 0, credit: 1 }));
  }

  // ---- each tax component is compared, not just the total ----------------
  {
    const book = bookOf({
      invoice_no: 'SPLIT-1', document_type: 'Tax Invoice',
      taxable_value: 10000, igst: 900, cgst: 900, sgst: 0,
    });
    const portal = twobRec({
      invoice_no: 'SPLIT-1', invoice_type: 'Regular',
      taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0, invoice_value: 11800,
    });
    const r = reconcilePurchases([book], [portal]);
    eq('same taxable and same total tax but a different split is a mismatch',
      r.rows[0]?.status, 'Amount Mismatch');
    check('...and the action names the component figures',
      /IGST 900/.test(String(r.rows[0]?.action)), r.rows[0]?.action);
  }

  // ---- the 2B side obeys the same one-sign rule ---------------------------
  {
    const h2 = ['GSTIN of Company', 'GSTIN of supplier', 'Invoice number', 'Invoice Date',
      'Invoice Type', 'Taxable Value', 'Integrated Tax', 'ITC Availability'];
    const pos = parseGstr2b([h2, ['26AALCS9985J1ZC', '27AAFCC9473R1ZP', 'CN-9', '20-04-2026', 'Credit Note', 5000, 900, 'Yes']], '2b.csv');
    eq('a POSITIVE credit note in 2B is stored negative', pos.rows[0]?.taxable_value, -5000);
    eq('...and its tax too', pos.rows[0]?.igst, -900);
    const neg = parseGstr2b([h2, ['26AALCS9985J1ZC', '27AAFCC9473R1ZP', 'CN-9', '20-04-2026', 'CDNR', -5000, -900, 'Yes']], '2b.csv');
    eq('an ALREADY-negative 2B credit note is not negated twice', neg.rows[0]?.taxable_value, -5000);

    // The portal JSON can carry either convention; the type decides.
    const jsonPos = parseGstr2bJson({
      gstin: '26AALCS9985J1ZC', fp: '042026',
      cdnr: [{ ctin: '27AAFCC9473R1ZP', nt_num: 'CN-9', nt_dt: '20-04-2026', ntty: 'C',
        itms: [{ num: 1, itm_det: { rt: 18, txval: 5000, iamt: 900, camt: 0, samt: 0, csamt: 0 } }] }],
    }, 'portal.json');
    eq('JSON credit note is a reduction', jsonPos.rows[0]?.taxable_value, -5000);
  }

  // ---- what the preview screen reports before the import -----------------
  {
    const p = parsePurchaseRegister([
      H,
      row('Tax Invoice', 'D-1', 1000, 180),
      row('Invoice', 'D-1', 1000, 180),
      row('Credit Note', 'C-1', 500, 90),
    ], 'dup.xlsx');
    const s = summarisePurchaseDocuments(p.rows);
    eq('preview counts invoices', s.documentTypes.invoice, 2);
    eq('preview counts credit notes', s.documentTypes.credit, 1);
    eq('preview gross taxable excludes the note', s.totals.gross.taxable, 2000);
    eq('preview gross tax excludes the note', s.totals.gross.tax, 360);
    eq('preview credit reduction is positive and separate', s.totals.creditNotes.taxable, 500);
    eq('preview credit tax is separate', s.totals.creditNotes.tax, 90);
    eq('preview net taxable is gross minus credit', s.totals.net.taxable, 1500);
    eq('preview net tax is gross minus credit', s.totals.netTax, 270);
    eq('preview flags the duplicate document', s.duplicates.length, 1);
    eq('...with its count', s.duplicates[0]?.count, 2);
    eq('...and its type', s.duplicates[0]?.document_type, 'Tax Invoice');
  }
}

section('15. multi-sheet workbooks pick the data sheet, not the first sheet');

{
  const { pickDataSheet, readAllSheets } = await import('../src/app/sheets');
  const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
  const REQUIRED = ['invoice_no', 'supplier_gstin', 'taxable_value'];

  // The sheet the template hands out: an Instructions sheet in front of the
  // register. Reading sheet 0 would parse the instructions and find nothing.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const example = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample);
    const instructions = [
      ['GST CONTROL ERP — PURCHASE REGISTER TEMPLATE'],
      [],
      ['Is file me SAP ka purchase register bhar kar wahi upload kar dijiye.'],
      ['Invoice No', 'Supplier GSTIN', 'Taxable Value'],
      ['Column', 'Zaroori?', 'Kya karta hai', 'Example'],
      ...PURCHASE_TEMPLATE_COLUMNS.map((c) => [c.header, 'HAAN', c.note, c.sample]),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, example]), 'Purchase Register');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const sheets = readAllSheets(Buffer.from(buf));
    eq('both sheets are read', sheets.length, 2);

    const picked = pickDataSheet(sheets, REQUIRED, { profile: 'purchase' });
    eq('the register sheet is chosen, not Instructions', picked.name, 'Purchase Register');

    const r = parsePurchaseRegister(picked.rows, 'template.xlsx');
    eq('the template round-trips through the parser', r.rows.length, 1);
    eq('reference number survives', r.rows[0]?.reference_no, 'PO-4500123456');
    eq('location survives', r.rows[0]?.unit_name, 'Sakar-I');
  }

  // A plain single-sheet file must behave exactly as before: the first sheet.
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const only = [{ name: 'Sheet1', rows: [headers, headers.map(() => '')] }];
    eq('single-sheet file picks its only sheet', pickDataSheet(only, REQUIRED).name, 'Sheet1');
  }

  // No sheet matches, so the first is reported — the caller's "missing required
  // column(s)" message then points at a real sheet.
  {
    const junk = [{ name: 'Notes', rows: [['a', 'b'], ['c', 'd']] }];
    eq('an unmatched workbook falls back to the first sheet', pickDataSheet(junk, REQUIRED).name, 'Notes');
  }
}

section('16. e-invoice / e-way bill — three states, not two');

{
  // GSTR-2B carries neither figure, so the only route into the system is a
  // purchase register column or a manual answer during reconciliation.
  // The distinction that matters: "not checked" must never become "No".
  const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
  const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);

  for (const h of ['E-Invoice', 'E-Invoice IRN', 'E-Way Bill', 'E-Way Bill No']) {
    const field = detectField(normaliseHeader(h), { profile: 'purchase' });
    check(`template header "${h}" is recognised`, !!field, String(field));
  }

  // Yes / No parse; a blank column stays absent rather than meaning "No".
  {
    const row = (over: Record<string, string>) => {
      const base: Record<string, string> = {
        'Our GSTIN': '26AALCS9985J1ZC', 'Document Number': 'INV-1',
        'Supplier GSTIN': '27AAFCC9473R1ZP', 'Taxable Amount': '1000',
        'Document Date': '2026-04-15',
      };
      const all = { ...base, ...over };
      return headers.map((h) => all[h] ?? '');
    };

    const yes = parsePurchaseRegister([headers, row({ 'E-Invoice': 'Yes', 'E-Way Bill': 'Yes', 'E-Way Bill No': '361012345678' })], 'x.xlsx');
    eq('E-Invoice Yes becomes true', yes.rows[0]?.has_e_invoice, true);
    eq('E-Way Bill Yes becomes true', yes.rows[0]?.has_e_way_bill, true);
    eq('e-way bill number is read', yes.rows[0]?.e_way_bill_no, '361012345678');

    const no = parsePurchaseRegister([headers, row({ 'E-Invoice': 'No' })], 'x.xlsx');
    eq('E-Invoice No becomes false', no.rows[0]?.has_e_invoice, false);
    eq('an absent E-Way Bill column stays undefined', no.rows[0]?.has_e_way_bill, undefined);

    const blank = parsePurchaseRegister([headers, row({})], 'x.xlsx');
    eq('blank E-Invoice stays undefined, not false', blank.rows[0]?.has_e_invoice, undefined);
    check('blank does not become false', blank.rows[0]?.has_e_invoice !== false);
  }

  // The same three-state rule applies to the manual save route.
  {
    const { parseEDocField } = await import('../src/app/store');

    const y = parseEDocField('has_e_invoice', 'Yes');
    const n = parseEDocField('has_e_invoice', 'no');
    const u = parseEDocField('has_e_invoice', '');
    eq('manual Yes', y.ok === true ? y.value : 'ERR', true);
    eq('manual No', n.ok === true ? n.value : 'ERR', false);
    eq('manual blank clears to null', u.ok === true ? u.value : 'ERR', null);

    const bad = parseEDocField('has_e_invoice', 'maybe');
    check('a non yes/no answer is rejected', bad.ok === false);

    const irn = parseEDocField('e_invoice_no', '  abc123  ');
    eq('IRN is trimmed', irn.ok === true ? irn.value : 'ERR', 'abc123');
    const long = parseEDocField('e_invoice_no', 'x'.repeat(500));
    eq('an over-long IRN is capped', String(long.ok === true ? long.value : '').length, 100);
  }
}

section('17. preview surfaces the e-doc columns, not just the amounts');

{
  // The parser reading a field is not the same as the operator seeing it. This
  // check exists because the e-invoice / e-way bill columns were read correctly
  // for months while the preview response quietly omitted them, so a working
  // feature looked broken in the screen that proves it works.
  const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
  const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);

  // Every template header that maps to a field must be echoed back by the
  // preview payload, or the preview table will render an empty column.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('src/server/server.ts', 'utf8'),
  );
  const previewBlock = source.slice(
    source.indexOf("/api/purchase-file/preview"),
    source.indexOf("/api/purchase-file/import"),
  );
  for (const c of PURCHASE_TEMPLATE_COLUMNS) {
    if (c.derived) continue;
    // The preview payload names the internal field, so map the header to it.
    const field = detectField(normaliseHeader(c.header), { profile: 'purchase' }) as string;
    // The parser reads the Document Type column through the shared
    // `invoice_type` alias, but the purchase payload names the fact it really is.
    const sent = field === 'invoice_type' ? 'document_type' : field;
    check(
      `preview echoes "${c.header}" (${sent})`,
      previewBlock.includes(`${sent}:`),
      'column read but not sent back, so the preview table shows it blank',
    );
  }

  // And the round trip itself: a filled template row must reach the parser.
  {
    const filled = headers.map((h) => {
      if (h === 'E-Invoice') return 'Yes';
      if (h === 'E-Invoice IRN') return 'IRN-abc123';
      if (h === 'E-Way Bill') return 'No';
      return PURCHASE_TEMPLATE_COLUMNS.find((c) => c.header === h)!.sample;
    });
    const r = parsePurchaseRegister([headers, filled], 'x.xlsx');
    eq('filled template row parses', r.rows.length, 1);
    eq('E-Invoice Yes survives', r.rows[0]?.has_e_invoice, true);
    eq('IRN survives', r.rows[0]?.e_invoice_no, 'IRN-abc123');
    eq('E-Way Bill No survives as false', r.rows[0]?.has_e_way_bill, false);
  }
}

// ---------------------------------------------------------------------------
section('17b. book entry date and Our Location No.');
// ---------------------------------------------------------------------------

{
  const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');

  // ---- the two headers the accounts team asked for ------------------------
  eq(
    'Our Location No. maps to unit_name',
    detectField(normaliseHeader('Our Location No.'), { profile: 'purchase' }),
    'unit_name',
  );
  eq(
    'Book Entry Date maps to book_entry_date',
    detectField(normaliseHeader('Book Entry Date'), { profile: 'purchase' }),
    'book_entry_date',
  );

  // Renaming the header must not break the files already in circulation.
  for (const old of ['Location', 'Unit', 'Plant', 'Location Name', 'Location Code']) {
    eq(
      `"${old}" still maps to unit_name`,
      detectField(normaliseHeader(old), { profile: 'purchase' }),
      'unit_name',
    );
  }

  // "posting date" and "voucher date" already belong to invoice_date, and
  // HEADER_LOOKUP is first-wins. Claiming them for the book entry date would
  // silently move an existing file's invoice date, so they must stay put.
  for (const old of ['Posting Date', 'Voucher Date', 'Invoice Date']) {
    eq(
      `"${old}" is NOT claimed by book_entry_date`,
      detectField(normaliseHeader(old), { profile: 'purchase' }),
      'invoice_date',
    );
  }

  // ---- the template's own rows round-trip ---------------------------------
  {
    const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
    const sample = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample);
    const r = parsePurchaseRegister([headers, sample], 'template.xlsx');
    eq('template sample row parses', r.rows.length, 1);
    eq('book entry date parsed', r.rows[0]?.book_entry_date, '2026-04-20');
    eq('invoice date still parsed', r.rows[0]?.invoice_date, '2026-04-15');
    eq('location number parsed', r.rows[0]?.unit_name, 'Sakar-I');
  }

  // ---- the case the column exists for -------------------------------------
  // A bill invoiced on 18-Apr but booked on 02-May. Both facts must survive:
  // collapsing them would hide exactly the books-vs-return gap this screen
  // exists to show.
  {
    const headers = [
      'Our GSTIN', 'Our Location No.', 'Reference No', 'Invoice No',
      'Invoice Date', 'Book Entry Date', 'Supplier GSTIN', 'Taxable Value', '2B Month',
    ];
    const row = [
      '26AALCS9985J1ZC', '1000', 'PO-4500123457', 'INV-889013',
      '2026-04-18', '2026-05-02', '27AAFCC9473R1ZP', '50000', '2026-04',
    ];
    const r = parsePurchaseRegister([headers, row], 'cross.xlsx');
    eq('cross-month row parses', r.rows.length, 1);
    const b = r.rows[0];
    eq('book entry date kept', b?.book_entry_date, '2026-05-02');
    eq('invoice date kept', b?.invoice_date, '2026-04-18');
    // 2B Month still wins the period, exactly as before this column existed —
    // adding a column must not silently re-base reconciliation.
    eq('period still comes from 2B Month', b?.period, '2026-04');
    eq('book entry month is derivable', b?.book_entry_date?.slice(0, 7), '2026-05');
    eq('location code kept', b?.unit_name, '1000');
    eq('reference still separate', b?.reference_no, 'PO-4500123457');
  }

  // ---- a file without the column must not break ----------------------------
  {
    const headers = ['Our GSTIN', 'Invoice No', 'Invoice Date', 'Supplier GSTIN', 'Taxable Value'];
    const row = ['26AALCS9985J1ZC', 'INV-OLD', '2026-04-10', '27AAFCC9473R1ZP', '1000'];
    const r = parsePurchaseRegister([headers, row], 'old.xlsx');
    eq('a file without the column still parses', r.rows.length, 1);
    eq('book entry date stays absent, not zero', r.rows[0]?.book_entry_date, undefined);
    eq('period still falls back to the invoice date', r.rows[0]?.period, '2026-04');
  }

  // Book entry date is only the LAST resort for the period, so a file with
  // neither a period column nor an invoice date can still be filed.
  {
    const headers = ['Our GSTIN', 'Invoice No', 'Book Entry Date', 'Supplier GSTIN', 'Taxable Value'];
    const row = ['26AALCS9985J1ZC', 'INV-ND', '2026-05-02', '27AAFCC9473R1ZP', '1000'];
    const r = parsePurchaseRegister([headers, row], 'nodate.xlsx');
    eq('row with only a book entry date parses', r.rows.length, 1);
    eq('period falls back to the book entry month', r.rows[0]?.period, '2026-05');
  }

  // ---- both preview screens must render the column ------------------------
  // This has now bitten twice: the field was parsed and stored correctly while
  // a preview table silently left it out, so a working feature looked broken in
  // the exact screen that proves it works. The paste preview has its own column
  // list, separate from the file upload one, so both are checked here.
  {
    const fs = await import('node:fs');
    const html = fs.readFileSync('src/server/public/index.html', 'utf8');
    const colLists = [...html.matchAll(/const cols = \[([\s\S]*?)\];/g)].map((m) => m[1]);

    // The purchase upload preview and the paste preview are the two that show
    // book data. They must be told apart by a column only ONE of them has —
    // matching both by "has supplier_gstin" silently resolves to the same
    // array twice and the second check then proves nothing.
    const purchaseList = colLists.find((l) => l.includes('has_e_way_bill'));
    const pasteList = colLists.find(
      (l) => !l.includes('has_e_way_bill') && l.includes('supplier_gstin') && l.includes('invoice_date'),
    );
    check('purchase preview column list found', !!purchaseList);
    check('paste preview column list found', !!pasteList);
    check(
      'the two preview column lists are genuinely different',
      !!purchaseList && !!pasteList && purchaseList !== pasteList,
      'the paste check was resolving to the upload list and proving nothing',
    );
    check(
      'purchase preview renders book_entry_date',
      !!purchaseList && purchaseList.includes('book_entry_date'),
      'parsed and stored but not shown, so the column reads blank',
    );
    check(
      'paste preview renders book_entry_date',
      !!pasteList && pasteList.includes('book_entry_date'),
      'the paste screen has a separate column list and was missed',
    );
    check(
      'purchase preview renders the derived book_entry_month',
      !!purchaseList && purchaseList.includes('book_entry_month'),
      'the accounts team asked for the book MONTH, not just the date',
    );
    check(
      'paste preview renders the derived book_entry_month',
      !!pasteList && pasteList.includes('book_entry_month'),
      'the paste screen has a separate column list and was missed',
    );
  }

  // ---- one malformed supplier GSTIN must not take the upload down ----------
  // This used to abort the whole import with a raw
  // "value too long for type character varying(15)" 500, so a single typo in a
  // 900-row register destroyed 899 good rows. Truncating instead would file the
  // purchase under a registration that does not exist, so the row is reported.
  {
    const headers = ['Our GSTIN', 'Invoice No', 'Invoice Date', 'Supplier GSTIN', 'Taxable Value'];
    const good = ['26AALCS9985J1ZC', 'INV-GOOD', '2026-04-10', '27AAFCC9473R1ZP', '1000'];
    const bad = ['26AALCS9985J1ZC', 'INV-BAD', '2026-04-11', 'Crompton Greaves, Ltd.', '2000'];
    const r = parsePurchaseRegister([headers, good, bad], 'mixed.xlsx');
    eq('the good row still imports', r.rows.length, 1);
    eq('and it is the right one', r.rows[0]?.invoice_no, 'INV-GOOD');
    eq('the malformed row is skipped', r.skipped.length, 1);
    check(
      'the skip reason names the problem',
      /supplier GSTIN is not a valid 15-character GSTIN/.test(r.skipped[0]?.reason || ''),
      r.skipped[0]?.reason,
    );
    // Nothing from the file's own text is echoed into the reason, because this
    // string is rendered in the browser.
    check(
      'the reason does not echo the rejected value back',
      !(r.skipped[0]?.reason || '').includes('Crompton'),
      'file content must not be reflected into the UI',
    );
  }

  // ---- the derived month the accounts team asked for ------------------------
  // Only the date is stored; the month is derived from it so the two can never
  // disagree. A purchase invoiced in April and booked in May must read as two
  // different months, which is the entire reason the column exists.
  {
    const { shapeLine } = await import('../src/app/store');

    const crossed = shapeLine({
      book_entry_date: '2026-05-02',
      book_igst: 180, book_cgst: 0, book_sgst: 0, book_cess: 0,
      period: '2026-04', matched_2b_month: '2026-04',
    });
    eq('book entry month derived from the date', crossed.book_entry_month, '2026-05');
    eq('book entry month has a readable label', !!crossed.bookEntryMonthLabel, true);
    eq('the period is untouched by the derived month', crossed.period, '2026-04');

    // Same month: the two agree, which is the common case.
    eq(
      'same-month row derives its own month',
      shapeLine({ book_entry_date: '2026-04-15', period: '2026-04' }).book_entry_month,
      '2026-04',
    );

    // A Date must work too, not just the string the type parser hands back.
    eq(
      'a Date value derives the same month',
      shapeLine({ book_entry_date: new Date('2026-05-02T00:00:00Z'), period: '2026-04' }).book_entry_month,
      '2026-05',
    );

    // No date at all must stay empty, never become a bogus month.
    eq('absent book entry date yields no month', shapeLine({ period: '2026-04' }).book_entry_month, null);
    eq('an empty string yields no month', shapeLine({ book_entry_date: '', period: '2026-04' }).book_entry_month, null);
  }
}

// ---------------------------------------------------------------------------
section('17c. P&L versus GSTR-1 engine');
// ---------------------------------------------------------------------------

{
  const { reconcilePlVsGstr1, gstr1SliceFor, summarisePeriods } =
    await import('../src/engine/pl-recon');
  type PlHeadDefLike = import('../src/engine/pl-recon').PlHeadDef;
  type Gstr1DocLike = import('../src/engine/pl-recon').Gstr1DocLite;

  const head = (over: Partial<PlHeadDefLike> = {}): PlHeadDefLike => ({
    id: 1, name: 'Taxable Sales', group_name: 'Turnover', sequence: 10,
    head_kind: 'SALE', is_mandatory: true, gst_applicable: true,
    taxable_type: 'Taxable', return_mapping: 'GSTR-1',
    gstr1_table: 'B2B/B2CL/B2CS', include_in_gstr1: true, ...over,
  });
  const doc = (over: Partial<Gstr1DocLike> = {}): Gstr1DocLike => ({
    gstin: '26AALCS9985J1ZC', table_type: 'B2B', taxable_value: 100000,
    rate: 18, igst: 18000, cgst: 0, sgst: 0, cess: 0, ...over,
  });

  // ---- a head that agrees is reconciled ----------------------------------
  {
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000 }], [doc()]);
    eq('an agreeing head is Reconciled', r.rows[0].status, 'Reconciled');
    eq('and the difference is zero', r.rows[0].difference, 0);
    eq('the P&L total is read', r.totalPl, 100000);
    eq('the GSTR-1 total is read', r.totalGstr1Taxable, 100000);
    eq('one GSTIN was involved', r.gstinCount, 1);
  }

  // ---- the basis decision, which is the whole ball game --------------------
  // The P&L is tax exclusive, so it is compared with taxable_value and NEVER
  // with invoice_value. Comparing a gross figure with a taxable one would show
  // a difference exactly equal to the tax on every single head.
  {
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000 }], [doc()]);
    eq('the comparison uses the taxable value', r.rows[0].gstr1_taxable, 100000);
    eq('the tax is reported alongside, not compared', r.rows[0].gstr1_tax, 18000);
    eq('invoice value is carried for information only', r.rows[0].gstr1_invoice_value, 118000);
    eq('a gross P&L figure would show a difference', reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 118000 }], [doc()]).rows[0].difference, 18000);
  }

  // ---- a difference is not an answer -------------------------------------
  {
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 90000 }], [doc()]);
    eq('a differing head is Pending Review', r.rows[0].status, 'Pending Review');
    eq('with the shortfall visible', r.rows[0].difference, -10000);
    eq('and no reason invented for it', r.rows[0].reason, '');
    eq('the headline counts it', r.pendingHeads, 1);
  }

  // ---- tolerance: two paise is not a finding -----------------------------
  {
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000.5 }], [doc()]);
    eq('half a rupee is not a difference', r.rows[0].status, 'Reconciled');
  }

  // ---- GSTIN detail survives the summing ---------------------------------
  {
    const docs = [
      doc({ gstin: '26AALCS9985J1ZC', taxable_value: 60000, igst: 10800 }),
      doc({ gstin: '24AALCS9985J1ZG', taxable_value: 40000, igst: 7200 }),
    ];
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000 }], docs);
    eq('two GSTINs combine to one company figure', r.rows[0].gstr1_taxable, 100000);
    eq('both GSTINs are counted', r.rows[0].gstin_count, 2);
    eq('and both are still listed underneath', r.rows[0].gstin_breakdown.length, 2);
    eq('the split is exact', r.rows[0].gstin_breakdown.map((s: any) => s.taxable_value).sort((a: number, b: number) => a - b).join(','), '40000,60000');
    eq('company GSTIN count', r.gstinCount, 2);
  }

  // ---- credit notes stay in their own row --------------------------------
  {
    const heads = [
      head({ id: 1, sequence: 10, gstr1_table: 'B2B/B2CL/B2CS' }),
      head({ id: 2, name: 'Credit Notes / Sales Returns', sequence: 50, head_kind: 'CREDIT_NOTE', gstr1_table: 'CDNR' }),
    ];
    const docs = [doc({ table_type: 'B2B', taxable_value: 100000 }), doc({ table_type: 'CDNR', taxable_value: 5000 })];
    const r = reconcilePlVsGstr1(heads, [{ head_id: 1, amount: 100000 }, { head_id: 2, amount: 5000 }], docs);
    eq('the sale row is not netted', r.rows[0].gstr1_taxable, 100000);
    eq('the credit note has its own row', r.rows[1].gstr1_taxable, 5000);
    eq('and its own status', r.rows[1].status, 'Reconciled');
  }

  // ---- Other Income is reported, never forced into a return ---------------
  {
    const other = head({ id: 9, name: 'Other Income', head_kind: 'OTHER_INCOME', gst_applicable: false, gstr1_table: null, include_in_gstr1: false });
    const r = reconcilePlVsGstr1([other], [{ head_id: 9, amount: 25000 }], [doc()]);
    eq('Other Income is Not Mapped', r.rows[0].status, 'Not Mapped');
    eq('with the outside-GST reason', r.rows[0].reason, 'other_income_non_gst');
    eq('the amount is still reported', r.outsideGstAmount, 25000);
    eq('but it is NOT in the GST headline', r.totalPl, 0);
    eq('and the row shows NO difference, because nothing was compared', r.rows[0].difference, 0);
    eq('and it creates no difference', r.totalDifference, 0);
  }

  // ---- a table the draft cannot produce says so, rather than claiming zero -
  {
    for (const [table, label] of [['EXP', 'EXP'], ['EXEMPT', 'EXEMPT']] as const) {
      const r = reconcilePlVsGstr1([head({ gstr1_table: table })], [{ head_id: 1, amount: 50000 }], [doc()]);
      eq(`${label} is Not Mapped`, r.rows[0].status, 'Not Mapped');
      check(`${label} says why`, !!r.rows[0].reason, r.rows[0].reason);
      eq(`${label} creates no fake difference`, r.totalDifference, 0);
      eq(`${label} row difference is zero too`, r.rows[0].difference, 0);
      eq(`${label} is not in the headline`, r.totalPl, 0);
    }
  }

  // ---- nil-rated rows are not counted twice -------------------------------
  {
    const docs = [doc({ taxable_value: 100000, rate: 18 }), doc({ table_type: 'B2CS', taxable_value: 20000, rate: 0, igst: 0 })];
    const nilHead = head({ id: 2, name: 'Nil / Zero Rated Sales', sequence: 40, gstr1_table: 'NIL' });
    const sale = head({ id: 1 });
    const r = reconcilePlVsGstr1([sale, nilHead], [{ head_id: 1, amount: 100000 }, { head_id: 2, amount: 20000 }], docs);
    eq('the zero-rated row goes to Nil, not Taxable Sales', r.rows[0].gstr1_taxable, 100000);
    eq('and it lands on Nil Rated', r.rows[1].gstr1_taxable, 20000);
    eq('neither row is double counted', r.totalGstr1Taxable, 120000);
  }

  // ---- the latest amendment wins ------------------------------------------
  {
    const r = reconcilePlVsGstr1(
      [head()],
      [{ head_id: 1, amount: 100000, amendment_no: 0 }, { head_id: 1, amount: 95000, amendment_no: 1 }],
      [doc()],
    );
    eq('the corrected amendment is the one used', r.totalPl, 95000);
    eq('and it shows as the difference it is', r.rows[0].difference, -5000);
  }

  // ---- rows come back in reporting order ---------------------------------
  {
    const heads = [
      head({ id: 3, name: 'Nil / Zero Rated Sales', sequence: 40, gstr1_table: 'NIL' }),
      head({ id: 1, name: 'Taxable Sales', sequence: 10 }),
      head({ id: 2, name: 'Export Sales', sequence: 20, gstr1_table: 'EXP' }),
    ];
    const r = reconcilePlVsGstr1(heads, [], []);
    eq('rows follow the P&L order, not the alphabet',
      r.rows.map((x: any) => x.head_name).join(' | '),
      'Taxable Sales | Export Sales | Nil / Zero Rated Sales');
  }

  // ---- B2B documents carry no rate, and must not be treated as nil-rated --
  // The portal's B2B table has no rate column, so our rate is NULL. Reading
  // NULL as 0 swept every B2B line out of Taxable Sales and left the whole
  // comparison running against nothing.
  {
    const b2b = doc({ table_type: 'B2B', rate: null });
    const r = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000 }], [b2b]);
    eq('a NULL-rate B2B document still counts as a taxable supply', r.rows[0].gstr1_taxable, 100000);
    eq('and it reconciles', r.rows[0].status, 'Reconciled');
    const nilOnly = reconcilePlVsGstr1(
      [head({ id: 2, sequence: 40, gstr1_table: 'NIL' })],
      [{ head_id: 2, amount: 0 }], [b2b]);
    eq('a NULL-rate B2B document is NOT nil-rated', nilOnly.rows[0].gstr1_taxable, 0);
  }

  // ---- the slice helper on its own ---------------------------------------
  {
    eq('a CDNR head only sees CDNR rows', gstr1SliceFor(head({ gstr1_table: 'CDNR' }), [doc(), doc({ table_type: 'CDNR', taxable_value: 7 })]).documents, 1);
    eq('an unmapped table is reported as unsupported', gstr1SliceFor(head({ gstr1_table: 'MYSTERY' }), [doc()]).supported, false);
  }

  // ---- the cross-period summary -----------------------------------------
  {
    const a = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 100000 }], [doc()]);
    const b = reconcilePlVsGstr1([head()], [{ head_id: 1, amount: 90000 }], [doc()]);
    const s = summarisePeriods([a, b]);
    eq('the summary adds the P&L', s.pl, 190000);
    eq('and the difference', s.difference, -10000);
    eq('and counts one match, one pending', `${s.matched}/${s.pending}`, '1/1');
  }
}

// ---------------------------------------------------------------------------
section('17e. the whole UI script must parse');
// ---------------------------------------------------------------------------

{
  // The application is one large inline <script>. A single stray quote in an
  // inline handler turns the rest of that line into a regex literal and the
  // ENTIRE screen stops working — with no server error and no useful log, just
  // a blank page. Nothing else in the suite would notice, because every other
  // test exercises TypeScript rather than the page.
  const fs = await import('node:fs');
  const html = fs.readFileSync('src/server/public/index.html', 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  check('the page carries an inline script', !!script);
  if (script) {
    let err = '';
    try {
      // eslint-disable-next-line no-new-func
      new Function(script[1]);
    } catch (e: any) {
      err = e.message;
    }
    check('the inline script parses', err === '', err);
  }

  // And the screen's own pieces are all wired up, so a rename cannot leave a
  // nav entry pointing at a view that no longer exists.
  for (const id of ['viewPl', 'plTiles', 'plTable', 'plPreviewCard', 'plPeriod', 'plFile']) {
    check(`the P&L screen has #${id}`, html.includes(`id="${id}"`));
  }
  check('the P&L screen is routed', html.includes("if (v === 'pl') loadPl()"));
  check('the P&L screen has a nav entry', /id: 'pl-recon'/.test(html));
  check('and is in VIEWS, without which showView never reveals it',
    /const VIEWS = \[[^\]]*'pl'[^\]]*\]/.test(html.replace(/\s+/g, ' ')));

  // The general form of that bug: a nav entry whose `view:` is not in VIEWS
  // loads its data but never becomes visible, which looks exactly like a
  // broken screen. Every live entry is checked rather than just the new one.
  {
    const viewList = /const VIEWS = \[([\s\S]*?)\];/.exec(html);
    const views = new Set((viewList?.[1] || '').match(/'([A-Za-z]+)'/g)?.map((s) => s.replace(/'/g, '')) || []);
    const navViews = [...html.matchAll(/view: '([A-Za-z]+)'/g)].map((m) => m[1]);
    check('the app has nav entries with a view', navViews.length > 0, String(navViews.length));
    const orphans = [...new Set(navViews.filter((v) => !views.has(v)))];
    check(
      'every nav view is registered in VIEWS',
      orphans.length === 0,
      orphans.length ? `these nav entries load data but never show: ${orphans.join(', ')}` : '',
    );
    // And every registered view that the router loads must have its markup.
    const missing = [...views].filter((v) => !html.includes(`id="view${v[0].toUpperCase()}${v.slice(1)}"`));
    check('every registered view has its markup', missing.length === 0, missing.join(', '));
  }
  for (const fn of ['loadPl', 'plLoad', 'plPreview', 'plImport', 'plRecon', 'plExplain', 'plTpl']) {
    check(`the P&L screen defines ${fn}()`, new RegExp(`function ${fn}\\(`).test(html));
  }
}

// ---------------------------------------------------------------------------
section('17d. P&L upload parsing');
// ---------------------------------------------------------------------------

{
  const { parsePlUpload, plPeriod, readPlFile } = await import('../src/app/pl-store');

  eq('YYYY-MM passes', plPeriod('2026-04'), '2026-04');
  eq('MM-YYYY passes', plPeriod('04-2026'), '2026-04');
  eq('YYYYMM passes', plPeriod('202604'), '2026-04');
  eq('Apr-26 passes', plPeriod('Apr-26'), '2026-04');
  eq('junk is empty, not a guess', plPeriod('sometime'), '');
  // The workbook reader hands a "2026-03" cell over as a Date, not as text.
  // Missing this made every period in a CSV upload report as missing while the
  // same file uploaded as .xlsx worked.
  eq('a Date cell is understood', plPeriod(new Date(2026, 2, 1)), '2026-03');
  eq('a Date cell in another month', plPeriod(new Date(2025, 11, 15)), '2025-12');
  eq('an invalid Date is not a guess', plPeriod(new Date('nonsense')), '');
  {
    const r = parsePlUpload([['P&L Head', 'Period', 'Amount'], ['Taxable Sales', new Date(2026, 2, 1), '1000']], 'dates.csv');
    eq('a row whose period arrived as a Date still parses', r.rows.length, 1);
    eq('with the right period', r.rows[0]?.period, '2026-03');
  }

  {
    const rows = [
      ['P&L STATEMENT'],
      [],
      ['P&L Head', 'Period', 'Amount', 'Remarks'],
      ['Taxable Sales', '2026-04', '1,00,000.00', ''],
      ['Other Income', '2026-04', '25000', 'interest'],
      ['Total', '2026-04', '125000', ''],
      ['Total Turnover', '', '', ''],
    ];
    const r = parsePlUpload(rows, 'pl.csv');
    eq('the header row is found below a title banner', r.headerRowIndex, 2);
    eq('both real rows are read', r.rows.length, 2);
    eq('Indian digit grouping is understood', r.rows[0].amount, 100000);
    eq('and the head name is kept', r.rows[0].headName, 'Taxable Sales');
    eq('the totals row is not treated as a head', r.rows.some((x) => /^total/i.test(x.headName)), false);
    eq('each line knows its row', r.rows[1].sourceRow, 5);
  }

  // A header that is missing the amount cannot be interpreted at all, and must
  // say so rather than importing zeroes.
  {
    const r = parsePlUpload([['P&L Head', 'Period'], ['Taxable Sales', '2026-04']], 'pl.csv');
    eq('a file with no amount column reads nothing', r.rows.length, 0);
    check('and explains why', /Amount/.test(r.skipped[0]?.reason || ''), r.skipped[0]?.reason);
  }

  // The template's own headers must be the ones the parser knows, or the file
  // we hand out is a file we cannot read.
  {
    const { PL_TEMPLATE_COLUMNS } = await import('../src/app/pl-template');
    const headers = PL_TEMPLATE_COLUMNS.map((c) => c.header);
    const sample = PL_TEMPLATE_COLUMNS.map((c) => c.sample);
    const r = parsePlUpload([headers, sample], 'template.csv');
    eq('the P&L template sample row parses', r.rows.length, 1);
    eq('with the right head', r.rows[0].headName, 'Taxable Sales');
    eq('and the right period', r.rows[0].period, '2026-04');
    eq('and the right amount', r.rows[0].amount, 1000000);
    const bad = parsePlUpload([headers, headers.map(() => '')], 'template.csv');
    eq('an empty template row reads nothing', bad.rows.length, 0);
  }
}

// ---------------------------------------------------------------------------
section('18. GSTR-1 draft adapter');
// ---------------------------------------------------------------------------
{
  const sales: SalesInvoice[] = [
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Reg', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'SVN/1', invoice_date: '2025-04-15', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, invoice_value: 11800 },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Walk-in', customer_gstin: '', invoice_no: 'CASH-1', invoice_date: '2025-04-16', period: '2025-04', invoice_type: 'R', place_of_supply: '', reverse_charge: false, taxable_value: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0, invoice_value: 5900 },
    { our_gstin: '26AALCS9985J1ZC', customer_name: 'Walk-in 2', customer_gstin: '', invoice_no: 'CASH-2', invoice_date: '2025-04-17', period: '2025-04', invoice_type: 'R', place_of_supply: '', reverse_charge: false, taxable_value: 3000, igst: 0, cgst: 270, sgst: 270, cess: 0, invoice_value: 3540 },
  ];
  const model = buildGstr1('26AALCS9985J1ZC', sales);
  const docs = draftDocuments(model, new Map([['SVN1', 7]]));

  eq('adapter: one document per B2B invoice plus B2CS aggregates', docs.length, 2);
  eq('adapter: the B2CS bucket collapses two walk-in sales into one row', docs.filter((d) => d.table_type === 'B2CS').length, 1);
  const b2cs = docs.find((d) => d.table_type === 'B2CS')!;
  eq('adapter: collapsed B2CS taxable value is the sum', b2cs.taxable_value, 8000);
  eq('adapter: collapsed B2CS tax is the sum', b2cs.igst + b2cs.cgst + b2cs.sgst, 1440);
  eq('adapter: a B2CS row has no invoice number', b2cs.invoice_number_raw, '');
  eq('adapter: a B2CS row has no invoice date', b2cs.invoice_date, null);
  eq('adapter: the B2CS key carries its rate slab', b2cs.invoice_number_norm, b2csKey(18));
  eq('adapter: the B2CS row states its rate', b2cs.rate, 18);
  eq('adapter: the book invoice id is attached when the number is known', (docs.find((d) => d.table_type === 'B2B') as any).sales_invoice_id, 7);
  eq('adapter: every document carries the period', new Set(docs.map((d) => d.period)).size, 1);
}

// ---------------------------------------------------------------------------
section('19. outward reconciliation statuses');
// ---------------------------------------------------------------------------
{
  const base = classifyFiled({
    our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2B',
    invoice_number: 'SVN/1', invoice_date: '2025-04-15',
    recipient_gstin: '27AAECA2190C1Z3', taxable_value: 10000, igst: 1800, invoice_value: 11800,
  })!;

  const clone = (over: Partial<Gstr1Document> = {}): Gstr1Document =>
    ({ ...base, ...over }) as Gstr1Document;

  eq('identical draft and filed is Matched', reconcile([base], [clone()])[0].status, 'Matched');

  eq(
    'a filed document with no book invoice is Declared Not In Books',
    reconcile([], [clone()])[0].status,
    'Declared Not In Books',
  );
  eq(
    'a book invoice the return omits is Not Declared',
    reconcile([base], [])[0].status,
    'Not Declared',
  );

  {
    const out = reconcile([base], [clone({ taxable_value: 9000, igst: 1620 })])[0];
    eq('a changed amount is an Amount Mismatch', out.status, 'Amount Mismatch');
    eq('the mismatch reports the taxable difference', out.difference_details.taxableDifference, -1000);
    eq('the mismatch reports the tax difference', out.difference_details.taxDifference, -180);
  }

  // Within a rupee is not a difference: GST allows that much rounding.
  eq(
    'a sub-rupee difference still counts as Matched',
    reconcile([base], [clone({ taxable_value: 10000.4 })])[0].status,
    'Matched',
  );
  eq(
    'a difference of exactly one rupee is still Matched',
    reconcile([base], [clone({ taxable_value: 10001 })])[0].status,
    'Matched',
  );

  {
    // Filed into a different table. Both sides keep their invoice number, which
    // is how this actually arises — the CA had a GSTIN the books did not.
    const out = reconcile([clone()], [clone({ table_type: 'B2CL' })])[0];
    eq('the same document in two tables is a Table Mismatch', out.status, 'Table Mismatch');
    eq('the mismatch names both tables', out.difference_details.filedAs, 'B2CL');
  }

  {
    const out = reconcile(
      [clone()],
      [clone({ recipient_gstin_norm: '24AAECA2190C1Z3', recipient_gstin_raw: '24AAECA2190C1Z3' })],
    )[0];
    eq('a different recipient GSTIN is a Recipient Mismatch', out.status, 'Recipient Mismatch');
    eq('the mismatch shows the books GSTIN', out.difference_details.booksGstin, '27AAECA2190C1Z3');
  }

  {
    // An empty GSTIN is absent data, not a disagreement about the customer.
    const out = reconcile([clone({ recipient_gstin_norm: null })], [clone()])[0];
    eq('a blank recipient on one side is not a Recipient Mismatch', out.status, 'Matched');
  }

  {
    const out = reconcile([base], [clone(), clone()])[0];
    eq('the same document filed twice is a Duplicate', out.status, 'Duplicate');
    eq('the duplicate counts both filed rows', out.difference_details.filedRows, 2);
  }

  {
    const cdnr = clone({ table_type: 'CDNR', invoice_type: 'CDNR', note_ref_number: null, taxable_value: -1000, igst: -180 });
    const out = reconcile([cdnr], [{ ...cdnr, note_ref_number: 'SVN-1' }])[0];
    eq('a credit note with no original reference is flagged', out.status, 'Credit Note Missing Ref');
  }
  {
    const cdnr = clone({ table_type: 'CDNR', invoice_type: 'CDNR', note_ref_number: 'SVN-9', taxable_value: -1000, igst: -180 });
    eq(
      'a properly linked credit note reconciles',
      reconcile([cdnr], [{ ...cdnr }])[0].status,
      'Matched',
    );
  }

  eq(
    'every outcome carries an action',
    reconcile([base], [clone({ taxable_value: 1 })]).every((o) => !!o.action),
    true,
  );

  // B2CS arrives from the portal as one row per place of supply and rate, so
  // two states at one rate are two rows on one side and one aggregate on ours.
  {
    const a = classifyFiled({ our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2CS', place_of_supply: '24', rate: 18, taxable_value: 5000, igst: 900 })!;
    const b = classifyFiled({ our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2CS', place_of_supply: '27', rate: 18, taxable_value: 3000, igst: 540 })!;
    eq('two B2CS rows at one rate share one key', a.invoice_number_norm, b.invoice_number_norm);
    eq('they fold into a single aggregate', foldFiledB2cs([a, b]).length, 1);
    eq('the folded aggregate sums the taxable value', foldFiledB2cs([a, b])[0].taxable_value, 8000);

    const draftBucket = classifyFiled({ our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2CS', rate: 18, taxable_value: 8000, igst: 1440 })!;
    const out = reconcile([draftBucket], [a, b])[0];
    eq('one draft aggregate matches two filed B2CS rows', out.status, 'Matched');
  }

  // A B2CS export that omits the rate still has to land on the draft's key.
  {
    const noRate = classifyFiled({ our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2CS', taxable_value: 10000, igst: 1800 })!;
    eq('a B2CS row with no rate is derived from its amounts', noRate.rate, 18);
    eq('and takes the same key as the draft would', noRate.invoice_number_norm, b2csKey(18));
  }
}

// ---------------------------------------------------------------------------
section('20. outward summary and money headline');
// ---------------------------------------------------------------------------
{
  const b2b = classifyFiled({ our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'B2B', invoice_number: 'A', invoice_date: '2025-04-01', recipient_gstin: '27AAECA2190C1Z3', taxable_value: 10000, igst: 1800 })!;
  const rows = summarise([b2b], [b2b]);
  eq('a table present on both sides and equal is OK', rows[0].status, 'OK');
  eq('the summary reports the B2B count', rows[0].filed_count, 1);
  eq('a table absent from one side is Missing Side', summarise([b2b], []).find((r) => r.table_type === 'B2B')!.status, 'Missing Side');
  eq('a table absent from BOTH sides is not reported at all', summarise([], []).length, 0);

  const off = summarise([b2b], [{ ...b2b, taxable_value: 9000, igst: 1620 }]);
  eq('a table whose money differs is Both Diff', off[0].status, 'Both Diff');
  eq('the summary carries the tax difference', off[0].tax_difference, -180);

  // A table mismatch is a real finding but moves no money, so it must not be
  // allowed to inflate the rupee headline.
  const tableOff = reconcile([b2b], [{ ...b2b, table_type: 'B2CL' }]);
  const t = countOutcomes(tableOff, [b2b], [{ ...b2b, table_type: 'B2CL' }]);
  eq('a table mismatch is counted', t.table_mismatch, 1);
  eq('a table mismatch moves no money', t.tax_difference, 0);
  eq('has_filed_data is true when a filed return exists', t.has_filed_data, true);
  eq('has_filed_data is false without one', countOutcomes([], [b2b], []).has_filed_data, false);
}

// ---------------------------------------------------------------------------
section('21. GSTR-1 portal export parsing');
// ---------------------------------------------------------------------------
{
  eq('money: Indian grouping parses', parseMoney('1,23,456.78'), 123456.78);
  eq('money: a rupee sign is stripped', parseMoney('₹1,000.00'), 1000);
  eq('money: parentheses mean a credit, not a small positive', parseMoney('(1,234.00)'), -1234);
  eq('money: a leading minus survives', parseMoney('-99.5'), -99.5);
  eq('money: blank is zero, not NaN', parseMoney(''), 0);
  eq('money: junk is zero, not a crash', parseMoney('n/a'), 0);

  eq('table from a portal tab name', detectTable('b2b', []), 'B2B');
  eq('table from a portal tab name, capitalised', detectTable('B2CL Invoices', []), 'B2CL');
  eq('table from a portal tab name with a suffix', detectTable('cdnr', []), 'CDNR');
  eq('a note-number column means CDNR even on an unnamed sheet', detectTable('Sheet1', ['Note Number', 'Taxable Value (₹)']), 'CDNR');
  eq('an unrecognised sheet with recipient GSTINs defaults to B2B', detectTable('Sheet1', ['GSTIN of Recipient', 'Invoice Number']), 'B2B');

  eq('table names parse from words as well as codes', parseTableType('Credit/Debit Notes'), 'CDNR');
  eq('table names parse from b2ba', parseTableType('B2BA'), 'B2B');

  // The portal's b2b sheet is RATE-WISE: one invoice, several rows, with the
  // invoice value repeated on each. Summing everything would double the
  // invoice value and report a difference that does not exist.
  {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['GSTIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice Date', 'Invoice Value(₹)', 'Place Of Supply', 'Reverse Charge', 'Rate', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
      ['27AAECA2190C1Z3', 'Acme Ltd', 'SVN/1', '2025-04-15', 11800, '27', 'N', 18, 6000, 0, 540, 540, 0],
      ['27AAECA2190C1Z3', 'Acme Ltd', 'SVN/1', '2025-04-15', 11800, '27', 'N', 18, 4000, 0, 360, 360, 0],
      ['24AAECA2190C1Z3', 'Other Ltd', 'SVN/2', '2025-04-16', 23600, '24', 'N', 18, 20000, 3600, 0, 0, 0],
    ]), 'b2b');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const parsed = parseFiledWorkbook(buf, { our_gstin: '26AALCS9985J1ZC', period: '2025-04' });
    eq('two rate lines fold into one invoice', parsed.rows.length, 2);
    eq('the folded taxable value is summed', parsed.rows.find((r) => r.invoice_number === 'SVN/1')!.taxable_value, 10000);
    eq('the folded tax is summed', parsed.rows.find((r) => r.invoice_number === 'SVN/1')!.igst, 0);
    eq('the folded CGST is summed', parsed.rows.find((r) => r.invoice_number === 'SVN/1')!.cgst, 900);
    eq('the invoice value is taken once, not summed', parsed.rows.find((r) => r.invoice_number === 'SVN/1')!.invoice_value, 11800);
    eq('the sheet name set the table', parsed.tableOfSheet.b2b, 'B2B');
    eq('the GSTIN fallback is applied', parsed.rows[0].our_gstin, '26AALCS9985J1ZC');
    eq('the period comes from the invoice date', parsed.rows[0].period, '2025-04');

    // The folded invoice must reconcile against a draft built from the books.
    const draft = draftDocuments(buildGstr1('26AALCS9985J1ZC', [
      { our_gstin: '26AALCS9985J1ZC', customer_name: 'Acme Ltd', customer_gstin: '27AAECA2190C1Z3', invoice_no: 'SVN/1', invoice_date: '2025-04-15', period: '2025-04', invoice_type: 'R', place_of_supply: '27', reverse_charge: false, taxable_value: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0, invoice_value: 11800 },
    ])).filter((d) => d.table_type === 'B2B');
    const filed = reconcile(draft, classifyFiledRows(parsed.rows));
    eq('a real portal export reconciles against the draft', filed.length, 2);
    eq('the invoice the books also carry is Matched', filed.find((o) => o.invoice_number_norm === 'SVN1')!.status, 'Matched');
    eq('the invoice the books lack is Declared Not In Books', filed.find((o) => o.invoice_number_norm === 'SVN2')!.status, 'Declared Not In Books');
  }

  // On a cdnr sheet "Invoice Number" is the invoice being credited, and the
  // note itself is "Note Number". Swapping them would reconcile every credit
  // note against the wrong document.
  {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['GSTIN of Recipient', 'Receiver Name', 'Note Number', 'Note Type', 'Note Date', 'Note Value(₹)', 'Place Of Supply', 'Invoice Number', 'Invoice Date', 'Rate', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
      ['27AAECA2190C1Z3', 'Acme Ltd', 'CN-1', 'C', '2025-04-20', -1180, '27', 'SVN/1', '2025-04-02', 18, -1000, 0, -90, -90, 0],
    ]), 'cdnr');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseFiledWorkbook(buf, { our_gstin: '26AALCS9985J1ZC', period: '2025-04' });
    eq('the credit note sheet parses one row', parsed.rows.length, 1);
    eq('the note number is the document', parsed.rows[0].invoice_number, 'CN-1');
    eq('the original invoice becomes the reference', parsed.rows[0].note_ref_number, 'SVN/1');
    eq('the note date is the document date', parsed.rows[0].invoice_date, '2025-04-20');
    eq('the negative taxable value survives', parsed.rows[0].taxable_value, -1000);
    eq('the sheet name set CDNR', parsed.tableOfSheet.cdnr, 'CDNR');
  }

  // A file with a cover sheet must not parse to zero rows.
  {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Instructions'], ['Download the GSTR-1 summary before uploading.']]), 'Read me');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['GSTIN of Recipient', 'Invoice Number', 'Invoice Date', 'Rate', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)'],
      ['27AAECA2190C1Z3', 'SVN/9', '2025-04-15', 18, 1000, 180, 0, 0],
    ]), 'b2b');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseFiledWorkbook(buf, { our_gstin: '26AALCS9985J1ZC', period: '2025-04' });
    eq('a cover sheet does not hide the data sheet', parsed.rows.length, 1);
    eq('and the data sheet is the one reported', parsed.perSheet.b2b, 1);
  }
}

// ---------------------------------------------------------------------------
section('22. dates read back from the database');
// ---------------------------------------------------------------------------
{
  // node-pg parses a DATE into local midnight. Converting to UTC first shifts
  // it back a day in IST — which put every invoice date on the reconciliation
  // screen one day early, and stopped any drafted invoice from ever matching
  // its filed counterpart.
  const localMidnight = new Date(2024, 3, 17); // 17 April 2024, local
  eq('isoDate formats a local-midnight Date without shifting it', isoDate(localMidnight), '2024-04-17');
  eq('isoDate passes a plain date string through', isoDate('2024-04-17'), '2024-04-17');
  eq('isoDate passes an ISO timestamp through', isoDate('2024-04-17T00:00:00.000Z'), '2024-04-17');
  eq('isoDate renders nothing for null', isoDate(null), '');
  eq('isoDate renders nothing for undefined', isoDate(undefined), '');
  check(
    'isoDate agrees with the local calendar day',
    isoDate(new Date(2025, 11, 31)) === '2025-12-31',
    isoDate(new Date(2025, 11, 31)),
  );
}

// ---------------------------------------------------------------------------
section('23. no handler may answer a request twice');
// ---------------------------------------------------------------------------
{
  // A handler that writes a response and then throws used to send a SECOND
  // response from inside wrap()'s catch. That second send throws as well, so the
  // rejection is never handled — and Node exits, taking the ERP down for every
  // user on the network. It was reachable from a plain GET: the P&L template
  // download with no `?company=`, because the shared company resolver answered
  // 400 itself and the handler then carried on to send the file.
  const fs = await import('node:fs');
  const server = fs.readFileSync('src/server/server.ts', 'utf8');

  const wrapBody = server.slice(server.indexOf('const wrap ='), server.indexOf('function actorOf'));
  check('wrap() still guards against a response that was already sent',
    wrapBody.includes('res.headersSent'), 'no headersSent guard');
  check('and the guard sits BEFORE the 500 reply, not after',
    wrapBody.indexOf('res.headersSent') < wrapBody.indexOf('res.status(500)'), 'guard is unreachable');

  // The lookup must be pure: it may only report, never respond. If it ever
  // writes to `res`, every caller that continues afterwards crashes again.
  const lookupBody = server.slice(server.indexOf('async function lookupCompany'), server.indexOf('async function resolveCompany'));
  check('the company lookup takes no response object', !/\bres\b/.test(lookupBody), 'lookup touches res');
  check('the lookup returns a result instead of writing one',
    lookupBody.includes('CompanyLookup'), 'lookup does not return a result type');

  // Naming the file for both templates, because both were broken.
  for (const f of ['xlsx', 'csv']) {
    const at = server.indexOf(`/api/template/pl.${f}`);
    const body = server.slice(at, server.indexOf('}));', at));
    check(`the pl.${f} template serves a file even with no company named`,
      body.includes('optionalCompanyId'), 'still calls the responding resolver');
    check(`and never uses the resolver that writes its own 400 (pl.${f})`,
      !body.includes('resolveCompany'), 'would answer twice');
  }

  // Routine paths must keep the strict resolver, or a missing company would
  // silently read the wrong company's data instead of failing.
  for (const route of ['/api/pl/heads', '/api/pl/outcomes', '/api/pl/reconcile']) {
    const at = server.indexOf(`'${route}'`);
    if (at < 0) continue;
    const body = server.slice(at, server.indexOf('}));', at));
    check(`${route} still insists on a company`,
      body.includes('resolveCompany(req, res)'), 'lost its company check');
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('24. financial year labels and the month picker');
// ---------------------------------------------------------------------------

{
  // March belongs to the financial year that STARTED the previous April: Mar-26
  // is the last month of FY 2025-26, not the first month of 2026-27. The month
  // control centre labelled Jan/Feb/Mar with an EMPTY financial year, because
  // its label helper rejected `month < 4` before the January branch below it
  // could ever run — so the year picker could not list a year whose only months
  // were January to March.
  eq('Mar-26 belongs to FY 2025-26', fyOf('2026-03'), '2025-26');
  eq('Apr-26 belongs to FY 2026-27', fyOf('2026-04'), '2026-27');

  const { fyLabelOf } = await import('../src/app/store');
  const everyMonth: string[] = [];
  for (let y = 2023; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) everyMonth.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  eq('the control centre labels every month exactly like the engine',
    everyMonth.filter((p) => fyLabelOf(p) !== fyOf(p)), []);
  eq('no month is left without a financial year', everyMonth.filter((p) => !fyLabelOf(p)), []);
  eq('January 2026 still sits in FY 2025-26', fyLabelOf('2026-01'), '2025-26');
  eq('and so does March 2026', fyLabelOf('2026-03'), '2025-26');

  // The page renders its own month grid and year list. Both were pinned to one
  // hardcoded year (Apr-2025..Mar-2026), and the picker then added two more
  // years derived from the DATA rather than from today — years with no months
  // and no data at all, which is precisely what reads as "the year is there but
  // the months are missing".
  const fs = await import('node:fs');
  const html = fs.readFileSync('src/server/public/index.html', 'utf8');
  check('the month list is not pinned to one hardcoded year',
    !html.includes("const MONTH_ORDER = ['20"), 'a fixed month list came back');
  check('the month strip lays out empty months from the selected year',
    html.includes('const fyMonths = monthsOfFy(CTX.fy);') && html.includes('const blanks = fyMonths.filter'),
    'strip still walks a fixed list');
  check('and a year with no data shows its months instead of a bare message',
    html.includes('if (!rows.length && !fyMonths.length) {'), 'an empty year hides its months');

  const NL = String.fromCharCode(10);
  const grab = (name: string) => {
    const at = html.indexOf(`function ${name}(`);
    const end = at < 0 ? -1 : html.indexOf(NL + '}', at);
    return at < 0 || end < 0 ? '' : html.slice(at, end + 2);
  };
  const fn = (name: string, needs?: string[]) => {
    const src = grab(name);
    check(`the page defines ${name}()`, src !== '');
    if (!src) return null;
    // The page's own helpers come along: fyOptionsFor() calls fyOfPeriod() and
    // fyOfPeriod() calls nothing, so evaluating one alone would only prove that
    // the others are missing from an otherwise fine page.
    const prelude = (needs || []).map((d) => `const ${d} = (${grab(d)});`);
    const body = [...prelude, `return (${src})`].join(String.fromCharCode(10));
    return new Function(body)() as (...a: any[]) => any;
  };
  const monthsOfFy = fn('monthsOfFy');
  const fyOptionsFor = fn('fyOptionsFor', ['fyOfPeriod', 'nextFy']);
  const fyOfPeriod = fn('fyOfPeriod');

  if (monthsOfFy && fyOptionsFor && fyOfPeriod) {
    eq('the page agrees with the engine on a March month', fyOfPeriod('2026-03'), '2025-26');
    eq('FY 2025-26 has its twelve months, April first', monthsOfFy('2025-26'),
      ['2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03']);
    eq('FY 2026-27 has twelve months of its own', monthsOfFy('2026-27'),
      ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03']);
    eq('every financial year answers with twelve months',
      ['2024-25', '2030-31'].map((fy) => monthsOfFy(fy).length), [12, 12]);
    eq('something that is not a year is not invented', monthsOfFy('baloney'), []);

    // The real months on file and today's year decide what may be selected.
    //
    // The year AFTER today's is offered deliberately (changed 2026-10, on the
    // office's request): FY 2027-28 has to be selectable while the office is
    // still working in FY 2026-27, because the picker is where the team asks
    // what is still unfiled next year. Two limits keep that honest — it is
    // exactly ONE year ahead, never a year invented from the data with months
    // that do not exist, and every year that has data keeps its place, so
    // nothing earlier is hidden.
    const onFile = ['2024-04', '2025-03', '2025-04', '2026-03'];
    eq('every year on file is offered, plus today and the year after it',
      fyOptionsFor(onFile, '2026-27'), ['2024-25', '2025-26', '2026-27', '2027-28']);
    eq('the current year stays selectable before its first file arrives',
      fyOptionsFor(['2025-04'], '2026-27'), ['2025-26', '2026-27', '2027-28']);
    eq('FY 2027-28 is offerable while the office is working in FY 2026-27',
      fyOptionsFor(['2025-04'], '2026-27').includes('2027-28'), true);
    eq('but nothing beyond the next year is ever offered',
      fyOptionsFor(['2025-04'], '2026-27').includes('2028-29'), false);
    eq('with nothing on file the current year is still offered',
      fyOptionsFor([], '2026-27'), ['2026-27', '2027-28']);
    eq('a year with data beyond today keeps its place',
      fyOptionsFor(['2027-04'], '2026-27'), ['2026-27', '2027-28']);
  }
}

// ---------------------------------------------------------------------------
section('25. GST money rules the exception reports depend on');
// ---------------------------------------------------------------------------

{
  // One invoice reaches GSTR-2B as one line per rate. The invoice is only
  // comparable as the SUM of those lines, and every one of them is part of the
  // same claim — comparing a single line reported half an invoice as an amount
  // mismatch (4 such rows were live in the real data) and left the other line
  // looking like a purchase nobody had booked.
  {
    const r = reconcilePurchases(
      [BILL({ invoice_no: 'SPLIT1', taxable_value: 10000, igst: 1800 })],
      [
        TWO({ invoice_no: 'SPLIT1', taxable_value: 6000, igst: 1080 }),
        TWO({ invoice_no: 'SPLIT1', taxable_value: 4000, igst: 720 }),
      ],
    );
    eq('a rate-split 2B invoice still matches the whole invoice', r.rows[0].status, 'Matched');
    eq('the 2B amount compared is the invoice total', r.rows[0].two_b_itc, 1800);
    eq('both of its 2B lines are claimed, so neither reads as not-booked', r.unbooked2b.length, 0);
  }

  // But the same invoice number in a DIFFERENT return month is a different
  // document — an amendment or a credit note — and must not be swallowed.
  {
    const r = reconcilePurchases(
      [BILL({ invoice_no: 'AMD1', period: '2026-03' })],
      [
        TWO({ invoice_no: 'AMD1', period: '2026-03', portal_fp: '2026-03' }),
        TWO({ invoice_no: 'AMD1', period: '2026-06', portal_fp: '2026-06' }),
      ],
    );
    eq('the book row matches the line from its own month', r.rows[0].status, 'Matched');
    eq('a later-month line for the same number is still surfaced', r.unbooked2b.length, 1);
  }

  // Claimable ITC is the portal's tax figure. The old code capped it at the
  // taxable value, which is not a rule in GST and quietly dropped credit.
  {
    const r = reconcilePurchases([], [TWO({ invoice_no: 'HI1', taxable_value: 100, igst: 1000 })]);
    eq('claimable ITC is not capped by the taxable value', r.summary.claimable_itc, 1000);
  }

  // A 2B line with no book counterpart is missing from the BOOKS. Both
  // directions shared one label, so the sheets contradicted themselves, and a
  // credit note was told to "claim" the credit it actually takes away.
  {
    const r = reconcilePurchases([], [TWO({ invoice_no: 'NB1' })]);
    eq('an unbooked 2B line is Missing in Books', r.unbooked2b[0].status, 'Missing in Books');
    check('and the advice is to book it and claim in 4(A)',
      /4\(A\) me claim/.test(r.unbooked2b[0].action || ''), r.unbooked2b[0].action);

    const cn = reconcilePurchases([], [TWO({ invoice_no: 'CN1', taxable_value: -5000, igst: -900 })]);
    const row = cn.unbooked2b[0];
    check('an unbooked credit note is not told to claim anything',
      !/claim kar sakte hain/.test(row.action || ''), row.action);
    check('it is told to REVERSE the credit instead', /REVERSE/.test(row.action || ''), row.action);
  }

  // ITC control: blocked credit is a REVERSAL (3B table 4(B)). Adding it to the
  // availed credit put money into the ledger that the portal had refused, and
  // that money then looked usable against output tax.
  {
    const { buildItcControl } = await import('../src/engine/control');
    const rep = buildItcControl({
      gstin: '26AALCS9985J1ZC',
      fromPeriod: '2025-04',
      toPeriod: '2025-04',
      books: [BILL({ invoice_no: 'B1' }), BILL({ invoice_no: 'B2' })],
      twob: [
        TWO({ invoice_no: 'B1' }),
        TWO({ invoice_no: 'B2', itc_availability: 'No', reason: 'cl.16(4)' }),
      ],
      outputTaxFor: () => 0,
    });
    const row = rep.periods[0];
    eq('the blocked credit is reported as blocked', row.blockedItc, 1800);
    eq('it is never availed', row.itcAvailed, row.claimableItc);
    eq('so the credit balance excludes it', row.closingCredit, 1800);
  }
}

// ---------------------------------------------------------------------------
section('26. a filter must speak the report table’s own columns');
// ---------------------------------------------------------------------------

{
  // The screen has ONE filter bar, but the reports read five different tables.
  // Selecting a month used to send `period` to gstr2b_lines (which calls it
  // `twob_month`) and `supplier` to audit_trail (which calls it
  // `supplier_gstin`), and every non-purchase report answered 500 the moment a
  // month was picked. These pin the mapping so it cannot come back.
  const { buildWhere, describeFilters, REPORTS } = await import('../src/app/reports');

  const FULL = {
    gstin: '26AALCS9985J1ZC', period: '2025-04', from: '2025-04', to: '2025-06',
    supplier: '24AALCS9985J1ZG', vendor: 'SHIVAM', status: 'Matched',
    decision: 'Claim', classification: '4(A) — Claimed',
    twoBMonth: '2025-05', decisionMonth: '2025-06',
    q: 'abc', followUp: 'pending', locked: true,
  };

  // --- purchase_lines: the full filter language --------------------------
  const p = buildWhere(FULL, 'purchase');
  check('purchase keeps its own supplier column', /p\.book_supplier_gstin = /.test(p.sql));
  check('purchase keeps its own 2B month column', /p\.matched_2b_month = /.test(p.sql));
  eq('purchase can answer every filter, so it ignores none', p.ignored, []);
  check('an unknown status returns nothing rather than everything',
    buildWhere({ status: 'Nonsense' }, 'purchase').sql.includes('false'));

  // --- gstr2b_lines: twob_month, supplier_gstin, supplier_name -----------
  const t = buildWhere(FULL, 'twob');
  check('the 2B month filter is twob_month', /t\.twob_month = /.test(t.sql));
  check('the 2B supplier filter is supplier_gstin', /t\.supplier_gstin = /.test(t.sql));
  check('the 2B vendor filter searches supplier_name', /t\.supplier_name/.test(t.sql));
  check('the 2B table is never asked for a column it lacks',
    !/party_name|match_status|book_supplier_gstin|itc_decision/.test(t.sql));
  check('a status the 2B table cannot answer is ignored, not faked',
    t.ignored.some((x) => x.startsWith('Status: Matched')));
  check("the 2B table's one honest status still works",
    buildWhere({ status: 'Missing in Books' }, 'twob').sql.includes('true'));
  check('and so does its own name for that status',
    buildWhere({ status: 'Not Booked' }, 'twob').sql.includes('true'));

  // --- audit_trail: unqualified columns, no vendor name ------------------
  const au = buildWhere(FULL, 'audit');
  check('the audit trail keeps its own period', /\bperiod = /.test(au.sql));
  check('the audit trail uses no table prefix at all', !/\b[pt]\./.test(au.sql));
  check('the audit trail ignores the vendor filter instead of inventing a column',
    au.ignored.some((x) => x.startsWith('Vendor contains')));
  check('the audit trail ignores match status and ITC decision',
    au.ignored.some((x) => x.startsWith('Status:')) && au.ignored.some((x) => x.startsWith('ITC decision:')));

  // --- month_locks answers `locked` from its own column ------------------
  check('month locks answers locked from is_locked',
    /is_locked = /.test(buildWhere({ locked: true, period: '2025-04' }, 'locks').sql));

  // --- gstr2b_files: its month is twob_month -----------------------------
  check('the file registry month is twob_month',
    /twob_month = /.test(buildWhere({ period: '2025-04' }, 'files').sql));

  // --- the ignored-filter echo is stated, never silent -------------------
  check('an ignored filter is named in the file’s filter echo',
    describeFilters({}, ['Status: Matched']).includes('Not applicable to this report (ignored): Status: Matched'));
  check('a report with no ignored filter has no such line',
    !describeFilters({ status: 'Matched' }).some((l) => l.includes('Not applicable')));

  // --- report by report: the fragment must speak only its own table ------
  for (const def of REPORTS) {
    const profile = def.profile ?? 'purchase';
    const { sql, ignored } = buildWhere(FULL, profile);
    const full = def.sql(sql);
    const aliasOk =
      profile === 'purchase' ? !/\bt\./.test(sql)
        : profile === 'twob' ? !/\bp\./.test(sql)
          : !/\b[pt]\./.test(sql);
    check(`report ${def.name}: filters speak only ${profile}'s columns`, aliasOk, sql);
    check(`report ${def.name}: builds a full statement`, /SELECT/.test(full));
    check(`report ${def.name}: every dropped filter is reported`,
      ignored.every((g) => describeFilters(FULL, [g]).includes(`Not applicable to this report (ignored): ${g}`)));
  }
}

// ---------------------------------------------------------------------------
section('27. the B2CL threshold is a date, not a constant');
// ---------------------------------------------------------------------------

{
  // The threshold was Rs 2,50,000 until 31 July 2024 and Rs 1,00,000 from the
  // August 2024 tax period (53rd GST Council, Notification 12/2024-CT). Holding
  // the old figure would file a Rs 1.5 lakh inter-state B2C sale as a
  // consolidated B2CS row — the wrong table on the return.
  const { b2clThresholdFor } = await import('../src/engine/gstr1');
  eq('the threshold is Rs 1,00,000 for a current period', b2clThresholdFor('2025-04'), 100000);
  eq('August 2024 is the first month of the new rule', b2clThresholdFor('2024-08'), 100000);
  eq('July 2024 still had the old Rs 2,50,000', b2clThresholdFor('2024-07'), 250000);

  const b2cInter = (period: string, value: number): SalesInvoice => ({
    our_gstin: '26AALCS9985J1ZC', customer_name: 'Walk-in (inter-state)',
    customer_gstin: '', invoice_no: 'B2C-1', invoice_date: period + '-20', period,
    invoice_type: 'R', place_of_supply: '27', reverse_charge: false,
    taxable_value: r2(value / 1.18), igst: r2(value - value / 1.18),
    cgst: 0, sgst: 0, cess: 0, invoice_value: value,
  });

  const now = buildGstr1('26AALCS9985J1ZC', [b2cInter('2025-04', 150000)]);
  eq('a Rs 1.5 lakh inter-state B2C sale is B2CL on 2025-04 data', now.b2cl.length, 1);
  eq('and it no longer disappears into B2CS', now.b2cs.length, 0);

  const old = buildGstr1('26AALCS9985J1ZC', [b2cInter('2024-01', 150000)]);
  eq('the same sale in January 2024 stays B2CS', old.b2cl.length, 0);
  eq('as one B2CS bucket', old.b2cs.length, 1);

  // The rule is "more than" the threshold, so the threshold value itself is not
  // a B2CL invoice.
  eq('exactly Rs 1,00,000 is not B2CL',
    buildGstr1('26AALCS9985J1ZC', [b2cInter('2025-04', 100000)]).b2cl.length, 0);
  eq('exactly Rs 2,50,000 was not B2CL in 2024',
    buildGstr1('26AALCS9985J1ZC', [b2cInter('2024-01', 250000)]).b2cl.length, 0);
  eq('but a rupee over it was',
    buildGstr1('26AALCS9985J1ZC', [b2cInter('2024-01', 250001)]).b2cl.length, 1);
  eq('a small inter-state B2C sale is still B2CS',
    buildGstr1('26AALCS9985J1ZC', [b2cInter('2025-04', 90000)]).b2cl.length, 0);
}

// ---------------------------------------------------------------------------
section('28. CDNUR — credit / debit notes to unregistered recipients (table 9B)');
// ---------------------------------------------------------------------------

{
  const cn = (over: Partial<SalesInvoice>): SalesInvoice => ({
    our_gstin: '26AALCS9985J1ZC', customer_name: 'Walk-in', customer_gstin: '',
    invoice_no: 'CN-1', invoice_date: '2025-04-20', period: '2025-04',
    invoice_type: 'CDNR', place_of_supply: '26', reverse_charge: false,
    taxable_value: -1000, igst: 0, cgst: -90, sgst: -90, cess: 0, invoice_value: -1180,
    note_ref_no: 'SVN-9', note_ref_date: '2025-04-02',
    ...over,
  });

  // A note follows the recipient, exactly like the supply it corrects.
  const unreg = buildGstr1('26AALCS9985J1ZC', [cn({})]);
  eq('an unregistered credit note does NOT go to CDNR', unreg.cdnr.length, 0);
  eq('it goes to CDNUR (table 9B)', unreg.cdnur.length, 1);
  eq('an intra-state unregistered note is typ B2CS', unreg.cdnur[0].noteType, 'B2CS');
  eq('CDNUR still carries the original invoice it corrects', unreg.cdnur[0].noteRefNo, 'SVN-9');

  const reg = buildGstr1('26AALCS9985J1ZC', [cn({ customer_gstin: '27AAECA2190C1Z3' })]);
  eq('a registered credit note stays in CDNR (9A)', reg.cdnr.length, 1);
  eq('and is not duplicated into CDNUR', reg.cdnur.length, 0);

  // `typ` mirrors how the ORIGINAL supply would have been reported.
  const big = buildGstr1('26AALCS9985J1ZC', [
    cn({ place_of_supply: '27', igst: -27000, cgst: 0, sgst: 0, taxable_value: -150000, invoice_value: -177000 }),
  ]);
  eq('an inter-state unregistered note over the threshold is typ B2CL', big.cdnur[0].noteType, 'B2CL');
  const small = buildGstr1('26AALCS9985J1ZC', [
    cn({ place_of_supply: '27', igst: -13500, cgst: 0, sgst: 0, taxable_value: -75000, invoice_value: -88500 }),
  ]);
  eq('the same note under the threshold is typ B2CS', small.cdnur[0].noteType, 'B2CS');

  const dn = buildGstr1('26AALCS9985J1ZC', [cn({ invoice_type: 'DN', invoice_no: 'DN-1' })]);
  eq('a debit note to an unregistered customer keeps ntty D', dn.cdnur[0].invoiceType, 'DN');

  // ---- portal JSON --------------------------------------------------------
  const json = gstr1PortalJson(unreg) as any;
  check('portal JSON: cdnur is a flat array, not grouped by GSTIN',
    Array.isArray(json.cdnur) && json.cdnur.length === 1);
  const row = json.cdnur[0];
  eq('portal JSON: cdnur carries typ', row.typ, 'B2CS');
  eq('portal JSON: cdnur carries ntty C', row.ntty, 'C');
  eq('portal JSON: cdnur declares its OWN note number', row.nt_num, 'CN-1');
  eq('portal JSON: cdnur note date is DD-MM-YYYY', row.nt_dt, '20-04-2025');
  eq('portal JSON: cdnur links the original invoice', row.inum, 'SVN-9');
  eq('portal JSON: cdnur original invoice date is DD-MM-YYYY', row.idt, '02-04-2025');
  check('portal JSON: cdnur has no ctin and no inv_typ',
    row.ctin === undefined && row.inv_typ === undefined);
  eq('portal JSON: cdnur items nest under itm_det', row.itms[0].itm_det.rt, 18);
  eq('portal JSON: sect declares CDNUR', json.sect.includes('CDNUR'), true);
  check('portal JSON: cdnr stays empty for an unregistered-only run', json.cdnr.length === 0);

  // ---- validation: the original ref is advice on 9B, an error on 9A ------
  const noRef = cn({ note_ref_no: undefined, note_ref_date: undefined });
  const unregNoRef = buildGstr1('26AALCS9985J1ZC', [noRef]);
  check('a CDNUR note with no original invoice is a WARNING, not an ERROR',
    unregNoRef.validation.some((v) => v.severity === 'WARNING' && /CDNUR/.test(v.message)) &&
    !unregNoRef.validation.some((v) => v.severity === 'ERROR'));
  const regNoRef = buildGstr1('26AALCS9985J1ZC', [{ ...noRef, customer_gstin: '27AAECA2190C1Z3' }]);
  check('a CDNR note with no original invoice stays an ERROR',
    regNoRef.validation.some((v) => v.severity === 'ERROR'));

  // ---- reconciliation -----------------------------------------------------
  eq('parseTableType knows cdnur', parseTableType('cdnur'), 'CDNUR');
  eq('parseTableType does not confuse CDNUR with CDNR', parseTableType('CDNR'), 'CDNR');
  eq('parseTableType reads a labelled 9B sheet', parseTableType('cdnur (9b)'), 'CDNUR');
  check('GSTR1_TABLES now includes CDNUR', GSTR1_TABLES.includes('CDNUR'));
  check('TABLE_LABEL describes CDNUR as table 9B', /9B/.test(TABLE_LABEL.CDNUR));

  const docs = draftDocuments(unreg);
  eq('a drafted CDNUR note becomes a CDNUR document',
    docs.filter((d) => d.table_type === 'CDNUR').length, 1);
  eq('and never a CDNR document', docs.filter((d) => d.table_type === 'CDNR').length, 0);

  const filedNoGstin = classifyFiled({
    our_gstin: '26AALCS9985J1ZC', period: '2025-04', invoice_type: 'CDNR',
    invoice_number: 'CN-1', invoice_date: '2025-04-20', taxable_value: -1000, cgst: -90, sgst: -90,
  })!;
  eq('a filed note with no recipient GSTIN classifies as CDNUR', filedNoGstin.table_type, 'CDNUR');
  const filedGstin = classifyFiled({
    our_gstin: '26AALCS9985J1ZC', period: '2025-04', invoice_type: 'CDNR',
    invoice_number: 'CN-2', invoice_date: '2025-04-20', recipient_gstin: '27AAECA2190C1Z3',
    taxable_value: -1000, igst: -180,
  })!;
  eq('a filed note with a recipient GSTIN classifies as CDNR', filedGstin.table_type, 'CDNR');
  const filedDeclared = classifyFiled({
    our_gstin: '26AALCS9985J1ZC', period: '2025-04', table_type: 'CDNUR', invoice_type: 'CDNR',
    invoice_number: 'CN-3', invoice_date: '2025-04-20', taxable_value: -1000, cgst: -90, sgst: -90,
  })!;
  eq('a declared CDNUR table is honoured', filedDeclared.table_type, 'CDNUR');

  check('the outward summary reports 9B as its own line',
    summarise(docs, []).some((r) => r.table_type === 'CDNUR'));
}

// ---------------------------------------------------------------------------
section('29. sales register template is the GSTR-1 input, and agrees with the parser');
// ---------------------------------------------------------------------------

{
  const { SALES_TEMPLATE_COLUMNS, salesTemplateCsv } = await import('../src/app/sales-template');
  const headers = SALES_TEMPLATE_COLUMNS.map((c) => c.header);
  const sample = SALES_TEMPLATE_COLUMNS.map((c) => c.sample);

  // Every header the template prints must be an alias the SALES parser
  // recognises. A header the parser does not know is dropped without a word,
  // and the GSTR-1 built from the rest is quietly wrong — which is worse than
  // refusing the file.
  for (const col of SALES_TEMPLATE_COLUMNS) {
    const field = detectField(normaliseHeader(col.header), { profile: 'sales' });
    check(`sales template header "${col.header}" is recognised`, !!field, String(field));
  }

  // ...and it must map to the field the note claims it is. "Customer GSTIN"
  // landing in `supplier_gstin` would file every sale under the wrong party.
  const expected: Record<string, string> = {
    'Our GSTIN': 'our_gstin',
    Unit: 'unit_name',
    'Customer Code': 'card_code',
    'Invoice No': 'invoice_no',
    'Invoice Date': 'invoice_date',
    'Invoice Type': 'invoice_type',
    'Customer GSTIN': 'customer_gstin',
    'Customer Name': 'customer_name',
    'Recipient Type': 'recipient_type',
    'Place of Supply': 'place_of_supply',
    'Taxable Value': 'taxable_value',
    IGST: 'igst', CGST: 'cgst', SGST: 'sgst', CESS: 'cess',
    'Invoice Value': 'invoice_value',
    HSN: 'hsn',
    'Original Invoice No': 'note_ref_no',
    'Original Invoice Date': 'note_ref_date',
    'Reverse Charge': 'reverse_charge',
    // The item line. Without these the HSN summary has no quantity and the
    // invoice collapses into one blended rate.
    'Line No': 'line_no',
    'Item Description': 'item_description',
    UQC: 'uqc',
    Quantity: 'quantity',
    'GST Rate': 'gst_rate',
    Freight: 'freight',
    'Other Charges': 'other_charges',
    // Portal tables that are declared once per period / per amendment.
    'Amendment Of Invoice No': 'amendment_invoice_no',
    'Amendment Of Invoice Date': 'amendment_invoice_date',
    'E-Commerce GSTIN': 'e_commerce_gstin',
    'Doc Nature': 'doc_nature',
    'Doc Series From': 'doc_series_from',
    'Doc Series To': 'doc_series_to',
    'Doc Series Cancelled': 'doc_series_cancelled',
  };
  for (const [header, field] of Object.entries(expected)) {
    eq(`"${header}" maps to ${field}`,
      detectField(normaliseHeader(header), { profile: 'sales' }), field);
  }

  // A sales file is only recognised as a sales file when these three columns
  // are present — `sniffKind` demands them, and `Invoice Value` is the one a
  // reader is most likely to omit because "taxable value + tax" looks derivable.
  // It is not: the B2CL threshold is a test on the invoice value as printed.
  eq('the template is detected as a sales register', sniffKind([headers, sample]), 'sales');
  for (const h of ['Invoice No', 'Taxable Value', 'Invoice Value']) {
    const without = SALES_TEMPLATE_COLUMNS.filter((c) => c.header !== h).map((c) => c.header);
    const kind = sniffKind([without, without.map(() => '1')]);
    check(`without "${h}" the file is no longer a sales register`, kind !== 'sales', kind);
  }
  // The specific trap, and the reason `Invoice Value` is marked compulsory
  // rather than convenient: drop it and the sniffer reads the sales file as a
  // PURCHASE register — "Customer GSTIN" is remapped to the supplier side, and
  // the whole sales register is then filed as purchase data. Not a missing
  // column; the wrong return.
  {
    const without = SALES_TEMPLATE_COLUMNS.filter((c) => c.header !== 'Invoice Value').map((c) => c.header);
    eq('without "Invoice Value" a sales file is mistaken for a purchase register',
      sniffKind([without, without.map(() => '1')]), 'purchase');
  }

  // The template's own sample row must round-trip, and its date must decide the
  // period — there is no period column, by design.
  {
    const r = parseSalesRegister([headers, sample], 'template.xlsx');
    eq('template sample row parses', r.rows.length, 1);
    const s = r.rows[0];
    eq('sample invoice number', s?.invoice_no, 'INV-889012');
    eq('sample our gstin', s?.our_gstin, '26AALCS9985J1ZC');
    eq('sample customer gstin', s?.customer_gstin, '27AAFCC9473R1ZP');
    eq('sample period comes from the invoice date', s?.period, '2026-04');
    eq('sample unit', s?.unit_name, 'Sakar-I');
    eq('sample hsn', s?.hsn, '8536');
    check('sample taxable parsed', Number(s?.taxable_value) === 100000);
    check('sample invoice value parsed', Number(s?.invoice_value) === 118000);
  }

  // The three examples in the workbook are the three tables, and they must
  // actually land in those tables — an example that classifies wrongly is
  // copied wrongly.
  {
    const row = (over: Record<string, string>) =>
      headers.map((h) => over[h] ?? SALES_TEMPLATE_COLUMNS.find((c) => c.header === h)!.sample);

    const rows = [
      headers,
      // registered, inter-state -> B2B
      row({}),
      // unregistered, same state as us (26), small -> B2CS
      row({
        'Invoice No': 'INV-2', 'Invoice Date': '2026-04-18', 'Customer GSTIN': '',
        'Place of Supply': '26', 'Taxable Value': '25000', IGST: '0', CGST: '2250',
        SGST: '2250', 'Invoice Value': '29500',
      }),
      // unregistered, inter-state, over Rs 1,00,000 -> B2CL
      row({
        'Invoice No': 'INV-3', 'Invoice Date': '2026-04-22', 'Customer GSTIN': '',
        'Place of Supply': '08', 'Taxable Value': '120000', IGST: '21600', CGST: '0',
        SGST: '0', 'Invoice Value': '141600',
      }),
      // credit note to a REGISTERED customer -> CDNR (9A), original linked
      row({
        'Invoice No': 'CN-1', 'Invoice Date': '2026-04-25', 'Invoice Type': 'CN',
        'Taxable Value': '-1000', IGST: '-180', CGST: '0', SGST: '0',
        'Invoice Value': '-1180',
        'Original Invoice No': 'CN-0007', 'Original Invoice Date': '2026-04-10',
      }),
      // credit note to an UNREGISTERED customer, big & inter-state -> CDNUR (9B)
      row({
        'Invoice No': 'CN-2', 'Invoice Date': '2026-04-25', 'Invoice Type': 'CN',
        'Customer GSTIN': '', 'Place of Supply': '08', 'Taxable Value': '-150000',
        IGST: '-27000', CGST: '0', SGST: '0', 'Invoice Value': '-177000',
        'Original Invoice No': 'CN-0007', 'Original Invoice Date': '2026-04-10',
      }),
    ];
    const parsed = parseSalesRegister(rows, 'template.xlsx');
    eq('every filled template row parses', parsed.rows.length, 5);

    const g1 = buildGstr1('26AALCS9985J1ZC', parsed.rows as any);
    eq('one invoice in B2B', g1.b2b.length, 1);
    eq('the intra-state small sale is B2CS, not B2CL', g1.b2cl.length, 1);
    eq('B2CS is summarised in one rate bucket', g1.b2cs.length, 1);
    eq('the registered note is CDNR', g1.cdnr.length, 1);
    eq('the unregistered note is CDNUR', g1.cdnur.length, 1);
    eq('an unregistered inter-state note over Rs 1L declares B2CL', g1.cdnur[0]?.noteType, 'B2CL');
    eq('the registered note kept its original invoice link', g1.cdnr[0]?.noteRefNo, 'CN-0007');
    check('the B2CL example really is invoice-wise', g1.b2cl[0]?.invoiceNo === 'INV-3');
    check('and the B2CS bucket carries the small intra-state sale',
      r2(g1.b2cs[0]!.taxable) === 25000);
    // The one error the template warns about in its instructions.
    check('no validation error is raised by the template examples',
      g1.validation.filter((v) => v.severity === 'ERROR').length === 0,
      JSON.stringify(g1.validation));
  }

  // The two lines of the workbook's multi-item example must land on ONE
  // invoice, each as its own item line — that is the whole point of the
  // template, and getting it wrong doubles the invoice value.
  {
    const twoLineInvoice = (over: Record<string, string>) =>
      headers.map((h) =>
        over[h] ??
        (SALES_TEMPLATE_COLUMNS.find((c) => c.header === h)!.sample));
    const shared = {
      'Invoice No': 'INV-M1', 'Invoice Date': '2026-04-08', 'Invoice Value': '57500.00',
      HSN: '8536', UQC: 'PCS', 'GST Rate': '18', IGST: '4500.00', CGST: '0.00', SGST: '0.00',
    };
    const rows = [
      headers,
      twoLineInvoice({ ...shared, 'Line No': '1', 'Item Description': 'Relay 24V DC', Quantity: '50', 'Taxable Value': '25000.00' }),
      twoLineInvoice({
        ...shared, 'Line No': '2', 'Item Description': 'Contactor 32A', HSN: '8537',
        Quantity: '40', 'GST Rate': '12', IGST: '3000.00', 'Taxable Value': '25000.00',
        'Doc Series From': '', 'Doc Series To': '', 'Doc Series Cancelled': '',
      }),
    ];
    const parsed = parseSalesRegister(rows, 'template.xlsx');
    eq('two item lines make ONE invoice', parsed.rows.length, 1);
    eq('and the invoice keeps both item lines', parsed.rows[0]?.items?.length, 2);
    eq('with their own rates', parsed.rows[0]?.items?.map((i) => i.gst_rate).join(','), '18,12');
    eq('with their own HSN', parsed.rows[0]?.items?.map((i) => i.hsn).join(','), '8536,8537');
    eq('line numbers come from the file', parsed.rows[0]?.items?.map((i) => i.line_no).join(','), '1,2');
    eq('money is summed per invoice', parsed.rows[0]?.taxable_value, 50000);
    eq('and Invoice Value is counted ONCE, not twice', parsed.rows[0]?.invoice_value, 57500);
    eq('an invoice-level HSN is dropped when the lines differ', parsed.rows[0]?.hsn, undefined);
    eq('a clean item-wise invoice raises no issue', parsed.issues.length, 0);
  }

  // A totals row is still rejected, template or not.
  {
    const total = headers.map((h) => (/Taxable|IGST|CGST|SGST|Invoice Value/.test(h) ? '999999' : ''));
    const r = parseSalesRegister([headers, total], 'template.xlsx');
    eq('a totals row in the sales template layout is skipped', r.rows.length, 0);
  }

  // The CSV and the workbook must print the SAME header list — a team that
  // uses the CSV and a team that uses the xlsx must not end up with two
  // different registers.
  {
    const csvHeaders = salesTemplateCsv().split('\r\n')[0].split(',');
    eq('the CSV carries the same number of columns', csvHeaders.length, headers.length);
    for (const h of headers) {
      check(`CSV has the \"${h}\" column`, csvHeaders.includes(h));
    }
  }
}

// ---------------------------------------------------------------------------
section('30. a sales register CSV on its own produces a GSTR-1');
// ---------------------------------------------------------------------------

{
  // The whole point of the template: hand the software nothing but a filled
  // sales CSV and get a GSTR-1 out. This runs the real pipeline over a real
  // temp folder — the same code path the server's Run button uses — because
  // "the parser reads the columns" is not the same claim as "a run delivers
  // the return".
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const { runMonthly } = await import('../src/app/pipeline');
  const { salesTemplateCsv } = await import('../src/app/sales-template');

  const dir = nodePath.join(process.cwd(), 'output', 'chk', 'sales-only-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, 'Sales Register Apr26.csv'), salesTemplateCsv(), 'utf8');

  const prevPersist = process.env.GST_PERSIST;
  process.env.GST_PERSIST = '0'; // a test must never write to the live books
  try {
    const run = await runMonthly({
      input: dir,
      out: nodePath.join(dir, 'out'),
      salesGstin: '26AALCS9985J1ZC',
    });

    eq('the run read the sales register', run.counts.sales, 1);
    eq('and read no purchases', run.counts.purchase, 0);
    eq('the folder carried no 2B', run.counts.twob, 0);
    eq('the GSTIN came from the sales rows', run.gstins.join(','), '26AALCS9985J1ZC');
    eq('the period came from the invoice date', run.periods.join(','), '2026-04');

    // A sales-only run must SAY that reconciliation was skipped. An empty
    // "Missing in 2B" sheet with no explanation reads as a clean month.
    check('the run says reconciliation was skipped',
      run.messages.some((m) => /Sirf sales register mila/i.test(m)), run.messages.join(' | '));

    const row = run.summary[0];
    eq('outward taxable reached the summary', row?.outwardTaxable, 100000);
    eq('output tax reached the summary', row?.outputTax, 18000);
    eq('purchase rows are zero, not hidden', row?.purchaseRows, 0);
    eq('no return-validation issue was raised', run.validationIssues.length, 0);

    // ---- the workbook the team reads -------------------------------------
    check('the workbook was written', fs.existsSync(run.workbookPath));
    const wb = XLSX.readFile(run.workbookPath);
    check('it has a GSTR-1 sheet', wb.SheetNames.includes('GSTR-1'));
    const g1rows = XLSX.utils.sheet_to_json(wb.Sheets['GSTR-1'], { header: 1, defval: null }) as unknown[][];
    const b2bLine = g1rows.find((r) => r[2] === 'B2B');
    check('the GSTR-1 sheet lists the invoice as B2B', !!b2bLine, JSON.stringify(g1rows.slice(0, 4)));
    eq('with the invoice number', b2bLine?.[5], 'INV-889012');

    // ---- the file the portal takes ---------------------------------------
    const portalFile = nodePath.join(run.returnsDir, '26AALCS9985J1ZC_2026-04_GSTR1.json');
    check('the portal JSON was written', fs.existsSync(portalFile));
    const portal = JSON.parse(fs.readFileSync(portalFile, 'utf8')) as any;
    eq('the portal file is for the right period', portal.fp, '202604');
    eq('the portal file carries one B2B invoice', portal.b2b?.[0]?.inv?.length, 1);
    eq('the unregistered-note table is present and empty', portal.cdnur?.length, 0);
    check('the portal file declares the sections it fills',
      typeof portal.sect === 'string' && portal.sect.includes('CDNUR'), String(portal.sect));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevPersist === undefined) delete process.env.GST_PERSIST;
    else process.env.GST_PERSIST = prevPersist;
  }
}

{
  // The two runs that must still FAIL loudly, because the alternative is an
  // empty workbook that looks like a month with nothing in it.
  const fsp = await import('node:fs');
  const nodePath = await import('node:path');
  const { runMonthly } = await import('../src/app/pipeline');
  const base = nodePath.join(process.cwd(), 'output', 'chk', 'sales-only-guards');

  const prevPersist = process.env.GST_PERSIST;
  process.env.GST_PERSIST = '0';
  try {
    // (a) an empty folder
    fsp.rmSync(base, { recursive: true, force: true });
    fsp.mkdirSync(base, { recursive: true });
    let emptyMsg = '';
    try {
      await runMonthly({ input: base, out: nodePath.join(base, 'out') });
    } catch (e: any) { emptyMsg = e.message; }
    check('an empty folder is still refused', /Nothing recognisable/i.test(emptyMsg), emptyMsg);

    // (b) a purchase register with no "Our GSTIN" column at all
    //
    // Every row parses, so the old first guard passed — and the run then wrote
    // a workbook with no data in it and reported success. A register that
    // cannot say WHICH registration it belongs to has to be refused instead.
    const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
    const keep = PURCHASE_TEMPLATE_COLUMNS.filter((c) => c.header !== 'Our GSTIN');
    const csv = [keep.map((c) => c.header), keep.map((c) => c.sample)]
      .map((r) => r.map((v) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))
      .join('\r\n') + '\r\n';
    fsp.writeFileSync(nodePath.join(base, 'purchase-no-gstin.csv'), csv, 'utf8');
    let gstinMsg = '';
    try {
      await runMonthly({ input: base, out: nodePath.join(base, 'out') });
    } catch (e: any) { gstinMsg = e.message; }
    check('a register with no "Our GSTIN" is refused, not emptied',
      /Our GSTIN/i.test(gstinMsg), gstinMsg);
  } finally {
    fsp.rmSync(base, { recursive: true, force: true });
    if (prevPersist === undefined) delete process.env.GST_PERSIST;
    else process.env.GST_PERSIST = prevPersist;
  }
}

// ---------------------------------------------------------------------------
section('31. item-wise sales register — grouping, HSN summary, three GSTINs');
// ---------------------------------------------------------------------------
{
  // The approved samples in `templates/`, read the way a run reads them. Every
  // number below is the file's own: nothing is invented, and both files are the
  // format the team fills in.
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const readCsv = (p: string): unknown[][] => {
    const wb = XLSX.read(fs.readFileSync(nodePath.join(process.cwd(), p)), { type: 'buffer', raw: true });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1, raw: true, defval: null, blankrows: false,
    }) as unknown[][];
  };

  const sakar = parseSalesRegister(readCsv('templates/Sales CSV GSTR1 - Sakar Units 1 and 3 (sample).csv'), 'sakar.csv');
  const svn = parseSalesRegister(readCsv('templates/Sales CSV GSTR1 - SVN (sample).csv'), 'svn.csv');

  eq('every column of the approved sample is understood', sakar.unmappedHeaders.length, 0);
  eq('the sample is read as an ITEM-wise register', sakar.itemLevel, true);
  eq('10 item rows in the Sakar sample', sakar.itemRows, 10);
  eq('grouped into 8 invoices', sakar.rows.length, 8);
  eq('4 item rows in the SVN sample', svn.itemRows, 4);
  eq('grouped into 4 invoices', svn.rows.length, 4);
  eq('no arithmetic problem in the Sakar sample', sakar.issues.length, 0);
  eq('no arithmetic problem in the SVN sample', svn.issues.length, 0);

  const money = (rows: SalesInvoice[]) => ({
    invoices: rows.length,
    taxable: r2(rows.reduce((a, s) => a + r2(s.taxable_value), 0)),
    igst: r2(rows.reduce((a, s) => a + r2(s.igst), 0)),
    cgst: r2(rows.reduce((a, s) => a + r2(s.cgst), 0)),
    sgst: r2(rows.reduce((a, s) => a + r2(s.sgst), 0)),
    invoiceValue: r2(rows.reduce((a, s) => a + r2(s.invoice_value), 0)),
    items: rows.reduce((a, s) => a + (s.items?.length ?? 0), 0),
  });
  const forGstin = (rows: SalesInvoice[], g: string) => rows.filter((r) => r.our_gstin === g);

  // ---- the three registrations, from ONE Sakar file and one SVN file ----
  eq('Sakar Unit-1', money(forGstin(sakar.rows, '26AALCS9985J1ZC')),
    { invoices: 6, taxable: 298000, igst: 46200, cgst: 2970, sgst: 2970, invoiceValue: 350140, items: 7 });
  eq('Sakar Unit-3', money(forGstin(sakar.rows, '24AALCS9985J1ZG')),
    { invoices: 2, taxable: 80700, igst: 0, cgst: 7263, sgst: 7263, invoiceValue: 95226, items: 3 });
  eq('SVN (one registration, two units)', money(svn.rows),
    { invoices: 4, taxable: 195000, igst: 25200, cgst: 4950, sgst: 4950, invoiceValue: 230100, items: 4 });
  eq('the whole Sakar file foots to its distinct invoice values', money(sakar.rows),
    { invoices: 8, taxable: 378700, igst: 46200, cgst: 10233, sgst: 10233, invoiceValue: 445366, items: 10 });

  // ---- repeated invoice totals: counted once ----
  const inv1002 = sakar.rows.find((s) => s.invoice_no === 'INV-1002')!;
  eq('INV-1002 kept both item lines', inv1002.items?.length, 2);
  eq('INV-1002 taxable is the sum of its items', inv1002.taxable_value, 50000);
  eq('INV-1002 invoice value is counted ONCE', inv1002.invoice_value, 57500);
  eq('INV-1002 items carry their own HSN', inv1002.items?.map((i) => i.hsn).join(','), '8536,8537');
  eq('INV-1002 items carry their own rate', inv1002.items?.map((i) => i.gst_rate).join(','), '18,12');
  eq('INV-1002 items carry their own quantity', inv1002.items?.map((i) => i.quantity).join(','), '50,40');

  const inv3002 = forGstin(sakar.rows, '24AALCS9985J1ZG').find((s) => s.invoice_no === 'INV-3002')!;
  eq('the freight line is its own item, not folded into the goods line', inv3002.items?.length, 2);
  eq('INV-3002 taxable = goods + taxable freight', inv3002.taxable_value, 30700);
  eq('INV-3002 invoice value is counted ONCE', inv3002.invoice_value, 36226);
  check('the freight item is the one that carries the description',
    /freight/i.test(String(inv3002.items?.[1]?.description)), String(inv3002.items?.[1]?.description));

  // ---- GSTR-1 built from the grouped invoices ----
  const u1 = buildGstr1('26AALCS9985J1ZC', forGstin(sakar.rows, '26AALCS9985J1ZC'));
  const u3 = buildGstr1('24AALCS9985J1ZG', forGstin(sakar.rows, '24AALCS9985J1ZG'));
  const svnModel = buildGstr1('26ABFCS9511H1Z7', svn.rows);

  eq('Unit-1: two B2B invoices', u1.b2b.length, 2);
  eq('Unit-1: one B2CL invoice', u1.b2cl.length, 1);
  eq('Unit-1: one B2CS bucket', u1.b2cs.length, 1);
  eq('Unit-1: one CDNR note', u1.cdnr.length, 1);
  eq('Unit-1: the note keeps the original invoice it corrects', u1.cdnr[0]?.noteRefNo, 'INV-1001');
  eq('Unit-1: no portal validation error on the sample',
    u1.validation.filter((v) => v.severity === 'ERROR').length, 0);

  const b2b1002 = u1.b2b.find((i) => i.invoiceNo === 'INV-1002')!;
  eq('Unit-1: INV-1002 carries TWO itm_det lines', b2b1002.items.length, 2);
  eq('Unit-1: with the rates printed on the register', b2b1002.items.map((i) => i.rate).join(','), '18,12');
  eq('Unit-1: and each line its own taxable value', b2b1002.items.map((i) => i.taxable).join(','), '25000,25000');

  // ---- HSN summary: HSN/SAC + UQC + rate, with quantity ----
  const hsnOf = (m: ReturnType<typeof buildGstr1>, hsn: string, rate: number) =>
    m.hsn.find((h) => h.hsn === hsn && h.rateOut === rate);
  const hsnSlice = (h: { taxable: number; qty: number; uqc: string } | undefined) =>
    ({ taxable: h?.taxable, qty: h?.qty, uqc: h?.uqc });
  eq('Unit-1: HSN summary has three buckets', u1.hsn.length, 3);
  eq('8536 @ 18% (three invoices + one credit note)', hsnSlice(hsnOf(u1, '8536', 18)),
    { taxable: 153000, qty: 255, uqc: 'PCS' });
  eq('8537 @ 12% (second rate line of INV-1002)', hsnSlice(hsnOf(u1, '8537', 12)),
    { taxable: 25000, qty: 40, uqc: 'PCS' });
  eq('8537 @ 18% (the B2CL sale)', hsnSlice(hsnOf(u1, '8537', 18)),
    { taxable: 120000, qty: 30, uqc: 'PCS' });
  check('Unit-1: the HSN summary foots to the return taxable',
    r2(u1.hsn.reduce((a, h) => a + h.taxable, 0)) === r2(u1.totals.taxable),
    `${r2(u1.hsn.reduce((a, h) => a + h.taxable, 0))} vs ${u1.totals.taxable}`);
  check('Unit-1: every HSN bucket carries a description', u1.hsn.every((h) => !!h.desc));
  eq('Unit-3: freight and goods share the HSN but stay separate lines',
    u3.hsn.length, 2);
  eq('Unit-3: 8536 @ 18% includes the taxable freight', hsnOf(u3, '8536', 18)?.taxable, 30700);
  eq('SVN: one HSN bucket (credit note nets off)', svnModel.hsn.length, 1);
  eq('SVN: 8536 @ 18% taxable', svnModel.hsn[0]?.taxable, 195000);
  eq('SVN: quantity summed from the item lines', svnModel.hsn[0]?.qty, 370);

  // ---- portal JSON ----
  const json: any = gstr1PortalJson(u1);
  const jInv1002 = json.b2b.find((g: any) => g.ctin === '27AAECA2190C1Z3').inv.find((i: any) => i.inum === 'INV-1002');
  eq('portal JSON: INV-1002 keeps two itms', jInv1002.itms.length, 2);
  eq('portal JSON: item numbers are the register line numbers', jInv1002.itms.map((i: any) => i.num).join(','), '1,2');
  eq('portal JSON: rates per item', jInv1002.itms.map((i: any) => i.itm_det.rt).join(','), '18,12');
  eq('portal JSON: invoice value once per invoice', jInv1002.val, 57500);
  check('portal JSON: HSN rows carry quantity and UQC',
    json.hsn.data.every((h: any) => typeof h.qty === 'number' && !!h.uqc),
    JSON.stringify(json.hsn.data));
  eq('portal JSON: DOC_ISSUED is declared from the series', json.doc_num, 1);
  const doc = json.doc_issued.doc_det[0].docs[0];
  eq('portal JSON: the series range and net issue',
    { from: doc.from, to: doc.to, totnum: doc.totnum, cancel: doc.cancel, net_issue: doc.net_issue },
    { from: '1001', to: '1200', totnum: 200, cancel: 3, net_issue: 197 });

  // ---- GSTR-3B working summary, per registration ----
  const b3 = (g: string, rows: SalesInvoice[]) => buildGstr3b({ gstin: g, period: '2026-04', reconRows: [], sales: rows });
  const u1b = b3('26AALCS9985J1ZC', forGstin(sakar.rows, '26AALCS9985J1ZC'));
  const u3b = b3('24AALCS9985J1ZG', forGstin(sakar.rows, '24AALCS9985J1ZG'));
  const svnb = b3('26ABFCS9511H1Z7', svn.rows);
  eq('3B Unit-1: 3.1(a) taxable', u1b.outward.taxable, 298000);
  eq('3B Unit-1: output tax', u1b.totalOutputTax, 52140);
  eq('3B Unit-3: 3.1(a) taxable', u3b.outward.taxable, 80700);
  eq('3B Unit-3: output tax', u3b.totalOutputTax, 14526);
  eq('3B SVN: 3.1(a) taxable', svnb.outward.taxable, 195000);
  eq('3B SVN: output tax', svnb.totalOutputTax, 35100);
  check('3B Unit-1: rate-wise break-up keeps 18% and 12% apart',
    u1b.outward.byRate.map((r) => r.rate).join(',').includes('18') &&
      u1b.outward.byRate.map((r) => r.rate).join(',').includes('12'),
    JSON.stringify(u1b.outward.byRate));
}

// ---------------------------------------------------------------------------
section('32. what an item-wise register must REFUSE, and what must still work');
// ---------------------------------------------------------------------------
{
  const HEAD = [
    'Our GSTIN', 'Unit', 'Customer Name', 'Customer GSTIN', 'Recipient Type', 'Place of Supply',
    'Invoice Type', 'Invoice No', 'Invoice Date', 'Line No', 'Invoice Value', 'Item Description',
    'HSN', 'UQC', 'Quantity', 'GST Rate', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'CESS',
    'Freight', 'Other Charges',
  ];
  const row = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? '');
  const base = {
    'Our GSTIN': '26AALCS9985J1ZC', Unit: 'Sakar-I', 'Customer Name': 'CROMPTON',
    'Customer GSTIN': '27AAECA2190C1Z3', 'Recipient Type': 'Registered', 'Place of Supply': '27',
    'Invoice Type': 'R', 'Invoice No': 'INV-X', 'Invoice Date': '2026-04-10', 'Line No': '1',
    'Invoice Value': '118000.00', 'Item Description': 'Relay', HSN: '8536', UQC: 'PCS',
    Quantity: '100', 'GST Rate': '18', 'Taxable Value': '100000.00', IGST: '18000.00',
    CGST: '0.00', SGST: '0.00', CESS: '0.00', Freight: '0.00', 'Other Charges': '0.00',
  };

  // (a) every line of one invoice must print the SAME invoice value
  {
    const r = parseSalesRegister(
      [HEAD, row(base), row({ ...base, 'Line No': '2', 'Item Description': 'Contactor', HSN: '8537', 'GST Rate': '12', 'Taxable Value': '25000.00', IGST: '3000.00', 'Invoice Value': '29500.00' })],
      'x.csv',
    );
    const errs = r.issues.filter((i) => i.severity === 'ERROR');
    eq('two different invoice values on one invoice is an ERROR', errs.length, 2);
    check('...one says the lines disagree with each other',
      errs.some((e) => /alag-alag Invoice Value/.test(e.message)), JSON.stringify(errs.map((e) => e.message)));
    check('...and one says the value is not taxable + tax',
      errs.some((e) => /match nahi karta/.test(e.message)), JSON.stringify(errs.map((e) => e.message)));
    eq('...and the invoice still carries both items', r.rows[0]?.items?.length, 2);
  }

  // (b) the same line twice would double the taxable value
  {
    const r = parseSalesRegister([HEAD, row(base), row(base)], 'x.csv');
    eq('a repeated item line is an ERROR', r.issues.filter((i) => i.severity === 'ERROR').length, 1);
    eq('...and the repeat is dropped, not summed', r.rows[0]?.taxable_value, 100000);
    eq('...and the invoice value is not doubled', r.rows[0]?.invoice_value, 118000);
  }

  // (c) the printed rate must agree with the tax charged
  {
    const r = parseSalesRegister([HEAD, row({ ...base, 'Taxable Value': '100000.00', IGST: '12000.00', 'GST Rate': '18', 'Invoice Value': '112000.00' })], 'x.csv');
    eq('a rate that does not match the tax is an ERROR',
      r.issues.filter((i) => i.severity === 'ERROR').length, 1);
  }

  // (d) inter-state supply must be IGST, intra-state must be CGST + SGST — for
  // an unregistered customer too, where the place of supply is the only signal.
  {
    const inter = parseSalesRegister([HEAD, row({ ...base, 'Customer GSTIN': '', 'Place of Supply': 'Rajasthan', IGST: '0.00', CGST: '900.00', SGST: '900.00', 'Taxable Value': '10000.00', 'Invoice Value': '11800.00', 'GST Rate': '18' })], 'x.csv');
    eq('inter-state B2C charged CGST/SGST is an ERROR',
      inter.issues.filter((i) => i.severity === 'ERROR').length, 1);
    const intra = parseSalesRegister([HEAD, row({ ...base, 'Customer GSTIN': '', 'Place of Supply': '26', IGST: '1800.00', CGST: '0.00', SGST: '0.00', 'Taxable Value': '10000.00', 'Invoice Value': '11800.00', 'GST Rate': '18' })], 'x.csv');
    eq('intra-state B2C charged IGST is an ERROR',
      intra.issues.filter((i) => i.severity === 'ERROR').length, 1);
  }

  // (e) the freight columns are a break-up of the taxable value, never extra
  {
    const r = parseSalesRegister([HEAD, row({ ...base, Freight: '150000.00' })], 'x.csv');
    eq('freight larger than the line it belongs to is an ERROR',
      r.issues.filter((i) => i.severity === 'ERROR').length, 1);
  }

  // (f) an invalid "Our GSTIN" cannot be filed at all — reported, not stored
  {
    const r = parseSalesRegister([HEAD, row({ ...base, 'Our GSTIN': '26INVALID' })], 'x.csv');
    eq('an invalid Our GSTIN drops the row with a reason', r.rows.length, 0);
    check('...and says why', r.skipped.some((s) => /not a valid GSTIN/.test(s.reason)), JSON.stringify(r.skipped));
  }

  // (g) BACKWARD COMPATIBILITY — the invoice-level register the team used before
  // item-wise import. One row per invoice, no item columns at all.
  {
    const LEGACY = [
      'Our GSTIN', 'Invoice No', 'Invoice Date', 'Invoice Type', 'Customer GSTIN', 'Customer Name',
      'Place of Supply', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Invoice Value', 'HSN', 'Reverse Charge',
    ];
    const leg = (o: Record<string, string>) => LEGACY.map((h) => o[h] ?? '');
    const rows = [
      LEGACY,
      leg({ 'Our GSTIN': '26AALCS9985J1ZC', 'Invoice No': 'L-1', 'Invoice Date': '2026-04-05', 'Invoice Type': 'R', 'Customer GSTIN': '27AAECA2190C1Z3', 'Customer Name': 'C', 'Place of Supply': '27', 'Taxable Value': '100000', IGST: '18000', 'Invoice Value': '118000', HSN: '8536' }),
      leg({ 'Our GSTIN': '26AALCS9985J1ZC', 'Invoice No': 'L-2', 'Invoice Date': '2026-04-06', 'Invoice Type': 'R', 'Customer GSTIN': '27AAECA2190C1Z3', 'Customer Name': 'C', 'Place of Supply': '27', 'Taxable Value': '50000', IGST: '9000', 'Invoice Value': '59000', HSN: '8536' }),
    ];
    const r = parseSalesRegister(rows, 'legacy.csv');
    eq('an invoice-level register is still read as one row per invoice', r.rows.length, 2);
    eq('...and is flagged as NOT item-wise', r.itemLevel, false);
    eq('...with a single item line each', r.rows.map((s) => s.items?.length).join(','), '1,1');
    eq('...and unchanged totals', r2(r.rows.reduce((a, s) => a + s.invoice_value, 0)), 177000);
    eq('no issue is raised by the old shape', r.issues.length, 0);
    buildGstr1('26AALCS9985J1ZC', r.rows);
  }

  // The legacy WORKBOOK template that shipped with the software must still load.
  {
    const fs2 = await import('node:fs');
    const nodePath2 = await import('node:path');
    const wb = XLSX.read(fs2.readFileSync(nodePath2.join(process.cwd(), 'templates', 'Sales Register Template.csv')), { type: 'buffer', raw: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false }) as unknown[][];
    const r = parseSalesRegister(rows, 'templates/Sales Register Template.csv');
    eq('the shipped Sales Register Template still parses', r.rows.length, 1);
    eq('...at the same invoice', r.rows[0]?.invoice_no, 'INV-889012');
    eq('...at the same invoice value', r.rows[0]?.invoice_value, 118000);
  }

  // (g) The Purchase Register template ships as a file too (`npm run
  // template:purchase`). The workbook the accounts team fills in must
  // round-trip through the exact sheet picker and parser the upload route
  // uses, otherwise the file handed out would only work by luck.
  {
    const fs2 = await import('node:fs');
    const nodePath2 = await import('node:path');
    const { readAllSheets, pickDataSheet } = await import('../src/app/sheets');
    const REQUIRED = ['invoice_no', 'supplier_gstin', 'taxable_value'];

    const xlsx = fs2.readFileSync(
      nodePath2.join(process.cwd(), 'templates', 'Purchase Register Template.xlsx'),
    );
    const sheets = readAllSheets(Buffer.from(xlsx));
    const picked = pickDataSheet(sheets, REQUIRED, { profile: 'purchase' });
    eq('the shipped Purchase template picks the register sheet, not Instructions',
      picked.name, 'Purchase Register');

    const r = parsePurchaseRegister(picked.rows, 'templates/Purchase Register Template.xlsx');
    eq('all three example rows in the shipped Purchase template parse', r.rows.length, 3);
    eq('...first example invoice', r.rows[0]?.invoice_no, 'INV-889012');
    eq('...second example is a debit note', r.rows[1]?.document_type, 'Debit Note');
    eq('...third example is a credit note', r.rows[2]?.document_type, 'Credit Note');
    eq('...credit note is negative despite a positive figure in the sheet', r.rows[2]?.taxable_value, -5000);
    eq('...reference number survives', r.rows[0]?.reference_no, 'PO-4500123456');
    eq('...location number survives', r.rows[0]?.unit_name, 'Sakar-I');
    eq('...book entry date survives', r.rows[1]?.book_entry_date, '2026-05-02');
    // Formula columns carry no cached value in the generated file, so they must
    // not be mistaken for data by the parser.
    eq('...the three example documents net to 105000',
      r2(r.rows.reduce((a, b) => a + b.taxable_value, 0)), 105000);

    // The CSV twin carries the identical canonical header row and parses too.
    const { PURCHASE_TEMPLATE_COLUMNS } = await import('../src/app/template');
    const expectHead = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header).join(',');
    const csv = fs2.readFileSync(
      nodePath2.join(process.cwd(), 'templates', 'Purchase Register Template.csv'),
      'utf8',
    );
    eq('the shipped Purchase template CSV header is the canonical header row',
      csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0], expectHead);
    const rc = parsePurchaseRegister(
      [expectHead.split(','), PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample)],
      'templates/Purchase Register Template.csv',
    );
    eq('the shipped Purchase template CSV example row parses', rc.rows.length, 1);
    eq('...at the same invoice', rc.rows[0]?.invoice_no, 'INV-889012');
  }
}

section('33. GSTR-2B vs Books working sheet — invoice-wise rows, uploadable line rows');

{
  const {
    TWOB_RECON_INVOICE_COLUMNS,
    TWOB_RECON_LINE_COLUMNS,
    TWOB_RECON_WRITABLE_HEADERS,
    groupInvoices,
    readSheets,
    twobReconTemplateBuffer,
    twobReconTemplateCsv,
  } = await import('../src/app/twob-recon-template');
  const { writableField } = await import('../src/app/report-import');
  const fs2 = await import('node:fs');
  const nodePath2 = await import('node:path');

  // ---- the double-count trap ---------------------------------------------
  // GSTR-2B is INVOICE-level and `purchase_lines` is LINE-level. Two book lines
  // of one invoice matched the same 2B invoice and therefore both carry the SAME
  // 2B amounts. Summing the 2B side would report a Rs 2,00,000 2B invoice for a
  // Rs 1,00,000 one and invent a difference of a whole invoice.
  const line = (over: Record<string, any>): Record<string, any> => ({
    our_gstin: '26AALCS9985J1ZC', period: '2026-04',
    party_name: 'CROMPTON GREAVES', book_supplier_gstin: '27AAFCC9473R1ZP',
    book_invoice_no: 'INV-1001', book_invoice_date: '2026-04-15',
    book_taxable_value: 60000, book_igst: 10800, book_cgst: 0, book_sgst: 0, book_cess: 0,
    book_itc: 10800,
    match_status: 'Matched', matched_2b_key: '2b.xlsx#2', matched_2b_month: '2026-04',
    twob_supplier_gstin: '27AAFCC9473R1ZP', twob_invoice_no: 'INV-1001',
    twob_invoice_date: '2026-04-15', twob_taxable_value: 100000, twob_igst: 18000,
    twob_cgst: 0, twob_sgst: 0, twob_itc: 18000,
    duplicate_count: 1, suggested_action: '', itc_decision: 'Pending Review', is_locked: false,
    ...over,
  });

  {
    const rows = [
      line({}),
      line({ book_taxable_value: 40000, book_igst: 7200, book_itc: 7200 }),
      line({
        book_invoice_no: 'INV-1002', book_invoice_date: '2026-04-18',
        book_taxable_value: 25000, book_igst: 0, book_cgst: 2250, book_sgst: 2250, book_itc: 4500,
        match_status: 'Missing in 2B', matched_2b_key: null, matched_2b_month: '',
        twob_taxable_value: null, twob_itc: null, twob_igst: 0, twob_invoice_no: '',
        suggested_action: 'Vendor se poocho',
      }),
    ];
    const inv = groupInvoices(rows);

    eq('two book lines of one invoice collapse into one row', inv.length, 2);
    const a = inv.find((r) => r.book_invoice_no === 'INV-1001')!;
    eq('...the invoice reports its line count', a.line_count, 2);
    eq('...books taxable is the SUM of the lines', a.book_taxable_value, 100000);
    eq('...books ITC is the SUM of the lines', a.book_itc, 18000);
    eq('2B taxable is counted ONCE, not once per line', a.twob_taxable_value, 100000);
    eq('2B ITC is counted ONCE too', a.twob_itc, 18000);
    eq('...so a fully matching invoice shows no difference', a.taxable_difference, 0);
    eq('...and no ITC difference', a.itc_difference, 0);
    eq('...and a single status', a.match_status, 'Matched');

    // Missing in 2B is not a zero difference: there is nothing to subtract, and
    // printing 0 invites somebody to reconcile it away.
    const b = inv.find((r) => r.book_invoice_no === 'INV-1002')!;
    eq('an invoice missing from 2B has no 2B match', b.matched_yesno, 'No');
    eq('...its taxable difference is BLANK, not zero', b.taxable_difference, '');
    eq('...its ITC difference is BLANK too', b.itc_difference, '');
    eq('...and its books total still stands', b.book_taxable_value, 25000);
  }

  // A mixed invoice says so, and says how it is mixed.
  {
    const inv = groupInvoices([
      line({}),
      line({ book_taxable_value: 40000, book_igst: 7200, book_itc: 7200, match_status: 'Missing in 2B', matched_2b_key: null }),
    ]);
    eq('one row for a mixed invoice', inv.length, 1);
    eq('...the status reads Mixed', inv[0].match_status, 'Mixed');
    check('...and the break-up names both statuses',
      /Matched 1/.test(String(inv[0].status_breakup)) && /Missing in 2B 1/.test(String(inv[0].status_breakup)));
  }

  // Two months carrying the same invoice number must not merge: two months of
  // ITC are two findings, not one.
  {
    const inv = groupInvoices([line({}), line({ period: '2026-05' })]);
    eq('the same invoice number in two months stays two rows', inv.length, 2);
  }

  // ...but the same supplier + invoice number booked twice in ONE month is ONE
  // finding. The engine's invoice identity is supplier + number (no date), it
  // flags every copy as Duplicate, and this sheet must agree with it rather than
  // reporting two rows where the Duplicate report reports one duplicated invoice.
  {
    const inv = groupInvoices([
      line({ duplicate_count: 2, match_status: 'Duplicate', matched_2b_key: null }),
      line({
        book_invoice_date: '2026-04-28', book_taxable_value: 1000, book_igst: 180, book_itc: 180,
        duplicate_count: 2, match_status: 'Duplicate', matched_2b_key: null,
      }),
    ]);
    eq('a duplicate booking collapses to one invoice row', inv.length, 1);
    eq('...with both copies counted as its lines', inv[0].line_count, 2);
    eq('...the duplicate count is shown', inv[0].duplicate_count, 2);
    eq('...the status is the engine\u2019s Duplicate', inv[0].match_status, 'Duplicate');
    eq('...and the earliest date is the one printed', inv[0].book_invoice_date, '2026-04-15');
  }

  // ---- sheet 2 is the one that goes back in ------------------------------
  for (const h of TWOB_RECON_WRITABLE_HEADERS) {
    check(`working-sheet column "${h}" is one the upload can write`, writableField(h) !== null);
  }
  check('the working sheet offers at least one writable field besides the key',
    TWOB_RECON_WRITABLE_HEADERS.filter((h) => writableField(h) !== 'id').length > 0);
  // ...and the other way round: the list the Instructions sheet calls fillable
  // must name columns that are actually on the sheet, or the reader is told to
  // fill a column that is not there.
  check('every header named as fillable is really on the working sheet',
    TWOB_RECON_WRITABLE_HEADERS.every((h) => TWOB_RECON_LINE_COLUMNS.some((c) => c.h === h)));
  check('the Instructions sheet lists every fillable header',
    (() => {
      const buf = twobReconTemplateBuffer({});
      const text = JSON.stringify(readSheets(buf).Instructions ?? []);
      return TWOB_RECON_WRITABLE_HEADERS.every((h) => text.includes(h));
    })());

  // A column the upload does NOT know would quietly lose what was typed in it,
  // so neither sheet may grow a duplicate header: two columns with one header
  // is ambiguous in Excel and ambiguous to the reader filling it in. (The two
  // sheets DO share headers on purpose — that is what makes them the same
  // reconciliation seen at two sizes.)
  check('sheet 1 has no duplicate header',
    new Set(TWOB_RECON_INVOICE_COLUMNS.map((c) => c.h)).size === TWOB_RECON_INVOICE_COLUMNS.length);
  check('sheet 2 has no duplicate header',
    new Set(TWOB_RECON_LINE_COLUMNS.map((c) => c.h)).size === TWOB_RECON_LINE_COLUMNS.length);
  eq('the line sheet starts with the row key the upload matches on',
    TWOB_RECON_LINE_COLUMNS[0].h, 'Line ID');

  // The route reads this report; a rename would turn the download into a 404.
  {
    const { findReport } = await import('../src/app/reports');
    check('the reconciliation report the working sheet is built from exists',
      !!findReport('purchase-reconciliation'));
  }

  // ---- and it can come back in ------------------------------------------
  // Reading `SheetNames[0]` made the upload reject every multi-sheet workbook
  // this system produces — including its own report exports, whose first sheet
  // is a cover. The sheet that carries a Line ID must be the one that is read.
  {
    const { readTable } = await import('../src/app/report-import');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['GST CONTROL ERP — SOMETHING'],
      [],
      ['Invoice No', 'Taxable Value'],
    ]), 'Instructions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Line ID', 'Invoice No', 'ITC Decision'],
      [11, 'INV-1', 'Claim'],
    ]), 'Line-wise (working)');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const rows = readTable(Buffer.from(buf), 'working.xlsx');
    eq('a multi-sheet upload is read from the sheet carrying a Line ID',
      (rows[0] ?? [])[0], 'Line ID');
    eq('...and its data row comes with it', (rows[1] ?? [])[0], 11);

    // A single-sheet file is untouched: same sheet, same rows as before.
    const one = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(one, XLSX.utils.aoa_to_sheet([
      ['Line ID', 'Invoice No'], [7, 'INV-9'],
    ]), 'Data');
    const oneBuf = XLSX.write(one, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const oneRows = readTable(Buffer.from(oneBuf), 'one.xlsx');
    eq('a single-sheet workbook still reads its only sheet', (oneRows[0] ?? [])[0], 'Line ID');

    // A workbook with no Line ID at all still reports the FIRST sheet, so the
    // "no Line ID" message keeps pointing at something real.
    const none = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(none, XLSX.utils.aoa_to_sheet([['Invoice No'], ['INV-9']]), 'Cover');
    XLSX.utils.book_append_sheet(none, XLSX.utils.aoa_to_sheet([['Zzz'], ['y']]), 'Other');
    const noneBuf = XLSX.write(none, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    eq('with no Line ID anywhere the first sheet is still what is read',
      (readTable(Buffer.from(noneBuf), 'none.xlsx')[0] ?? [])[0], 'Invoice No');
  }

  // ---- the shipped skeleton ---------------------------------------------
  const xlsx = fs2.readFileSync(
    nodePath2.join(process.cwd(), 'templates', 'GSTR-2B vs Books - Invoice-wise Reconciliation Template.xlsx'),
  );
  const sheets = readSheets(Buffer.from(xlsx));
  const names = Object.keys(sheets);
  eq('the shipped workbook carries three sheets', names.length, 3);
  eq('...instructions first', names[0], 'Instructions');
  eq('...invoice-wise second', names[1], '2B vs Books (invoice-wise)');
  eq('...line-wise last', names[2], 'Line-wise (working)');

  {
    const head = (sheets['2B vs Books (invoice-wise)'] ?? [])[0] as unknown[];
    eq('the invoice-wise sheet header is the canonical column list',
      head.join('|'), TWOB_RECON_INVOICE_COLUMNS.map((c) => c.h).join('|'));
    const lhead = (sheets['Line-wise (working)'] ?? [])[0] as unknown[];
    eq('the line-wise sheet header is the canonical column list',
      lhead.join('|'), TWOB_RECON_LINE_COLUMNS.map((c) => c.h).join('|'));

    // The example rows teach both shapes: a 2-line invoice that matches, and one
    // invoice that never reached 2B.
    const body = sheets['2B vs Books (invoice-wise)'] ?? [];
    eq('sheet 1 carries two example invoices', body.length - 1, 2);
    const lines = sheets['Line-wise (working)'] ?? [];
    eq('sheet 2 carries the three example lines', lines.length - 1, 3);

    const idIdx = TWOB_RECON_LINE_COLUMNS.findIndex((c) => c.h === 'Line ID');
    const ids = lines.slice(1).map((r) => Number((r as unknown[])[idIdx]));
    check('the example Line IDs are placeholders, not real line ids',
      ids.every((n) => n >= 999001 && n <= 999099));
  }

  check('the skeleton says out loud that its rows are examples',
    JSON.stringify(sheets.Instructions ?? []).includes('EXAMPLE ROWS'));

  // ---- pre-filled: real rows in, same two shapes out ---------------------
  {
    const buf = twobReconTemplateBuffer({
      companyName: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
      gstin: '26AALCS9985J1ZC', period: '2026-04',
      rows: [line({}), line({ book_taxable_value: 40000, book_igst: 7200, book_itc: 7200 })],
    });
    const filled = readSheets(buf);
    eq('a pre-filled sheet carries exactly the rows it was given',
      (filled['Line-wise (working)'] ?? []).length - 1, 2);
    eq('...collapsed to one invoice row',
      (filled['2B vs Books (invoice-wise)'] ?? []).length - 1, 1);
    check('...and the cover says where the rows came from, not that they are examples',
      !JSON.stringify(filled.Instructions ?? []).includes('EXAMPLE ROWS') &&
        JSON.stringify(filled.Instructions ?? []).includes('2026-04'));

    // The 2B column really is the single 2B invoice in the file, read back from
    // the written workbook rather than from the object that built it.
    const body = filled['2B vs Books (invoice-wise)'] ?? [];
    const colIdx = TWOB_RECON_INVOICE_COLUMNS.findIndex((c) => c.h === '2B Taxable Value');
    eq('the written 2B taxable value is the invoice value, once',
      Number((body[1] as unknown[])[colIdx]), 100000);
  }

  // ---- the CSV twin is sheet 1 ------------------------------------------
  {
    const csv = twobReconTemplateCsv();
    const body = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
    const headerLine = body.find((l) => l.startsWith('GSTIN,')) ?? '';
    eq('the CSV header row is the invoice-wise column list',
      headerLine.split(',')[0] + '|' + headerLine.split(',').length,
      'GSTIN|' + TWOB_RECON_INVOICE_COLUMNS.length);
    check('the CSV says it is for reading, not for upload',
      body.some((l) => /Upload the .xlsx working sheet/.test(l)));
  }

  // ---- wired into the app ------------------------------------------------
  {
    const server = fs2.readFileSync(nodePath2.join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
    check('the server serves the working sheet',
      server.includes('/api/template/twob-recon.xlsx') && server.includes('/api/template/twob-recon.csv'));
    const html = fs2.readFileSync(nodePath2.join(process.cwd(), 'src', 'server', 'public', 'index.html'), 'utf8');
    check('the UI offers the download', html.includes('downloadTwobRecon('));
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(66));
console.log(`GST ERP engine: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('failing: ' + failures.join(' | '));
console.log('='.repeat(66));
if (fail > 0) process.exit(1);
