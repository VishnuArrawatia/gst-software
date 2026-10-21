-- ===================================================================
-- USERS AND ROLES — the accounts team, plus an audit-trigger fix.
-- ===================================================================

-- The audit trigger from migration 01 assumed every audited table has an
-- `id` column. The junction tables (user_roles, role_permissions) have a
-- composite key instead, so inserting into them raised
-- `record "new" has no field "id"`. Resolve the entity id from the JSON
-- instead, with a fallback for the junction tables.
CREATE OR REPLACE FUNCTION fn_audit_log() RETURNS TRIGGER AS $$
DECLARE
  v_user_id   INTEGER;
  v_entity_id INTEGER;
  v_json      JSONB;
BEGIN
  BEGIN
    v_user_id := current_setting('app.current_user_id')::INTEGER;
  EXCEPTION
    WHEN OTHERS THEN
      v_user_id := NULL;
  END;

  IF TG_OP = 'DELETE' THEN
    v_json := to_jsonb(OLD);
  ELSE
    v_json := to_jsonb(NEW);
  END IF;

  v_entity_id := NULLIF(v_json ->> 'id', '')::INTEGER;
  IF v_entity_id IS NULL THEN
    v_entity_id := COALESCE(NULLIF(v_json ->> 'user_id', '')::INTEGER,
                            NULLIF(v_json ->> 'role_id', '')::INTEGER);
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (v_user_id, 'INSERT', TG_TABLE_NAME, v_entity_id, NULL, v_json);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (v_user_id, 'UPDATE', TG_TABLE_NAME, v_entity_id, to_jsonb(OLD), v_json);
    RETURN NEW;
  ELSE
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (v_user_id, 'DELETE', TG_TABLE_NAME, v_entity_id, v_json, NULL);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------------
-- One master user (the owner) plus three team users.
--
-- No password is set here: login does not exist yet, so every account
-- carries the sentinel LOGIN_NOT_ENABLED rather than a hash that could
-- later be mistaken for a real one. Enabling login must replace this.
-- Idempotent: re-running only fills in what is missing.
-- -------------------------------------------------------------------

INSERT INTO roles (name, description) VALUES
  ('Master Administrator', 'Owner of the system. Full control, including month unlock and user management.'),
  ('Accounts User',        'Works on purchase, 2B, reconciliation, ITC decisions and supplier follow-up.')
ON CONFLICT (LOWER(name)) DO NOTHING;

INSERT INTO users (email, username, display_name, password_hash, status) VALUES
  ('master@sakar.local',  'master',  'Master User', 'LOGIN_NOT_ENABLED', 'active'),
  ('user1@sakar.local',   'user-1',  'User-1',      'LOGIN_NOT_ENABLED', 'active'),
  ('user2@sakar.local',   'user-2',  'User-2',      'LOGIN_NOT_ENABLED', 'active'),
  ('user3@sakar.local',   'user-3',  'User-3',      'LOGIN_NOT_ENABLED', 'active')
ON CONFLICT (LOWER(email)) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
  FROM users u JOIN roles r ON r.name = 'Master Administrator'
 WHERE LOWER(u.username) = 'master'
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
 WHERE r.name = 'Accounts User'
   AND LOWER(u.username) IN ('user-1', 'user-2', 'user-3')
ON CONFLICT (user_id, role_id) DO NOTHING;

COMMENT ON COLUMN users.password_hash IS
  'Sentinel LOGIN_NOT_ENABLED until login is implemented; never a usable hash.';
