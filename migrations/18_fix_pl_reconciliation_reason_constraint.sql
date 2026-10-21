-- 18_fix_pl_reconciliation_reason_constraint.sql
--
-- Fixes a constraint that made the module impossible to use.
--
-- Migration 17 declared:
--
--     CHECK (difference = 0 OR difference_reason IS NOT NULL)
--
-- That reads well — "a difference must carry a reason" — but it also forbids the
-- row the moment it is created. A freshly detected difference has no reason yet:
-- finding one is the work. So the reconciliation could not store its own work
-- queue, and every run died with:
--
--     new row for relation "pl_reconciliation" violates check constraint
--     "ck_plr_reason"
--
-- The intent was never "no reason may ever be empty". It was "a difference may
-- not be *closed* without one". Pending Review is precisely the open state, so
-- the constraint now reads:
--
--     a row may sit open (Pending Review), or it may have no difference, or it
--     must name a reason.
--
-- Nothing is relaxed that a reader of the data cares about: a row that is
-- Reconciled, Difference Explained or Difference Unresolved can never carry an
-- unexplained non-zero difference, and `setPlDifferenceReason` still refuses
-- such a write at the application layer too.

ALTER TABLE pl_reconciliation
  DROP CONSTRAINT IF EXISTS ck_plr_reason;

ALTER TABLE pl_reconciliation
  ADD CONSTRAINT ck_plr_reason CHECK (
    status = 'Pending Review'
    OR difference = 0
    OR difference_reason IS NOT NULL
  );

COMMENT ON CONSTRAINT ck_plr_reason ON pl_reconciliation IS
  'A difference may sit open as Pending Review, but it can never be closed without a reason from recon_difference_reasons.';