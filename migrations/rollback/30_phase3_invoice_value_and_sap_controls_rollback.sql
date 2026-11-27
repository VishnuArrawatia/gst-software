-- Rollback for Phase 3 Migration 30 (`30_phase3_invoice_value_and_sap_controls.sql`)
--
-- DATA-PRESERVATION GUARD:
--   Refuses to silently destroy recorded SAP Business One control totals
--   (`sap_book_control_totals`) or upload history (`sap_control_upload_batches`)
--   unless an operator explicitly sets `SET LOCAL gst.force_phase3_rollback = 'on';`
--   AFTER archiving/backing up the data.

BEGIN;

DO $$
DECLARE
  v_ctrl_cnt  INT := 0;
  v_batch_cnt INT := 0;
  v_force     BOOLEAN := (COALESCE(current_setting('gst.force_phase3_rollback', true), '') = 'on');
BEGIN
  IF to_regclass('public.sap_book_control_totals') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_ctrl_cnt FROM sap_book_control_totals;
  END IF;

  IF to_regclass('public.sap_control_upload_batches') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_batch_cnt FROM sap_control_upload_batches;
  END IF;

  IF NOT v_force AND (v_ctrl_cnt > 0 OR v_batch_cnt > 0) THEN
    RAISE EXCEPTION
      'Refusing silent rollback of Migration 30: % sap_book_control_totals and % sap_control_upload_batches rows exist. Backup/archive first, then SET LOCAL gst.force_phase3_rollback = ''on''.',
      v_ctrl_cnt, v_batch_cnt;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_sap_ctrl_fy_period;
DROP INDEX IF EXISTS uq_sap_ctrl_active_gstin_period;
DROP TABLE IF EXISTS sap_book_control_totals;

DROP INDEX IF EXISTS idx_sap_ctrl_batches_hash;
DROP TABLE IF EXISTS sap_control_upload_batches;

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

ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS invoice_value_difference,
  DROP COLUMN IF EXISTS twob_invoice_value,
  DROP COLUMN IF EXISTS book_invoice_value,
  DROP COLUMN IF EXISTS source_invoice_value;

DELETE FROM schema_migrations
 WHERE filename = '30_phase3_invoice_value_and_sap_controls.sql';

COMMIT;
