-- 26_gstr2b_excel_and_ims.sql
--
-- Additive schema enhancements for:
--   1. GSTR-2B Excel multi-sheet/multi-period import batches & metadata
--   2. Granular 15-status GSTR-2B reconciliation outcome + Complete Reconciliation Export history
--   3. Independent Immutable IMS Portal data layer, matching runs, workflow decisions,
--      manual portal upload tracking, error reports, and IMS audit trail.
--
-- 100% additive & idempotent. Never modifies purchase_lines.book_* or deletes historical data.

-- ===========================================================================
-- 1. GSTR-2B EXCEL IMPORT BATCHES & LINE METADATA
-- ===========================================================================

CREATE TABLE IF NOT EXISTS gstr2b_import_batches (
    id                BIGSERIAL PRIMARY KEY,
    batch_uid         VARCHAR(64) NOT NULL UNIQUE,
    our_gstin         VARCHAR(15),
    detected_gstins   TEXT[] NOT NULL DEFAULT '{}',
    financial_year    VARCHAR(9),
    period_mode       VARCHAR(20) NOT NULL DEFAULT 'single',
    selected_periods  TEXT[] NOT NULL DEFAULT '{}',
    detected_periods  TEXT[] NOT NULL DEFAULT '{}',
    file_names        TEXT[] NOT NULL DEFAULT '{}',
    file_hashes       TEXT[] NOT NULL DEFAULT '{}',
    categories        TEXT[] NOT NULL DEFAULT '{}',
    total_records     INTEGER NOT NULL DEFAULT 0,
    accepted_records  INTEGER NOT NULL DEFAULT 0,
    duplicate_records INTEGER NOT NULL DEFAULT 0,
    rejected_records  INTEGER NOT NULL DEFAULT 0,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_by       TEXT NOT NULL DEFAULT 'system',
    imported_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_2b_batch_gstin ON gstr2b_import_batches (our_gstin, imported_at DESC);

ALTER TABLE gstr2b_lines
    ADD COLUMN IF NOT EXISTS doc_category            VARCHAR(30),
    ADD COLUMN IF NOT EXISTS import_batch_id         BIGINT REFERENCES gstr2b_import_batches(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS original_sign_preserved BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS source_taxable_value    NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS source_igst             NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS source_cgst             NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS source_sgst             NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS source_cess             NUMERIC(15,2);

CREATE INDEX IF NOT EXISTS idx_2bl_batch ON gstr2b_lines (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_2bl_cat   ON gstr2b_lines (our_gstin, twob_month, doc_category);

ALTER TABLE purchase_lines
    ADD COLUMN IF NOT EXISTS detailed_match_status VARCHAR(60);

CREATE INDEX IF NOT EXISTS idx_pl_detailed_status ON purchase_lines (detailed_match_status);

-- ===========================================================================
-- 2. COMPLETE RECONCILIATION EXPORT HISTORY
-- ===========================================================================

CREATE TABLE IF NOT EXISTS recon_export_history (
    id                BIGSERIAL PRIMARY KEY,
    export_type       VARCHAR(40) NOT NULL DEFAULT 'gstr2b_complete',
    exported_by       TEXT NOT NULL DEFAULT 'system',
    exported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    our_gstin         VARCHAR(15),
    selected_gstins   TEXT[] NOT NULL DEFAULT '{}',
    period_mode       VARCHAR(20) NOT NULL DEFAULT 'single',
    selected_periods  TEXT[] NOT NULL DEFAULT '{}',
    filters           JSONB NOT NULL DEFAULT '{}'::jsonb,
    record_count      INTEGER NOT NULL DEFAULT 0,
    file_name         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reh_at ON recon_export_history (exported_at DESC);

-- ===========================================================================
-- 3. INDEPENDENT IMS PORTAL DATA LAYER (SEPARATE FROM GSTR-2B)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ims_import_batches (
    id                BIGSERIAL PRIMARY KEY,
    batch_uid         VARCHAR(64) NOT NULL UNIQUE,
    our_gstin         VARCHAR(15),
    file_name         TEXT NOT NULL,
    file_sha256       CHAR(64) NOT NULL,
    file_format       VARCHAR(15) NOT NULL,
    categories        TEXT[] NOT NULL DEFAULT '{}',
    total_records     INTEGER NOT NULL DEFAULT 0,
    accepted_records  INTEGER NOT NULL DEFAULT 0,
    duplicate_records INTEGER NOT NULL DEFAULT 0,
    rejected_records  INTEGER NOT NULL DEFAULT 0,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_by       TEXT NOT NULL DEFAULT 'system',
    imported_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ims_batch_at ON ims_import_batches (imported_at DESC);

CREATE TABLE IF NOT EXISTS ims_documents (
    id                     BIGSERIAL PRIMARY KEY,
    doc_key                TEXT NOT NULL UNIQUE,
    import_batch_id        BIGINT REFERENCES ims_import_batches(id) ON DELETE SET NULL,
    our_gstin              VARCHAR(15) NOT NULL,
    supplier_gstin         VARCHAR(15) NOT NULL,
    supplier_name          TEXT,
    doc_category           VARCHAR(30) NOT NULL DEFAULT 'B2B',
    document_type          VARCHAR(25) NOT NULL,
    document_type_raw      VARCHAR(60),
    document_no            VARCHAR(100) NOT NULL,
    document_no_norm       VARCHAR(100) NOT NULL,
    document_date          DATE,
    place_of_supply        VARCHAR(100),
    reverse_charge         BOOLEAN NOT NULL DEFAULT false,
    taxable_value          NUMERIC(15,2) NOT NULL DEFAULT 0,
    igst                   NUMERIC(15,2) NOT NULL DEFAULT 0,
    cgst                   NUMERIC(15,2) NOT NULL DEFAULT 0,
    sgst                   NUMERIC(15,2) NOT NULL DEFAULT 0,
    cess                   NUMERIC(15,2) NOT NULL DEFAULT 0,
    invoice_value          NUMERIC(15,2) NOT NULL DEFAULT 0,
    source_taxable_value   NUMERIC(15,2),
    source_igst            NUMERIC(15,2),
    source_cgst            NUMERIC(15,2),
    source_sgst            NUMERIC(15,2),
    source_cess            NUMERIC(15,2),
    portal_matching_key    TEXT,
    ims_source_action      VARCHAR(40),
    ims_source_status      VARCHAR(40),
    gstr1_filing_status    VARCHAR(30),
    gstr1_period           VARCHAR(7),
    itc_reduction_required BOOLEAN NOT NULL DEFAULT false,
    source_file            TEXT NOT NULL,
    source_row             INTEGER,
    raw_payload            JSONB,
    imported_by            TEXT NOT NULL DEFAULT 'system',
    imported_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ims_doc_match ON ims_documents (our_gstin, supplier_gstin, document_no_norm);
CREATE INDEX IF NOT EXISTS idx_ims_doc_pmk   ON ims_documents (our_gstin, portal_matching_key);
CREATE INDEX IF NOT EXISTS idx_ims_doc_batch ON ims_documents (import_batch_id);

CREATE OR REPLACE FUNCTION trg_ims_source_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.our_gstin           IS DISTINCT FROM OLD.our_gstin
       OR NEW.supplier_gstin   IS DISTINCT FROM OLD.supplier_gstin
       OR NEW.document_type    IS DISTINCT FROM OLD.document_type
       OR NEW.document_no      IS DISTINCT FROM OLD.document_no
       OR NEW.document_date    IS DISTINCT FROM OLD.document_date
       OR NEW.taxable_value    IS DISTINCT FROM OLD.taxable_value
       OR NEW.igst             IS DISTINCT FROM OLD.igst
       OR NEW.cgst             IS DISTINCT FROM OLD.cgst
       OR NEW.sgst             IS DISTINCT FROM OLD.sgst
       OR NEW.cess             IS DISTINCT FROM OLD.cess
       OR NEW.portal_matching_key IS DISTINCT FROM OLD.portal_matching_key
       OR NEW.ims_source_action   IS DISTINCT FROM OLD.ims_source_action
       OR NEW.ims_source_status   IS DISTINCT FROM OLD.ims_source_status
       OR NEW.source_file         IS DISTINCT FROM OLD.source_file THEN
        RAISE EXCEPTION
            'Original IMS source documents are immutable and cannot be altered after import.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ims_doc_immutable ON ims_documents;
CREATE TRIGGER trg_ims_doc_immutable
    BEFORE UPDATE ON ims_documents
    FOR EACH ROW EXECUTE FUNCTION trg_ims_source_immutable();

-- ===========================================================================
-- 4. IMS RECONCILIATION RUNS & RESULTS (INDEPENDENT FROM GSTR-2B)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ims_recon_runs (
    id                BIGSERIAL PRIMARY KEY,
    our_gstin         VARCHAR(15) NOT NULL,
    books_period_mode VARCHAR(20) NOT NULL DEFAULT 'single',
    books_periods     TEXT[] NOT NULL DEFAULT '{}',
    tolerance         NUMERIC(10,2) NOT NULL DEFAULT 1,
    total_ims         INTEGER NOT NULL DEFAULT 0,
    total_books       INTEGER NOT NULL DEFAULT 0,
    matched_count     INTEGER NOT NULL DEFAULT 0,
    ims_only_count    INTEGER NOT NULL DEFAULT 0,
    books_only_count  INTEGER NOT NULL DEFAULT 0,
    mismatch_count    INTEGER NOT NULL DEFAULT 0,
    duplicate_count   INTEGER NOT NULL DEFAULT 0,
    run_by            TEXT NOT NULL DEFAULT 'system',
    run_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ims_run_gstin ON ims_recon_runs (our_gstin, run_at DESC);

CREATE TABLE IF NOT EXISTS ims_recon_results (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT NOT NULL REFERENCES ims_recon_runs(id) ON DELETE CASCADE,
    our_gstin             VARCHAR(15) NOT NULL,
    books_period          VARCHAR(7),
    ims_doc_id            BIGINT REFERENCES ims_documents(id) ON DELETE CASCADE,
    purchase_line_id      BIGINT REFERENCES purchase_lines(id) ON DELETE CASCADE,
    recon_status          VARCHAR(60) NOT NULL,
    portal_matching_key   TEXT,
    internal_match_key    TEXT,
    taxable_diff          NUMERIC(15,2),
    igst_diff             NUMERIC(15,2),
    cgst_diff             NUMERIC(15,2),
    sgst_diff             NUMERIC(15,2),
    cess_diff             NUMERIC(15,2),
    total_tax_diff        NUMERIC(15,2),
    date_diff_days        INTEGER,
    recommended_action    VARCHAR(40),
    recommendation_reason TEXT,
    is_manual_link        BOOLEAN NOT NULL DEFAULT false,
    manual_linked_by      TEXT,
    manual_linked_at      TIMESTAMPTZ,
    remarks               TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ims_res_run    ON ims_recon_results (run_id);
CREATE INDEX IF NOT EXISTS idx_ims_res_status ON ims_recon_results (our_gstin, recon_status);
CREATE INDEX IF NOT EXISTS idx_ims_res_doc    ON ims_recon_results (ims_doc_id);
CREATE INDEX IF NOT EXISTS idx_ims_res_book   ON ims_recon_results (purchase_line_id);
CREATE INDEX IF NOT EXISTS idx_ims_res_pmk    ON ims_recon_results (portal_matching_key);

-- ===========================================================================
-- 5. IMS USER DECISIONS, APPROVALS, PORTAL TRACKING & ERROR REPORTS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ims_action_decisions (
    id                    BIGSERIAL PRIMARY KEY,
    ims_doc_id            BIGINT NOT NULL UNIQUE REFERENCES ims_documents(id) ON DELETE CASCADE,
    our_gstin             VARCHAR(15) NOT NULL,
    portal_matching_key   TEXT,
    current_portal_action VARCHAR(40),
    recommended_action    VARCHAR(40),
    user_action           VARCHAR(40) NOT NULL,
    remarks               TEXT,
    workflow_status       VARCHAR(40) NOT NULL DEFAULT 'READY FOR REVIEW',
    source_channel        VARCHAR(30) NOT NULL DEFAULT 'ui',
    decided_by            TEXT NOT NULL,
    decided_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by           TEXT,
    approved_at           TIMESTAMPTZ,
    approval_remarks      TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ims_user_action CHECK (
        user_action IN ('ACCEPT','REJECT','PENDING','DO NOT TAKE ANY ACTION')
    ),
    CONSTRAINT ck_ims_workflow_status CHECK (
        workflow_status IN (
            'NOT READY','READY FOR REVIEW','APPROVED BY USER',
            'UPLOAD PENDING','PROCESSING','SUCCESS','FAILED',
            'NOT UPLOADED','ERROR REVIEW REQUIRED'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_ims_dec_gstin ON ims_action_decisions (our_gstin, workflow_status);

CREATE TABLE IF NOT EXISTS ims_portal_upload_batches (
    id              BIGSERIAL PRIMARY KEY,
    batch_ref       VARCHAR(64) NOT NULL UNIQUE,
    our_gstin       VARCHAR(15) NOT NULL,
    mode            VARCHAR(30) NOT NULL DEFAULT 'MANUAL_PORTAL_EXPORT',
    batch_status    VARCHAR(40) NOT NULL DEFAULT 'APPROVED BY USER',
    total_docs      INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    pending_count   INTEGER NOT NULL DEFAULT 0,
    portal_ack_ref  TEXT,
    approved_by     TEXT NOT NULL,
    approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at    TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ims_ub_status CHECK (
        batch_status IN (
            'NOT READY','READY FOR REVIEW','APPROVED BY USER',
            'UPLOAD PENDING','PROCESSING','SUCCESS','FAILED',
            'NOT UPLOADED','ERROR REVIEW REQUIRED'
        )
    )
);

CREATE TABLE IF NOT EXISTS ims_portal_upload_results (
    id                   BIGSERIAL PRIMARY KEY,
    upload_batch_id      BIGINT NOT NULL REFERENCES ims_portal_upload_batches(id) ON DELETE CASCADE,
    ims_doc_id           BIGINT NOT NULL REFERENCES ims_documents(id) ON DELETE CASCADE,
    our_gstin            VARCHAR(15) NOT NULL,
    portal_matching_key  TEXT,
    previous_action      VARCHAR(40),
    proposed_action      VARCHAR(40) NOT NULL,
    upload_status        VARCHAR(40) NOT NULL DEFAULT 'APPROVED BY USER',
    portal_reference     TEXT,
    portal_error_code    VARCHAR(60),
    portal_error_message TEXT,
    confirmed_by         TEXT,
    confirmed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (upload_batch_id, ims_doc_id),
    CONSTRAINT ck_ims_ur_status CHECK (
        upload_status IN (
            'NOT READY','READY FOR REVIEW','APPROVED BY USER',
            'UPLOAD PENDING','PROCESSING','SUCCESS','FAILED',
            'NOT UPLOADED','ERROR REVIEW REQUIRED'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_ims_ur_doc ON ims_portal_upload_results (ims_doc_id, upload_status);

CREATE TABLE IF NOT EXISTS ims_error_reports (
    id                  BIGSERIAL PRIMARY KEY,
    upload_batch_id     BIGINT REFERENCES ims_portal_upload_batches(id) ON DELETE SET NULL,
    ims_doc_id          BIGINT REFERENCES ims_documents(id) ON DELETE SET NULL,
    our_gstin           VARCHAR(15) NOT NULL,
    supplier_gstin      VARCHAR(15),
    document_no         VARCHAR(100),
    portal_matching_key TEXT,
    error_code          VARCHAR(60),
    error_message       TEXT NOT NULL,
    source_file         TEXT,
    resolution_status   VARCHAR(30) NOT NULL DEFAULT 'OPEN',
    resolution_notes    TEXT,
    imported_by         TEXT NOT NULL DEFAULT 'system',
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ims_err_gstin ON ims_error_reports (our_gstin, resolution_status);

CREATE TABLE IF NOT EXISTS ims_audit_trail (
    id               BIGSERIAL PRIMARY KEY,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor            TEXT NOT NULL,
    event_type       VARCHAR(50) NOT NULL,
    our_gstin        VARCHAR(15),
    ims_doc_id       BIGINT,
    purchase_line_id BIGINT,
    batch_id         BIGINT,
    old_value        TEXT,
    new_value        TEXT,
    reason           TEXT,
    details          JSONB
);

CREATE INDEX IF NOT EXISTS idx_ims_at_ts    ON ims_audit_trail (ts DESC);
CREATE INDEX IF NOT EXISTS idx_ims_at_gstin ON ims_audit_trail (our_gstin, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ims_at_doc   ON ims_audit_trail (ims_doc_id);

-- Attach lightweight fn_audit_log() to IMS decision & workflow tables
DO $$
DECLARE
    tbl TEXT;
    t TEXT[] := ARRAY['ims_action_decisions','ims_portal_upload_batches','ims_error_reports'];
BEGIN
    FOREACH tbl IN ARRAY t LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_audit_%I ON %I', tbl, tbl);
        EXECUTE format(
            'CREATE TRIGGER tg_audit_%I AFTER INSERT OR UPDATE OR DELETE ON %I
             FOR EACH ROW EXECUTE FUNCTION fn_audit_log()', tbl, tbl);
    END LOOP;
END $$;
