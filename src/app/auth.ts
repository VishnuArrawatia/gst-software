/**
 * GST CONTROL ERP — identity.
 *
 * Passwords are stored as scrypt hashes and never leave this module. A
 * session is an opaque random token held in login_sessions and carried in an
 * HttpOnly cookie, so the page's JavaScript cannot read it.
 */

import crypto from 'crypto';
import type { Client } from 'pg';
import { withClient } from './store';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** `scrypt$N$r$p$<salt hex>$<hash hex>` */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time compare; never leaks how much of the hash matched. */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const key = crypto.scryptSync(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** A password a human can retype; avoids characters that break shells and CSV. */
export function generatePassword(len = 14): string {
  // Ambiguous glyphs (0/O, 1/l/I) are left out on purpose.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const SESSION_HOURS = 12;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  mobile: string | null;
  status: string;
  isSuperAdmin: boolean;
  /** Primary role name, e.g. ACCOUNTS USER. */
  role: string;
  roles: string[];
  /** 'resource.action' strings. */
  permissions: string[];
  /** Null means every company (SUPER ADMIN). */
  companyIds: number[] | null;
  gstinIds: number[] | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

export function can(u: SessionUser | null, resource: string, action: string): boolean {
  if (!u) return false;
  return u.permissions.includes(`${resource}.${action}`);
}

/** Load a user with roles, permissions and access. Throws when the id is unknown. */
export async function loadUser(c: Client, id: number): Promise<SessionUser> {
  const u = await c.query(
    `SELECT id, username, display_name, email, mobile, status, last_login_at, must_change_password
       FROM users WHERE id = $1`,
    [id],
  );
  if (!u.rowCount) throw new Error('user not found');
  const row = u.rows[0];

  const r = await c.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 ORDER BY r.name`,
    [id],
  );
  const roles: string[] = r.rows.map((x: any) => x.name);

  const p = await c.query(
    `SELECT DISTINCT p.resource || '.' || p.action AS k
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [id],
  );
  const permissions: string[] = p.rows.map((x: any) => x.k);

  const isSuperAdmin = roles.includes('SUPER ADMIN');

  const ca = await c.query('SELECT company_id FROM user_company_access WHERE user_id = $1 ORDER BY company_id', [id]);
  const ga = await c.query('SELECT gstin_id FROM user_gstin_access WHERE user_id = $1 ORDER BY gstin_id', [id]);

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
    isSuperAdmin,
    role: roles[0] || 'ACCOUNTS USER',
    roles,
    permissions,
    // No rows at all means "all companies" — that is how SUPER ADMIN is granted
    // everything without a row per company.
    companyIds: ca.rowCount ? ca.rows.map((x: any) => x.company_id) : null,
    gstinIds: ga.rowCount ? ga.rows.map((x: any) => x.gstin_id) : null,
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    mustChangePassword: row.must_change_password === true,
  };
}

/** Verify a login. Returns the session token, or a reason it failed. */
export async function login(
  username: string,
  password: string,
  ip?: string,
  userAgent?: string,
): Promise<{ ok: true; token: string; user: SessionUser } | { ok: false; reason: string }> {
  const uname = String(username || '').trim();

  const found = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, password_hash, status FROM users WHERE UPPER(username) = UPPER($1)`,
      [uname],
    );
    return r.rows[0] as { id: number; password_hash: string; status: string } | undefined;
  });
  if (!found) return { ok: false, reason: 'Username or password is wrong.' };
  if (found.status === 'locked') return { ok: false, reason: 'This account is locked.' };
  if (!verifyPassword(password, found.password_hash)) {
    return { ok: false, reason: 'Username or password is wrong.' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);

  const user = await withClient(async (c) => {
    await c.query(
      `INSERT INTO login_sessions (token, user_id, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, found.id, expires, ip ?? null, (userAgent ?? '').slice(0, 300)],
    );
    await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [found.id]);
    return loadUser(c, found.id);
  });

  return { ok: true, token, user };
}

/** Resolve a session token to its user, or null when absent/expired. */
export async function userFromToken(token?: string | null): Promise<SessionUser | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT s.user_id FROM login_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [token],
    );
    if (!r.rowCount) return null;
    await c.query(`UPDATE login_sessions SET last_seen_at = now() WHERE token = $1`, [token]);
    return loadUser(c, r.rows[0].user_id);
  });
}

export async function logout(token?: string | null): Promise<void> {
  if (!token) return;
  await withClient((c) => c.query('DELETE FROM login_sessions WHERE token = $1', [token]));
}

/** Change a password, refusing to accept an empty or too-short one. */
export async function setPassword(userId: number, plain: string): Promise<{ ok: boolean; reason?: string }> {
  if (String(plain || '').length < 8) return { ok: false, reason: 'Password must be at least 8 characters.' };
  await withClient((c) =>
    c.query(
      `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
      [hashPassword(plain), userId],
    ),
  );
  return { ok: true };
}

/** Housekeeping: drop sessions that have expired. */
export async function purgeExpiredSessions(): Promise<number> {
  const r = await withClient((c) => c.query('DELETE FROM login_sessions WHERE expires_at < now()'));
  return r.rowCount ?? 0;
}
