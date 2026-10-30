/**
 * GST ERP — Annual Return GSTR-9 & Reconciliation Statement GSTR-9C Compiler.
 *
 * Compiles 12 months of outward (Sales / GSTR-1) and inward (Purchase / GSTR-2B / GSTR-3B)
 * data for a Financial Year (`YYYY-YY`, e.g. `2025-26`) plus the next-FY spillover window
 * (April to October, filed up to 30 November) into:
 *   1. Complete GSTR-9 (Parts II, III, IV, V, VI — Tables 4 to 18)
 *   2. GSTR-9 Portal JSON (`gstr9PortalJson`)
 *   3. Complete GSTR-9C Audit Reconciliation (Tables 5, 7, 9, 12)
 *   4. CA-friendly working sheet rows (`gstr9WorkingRows`, `gstr9cWorkingRows`)
 */

import {
  effectiveRate,
  fyOf,
  isCreditNote,
  r2,
  taxOf,
  type Gstr2bRecord,
  type PurchaseBill,
  type SalesInvoice,
} from './core';
import { buildGstr1, type HsnRow } from './gstr1';
import { buildGstr3b } from './gstr3b';
import { reconcilePurchases } from './match';

export interface TaxMoney {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
}

export interface ItcMoney {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
}

export interface Gstr9MonthlySlice {
  period: string;
  gstr1Taxable: number;
  gstr1Tax: number;
  gstr3bOutwardTaxable: number;
  gstr3bOutputTax: number;
  outwardDiffTaxable: number;
  outwardDiffTax: number;
  booksItc: number;
  twobItc: number;
  gstr3bItcAvailable: number;
  gstr3bItcReversed: number;
  gstr3bItcNet: number;
  rcmTaxable: number;
  rcmTax: number;
  cashPaid: number;
  itcUtilised: number;
}

export interface Gstr9Model {
  gstin: string;
  legalName?: string;
  fy: string;
  fp: string; // Portal financial year period e.g. '032026' for 2025-26

  /** Part II — Table 4: Outward and inward supplies made during the FY on which tax is payable */
  table4: {
    b2c: TaxMoney;          // 4A: Supplies made to un-registered persons (B2CS + B2CL)
    b2b: TaxMoney;          // 4B: Supplies made to registered persons (B2B)
    expWp: TaxMoney;        // 4C: Zero-rated supply (Export) on payment of tax
    sezWp: TaxMoney;        // 4D: Supply to SEZ on payment of tax
    deemedExp: TaxMoney;    // 4E: Deemed Exports
    advances: TaxMoney;     // 4F: Advances on which tax has been paid but invoice not issued
    inwardRcm: TaxMoney;    // 4G: Inward supplies on which tax is to be paid on reverse charge basis
    subTotal4H: TaxMoney;   // 4H: Sub-total (4A to 4G)
    creditNotes: TaxMoney;  // 4I: Credit notes issued in respect of 4B to 4E
    debitNotes: TaxMoney;   // 4J: Debit notes issued in respect of 4B to 4E
    amendmentsAdd: TaxMoney;// 4K: Supplies / tax declared through Amendments (+)
    amendmentsSub: TaxMoney;// 4L: Supplies / tax reduced through Amendments (-)
    subTotal4M: TaxMoney;   // 4M: Sub-total (4I to 4L)
    totalTaxable4N: TaxMoney; // 4N: Supplies and advances on which tax is to be paid (4H + 4M)
  };

  /** Part II — Table 5: Outward supplies made during the FY on which tax is NOT payable */
  table5: {
    expWop: number;         // 5A: Zero rated supply (Export) without payment of tax
    sezWop: number;         // 5B: Supply to SEZ without payment of tax
    rcmOutward: number;     // 5C: Supplies on which tax is to be paid by recipient on RCM
    exempted: number;       // 5D: Exempted
    nilRated: number;       // 5E: Nil Rated
    nonGst: number;         // 5F: Non-GST supply (includes 'no supply')
    subTotal5G: number;     // 5G: Sub-total (5A to 5F)
    creditNotes: number;    // 5H: Credit notes in respect of 5A to 5F
    debitNotes: number;     // 5I: Debit notes in respect of 5A to 5F
    totalNonTaxable5M: number; // 5M: Turnover on which tax is not to be paid
    totalTurnover5N: number;   // 5N: Total Turnover (including advances) (4N + 5M - 4G)
  };

  /** Part III — Table 6: Details of ITC availed during the financial year */
  table6: {
    auto3b6A: ItcMoney;     // 6A: Total amount of ITC availed through FORM GSTR-3B
    inwardInputs6B: ItcMoney; // 6B: Inward supplies (other than imports & RCM)
    rcmUnreg6C: ItcMoney;   // 6C: Inward supplies from unregistered persons liable to RCM
    rcmReg6D: ItcMoney;     // 6D: Inward supplies from registered persons liable to RCM
    importsGoods6E: ItcMoney; // 6E: Import of goods
    importsServices6F: ItcMoney; // 6F: Import of services
    isd6G: ItcMoney;        // 6G: Input Tax credit received from ISD
    reclaimed6H: ItcMoney;  // 6H: Amount of ITC reclaimed under the provisions of the Act
    subTotal6I: ItcMoney;   // 6I: Sub-total (6B to 6H)
    difference6J: ItcMoney; // 6J: Difference (6I - 6A)
    totalAvailed6O: ItcMoney; // 6O: Total ITC availed
  };

  /** Part III — Table 7: Details of ITC Reversed and Ineligible ITC */
  table7: {
    rule37_7A: ItcMoney;    // 7A: As per Rule 37 (180-day non-payment)
    sec17_5_7E: ItcMoney;   // 7E: As per Section 17(5) / Blocked / 16(4) reversals in 3B 4(B)
    otherReversals7H: ItcMoney; // 7H: Other reversals
    totalReversed7I: ItcMoney;  // 7I: Total ITC Reversed (sum of 7A to 7H)
    netItcAvailable7J: ItcMoney;// 7J: Net ITC Available for Utilization (6O - 7I)
  };

  /** Part III — Table 8: Other ITC related information (GSTR-2B vs GSTR-3B reconciliation) */
  table8: {
    itcAsPer2b8A: ItcMoney;      // 8A: ITC as per GSTR-2B
    itcAsPer6B6H_8B: ItcMoney;   // 8B: ITC as per sum of 6B and 6H
    itcClaimedNextFy8C: ItcMoney;// 8C: ITC on inward supplies received in FY but availed in next FY (Apr-Oct)
    difference8D: ItcMoney;      // 8D: Difference [8A - (8B + 8C)]
    availableNotAvailed8E: ItcMoney; // 8E: ITC available but not availed
    ineligible8F: ItcMoney;      // 8F: ITC available but ineligible
    lapsed8K: ItcMoney;          // 8K: Total ITC to be lapsed in current financial year
  };

  /** Part IV — Table 9: Details of tax paid as declared in returns filed during the FY */
  table9: {
    taxPayable: ItcMoney;
    paidThroughItc: ItcMoney;
    paidInCash: ItcMoney;
    difference: ItcMoney;
  };

  /** Part V — Tables 10, 11, 12, 13: Next-FY spillover adjustments (April to October returns) */
  partV: {
    table10SuppliesAdd: TaxMoney; // 10: Supplies / tax declared through Amendments (+) in next FY
    table11SuppliesSub: TaxMoney; // 11: Supplies / tax reduced through Amendments (-) in next FY
    table12ItcReversed: ItcMoney; // 12: Reversal of ITC availed during previous FY
    table13ItcAvailed: ItcMoney;  // 13: ITC availed for the previous FY in next FY (Apr-Oct)
  };

  /** Part VI — Tables 17 & 18: Annual Outward and Inward HSN Summary */
  table17OutwardHsn: HsnRow[];
  table18InwardHsn: HsnRow[];

  /** 12-Month Control Matrix (GSTR-1 vs GSTR-3B vs GSTR-2B vs Books) */
  monthlySummary: Gstr9MonthlySlice[];
}

export interface Gstr9cModel {
  gstin: string;
  legalName?: string;
  fy: string;
  /** Part II — Table 5 & 7: Reconciliation of Gross and Taxable Turnover */
  turnoverRecon: {
    turnoverAsPerBooks: number;       // 5A: Turnover as per audited financial statements / P&L
    unbilledRevenue: number;          // 5B
    deemedSupply: number;             // 5D
    creditNotesNotInReturn: number;   // 5E
    annualTurnoverAdjusted5P: number; // 5P: Annual turnover after adjustments
    turnoverAsPerGstr9_5Q: number;    // 5Q: Turnover as declared in Annual Return (GSTR-9 5N)
    unreconciledTurnover5R: number;   // 5R: Un-reconciled turnover (5Q - 5P)
    exemptNilNonGst7B: number;        // 7B: Value of Exempt, Nil-rated, Non-GST supplies
    zeroRatedWithoutTax7C: number;    // 7C: Zero-rated supplies made without payment of tax
    rcmOutward7D: number;             // 7D: Supplies on which tax is to be paid by recipient on RCM
    adjustedTaxableTurnover7E: number;// 7E: Taxable turnover as per adjustments above
    taxableTurnoverGstr9_7F: number;  // 7F: Taxable turnover as per Table 4N - 4G of GSTR-9
    unreconciledTaxable7G: number;    // 7G: Unreconciled taxable turnover (7F - 7E)
  };
  /** Part III — Table 9: Reconciliation of rate-wise liability and amount payable thereon */
  taxLiabilityRecon: {
    byRate: Array<{
      rate: number;
      taxable: number;
      igst: number;
      cgst: number;
      sgst: number;
      cess: number;
      totalTax: number;
    }>;
    rcmLiability: TaxMoney;
    totalPayableAsPer9c_9P: ItcMoney;
    totalPaidAsPerGstr9_9Q: ItcMoney;
    unreconciledTax9R: ItcMoney;
  };
  /** Part IV — Table 12: Reconciliation of Net Input Tax Credit (ITC) */
  itcRecon: {
    itcAsPerBooks12A: number;        // 12A: ITC availed as per audited financial statements / Purchase Register
    itcBookedInPrevFyClaimedNow12B: number; // 12B: ITC booked in earlier FY claimed in current FY
    itcBookedNowClaimedNextFy12C: number;   // 12C: ITC booked in current FY to be claimed in subsequent FY
    itcAvailedAsPerBooks12D: number; // 12D: ITC availed as per financial statements (12A + 12B - 12C)
    itcClaimedInGstr9_12E: number;   // 12E:ITC claimed in Annual Return (GSTR-9 Table 7J)
    unreconciledItc12F: number;      // 12F: Un-reconciled ITC (12E - 12D)
  };
}

export interface BuildGstr9Input {
  gstin: string;
  legalName?: string;
  /** Financial year in `YYYY-YY` format, e.g. `2025-26` (or a period like `2025-04`). */
  fy: string;
  sales: SalesInvoice[];
  books: PurchaseBill[];
  twob: Gstr2bRecord[];
  /** Optional audited P&L turnover for GSTR-9C Table 5A. Defaults to books sales turnover. */
  auditedTurnover?: number;
}

export function zeroTaxMoney(): TaxMoney {
  return { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 };
}

export function zeroItcMoney(): ItcMoney {
  return { igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
}

function addTaxMoney(a: TaxMoney, b: Partial<TaxMoney>): TaxMoney {
  const taxable = r2(a.taxable + r2(b.taxable ?? 0));
  const igst = r2(a.igst + r2(b.igst ?? 0));
  const cgst = r2(a.cgst + r2(b.cgst ?? 0));
  const sgst = r2(a.sgst + r2(b.sgst ?? 0));
  const cess = r2(a.cess + r2(b.cess ?? 0));
  return { taxable, igst, cgst, sgst, cess, tax: r2(igst + cgst + sgst + cess) };
}

function addItcMoney(a: ItcMoney, b: Partial<ItcMoney>): ItcMoney {
  const igst = r2(a.igst + r2(b.igst ?? 0));
  const cgst = r2(a.cgst + r2(b.cgst ?? 0));
  const sgst = r2(a.sgst + r2(b.sgst ?? 0));
  const cess = r2(a.cess + r2(b.cess ?? 0));
  return { igst, cgst, sgst, cess, total: r2(igst + cgst + sgst + cess) };
}

function subItcMoney(a: ItcMoney, b: Partial<ItcMoney>): ItcMoney {
  const igst = r2(a.igst - r2(b.igst ?? 0));
  const cgst = r2(a.cgst - r2(b.cgst ?? 0));
  const sgst = r2(a.sgst - r2(b.sgst ?? 0));
  const cess = r2(a.cess - r2(b.cess ?? 0));
  return { igst, cgst, sgst, cess, total: r2(igst + cgst + sgst + cess) };
}

/** Return the 12 `YYYY-MM` periods of a financial year (`2025-26` -> `2025-04..2026-03`). */
export function fyMonths(fyInput: string): { fy: string; months: string[]; spilloverMonths: string[]; fp: string } {
  const fy = /^\d{4}-\d{2}$/.test(fyInput) && Number(fyInput.slice(5, 7)) > 12 ? fyInput : fyOf(fyInput);
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  const startYear = m ? Number(m[1]) : 2025;
  const endYear = startYear + 1;
  const months: string[] = [];
  for (let mm = 4; mm <= 12; mm++) months.push(`${startYear}-${String(mm).padStart(2, '0')}`);
  for (let mm = 1; mm <= 3; mm++) months.push(`${endYear}-${String(mm).padStart(2, '0')}`);
  const spilloverMonths: string[] = [];
  for (let mm = 4; mm <= 10; mm++) spilloverMonths.push(`${endYear}-${String(mm).padStart(2, '0')}`);
  return { fy: `${startYear}-${String(endYear).slice(-2)}`, months, spilloverMonths, fp: `03${endYear}` };
}

export function buildGstr9(input: BuildGstr9Input): Gstr9Model {
  const { gstin, legalName } = input;
  const { fy, months, spilloverMonths, fp } = fyMonths(input.fy);
  const monthSet = new Set(months);
  const spilloverSet = new Set(spilloverMonths);

  const fySales = input.sales.filter((s) => (!s.our_gstin || s.our_gstin === gstin) && monthSet.has(s.period));
  const fyBooks = input.books.filter((b) => (!b.our_gstin || b.our_gstin === gstin) && monthSet.has(b.period));
  const fyTwob = input.twob.filter((w) => (!w.our_gstin || w.our_gstin === gstin) && monthSet.has(w.period));

  // ---- Part II: Table 4 & Table 5 from FY Sales ---------------------------
  let b2c = zeroTaxMoney();
  let b2b = zeroTaxMoney();
  let expWp = zeroTaxMoney();
  let sezWp = zeroTaxMoney();
  let deemedExp = zeroTaxMoney();
  const advances = zeroTaxMoney();
  let inwardRcm = zeroTaxMoney();
  let creditNotes = zeroTaxMoney();
  let debitNotes = zeroTaxMoney();
  const amendmentsAdd = zeroTaxMoney();
  const amendmentsSub = zeroTaxMoney();

  let expWop = 0;
  let sezWop = 0;
  const rcmOutward = 0;
  let exempted = 0;
  let nilRated = 0;
  let nonGst = 0;
  let table5CreditNotes = 0;
  let table5DebitNotes = 0;

  for (const s of fySales) {
    const t = r2(s.taxable_value);
    const tax = taxOf(s);
    const tm: Partial<TaxMoney> = {
      taxable: t,
      igst: r2(s.igst),
      cgst: r2(s.cgst),
      sgst: r2(s.sgst),
      cess: r2(s.cess),
    };
    const isZeroOrNonTax =
      s.invoice_type === 'EXPWOP' ||
      s.invoice_type === 'SEWOP' ||
      s.invoice_type === 'EXEMPT' ||
      s.invoice_type === 'NIL' ||
      s.invoice_type === 'NONGST' ||
      (t !== 0 && tax === 0 && s.invoice_type !== 'EXPWP' && s.invoice_type !== 'SEZWP' && s.invoice_type !== 'DE');

    if (isCreditNote(s.invoice_type)) {
      if (tax === 0 && isZeroOrNonTax) {
        if (s.invoice_type === 'DN') table5DebitNotes = r2(table5DebitNotes + Math.abs(t));
        else table5CreditNotes = r2(table5CreditNotes + Math.abs(t));
      } else if (s.invoice_type === 'DN') {
        debitNotes = addTaxMoney(debitNotes, tm);
      } else {
        // Credit notes are stored negative in the engine; keep their signed effect
        creditNotes = addTaxMoney(creditNotes, tm);
      }
      continue;
    }

    if (s.invoice_type === 'EXPWP') {
      expWp = addTaxMoney(expWp, tm);
    } else if (s.invoice_type === 'SEZWP') {
      sezWp = addTaxMoney(sezWp, tm);
    } else if (s.invoice_type === 'DE') {
      deemedExp = addTaxMoney(deemedExp, tm);
    } else if (s.invoice_type === 'EXPWOP') {
      expWop = r2(expWop + t);
    } else if (s.invoice_type === 'SEWOP') {
      sezWop = r2(sezWop + t);
    } else if (s.invoice_type === 'EXEMPT') {
      exempted = r2(exempted + t);
    } else if (s.invoice_type === 'NONGST') {
      nonGst = r2(nonGst + t);
    } else if (s.invoice_type === 'NIL' || (t !== 0 && tax === 0)) {
      nilRated = r2(nilRated + t);
    } else if ((s.customer_gstin || '').trim().length === 15) {
      b2b = addTaxMoney(b2b, tm);
    } else {
      b2c = addTaxMoney(b2c, tm);
    }
  }

  // ---- Monthly compilation (12 months of GSTR-1, Recon, GSTR-3B) ----------
  const monthlySummary: Gstr9MonthlySlice[] = [];
  let auto3b6A = zeroItcMoney();
  let inwardInputs6B = zeroItcMoney();
  let rcmReg6D = zeroItcMoney();
  let reclaimed6H = zeroItcMoney();
  let sec17_5_7E = zeroItcMoney();
  let taxPayable9 = zeroItcMoney();
  let paidThroughItc9 = zeroItcMoney();
  let paidInCash9 = zeroItcMoney();

  let availableNotAvailed8E = zeroItcMoney();
  let ineligible8F = zeroItcMoney();

  const outwardHsnMap = new Map<string, HsnRow>();
  const inwardHsnMap = new Map<string, HsnRow>();

  for (const period of months) {
    const mSales = fySales.filter((s) => s.period === period);
    const mBooks = fyBooks.filter((b) => b.period === period);
    const mTwob = fyTwob.filter((w) => w.period === period);

    const g1 = buildGstr1(gstin, mSales);
    const recon = reconcilePurchases(mBooks, mTwob);
    const g3 = buildGstr3b({ gstin, period, reconRows: recon.rows, sales: mSales });

    // Merge Outward HSN (Table 17)
    for (const h of g1.hsn) {
      const k = `${h.hsn}|${h.uqc}|${h.rateOut}`;
      const cur = outwardHsnMap.get(k);
      if (!cur) {
        outwardHsnMap.set(k, { ...h });
      } else {
        cur.qty = r2(cur.qty + h.qty);
        cur.taxable = r2(cur.taxable + h.taxable);
        cur.igst = r2(cur.igst + h.igst);
        cur.cgst = r2(cur.cgst + h.cgst);
        cur.sgst = r2(cur.sgst + h.sgst);
        cur.cess = r2(cur.cess + h.cess);
      }
    }

    // Merge Inward HSN (Table 18) where purchase rows carry HSN
    for (const b of mBooks) {
      if (!b.hsn) continue;
      const rate = effectiveRate(b.taxable_value, taxOf(b), period);
      const k = `${b.hsn}|PCS|${rate}`;
      const cur = inwardHsnMap.get(k);
      if (!cur) {
        inwardHsnMap.set(k, {
          hsn: b.hsn,
          uqc: 'PCS',
          rateIn: rate,
          rateOut: rate,
          desc: b.remark || '',
          qty: 1,
          taxable: r2(b.taxable_value),
          igst: r2(b.igst),
          cgst: r2(b.cgst),
          sgst: r2(b.sgst),
          cess: r2(b.cess),
        });
      } else {
        cur.qty = r2(cur.qty + 1);
        cur.taxable = r2(cur.taxable + b.taxable_value);
        cur.igst = r2(cur.igst + b.igst);
        cur.cgst = r2(cur.cgst + b.cgst);
        cur.sgst = r2(cur.sgst + b.sgst);
        cur.cess = r2(cur.cess + b.cess);
      }
    }

    // RCM from 3B 3.1(d) -> GSTR-9 4G & 6D
    inwardRcm = addTaxMoney(inwardRcm, g3.inwardRcm);

    // Table 6A: Auto-populated from 3B Table 4(A)
    auto3b6A = addItcMoney(auto3b6A, g3.itcByTax.available);

    // Separate RCM ITC (6D), Reclaimed ITC (6H), and Normal Inputs ITC (6B)
    for (const r of recon.rows) {
      const ig = r2(r.two_b_igst ?? r.igst);
      const cg = r2(r.two_b_cgst ?? r.cgst);
      const sg = r2(r.two_b_sgst ?? r.sgst);
      const ce = r2(r.two_b_cess ?? r.cess);
      const cls = (r.return_classification || '').trim();
      const dec = (r.itc_decision || '').trim();

      if (dec === 'Do Not Claim') {
        availableNotAvailed8E = addItcMoney(availableNotAvailed8E, { igst: ig, cgst: cg, sgst: sg, cess: ce });
      } else if (dec === 'Ineligible' || cls === 'Ineligible' || r.status === 'ITC Blocked') {
        ineligible8F = addItcMoney(ineligible8F, { igst: ig, cgst: cg, sgst: sg, cess: ce });
      }

      const isClaimed =
        cls === '4(A) — Claimed' ||
        (!cls && dec === 'Claim') ||
        (!cls && (!dec || dec === 'Pending Review') && (r.status === 'Matched' || r.status === 'Amount Mismatch'));
      if (!isClaimed || (r.itc_decision_month && spilloverSet.has(r.itc_decision_month))) continue;

      if (r.reverse_charge) {
        rcmReg6D = addItcMoney(rcmReg6D, { igst: ig, cgst: cg, sgst: sg, cess: ce });
      } else if (r.itc_decision_month && r.itc_decision_month > r.period) {
        reclaimed6H = addItcMoney(reclaimed6H, { igst: ig, cgst: cg, sgst: sg, cess: ce });
      } else {
        inwardInputs6B = addItcMoney(inwardInputs6B, { igst: ig, cgst: cg, sgst: sg, cess: ce });
      }
    }

    // Table 7E: Reversals from 3B Table 4(B)
    sec17_5_7E = addItcMoney(sec17_5_7E, g3.itcByTax.reversed);

    // Table 9: Tax payable vs paid
    const mOutTax: ItcMoney = {
      igst: r2(g3.outward.igst + g3.inwardRcm.igst),
      cgst: r2(g3.outward.cgst + g3.inwardRcm.cgst),
      sgst: r2(g3.outward.sgst + g3.inwardRcm.sgst),
      cess: r2(g3.outward.cess + g3.inwardRcm.cess),
      total: r2(g3.totalOutputTax + g3.inwardRcm.tax),
    };
    taxPayable9 = addItcMoney(taxPayable9, mOutTax);

    // Proportional head allocation for ITC utilised vs Cash paid
    const ratio = g3.totalOutputTax > 0 ? Math.min(1, g3.itcUtilised / g3.totalOutputTax) : 0;
    const mItcUsed: ItcMoney = {
      igst: r2(g3.outward.igst * ratio),
      cgst: r2(g3.outward.cgst * ratio),
      sgst: r2(g3.outward.sgst * ratio),
      cess: r2(g3.outward.cess * ratio),
      total: g3.itcUtilised,
    };
    // RCM liability is always discharged in cash
    const mCashPaid: ItcMoney = {
      igst: r2(mOutTax.igst - mItcUsed.igst),
      cgst: r2(mOutTax.cgst - mItcUsed.cgst),
      sgst: r2(mOutTax.sgst - mItcUsed.sgst),
      cess: r2(mOutTax.cess - mItcUsed.cess),
      total: r2(g3.cashPayable + g3.inwardRcm.tax),
    };
    paidThroughItc9 = addItcMoney(paidThroughItc9, mItcUsed);
    paidInCash9 = addItcMoney(paidInCash9, mCashPaid);

    const g1Tax = r2(g1.totals.igst + g1.totals.cgst + g1.totals.sgst + g1.totals.cess);
    monthlySummary.push({
      period,
      gstr1Taxable: g1.totals.taxable,
      gstr1Tax: g1Tax,
      gstr3bOutwardTaxable: g3.outward.taxable,
      gstr3bOutputTax: g3.totalOutputTax,
      outwardDiffTaxable: r2(g1.totals.taxable - g3.outward.taxable),
      outwardDiffTax: r2(g1Tax - g3.totalOutputTax),
      booksItc: recon.summary.books_itc,
      twobItc: recon.summary.twob_itc,
      gstr3bItcAvailable: g3.itcAvailable,
      gstr3bItcReversed: g3.itcReversed,
      gstr3bItcNet: g3.itcAvailed,
      rcmTaxable: g3.inwardRcm.taxable,
      rcmTax: g3.inwardRcm.tax,
      cashPaid: mCashPaid.total,
      itcUtilised: g3.itcUtilised,
    });
  }

  // ---- Part II Subtotals & Totals -----------------------------------------
  let subTotal4H = zeroTaxMoney();
  for (const m of [b2c, b2b, expWp, sezWp, deemedExp, advances, inwardRcm]) {
    subTotal4H = addTaxMoney(subTotal4H, m);
  }
  let subTotal4M = zeroTaxMoney();
  for (const m of [creditNotes, debitNotes, amendmentsAdd, amendmentsSub]) {
    subTotal4M = addTaxMoney(subTotal4M, m);
  }
  const totalTaxable4N = addTaxMoney(subTotal4H, subTotal4M);

  const subTotal5G = r2(expWop + sezWop + rcmOutward + exempted + nilRated + nonGst);
  const totalNonTaxable5M = r2(subTotal5G - table5CreditNotes + table5DebitNotes);
  const totalTurnover5N = r2(totalTaxable4N.taxable + totalNonTaxable5M - inwardRcm.taxable);

  // ---- Part III: Table 6, Table 7, Table 8 --------------------------------
  const rcmUnreg6C = zeroItcMoney();
  const importsGoods6E = zeroItcMoney();
  const importsServices6F = zeroItcMoney();
  const isd6G = zeroItcMoney();
  let subTotal6I = zeroItcMoney();
  for (const m of [inwardInputs6B, rcmUnreg6C, rcmReg6D, importsGoods6E, importsServices6F, isd6G, reclaimed6H]) {
    subTotal6I = addItcMoney(subTotal6I, m);
  }
  const difference6J = subItcMoney(subTotal6I, auto3b6A);
  const totalAvailed6O = { ...subTotal6I };

  const rule37_7A = zeroItcMoney();
  const otherReversals7H = zeroItcMoney();
  const totalReversed7I = addItcMoney(addItcMoney(rule37_7A, sec17_5_7E), otherReversals7H);
  const netItcAvailable7J = subItcMoney(totalAvailed6O, totalReversed7I);

  // Table 8A: Total eligible ITC as per GSTR-2B for the Financial Year
  let itcAsPer2b8A = zeroItcMoney();
  for (const w of fyTwob) {
    if (String(w.itc_availability || 'Yes').trim().toUpperCase() === 'NO') continue;
    itcAsPer2b8A = addItcMoney(itcAsPer2b8A, {
      igst: r2(w.igst),
      cgst: r2(w.cgst),
      sgst: r2(w.sgst),
      cess: r2(w.cess),
    });
  }
  const itcAsPer6B6H_8B = addItcMoney(inwardInputs6B, reclaimed6H);

  // Table 8C & Table 13: ITC of current FY claimed in Next FY (Apr-Oct spillover window)
  let itcClaimedNextFy8C = zeroItcMoney();
  for (const b of input.books) {
    if (b.our_gstin && b.our_gstin !== gstin) continue;
    const invFy = fyOf((b.invoice_date || b.period || '').slice(0, 7));
    const claimMonth = b.itc_decision_month || '';
    if (invFy === fy && spilloverSet.has(claimMonth) && (!b.itc_decision || b.itc_decision === 'Claim')) {
      itcClaimedNextFy8C = addItcMoney(itcClaimedNextFy8C, {
        igst: r2(b.igst),
        cgst: r2(b.cgst),
        sgst: r2(b.sgst),
        cess: r2(b.cess),
      });
    }
  }

  const difference8D = subItcMoney(itcAsPer2b8A, addItcMoney(itcAsPer6B6H_8B, itcClaimedNextFy8C));
  const lapsed8K = { ...difference8D };

  return {
    gstin,
    legalName,
    fy,
    fp,
    table4: {
      b2c,
      b2b,
      expWp,
      sezWp,
      deemedExp,
      advances,
      inwardRcm,
      subTotal4H,
      creditNotes,
      debitNotes,
      amendmentsAdd,
      amendmentsSub,
      subTotal4M,
      totalTaxable4N,
    },
    table5: {
      expWop,
      sezWop,
      rcmOutward,
      exempted,
      nilRated,
      nonGst,
      subTotal5G,
      creditNotes: table5CreditNotes,
      debitNotes: table5DebitNotes,
      totalNonTaxable5M,
      totalTurnover5N,
    },
    table6: {
      auto3b6A,
      inwardInputs6B,
      rcmUnreg6C,
      rcmReg6D,
      importsGoods6E,
      importsServices6F,
      isd6G,
      reclaimed6H,
      subTotal6I,
      difference6J,
      totalAvailed6O,
    },
    table7: {
      rule37_7A,
      sec17_5_7E,
      otherReversals7H,
      totalReversed7I,
      netItcAvailable7J,
    },
    table8: {
      itcAsPer2b8A,
      itcAsPer6B6H_8B,
      itcClaimedNextFy8C,
      difference8D,
      availableNotAvailed8E,
      ineligible8F,
      lapsed8K,
    },
    table9: {
      taxPayable: taxPayable9,
      paidThroughItc: paidThroughItc9,
      paidInCash: paidInCash9,
      difference: subItcMoney(taxPayable9, addItcMoney(paidThroughItc9, paidInCash9)),
    },
    partV: {
      table10SuppliesAdd: zeroTaxMoney(),
      table11SuppliesSub: zeroTaxMoney(),
      table12ItcReversed: zeroItcMoney(),
      table13ItcAvailed: itcClaimedNextFy8C,
    },
    table17OutwardHsn: [...outwardHsnMap.values()].sort(
      (a, b) => (a.hsn || '').localeCompare(b.hsn || '') || a.rateOut - b.rateOut,
    ),
    table18InwardHsn: [...inwardHsnMap.values()].sort(
      (a, b) => (a.hsn || '').localeCompare(b.hsn || '') || a.rateOut - b.rateOut,
    ),
    monthlySummary,
  };
}

/**
 * Build GSTR-9C Audit Reconciliation Statement from a compiled GSTR-9 model.
 */
export function buildGstr9c(
  g9: Gstr9Model,
  opts: {
    auditedTurnover?: number;
    unbilledRevenue?: number;
    booksItcTotal?: number;
    sales?: SalesInvoice[];
  } = {},
): Gstr9cModel {
  const turnoverAsPerGstr9_5Q = g9.table5.totalTurnover5N;
  const turnoverAsPerBooks = r2(opts.auditedTurnover ?? turnoverAsPerGstr9_5Q);
  const unbilledRevenue = r2(opts.unbilledRevenue ?? 0);
  const annualTurnoverAdjusted5P = r2(turnoverAsPerBooks + unbilledRevenue);
  const unreconciledTurnover5R = r2(turnoverAsPerGstr9_5Q - annualTurnoverAdjusted5P);

  const exemptNilNonGst7B = r2(g9.table5.exempted + g9.table5.nilRated + g9.table5.nonGst);
  const zeroRatedWithoutTax7C = r2(g9.table5.expWop + g9.table5.sezWop);
  const rcmOutward7D = g9.table5.rcmOutward;
  const adjustedTaxableTurnover7E = r2(
    annualTurnoverAdjusted5P - exemptNilNonGst7B - zeroRatedWithoutTax7C - rcmOutward7D,
  );
  const taxableTurnoverGstr9_7F = r2(g9.table4.totalTaxable4N.taxable - g9.table4.inwardRcm.taxable);
  const unreconciledTaxable7G = r2(taxableTurnoverGstr9_7F - adjustedTaxableTurnover7E);

  // Table 9: Rate-wise tax liability
  const rateBuckets = new Map<number, { taxable: number; igst: number; cgst: number; sgst: number; cess: number }>();
  if (opts.sales && opts.sales.length > 0) {
    for (const s of opts.sales) {
      const t = r2(s.taxable_value);
      const tax = taxOf(s);
      if (tax === 0 && (s.invoice_type === 'NIL' || s.invoice_type === 'EXEMPT' || s.invoice_type === 'NONGST' || s.invoice_type === 'EXPWOP' || s.invoice_type === 'SEWOP')) {
        continue;
      }
      const rate = effectiveRate(t, tax, s.period);
      const b = rateBuckets.get(rate) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      b.taxable = r2(b.taxable + t);
      b.igst = r2(b.igst + r2(s.igst));
      b.cgst = r2(b.cgst + r2(s.cgst));
      b.sgst = r2(b.sgst + r2(s.sgst));
      b.cess = r2(b.cess + r2(s.cess));
      rateBuckets.set(rate, b);
    }
  }
  const byRate = [...rateBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, v]) => ({
      rate,
      ...v,
      totalTax: r2(v.igst + v.cgst + v.sgst + v.cess),
    }));

  const totalPayableAsPer9c_9P = g9.table9.taxPayable;
  const totalPaidAsPerGstr9_9Q = addItcMoney(g9.table9.paidThroughItc, g9.table9.paidInCash);
  const unreconciledTax9R = subItcMoney(totalPaidAsPerGstr9_9Q, totalPayableAsPer9c_9P);

  // Table 12: ITC Reconciliation
  const booksItcDefault = r2(g9.monthlySummary.reduce((a, m) => a + m.booksItc, 0));
  const itcAsPerBooks12A = r2(opts.booksItcTotal ?? booksItcDefault);
  const itcBookedInPrevFyClaimedNow12B = 0;
  const itcBookedNowClaimedNextFy12C = g9.table8.itcClaimedNextFy8C.total;
  const itcAvailedAsPerBooks12D = r2(
    itcAsPerBooks12A + itcBookedInPrevFyClaimedNow12B - itcBookedNowClaimedNextFy12C,
  );
  const itcClaimedInGstr9_12E = g9.table7.netItcAvailable7J.total;
  const unreconciledItc12F = r2(itcClaimedInGstr9_12E - itcAvailedAsPerBooks12D);

  return {
    gstin: g9.gstin,
    legalName: g9.legalName,
    fy: g9.fy,
    turnoverRecon: {
      turnoverAsPerBooks,
      unbilledRevenue,
      deemedSupply: 0,
      creditNotesNotInReturn: 0,
      annualTurnoverAdjusted5P,
      turnoverAsPerGstr9_5Q,
      unreconciledTurnover5R,
      exemptNilNonGst7B,
      zeroRatedWithoutTax7C,
      rcmOutward7D,
      adjustedTaxableTurnover7E,
      taxableTurnoverGstr9_7F,
      unreconciledTaxable7G,
    },
    taxLiabilityRecon: {
      byRate,
      rcmLiability: g9.table4.inwardRcm,
      totalPayableAsPer9c_9P,
      totalPaidAsPerGstr9_9Q,
      unreconciledTax9R,
    },
    itcRecon: {
      itcAsPerBooks12A,
      itcBookedInPrevFyClaimedNow12B,
      itcBookedNowClaimedNextFy12C,
      itcAvailedAsPerBooks12D,
      itcClaimedInGstr9_12E,
      unreconciledItc12F,
    },
  };
}

/**
 * Portal-compatible JSON representation of GSTR-9.
 */
export function gstr9PortalJson(g9: Gstr9Model): Record<string, unknown> {
  const tm = (x: TaxMoney) => ({
    txval: x.taxable,
    iamt: x.igst,
    camt: x.cgst,
    samt: x.sgst,
    csamt: x.cess,
  });
  const im = (x: ItcMoney) => ({
    iamt: x.igst,
    camt: x.cgst,
    samt: x.sgst,
    csamt: x.cess,
  });
  return {
    gstin: g9.gstin,
    fp: g9.fp,
    table4: {
      b2c: tm(g9.table4.b2c),
      b2b: tm(g9.table4.b2b),
      exp: tm(g9.table4.expWp),
      sez: tm(g9.table4.sezWp),
      deemed: tm(g9.table4.deemedExp),
      at: tm(g9.table4.advances),
      rchrg: tm(g9.table4.inwardRcm),
      sub_total_4a_4g: tm(g9.table4.subTotal4H),
      cr_nt: tm(g9.table4.creditNotes),
      dr_nt: tm(g9.table4.debitNotes),
      amd_pos: tm(g9.table4.amendmentsAdd),
      amd_neg: tm(g9.table4.amendmentsSub),
      sub_total_4i_4l: tm(g9.table4.subTotal4M),
      sup_adv: tm(g9.table4.totalTaxable4N),
    },
    table5: {
      zero_rtd: { txval: g9.table5.expWop },
      sez: { txval: g9.table5.sezWop },
      rchrg: { txval: g9.table5.rcmOutward },
      exmt: { txval: g9.table5.exempted },
      nil: { txval: g9.table5.nilRated },
      non_gst: { txval: g9.table5.nonGst },
      sub_total_5a_5f: { txval: g9.table5.subTotal5G },
      cr_nt: { txval: g9.table5.creditNotes },
      dr_nt: { txval: g9.table5.debitNotes },
      tot_to_no_tax: { txval: g9.table5.totalNonTaxable5M },
      total_to: { txval: g9.table5.totalTurnover5N },
    },
    table6: {
      itc_3b: im(g9.table6.auto3b6A),
      supp_non_rchrg: [{ itc_typ: 'ip', ...im(g9.table6.inwardInputs6B) }],
      supp_rchrg_unreg: [{ itc_typ: 'ip', ...im(g9.table6.rcmUnreg6C) }],
      supp_rchrg_reg: [{ itc_typ: 'ip', ...im(g9.table6.rcmReg6D) }],
      itc_clmd: im(g9.table6.reclaimed6H),
      sub_total_6b_6h: im(g9.table6.subTotal6I),
      diff: im(g9.table6.difference6J),
      tot_itc_availed: im(g9.table6.totalAvailed6O),
    },
    table7: {
      rule37: im(g9.table7.rule37_7A),
      sec17: im(g9.table7.sec17_5_7E),
      oth: im(g9.table7.otherReversals7H),
      tot_itc_revd: im(g9.table7.totalReversed7I),
      net_itc_aval: im(g9.table7.netItcAvailable7J),
    },
    table8: {
      itc_2b: im(g9.table8.itcAsPer2b8A),
      tot_itc_6b_6h: im(g9.table8.itcAsPer6B6H_8B),
      itc_inwd_supp: im(g9.table8.itcClaimedNextFy8C),
      diff: im(g9.table8.difference8D),
      itc_nt_avail: im(g9.table8.availableNotAvailed8E),
      itc_inelg: im(g9.table8.ineligible8F),
      tot_itc_lapsed: im(g9.table8.lapsed8K),
    },
    table9: {
      iamt: { txpyble: g9.table9.taxPayable.igst, txpaid_cash: g9.table9.paidInCash.igst, tax_paid_itc: g9.table9.paidThroughItc.igst },
      camt: { txpyble: g9.table9.taxPayable.cgst, txpaid_cash: g9.table9.paidInCash.cgst, tax_paid_itc: g9.table9.paidThroughItc.cgst },
      samt: { txpyble: g9.table9.taxPayable.sgst, txpaid_cash: g9.table9.paidInCash.sgst, tax_paid_itc: g9.table9.paidThroughItc.sgst },
      csamt: { txpyble: g9.table9.taxPayable.cess, txpaid_cash: g9.table9.paidInCash.cess, tax_paid_itc: g9.table9.paidThroughItc.cess },
    },
    table10: {
      dbn_amd: tm(g9.partV.table10SuppliesAdd),
      cdn_amd: tm(g9.partV.table11SuppliesSub),
      itc_rvsl: im(g9.partV.table12ItcReversed),
      itc_avail: im(g9.partV.table13ItcAvailed),
    },
    table17: {
      items: g9.table17OutwardHsn.map((h) => ({
        hsn_sc: h.hsn,
        desc: h.desc,
        uqc: h.uqc,
        qty: h.qty,
        rt: h.rateOut,
        txval: h.taxable,
        iamt: h.igst,
        camt: h.cgst,
        samt: h.sgst,
        csamt: h.cess,
      })),
    },
    table18: {
      items: g9.table18InwardHsn.map((h) => ({
        hsn_sc: h.hsn,
        desc: h.desc,
        uqc: h.uqc,
        qty: h.qty,
        rt: h.rateOut,
        txval: h.taxable,
        iamt: h.igst,
        camt: h.cgst,
        samt: h.sgst,
        csamt: h.cess,
      })),
    },
  };
}

/** Flat working-sheet rows for GSTR-9 Excel tab and UI grid. */
export interface Gstr9SheetRow {
  part: string;
  table: string;
  description: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  totalTax: number;
}

export function gstr9WorkingRows(g9: Gstr9Model): Gstr9SheetRow[] {
  const rows: Gstr9SheetRow[] = [];
  const pushTax = (part: string, table: string, description: string, m: TaxMoney) =>
    rows.push({
      part,
      table,
      description,
      taxable: m.taxable,
      igst: m.igst,
      cgst: m.cgst,
      sgst: m.sgst,
      cess: m.cess,
      totalTax: m.tax,
    });
  const pushVal = (part: string, table: string, description: string, taxable: number) =>
    rows.push({ part, table, description, taxable, igst: 0, cgst: 0, sgst: 0, cess: 0, totalTax: 0 });
  const pushItc = (part: string, table: string, description: string, m: ItcMoney) =>
    rows.push({
      part,
      table,
      description,
      taxable: 0,
      igst: m.igst,
      cgst: m.cgst,
      sgst: m.sgst,
      cess: m.cess,
      totalTax: m.total,
    });

  // Part II — Table 4
  pushTax('Part II', '4A', 'Supplies made to un-registered persons (B2C = B2CS + B2CL)', g9.table4.b2c);
  pushTax('Part II', '4B', 'Supplies made to registered persons (B2B)', g9.table4.b2b);
  pushTax('Part II', '4C', 'Zero rated supply (Export) on payment of tax (EXPWP)', g9.table4.expWp);
  pushTax('Part II', '4D', 'Supply to SEZ on payment of tax (SEZWP)', g9.table4.sezWp);
  pushTax('Part II', '4E', 'Deemed Exports (DE)', g9.table4.deemedExp);
  pushTax('Part II', '4G', 'Inward supplies on which tax is payable on Reverse Charge (RCM)', g9.table4.inwardRcm);
  pushTax('Part II', '4H', 'Sub-total (4A to 4G)', g9.table4.subTotal4H);
  pushTax('Part II', '4I', 'Credit notes issued in respect of 4B to 4E (-)', g9.table4.creditNotes);
  pushTax('Part II', '4J', 'Debit notes issued in respect of 4B to 4E (+)', g9.table4.debitNotes);
  pushTax('Part II', '4N', 'Supplies and advances on which tax is to be paid (4H + 4M)', g9.table4.totalTaxable4N);

  // Part II — Table 5
  pushVal('Part II', '5A', 'Zero rated supply (Export) without payment of tax (EXPWOP)', g9.table5.expWop);
  pushVal('Part II', '5B', 'Supply to SEZ without payment of tax (SEWOP)', g9.table5.sezWop);
  pushVal('Part II', '5D', 'Exempted outward supplies', g9.table5.exempted);
  pushVal('Part II', '5E', 'Nil Rated outward supplies', g9.table5.nilRated);
  pushVal('Part II', '5F', 'Non-GST supply (includes No Supply)', g9.table5.nonGst);
  pushVal('Part II', '5M', 'Turnover on which tax is not to be paid (5G - 5H + 5I)', g9.table5.totalNonTaxable5M);
  pushVal('Part II', '5N', 'Total Turnover (including advances) (4N + 5M - 4G)', g9.table5.totalTurnover5N);

  // Part III — Table 6, 7, 8
  pushItc('Part III', '6A', 'Total ITC availed through FORM GSTR-3B (sum of Table 4A)', g9.table6.auto3b6A);
  pushItc('Part III', '6B', 'Inward supplies (other than imports and RCM) — Inputs & Services', g9.table6.inwardInputs6B);
  pushItc('Part III', '6D', 'Inward supplies from registered persons liable to RCM', g9.table6.rcmReg6D);
  pushItc('Part III', '6H', 'Amount of ITC reclaimed under the provisions of the Act', g9.table6.reclaimed6H);
  pushItc('Part III', '6I', 'Sub-total (6B to 6H)', g9.table6.subTotal6I);
  pushItc('Part III', '6J', 'Difference (6I - 6A)', g9.table6.difference6J);
  pushItc('Part III', '6O', 'Total ITC availed', g9.table6.totalAvailed6O);

  pushItc('Part III', '7E', 'ITC Reversed — Section 17(5) / Blocked / 16(4) as per GSTR-3B 4(B)', g9.table7.sec17_5_7E);
  pushItc('Part III', '7I', 'Total ITC Reversed', g9.table7.totalReversed7I);
  pushItc('Part III', '7J', 'Net ITC Available for Utilization (6O - 7I)', g9.table7.netItcAvailable7J);

  pushItc('Part III', '8A', 'ITC as per GSTR-2B (Table 3 & 5 thereof)', g9.table8.itcAsPer2b8A);
  pushItc('Part III', '8B', 'ITC as per sum of 6B and 6H', g9.table8.itcAsPer6B6H_8B);
  pushItc('Part III', '8C', 'ITC on inward supplies received in FY but availed in Next FY (Apr-Oct)', g9.table8.itcClaimedNextFy8C);
  pushItc('Part III', '8D', 'Difference [8A - (8B + 8C)]', g9.table8.difference8D);
  pushItc('Part III', '8E', 'ITC available but not availed', g9.table8.availableNotAvailed8E);
  pushItc('Part III', '8F', 'ITC available but ineligible', g9.table8.ineligible8F);
  pushItc('Part III', '8K', 'Total ITC to be lapsed in current financial year', g9.table8.lapsed8K);

  // Part IV — Table 9
  pushItc('Part IV', '9 (Payable)', 'Total Tax Payable', g9.table9.taxPayable);
  pushItc('Part IV', '9 (Paid ITC)', 'Paid through ITC', g9.table9.paidThroughItc);
  pushItc('Part IV', '9 (Paid Cash)', 'Paid in Cash', g9.table9.paidInCash);
  pushItc('Part IV', '9 (Diff)', 'Differential Tax (Payable - Paid)', g9.table9.difference);

  // Part V — Spillover
  pushItc('Part V', '13', 'ITC availed for the previous financial year in Next FY (Apr-Oct)', g9.partV.table13ItcAvailed);

  return rows;
}

export function gstr9cWorkingRows(g9c: Gstr9cModel): Array<{ table: string; description: string; amount: number }> {
  return [
    { table: '5A', description: 'Turnover (including exports) as per audited financial statements / books', amount: g9c.turnoverRecon.turnoverAsPerBooks },
    { table: '5P', description: 'Annual turnover after adjustments', amount: g9c.turnoverRecon.annualTurnoverAdjusted5P },
    { table: '5Q', description: 'Turnover as declared in Annual Return (GSTR-9 Table 5N)', amount: g9c.turnoverRecon.turnoverAsPerGstr9_5Q },
    { table: '5R', description: 'Un-reconciled turnover (5Q - 5P)', amount: g9c.turnoverRecon.unreconciledTurnover5R },
    { table: '7B', description: 'Less: Value of Exempt, Nil-rated, Non-GST supplies', amount: g9c.turnoverRecon.exemptNilNonGst7B },
    { table: '7C', description: 'Less: Zero-rated supplies made without payment of tax', amount: g9c.turnoverRecon.zeroRatedWithoutTax7C },
    { table: '7E', description: 'Taxable turnover as per adjustments above', amount: g9c.turnoverRecon.adjustedTaxableTurnover7E },
    { table: '7F', description: 'Taxable turnover as per Table (4N - 4G) of GSTR-9', amount: g9c.turnoverRecon.taxableTurnoverGstr9_7F },
    { table: '7G', description: 'Un-reconciled taxable turnover (7F - 7E)', amount: g9c.turnoverRecon.unreconciledTaxable7G },
    { table: '9P', description: 'Total amount of tax payable as per GSTR-9C', amount: g9c.taxLiabilityRecon.totalPayableAsPer9c_9P.total },
    { table: '9Q', description: 'Total amount of tax paid as declared in GSTR-9', amount: g9c.taxLiabilityRecon.totalPaidAsPerGstr9_9Q.total },
    { table: '9R', description: 'Un-reconciled payment of tax (9Q - 9P)', amount: g9c.taxLiabilityRecon.unreconciledTax9R.total },
    { table: '12A', description: 'ITC availed as per audited financial statements / purchase books', amount: g9c.itcRecon.itcAsPerBooks12A },
    { table: '12C', description: 'Less: ITC booked in current FY to be claimed in subsequent FY (Table 8C/13)', amount: g9c.itcRecon.itcBookedNowClaimedNextFy12C },
    { table: '12D', description: 'ITC availed as per financial statements (12A + 12B - 12C)', amount: g9c.itcRecon.itcAvailedAsPerBooks12D },
    { table: '12E', description: 'ITC claimed in Annual Return (GSTR-9 Table 7J)', amount: g9c.itcRecon.itcClaimedInGstr9_12E },
    { table: '12F', description: 'Un-reconciled ITC (12E - 12D)', amount: g9c.itcRecon.unreconciledItc12F },
  ];
}
