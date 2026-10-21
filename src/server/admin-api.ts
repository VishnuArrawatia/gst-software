/**
 * GST CONTROL ERP — identity, company and user administration routes.
 *
 * These are mounted from server.ts. Authorisation lives here, on the server:
 * hiding a button in the UI is never treated as a permission check.
 */

import fs from 'fs';
import path from 'path';
import express from 'express';

import { withClient } from '../app/store';
import { can, login, logout, setPassword, type SessionUser } from '../app/auth';
import { generatePassword, hashPassword } from '../app/auth';

export const LOGO_DIR = path.join(process.cwd(), 'src', 'server', 'public', 'logos', 'companies');
const ALLOWED_LOGO = new Set(['png', 'jpg', 'jpeg', 'svg']);

export function str(v: unknown): string {
  return String(v ?? '').trim();
}
export function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? n : undefined;
}

/** Write one audit row. Never throws — an audit failure must not lose the change. */
export async function audit(
  actor: SessionUser | null,
  e: {
    action: string;
    module: string;
    company?: string | null;
    gstin?: string | null;
    period?: string | null;
    lineId?: number | null;
    invoiceNo?: string | null;
    field?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
    details?: unknown;
  },
): Promise<void> {
  try {
    await withClient((c) =>
      c.query(
        `INSERT INTO audit_trail
           (changed_by, user_id, action, module, company, our_gstin, period,
            line_id, invoice_no, field_name, old_value, new_value, reason, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          actor?.displayName ?? 'unknown',
          actor?.id ?? null,
          e.action,
          e.module,
          e.company ?? null,
          e.gstin ?? null,
          e.period ?? null,
          e.lineId ?? null,
          e.invoiceNo ?? null,
          e.field ?? null,
          e.oldValue == null ? null : String(e.oldValue),
          e.newValue == null ? null : String(e.newValue),
          e.reason ?? null,
          e.details ? JSON.stringify(e.details) : null,
        ],
      ),
    );
  } catch (err: any) {
    // The operation must still succeed — an audit write is not worth failing a
    // download over. It must not succeed SILENTLY, though: `action` was
    // VARCHAR(20) and every action name longer than that was dropped here while
    // the request still returned 200, so a class of events looked audited and
    // was not. Log, so the next one is visible.
    console.error(`[audit] "${e.action}" not recorded: ${err?.message || err}`);
  }
}

export function registerAdminRoutes(app: express.Express, requirePerm: (r: string, a: string) => any) {
  const wrap =
    (fn: (req: any, res: any) => Promise<unknown>) =>
    (req: any, res: any) => {
      fn(req, res).catch((e) => res.status(500).json({ error: e.message }));
    };

  // ---------------------------------------------------------------- login
  app.post('/api/auth/login', wrap(async (req, res) => {
    const username = str(req.body?.username);
    const password = str(req.body?.password);
    const result = await login(username, password, str(req.ip), String(req.headers['user-agent'] || ''));
    if ('reason' in result) {
      await audit(null, { action: 'LOGIN_FAILED', module: 'Auth', field: username, newValue: 'rejected' });
      return res.status(401).json({ error: result.reason });
    }
    await audit(result.user, { action: 'LOGIN', module: 'Auth', newValue: result.token.slice(0, 8) });
    res.setHeader(
      'Set-Cookie',
      `gst_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`,
    );
    res.json({ ok: true, user: result.user });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    const raw = String(req.headers.cookie || '');
    const m = /gst_session=([^;]+)/.exec(raw);
    await logout(m ? decodeURIComponent(m[1]) : null);
    await audit(req.user, { action: 'LOGOUT', module: 'Auth' });
    res.setHeader('Set-Cookie', 'gst_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', wrap(async (req, res) => {
    res.json({ user: req.user });
  }));

  app.post('/api/auth/change-password', wrap(async (req, res) => {
    const current = str(req.body?.current);
    const next = str(req.body?.next);
    const fresh = await login(str(req.user.username), current);
    if ('reason' in fresh) return res.status(400).json({ error: 'Current password is wrong.' });
    const r = await setPassword(req.user.id, next);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    await logout(fresh.token);
    await audit(req.user, { action: 'PASSWORD_CHANGE', module: 'Auth' });
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  }));

  // ------------------------------------------------------------ companies
  app.get('/api/companies', requirePerm('company', 'view'), wrap(async (req, res) => {
    const rows = await withClient((c) =>
      c.query(
        `SELECT c.id, c.name, c.short_name, c.legal_name, c.tax_identifier, c.address,
                c.status, c.logo_file, c.logo_mime, c.logo_updated_at,
                (SELECT count(*)::int FROM gstins g WHERE g.company_id = c.id) AS gstin_count
           FROM companies c ORDER BY c.name`,
      ),
    );
    // Never leak a company the caller has not been granted.
    const allow = req.user.companyIds;
    const visible = allow === null ? rows.rows : rows.rows.filter((r: any) => allow.includes(r.id));
    res.json({ companies: visible });
  }));

  app.post('/api/companies', requirePerm('company', 'create'), wrap(async (req, res) => {
    const name = str(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Company name is required.' });
    const r = await withClient(async (c) => {
      const q = await c.query(
        `INSERT INTO companies (name, short_name, legal_name, tax_identifier, address, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [name, str(req.body?.shortName) || null, str(req.body?.legalName) || null,
         str(req.body?.pan) || null, str(req.body?.address) || null, req.user.id],
      );
      await audit(req.user, { action: 'COMPANY_CREATE', module: 'Company', newValue: name, details: req.body });
      return q;
    });
    res.json({ ok: true, id: r.rows[0].id });
  }));

  app.post('/api/companies/:id', requirePerm('company', 'edit'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const before = await withClient((c) => c.query('SELECT * FROM companies WHERE id = $1', [id]));
    if (!before.rowCount) return res.status(404).json({ error: 'company not found' });
    const fields: Record<string, any> = {
      name: str(req.body?.name),
      short_name: str(req.body?.shortName),
      legal_name: str(req.body?.legalName),
      tax_identifier: str(req.body?.pan),
      address: str(req.body?.address),
    };
    const sets = Object.keys(fields).filter((k) => fields[k] !== '');
    await withClient(async (c) => {
      await c.query(
        `UPDATE companies SET ${sets.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${sets.length + 2},
                updated_at = now() WHERE id = $1`,
        [id, ...sets.map((k) => fields[k]), req.user.id],
      );
    });
    const after = await withClient((c) => c.query('SELECT * FROM companies WHERE id = $1', [id]));
    const b = before.rows[0]; const a = after.rows[0];
    for (const k of Object.keys(fields)) {
      if (String(b[k] ?? '') !== String(a[k] ?? '')) {
        await audit(req.user, {
          action: 'COMPANY_EDIT', module: 'Company', field: k,
          oldValue: b[k], newValue: a[k], company: a.name,
        });
      }
    }
    res.json({ ok: true });
  }));

  app.post('/api/companies/:id/status', requirePerm('company', 'disable'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const status = Number(req.body?.status) === 1 ? 1 : 0;
    const r = await withClient((c) => c.query('UPDATE companies SET status = $1, updated_by = $2 WHERE id = $3', [status, req.user.id, id]));
    if (!r.rowCount) return res.status(404).json({ error: 'company not found' });
    await audit(req.user, { action: status ? 'COMPANY_ENABLE' : 'COMPANY_DISABLE', module: 'Company', newValue: status });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ logo
  app.post('/api/companies/:id/logo', requirePerm('company', 'logo'),
    express.raw({ type: '*/*', limit: '8mb' }),
    wrap(async (req, res) => {
      const id = num(req.params.id);
      const name = path.basename(str(req.query.name) || 'logo');
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_LOGO.has(ext)) {
        return res.status(400).json({ error: 'Logo must be PNG, JPG, JPEG or SVG.' });
      }
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty upload.' });
      // Trust the extension only after the bytes agree with it.
      if (ext === 'png' && buf.slice(1, 4).toString() !== 'PNG') {
        return res.status(400).json({ error: 'That file is not a PNG.' });
      }
      if ((ext === 'jpg' || ext === 'jpeg') && buf.slice(0, 2).toString('hex') !== 'ffd8') {
        return res.status(400).json({ error: 'That file is not a JPEG.' });
      }
      if (ext === 'svg' && !/<svg[\s>]/i.test(buf.slice(0, 2048).toString('utf8'))) {
        return res.status(400).json({ error: 'That file is not an SVG.' });
      }

      fs.mkdirSync(LOGO_DIR, { recursive: true });
      const file = `company-${id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(LOGO_DIR, file), buf);

      // Drop the previous logo so uploads do not accumulate on disk.
      const prev = await withClient((c) => c.query('SELECT logo_file FROM companies WHERE id = $1', [id]));
      const old = prev.rows[0]?.logo_file;
      if (old) { try { fs.unlinkSync(path.join(LOGO_DIR, old)); } catch { /* already gone */ } }

      await withClient((c) =>
        c.query(
          `UPDATE companies SET logo_file = $1, logo_mime = $2, logo_updated_at = now(), logo_updated_by = $3
            WHERE id = $4`,
          [file, `image/${ext === 'svg' ? 'svg+xml' : ext}`, req.user.id, id],
        ));
      await audit(req.user, { action: 'COMPANY_LOGO', module: 'Company', newValue: file });
      res.json({ ok: true, url: `/logos/companies/${file}` });
    }));

  // ----------------------------------------------------------------- users
  app.get('/api/gstins', requirePerm('company', 'view'), wrap(async (req, res) => {
    const rows = await withClient((c) =>
      c.query(
        `SELECT g.id, g.gstin_number, g.company_id, g.status, g.legal_name,
                c.name AS company_name, c.short_name, u.name AS unit_name
           FROM gstins g
           JOIN companies c ON c.id = g.company_id
           LEFT JOIN units u ON u.id = g.unit_id
          ORDER BY c.name, g.gstin_number`,
      ),
    );
    const allow = req.user.gstinIds;
    const visible = allow === null
      ? rows.rows
      : rows.rows.filter((r: any) => allow.includes(r.id));
    res.json({ gstins: visible });
  }));

  app.get('/api/admin/users', requirePerm('user', 'view'), wrap(async (req, res) => {
    const rows = await withClient((c) =>
      c.query(
        `SELECT u.id, u.username, u.display_name, u.email, u.mobile, u.status,
                u.last_login_at, u.created_at, u.must_change_password,
                coalesce((SELECT string_agg(r.name, ', ') FROM user_roles ur
                            JOIN roles r ON r.id = ur.role_id
                           WHERE ur.user_id = u.id), '') AS roles,
                (SELECT count(*)::int FROM user_company_access a WHERE a.user_id = u.id) AS company_count,
                (SELECT count(*)::int FROM user_gstin_access g WHERE g.user_id = u.id) AS gstin_count,
                coalesce((SELECT array_agg(a.company_id ORDER BY a.company_id)
                            FROM user_company_access a WHERE a.user_id = u.id), '{}') AS company_ids,
                coalesce((SELECT array_agg(g.gstin_id ORDER BY g.gstin_id)
                            FROM user_gstin_access g WHERE g.user_id = u.id), '{}') AS gstin_ids
           FROM users u ORDER BY (u.username = 'MASTER') DESC, u.id`,
      ),
    );
    res.json({ users: rows.rows });
  }));

  app.get('/api/admin/roles', requirePerm('user', 'view'), wrap(async (req, res) => {
    const roles = await withClient((c) => c.query('SELECT id, name, description FROM roles ORDER BY name'));
    const perms = await withClient((c) =>
      c.query(`SELECT r.name, p.resource, p.action FROM role_permissions rp
                 JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id`));
    res.json({
      roles: roles.rows.map((r: any) => ({
        ...r,
        permissions: perms.rows.filter((p: any) => p.name === r.name).map((p: any) => `${p.resource}.${p.action}`),
      })),
      catalogue: [...new Set(perms.rows.map((p: any) => `${p.resource}.${p.action}`))].sort(),
    });
  }));

  app.post('/api/admin/users', requirePerm('user', 'create'), wrap(async (req, res) => {
    const username = str(req.body?.username).toUpperCase();
    const email = str(req.body?.email);
    if (!username) return res.status(400).json({ error: 'Login ID is required.' });
    if (!email) return res.status(400).json({ error: 'Email is required (it is the unique key).' });
    const dupe = await withClient((c) => c.query('SELECT id FROM users WHERE UPPER(username) = UPPER($1)', [username]));
    if (dupe.rowCount) return res.status(409).json({ error: 'That login ID already exists.' });

    const password = str(req.body?.password) || generatePassword(14);
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const role = str(req.body?.role) || 'ACCOUNTS USER';

    const out = await withClient(async (c) => {
      const ins = await c.query(
        `INSERT INTO users (username, email, display_name, mobile, password_hash, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,'active',true) RETURNING id`,
        [username, email, str(req.body?.displayName) || username, str(req.body?.mobile) || null, hashPassword(password)],
      );
      const id = ins.rows[0].id;
      await c.query(
        'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE LOWER(name) = LOWER($2)',
        [id, role],
      );
      for (const cid of Array.isArray(req.body?.companyIds) ? req.body.companyIds : []) {
        await c.query(
          'INSERT INTO user_company_access (user_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, Number(cid)],
        );
      }
      return { id, password };
    });
    await audit(req.user, { action: 'USER_CREATE', module: 'User', newValue: username, details: { role } });
    res.json({ ok: true, id: out.id, password: out.password, message: 'Password shown once.' });
  }));

  app.post('/api/admin/users/:id', requirePerm('user', 'edit'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const before = await withClient((c) => c.query('SELECT * FROM users WHERE id = $1', [id]));
    if (!before.rowCount) return res.status(404).json({ error: 'user not found' });
    // MASTER is never renamed or re-roled by anyone.
    const isMaster = String(before.rows[0].username).toUpperCase() === 'MASTER';
    const username = isMaster
      ? before.rows[0].username
      : (str(req.body?.username) || before.rows[0].username).toUpperCase();

    await withClient(async (c) => {
      await c.query(
        `UPDATE users SET username = $1, display_name = $2, email = $3, mobile = $4, updated_at = now()
          WHERE id = $5`,
        [username, str(req.body?.displayName) || before.rows[0].display_name,
         str(req.body?.email) || before.rows[0].email, str(req.body?.mobile) || null, id],
      );
      const role = str(req.body?.role);
      if (role && !isMaster) {
        await c.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
        await c.query(
          'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE LOWER(name) = LOWER($2)',
          [id, role],
        );
      }
    });

    const after = await withClient((c) => c.query('SELECT * FROM users WHERE id = $1', [id]));
    for (const k of ['username', 'display_name', 'email', 'mobile']) {
      if (String(before.rows[0][k] ?? '') !== String(after.rows[0][k] ?? '')) {
        await audit(req.user, {
          action: 'USER_EDIT', module: 'User', field: k,
          oldValue: before.rows[0][k], newValue: after.rows[0][k],
        });
      }
    }
    if (str(req.body?.role) && !isMaster) {
      await audit(req.user, { action: 'ROLE_CHANGE', module: 'User', newValue: str(req.body?.role) });
    }
    res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/status', requirePerm('user', 'disable'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const before = await withClient((c) => c.query('SELECT username FROM users WHERE id = $1', [id]));
    if (!before.rowCount) return res.status(404).json({ error: 'user not found' });
    if (String(before.rows[0].username).toUpperCase() === 'MASTER') {
      return res.status(403).json({ error: 'The MASTER account cannot be disabled.' });
    }
    const status = str(req.body?.status) === 'inactive' ? 'inactive' : 'active';
    await withClient((c) => c.query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2', [status, id]));
    // Disabling must end any live session that account holds.
    if (status === 'inactive') await withClient((c) => c.query('DELETE FROM login_sessions WHERE user_id = $1', [id]));
    await audit(req.user, {
      action: status === 'active' ? 'USER_ENABLE' : 'USER_DISABLE',
      module: 'User', newValue: before.rows[0].username,
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/reset-password', requirePerm('user', 'reset_password'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const password = str(req.body?.password) || generatePassword(14);
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const r = await withClient((c) =>
      c.query(
        `UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2`,
        [hashPassword(password), id],
      ));
    if (!r.rowCount) return res.status(404).json({ error: 'user not found' });
    await withClient((c) => c.query('DELETE FROM login_sessions WHERE user_id = $1', [id]));
    await audit(req.user, { action: 'PASSWORD_RESET', module: 'User', newValue: id });
    res.json({ ok: true, password, message: 'Password shown once.' });
  }));

  app.post('/api/admin/users/:id/access', requirePerm('user', 'access'), wrap(async (req, res) => {
    const id = num(req.params.id);
    const before = await withClient((c) => c.query('SELECT username FROM users WHERE id = $1', [id]));
    if (!before.rowCount) return res.status(404).json({ error: 'user not found' });
    if (String(before.rows[0].username).toUpperCase() === 'MASTER') {
      return res.json({ ok: true, note: 'MASTER always has access to everything.' });
    }
    const companyIds = (Array.isArray(req.body?.companyIds) ? req.body.companyIds : []).map(Number);
    const gstinIds = (Array.isArray(req.body?.gstinIds) ? req.body.gstinIds : []).map(Number);
    await withClient(async (c) => {
      await c.query('DELETE FROM user_company_access WHERE user_id = $1', [id]);
      await c.query('DELETE FROM user_gstin_access WHERE user_id = $1', [id]);
      for (const cid of companyIds) {
        await c.query(
          'INSERT INTO user_company_access (user_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, cid],
        );
      }
      for (const gid of gstinIds) {
        await c.query(
          'INSERT INTO user_gstin_access (user_id, gstin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, gid],
        );
      }
    });
    // Access changed: end live sessions so the new scope applies at next login.
    await withClient((c) => c.query('DELETE FROM login_sessions WHERE user_id = $1', [id]));
    await audit(req.user, {
      action: 'ACCESS_CHANGE', module: 'User',
      newValue: before.rows[0].username, details: { companyIds, gstinIds },
    });
    res.json({ ok: true });
  }));
}
