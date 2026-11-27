-- Rollback for REM-3 Migration 33 (`33_phase6_reclaim_amount_and_constraints.sql`)
--
-- DATA-PRESERVATION GUARD:
--   Refuses to silently discard recorded ITC reclaim tranches (`itc_reclaim_entries`),
--   `purchase_lines.itc_reclaim_amount`, or `recon_corrections` audit entries unless
--   an operator explicitly sets `SET LOCAL gst.force_rem3_rollback = 'on';` AFTER
--   taking and verifying a pg_dump backup.

BEGIN;

DO $$
DECLARE
  v_ire_cnt INT := 0;
  v_pl_cnt  INT := 0;
  v_rc_cnt  INT := 0;
  v_force   BOOLEAN := (current_setting('gst.force_rem3_rollback', true) = 'on');
BEGIN
  SELECT COUNT(*) INTO v_ire_cnt FROM itc_reclaim_entries;
  SELECT COUNT(*) INTO v_pl_cnt FROM purchase_lines WHERE itc_reclaim_amount IS NOT NULL;
  SELECT COUNT(*) INTO v_rc_cnt FROM recon_corrections WHERE field_name = 'itc_reclaim_amount';

  IF NOT v_force AND (v_ire_cnt > 0 OR v_pl_cnt > 0 OR v_rc_cnt > 0) THEN
    RAISE EXCEPTION
      'Refusing silent rollback of Migration 33: % itc_reclaim_entries, % purchase_lines reclaim amounts, and % recon_corrections exist. Backup/archive first, then SET LOCAL gst.force_rem3_rollback = ''on''.',
      v_ire_cnt, v_pl_cnt, v_rc_cnt;
  END IF;
END $$;

-- Restore Migration 30 trg_book_values_immutable()
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
    ) THEN
        RAISE EXCEPTION
            'Book values are immutable. Reconcile by changing the recon_* fields, never the book_* fields.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE purchase_lines
  DROP CONSTRAINT IF EXISTS ck_pl_reclaim_head_sum,
  DROP CONSTRAINT IF EXISTS ck_pl_reclaim_amt_pos,
  DROP CONSTRAINT IF EXISTS ck_pl_no_17_5_reclaim,
  DROP CONSTRAINT IF EXISTS ck_pl_itc_rev_type,
  DROP CONSTRAINT IF EXISTS ck_pl_impg_rcm_excl;

DROP INDEX IF EXISTS idx_ire_line_id;
DROP INDEX IF EXISTS idx_ire_gstin_month;
DROP TABLE IF EXISTS itc_reclaim_entries;

ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS itc_reclaim_cess,
  DROP COLUMN IF EXISTS itc_reclaim_utgst,
  DROP COLUMN IF EXISTS itc_reclaim_sgst,
  DROP COLUMN IF EXISTS itc_reclaim_cgst,
  DROP COLUMN IF EXISTS itc_reclaim_igst,
  DROP COLUMN IF EXISTS itc_reclaim_amount;

DELETE FROM schema_migrations
 WHERE filename = '33_phase6_reclaim_amount_and_constraints.sql';

COMMIT;
