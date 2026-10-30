/**
 * GST ERP — Invoice Management System (IMS) Action Builder.
 *
 * Maps GSTR-2B vs Books reconciliation outcomes and human ITC decisions into
 * the GST Portal's three IMS actions:
 *   - Accept  : Invoice verified in books; flows into GSTR-2B & GSTR-3B 4(A).
 *   - Reject  : Blocked / Ineligible / Not belonging to us / Sec 16(4) barred.
 *   - Pending : Held for future period (Reclaim Later / Query Vendor / Unbooked in books / Amount Mismatch).
 */

import { r2, type ReconRow } from './core';

export type ImsAction = 'Accept' | 'Reject' | 'Pending';

export interface ImsRow {
  our_gstin: string;
  supplier_gstin: string;
  supplier_name: string;
  invoice_no: string;
  invoice_date: string;
  document_type: string;
  period: string;
  twob_month: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total_itc: number;
  recon_status: string;
  itc_decision: string;
  ims_action: ImsAction;
  ims_remark: string;
}

export interface ImsReport {
  rows: ImsRow[];
  summary: {
    total_rows: number;
    accept_count: number;
    accept_itc: number;
    reject_count: number;
    reject_itc: number;
    pending_count: number;
    pending_itc: number;
  };
}

export function decideImsAction(r: ReconRow): { action: ImsAction; remark: string } {
  const cls = (r.return_classification || '').trim();
  const dec = (r.itc_decision || '').trim();

  if (r.sec16_4_barred) {
    return {
      action: 'Reject',
      remark: 'Section 16(4) time-barred (claimed after 30 Nov / Oct return of next FY)',
    };
  }

  if (cls && cls !== 'Pending Review') {
    if (cls === '4(A) — Claimed') return { action: 'Accept', remark: 'Classified as 4(A) — Claimed' };
    if (cls === '4(B) — Blocked' || cls === 'Ineligible') {
      return { action: 'Reject', remark: `Classified as ${cls}` };
    }
    if (cls === 'Not in 3B — Carried' || cls === '4(A)(i) — Books only') {
      return { action: 'Pending', remark: `Carried forward (${cls})` };
    }
  }

  if (dec && dec !== 'Pending Review') {
    if (dec === 'Claim') return { action: 'Accept', remark: 'Approved for ITC claim' };
    if (dec === 'Do Not Claim' || dec === 'Ineligible' || dec === 'Reversed') {
      return { action: 'Reject', remark: `Decision: ${dec}` };
    }
    if (dec === 'Reclaim Later' || dec === 'Query Vendor') {
      return { action: 'Pending', remark: `Held on IMS (${dec})` };
    }
  }

  switch (r.status) {
    case 'Matched':
      return { action: 'Accept', remark: 'Matched with purchase register' };
    case 'ITC Blocked':
      return { action: 'Reject', remark: r.reason || 'Portal 2B marked ITC unavailable' };
    case 'Amount Mismatch':
      return { action: 'Pending', remark: 'Amount mismatch between books and 2B — verify with vendor' };
    case 'Missing in Books':
      return { action: 'Pending', remark: 'In GSTR-2B but not yet booked in purchase register' };
    default:
      return { action: 'Pending', remark: r.action || 'Pending review' };
  }
}

export function buildImsActions(reconRows: ReconRow[], unbooked2b: ReconRow[] = []): ImsReport {
  const rows: ImsRow[] = [];
  let accept_count = 0;
  let accept_itc = 0;
  let reject_count = 0;
  let reject_itc = 0;
  let pending_count = 0;
  let pending_itc = 0;

  // Include book rows that have a 2B counterpart, plus unbooked 2B rows
  const portalBacked = [
    ...reconRows.filter((r) => r.status === 'Matched' || r.status === 'Amount Mismatch' || r.status === 'ITC Blocked'),
    ...unbooked2b,
  ];

  for (const r of portalBacked) {
    const { action, remark } = decideImsAction(r);
    const total_itc = r2(r.two_b_itc ?? r.itc);
    const taxable = r2(r.two_b_taxable ?? r.taxable_value);
    const igst = r2(r.two_b_igst ?? r.igst);
    const cgst = r2(r.two_b_cgst ?? r.cgst);
    const sgst = r2(r.two_b_sgst ?? r.sgst);
    const cess = r2(r.two_b_cess ?? r.cess);

    if (action === 'Accept') {
      accept_count++;
      accept_itc = r2(accept_itc + total_itc);
    } else if (action === 'Reject') {
      reject_count++;
      reject_itc = r2(reject_itc + total_itc);
    } else {
      pending_count++;
      pending_itc = r2(pending_itc + total_itc);
    }

    rows.push({
      our_gstin: r.our_gstin,
      supplier_gstin: r.supplier_gstin,
      supplier_name: r.party_name,
      invoice_no: r.invoice_no,
      invoice_date: r.invoice_date,
      document_type: r.document_type || 'Tax Invoice',
      period: r.period,
      twob_month: r.matched_2b_month || r.period,
      taxable_value: taxable,
      igst,
      cgst,
      sgst,
      cess,
      total_itc,
      recon_status: r.status,
      itc_decision: r.itc_decision || 'Pending Review',
      ims_action: action,
      ims_remark: remark,
    });
  }

  return {
    rows,
    summary: {
      total_rows: rows.length,
      accept_count,
      accept_itc,
      reject_count,
      reject_itc,
      pending_count,
      pending_itc,
    },
  };
}

