-- ROLLBACK for 28_utgst_separation_and_phase1.sql
--
-- Safely restores UTGST values back into SGST (preserving total tax liability
-- down to 0.00) before dropping the additive columns added by Migration 28.
-- Run ONLY inside a verified maintenance window after taking a pg_dump backup.

BEGIN;

SET LOCAL gst.allow_utgst_reclass = 'on';

-- 1. Restore any reclassified book_utgst back into book_sgst so zero tax is lost
UPDATE purchase_lines
   SET book_sgst = book_sgst + book_utgst,
       book_utgst = 0,
       twob_sgst = CASE WHEN twob_utgst IS NOT NULL THEN COALESCE(twob_sgst, 0) + twob_utgst ELSE twob_sgst END,
       twob_utgst = CASE WHEN twob_utgst IS NOT NULL THEN 0 ELSE NULL END
 WHERE book_utgst <> 0 OR COALESCE(twob_utgst, 0) <> 0;

UPDATE gstr2b_lines
   SET sgst = sgst + utgst,
       utgst = 0
 WHERE utgst <> 0;

-- 2. Restore original trg_book_values_immutable() without book_utgst
CREATE OR REPLACE FUNCTION trg_book_values_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.book_supplier_gstin IS DISTINCT FROM OLD.book_supplier_gstin
       OR NEW.book_invoice_no     IS DISTINCT FROM OLD.book_invoice_no
       OR NEW.book_invoice_date   IS DISTINCT FROM OLD.book_invoice_date
       OR NEW.book_taxable_value  IS DISTINCT FROM OLD.book_taxable_value
       OR NEW.book_igst           IS DISTINCT FROM OLD.book_igst
       OR NEW.book_cgst           IS DISTINCT FROM OLD.book_cgst
       OR NEW.book_sgst           IS DISTINCT FROM OLD.book_sgst
       OR NEW.book_cess           IS DISTINCT FROM OLD.book_cess THEN
        RAISE EXCEPTION
            'Book values are immutable. Reconcile by changing the recon_* fields, never the book_* fields.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Drop additive columns
ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS source_utgst,
  DROP COLUMN IF EXISTS book_utgst,
  DROP COLUMN IF EXISTS twob_utgst,
  DROP COLUMN IF EXISTS recon_extra_utgst;

ALTER TABLE gstr2b_lines
  DROP COLUMN IF EXISTS utgst,
  DROP COLUMN IF EXISTS source_utgst,
  DROP COLUMN IF EXISTS original_doc_no,
  DROP COLUMN IF EXISTS original_doc_date;

-- 4. Restore Migration 27 check constraint
ALTER TABLE recon_corrections DROP CONSTRAINT IF EXISTS ck_rc_field;
ALTER TABLE recon_corrections
  ADD CONSTRAINT ck_rc_field CHECK (
    field_name IN (
      'recon_supplier_gstin', 'recon_invoice_no', 'recon_invoice_date',
      'recon_extra_charges_type', 'recon_extra_taxable', 'recon_extra_igst',
      'recon_extra_cgst', 'recon_extra_sgst', 'recon_extra_cess',
      'itc_decision', 'itc_decision_month', 'decision_reason', 'return_classification',
      'has_e_invoice', 'e_invoice_no', 'has_e_way_bill', 'e_way_bill_no',
      'e_invoice_required', 'e_way_bill_required', 'our_gstin'
    )
  );

DELETE FROM schema_migrations WHERE filename = '28_utgst_separation_and_phase1.sql';

COMMIT;
