-- 14_fix_sales_lock_trigger_period_width.sql
--
-- `block_write_to_locked_period` declared its period variable VARCHAR(6), but
-- every period in this schema is `YYYY-MM` — seven characters. Any INSERT into
-- sales_invoices therefore failed with
--
--     value too long for type character varying(6)
--
-- before the function's own logic ever ran. It stayed hidden because nothing
-- had ever written a sales row; persisting the sales register is what exposed
-- it.
--
-- The fix is the declaration only. The function's behaviour is unchanged: it
-- still refuses a write to a locked GSTIN + financial year + period, and still
-- names the period and GSTIN in the error.

CREATE OR REPLACE FUNCTION block_write_to_locked_period() RETURNS TRIGGER AS $$
DECLARE
    v_gstin INTEGER;
    v_fy    VARCHAR(9);
    -- Was VARCHAR(6). `period` is a YYYY-MM code everywhere in this schema
    -- (purchase_lines.period and sales_invoices.period are both VARCHAR(7)),
    -- so the variable could never hold the value it was handed.
    v_pr    VARCHAR(7);
BEGIN
    v_gstin := COALESCE(NEW.gstin_id, OLD.gstin_id);
    v_fy    := COALESCE(NEW.financial_year, OLD.financial_year);
    v_pr    := COALESCE(NEW.period, OLD.period);

    IF EXISTS (
        SELECT 1 FROM period_locks
        WHERE is_locked
          AND (gstin_id = v_gstin OR gstin_id IS NULL)
          AND financial_year = v_fy
          AND period = v_pr
    ) THEN
        RAISE EXCEPTION
            'Period % of GSTIN % is locked. Unlock it first if this change is intended.', v_pr, v_gstin
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION block_write_to_locked_period() IS
  'Refuses a write to a locked GSTIN + financial year + period. The period variable must be VARCHAR(7) because period codes are YYYY-MM.';