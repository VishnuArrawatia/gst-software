-- Migration 20 — GSTR-1 table 9B (CDNUR).
--
-- Credit / debit notes issued to UNREGISTERED recipients belong in table 9B
-- (CDNUR), never in 9A (CDNR): the portal groups 9A by the recipient's GSTIN,
-- and an unregistered note has no GSTIN to group on. Without this enum value a
-- drafted CDNUR row cannot be stored at all — every insert fails the enum cast.
--
-- Additive: ADD VALUE only appends to the enum, so no existing row changes
-- meaning and no constraint needs rewriting. PostgreSQL 12+ permits this inside
-- the migration runner's transaction as long as the new value is not USED in the
-- same transaction — which is exactly why nothing below inserts a CDNUR row.

ALTER TYPE gstr1_table_type ADD VALUE IF NOT EXISTS 'CDNUR';
