-- 19_pl_reconciled_by_text.sql
--
-- `reconciled_by` was declared INTEGER while every other "who did this"
-- column in this database — audit_trail.changed_by, recon_corrections,
-- pl_month_status.recon_run_by — holds the actor's NAME. The application writes
-- the actor name, so saving an explanation failed with:
--
--     invalid input syntax for type integer: "Vishnu"
--
-- and the whole "explain this difference" action returned a 500. The other
-- tables are the precedent; this column was the odd one out.
--
-- PostgreSQL refuses to alter the type of a column a view selects from, so
-- v_pl_vs_books is dropped and rebuilt around the change. The definition is
-- repeated here on purpose: a migration must stand on its own, and copying a
-- view definition from an older migration is how two of them drift apart.

DROP VIEW IF EXISTS v_pl_vs_books;

ALTER TABLE pl_reconciliation
  ALTER COLUMN reconciled_by TYPE TEXT USING reconciled_by::text;

COMMENT ON COLUMN pl_reconciliation.reconciled_by IS
  'Display name of the person who explained the difference. The numeric user id is in audit_trail for the same action.';

CREATE OR REPLACE VIEW v_pl_vs_books AS
SELECT
    r.id                AS recon_id,
    r.company_id,
    co.name             AS company_name,
    r.financial_year,
    r.period,
    h.id                AS pl_head_id,
    h.name              AS pl_head,
    h.group_name,
    h.head_kind,
    h.sequence,
    h.is_mandatory,
    m.gst_applicable,
    m.taxable_type,
    m.return_mapping,
    r.gstr1_table,
    m.include_in_gstr1,
    r.amendment_no,
    r.pl_amount,
    r.gstr1_amount,
    r.difference,
    r.gstin_count,
    r.gstin_breakdown,
    r.difference_reason,
    dr.label            AS difference_reason_label,
    dr.category         AS difference_category,
    r.remarks,
    r.status,
    r.is_locked,
    r.reconciled_by,
    r.reconciled_at
FROM pl_reconciliation r
JOIN pl_heads h        ON h.id = r.pl_head_id
JOIN companies co      ON co.id = r.company_id
LEFT JOIN pl_gst_mapping m ON m.pl_head_id = h.id AND m.status = 1
LEFT JOIN recon_difference_reasons dr ON dr.code = r.difference_reason;

COMMENT ON VIEW v_pl_vs_books IS
    'P&L head versus the combined GSTR-1 figure for that head. One row per head per month; gstin_breakdown carries the GSTIN detail.';