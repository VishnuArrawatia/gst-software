/**
 * GST ERP — monthly run (command line).
 *
 * All the work lives in src/app/pipeline.ts so that the web server and this
 * command produce identical numbers. This file only parses flags and prints.
 *
 * Usage:
 *   npm run cli -- --input "D:\c drive\Desktop\GST Monthly Input" --out "F:\GST-SOFTWARE\output"
 *   npm run cli -- --input <dir> --period 2025-04
 *   npm run cli -- --sales-gstin 26AALCS9985J1ZC
 *   npm run cli -- --json run.json      # dump the whole run for another program
 *
 * File type is detected from the content, not the file name, so the folder can
 * contain "Purchase Register Apr25-Mar26.xlsx", a GSTR-2B download and the
 * portal's 2B JSON with no configuration.
 */

import fs from 'fs';

import { inr, runMonthly } from '../app/pipeline';
import { labelOf } from '../engine/core';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const INPUT = arg('input', process.env.GST_INPUT_DIR || 'D:/c drive/Desktop/GST Monthly Input')!;
const OUT = arg('out', process.env.GST_OUTPUT_DIR || 'output')!;
const ONLY_PERIOD = arg('period');
const SALES_GSTIN = arg('sales-gstin', process.env.GST_SALES_GSTIN);

function head(msg: string) {
  console.log('\n' + '='.repeat(74) + '\n' + msg + '\n' + '='.repeat(74));
}

head('GST ERP — monthly run');
console.log('input :', INPUT);
console.log('output:', OUT);

const run = await runMonthly({
  input: INPUT,
  out: OUT,
  onlyPeriod: ONLY_PERIOD,
  salesGstin: SALES_GSTIN,
  log: (s) => console.log(s),
});

console.log('\nwrote workbook:', run.workbookPath);
console.log('wrote return JSON ->', run.returnsDir);

/**
 * `--json <path>` dumps the whole run so another program (the web server) can
 * serve the numbers without re-reading the 20k-row workbook.
 */
const JSON_OUT = arg('json');
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ ...run, log: undefined, bundles: undefined }, null, 2));
  console.log('wrote run JSON ->', JSON_OUT);
}

head('RESULTS');
console.log('GSTIN       Period   Matched  Exc   Claimable ITC   Output Tax   Payable/(Credit)   Cash');
for (const x of run.bundles) {
  const exc =
    x.recon.summary.amount_mismatch +
    x.recon.summary.missing_in_2b +
    x.recon.summary.duplicate +
    x.recon.summary.itc_blocked;
  console.log(
    `${x.gstin}  ${labelOf(x.period)}   ${String(x.recon.summary.matched).padStart(6)}  ${String(exc).padStart(4)}   ` +
      `${inr(x.g3.itcAvailable).padStart(14)}   ${inr(x.g3.totalOutputTax).padStart(12)}   ` +
      `${inr(x.g3.taxPayable).padStart(18)}   ${inr(x.g3.cashPayable).padStart(12)}`,
  );
}

console.log(
  `\nexceptions ${run.totals.exceptions} | blocked ITC ${inr(run.totals.blockedItc)} | 4A(i) pending ${inr(run.totals.pending4ai)}`,
);

// Phase 0 — what is now stored and editable, and what was refused.
if (run.phase0.enabled) {
  console.log(
    `\nphase 0 stored: ${run.phase0.lines} book lines, ${run.phase0.twobLines} 2B lines, ` +
      `${run.phase0.filesRegistered} 2B files, ${run.phase0.itcWorkingRows} ITC working rows`,
  );
  if (run.phase0.reason) console.log(`  ! ${run.phase0.reason}`);
  for (const d of run.phase0.duplicateFiles) console.log(`  duplicate 2B file ignored: ${d}`);
  for (const l of run.phase0.lockedSkipped) console.log(`  locked month, not written: ${l}`);
}

if (run.validationIssues.length) {
  console.log(`\nGSTR-1 validation — ${run.validationIssues.length} issue(s):`);
  for (const v of run.validationIssues.slice(0, 20)) {
    console.log(`  [${v.severity}] ${v.invoiceNo}: ${v.message}`);
  }
} else if (run.counts.sales > 0) {
  console.log('\nGSTR-1 validation: clean');
}
console.log('\ndone.');
