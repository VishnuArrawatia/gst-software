-- 12_e_invoice_and_e_way_bill.sql
--
-- Two questions the Accounts team asks on every invoice while reconciling
-- bill-to-bill: was an e-invoice (IRN) generated for it, and is there an
-- e-way bill number against it?
--
-- Neither figure comes from GSTR-2B. 2B carries only ITC data — supplier,
-- invoice, tax — and says nothing about IRN or e-way bills; those live in the
-- e-invoice system and the e-way bill portal. So they are captured here at
-- reconciliation time, when the person doing the reconciliation is already
-- looking at the invoice.
--
-- `*_required` records whether the law needs one at all, so "missing" can be
-- told apart from "not applicable". E-invoicing kicks in above Rs 5 crore of
-- invoice value and an e-way bill above Rs 50,000 of consignment value, so a
-- blank `*_required` is honest for the many small invoices where neither
-- applies.
--
-- Additive only: no existing row is touched and no column is dropped.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS has_e_invoice        BOOLEAN,
  ADD COLUMN IF NOT EXISTS e_invoice_no         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS has_e_way_bill      BOOLEAN,
  ADD COLUMN IF NOT EXISTS e_way_bill_no       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS e_invoice_required  BOOLEAN,
  ADD COLUMN IF NOT EXISTS e_way_bill_required BOOLEAN;

COMMENT ON COLUMN purchase_lines.has_e_invoice IS
  'TRUE = e-invoice generated for this invoice, FALSE = not generated, NULL = not yet checked.';
COMMENT ON COLUMN purchase_lines.e_invoice_no IS
  'IRN / IRN hash reported by the supplier. Empty means no e-invoice reference was recorded.';
COMMENT ON COLUMN purchase_lines.has_e_way_bill IS
  'TRUE = e-way bill generated, FALSE = not generated, NULL = not yet checked.';
COMMENT ON COLUMN purchase_lines.e_way_bill_no IS
  'E-way bill number. Empty means no number was recorded.';
COMMENT ON COLUMN purchase_lines.e_invoice_required IS
  'Whether e-invoicing is mandatory for this invoice (invoice value above the Rs 5 crore threshold).';
COMMENT ON COLUMN purchase_lines.e_way_bill_required IS
  'Whether an e-way bill is mandatory for this consignment (value above Rs 50,000).';

-- The exception report scans for "required but missing", always inside one
-- GSTIN and period, which is how every month screen filters.
CREATE INDEX IF NOT EXISTS ix_purchase_lines_einvoice_gap
  ON purchase_lines (our_gstin, period)
  WHERE e_invoice_required AND has_e_invoice IS NOT TRUE;

CREATE INDEX IF NOT EXISTS ix_purchase_lines_ewaybill_gap
  ON purchase_lines (our_gstin, period)
  WHERE e_way_bill_required AND has_e_way_bill IS NOT TRUE;