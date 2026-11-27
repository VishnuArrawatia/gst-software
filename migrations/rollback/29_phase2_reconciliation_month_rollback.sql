-- Rollback for Phase 2 Migration 29 (`29_phase2_reconciliation_month.sql`)
-- Safe additive rollback: drops index and column only; zero impact on book_* or 2B data.

DROP INDEX IF EXISTS idx_pl_recon_month;

ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS reconciliation_month;

DELETE FROM schema_migrations
 WHERE filename = '29_phase2_reconciliation_month.sql';
