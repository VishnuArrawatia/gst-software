-- 32_phase6_gstr3b_itc_control.sql
--
-- Phase 6 — GSTR-3B Table 4 Readiness & Strict Manual ITC Control
--   1. Separates `itc_claim_month` / `itc_claim_fy` from `period` (Books Month),
--      `matched_2b_month` (Actual GSTR-2B Month), and `itc_decision_month`.
--   2. Adds explicit `is_impg` (Table 4(A)(1)), `is_rcm` (Table 4(A)(3)),
--      `itc_reversal_type` ('SEC_17_5_BLOCKED' -> 4(B)(1) vs 'OTHER_TEMPORARY' -> 4(B)(2)),
--      and manual reclaim tracking (`itc_reclaimed`, `itc_reclaim_month`,
--      `itc_reclaim_reason`, `itc_reclaimed_by`, `itc_reclaimed_at` -> Table 4(D)(1)).
--   3. Extends `recon_corrections.ck_rc_field` to audit all manual ITC control fields.
--
-- 100% additive & idempotent. Zero automatic ITC claims, reversals, or book_* changes.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS itc_claim_month    VARCHAR(7),
  ADD COLUMN IF NOT EXISTS itc_claim_fy       VARCHAR(9),
  ADD COLUMN IF NOT EXISTS is_impg            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_rcm             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS itc_reversal_type  VARCHAR(24),
  ADD COLUMN IF NOT EXISTS itc_reclaimed      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS itc_reclaim_month  VARCHAR(7),
  ADD COLUMN IF NOT EXISTS itc_reclaim_reason TEXT,
  ADD COLUMN IF NOT EXISTS itc_reclaimed_by   TEXT,
  ADD COLUMN IF NOT EXISTS itc_reclaimed_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pl_itc_reclaim_month
  ON purchase_lines (our_gstin, itc_reclaim_month)
  WHERE itc_reclaimed = true AND itc_reclaim_month IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pl_itc_claim_month
  ON purchase_lines (our_gstin, itc_claim_month)
  WHERE itc_claim_month IS NOT NULL;

ALTER TABLE recon_corrections
  DROP CONSTRAINT IF EXISTS ck_rc_field;

ALTER TABLE recon_corrections
  ADD CONSTRAINT ck_rc_field CHECK (
    field_name IN (
      'recon_supplier_gstin',
      'recon_invoice_no',
      'recon_invoice_date',
      'recon_extra_charges_type',
      'recon_extra_taxable',
      'recon_extra_igst',
      'recon_extra_cgst',
      'recon_extra_sgst',
      'recon_extra_utgst',
      'recon_extra_cess',
      'itc_decision',
      'itc_decision_month',
      'itc_claim_month',
      'itc_reversal_type',
      'itc_reclaimed',
      'itc_reclaim_month',
      'is_impg',
      'is_rcm',
      'decision_reason',
      'return_classification',
      'has_e_invoice',
      'e_invoice_no',
      'has_e_way_bill',
      'e_way_bill_no',
      'e_invoice_required',
      'e_way_bill_required',
      'our_gstin'
    )
  );
