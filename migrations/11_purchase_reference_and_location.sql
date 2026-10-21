-- 11_purchase_reference_and_location.sql
--
-- The SAP purchase register carries a PO / GRN reference next to the invoice
-- number. Reconciliation matches on the INVOICE number, so the reference is
-- stored in its own column and never allowed to stand in for the invoice.
--
-- `unit_name` already holds the Location, so nothing is added for it.
--
-- Additive only: no existing row is touched and no column is dropped.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS book_reference_no VARCHAR(200);

COMMENT ON COLUMN purchase_lines.book_reference_no IS
  'PO / GRN / your-reference number from the purchase register. Kept separate from book_invoice_no because reconciliation matches on the invoice number.';

-- The reference shows in supplier follow-up and drill-downs, which always
-- filter by GSTIN and period.
CREATE INDEX IF NOT EXISTS ix_purchase_lines_ref
  ON purchase_lines (our_gstin, period)
  WHERE book_reference_no IS NOT NULL AND book_reference_no <> '';