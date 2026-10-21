-- ===================================================================
-- ACCOUNTS USER gets the sales side too.
--
-- The Sales Register and Portal GSTR-1 cards, and the two sales template
-- downloads behind them, are gated on data.import_sales. Migration 08 gave that
-- permission to SUPER ADMIN only, so the accounts team (USER-1, USER-2, USER-3)
-- could download every purchase template but got "not allowed" on the sales
-- ones — the same month's work, refused halfway.
--
-- The accounts team works both registers, so grant it to their role as well.
-- Purchase-side permissions (import_purchase, upload_2b, import_excel) are
-- already theirs; nothing is revoked here and no data is touched.
-- Idempotent, and a no-op on a fresh install that ran migration 08 corrected.
-- ===================================================================

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON (p.resource, p.action) = ('data', 'import_sales')
 WHERE LOWER(r.name) = 'accounts user'
ON CONFLICT (role_id, permission_id) DO NOTHING;
