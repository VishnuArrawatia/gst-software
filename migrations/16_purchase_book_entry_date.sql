-- 16_purchase_book_entry_date.sql
--
-- The purchase register carries the date the entry was booked in our books.
-- This is NOT the supplier's invoice date: a bill received on 28-Apr can be
-- booked in May, and that difference is exactly what makes a purchase show up
-- in one month's books and a different month's GSTR-2B.
--
-- The SAP register also has a `Month` column, but it competes with `2B Month`
-- for the single `period` field and `2B Month` wins (FIELD_PRIORITY.period), so
-- the book entry month was being dropped on import. Storing the date keeps the
-- month derivable from it instead of asking for a second, redundant column.
--
-- The accounts team confirmed this column doubles as the PO / GRN reference
-- date — many registers carry a single date for both — so no separate
-- `book_reference_date` is added.
--
-- Additive only: nullable, no existing row is touched, nothing is dropped.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS book_entry_date DATE;

COMMENT ON COLUMN purchase_lines.book_entry_date IS
  'Date the invoice was booked in our books (may be the PO/GRN reference date). Distinct from book_invoice_date, which is the supplier''s invoice date. The book entry month is derived from this.';

-- Book entry month is read by filtering on a date range per period, which is
-- what every book-vs-return ageing query does.
CREATE INDEX IF NOT EXISTS ix_purchase_lines_entry_date
  ON purchase_lines (our_gstin, book_entry_date)
  WHERE book_entry_date IS NOT NULL;