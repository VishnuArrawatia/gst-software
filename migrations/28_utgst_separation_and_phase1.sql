-- 28_utgst_separation_and_phase1.sql
--
-- Phase 1 — Critical Reconciliation Correctness:
--   1. Separate UTGST columns on `purchase_lines` and `gstr2b_lines` so Union
--      Territory tax (state codes 04, 26, 31, 35, 38) is never merged into SGST.
--   2. Preserve original amendment reference (`original_doc_no`, `original_doc_date`)
--      on `gstr2b_lines` for B2BA / CDNRA auditability.
--   3. Extend `trg_book_values_immutable()` to also guard `book_utgst`, while
--      allowing a strictly tax-invariant, transaction-local UTGST reclassification
--      (`gst.allow_utgst_reclass = 'on'` AND `NEW.book_sgst + NEW.book_utgst = OLD.book_sgst + OLD.book_utgst`).
--   4. Extend `recon_corrections.ck_rc_field` to allow `recon_extra_utgst`.
--
-- 100% additive & idempotent. Zero historical rows deleted or overwritten.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS source_utgst      NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS book_utgst        NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twob_utgst        NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS recon_extra_utgst NUMERIC(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN purchase_lines.book_utgst IS
  'Union Territory GST (UTGST) booked on purchase line, separate from SGST. Immutable via trg_pl_book_immutable.';
COMMENT ON COLUMN purchase_lines.source_utgst IS
  'UTGST exactly as printed in the original source file before sign normalisation.';
COMMENT ON COLUMN purchase_lines.twob_utgst IS
  'Matched GSTR-2B UTGST component, kept separate from twob_sgst.';
COMMENT ON COLUMN purchase_lines.recon_extra_utgst IS
  'Books-side recon overlay: additional UTGST on Freight / Other Charges.';

ALTER TABLE gstr2b_lines
  ADD COLUMN IF NOT EXISTS utgst             NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_utgst      NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS original_doc_no   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS original_doc_date DATE;

COMMENT ON COLUMN gstr2b_lines.utgst IS
  'Union Territory GST (UTGST) on GSTR-2B line, separate from SGST.';

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
    ) THEN
        RAISE EXCEPTION
            'Book values are immutable. Reconcile by changing the recon_* fields, never the book_* fields.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
