-- GST-SOFTWARE — Phase 0 corrections to migration 04
--
-- Found by the Phase 0 acceptance tests (tests/phase0-db.ts), which is what
-- they are for:
--
--   * recon_corrections.ck_rc_field did not list `decision_reason`, so saving
--     an ITC decision reason was rejected by the database. The decision REASON
--     belongs in the history exactly as much as the decision itself does.
--   * month_locks had a column for the unlock reason but none for the lock
--     reason, so "LOCK April-26 because the return was filed" could not be
--     recorded.
--
-- Both are additive. No data is rewritten.

ALTER TABLE recon_corrections DROP CONSTRAINT IF EXISTS ck_rc_field;
ALTER TABLE recon_corrections ADD CONSTRAINT ck_rc_field CHECK (
    field_name IN ('recon_supplier_gstin','recon_invoice_no','recon_invoice_date',
                   'itc_decision','itc_decision_month','decision_reason','return_classification')
);

ALTER TABLE month_locks ADD COLUMN IF NOT EXISTS reason TEXT;

COMMENT ON COLUMN month_locks.reason IS
    'Why the period was locked. The unlock reason is kept separately in unlock_reason.';