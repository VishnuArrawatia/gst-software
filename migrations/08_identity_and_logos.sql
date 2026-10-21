-- ===================================================================
-- IDENTITY, ROLES, ACCESS AND COMPANY LOGOS
--
-- Additive only: every change below adds a column or a new table.
-- Nothing existing is dropped, renamed or retyped.
-- ===================================================================

-- ---- Company master: the fields a company profile needs ------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS short_name      VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address         TEXT;
-- Logo is stored as a file under src/server/public/logos/companies/;
-- only the file name is kept here, never the bytes.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_file       VARCHAR(200);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_mime       VARCHAR(60);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN companies.logo_file IS
  'File name under src/server/public/logos/companies/, or NULL for the built-in placeholder.';

-- ---- Users: mobile, and force a password change on first login ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- ---- Audit trail: who did it, and in which module ------------------------
ALTER TABLE audit_trail ADD COLUMN IF NOT EXISTS user_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_trail ADD COLUMN IF NOT EXISTS module VARCHAR(40);

COMMENT ON COLUMN audit_trail.user_id IS
  'The logged-in account. NULL for changes made before login existed.';

-- ---- Who may see which company / which GSTIN ----------------------------
CREATE TABLE IF NOT EXISTS user_company_access (
    user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_uca_company ON user_company_access (company_id);

CREATE TABLE IF NOT EXISTS user_gstin_access (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gstin_id  INTEGER NOT NULL REFERENCES gstins(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, gstin_id)
);
CREATE INDEX IF NOT EXISTS idx_uga_gstin ON user_gstin_access (gstin_id);

COMMENT ON TABLE user_gstin_access IS
  'GSTIN-level access. A user with no rows here inherits every GSTIN of the companies granted in user_company_access.';

-- ---- Login sessions ------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_sessions (
    token       CHAR(64) PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    ip_address  TEXT,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON login_sessions (expires_at);

-- ===================================================================
-- ROLES
-- ===================================================================
INSERT INTO roles (name, description) VALUES
  ('SUPER ADMIN',        'Unrestricted control of the application, including users, companies and month unlock.'),
  ('ACCOUNTS USER',      'Day-to-day GST work: import, reconcile, ITC decisions, follow-up and reports.'),
  ('ACCOUNTS REVIEWER',  'Read and review. Exports reports and adds remarks, but changes no master data.')
ON CONFLICT (LOWER(name)) DO NOTHING;

-- Migration 07 created 'Master Administrator' and 'Accounts User'. Move the
-- existing assignments onto the canonical roles, then drop the old rows.
UPDATE user_roles SET role_id = (SELECT id FROM roles WHERE LOWER(name) = 'super admin')
 WHERE role_id IN (SELECT id FROM roles WHERE LOWER(name) = 'master administrator')
   AND NOT EXISTS (
     SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = user_roles.user_id AND LOWER(r.name) = 'super admin');

DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE LOWER(name) = 'master administrator');
DELETE FROM user_roles
 WHERE role_id = (SELECT id FROM roles WHERE LOWER(name) = 'master administrator');
DELETE FROM roles WHERE LOWER(name) = 'master administrator';

-- ===================================================================
-- PERMISSIONS — resource.action, so new roles can be added later without
-- changing any code.
-- ===================================================================
INSERT INTO permissions (resource, action, description) VALUES
  ('company','view','See the company master'),
  ('company','create','Add a company'),
  ('company','edit','Edit a company'),
  ('company','disable','Disable or enable a company'),
  ('company','logo','Upload or replace a company logo'),
  ('gstin','view','See GSTINs and units'),
  ('gstin','manage','Add or edit GSTINs'),
  ('user','view','See the user master'),
  ('user','create','Create a user'),
  ('user','edit','Edit a user, including display name and role'),
  ('user','disable','Disable or enable a user'),
  ('user','reset_password','Reset another user''s password'),
  ('user','assign_role','Assign or change a role'),
  ('user','permissions','Change a role''s permissions'),
  ('user','access','Grant or revoke company and GSTIN access'),
  ('data','import_purchase','Import the purchase register'),
  ('data','import_sales','Import the sales register'),
  ('data','upload_2b','Upload GSTR-2B'),
  ('data','import_excel','Import a worked-on Excel or CSV file'),
  ('data','run','Run the reconciliation'),
  ('recon','view','View the purchase reconciliation'),
  ('recon','edit','Edit reconciliation fields'),
  ('recon','rereconcile','Save and re-reconcile'),
  ('itc','view','View ITC working'),
  ('itc','decide','Take an ITC decision and claim month'),
  ('followup','view','View supplier follow-up'),
  ('followup','edit','Record follow-up, response and remarks'),
  ('report','view','View reports'),
  ('report','export','Export Excel or CSV'),
  ('control','lock','Lock a GST month'),
  ('control','unlock','Unlock a GST month (admin only)'),
  ('control','audit','View the audit trail'),
  ('control','correction','Correct stored data'),
  ('settings','system','Change system settings')
ON CONFLICT (resource, action) DO NOTHING;

-- SUPER ADMIN gets everything.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE LOWER(r.name) = 'super admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ACCOUNTS USER: the day-to-day GST work, and nothing administrative.
-- Both registers: the accounts team downloads the Sales and the Purchase
-- templates from the same seat, so `import_sales` belongs here with
-- `import_purchase`.
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

-- ACCOUNTS REVIEWER: read, review, export, add remarks. No edits, no unlock.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON (p.resource, p.action) IN (
    ('company','view'), ('gstin','view'),
    ('recon','view'), ('itc','view'),
    ('followup','view'), ('followup','edit'),
    ('report','view'), ('report','export'), ('control','audit'))
 WHERE LOWER(r.name) = 'accounts reviewer'
ON CONFLICT (role_id, permission_id) DO NOTHING;
