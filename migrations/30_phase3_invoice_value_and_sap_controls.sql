-- 30_phase3_invoice_value_and_sap_controls.sql
--
-- Phase 3:
--   1. Capture actual invoice total (`source_invoice_value`, `book_invoice_value`)
--      on `purchase_lines` without fabricating it when absent in the source file,
--      plus `twob_invoice_value` and `invoice_value_difference` for separate comparison.
--   2. Extend `trg_book_values_immutable()` so `book_invoice_value` is also protected
--      once written (preserving the UTGST tax-invariant reclassification guard).
--   3. Create `sap_control_upload_batches` and `sap_book_control_totals` for
--      SAP Business One Monthly Control Totals (Manual Entry + Excel Upload)
--      with full upload/version history and accidental-overwrite protection.
--
-- 100% additive & idempotent. Zero historical rows deleted or modified.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS source_invoice_value     NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS book_invoice_value       NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS twob_invoice_value       NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS invoice_value_difference NUMERIC(15,2);

COMMENT ON COLUMN purchase_lines.source_invoice_value IS
  'Actual invoice total as printed in the source Purchase Register (NULL when absent in source file; never fabricated).';
COMMENT ON COLUMN purchase_lines.book_invoice_value IS
  'Signed actual invoice total (negative for Credit Notes) when present in source Purchase Register; immutable via trg_pl_book_immutable.';
COMMENT ON COLUMN purchase_lines.twob_invoice_value IS
  'Matched GSTR-2B invoice/document value for separate comparison against book_invoice_value.';
COMMENT ON COLUMN purchase_lines.invoice_value_difference IS
  'book_invoice_value - twob_invoice_value when both are present (NULL if either is unavailable).';

CREATE OR REPLACE FUNCTION trg_book_values_immutable()
RETURNS TRIGGER AS $$
DECLARE
    v_allow_utgst BOOLEAN := (current_setting('gst.allow_utgst_reclass', true) = 'on');
    v_only_utgst_reclass BOOLEAN := false;
BEGIN
    IF v_allow_utgst
       AND NEW.book_supplier_gstin IS NOT DISTINCT FROM OLD.book_supplier_gstin
       AND NEW.book_invoice_no     IS NOT DISTINCT FROM OLD.book_invoice_no
       AND NEW.book_invoice_date   IS NOT DISTINCT FROM OLD.book_invoice_date
       AND NEW.book_taxable_value  IS NOT DISTINCT FROM OLD.book_taxable_value
       AND NEW.book_igst           IS NOT DISTINCT FROM OLD.book_igst
       AND NEW.book_cgst           IS NOT DISTINCT FROM OLD.book_cgst
       AND NEW.book_cess           IS NOT DISTINCT FROM OLD.book_cess
       AND NEW.book_invoice_value  IS NOT DISTINCT FROM OLD.book_invoice_value
       AND (NEW.book_sgst + NEW.book_utgst) = (OLD.book_sgst + OLD.book_utgst) THEN
        v_only_utgst_reclass := true;
    END IF;

    IF NOT v_only_utgst_reclass AND (
           NEW.book_supplier_gstin IS DISTINCT FROM OLD.book_supplier_gstin
        OR NEW.book_invoice_no     IS DISTINCT FROM OLD.book_invoice_no
        OR NEW.book_invoice_date   IS DISTINCT FROM OLD.book_invoice_date
        OR NEW.book_taxable_value  IS DISTINCT FROM OLD.book_taxable_value
        OR NEW.book_igst           IS DISTINCT FROM OLD.book_igst
        OR NEW.book_cgst           IS DISTINCT FROM OLD.book_cgst
        OR NEW.book_sgst           IS DISTINCT FROM OLD.book_sgst
        OR NEW.book_utgst          IS DISTINCT FROM OLD.book_utgst
        OR NEW.book_cess           IS DISTINCT FROM OLD.book_cess
        OR (OLD.book_invoice_value IS NOT NULL AND NEW.book_invoice_value IS DISTINCT FROM OLD.book_invoice_value)
    ) THEN
        RAISE EXCEPTION
            'Book values are immutable. Reconcile by changing the recon_* fields, never the book_* fields.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- SAP Business One Control Totals Upload / Entry History Batches
CREATE TABLE IF NOT EXISTS sap_control_upload_batches (
    id              BIGSERIAL PRIMARY KEY,
    batch_uid       VARCHAR(64) NOT NULL UNIQUE,
    source_type     VARCHAR(16) NOT NULL CHECK (source_type IN ('MANUAL', 'EXCEL')),
    file_name       TEXT,
    file_hash       VARCHAR(64),
    row_count       INTEGER NOT NULL DEFAULT 0,
    uploaded_by     TEXT NOT NULL DEFAULT 'system',
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sap_ctrl_batches_hash
  ON sap_control_upload_batches (file_hash)
  WHERE file_hash IS NOT NULL;

-- SAP Business One Monthly Control Totals (Versioned, Non-Destructive History)
CREATE TABLE IF NOT EXISTS sap_book_control_totals (
    id              BIGSERIAL PRIMARY KEY,
    our_gstin       VARCHAR(15) NOT NULL,
    financial_year  VARCHAR(9)  NOT NULL,
    period          VARCHAR(7)  NOT NULL,
    invoice_count   INTEGER     NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
    taxable_value   NUMERIC(15,2) NOT NULL DEFAULT 0,
    igst            NUMERIC(15,2) NOT NULL DEFAULT 0,
    cgst            NUMERIC(15,2) NOT NULL DEFAULT 0,
    sgst            NUMERIC(15,2) NOT NULL DEFAULT 0,
    utgst           NUMERIC(15,2) NOT NULL DEFAULT 0,
    cess            NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_gst       NUMERIC(15,2) NOT NULL DEFAULT 0,
    invoice_value   NUMERIC(15,2) NOT NULL DEFAULT 0,
    source_type     VARCHAR(16) NOT NULL DEFAULT 'MANUAL' CHECK (source_type IN ('MANUAL', 'EXCEL')),
    batch_id        BIGINT REFERENCES sap_control_upload_batches(id),
    version_no      INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_locked       BOOLEAN NOT NULL DEFAULT false,
    entered_by      TEXT NOT NULL DEFAULT 'system',
    remarks         TEXT,
    overwrite_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active control total per (our_gstin, period); prior versions stay archived (`is_active = false`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sap_ctrl_active_gstin_period
  ON sap_book_control_totals (our_gstin, period)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_sap_ctrl_fy_period
  ON sap_book_control_totals (financial_year, period, our_gstin);
