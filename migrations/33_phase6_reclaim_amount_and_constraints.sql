-- 33_phase6_reclaim_amount_and_constraints.sql
--
-- REM-3 (HIGH-03, MED-01, LOW-02):
--   1. Persist head-wise & total ITC reclaim amounts on `purchase_lines` AND add
--      `itc_reclaim_entries` child ledger table supporting both full reclaim and
--      multi-tranche partial reclaims against one original 4(B)(2) reversal.
--   2. Add database-level CHECK constraints on `purchase_lines`:
--        - `ck_pl_impg_rcm_excl`: IMPG and RCM are mutually exclusive
--        - `ck_pl_itc_rev_type`: explicit allowlist ('SEC_17_5_BLOCKED', 'OTHER_TEMPORARY')
--        - `ck_pl_no_17_5_reclaim`: permanently blocked Sec 17(5) credit cannot be reclaimed
--        - `ck_pl_reclaim_amt_pos`: positive reclaim total when present
--        - `ck_pl_reclaim_head_sum`: sum of head-wise reclaim amounts === total reclaim
--   3. Extend `recon_corrections.ck_rc_field` to audit `itc_reclaim_amount`.
--   4. Extend `trg_book_values_immutable()` (LOW-02) to also protect `source_utgst`
--      and non-null `source_invoice_value` while keeping `recon_extra_*` overlays working.
--
-- 100% additive & idempotent. Zero historical ITC or reconciliation data destroyed.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS itc_reclaim_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS itc_reclaim_igst   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS itc_reclaim_cgst   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS itc_reclaim_sgst   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS itc_reclaim_utgst  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS itc_reclaim_cess   NUMERIC(15,2);

COMMENT ON COLUMN purchase_lines.itc_reclaim_amount IS
  'Cumulative approved ITC reclaim total across all reclaim tranches (Table 4(D)(1)).';

CREATE TABLE IF NOT EXISTS itc_reclaim_entries (
  id              BIGSERIAL PRIMARY KEY,
  line_id         BIGINT NOT NULL REFERENCES purchase_lines(id) ON DELETE CASCADE,
  our_gstin       VARCHAR(15) NOT NULL,
  reclaim_month   VARCHAR(7)  NOT NULL,
  reclaim_fy      VARCHAR(9)  NOT NULL,
  reclaim_amount  NUMERIC(15,2) NOT NULL CHECK (reclaim_amount > 0),
  reclaim_igst    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reclaim_igst >= 0),
  reclaim_cgst    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reclaim_cgst >= 0),
  reclaim_sgst    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reclaim_sgst >= 0),
  reclaim_utgst   NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reclaim_utgst >= 0),
  reclaim_cess    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reclaim_cess >= 0),
  remaining_after NUMERIC(15,2) NOT NULL CHECK (remaining_after >= 0),
  reason          TEXT NOT NULL,
  reclaimed_by    TEXT NOT NULL,
  reclaimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_ire_head_sum CHECK (
    ABS((reclaim_igst + reclaim_cgst + reclaim_sgst + reclaim_utgst + reclaim_cess) - reclaim_amount) <= 0.01
  ),
  CONSTRAINT uq_ire_line_month UNIQUE (line_id, reclaim_month)
);

CREATE INDEX IF NOT EXISTS idx_ire_gstin_month
  ON itc_reclaim_entries (our_gstin, reclaim_month);

CREATE INDEX IF NOT EXISTS idx_ire_line_id
  ON itc_reclaim_entries (line_id);

-- Database-level CHECK constraints on purchase_lines (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pl_impg_rcm_excl') THEN
    ALTER TABLE purchase_lines
      ADD CONSTRAINT ck_pl_impg_rcm_excl CHECK (NOT (is_impg = true AND is_rcm = true));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pl_itc_rev_type') THEN
    ALTER TABLE purchase_lines
      ADD CONSTRAINT ck_pl_itc_rev_type
      CHECK (itc_reversal_type IS NULL OR itc_reversal_type IN ('SEC_17_5_BLOCKED', 'OTHER_TEMPORARY'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pl_no_17_5_reclaim') THEN
    ALTER TABLE purchase_lines
      ADD CONSTRAINT ck_pl_no_17_5_reclaim
      CHECK (NOT (itc_reclaimed = true AND itc_reversal_type = 'SEC_17_5_BLOCKED'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pl_reclaim_amt_pos') THEN
    ALTER TABLE purchase_lines
      ADD CONSTRAINT ck_pl_reclaim_amt_pos
      CHECK (itc_reclaim_amount IS NULL OR itc_reclaim_amount > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pl_reclaim_head_sum') THEN
    ALTER TABLE purchase_lines
      ADD CONSTRAINT ck_pl_reclaim_head_sum
      CHECK (
        itc_reclaim_amount IS NULL
        OR ABS(
          (COALESCE(itc_reclaim_igst, 0)
           + COALESCE(itc_reclaim_cgst, 0)
           + COALESCE(itc_reclaim_sgst, 0)
           + COALESCE(itc_reclaim_utgst, 0)
           + COALESCE(itc_reclaim_cess, 0))
          - itc_reclaim_amount
        ) <= 0.01
      );
  END IF;
END $$;

-- Extend recon_corrections.ck_rc_field to audit `itc_reclaim_amount`
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
      'itc_reclaim_amount',
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

-- Extend trg_book_values_immutable() (LOW-02) to also guard source_utgst & non-null source_invoice_value
CREATE OR REPLACE FUNCTION trg_book_values_immutable()
RETURNS TRIGGER AS $$
DECLARE
    v_allow_utgst BOOLEAN := (current_setting('gst.allow_utgst_reclass', true) = 'on');
    v_only_utgst_reclass BOOLEAN := false;
BEGIN
    IF v_allow_utgst
       AND NEW.book_supplier_gstin IS NOT DISTINCT FROM OLD.book_supplier_gstin
       AND NEW.book_invoice_no     IS NOT DISTINCT FROM OLD.book_invoice_no
       AND NEW.book_invoice_date   IS NOT DISTINCT FROM OLD.book_invoice_date
       AND NEW.book_taxable_value  IS NOT DISTINCT FROM OLD.book_taxable_value
       AND NEW.book_igst           IS NOT DISTINCT FROM OLD.book_igst
       AND NEW.book_cgst           IS NOT DISTINCT FROM OLD.book_cgst
       AND NEW.book_cess           IS NOT DISTINCT FROM OLD.book_cess
       AND NEW.book_invoice_value  IS NOT DISTINCT FROM OLD.book_invoice_value
       AND NEW.source_utgst        IS NOT DISTINCT FROM OLD.source_utgst
       AND (OLD.source_invoice_value IS NULL OR NEW.source_invoice_value IS NOT DISTINCT FROM OLD.source_invoice_value)
       AND (NEW.book_sgst + NEW.book_utgst) = (OLD.book_sgst + OLD.book_utgst) THEN
        v_only_utgst_reclass := true;
    END IF;

    IF NOT v_only_utgst_reclass AND (
           NEW.book_supplier_gstin IS DISTINCT FROM OLD.book_supplier_gstin
        OR NEW.book_invoice_no     IS DISTINCT FROM OLD.book_invoice_no
        OR NEW.book_invoice_date   IS DISTINCT FROM OLD.book_invoice_date
        OR NEW.book_taxable_value  IS DISTINCT FROM OLD.book_taxable_value
        OR NEW.book_igst           IS DISTINCT FROM OLD.book_igst
        OR NEW.book_cgst           IS DISTINCT FROM OLD.book_cgst
        OR NEW.book_sgst           IS DISTINCT FROM OLD.book_sgst
        OR NEW.book_utgst          IS DISTINCT FROM OLD.book_utgst
        OR NEW.book_cess           IS DISTINCT FROM OLD.book_cess
        OR (OLD.book_invoice_value IS NOT NULL AND NEW.book_invoice_value IS DISTINCT FROM OLD.book_invoice_value)
        OR NEW.source_utgst        IS DISTINCT FROM OLD.source_utgst
        OR (OLD.source_invoice_value IS NOT NULL AND NEW.source_invoice_value IS DISTINCT FROM OLD.source_invoice_value)
    ) THEN
        RAISE EXCEPTION
            'Book values are immutable. Reconcile by changing the recon_* fields, never the book_* or source_* fields.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
