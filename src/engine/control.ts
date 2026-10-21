/**
 * GST ERP — input tax credit control.
 *
 * Answers what a GST controller actually asks every month:
 *
 *   - How much ITC did I earn, and how much did I actually use?
 *   - What is the credit balance sitting in the balance sheet?
 *   - How much is blocked, and how much has no GSTR-2B support at all?
 *   - Which vendors keep costing me credit?
 *   - What is about to lapse? (cl.16(4)(d) — ITC for an FY lapses after
 *     30 November of the following FY, unless it is declared under 4A(i).)
 *
 * The running balance is the point of the module. ITC is an asset, not a
 * monthly P&L item: a month with big purchases and no sales builds credit that
 * must carry forward, and forgetting to carry it is the single most expensive
 * GST bookkeeping mistake.
 */

import {
  fyOf,
  monthRange,
  r2,
  taxOf,
  type Gstr2bRecord,
  type PurchaseBill,
  type ReconRow,
} from './core';
import { reconcilePurchases } from './match';

/** Credit in one GSTIN for one month, after reconciliation. */
export interface PeriodCredit {
  period: string;
  gstin: string;
  booksRows: number;
  twobRows: number;

  /** ITC the purchase books recorded. */
  booksItc: number;
  /** ITC actually supported by GSTR-2B and not blocked. */
  claimableItc: number;
  /** Blocked by the portal (cl.16(4)). Not claimable. */
  blockedItc: number;
  /** In the books with no GSTR-2B support. Claimable only via 4A(i). */
  pending4aiItc: number;
  /** Booked twice. Must be reversed before claiming. */
  duplicateItc: number;

  /** 4(A) + 4(B) as filed. */
  itcAvailed: number;
}

export interface RunningRow extends PeriodCredit {
  openingCredit: number;
  /** Output tax for the month, supplied by the GSTR-3B builder. */
  outputTax: number;
  itcUtilised: number;
  closingCredit: number;
  /** ITC about to lapse, per cl.16(4)(d). */
  lapsing: number;
}

export interface VendorExposure {
  supplierGstin: string;
  partyName: string;
  invoices: number;
  booksItc: number;
  blockedItc: number;
  missingItc: number;
  duplicateItc: number;
  /** ITC this vendor has cost the business and that is still unrecovered. */
  costItc: number;
}

export interface ItcControlReport {
  gstin: string;
  fromPeriod: string;
  toPeriod: string;
  periods: RunningRow[];
  totals: {
    booksItc: number;
    claimableItc: number;
    blockedItc: number;
    pending4aiItc: number;
    duplicateItc: number;
    itcUtilised: number;
    openingCredit: number;
    closingCredit: number;
    lapsing: number;
    /** Months where credit built up and was NOT used. */
    idleCreditMonths: number;
  };
  vendors: VendorExposure[];
}

/**
 * Build the control report for one GSTIN across a period range.
 *
 * `outputTaxFor` lets the caller plug in the GSTR-3B outward figures so the
 * running balance reflects real liability instead of an assumption. When it is
 * omitted, credit simply accumulates, which is the conservative reading.
 */
export function buildItcControl(opts: {
  gstin: string;
  fromPeriod: string;
  toPeriod: string;
  books: PurchaseBill[];
  twob: Gstr2bRecord[];
  outputTaxFor?: (period: string) => number;
  /** Credit opening balance brought forward from before `fromPeriod`. */
  openingCredit?: number;
}): ItcControlReport {
  const { gstin, fromPeriod, toPeriod } = opts;
  const periods = monthRange(fromPeriod, toPeriod);

  const rows: RunningRow[] = [];
  let opening = r2(opts.openingCredit ?? 0);
  let totalClaimable = 0;
  let totalBlocked = 0;
  let totalPending = 0;
  let totalDuplicate = 0;
  let totalBooks = 0;
  let totalUtilised = 0;
  let idleMonths = 0;

  for (const period of periods) {
    const b = opts.books.filter((x) => periodOfSafe(x) === period);
    const w = opts.twob.filter((x) => periodOfSafe(x) === period);
    const recon: ReconRow[] = reconcilePurchases(b, w).rows;

    let blockedItc = 0;
    let pending4aiItc = 0;
    let duplicateItc = 0;
    let claimableItc = 0;

    for (const r of recon) {
      if (r.status === 'ITC Blocked') {
        blockedItc = r2(blockedItc + (r.two_b_itc ?? r.itc));
      } else if (r.status === 'Duplicate') {
        duplicateItc = r2(duplicateItc + r.itc);
      } else if (r.status === 'Missing in 2B') {
        pending4aiItc = r2(pending4aiItc + r.itc);
      } else {
        // Matched / Amount Mismatch both claim at the 2B amount.
        claimableItc = r2(claimableItc + (r.two_b_itc ?? r.itc));
      }
    }

    const booksItc = r2(recon.reduce((a, r) => a + r.itc, 0));
    // Blocked credit is a REVERSAL (3B table 4(B)) and is never part of what was
    // availed. Adding it here credited the ledger with money the portal had
    // already refused, and that credit then looked usable against output tax.
    const itcAvailed = r2(claimableItc);
    const outputTax = r2(opts.outputTaxFor?.(period) ?? 0);

    // Credit is an asset: opening credit plus what was earned, less what the
    // month's liability could absorb.
    const available = r2(opening + itcAvailed);
    const itcUtilised = outputTax > 0 ? r2(Math.min(available, outputTax)) : 0;
    const closingCredit = r2(available - itcUtilised);

    if (closingCredit > 0 && itcUtilised === 0) idleMonths++;

    rows.push({
      period,
      gstin,
      booksRows: b.length,
      twobRows: w.length,
      booksItc,
      claimableItc,
      blockedItc,
      pending4aiItc,
      duplicateItc,
      itcAvailed,
      openingCredit: opening,
      outputTax,
      itcUtilised,
      closingCredit,
      lapsing: closingCredit,
    });

    opening = closingCredit;
    totalClaimable = r2(totalClaimable + claimableItc);
    totalBlocked = r2(totalBlocked + blockedItc);
    totalPending = r2(totalPending + pending4aiItc);
    totalDuplicate = r2(totalDuplicate + duplicateItc);
    totalBooks = r2(totalBooks + booksItc);
    totalUtilised = r2(totalUtilised + itcUtilised);
  }

  // ---- vendor exposure -----------------------------------------------------
  const vendors = new Map<string, VendorExposure>();
  for (const r of rows.length ? allRowsFor(opts, periods) : []) {
    const k = r.supplier_gstin || '(no GSTIN)';
    if (!vendors.has(k)) {
      vendors.set(k, {
        supplierGstin: k,
        partyName: r.party_name || k,
        invoices: 0,
        booksItc: 0,
        blockedItc: 0,
        missingItc: 0,
        duplicateItc: 0,
        costItc: 0,
      });
    }
    const v = vendors.get(k)!;
    v.invoices++;
    v.booksItc = r2(v.booksItc + r.itc);
    if (r.status === 'ITC Blocked') v.blockedItc = r2(v.blockedItc + r.itc);
    else if (r.status === 'Missing in 2B') v.missingItc = r2(v.missingItc + r.itc);
    else if (r.status === 'Duplicate') v.duplicateItc = r2(v.duplicateItc + r.itc);
  }
  for (const v of vendors.values()) {
    v.costItc = r2(v.blockedItc + v.missingItc + v.duplicateItc);
    if (v.partyName === v.supplierGstin && v.supplierGstin !== '(no GSTIN)') {
      // Keep the better name seen across rows.
      const named = allRowsFor(opts, periods).find((r) => r.supplier_gstin === v.supplierGstin && r.party_name);
      if (named?.party_name) v.partyName = named.party_name;
    }
  }

  const sortedVendors = [...vendors.values()]
    .filter((v) => v.costItc > 0)
    .sort((a, b) => b.costItc - a.costItc);

  return {
    gstin,
    fromPeriod,
    toPeriod,
    periods: rows,
    totals: {
      booksItc: totalBooks,
      claimableItc: totalClaimable,
      blockedItc: totalBlocked,
      pending4aiItc: totalPending,
      duplicateItc: totalDuplicate,
      itcUtilised: totalUtilised,
      openingCredit: r2(opts.openingCredit ?? 0),
      closingCredit: rows.length ? rows[rows.length - 1].closingCredit : 0,
      lapsing: rows.length ? rows[rows.length - 1].closingCredit : 0,
      idleCreditMonths: idleMonths,
    },
    vendors: sortedVendors,
  };
}

/** Reconcile every period once and hand back the flattened rows. */
function allRowsFor(opts: { books: PurchaseBill[]; twob: Gstr2bRecord[] }, periods: string[]): ReconRow[] {
  const out: ReconRow[] = [];
  for (const period of periods) {
    out.push(
      ...reconcilePurchases(
        opts.books.filter((x) => periodOfSafe(x) === period),
        opts.twob.filter((x) => periodOfSafe(x) === period)
      ).rows
    );
  }
  return out;
}

function periodOfSafe(x: { period?: string }): string {
  return x.period || '';
}

/**
 * Flag credit that will lapse.
 *
 * cl.16(4)(d): ITC for a financial year must be claimed by 30 November of the
 * following FY. The `asOf` date lets the caller ask "what is at risk right now"
 * rather than only reporting the final balance.
 */
export function lapseRisk(
  closingCredit: number,
  fy: string,
  asOf = new Date(),
): { lapsing: number; deadline: string; expired: boolean } {
  // Accept "2025-26", "2025-04", "2025" or a raw year number. The financial year
  // a period belongs to decides the deadline, so a period must be resolved to
  // its FY before it gets here.
  const fyCode = /^\d{4}-\d{2}$/.test(fy) ? fy : fyOf(fy);
  const m = /^(\d{4})-(\d{2})$/.exec(fyCode);
  const startYear = m ? Number(m[1]) : Number(String(fy).slice(0, 4)) || asOf.getFullYear();
  const deadline = new Date(startYear + 1, 10, 30, 23, 59, 59); // 30 Nov of the next FY
  const days = Math.ceil((deadline.getTime() - asOf.getTime()) / 86400000);
  const y = deadline.getFullYear();
  const mm = String(deadline.getMonth() + 1).padStart(2, '0');
  const dd = String(deadline.getDate()).padStart(2, '0');
  return {
    lapsing: closingCredit,
    deadline: `${y}-${mm}-${dd}`,
    expired: days < 0,
  };
}
