-- ===================================================================
-- REPAIR: restore the ACCOUNTS USER role.
--
-- Migration 08 originally deleted 'accounts user' along with the
-- superseded 'master administrator' name. Renaming to the same name is a
-- no-op, so the role was removed while three users still referenced it.
-- 08 has been corrected; this repairs databases that already ran it.
-- Idempotent, and a no-op on a fresh install.
-- ===================================================================

INSERT INTO roles (name, description) VALUES
  ('ACCOUNTS USER', 'Day-to-day GST work: import, reconcile, ITC decisions, follow-up and reports.')
ON CONFLICT (LOWER(name)) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON (p.resource, p.action) IN (
    ('company','view'), ('gstin','view'),
    ('data','import_purchase'), ('data','import_sales'), ('data','upload_2b'), ('data','import_excel'), ('data','run'),
    ('recon','view'), ('recon','edit'), ('recon','rereconcile'),
    ('itc','view'), ('itc','decide'),
    ('followup','view'), ('followup','edit'),
    ('report','view'), ('report','export'))
 WHERE LOWER(r.name) = 'accounts user'
ON CONFLICT (role_id, permission_id) DO NOTHING;
