-- 24_our_gstin_correction.sql
--
-- The reconciliation screen lets the accounts team correct four fields on a
-- purchase line while the invoice is open: invoice number, invoice date,
-- supplier GSTIN — and the company's OWN GSTIN, for the row where the register
-- carried the wrong registration.
--
-- The first three are `recon_*` columns and were already recorded as
-- corrections. Our GSTIN is not a recon_* column (it decides the month, the
-- company and the unit), so it is corrected on the line itself and its history
-- belongs beside the others.
--
-- `recon_corrections.field_name` is guarded by a CHECK listing the fields it
-- will accept, so without this the INSERT is rejected and the whole save fails.
-- The old constraint is dropped by name and re-added with the wider list; no
-- row is touched. Keep in step with CORRECTION_FIELDS in src/app/store.ts.

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
      'e_way_bill_required',
      -- The company's own registration on the row. Corrected when the register
      -- was imported under the wrong GSTIN; the line moves to the right company
      -- and unit, and the move is recorded like any other correction.
      'our_gstin'
    )
  );

COMMENT ON CONSTRAINT ck_rc_field ON recon_corrections IS
  'Whitelists the columns recon_corrections will record. Keep in step with CORRECTION_FIELDS in src/app/store.ts.';
