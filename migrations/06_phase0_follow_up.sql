-- GST-SOFTWARE — Phase 0, follow-up columns
--
-- The Accounts team downloads "Missing in 2B", works the list outside the
-- application (in Excel, or by calling the vendor), and uploads it back with
-- what they learned. These five columns are the ones they are allowed to fill
-- in. They are deliberately NOT reconciliation fields: a vendor's reply never
-- changes what the books said or what the portal said.
--
-- Everything else in an uploaded report — book values, amounts, the 2B figures
-- — is carried through the export and ignored on the way back in. The book
-- immutability trigger keeps enforcing that from the database side.

ALTER TABLE purchase_lines
    ADD COLUMN IF NOT EXISTS remarks           TEXT,
    ADD COLUMN IF NOT EXISTS vendor_response   TEXT,
    ADD COLUMN IF NOT EXISTS follow_up_date    DATE,
    ADD COLUMN IF NOT EXISTS expected_correction TEXT,
    ADD COLUMN IF NOT EXISTS action_taken      TEXT;

COMMENT ON COLUMN purchase_lines.remarks IS
    'Free note added by the Accounts team. Not a reconciliation input.';
COMMENT ON COLUMN purchase_lines.vendor_response IS
    'What the vendor said when asked.';
COMMENT ON COLUMN purchase_lines.follow_up_date IS
    'Date the vendor was last chased.';
COMMENT ON COLUMN purchase_lines.expected_correction IS
    'What the vendor has undertaken to do.';
COMMENT ON COLUMN purchase_lines.action_taken IS
    'What we did about it.';

-- The supplier follow-up screen ranks by money at risk, and the vendor list is
-- always read per supplier, so both need an index.
CREATE INDEX IF NOT EXISTS idx_pl_followup ON purchase_lines (book_supplier_gstin, follow_up_date);
CREATE INDEX IF NOT EXISTS idx_pl_vendor_missing
    ON purchase_lines (book_supplier_gstin) WHERE match_status <> 'Matched';