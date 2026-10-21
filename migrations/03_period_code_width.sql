-- Period codes are stored as 'YYYY-MM' (7 characters) — the format the whole
-- engine uses (periodOf(), labelOf(), and every `period` column in the
-- reconciliation output).
--
-- The original schema declared these columns VARCHAR(6), which fits 'YYYYMM'
-- but not 'YYYY-MM'. Nothing noticed it while the tables were empty, because a
-- 7-character value fails at INSERT time with a bare
--
--     ERROR:  value too long for type character varying(6)
--
-- pointing at the column, not at the format. Every write into
-- purchase_bills / gstr2b_records / sales_invoices would have failed on the
-- first real load. Widening to 7 is the fix; no data is rewritten, and the
-- financial year code ('2025-26', 7 chars) keeps matching period codes of the
-- same shape.

-- v_itc_control reads itc_period_ledger.period, and PostgreSQL refuses to
-- change the type of a column a view depends on. Drop and rebuild it: it is a
-- pure SELECT with no data of its own, so nothing is lost.
DROP VIEW IF EXISTS v_itc_control;

ALTER TABLE periods               ALTER COLUMN period_code TYPE VARCHAR(7);
ALTER TABLE uploaded_files        ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE purchase_bills        ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE gstr2b_records        ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE period_locks          ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE sales_invoices        ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE sales_reconciliation  ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE gstr1_filings         ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE gstr3b_filings        ALTER COLUMN period        TYPE VARCHAR(7);
ALTER TABLE itc_period_ledger     ALTER COLUMN period        TYPE VARCHAR(7);

CREATE VIEW v_itc_control AS
SELECT
    g.gstin_number,
    c.name            AS company_name,
    u.name            AS unit_name,
    l.financial_year,
    l.period,
    l.opening_credit,
    l.books_itc,
    l.claimable_itc,
    l.blocked_itc,
    l.pending_4ai_itc,
    l.duplicate_itc,
    l.itc_availed,
    l.output_tax,
    l.itc_utilised,
    l.closing_credit,
    l.lapse_deadline,
    CASE
        WHEN l.lapse_deadline < CURRENT_DATE                 THEN 'LAPSED'
        WHEN l.lapse_deadline < CURRENT_DATE + INTERVAL '60 days' THEN 'URGENT'
        WHEN l.closing_credit > 0                            THEN 'AT RISK'
        ELSE 'CLEAR'
    END AS lapse_status
FROM itc_period_ledger l
JOIN gstins    g ON g.id = l.gstin_id
JOIN companies c ON c.id = g.company_id
LEFT JOIN units u ON u.id = g.unit_id;

-- The trigger that validates (financial_year, period) pairs compares against
-- periods.period_code, so it starts working as soon as the widths match.