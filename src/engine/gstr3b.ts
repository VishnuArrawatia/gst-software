/**
 * GST ERP — GSTR-3B builder.
 *
 * Produces two things from the same model:
 *   1. a working view  — every table as flat rows, so the CA can read it and
 *      spot-check it against the portal;
 *   2. the portal JSON — the shape the GST portal's offline utility accepts.
 *
 * IMPORTANT SOURCING RULE
 *   Input tax credit is taken from the RECONCILED GSTR-2B view, never from the
 *   purchase books alone. Under cl.16(2)(b) credit is available only for invoices
 *   the supplier actually reported, and cl.16(4) blocks it where the portal has
 *   marked it unavailable. Books-only invoices are NOT silently added to 4(A) —
 *   they are reported separately as a 4A(i) declaration memo, because that is
 *   the only route by which they can still be claimed.
 */

import {
  effectiveRate,
  fyOf,
  labelOf,
  r2,
  taxOf,
  type GstInvoiceForReturn,
  type ReconRow,
} from './core';

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

export interface OutwardTotals {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Grouped by effective rate — feeds the 3.1(a) rate breakdown. */
  byRate: Array<{ rate: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>;
}

export interface ItcDetailRow {
  txnType: 'R' | 'IS' | 'DE' | 'DN' | 'O';
  /** 'Yes' when the credit is traceable to the supplier's invoice. */
  availableFromInvoice: 'Yes' | 'No';
  eligible: number;
  availed: number;
  notAvailed: number;
  reason?: string;
}

export interface Gstr3bModel {
  gstin: string;
  legalName?: string;
  period: string;
  periodLabel: string;
  financialYear: string;

  // 3.1 outward supplies
  outward: OutwardTotals;
  /**
   * The outward amounts that sit outside 3.1(a). The form's own numbering is:
   *   (b) outward taxable supplies (zero rated),
   *   (c) other outward supplies (nil rated, exempted),
   *   (d) inward supplies liable to reverse charge,
   *   (e) non-GST outward supplies.
   * 3.1(d) is not produced here — reverse charge inward supplies are not
   * modelled — so it is reported as zero rather than guessed.
   */
  exempt: number;
  nonGst: number;
  zeroRated: number;
  /** 3.1(d) Inward supplies liable to reverse charge. */
  inwardRcm: {
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    tax: number;
  };
  /** 4(A)(3) ITC on inward supplies liable to reverse charge. */
  rcmItc: number;
  /** Component-wise ITC summary for GSTR-3B and GSTR-9. */
  itcByTax: {
    available: { igst: number; cgst: number; sgst: number; cess: number };
    reversed: { igst: number; cgst: number; sgst: number; cess: number };
    net: { igst: number; cgst: number; sgst: number; cess: number };
  };

  // 3.2 inward
  inwardTaxable: number;
  inwardIgst: number;
  inwardCgst: number;
  inwardSgst: number;
  inwardCess: number;

  // table 4
  itcAvailable: number;
  itcReversed: number;
  itcAvailed: number;
  /** Table 5 — ISD and other credits, not in scope for these entities yet. */
  itcOther: number;

  // reconciliation provenance, so the CA can see where every rupee came from
  reconciliation: {
    matched_rows: number;
    amount_mismatch_rows: number;
    missing_in_2b_rows: number;
    duplicate_rows: number;
    blocked_rows: number;
    /** ITC sitting in the books with no 2B support — needs a 4A(i) declaration. */
    pending_4ai: number;
  };

  // derived
  totalItcAvailed: number;
  totalOutputTax: number;
  taxPayable: number;
  itcUtilised: number;
  cashPayable: number;
  /** ITC that could not be used this month and rolls to the next period. */
  itcCarryForward: number;
}

export interface Build3bInput {
  gstin: string;
  legalName?: string;
  period: string;
  /** Reconciled purchase rows for THIS gstin and THIS period. */
  reconRows: ReconRow[];
  /** Sales invoices for THIS gstin and THIS period. */
  sales: GstInvoiceForReturn[];
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/** Group outward invoices into a rate-wise summary. */
function summariseOutward(sales: GstInvoiceForReturn[]): OutwardTotals {
  const byRate = new Map<number, { taxable: number; igst: number; cgst: number; sgst: number; cess: number }>();
  let taxable = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let cess = 0;

  for (const s of sales) {
    const t = r2(s.taxable_value);
    const rate = effectiveRate(t, taxOf(s));
    if (!byRate.has(rate)) byRate.set(rate, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    const g = byRate.get(rate)!;
    g.taxable = r2(g.taxable + t);
    g.igst = r2(g.igst + r2(s.igst));
    g.cgst = r2(g.cgst + r2(s.cgst));
    g.sgst = r2(g.sgst + r2(s.sgst));
    g.cess = r2(g.cess + r2(s.cess));

    taxable = r2(taxable + t);
    igst = r2(igst + r2(s.igst));
    cgst = r2(cgst + r2(s.cgst));
    sgst = r2(sgst + r2(s.sgst));
    cess = r2(cess + r2(s.cess));
  }

  return {
    taxable,
    igst,
    cgst,
    sgst,
    cess,
    byRate: [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, v]) => ({ rate, ...v })),
  };
}

/**
 * Decide how much ITC each reconciled row contributes to table 4(A).
 *
 * Only rows the portal actually support count. `Amount Mismatch` rows DO count
 * — at the 2B amount, not the books amount, because that is what the portal
 * will accept.
 */
export function itcDetailFromRecon(rows: ReconRow[]): {
  available: ItcDetailRow;
  reversed: ItcDetailRow;
  pending4ai: number;
  counts: Gstr3bModel['reconciliation'];
} {
  let availableAmount = 0;
  let reversedAmount = 0;
  let pending4ai = 0;

  const counts = {
    matched_rows: 0,
    amount_mismatch_rows: 0,
    missing_in_2b_rows: 0,
    duplicate_rows: 0,
    blocked_rows: 0,
    pending_4ai: 0,
  };

  for (const r of rows) {
    switch (r.status) {
      case 'Matched':
        counts.matched_rows++;
        break;
      case 'Amount Mismatch':
        counts.amount_mismatch_rows++;
        break;
      case 'ITC Blocked':
        counts.blocked_rows++;
        break;
      case 'Duplicate':
        counts.duplicate_rows++;
        break;
      case 'Missing in 2B':
      default:
        counts.missing_in_2b_rows++;
        break;
    }

    const rowItc = r.two_b_itc ?? r.itc;
    const cls = (r.return_classification || '').trim();
    const dec = (r.itc_decision || '').trim();

    if (cls && cls !== 'Pending Review') {
      if (cls === '4(A) — Claimed') {
        availableAmount = r2(availableAmount + rowItc);
      } else if (cls === '4(A)(i) — Books only') {
        pending4ai = r2(pending4ai + r.itc);
      } else if (cls === '4(B) — Blocked' || cls === 'Ineligible') {
        reversedAmount = r2(reversedAmount + rowItc);
      }
      // 'Not in 3B — Carried' contributes neither to 4(A) nor to 4(B) this period.
      continue;
    }

    if (dec && dec !== 'Pending Review') {
      if (dec === 'Claim') {
        availableAmount = r2(availableAmount + rowItc);
      } else if (dec === 'Ineligible' || dec === 'Reversed') {
        reversedAmount = r2(reversedAmount + rowItc);
      } else if (dec === 'Reclaim Later' || dec === 'Query Vendor') {
        if (r.status === 'Missing in 2B') pending4ai = r2(pending4ai + r.itc);
      }
      // 'Do Not Claim' contributes nothing to 4(A), 4(B) or 4A(i).
      continue;
    }

    switch (r.status) {
      case 'Matched':
      case 'Amount Mismatch':
        // The portal is the authority on the claimable amount.
        availableAmount = r2(availableAmount + rowItc);
        break;

      case 'ITC Blocked':
        // cl.16(4) — the portal says the credit is unavailable. Report it in 4(B).
        reversedAmount = r2(reversedAmount + rowItc);
        break;

      case 'Duplicate':
        // A duplicate booking would double-claim, so nothing goes to 4(A).
        break;

      case 'Missing in 2B':
      default:
        // In the books, unsupported by GSTR-2B. Claimable only via a 4A(i)
        // declaration, which is why it is excluded from 4(A) here.
        pending4ai = r2(pending4ai + r.itc);
        break;
    }
  }

  counts.pending_4ai = pending4ai;

  return {
    available: {
      txnType: 'R',
      availableFromInvoice: 'Yes',
      eligible: availableAmount,
      availed: availableAmount,
      notAvailed: 0,
    },
    reversed: {
      txnType: 'R',
      availableFromInvoice: 'Yes',
      eligible: reversedAmount,
      availed: 0,
      notAvailed: reversedAmount,
      reason: '16(4) — ITC unavailable as per GSTR-2B',
    },
    pending4ai,
    counts,
  };
}

export function buildGstr3b(input: Build3bInput): Gstr3bModel {
  const { gstin, period } = input;

  const outward = summariseOutward(input.sales);

  // A zero-rated supply is an export or a supply to an SEZ, which the books
  // mark with these invoice types and on which no tax is charged.
  const isZeroRatedSupply = (s: GstInvoiceForReturn): boolean =>
    s.invoice_type === 'SEZWP' ||
    s.invoice_type === 'SEWOP' ||
    s.invoice_type === 'DE' ||
    s.invoice_type === 'EXPWP' ||
    s.invoice_type === 'EXPWOP';

  const zeroRated = r2(
    input.sales.filter(isZeroRatedSupply).reduce((a, s) => a + r2(s.taxable_value), 0)
  );

  // 3.1(c) is nil rated PLUS exempt. A zero-rated supply also carries no tax, so
  // it must be excluded here: without this the same export was counted in both
  // 3.1(b) and 3.1(c) and the two rows together overstated outward supplies by
  // the full value of every export.
  const exempt = r2(
    input.sales
      .filter((s) => r2(s.taxable_value) !== 0 && taxOf(s) === 0 && !isZeroRatedSupply(s) && s.invoice_type !== 'NONGST')
      .reduce((a, s) => a + r2(s.taxable_value), 0)
  );

  const itc = itcDetailFromRecon(input.reconRows);

  // Inward taxable is the 2B taxable for supported lines, plus books taxable for
  // lines awaiting a 4A(i) declaration (reported, not claimed).
  const inwardTaxable = r2(input.reconRows.reduce((a, r) => a + r2(r.taxable_value), 0));
  const rcmRows = input.reconRows.filter((r) => r.reverse_charge && r.status !== 'Duplicate');
  const inwardRcm = {
    taxable: r2(rcmRows.reduce((a, r) => a + r2(r.two_b_taxable ?? r.taxable_value), 0)),
    igst: r2(rcmRows.reduce((a, r) => a + r2(r.two_b_igst ?? r.igst), 0)),
    cgst: r2(rcmRows.reduce((a, r) => a + r2(r.two_b_cgst ?? r.cgst), 0)),
    sgst: r2(rcmRows.reduce((a, r) => a + r2(r.two_b_sgst ?? r.sgst), 0)),
    cess: r2(rcmRows.reduce((a, r) => a + r2(r.two_b_cess ?? r.cess), 0)),
    tax: 0,
  };
  inwardRcm.tax = r2(inwardRcm.igst + inwardRcm.cgst + inwardRcm.sgst + inwardRcm.cess);
  const rcmItc = r2(
    rcmRows
      .filter((r) => r.status !== 'ITC Blocked' && r.itc_decision !== 'Do Not Claim' && r.itc_decision !== 'Ineligible')
      .reduce((a, r) => a + r2(r.two_b_itc ?? r.itc), 0),
  );
  const availByTax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const revByTax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const r of input.reconRows) {
    const ig = r2(r.two_b_igst ?? r.igst);
    const cg = r2(r.two_b_cgst ?? r.cgst);
    const sg = r2(r.two_b_sgst ?? r.sgst);
    const ce = r2(r.two_b_cess ?? r.cess);
    const cls = (r.return_classification || '').trim();
    const dec = (r.itc_decision || '').trim();
    let kind: 'avail' | 'rev' | 'none' = 'none';
    if (cls && cls !== 'Pending Review') {
      if (cls === '4(A) — Claimed') kind = 'avail';
      else if (cls === '4(B) — Blocked' || cls === 'Ineligible') kind = 'rev';
    } else if (dec && dec !== 'Pending Review') {
      if (dec === 'Claim') kind = 'avail';
      else if (dec === 'Ineligible' || dec === 'Reversed') kind = 'rev';
    } else if (r.status === 'Matched' || r.status === 'Amount Mismatch') {
      kind = 'avail';
    } else if (r.status === 'ITC Blocked') {
      kind = 'rev';
    }
    if (kind === 'avail') {
      availByTax.igst = r2(availByTax.igst + ig);
      availByTax.cgst = r2(availByTax.cgst + cg);
      availByTax.sgst = r2(availByTax.sgst + sg);
      availByTax.cess = r2(availByTax.cess + ce);
    } else if (kind === 'rev') {
      revByTax.igst = r2(revByTax.igst + ig);
      revByTax.cgst = r2(revByTax.cgst + cg);
      revByTax.sgst = r2(revByTax.sgst + sg);
      revByTax.cess = r2(revByTax.cess + ce);
    }
  }
  const itcByTax = {
    available: availByTax,
    reversed: revByTax,
    net: {
      igst: r2(availByTax.igst - revByTax.igst),
      cgst: r2(availByTax.cgst - revByTax.cgst),
      sgst: r2(availByTax.sgst - revByTax.sgst),
      cess: r2(availByTax.cess - revByTax.cess),
    },
  };
  const inwardIgst = r2(input.reconRows.reduce((a, r) => a + r2(r.two_b_itc !== undefined ? r2(r.igst) : 0), 0));
  const inwardCgst = r2(input.reconRows.reduce((a, r) => a + r2(r.two_b_itc !== undefined ? r2(r.cgst) : 0), 0));
  const inwardSgst = r2(input.reconRows.reduce((a, r) => a + r2(r.two_b_itc !== undefined ? r2(r.sgst) : 0), 0));
  const inwardCess = r2(input.reconRows.reduce((a, r) => a + r2(r.two_b_itc !== undefined ? r2(r.cess) : 0), 0));

  const itcAvailable = r2(itc.available.availed);
  const itcReversed = r2(itc.reversed.notAvailed);
  // Table 4(C) is 4(A) MINUS 4(B): the portal nets reversals off the credit
  // that was available. Adding the two treated blocked credit as though it were
  // claimable, which understated the tax payable and overstated the credit
  // carried forward by the whole blocked amount.
  const itcAvailed = r2(itcAvailable - itcReversed);
  const itcOther = 0;

  const businessOutput = r2(outward.igst + outward.cgst + outward.sgst + outward.cess);
  const totalOutputTax = businessOutput;
  const totalItcAvailed = r2(itcAvailed + itcOther);
  // Negative means an excess-credit month: nothing is utilised and nothing is
  // paid, the balance simply carries forward.
  const taxPayable = r2(totalOutputTax - totalItcAvailed);
  const itcUtilised = taxPayable > 0 ? r2(Math.min(totalItcAvailed, taxPayable)) : 0;
  const cashPayable = taxPayable > 0 ? r2(totalOutputTax - itcUtilised) : 0;
  const itcCarryForward = r2(totalItcAvailed - itcUtilised);

  return {
    gstin,
    legalName: input.legalName,
    period,
    periodLabel: labelOf(period),
    financialYear: fyOf(period),
    outward,
    exempt,
    nonGst: r2(
      input.sales
        .filter((s) => s.invoice_type === 'NONGST')
        .reduce((a, s) => a + r2(s.taxable_value), 0)
    ),
    zeroRated,
    inwardRcm,
    rcmItc,
    itcByTax,
    inwardTaxable,
    inwardIgst,
    inwardCgst,
    inwardSgst,
    inwardCess,
    itcAvailable,
    itcReversed,
    itcAvailed,
    itcOther,
    reconciliation: itc.counts,
    totalItcAvailed,
    totalOutputTax,
    taxPayable,
    itcUtilised,
    cashPayable,
    itcCarryForward,
  };
}

// ---------------------------------------------------------------------------
// working sheet — flat rows, CA-friendly
// ---------------------------------------------------------------------------

export interface SheetRow {
  section: string;
  table: string;
  description: string;
  rate?: number;
  value: number;
}

/** Flatten the model into rows that read like the on-screen 3B table. */
export function gstr3bWorkingRows(m: Gstr3bModel): SheetRow[] {
  const R: SheetRow[] = [];
  const push = (section: string, table: string, description: string, value: number, rate?: number) =>
    R.push({ section, table, description, value: r2(value), rate });

  push('3.1(a)', '3.1(a)', 'Outward taxable supplies', m.outward.taxable);
  for (const g of m.outward.byRate) {
    push('3.1(a)', '3.1(a)', `  of which @ ${g.rate}%`, g.taxable, g.rate);
  }
  push('3.1(a)', '3.1(a)', 'Integrated tax (IGST)', m.outward.igst);
  push('3.1(a)', '3.1(a)', 'Central tax (CGST)', m.outward.cgst);
  push('3.1(a)', '3.1(a)', 'State/UT tax (SGST)', m.outward.sgst);
  push('3.1(a)', '3.1(a)', 'Cess', m.outward.cess);

  // The form's 3.1 rows, in the order the portal shows them. 3.1(c) is one
  // amount — nil rated and exempt together — and 3.1(d) is inward supplies
  // liable to reverse charge, which this application does not produce, so it is
  // reported as zero instead of being pointed at an outward figure.
  push('3.1(b)', '3.1(b)', 'Outward taxable supplies (zero rated)', m.zeroRated);
  push('3.1(c)', '3.1(c)', 'Other outward supplies (nil rated, exempted)', m.exempt);
  push('3.1(d)', '3.1(d)', 'Inward supplies liable to reverse charge', m.inwardRcm.taxable);
  push('3.1(e)', '3.1(e)', 'Non-GST outward supplies', m.nonGst);

  push('3.2', '3.2', 'ITC on inward supplies (registered)', m.inwardTaxable);
  push('3.2', '3.2', '  IGST component', m.inwardIgst);
  push('3.2', '3.2', '  CGST component', m.inwardCgst);
  push('3.2', '3.2', '  SGST component', m.inwardSgst);
  push('3.2', '3.2', '  Cess component', m.inwardCess);

  push('4(A)', '4(A)', 'ITC available', m.itcAvailable);
  push('4(B)', '4(B)', 'ITC reversed (blocked / 16(4))', m.itcReversed);
  push('4(C)', '4(C)', 'Net ITC available (4A - 4B)', m.itcAvailed);
  push('4(D)', '4(D)', 'Other ITC — ISD / reclaimed / ineligible (not produced)', m.itcOther);

  // These are computed totals, not portal lines. Labelling them 5 / 6 / 7 would
  // send the CA to a row of the form that does not carry that figure — 5 is
  // exempt/nil inward supplies, 5.1 interest and 5.2 late fee — so they are
  // named, not numbered.
  push('Computed', 'Total ITC availed', 'Net credit taken this month', m.totalItcAvailed);
  push('Computed', 'Total ITC eligible', 'Credit eligible for set-off', r2(m.itcAvailable + m.itcOther));

  // Table 6.1 — payment of tax.
  push('6.1', '6.1', 'Output tax payable', m.totalOutputTax);
  push('6.1', '6.1', 'Discharged through ITC', m.itcUtilised);
  push('6.1', '6.1', 'Discharged in cash', m.cashPayable);
  push('Memo', 'Memo', 'ITC carried forward to next period', m.itcCarryForward);

  if (m.reconciliation.pending_4ai > 0) {
    push('Memo', '4A(i)', 'ITC in books without GSTR-2B support — declare here', m.reconciliation.pending_4ai);
  }

  return R;
}

// ---------------------------------------------------------------------------
// portal JSON — GST portal offline utility shape
// ---------------------------------------------------------------------------

/**
 * Build the GSTR-3B JSON the portal's offline utility accepts.
 *
 * `hash` is the MD5 the portal expects for offline validation. The caller must
 * inject it (`GST3B_<gstin>_<fp>_<version>_<hash>`); we cannot know it without a
 * GSTIN login, so it is left null here and the CLI fills it in.
 */
export function gstr3bPortalJson(m: Gstr3bModel, itc: ItcDetailRow, itcRev: ItcDetailRow, hash = null): unknown {
  const fp = m.period.replace('-', '');
  const itcDet = [
    {
      txnType: itc.txnType,
      avlItcFrMscr: itc.availableFromInvoice,
      itcEligible: itc.eligible,
      itcAvlb: itc.availed,
      itcNtAvlb: itc.notAvailed,
    },
  ];
  const revItcDet =
    itcRev.notAvailed > 0
      ? [
          {
            txnType: itcRev.txnType,
            avlItcFrMscr: itcRev.availableFromInvoice,
            itcEligible: itcRev.eligible,
            itcAvlb: itcRev.availed,
            itcNtAvlb: itcRev.notAvailed,
            rsn: 'ITC not available as per GSTR-2B (cl.16(4))',
          },
        ]
      : [];

  return {
    gstin: m.gstin,
    fp,
    taxPeriod: m.period,
    version: 'GST3B.1',
    hash,
    b2b: [],
    b2cl: [],
    b2cs: [],
    cdnr: [],
    exp: [],
    'nil/non-gst': m.exempt > 0 ? [{ sply_ty: 'B2B-WDNA', typ: 'EXEMPT', nil_amt: m.exempt, itm_amt: 0 }] : [],
    itcAvailDet: { itcDet, revDet: revItcDet, revRsn: [], othrRsn: [] },
    itcRedDet: { revRsn: [], othrRsn: [] },
    itcAvail: m.itcAvailable,
    itcRev: m.itcReversed,
    itcNtAvail: m.itcReversed,
    itcReedmDet: { csdAmdItmDet: [], csdItmDet: [], isdItmDet: [], othrItmDet: [] },
    itcReedm: 0,
    itcNtReedm: 0,
    itcCash: 0,
    utiCdf: [],
    utiCsh: [],
    utiItc: [],
    utiTcs: [],
    availSetOff: 'Y',
  };
}
