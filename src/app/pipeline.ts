/**
 * GST ERP — the monthly pipeline.
 *
 * Everything the CLI does, minus the console: scan a folder, ingest, reconcile,
 * build the workbook, write the portal JSON. It is a plain function so the CLI
 * and the local web server run exactly the same code — the team must never see
 * different numbers depending on who started the job.
 *
 * Nothing here touches the database. The engine is pure; this module only does
 * file I/O and calls into it.
 */

import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

import {
  isGstr2bJson,
  parseGstr2b,
  parseGstr2bJson,
  parsePurchaseRegister,
  parseSalesRegister,
  sniffKind,
  type SalesIssue,
} from '../engine/ingest';
import { matchPercent, reconcilePurchases } from '../engine/match';
import { buildGstr3b, gstr3bPortalJson, gstr3bWorkingRows, itcDetailFromRecon } from '../engine/gstr3b';
import { buildGstr1, gstr1HsnSheetRows, gstr1PortalJson, gstr1SheetRows } from '../engine/gstr1';
import { buildItcControl, lapseRisk } from '../engine/control';
import { buildImsActions } from '../engine/ims';
import { buildGstr9, buildGstr9c, gstr9PortalJson, gstr9WorkingRows, gstr9cWorkingRows } from '../engine/gstr9';
import { dbReady, itcWorking, persistRun, reconMapOf, sha256, type TwoBFileInput } from './store';
import {
  fyOf,
  labelOf,
  normGstin,
  r2,
  taxOf,
  type Gstr2bRecord,
  type PurchaseBill,
  type SalesInvoice,
} from '../engine/core';

export interface RunOptions {
  input: string;
  out: string;
  onlyPeriod?: string;
  /** GSTIN to attribute sales rows to when the sales export has no GSTIN column. */
  salesGstin?: string;
  /** Called with progress lines. The CLI prints them; the server captures them. */
  log?: (line: string) => void;
  /**
   * Write the Phase-0 state (immutable book lines, reconciliation overrides,
   * ITC decisions) to PostgreSQL. On by default; a database outage is reported
   * in `phase0.reason` and never fails the run.
   */
  persist?: boolean;
}

export interface PeriodBundle {
  gstin: string;
  period: string;
  recon: ReturnType<typeof reconcilePurchases>;
  g3: ReturnType<typeof buildGstr3b>;
  g1: ReturnType<typeof buildGstr1>;
  itcDetail: ReturnType<typeof itcDetailFromRecon>;
  bCount: number;
  wCount: number;
  sCount: number;
}

export interface FileReport {
  file: string;
  detected: string;
  rows: number;
  skipped: number;
  warnings: string[];
  /** Sales only: was the file item-wise, and how many item rows did it carry. */
  itemLevel?: boolean;
  itemRows?: number;
}

export interface MonthlyRun {
  input: string;
  out: string;
  gstins: string[];
  periods: string[];
  counts: { purchase: number; twob: number; sales: number };
  files: FileReport[];
  bundles: PeriodBundle[];
  workbookPath: string;
  returnsDir: string;
  totals: { exceptions: number; blockedItc: number; pending4ai: number };
  /** Anything the user should read before trusting the numbers. */
  messages: string[];
  /** One row per GSTIN+period, ready for the summary table. */
  summary: Array<Record<string, string | number>>;
  /** GSTR-1 problems the portal would reject (duplicate invoice, missing original, ...). */
  validationIssues: Array<{ severity: string; invoiceNo: string; message: string }>;
  /** What Phase 0 persisted, and what it could not. See src/app/store.ts. */
  phase0: Phase0Report;
  /**
   * Every exception line, grouped by kind and shaped as plain objects so it can
   * be written to JSON and served by the web server without re-running.
   */
  exceptions: Record<ExceptionKind, Array<Record<string, unknown>>>;
  log: string[];
}

export type ExceptionKind = 'missing' | 'mismatch' | 'blocked' | 'duplicate' | 'unbooked';

export interface Phase0Report {
  enabled: boolean;
  ok: boolean;
  reason?: string;
  lines: number;
  twobLines: number;
  /** Sales invoices written to sales_invoices by this run. */
  salesStored: number;
  /** Sales ITEM lines written to sales_invoice_items by this run. */
  salesItemsStored: number;
  filesRegistered: number;
  duplicateFiles: string[];
  lockedSkipped: string[];
  itcWorkingRows: number;
}

const inr = (n: number) =>
  Number(r2(n)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function readSheetRows(file: string): { rows: unknown[][]; sheetName: string; sheets: string[] } {
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  }) as unknown[][];
  return { rows, sheetName, sheets: wb.SheetNames };
}

/**
 * Scan a folder and decide what each file is.
 *
 * The portal's GSTR-2B JSON is handled first and separately: it has no header
 * row, so the tabular sniffer would reject it.
 */
export function ingestFolder(opts: RunOptions): {
  books: PurchaseBill[];
  twob: Gstr2bRecord[];
  sales: SalesInvoice[];
  files: FileReport[];
  messages: string[];
  /** Sales-register problems (arithmetic, duplicates, rate/split) with the invoice. */
  salesIssues: SalesIssue[];
} {
  const { log = () => {} } = opts;
  const names = fs
    .readdirSync(opts.input)
    .filter((f) => /\.(xlsx|xlsm|xlsb|csv|json)$/i.test(f) && !/^~\$/.test(f))
    // The team's own output workbooks must not be mistaken for source data.
    .filter((f) => !/gst reco|reconcilation/i.test(f));

  let books: PurchaseBill[] = [];
  let twob: Gstr2bRecord[] = [];
  let sales: SalesInvoice[] = [];
  const messages: string[] = [];
  const files: FileReport[] = [];
  const salesIssues: SalesIssue[] = [];

  for (const f of names) {
    const full = path.join(opts.input, f);
    const report: FileReport = { file: f, detected: 'unknown', rows: 0, skipped: 0, warnings: [] };

    if (/\.json$/i.test(f)) {
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e: any) {
        messages.push(`${f}: invalid JSON (${e.message})`);
        files.push({ ...report, detected: 'invalid json' });
        continue;
      }
      if (!isGstr2bJson(json)) {
        files.push({ ...report, detected: 'json (not a GSTR-2B)' });
        log(`  ${f}\n    detected as: json (not a GSTR-2B)`);
        continue;
      }
      try {
        const r = parseGstr2bJson(json, f);
        twob.push(...r.rows);
        report.detected = 'gstr-2b portal JSON';
        report.rows = r.rows.length;
        report.skipped = r.skipped.length;
        report.warnings = r.warnings || [];
        for (const s of r.skipped) messages.push(`${f}: ${s.reason}`);
      } catch (e: any) {
        messages.push(`${f}: ${e.message}`);
        report.detected = 'gstr-2b portal JSON (failed)';
      }
      files.push(report);
      log(
        `  ${f}\n    detected as: ${report.detected}\n    2B rows ${report.rows}, skipped ${report.skipped}` +
          report.warnings.map((w) => `\n    warning: ${w}`).join(''),
      );
      continue;
    }

    let rows: unknown[][];
    try {
      rows = readSheetRows(full).rows;
    } catch (e: any) {
      messages.push(`${f}: could not read (${e.message})`);
      files.push({ ...report, detected: 'unreadable' });
      continue;
    }
    const kind = sniffKind(rows);
    report.detected = kind;

    try {
      if (kind === 'purchase') {
        const r = parsePurchaseRegister(rows, f);
        books.push(...r.rows);
        report.rows = r.rows.length;
        report.skipped = r.skipped.length;
        if (r.unmappedHeaders.length) log(`    ignored columns: ${r.unmappedHeaders.slice(0, 8).join(' | ')}`);
      } else if (kind === 'twob') {
        const r = parseGstr2b(rows, f);
        twob.push(...r.rows);
        report.rows = r.rows.length;
        report.skipped = r.skipped.length;
        if (r.unmappedHeaders.length) log(`    ignored columns: ${r.unmappedHeaders.slice(0, 8).join(' | ')}`);
      } else if (kind === 'sales') {
        const r = parseSalesRegister(rows, f);
        report.itemLevel = r.itemLevel;
        report.itemRows = r.itemRows;
        salesIssues.push(...r.issues);
        // A column the parser does not recognise is dropped without a word, and
        // the GSTR-1 built from the rest is quietly wrong. The purchase and 2B
        // readers have always said so; the sales reader never did.
        if (r.unmappedHeaders.length) {
          log(`    ignored columns: ${r.unmappedHeaders.slice(0, 8).join(' | ')}`);
        }
        for (const s of r.skipped) {
          messages.push(`${f} row ${s.row}: ${s.reason}`);
        }
        let rowsIn = r.rows;
        if (rowsIn.length && !rowsIn.some((s) => s.our_gstin)) {
          if (opts.salesGstin) {
            rowsIn = rowsIn.map((s) => ({ ...s, our_gstin: opts.salesGstin! }));
            messages.push(`${f}: sales rows carry no GSTIN, attributed to ${opts.salesGstin} from --sales-gstin`);
          } else {
            messages.push(
              `${f}: ${rowsIn.length} sales rows carry no GSTIN and cannot be filed — re-run with --sales-gstin <GSTIN>`,
            );
            rowsIn = [];
          }
        }
        sales.push(...rowsIn);
        report.rows = rowsIn.length;
        report.skipped = r.skipped.length;
      }
    } catch (e: any) {
      messages.push(`${f}: ${e.message}`);
    }

    files.push(report);
    log(
      `  ${f}\n    detected as: ${kind}\n    rows ${report.rows}, skipped ${report.skipped}` +
        (kind === 'sales'
          ? `\n    item-wise: ${report.itemLevel ? 'yes' : 'no (one row per invoice)'}` +
            (report.itemLevel ? `, ${report.itemRows ?? 0} item row(s) grouped into invoices` : '')
          : '') +
        (kind === 'unknown' ? '\n    skipped — no recognisable GST columns' : ''),
    );
  }

  return { books, twob, sales, files, messages, salesIssues };
}

export async function runMonthly(opts: RunOptions): Promise<MonthlyRun> {
  const { log = () => {} } = opts;
  const lines: string[] = [];
  const say = (s = '') => {
    lines.push(s);
    log(s);
  };

  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input folder not found: ${opts.input}`);
  }
  say('candidate files:');

  const { books, twob, sales, files, messages, salesIssues } = ingestFolder({ ...opts, log: say });

  say(`loaded -> purchase ${books.length}, gstr2b ${twob.length}, sales ${sales.length}`);
  if (messages.length) {
    say('ingest warnings:');
    messages.forEach((l) => say(`   ! ${l}`));
  }

  // Sales-register arithmetic. This is where a multi-item invoice that repeats
  // its total, a duplicate line or a rate that does not match the tax charged
  // is caught — BEFORE the numbers reach a return. Nothing here is silent.
  if (salesIssues.length) {
    const errors = salesIssues.filter((i) => i.severity === 'ERROR').length;
    say(`sales register check: ${salesIssues.length} issue(s), ${errors} error(s)`);
    for (const i of salesIssues.slice(0, 40)) {
      say(`   ${i.severity}  ${i.invoiceNo}: ${i.message}`);
    }
    if (salesIssues.length > 40) say(`   ... ${salesIssues.length - 40} more`);
    messages.push(
      `Sales register me ${errors} error aur ${salesIssues.length - errors} warning mile — ` +
        `GSTR-1 ban gayi hai lekin inhe file karne se pehle theek karein.`,
    );
  }
  // A sales register on its own is a legitimate run: GSTR-1 is built from the
  // sales rows and there is simply nothing to reconcile. Only a folder with no
  // recognisable file at all is an error.
  if (books.length === 0 && twob.length === 0 && sales.length === 0) {
    throw new Error(
      'Nothing recognisable to reconcile. Add the SAP purchase register, the GSTR-2B (xlsx or portal JSON), ' +
        'or the sales register — the sales register alone is enough for GSTR-1.',
    );
  }
  if (books.length === 0 && twob.length === 0) {
    // Say it out loud. Every purchase-side sheet is about to be empty, and an
    // empty "Missing in 2B" sheet with no explanation reads as a clean month.
    say('  ! Sales-only run: reconciliation skipped (koi purchase register / GSTR-2B nahi mila).');
    messages.push(
      'Sirf sales register mila — GSTR-1 bani hai. Purchase reconciliation, ITC aur 4(A)(i) figures khaali hain ' +
        'kyunki koi purchase register / GSTR-2B input me nahi tha.',
    );
  }

  const gstins = [
    ...new Set([...books.map((b) => b.our_gstin), ...twob.map((t) => t.our_gstin), ...sales.map((s) => s.our_gstin)]),
  ]
    .filter(Boolean)
    .sort();
  if (gstins.length === 0) {
    // Rows were read but none could be attributed. Without this the run would
    // "succeed" with an empty workbook, which looks like a month with no data.
    throw new Error(
      'Rows mile lekin kisi row me "Our GSTIN" nahi tha. Sales template ka "Our GSTIN" column bharein ' +
        '(ya CLI par --sales-gstin <GSTIN> dein).',
    );
  }
  const allPeriods = [...new Set([...books.map((b) => b.period), ...twob.map((t) => t.period), ...sales.map((s) => s.period)])]
    .filter(Boolean)
    .sort();
  const periods = opts.onlyPeriod ? [opts.onlyPeriod] : allPeriods;
  say(`GSTINs   : ${gstins.join(', ')}`);
  say(`periods  : ${periods[0]} -> ${periods[periods.length - 1]} (${periods.length})`);

  const bundles: PeriodBundle[] = [];
  for (const gstin of gstins) {
    const g = periods.filter((p) => {
      if (opts.onlyPeriod) return true;
      return (
        books.some((b) => b.our_gstin === gstin && b.period === p) ||
        twob.some((t) => t.our_gstin === gstin && t.period === p) ||
        sales.some((s) => s.our_gstin === gstin && s.period === p)
      );
    });
    for (const period of g) bundles.push(buildOne(gstin, period));
  }

  function buildOne(gstin: string, period: string): PeriodBundle {
    const b = books.filter((x) => x.our_gstin === gstin && x.period === period);
    const w = twob.filter((x) => x.our_gstin === gstin && x.period === period);
    const s = sales.filter((x) => x.our_gstin === gstin && x.period === period);

    const recon = reconcilePurchases(b, w);
    const g3 = buildGstr3b({ gstin, period, reconRows: recon.rows, sales: s });
    const g1 = buildGstr1(gstin, s);
    const itcDetail = itcDetailFromRecon(recon.rows);

    return { gstin, period, recon, g3, g1, itcDetail, bCount: b.length, wCount: w.length, sCount: s.length };
  }

  const dupItc = (x: PeriodBundle): number =>
    r2(x.recon.rows.filter((r) => r.status === 'Duplicate').reduce((a, r) => a + r.itc, 0));

  const excOf = (x: PeriodBundle): number =>
    x.recon.summary.amount_mismatch +
    x.recon.summary.missing_in_2b +
    x.recon.summary.duplicate +
    x.recon.summary.itc_blocked;

  const summary = bundles.map((x) => ({
    gstin: x.gstin,
    period: x.period,
    label: labelOf(x.period),
    purchaseRows: x.bCount,
    purchaseItc: x.recon.summary.books_itc,
    twobRows: x.wCount,
    claimableItc: x.recon.summary.claimable_itc,
    blockedItc: x.itcDetail.reversed.notAvailed,
    pending4ai: x.itcDetail.pending4ai,
    duplicateItc: dupItc(x),
    matched: x.recon.summary.matched,
    exceptions: excOf(x),
    matchPercent: matchPercent(x.recon.summary),
    outwardTaxable: x.g3.outward.taxable,
    outputTax: x.g3.totalOutputTax,
    itcAvailed: x.g3.itcAvailed,
    taxPayable: x.g3.taxPayable,
    cashPayable: x.g3.cashPayable,
  }));

  // ---- workbook -----------------------------------------------------------
  fs.mkdirSync(opts.out, { recursive: true });

  const wb = XLSX.utils.book_new();
  const add = (name: string, aoa: unknown[][]) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31));
  };

  const summaryRows: unknown[][] = [
    ['GST RECONCILIATION & RETURN WORKBOOK'],
    [`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`],
    [`Input folder: ${opts.input}`],
    [],
    [
      'GSTIN', 'Period', 'Purchase Rows', 'Purchase ITC', '2B Rows', 'Claimable ITC',
      'Blocked ITC', '4A(i) Pending', 'Duplicate ITC', 'Matched', 'Exceptions', 'Match %',
      'Outward Taxable', 'Output Tax', '3B ITC Availed', '3B Payable / (Credit)', 'Cash Payable',
    ],
  ];
  for (const s of summary) {
    summaryRows.push([
      s.gstin, s.label, s.purchaseRows, s.purchaseItc, s.twobRows, s.claimableItc,
      s.blockedItc, s.pending4ai, s.duplicateItc, s.matched, s.exceptions, s.matchPercent,
      s.outwardTaxable, s.outputTax, s.itcAvailed, s.taxPayable, s.cashPayable,
    ]);
  }
  add('Summary', summaryRows);

  const RECON_HEAD: unknown[] = [
    'GSTIN', 'Period', 'Status', 'Vendor', 'Supplier GSTIN', 'Invoice No', 'Invoice Date',
    'Taxable', 'IGST', 'CGST', 'SGST', 'Total ITC', '2B Taxable', '2B ITC', 'ITC Difference',
    'ITC Availability', 'Reason', 'Kya karna hai',
  ];

  const missingRows: unknown[][] = [RECON_HEAD];
  const mismatchRows: unknown[][] = [RECON_HEAD];
  const blockedRows: unknown[][] = [RECON_HEAD];
  const duplicateRows: unknown[][] = [RECON_HEAD];
  const unbookedRows: unknown[][] = [RECON_HEAD];
  const bookDetail: unknown[][] = [RECON_HEAD];
  const twobDetail: unknown[][] = [[
    'GSTIN', 'Period', 'Supplier GSTIN', 'Vendor', 'Invoice No', 'Invoice Date',
    'Taxable', 'IGST', 'CGST', 'SGST', 'Total ITC', 'ITC Availability', 'Reason', 'Status',
  ]];

  const pushRecon = (target: unknown[][], r: any) =>
    target.push([
      r.our_gstin, labelOf(r.period), r.status, r.party_name, r.supplier_gstin, r.invoice_no, r.invoice_date,
      r.taxable_value, r.igst, r.cgst, r.sgst, r.itc,
      r.two_b_taxable, r.two_b_itc, r.itc_difference, r.itc_availability, r.reason, r.action,
    ]);

  const exceptions: MonthlyRun['exceptions'] = { missing: [], mismatch: [], blocked: [], duplicate: [], unbooked: [] };

  const asObject = (x: PeriodBundle, r: any, status: string) => ({
    gstin: x.gstin,
    period: x.period,
    label: labelOf(x.period),
    status,
    vendor: r.party_name,
    supplierGstin: r.supplier_gstin,
    invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date,
    taxable: r.taxable_value,
    itc: r.itc,
    twoBTaxable: r.two_b_taxable,
    twoBItc: r.two_b_itc,
    difference: r.itc_difference,
    itcAvailability: r.itc_availability,
    reason: r.reason,
    action: r.action,
  });

  for (const x of bundles) {
    for (const r of x.recon.rows) {
      pushRecon(bookDetail, r);
      if (r.status === 'Missing in 2B') {
        pushRecon(missingRows, r);
        exceptions.missing.push(asObject(x, r, r.status));
      } else if (r.status === 'Amount Mismatch') {
        pushRecon(mismatchRows, r);
        exceptions.mismatch.push(asObject(x, r, r.status));
      } else if (r.status === 'ITC Blocked') {
        pushRecon(blockedRows, r);
        exceptions.blocked.push(asObject(x, r, r.status));
      } else if (r.status === 'Duplicate') {
        pushRecon(duplicateRows, r);
        exceptions.duplicate.push(asObject(x, r, r.status));
      }
    }
    for (const r of x.recon.unbooked2b) {
      pushRecon(unbookedRows, r);
      exceptions.unbooked.push(asObject(x, r, r.status));
      twobDetail.push([
        r.our_gstin, labelOf(r.period), r.supplier_gstin, r.party_name, r.invoice_no, r.invoice_date,
        r.taxable_value, r.igst, r.cgst, r.sgst, r.itc, r.itc_availability, r.reason, r.status,
      ]);
    }
  }
  for (const t of twob) {
    const b = bundles.find((x) => x.gstin === t.our_gstin && x.period === t.period);
    const row = b?.recon.rows.find((r) => r.matched_2b_id === t.id);
    twobDetail.push([
      t.our_gstin, labelOf(t.period), t.supplier_gstin, t.supplier_name, t.invoice_no, t.invoice_date,
      t.taxable_value, t.igst, t.cgst, t.sgst, taxOf(t), t.itc_availability, t.reason,
      row?.status || 'Missing in Books',
    ]);
  }

  add('Missing in 2B', missingRows);
  add('Amount Mismatch', mismatchRows);
  add('ITC Blocked', blockedRows);
  add('Duplicates', duplicateRows);
  add('Missing in Books', unbookedRows);
  add('Purchase Detail', bookDetail);
  add('GSTR-2B Detail', twobDetail);

  // ---- ITC control --------------------------------------------------------
  const controlRows: unknown[][] = [
    ['GSTIN', 'Period', 'Opening Credit', 'Books ITC', 'Claimable ITC', 'Blocked ITC', '4A(i) Pending',
      'ITC Availed', 'Output Tax', 'ITC Utilised', 'Closing Credit', 'Lapse Risk'],
  ];
  for (const gstin of gstins) {
    const gs = periods.filter(
      (p) =>
        books.some((b) => b.our_gstin === gstin && b.period === p) ||
        twob.some((t) => t.our_gstin === gstin && t.period === p),
    );
    if (gs.length === 0) continue;

    const outputFor = (p: string) =>
      sales.filter((s) => s.our_gstin === gstin && s.period === p).reduce((a, s) => a + taxOf(s), 0);

    const c = buildItcControl({
      gstin,
      fromPeriod: gs[0],
      toPeriod: gs[gs.length - 1],
      books: books.filter((b) => b.our_gstin === gstin),
      twob: twob.filter((t) => t.our_gstin === gstin),
      outputTaxFor: outputFor,
    });

    for (const p of c.periods) {
      const risk = lapseRisk(p.closingCredit, fyOf(p.period));
      controlRows.push([
        gstin, labelOf(p.period), p.openingCredit, p.booksItc, p.claimableItc, p.blockedItc, p.pending4aiItc,
        p.itcAvailed, p.outputTax, p.itcUtilised, p.closingCredit,
        risk.expired ? `LAPSED ${risk.deadline}` : `at risk by ${risk.deadline}`,
      ]);
    }
    if (c.vendors.length) {
      controlRows.push([]);
      controlRows.push(['Top vendors costing ITC — ' + gstin]);
      controlRows.push(['Supplier GSTIN', 'Vendor', 'Invoices', 'Books ITC', 'Blocked ITC', 'Missing in 2B', 'Duplicate ITC', 'Total ITC Cost']);
      for (const v of c.vendors.slice(0, 25)) {
        controlRows.push([v.supplierGstin, v.partyName, v.invoices, v.booksItc, v.blockedItc, v.missingItc, v.duplicateItc, v.costItc]);
      }
    }
  }
  add('ITC Control', controlRows);

  // ---- GSTR-3B and GSTR-1 working sheets ----------------------------------
  const gstr3bRows: unknown[][] = [['GSTIN', 'Period', 'Table', 'Description', 'Rate %', 'Amount']];
  const gstr1Rows: unknown[][] = [[
    'GSTIN', 'Period', 'Table', 'GSTIN', 'Party', 'Invoice No', 'Invoice Date',
    'Invoice Value', 'POS', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess',
    // Appended, never inserted: the columns above keep their positions so every
    // existing reading of this sheet (and the tests that pin them) still works.
    'Item Line', 'HSN/SAC', 'UQC', 'Quantity', 'Item Description',
  ]];
  const hsnRows: unknown[][] = [[
    'GSTIN', 'Period', 'HSN/SAC', 'Item Description', 'UQC', 'Quantity', 'Rate %',
    'Taxable', 'IGST', 'CGST', 'SGST', 'Cess',
  ]];

  for (const x of bundles) {
    for (const r of gstr3bWorkingRows(x.g3)) {
      gstr3bRows.push([x.gstin, labelOf(x.period), r.table, r.description, r.rate ?? '', r.value]);
    }
    gstr3bRows.push([]);
    for (const r of gstr1SheetRows(x.g1)) {
      gstr1Rows.push([
        x.gstin, labelOf(x.period), r.table, r.gstin, r.party, r.invoiceNo, r.invoiceDate,
        r.invoiceValue, r.pos, r.rate, r.taxable, r.igst, r.cgst, r.sgst, r.cess,
        r.lineNo ?? '', r.hsn ?? '', r.uqc ?? '', r.qty ?? '', r.desc ?? '',
      ]);
    }
    for (const r of gstr1HsnSheetRows(x.g1)) {
      hsnRows.push([
        x.gstin, labelOf(x.period), r.hsn, r.description, r.uqc, r.qty, r.rate,
        r.taxable, r.igst, r.cgst, r.sgst, r.cess,
      ]);
    }
  }
  add('GSTR-3B', gstr3bRows);
  add('GSTR-1', gstr1Rows);
  add('HSN Summary', hsnRows);

  // ---- vendor follow-up ---------------------------------------------------
  const followup: unknown[][] = [[
    'GSTIN', 'Period', 'Vendor', 'Supplier GSTIN', 'Invoice No', 'Invoice Date', 'Taxable', 'ITC', 'Kya poochna hai',
  ]];
  for (const row of missingRows.slice(1)) {
    followup.push([
      row[0], row[1], row[3], row[4], row[5], row[6], row[7], row[11],
      `Vendor se GSTR-1 me ye invoice file karwaayein. Tab tak ${inr(Number(row[11]))} ITC claim mat karein.`,
    ]);
  }
  for (const r of exceptions.missing) {
    r.ask = `Vendor se GSTR-1 me ye invoice file karwaayein. Tab tak ${inr(Number(r.itc))} ITC claim mat karein.`;
  }
  add('Vendor Follow-up', followup);

  // ---- IMS Action Sheet (Accept / Reject / Pending) -----------------------
  const imsSheet: unknown[][] = [[
    'GSTIN', 'Period', '2B Month', 'Supplier GSTIN', 'Supplier Name', 'Document Type',
    'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess',
    'Total ITC', 'Recon Status', 'ITC Decision', 'IMS Action', 'IMS Remark',
  ]];
  for (const x of bundles) {
    const ims = buildImsActions(x.recon.rows, x.recon.unbooked2b);
    for (const r of ims.rows) {
      imsSheet.push([
        r.our_gstin, labelOf(r.period), labelOf(r.twob_month), r.supplier_gstin, r.supplier_name,
        r.document_type, r.invoice_no, r.invoice_date, r.taxable_value, r.igst, r.cgst, r.sgst, r.cess,
        r.total_itc, r.recon_status, r.itc_decision, r.ims_action, r.ims_remark,
      ]);
    }
  }
  add('IMS Actions', imsSheet);

  // ---- GSTR-9 Annual & GSTR-9C Audit Reconciliation -----------------------
  const fys = [...new Set(periods.map((p) => fyOf(p)).filter(Boolean))].sort();
  const gstr9Sheet: unknown[][] = [[
    'GSTIN', 'Financial Year', 'Part', 'Table', 'Description', 'Taxable Value',
    'IGST', 'CGST', 'SGST', 'Cess', 'Total Tax / ITC',
  ]];
  const gstr9cSheet: unknown[][] = [[
    'GSTIN', 'Financial Year', 'Table', 'Description', 'Amount (Rs)',
  ]];
  const compiledGstr9: Array<{ gstin: string; fy: string; g9: ReturnType<typeof buildGstr9> }> = [];
  for (const g of gstins) {
    for (const fy of fys) {
      const g9 = buildGstr9({ gstin: g, fy, sales, books, twob });
      const g9c = buildGstr9c(g9, { sales: sales.filter((s) => (!s.our_gstin || s.our_gstin === g) && fyOf(s.period) === fy) });
      compiledGstr9.push({ gstin: g, fy, g9 });
      for (const r of gstr9WorkingRows(g9)) {
        gstr9Sheet.push([
          g, fy, r.part, r.table, r.description, r.taxable,
          r.igst, r.cgst, r.sgst, r.cess, r.totalTax,
        ]);
      }
      for (const r of gstr9cWorkingRows(g9c)) {
        gstr9cSheet.push([g, fy, r.table, r.description, r.amount]);
      }
    }
  }
  add('GSTR-9 Annual', gstr9Sheet);
  add('GSTR-9C Recon', gstr9cSheet);

  const workbookPath = path.join(opts.out, `GST Monthly ${new Date().toISOString().slice(0, 10)}.xlsx`);
  XLSX.writeFile(wb, workbookPath, { bookType: 'xlsx' });

  // ---- portal JSON --------------------------------------------------------
  const returnsDir = path.join(opts.out, 'returns');
  fs.mkdirSync(returnsDir, { recursive: true });
  for (const x of bundles) {
    const base = `${x.gstin}_${x.period}`;
    fs.writeFileSync(
      path.join(returnsDir, `${base}_GSTR3B.json`),
      JSON.stringify(gstr3bPortalJson(x.g3, x.itcDetail.available, x.itcDetail.reversed), null, 2),
    );
    fs.writeFileSync(path.join(returnsDir, `${base}_GSTR1.json`), JSON.stringify(gstr1PortalJson(x.g1), null, 2));
  }
  for (const item of compiledGstr9) {
    fs.writeFileSync(
      path.join(returnsDir, `${item.gstin}_${item.fy}_GSTR9.json`),
      JSON.stringify(gstr9PortalJson(item.g9), null, 2),
    );
  }
  {
  }

  // Register-level checks first (they are about the numbers themselves), then
  // the portal-level rules the return builder enforces.
  const validationIssues = [...salesIssues, ...bundles.flatMap((x) => x.g1.validation)];

  // ---- Phase 0: persist book lines, 2B lines and the file registry --------
  // The workbook above is the report; this is the record the Accounts team
  // edits, re-reconciles and locks. A database problem is reported, not fatal:
  // a reconciliation that has already been computed must still be delivered.
  const phase0: Phase0Report = {
    enabled: opts.persist !== false && process.env.GST_PERSIST !== '0',
    ok: false,
    lines: 0,
    twobLines: 0,
    salesStored: 0,
    salesItemsStored: 0,
    filesRegistered: 0,
    duplicateFiles: [],
    lockedSkipped: [],
    itcWorkingRows: 0,
  };
  if (phase0.enabled) {
    const ready = await dbReady();
    if (!ready.ok) {
      phase0.reason = ready.reason;
      say(`  ! Phase 0 storage unavailable (${ready.reason}) — run finished, edits disabled.`);
    } else {
      const persisted = await persistRun({
        books,
        twob,
        sales,
        reconByBundle: reconMapOf(
          bundles.map((x) => ({ gstin: x.gstin, period: x.period, result: x.recon })),
        ),
        twoBFiles: twoBFileRegistry(opts.input, twob),
        uploadedBy: 'cli',
      });
      phase0.ok = persisted.ok;
      phase0.reason = persisted.reason;
      phase0.lines = persisted.linesInserted;
      phase0.twobLines = persisted.twobInserted;
      phase0.salesStored = persisted.salesInserted + persisted.salesUpdated;
      phase0.salesItemsStored = persisted.salesItemsStored;
      phase0.filesRegistered = persisted.filesRegistered;
      phase0.duplicateFiles = persisted.duplicateFiles;
      phase0.lockedSkipped = [...new Set(persisted.lockedSkipped)];
      say(
        `  Phase 0 stored: ${phase0.lines} book lines, ${phase0.twobLines} 2B lines, ` +
          `${phase0.salesStored} sales invoices, ${phase0.salesItemsStored} sales item lines, ` +
          `${phase0.filesRegistered} 2B files registered` +
          (phase0.duplicateFiles.length ? `, ${phase0.duplicateFiles.length} duplicate file(s) ignored` : '') +
          (phase0.lockedSkipped.length ? `, ${phase0.lockedSkipped.length} locked month(s) skipped` : '') +
          (phase0.reason ? `  (!) ${phase0.reason}` : ''),
      );
      if (persisted.salesUnknownGstin.length) {
        say(
          `  ! ${persisted.salesUnknownGstin.length} sales GSTIN(s) master me nahi hain — ` +
            `rows store nahi hui: ${persisted.salesUnknownGstin.slice(0, 5).join(', ')}` +
            (persisted.salesUnknownGstin.length > 5 ? ' …' : ''),
        );
      }
      try {
        const working = await itcWorking({ limit: 50000 });
        phase0.itcWorkingRows = working.length;
        // Appended to the workbook that was already written, so the file on
        // disk and the numbers in the log come from the same reconciliation.
        const wb2 = XLSX.readFile(workbookPath);
        const rows: unknown[][] = [[
          'GSTIN', 'Period', 'Vendor', 'Book GSTIN', 'Recon GSTIN', 'Book Inv No', 'Recon Inv No',
          'Book Inv Date', 'Recon Inv Date', 'Edited', 'Taxable', 'IGST', 'CGST', 'SGST', 'CESS',
          'ITC', '2B Matched', '2B Month', 'Match Status', 'ITC Decision', 'ITC Decision Month',
          'Decision By', 'Decision Date', 'Reason', 'Return Classification', '2B Taxable', '2B ITC',
        ]];
        for (const w of working) {
          rows.push([
            w.our_gstin, w.periodLabel, w.party_name, w.bookGstin, w.reconGstin,
            w.bookInvoiceNo, w.reconInvoiceNo, w.bookInvoiceDate, w.reconInvoiceDate,
            w.edited ? 'YES' : '', w.taxable, w.igst, w.cgst, w.sgst, w.cess, w.itc,
            w.twoBMatched ? 'YES' : 'No', w.twoBMonthLabel, w.match_status,
            w.itc_decision, w.itc_decision_month ?? '', w.decision_by ?? '',
            w.decision_at ? new Date(w.decision_at).toISOString().slice(0, 10) : '',
            w.decision_reason ?? '', w.return_classification, w.twoBTaxable ?? '', w.twoBItc ?? '',
          ]);
        }
        XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rows), 'ITC Working');
        XLSX.writeFile(wb2, workbookPath, { bookType: 'xlsx' });
        say(`  ITC working sheet: ${working.length} lines (spec 14)`);
      } catch (e: any) {
        say(`  ! ITC working sheet not written: ${e.message}`);
      }
    }
  }

  return {
    input: opts.input,
    out: opts.out,
    gstins,
    periods,
    counts: { purchase: books.length, twob: twob.length, sales: sales.length },
    files,
    bundles,
    workbookPath,
    returnsDir,
    totals: {
      exceptions: bundles.reduce((a, x) => a + excOf(x), 0),
      blockedItc: r2(bundles.reduce((a, x) => a + x.itcDetail.reversed.notAvailed, 0)),
      pending4ai: r2(bundles.reduce((a, x) => a + x.itcDetail.pending4ai, 0)),
    },
    messages,
    summary,
    validationIssues,
    exceptions,
    phase0,
    log: lines,
  };
}

/**
 * Build the GSTR-2B file registry rows (spec §9) from the ingested 2B lines.
 *
 * One entry per (GSTIN, 2B month, file). The SHA-256 is what stops the same
 * portal download being registered twice under a different name.
 */
function twoBFileRegistry(inputDir: string, twob: Gstr2bRecord[]): TwoBFileInput[] {
  const groups = new Map<string, { recs: Gstr2bRecord[]; meta: Gstr2bRecord }>();
  for (const t of twob) {
    const month = (t.portal_fp || t.period || '').slice(0, 7);
    if (!month) continue;
    const key = `${normGstin(t.our_gstin)}|${month}|${t.source_file ?? ''}`;
    if (!groups.has(key)) groups.set(key, { recs: [], meta: t });
    groups.get(key)!.recs.push(t);
  }

  const out: TwoBFileInput[] = [];
  for (const [, g] of groups) {
    const t = g.meta;
    const month = (t.portal_fp || t.period).slice(0, 7);
    let digest = '';
    let size: number | undefined;
    const file = t.source_file ? path.join(inputDir, t.source_file) : '';
    if (file && fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      digest = sha256(buf);
      size = buf.length;
    }
    out.push({
      file_name: t.source_file || `2b-${normGstin(t.our_gstin)}-${month}`,
      // Without a real file on disk the name itself is the fingerprint, so the
      // registry still refuses a second identical upload.
      sha256: digest || sha256(`${t.source_file}|${month}|${g.recs.length}`),
      file_size: size,
      our_gstin: normGstin(t.our_gstin),
      twob_month: month,
      portal_fp: (t.portal_fp || '').slice(0, 7) || undefined,
      record_count: g.recs.length,
      blocked_count: g.recs.filter((r) => String(r.itc_availability ?? 'Yes').toLowerCase() !== 'yes').length,
      source_format: /\.json$/i.test(t.source_file || '') ? 'json' : 'xlsx',
    });
  }
  return out;
}

export { inr };