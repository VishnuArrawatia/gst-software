-- 25_purchase_document_type.sql
--
-- The purchase register has always carried three kinds of document in one
-- file — invoices, credit and debit notes — but a row had no way to say which
-- one it was. Two things followed from that, and both were wrong:
--
--   * a credit note ADDED to the month's purchases instead of reducing them,
--     because nothing knew its amounts meant "less"; and
--   * an invoice and a credit note sharing a number could satisfy each other in
--     the GSTR-2B reconciliation, since the match key was only
--     (supplier GSTIN, document number).
--
-- `book_document_type` is the missing fact. The importer applies its sign
-- exactly once to the amounts it stores in book_*, so every existing sum — ITC,
-- taxable value, dashboards, exports — nets correctly without being told about
-- notes. `source_*` keeps what the file actually printed, and
-- `book_document_type_raw` keeps the spelling the file used, so the audit trail
-- can always show both sides of the normalization.
--
-- Existing rows: a purchase line whose amounts are negative can only be a
-- credit note (that is how the old template's users had to enter one), so those
-- are labelled rather than re-signed. Everything else is a tax invoice, and its
-- source amounts equal the book amounts it already had.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS book_document_type     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS book_document_type_raw VARCHAR(60),
  ADD COLUMN IF NOT EXISTS book_sign              SMALLINT,
  ADD COLUMN IF NOT EXISTS source_taxable_value   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS source_igst            NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS source_cgst            NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS source_sgst            NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS source_cess            NUMERIC(15,2);

UPDATE purchase_lines
   SET book_document_type = 'Credit Note'
 WHERE book_document_type IS NULL
   AND (book_taxable_value < 0 OR book_igst < 0 OR book_cgst < 0
        OR book_sgst < 0 OR book_cess < 0);

UPDATE purchase_lines
   SET book_document_type = 'Tax Invoice'
 WHERE book_document_type IS NULL;

UPDATE purchase_lines
   SET book_sign = CASE WHEN book_document_type = 'Credit Note' THEN -1 ELSE 1 END
 WHERE book_sign IS NULL;

UPDATE purchase_lines
   SET source_taxable_value = book_taxable_value
 WHERE source_taxable_value IS NULL;
UPDATE purchase_lines SET source_igst = book_igst WHERE source_igst IS NULL;
UPDATE purchase_lines SET source_cgst = book_cgst WHERE source_cgst IS NULL;
UPDATE purchase_lines SET source_sgst = book_sgst WHERE source_sgst IS NULL;
UPDATE purchase_lines SET source_cess = book_cess WHERE source_cess IS NULL;

ALTER TABLE purchase_lines
  ALTER COLUMN book_document_type SET DEFAULT 'Tax Invoice',
  ALTER COLUMN book_document_type SET NOT NULL,
  ALTER COLUMN book_document_type_raw SET DEFAULT NULL,
  ALTER COLUMN book_sign SET DEFAULT 1,
  ALTER COLUMN book_sign SET NOT NULL,
  ALTER COLUMN source_taxable_value SET DEFAULT 0,
  ALTER COLUMN source_taxable_value SET NOT NULL,
  ALTER COLUMN source_igst SET DEFAULT 0,
  ALTER COLUMN source_igst SET NOT NULL,
  ALTER COLUMN source_cgst SET DEFAULT 0,
  ALTER COLUMN source_cgst SET NOT NULL,
  ALTER COLUMN source_sgst SET DEFAULT 0,
  ALTER COLUMN source_sgst SET NOT NULL,
  ALTER COLUMN source_cess SET DEFAULT 0,
  ALTER COLUMN source_cess SET NOT NULL;

ALTER TABLE purchase_lines
  DROP CONSTRAINT IF EXISTS ck_pl_document_type;
ALTER TABLE purchase_lines
  ADD CONSTRAINT ck_pl_document_type CHECK (
    book_document_type IN ('Tax Invoice', 'Debit Note', 'Credit Note')
  );

ALTER TABLE purchase_lines
  DROP CONSTRAINT IF EXISTS ck_pl_book_sign;
ALTER TABLE purchase_lines
  ADD CONSTRAINT ck_pl_book_sign CHECK (book_sign IN (-1, 1));

COMMENT ON COLUMN purchase_lines.book_document_type IS
  'Tax Invoice | Debit Note | Credit Note. Decides the sign of every book amount; a credit note is stored negative.';
COMMENT ON COLUMN purchase_lines.book_document_type_raw IS
  'The document-type text exactly as the source file wrote it (e.g. "CN"), kept for audit.';
COMMENT ON COLUMN purchase_lines.book_sign IS
  '+1 for Tax Invoice / Debit Note, -1 for Credit Note. Applied to the amounts exactly once at import.';
COMMENT ON COLUMN purchase_lines.source_taxable_value IS
  'Taxable amount exactly as the source file printed it, before the document-type sign was applied.';

-- ---------------------------------------------------------------------------
-- GSTR-2B credit notes: the portal has exported these with BOTH sign
-- conventions across releases (negative txval in the JSON, positive in some
-- converted spreadsheets). The ledger effect is always a reduction, so any
-- credit-note line still sitting positive is brought onto the negative
-- convention the matcher and the reports now assume. Idempotent: it only
-- touches rows whose figures are not already negative.
-- ---------------------------------------------------------------------------
UPDATE gstr2b_lines
   SET taxable_value = -ABS(taxable_value),
       igst          = -ABS(igst),
       cgst          = -ABS(cgst),
       sgst          = -ABS(sgst),
       cess          = -ABS(cess),
       invoice_value = -ABS(invoice_value)
 WHERE document_type ~* '(cdnr|credit|^\s*cn\s*$|^\s*c\s*$)'
   AND (taxable_value > 0 OR igst > 0 OR cgst > 0 OR sgst > 0 OR cess > 0);
