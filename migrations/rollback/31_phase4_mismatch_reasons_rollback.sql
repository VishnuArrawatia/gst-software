-- Rollback for Phase 4 Migration 31 (`31_phase4_mismatch_reasons.sql`)
-- Safe additive rollback: drops index and columns only.

DROP INDEX IF EXISTS idx_pl_mismatch_reasons_gin;

ALTER TABLE purchase_lines
  DROP COLUMN IF EXISTS candidate_count,
  DROP COLUMN IF EXISTS mismatch_reasons;

DELETE FROM schema_migrations
 WHERE filename = '31_phase4_mismatch_reasons.sql';
