-- 27_recon_additional_charges.sql
--
-- Books-side reconciliation overlay for Additional Charges (Freight, Packaging,
-- Loading/Unloading, Insurance, Other Charges, Rounding) that appear on the
-- supplier's GSTR-2B invoice but were booked in a separate expense ledger
-- outside the main Purchase Register.
--
-- Golden rules preserved:
--   1. Original `book_*` columns remain 100% immutable (enforced by trg_pl_book_immutable).
--   2. Original `gstr2b_lines` remain 100% immutable.
--   3. Additional charges live strictly in `recon_extra_*` overlay columns and
--      every change is logged in `recon_corrections` and `audit_trail`.
--   4. 100% additive and idempotent.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS recon_extra_charges_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS recon_extra_taxable      NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recon_extra_igst         NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recon_extra_cgst         NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recon_extra_sgst         NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recon_extra_cess         NUMERIC(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN purchase_lines.recon_extra_charges_type IS
  'Books-side recon overlay reason for additional charges (e.g. Freight, Other Charges, Packaging).';
COMMENT ON COLUMN purchase_lines.recon_extra_taxable IS
  'Books-side recon overlay: additional taxable charges (Freight / Other Charges) added to book_taxable_value during GSTR-2B matching. Original book_taxable_value stays immutable.';

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
