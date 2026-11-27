/**
 * GST Control ERP — Phase 6: GSTR-3B Table 4 Readiness & Strict Manual ITC Control.
 *
 * Strictly reuses `buildGstr3b()` from `src/engine/gstr3b.ts` (ZERO duplicate
 * ITC calculation engine). Never auto-claims, auto-reverses, auto-reclaims,
 * or auto-modifies Books Month, GSTR-2B Month, ITC Decision Month, or ITC Claim Month.
 */

import XLSX from 'xlsx';
import { fyOf, isoDate, labelOf, normDocType, normGstin, r2, type ReconRow } from '../engine/core';
import { buildGstr3b, type Gstr3bTable4, type TaxBreakup5 } from '../engine/gstr3b';
import { isLocked, withClient } from './store';
import { polishWorkbook } from './xlsx-format';

export type ItcReversalType = 'SEC_17_5_BLOCKED' | 'OTHER_TEMPORARY';

const ALLOWED_ITC_DECISIONS = new Set([
  'Claim',
  'Reclaim Later',
  'Ineligible',
  'Reversed',
  'Do Not Claim',
  'Query Vendor',
  'Pending Review',
]);

const ALLOWED_REVERSAL_TYPES = new Set<ItcReversalType>([
  'SEC_17_5_BLOCKED',
  'OTHER_TEMPORARY',
]);

export interface ReclaimHeadAmounts {
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  total: number;
}

/**
 * Allocate `reclaimAmount` proportionally across remaining tax heads using
 * integer-paise Hamilton (largest-remainder) rounding so that:
 *   - each head is >= 0 and <= remaining head balance
 *   - r2(igst + cgst + sgst + utgst + cess) === r2(reclaimAmount) EXACTLY
 */
export function allocateReclaimProportional(
  remaining: { igst: number; cgst: number; sgst: number; utgst: number; cess: number },
  reclaimAmount: number,
): ReclaimHeadAmounts {
  const keys = ['igst', 'cgst', 'sgst', 'utgst', 'cess'] as const;
  const remPaise = keys.map((k) => Math.max(0, Math.round(Math.abs(r2(remaining[k])) * 100)));
  const totalRemPaise = remPaise.reduce((a, b) => a + b, 0);
  const targetPaise = Math.max(0, Math.round(r2(reclaimAmount) * 100));

  if (totalRemPaise === 0 || targetPaise === 0) {
    return { igst: 0, cgst: 0, sgst: 0, utgst: 0, cess: 0, total: 0 };
  }
  if (targetPaise >= totalRemPaise) {
    const out = {
      igst: r2(remPaise[0] / 100),
      cgst: r2(remPaise[1] / 100),
      sgst: r2(remPaise[2] / 100),
      utgst: r2(remPaise[3] / 100),
      cess: r2(remPaise[4] / 100),
      total: r2(totalRemPaise / 100),
    };
    return out;
  }

  const exact = remPaise.map((rp) => (rp * targetPaise) / totalRemPaise);
  const alloc = exact.map((e, idx) => Math.min(remPaise[idx], Math.floor(e)));
  let leftover = targetPaise - alloc.reduce((a, b) => a + b, 0);

  // Distribute remaining paise to heads with largest fractional remainder & spare capacity
  const order = keys
    .map((_, idx) => ({ idx, frac: exact[idx] - Math.floor(exact[idx]), cap: remPaise[idx] - alloc[idx] }))
    .sort((a, b) => b.frac - a.frac || b.cap - a.cap || a.idx - b.idx);

  for (const item of order) {
    if (leftover <= 0) break;
    if (alloc[item.idx] < remPaise[item.idx]) {
      alloc[item.idx] += 1;
      leftover -= 1;
    }
  }
  // Safety pass if any paise remain due to caps
  for (let idx = 0; idx < keys.length && leftover > 0; idx++) {
    const room = remPaise[idx] - alloc[idx];
    if (room > 0) {
      const add = Math.min(room, leftover);
      alloc[idx] += add;
      leftover -= add;
    }
  }

  const igst = r2(alloc[0] / 100);
  const cgst = r2(alloc[1] / 100);
  const sgst = r2(alloc[2] / 100);
  const utgst = r2(alloc[3] / 100);
  const cess = r2(alloc[4] / 100);
  return { igst, cgst, sgst, utgst, cess, total: r2(igst + cgst + sgst + utgst + cess) };
}

export interface ManualItcControlInput {
  decision?: 'Claim' | 'Reclaim Later' | 'Ineligible' | 'Reversed' | 'Do Not Claim' | 'Query Vendor' | 'Pending Review';
  decisionMonth?: string | null;
  claimMonth?: string | null;
  reversalType?: ItcReversalType | null;
  returnClassification?: string | null;
  isImpg?: boolean;
  isRcm?: boolean;
  reason: string;
}

export interface ManualItcReclaimInput {
  reclaimMonth: string;
  reclaimAmount?: number;
  reason: string;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Strictly manual ITC control decision.
 * Requires explicit `changedBy` and non-empty `reason`; refuses locked months;
 * keeps Books Month (`period`), 2B Month (`matched_2b_month`), `itc_decision_month`,
 * and `itc_claim_month` strictly separate; logs full before/after audit trail.
 */
export async function recordManualItcDecision(
  lineId: number,
  input: ManualItcControlInput,
  opts: { changedBy: string },
): Promise<{ ok: boolean; reason?: string; locked?: boolean; changed: string[] }> {
  const reason = String(input.reason || '').trim();
  if (!reason) return { ok: false, reason: 'A mandatory reason is required for every manual ITC control decision.', changed: [] };
  if (input.decision !== undefined && !ALLOWED_ITC_DECISIONS.has(String(input.decision))) {
    return { ok: false, reason: `Invalid ITC decision "${input.decision}". Allowed: ${[...ALLOWED_ITC_DECISIONS].join(', ')}.`, changed: [] };
  }
  if (input.reversalType !== undefined && input.reversalType !== null && !ALLOWED_REVERSAL_TYPES.has(input.reversalType)) {
    return { ok: false, reason: `Invalid itc_reversal_type "${input.reversalType}". Allowed: ${[...ALLOWED_REVERSAL_TYPES].join(', ')}.`, changed: [] };
  }
  if (input.decisionMonth && !PERIOD_RE.test(input.decisionMonth)) {
    return { ok: false, reason: 'decisionMonth must be YYYY-MM.', changed: [] };
  }
  if (input.claimMonth && !PERIOD_RE.test(input.claimMonth)) {
    return { ok: false, reason: 'claimMonth must be YYYY-MM.', changed: [] };
  }

  return withClient(async (c) => {
    const existingRes = await c.query(`SELECT * FROM purchase_lines WHERE id = $1`, [lineId]);
    const old = existingRes.rows[0];
    if (!old) return { ok: false, reason: `Purchase line ${lineId} not found.`, changed: [] };

    // Mutual exclusivity check: IMPG (4A1) and RCM (4A3) cannot both be true
    const nextImpg = input.isImpg !== undefined ? Boolean(input.isImpg) : Boolean(old.is_impg);
    const nextRcm = input.isRcm !== undefined ? Boolean(input.isRcm) : Boolean(old.is_rcm);
    if (nextImpg && nextRcm) {
      return { ok: false, reason: 'IMPG (Table 4(A)(1)) and RCM (Table 4(A)(3)) are mutually exclusive and cannot both be set on the same invoice.', changed: [] };
    }

    // Check locks on ALL relevant months: original Books Month, target/prior claimMonth, target/prior decisionMonth
    const monthsToCheck = new Set<string>();
    if (old.period) monthsToCheck.add(String(old.period));
    if (input.claimMonth) monthsToCheck.add(String(input.claimMonth));
    if (input.claimMonth !== undefined && old.itc_claim_month && old.itc_claim_month !== input.claimMonth) {
      monthsToCheck.add(String(old.itc_claim_month));
    }
    if (input.decisionMonth) monthsToCheck.add(String(input.decisionMonth));
    if (input.decisionMonth !== undefined && old.itc_decision_month && old.itc_decision_month !== input.decisionMonth) {
      monthsToCheck.add(String(old.itc_decision_month));
    }

    for (const m of monthsToCheck) {
      const lk = await isLocked(old.our_gstin, m);
      if (lk.locked) {
        return { ok: false, locked: true, reason: `Month ${m} for ${old.our_gstin} is LOCKED.`, changed: [] };
      }
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    const auditDiffs: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];
    const setField = (col: string, nextVal: unknown, prevVal: unknown) => {
      const pStr = prevVal === null || prevVal === undefined ? null : String(prevVal);
      const nStr = nextVal === null || nextVal === undefined ? null : String(nextVal);
      if (pStr === nStr) return;
      params.push(nextVal);
      updates.push(`${col} = $${params.length}`);
      auditDiffs.push({ field: col, oldVal: pStr, newVal: nStr });
    };

    if (input.decision !== undefined) setField('itc_decision', input.decision, old.itc_decision);
    if (input.decisionMonth !== undefined) setField('itc_decision_month', input.decisionMonth || null, old.itc_decision_month);
    if (input.claimMonth !== undefined) {
      setField('itc_claim_month', input.claimMonth || null, old.itc_claim_month);
      params.push(input.claimMonth ? fyOf(input.claimMonth) : null);
      updates.push(`itc_claim_fy = $${params.length}`);
    }
    if (input.reversalType !== undefined) setField('itc_reversal_type', input.reversalType || null, old.itc_reversal_type);
    if (input.returnClassification !== undefined) setField('return_classification', input.returnClassification || null, old.return_classification);
    if (input.isImpg !== undefined) setField('is_impg', Boolean(input.isImpg), Boolean(old.is_impg));
    if (input.isRcm !== undefined) setField('is_rcm', Boolean(input.isRcm), Boolean(old.is_rcm));

    if (!auditDiffs.length) {
      return { ok: true, changed: [] };
    }

    await c.query('BEGIN');
    try {
      params.push(opts.changedBy || 'unknown', reason, lineId);
      await c.query(
        `UPDATE purchase_lines
            SET ${updates.join(', ')},
                decision_by = $${params.length - 2},
                decision_at = now(),
                decision_reason = $${params.length - 1},
                updated_at = now()
          WHERE id = $${params.length}`,
        params,
      );

      for (const d of auditDiffs) {
        await c.query(
          `INSERT INTO recon_corrections (line_id, field_name, old_value, new_value, reason, changed_by, rerefreshed)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [lineId, d.field, d.oldVal ?? '', d.newVal ?? '', reason, opts.changedBy || 'unknown'],
        );
      }

      await c.query(
        `INSERT INTO audit_trail (changed_by, action, our_gstin, financial_year, period, reason, details)
         VALUES ($1, 'MANUAL_ITC_CONTROL', $2, $3, $4, $5, $6)`,
        [
          opts.changedBy || 'unknown',
          old.our_gstin,
          fyOf(old.period),
          old.period,
          reason,
          JSON.stringify({ lineId, changes: auditDiffs }),
        ],
      );

      await c.query('COMMIT');
      return { ok: true, changed: auditDiffs.map((d) => d.field) };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Strictly manual reclaim of a previously reversed (4(B)(2) temporary reversal)
 * ITC line into Table 4(D)(1) of a subsequent return period.
 * Blocks reclaiming Section 17(5) permanent blocked credits!
 */
export async function recordManualItcReclaim(
  lineId: number,
  input: ManualItcReclaimInput,
  opts: { changedBy: string },
): Promise<{
  ok: boolean;
  reason?: string;
  locked?: boolean;
  reclaimEntry?: {
    reclaimMonth: string;
    reclaimAmount: number;
    igst: number;
    cgst: number;
    sgst: number;
    utgst: number;
    cess: number;
    cumulativeReclaimed: number;
    remainingBalance: number;
  };
}> {
  const reason = String(input.reason || '').trim();
  if (!reason) return { ok: false, reason: 'A mandatory reason is required to reclaim ITC in Table 4(D)(1).' };
  if (!PERIOD_RE.test(input.reclaimMonth)) return { ok: false, reason: 'reclaimMonth must be YYYY-MM.' };

  return withClient(async (c) => {
    const res = await c.query(`SELECT * FROM purchase_lines WHERE id = $1`, [lineId]);
    const old = res.rows[0];
    if (!old) return { ok: false, reason: `Purchase line ${lineId} not found.` };

    const lk = await isLocked(old.our_gstin, input.reclaimMonth);
    if (lk.locked) return { ok: false, locked: true, reason: `Target reclaim month ${input.reclaimMonth} is LOCKED.` };

    if (old.itc_reversal_type === 'SEC_17_5_BLOCKED' || old.itc_decision === 'Ineligible' || old.match_status === 'ITC Blocked') {
      return { ok: false, reason: 'Section 17(5) permanently blocked ITC (Table 4(B)(1)) CANNOT be reclaimed in Table 4(D)(1).' };
    }
    if (old.itc_decision !== 'Reversed' && old.itc_reversal_type !== 'OTHER_TEMPORARY') {
      return { ok: false, reason: 'Only ITC previously reversed under Table 4(B)(2) (Reversed / OTHER_TEMPORARY) can be reclaimed.' };
    }

    const baseMonth = String(old.itc_decision_month || old.period || '');
    if (baseMonth && input.reclaimMonth <= baseMonth) {
      return { ok: false, reason: `Reclaim month (${input.reclaimMonth}) must be subsequent to reversal/books month (${baseMonth}).` };
    }

    const origHeads = {
      igst: Math.abs(r2(Number(old.twob_igst ?? old.book_igst ?? 0))),
      cgst: Math.abs(r2(Number(old.twob_cgst ?? old.book_cgst ?? 0))),
      sgst: Math.abs(r2(Number(old.twob_sgst ?? old.book_sgst ?? 0))),
      utgst: Math.abs(r2(Number(old.twob_utgst ?? old.book_utgst ?? 0))),
      cess: Math.abs(r2(Number(old.twob_cess ?? old.book_cess ?? 0))),
    };
    const originalReversedTax = r2(origHeads.igst + origHeads.cgst + origHeads.sgst + origHeads.utgst + origHeads.cess);

    // Load prior reclaim tranches for this invoice
    const priorRes = await c.query(
      `SELECT reclaim_month, reclaim_amount, reclaim_igst, reclaim_cgst, reclaim_sgst, reclaim_utgst, reclaim_cess
         FROM itc_reclaim_entries
        WHERE line_id = $1
        ORDER BY id ASC`,
      [lineId],
    );
    const priorRows = priorRes.rows as any[];

    // Duplicate check: same month already reclaimed
    if (priorRows.some((p) => String(p.reclaim_month) === input.reclaimMonth)) {
      return {
        ok: false,
        reason: `Duplicate reclaim blocked: this invoice already has a reclaim entry in ${input.reclaimMonth}.`,
      };
    }

    let priorIg = 0, priorCg = 0, priorSg = 0, priorUt = 0, priorCe = 0, priorTot = 0;
    if (priorRows.length > 0) {
      for (const p of priorRows) {
        priorIg = r2(priorIg + Number(p.reclaim_igst || 0));
        priorCg = r2(priorCg + Number(p.reclaim_cgst || 0));
        priorSg = r2(priorSg + Number(p.reclaim_sgst || 0));
        priorUt = r2(priorUt + Number(p.reclaim_utgst || 0));
        priorCe = r2(priorCe + Number(p.reclaim_cess || 0));
        priorTot = r2(priorTot + Number(p.reclaim_amount || 0));
      }
    } else if (old.itc_reclaimed) {
      // Legacy full reclaim recorded prior to Migration 33
      priorIg = origHeads.igst;
      priorCg = origHeads.cgst;
      priorSg = origHeads.sgst;
      priorUt = origHeads.utgst;
      priorCe = origHeads.cess;
      priorTot = originalReversedTax;
    }

    const remHeads = {
      igst: r2(Math.max(0, origHeads.igst - priorIg)),
      cgst: r2(Math.max(0, origHeads.cgst - priorCg)),
      sgst: r2(Math.max(0, origHeads.sgst - priorSg)),
      utgst: r2(Math.max(0, origHeads.utgst - priorUt)),
      cess: r2(Math.max(0, origHeads.cess - priorCe)),
    };
    const remainingBalance = r2(remHeads.igst + remHeads.cgst + remHeads.sgst + remHeads.utgst + remHeads.cess);

    if (remainingBalance <= 0.005) {
      return {
        ok: false,
        reason: `Duplicate reclaim blocked: full reversed ITC (${originalReversedTax}) was already reclaimed in ${old.itc_reclaim_month || 'earlier period(s)'}.`,
      };
    }

    let requestedAmt = remainingBalance;
    if (input.reclaimAmount !== undefined && input.reclaimAmount !== null) {
      if (!Number.isFinite(input.reclaimAmount) || input.reclaimAmount <= 0) {
        return { ok: false, reason: 'reclaimAmount must be a positive number.' };
      }
      if (r2(input.reclaimAmount) > r2(remainingBalance) + 0.005) {
        return {
          ok: false,
          reason:
            priorTot > 0
              ? `Reclaim amount (${r2(input.reclaimAmount)}) exceeds remaining reclaimable balance (${remainingBalance}; original reversed ITC: ${originalReversedTax}).`
              : `Reclaim amount (${r2(input.reclaimAmount)}) exceeds original reversed ITC (${originalReversedTax}).`,
        };
      }
      requestedAmt = r2(input.reclaimAmount);
    }

    const alloc = allocateReclaimProportional(remHeads, requestedAmt);
    const cumIg = r2(priorIg + alloc.igst);
    const cumCg = r2(priorCg + alloc.cgst);
    const cumSg = r2(priorSg + alloc.sgst);
    const cumUt = r2(priorUt + alloc.utgst);
    const cumCe = r2(priorCe + alloc.cess);
    const cumTot = r2(cumIg + cumCg + cumSg + cumUt + cumCe);
    const remainingAfter = r2(Math.max(0, originalReversedTax - cumTot));

    await c.query('BEGIN');
    try {
      await c.query(
        `INSERT INTO itc_reclaim_entries (
           line_id, our_gstin, reclaim_month, reclaim_fy,
           reclaim_amount, reclaim_igst, reclaim_cgst, reclaim_sgst, reclaim_utgst, reclaim_cess,
           remaining_after, reason, reclaimed_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          lineId, old.our_gstin, input.reclaimMonth, fyOf(input.reclaimMonth),
          alloc.total, alloc.igst, alloc.cgst, alloc.sgst, alloc.utgst, alloc.cess,
          remainingAfter, reason, opts.changedBy || 'unknown',
        ],
      );

      await c.query(
        `UPDATE purchase_lines
            SET itc_reclaimed = true,
                itc_reclaim_month = $1,
                itc_reclaim_amount = $2,
                itc_reclaim_igst = $3,
                itc_reclaim_cgst = $4,
                itc_reclaim_sgst = $5,
                itc_reclaim_utgst = $6,
                itc_reclaim_cess = $7,
                itc_reclaim_reason = $8,
                itc_reclaimed_by = $9,
                itc_reclaimed_at = now(),
                updated_at = now()
          WHERE id = $10`,
        [
          input.reclaimMonth, cumTot, cumIg, cumCg, cumSg, cumUt, cumCe,
          reason, opts.changedBy || 'unknown', lineId,
        ],
      );

      await c.query(
        `INSERT INTO recon_corrections (line_id, field_name, old_value, new_value, reason, changed_by, rerefreshed)
         VALUES ($1, 'itc_reclaimed', $2, 'true', $3, $4, true),
                ($1, 'itc_reclaim_month', $5, $6, $3, $4, true),
                ($1, 'itc_reclaim_amount', $7, $8, $3, $4, true)`,
        [
          lineId,
          String(Boolean(old.itc_reclaimed)),
          reason,
          opts.changedBy || 'unknown',
          old.itc_reclaim_month ?? '',
          input.reclaimMonth,
          String(priorTot),
          String(cumTot),
        ],
      );

      await c.query(
        `INSERT INTO audit_trail (changed_by, action, our_gstin, financial_year, period, reason, details)
         VALUES ($1, 'MANUAL_ITC_RECLAIM', $2, $3, $4, $5, $6)`,
        [
          opts.changedBy || 'unknown',
          old.our_gstin,
          fyOf(input.reclaimMonth),
          input.reclaimMonth,
          reason,
          JSON.stringify({
            lineId,
            originalPeriod: old.period,
            reclaimMonth: input.reclaimMonth,
            tranche: alloc,
            cumulativeReclaimed: cumTot,
            remainingBalance: remainingAfter,
          }),
        ],
      );

      await c.query('COMMIT');
      return {
        ok: true,
        reclaimEntry: {
          reclaimMonth: input.reclaimMonth,
          reclaimAmount: alloc.total,
          igst: alloc.igst,
          cgst: alloc.cgst,
          sgst: alloc.sgst,
          utgst: alloc.utgst,
          cess: alloc.cess,
          cumulativeReclaimed: cumTot,
          remainingBalance: remainingAfter,
        },
      };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

export interface Gstr3bTable4DetailRow {
  lineId: number;
  ourGstin: string;
  booksMonth: string;
  twobMonth: string;
  decisionMonth: string;
  claimMonth: string;
  reclaimMonth: string;
  supplierGstin: string;
  supplierName: string;
  docNo: string;
  docDate: string;
  docType: string;
  table4Bucket: string;
  igst: number;
  cgst: number;
  sgst: number;
  utgst: number;
  cess: number;
  totalTax: number;
  itcDecision: string;
  reversalType: string;
  isImpg: boolean;
  isRcm: boolean;
  originalReversalAmount: number;
  cumulativeReclaimed: number;
  remainingBalance: number;
  decisionBy: string;
  decisionReason: string;
  sourceFile: string;
}

export interface Gstr3bTable4Report {
  gstin: string;
  period: string;
  periodLabel: string;
  financialYear: string;
  table4: Gstr3bTable4;
  reconciliation: {
    matched_rows: number;
    amount_mismatch_rows: number;
    missing_in_2b_rows: number;
    duplicate_rows: number;
    blocked_rows: number;
    pending_4ai: number;
  };
  details: Gstr3bTable4DetailRow[];
  parityOk: boolean;
  parityErrors: string[];
}

export async function buildGstr3bTable4ReportFromDb(opts: {
  gstin: string;
  period: string;
}): Promise<Gstr3bTable4Report> {
  const gstin = normGstin(opts.gstin);
  const period = String(opts.period || '').trim();

  return withClient(async (c) => {
    // 1. Load rows belonging to this GSTIN & return period (Books Month or explicit Claim Month)
    const res = await c.query(
      `SELECT p.*,
              (SELECT gl.doc_category FROM gstr2b_lines gl
                WHERE gl.our_gstin = p.our_gstin AND gl.line_key = p.matched_2b_key LIMIT 1) AS matched_doc_cat
         FROM purchase_lines p
        WHERE p.our_gstin = $1
          AND COALESCE(p.itc_claim_month, p.period) = $2
        ORDER BY p.period, p.id`,
      [gstin, period],
    );

    // 2. Load persisted reclaim tranches for this GSTIN & period (`itc_reclaim_entries`),
    //    plus fallback for any legacy `purchase_lines` reclaimed before Migration 33.
    const recRes = await c.query(
      `SELECT p.*,
              e.reclaim_month AS entry_reclaim_month,
              e.reclaim_amount AS entry_reclaim_amount,
              e.reclaim_igst AS entry_reclaim_igst,
              e.reclaim_cgst AS entry_reclaim_cgst,
              e.reclaim_sgst AS entry_reclaim_sgst,
              e.reclaim_utgst AS entry_reclaim_utgst,
              e.reclaim_cess AS entry_reclaim_cess,
              e.reason AS entry_reclaim_reason,
              e.reclaimed_by AS entry_reclaimed_by,
              (SELECT gl.doc_category FROM gstr2b_lines gl
                WHERE gl.our_gstin = p.our_gstin AND gl.line_key = p.matched_2b_key LIMIT 1) AS matched_doc_cat
         FROM itc_reclaim_entries e
         JOIN purchase_lines p ON p.id = e.line_id
        WHERE e.our_gstin = $1
          AND e.reclaim_month = $2
        ORDER BY p.period, e.id`,
      [gstin, period],
    );

    const legacyRecRes = await c.query(
      `SELECT p.*,
              (SELECT gl.doc_category FROM gstr2b_lines gl
                WHERE gl.our_gstin = p.our_gstin AND gl.line_key = p.matched_2b_key LIMIT 1) AS matched_doc_cat
         FROM purchase_lines p
        WHERE p.our_gstin = $1
          AND p.itc_reclaimed = true
          AND p.itc_reclaim_month = $2
          AND COALESCE(p.itc_claim_month, p.period) <> $2
          AND NOT EXISTS (SELECT 1 FROM itc_reclaim_entries e WHERE e.line_id = p.id)
        ORDER BY p.period, p.id`,
      [gstin, period],
    );

    const reconRows: ReconRow[] = [];
    const details: Gstr3bTable4DetailRow[] = [];

    const combinedRows: Array<{ r: any; isReclaimEntry: boolean }> = [
      ...(res.rows as any[]).map((r) => ({ r, isReclaimEntry: false })),
      ...(recRes.rows as any[]).map((r) => ({ r, isReclaimEntry: true })),
      ...(legacyRecRes.rows as any[]).map((r) => ({ r, isReclaimEntry: true })),
    ];

    for (const { r, isReclaimEntry } of combinedRows) {
      const docCat = String(r.matched_doc_cat || '').toUpperCase();
      const isImpg = Boolean(r.is_impg || docCat === 'IMPG' || docCat === 'IMPGA' || docCat === 'IMPGSEZ');
      const isRcm = Boolean(r.is_rcm || r.reverse_charge);

      const ig = isReclaimEntry && r.entry_reclaim_igst !== undefined
        ? r2(Number(r.entry_reclaim_igst || 0))
        : r2(Number(r.twob_igst ?? r.book_igst ?? 0));
      const cg = isReclaimEntry && r.entry_reclaim_cgst !== undefined
        ? r2(Number(r.entry_reclaim_cgst || 0))
        : r2(Number(r.twob_cgst ?? r.book_cgst ?? 0));
      const sg = isReclaimEntry && r.entry_reclaim_sgst !== undefined
        ? r2(Number(r.entry_reclaim_sgst || 0))
        : r2(Number(r.twob_sgst ?? r.book_sgst ?? 0));
      const ut = isReclaimEntry && r.entry_reclaim_utgst !== undefined
        ? r2(Number(r.entry_reclaim_utgst || 0))
        : r2(Number(r.twob_utgst ?? r.book_utgst ?? 0));
      const ce = isReclaimEntry && r.entry_reclaim_cess !== undefined
        ? r2(Number(r.entry_reclaim_cess || 0))
        : r2(Number(r.twob_cess ?? r.book_cess ?? 0));
      const tot = r2(ig + cg + sg + ut + ce);

      const row: ReconRow = {
        book_line_id: String(r.id),
        our_gstin: gstin,
        party_name: String(r.party_name || ''),
        supplier_gstin: normGstin(r.recon_supplier_gstin || r.book_supplier_gstin),
        invoice_no: String(r.recon_invoice_no || r.book_invoice_no || ''),
        invoice_date: r.book_invoice_date ? isoDate(r.book_invoice_date) : '',
        period: String(r.period || ''),
        document_type: normDocType(r.book_document_type || 'Tax Invoice'),
        taxable_value: r2(Number(r.book_taxable_value || 0)),
        igst: r2(Number(r.book_igst || 0)),
        cgst: r2(Number(r.book_cgst || 0)),
        sgst: r2(Number(r.book_sgst || 0)),
        utgst: r2(Number(r.book_utgst || 0)),
        cess: r2(Number(r.book_cess || 0)),
        itc: r2(Number(r.book_igst || 0) + Number(r.book_cgst || 0) + Number(r.book_sgst || 0) + Number(r.book_utgst || 0) + Number(r.book_cess || 0)),
        status: (r.match_status || 'Missing in 2B') as any,
        matched_2b_id: r.matched_2b_key || undefined,
        matched_2b_month: r.matched_2b_month || undefined,
        two_b_taxable: r.twob_taxable_value !== null && r.twob_taxable_value !== undefined ? r2(Number(r.twob_taxable_value)) : undefined,
        two_b_igst: isReclaimEntry ? ig : (r.twob_igst !== null && r.twob_igst !== undefined ? r2(Number(r.twob_igst)) : undefined),
        two_b_cgst: isReclaimEntry ? cg : (r.twob_cgst !== null && r.twob_cgst !== undefined ? r2(Number(r.twob_cgst)) : undefined),
        two_b_sgst: isReclaimEntry ? sg : (r.twob_sgst !== null && r.twob_sgst !== undefined ? r2(Number(r.twob_sgst)) : undefined),
        two_b_utgst: isReclaimEntry ? ut : (r.twob_utgst !== null && r.twob_utgst !== undefined ? r2(Number(r.twob_utgst)) : undefined),
        two_b_cess: isReclaimEntry ? ce : (r.twob_cess !== null && r.twob_cess !== undefined ? r2(Number(r.twob_cess)) : undefined),
        two_b_itc: isReclaimEntry ? tot : (r.twob_itc !== null && r.twob_itc !== undefined ? r2(Number(r.twob_itc)) : undefined),
        doc_category: docCat || undefined,
        is_impg: isImpg,
        reverse_charge: isRcm,
        itc_decision: isReclaimEntry ? 'Claim' : (r.itc_decision || undefined),
        itc_decision_month: r.itc_decision_month || undefined,
        itc_claim_month: r.itc_claim_month || undefined,
        itc_reversal_type: r.itc_reversal_type || undefined,
        itc_reclaimed: isReclaimEntry,
        itc_reclaim_month: isReclaimEntry ? String(r.entry_reclaim_month || r.itc_reclaim_month || period) : (r.itc_reclaim_month || undefined),
        return_classification: isReclaimEntry ? '4(D)(1) — Reclaimed' : (r.return_classification || undefined),
        source_file: String(r.source_file || ''),
      };
      reconRows.push(row);

      let bucket = 'Pending / Excluded';
      if (isReclaimEntry) bucket = '4(D)(1) — Reclaimed ITC';
      else if (r.match_status === 'Duplicate') bucket = 'Excluded (Duplicate)';
      else if (r.itc_decision === 'Ineligible' || r.itc_reversal_type === 'SEC_17_5_BLOCKED' || r.match_status === 'ITC Blocked') bucket = '4(B)(1) — Sec 17(5) Blocked';
      else if (r.itc_decision === 'Reversed' || r.itc_reversal_type === 'OTHER_TEMPORARY') bucket = '4(B)(2) — Other Reversal';
      else if (r.itc_decision === 'Do Not Claim' || r.itc_decision === 'Reclaim Later' || r.itc_decision === 'Query Vendor') bucket = 'Deferred / Hold';
      else if (r.match_status === 'Missing in 2B' && r.itc_decision !== 'Claim') bucket = '4A(i) — Missing in 2B';
      else if (isImpg) bucket = '4(A)(1) — Import of Goods (IMPG)';
      else if (isRcm) bucket = '4(A)(3) — Reverse Charge (RCM)';
      else bucket = '4(A)(5) — All Other ITC';

      const origTaxAbs = r2(
        Math.abs(Number(r.twob_igst ?? r.book_igst ?? 0)) +
        Math.abs(Number(r.twob_cgst ?? r.book_cgst ?? 0)) +
        Math.abs(Number(r.twob_sgst ?? r.book_sgst ?? 0)) +
        Math.abs(Number(r.twob_utgst ?? r.book_utgst ?? 0)) +
        Math.abs(Number(r.twob_cess ?? r.book_cess ?? 0)),
      );
      const is4B2Reversal = (r.itc_decision === 'Reversed' || r.itc_reversal_type === 'OTHER_TEMPORARY')
        && r.itc_reversal_type !== 'SEC_17_5_BLOCKED'
        && r.itc_decision !== 'Ineligible'
        && r.match_status !== 'ITC Blocked';
      const origRevAmt = is4B2Reversal ? origTaxAbs : 0;
      const cumRecAmt = is4B2Reversal
        ? (r.itc_reclaim_amount !== null && r.itc_reclaim_amount !== undefined
            ? r2(Number(r.itc_reclaim_amount))
            : (r.itc_reclaimed ? origTaxAbs : 0))
        : 0;
      const remBalAmt = is4B2Reversal ? r2(Math.max(0, origRevAmt - cumRecAmt)) : 0;

      details.push({
        lineId: Number(r.id),
        ourGstin: gstin,
        booksMonth: String(r.period || ''),
        twobMonth: String(r.matched_2b_month || ''),
        decisionMonth: String(r.itc_decision_month || ''),
        claimMonth: String(r.itc_claim_month || ''),
        reclaimMonth: String(isReclaimEntry ? (r.entry_reclaim_month || r.itc_reclaim_month || period) : (r.itc_reclaim_month || '')),
        supplierGstin: normGstin(r.book_supplier_gstin),
        supplierName: String(r.party_name || ''),
        docNo: String(r.book_invoice_no || ''),
        docDate: r.book_invoice_date ? isoDate(r.book_invoice_date) : '',
        docType: normDocType(r.book_document_type || 'Tax Invoice'),
        table4Bucket: bucket,
        igst: ig,
        cgst: cg,
        sgst: sg,
        utgst: ut,
        cess: ce,
        totalTax: tot,
        itcDecision: String(r.itc_decision || 'Pending Review'),
        reversalType: String(r.itc_reversal_type || ''),
        isImpg,
        isRcm,
        originalReversalAmount: origRevAmt,
        cumulativeReclaimed: cumRecAmt,
        remainingBalance: remBalAmt,
        decisionBy: String(isReclaimEntry ? (r.entry_reclaimed_by || r.itc_reclaimed_by || '') : (r.decision_by || '')),
        decisionReason: String(isReclaimEntry ? (r.entry_reclaim_reason || r.itc_reclaim_reason || '') : (r.decision_reason || '')),
        sourceFile: String(r.source_file || ''),
      });
    }

    const g3b = buildGstr3b({ gstin, period, reconRows, sales: [] });
    const t4 = g3b.table4;

    const parityErrors: string[] = [];
    const eq = (a: number, b: number) => Math.abs(r2(a) - r2(b)) <= 0.01;
    if (!eq(t4.table4A1_impg.total + t4.table4A3_rcm.total + t4.table4A5_allOther.total, t4.table4A_total.total)) {
      parityErrors.push('4(A)(1) + 4(A)(3) + 4(A)(5) != 4(A) Total');
    }
    if (!eq(t4.table4B1_sec17_5.total + t4.table4B2_otherReversal.total, t4.table4B_total.total)) {
      parityErrors.push('4(B)(1) + 4(B)(2) != 4(B) Total');
    }
    if (!eq(t4.table4A_total.total - t4.table4B_total.total, t4.table4C_netItc.total)) {
      parityErrors.push('4(A) Total - 4(B) Total != 4(C) Net ITC');
    }
    const checkHead = (h: keyof TaxBreakup5) => {
      if (!eq(t4.table4A_total[h] - t4.table4B_total[h], t4.table4C_netItc[h])) {
        parityErrors.push(`4(C) ${h} mismatch`);
      }
    };
    (['igst', 'cgst', 'sgst', 'utgst', 'cess'] as Array<keyof TaxBreakup5>).forEach(checkHead);

    return {
      gstin,
      period,
      periodLabel: labelOf(period),
      financialYear: fyOf(period),
      table4: t4,
      reconciliation: g3b.reconciliation,
      details,
      parityOk: parityErrors.length === 0,
      parityErrors,
    };
  });
}

export function exportGstr3bTable4Workbook(report: Gstr3bTable4Report): Buffer {
  const wb = XLSX.utils.book_new();
  const t = report.table4;
  const row = (code: string, desc: string, b: TaxBreakup5) => ({
    'Table 4 Row': code,
    Description: desc,
    IGST: b.igst,
    CGST: b.cgst,
    SGST: b.sgst,
    UTGST: b.utgst,
    Cess: b.cess,
    'Total Tax': b.total,
  });

  const summaryRows = [
    row('4(A)(1)', 'Import of Goods (IMPG)', t.table4A1_impg),
    row('4(A)(3)', 'Inward supplies liable to Reverse Charge (RCM)', t.table4A3_rcm),
    row('4(A)(5)', 'All other eligible ITC', t.table4A5_allOther),
    row('4(A) Total', 'Total ITC Available (4A1 + 4A3 + 4A5)', t.table4A_total),
    row('4(B)(1)', 'ITC Reversed — Section 17(5) Blocked (Permanent)', t.table4B1_sec17_5),
    row('4(B)(2)', 'ITC Reversed — Others (Temporary / Reclaimable)', t.table4B2_otherReversal),
    row('4(B) Total', 'Total ITC Reversed (4B1 + 4B2)', t.table4B_total),
    row('4(C)', 'Net ITC Available (4A Total - 4B Total)', t.table4C_netItc),
    row('4(D)(1)', 'ITC Reclaimed (previously reversed under 4(B)(2))', t.table4D1_reclaimed),
    row('4(D)(2)', 'Ineligible / Sec 16(4) Time-Barred Memo', t.table4D2_ineligible),
  ];

  const detailRows = report.details.map((d) => ({
    'Line ID': d.lineId,
    'Our GSTIN': d.ourGstin,
    'Books Month': d.booksMonth,
    'Actual 2B Month': d.twobMonth,
    'ITC Decision Month': d.decisionMonth,
    'ITC Claim Month': d.claimMonth,
    'ITC Reclaim Month': d.reclaimMonth,
    'Supplier GSTIN': d.supplierGstin,
    'Supplier Name': d.supplierName,
    'Document No': d.docNo,
    'Document Date': d.docDate,
    'Document Type': d.docType,
    'GSTR-3B Table 4 Bucket': d.table4Bucket,
    IGST: d.igst,
    CGST: d.cgst,
    SGST: d.sgst,
    UTGST: d.utgst,
    Cess: d.cess,
    'Total Tax': d.totalTax,
    'ITC Decision': d.itcDecision,
    'Decision By': d.decisionBy,
    'Decision Reason': d.decisionReason,
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'GSTR-3B Table 4 Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ Info: 'No invoice lines' }]), 'Table 4 Invoice Working');
  return polishWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}
