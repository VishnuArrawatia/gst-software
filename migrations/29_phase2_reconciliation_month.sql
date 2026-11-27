-- Phase 2: Cross-Month & Cross-FY Reconciliation Control
-- Strictly additive migration: records the month in which a match was established
-- (`reconciliation_month`) separately from Original Books Month (`period`),
-- Actual GSTR-2B Month (`matched_2b_month`), and ITC Claim Month (`itc_decision_month`).
-- Never alters book_* columns, existing transaction values, or itc_decision_month.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS reconciliation_month VARCHAR(7);

-- Backfill reconciliation_month for already-matched rows as GREATEST(period, matched_2b_month)
-- (e.g., Books=2026-11 matched against 2B=2026-04 -> reconciled in 2026-11;
--        Books=2026-03 matched against 2B=2026-04 -> reconciled in 2026-04).
UPDATE purchase_lines
   SET reconciliation_month = GREATEST(period, matched_2b_month)
 WHERE matched_2b_key IS NOT NULL
   AND matched_2b_month IS NOT NULL
   AND reconciliation_month IS NULL;

CREATE INDEX IF NOT EXISTS idx_pl_recon_month
  ON purchase_lines (our_gstin, reconciliation_month)
  WHERE reconciliation_month IS NOT NULL;
