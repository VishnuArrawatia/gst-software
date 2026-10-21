-- 13_e_doc_correction_constraint.sql
--
-- `recon_corrections` guards `field_name` with a CHECK listing the fields it
-- will accept. Migration 12 added the e-invoice / e-way bill columns and the
-- edit path now records them as corrections like any other per-invoice answer,
-- so the constraint has to name them too — otherwise the INSERT is rejected
-- and the whole save fails.
--
-- The old constraint is dropped by name and re-added with the wider list.
-- No row is touched; this only widens what may be written.

ALTER TABLE recon_corrections
  DROP CONSTRAINT IF EXISTS ck_rc_field;

ALTER TABLE recon_corrections
  ADD CONSTRAINT ck_rc_field CHECK (
    field_name IN (
      'recon_supplier_gstin',
      'recon_invoice_no',
      'recon_invoice_date',
      'itc_decision',
      'itc_decision_month',
      'decision_reason',
      'return_classification',
      -- e-invoice / e-way bill, recorded on the invoice during reconciliation.
      -- GSTR-2B carries neither figure, so these are human answers kept with
      -- who gave them and when, exactly like the fields above.
      'has_e_invoice',
      'e_invoice_no',
      'has_e_way_bill',
      'e_way_bill_no',
      'e_invoice_required',
      'e_way_bill_required'
    )
  );

COMMENT ON CONSTRAINT ck_rc_field ON recon_corrections IS
  'Whitelists the columns recon_corrections will record. Keep in step with CORRECTION_FIELDS in src/app/store.ts.';