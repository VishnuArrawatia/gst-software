-- 31_phase4_mismatch_reasons.sql
--
-- Phase 4 — Granular Mismatch Reasons & Multiple-Candidate Ambiguity Tracking
--   1. Adds `mismatch_reasons TEXT[] NOT NULL DEFAULT '{}'` on `purchase_lines`
--      to persist structured diagnostic tags (`LEADING_ZERO_INVOICE_DIFF`,
--      `MULTIPLE_CANDIDATES`, `SUPPLIER_GSTIN_DIFF`, `DOC_TYPE_MISMATCH_*`,
--      `TAXABLE_VALUE_DIFF`, `IGST_DIFF`, `CGST_DIFF`, `SGST_DIFF`, `UTGST_DIFF`,
--      `CESS_DIFF`, `INVOICE_VALUE_DIFF`, `DOCUMENT_DATE_DIFF`, `MISSING_IN_2B`).
--   2. Adds `candidate_count INTEGER NOT NULL DEFAULT 0` on `purchase_lines`
--      to flag ambiguous multi-candidate matches requiring explicit user confirmation.
--
-- 100% additive & idempotent. Zero modification to book_* or gstr2b_lines.

ALTER TABLE purchase_lines
  ADD COLUMN IF NOT EXISTS mismatch_reasons TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS candidate_count  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pl_mismatch_reasons_gin
  ON purchase_lines USING GIN (mismatch_reasons)
  WHERE cardinality(mismatch_reasons) > 0;
