-- Migration 21 — audit_trail.action was too narrow to hold the action names.
--
-- `action` was declared VARCHAR(20). Six of the action names the application
-- actually writes are longer than that:
--
--     PURCHASE_TEMPLATE_DOWNLOAD  (26)   <- silently never recorded
--     SALES_TEMPLATE_DOWNLOAD     (23)   <- silently never recorded
--     RETURN_CLASSIFICATION       (21)   <- silently never recorded
--     RECONCILIATION_RUN          (18)   ok
--     GSTR1_FILED_IMPORT          (18)   ok
--     REPORT_IMPORT               (13)   ok
--
-- The insert failed with `value too long for type character varying(20)` and the
-- caller (`audit()` in src/server/admin-api.ts) swallows errors so that an audit
-- problem can never fail the operation it is recording. The result was the worst
-- of both worlds: the route returned 200, the template download worked, and the
-- audit trail recorded nothing — the one place the trail exists to prove.
--
-- Widening the column is a metadata-only change in PostgreSQL (no table rewrite,
-- no constraint to rebuild) and no reader assumes a 20-character action: the
-- Audit Trail screen prints whatever is there. Verified before widening: no
-- index, CHECK or view selects `action` with a length assumption.
--
-- The `IF` guard keeps this re-runnable, like the other migrations.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'audit_trail'
       AND column_name = 'action'
       AND character_maximum_length < 60
  ) THEN
    ALTER TABLE audit_trail ALTER COLUMN action TYPE VARCHAR(60);
  END IF;
END $$;

COMMENT ON COLUMN audit_trail.action IS
  'What happened, e.g. SALES_TEMPLATE_DOWNLOAD. 60 characters so every action name the application writes fits; anything longer is dropped by the writer, not truncated.';
