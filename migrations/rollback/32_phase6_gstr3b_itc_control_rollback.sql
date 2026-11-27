-- Rollback for Phase 6 Migration 32 (`32_phase6_gstr3b_itc_control.sql`)
--
-- DATA-PRESERVATION GUARD:
--   Refuses to silently destroy recorded Phase 6 ITC control history (manual claim
--   months, reversals, reclaims, or recon_corrections audit entries) unless an
--   operator explicitly sets `SET LOCAL gst.force_phase6_rollback = 'on';` AFTER
--   archiving/backing up the data.

BEGIN;

DO $$
DECLARE
  v_pl_hist INT := 0;
  v_rc_hist INT := 0;
  v_force BOOLEAN := (COALESCE(current_setting('gst.force_phase6_rollback', true), '') = 'on');
BEGIN
  SELECT COUNT(*) INTO v_pl_hist
    FROM purchase_lines
   WHERE itc_claim_month IS NOT NULL
      OR itc_reversal_type IS NOT NULL
      OR itc_reclaimed = true
      OR is_impg = true
      OR is_rcm = true;

  SELECT COUNT(*) INTO v_rc_hist
    FROM recon_corrections
   WHERE field_name IN (
     'itc_claim_month', 'itc_reversal_type', 'itc_reclaimed',
     'itc_reclaim_month', 'is_impg', 'is_rcm'
   );

  IF NOT v_force AND (v_pl_hist > 0 OR v_rc_hist > 0) THEN
    RAISE EXCEPTION
      'Refusing silent rollback of Migration 32: % purchase_lines and % recon_corrections carry Phase 6 ITC history. Archive/backup first, then SET LOCAL gst.force_phase6_rollback = ''on''.',
      v_pl_hist, v_rc_hist;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_pl_itc_claim_month;
DROP INDEX IF EXISTS idx_pl_itc_reclaim_month;

-- Restore Migration 28 check constraint without failing on historical audit rows
-- preserved during a forced rollback (`SET LOCAL gst.force_phase6_rollback = 'on'`).
DO $$
BEGIN
  ALTER TABLE recon_corrections DROP CONSTRAINT IF EXISTS ck_rc_field;
  IF EXISTS (
    SELECT 1 FROM recon_corrections
     WHERE field_name NOT IN (
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
  ) THEN
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
      ) NOT VALID;
  ELSE
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
  END IF;
END $$;

ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS itc_reclaimed_at,
  DROP COLUMN IF EXISTS itc_reclaimed_by,
  DROP COLUMN IF EXISTS itc_reclaim_reason,
  DROP COLUMN IF EXISTS itc_reclaim_month,
  DROP COLUMN IF EXISTS itc_reclaimed,
  DROP COLUMN IF EXISTS itc_reversal_type,
  DROP COLUMN IF EXISTS is_rcm,
  DROP COLUMN IF EXISTS is_impg,
  DROP COLUMN IF EXISTS itc_claim_fy,
  DROP COLUMN IF EXISTS itc_claim_month;

DELETE FROM schema_migrations
 WHERE filename = '32_phase6_gstr3b_itc_control.sql';

COMMIT;
