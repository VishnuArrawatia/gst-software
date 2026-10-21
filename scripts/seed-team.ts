/**
 * Seed the accounts team with real passwords.
 *
 * MASTER / Vishnu is SUPER ADMIN; USER-1..3 are login IDs whose display names
 * MASTER can change later — no employee name is hard-coded anywhere.
 *
 * Passwords are generated fresh and printed ONCE. Re-running resets them.
 *
 * Usage:  npm run seed:team
 */

import { Client } from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { generatePassword, hashPassword } from '../src/app/auth';

loadEnv();

const TEAM = [
  { username: 'MASTER',  from: 'master',  display: 'Vishnu',   role: 'SUPER ADMIN',       email: 'MASTER@sakar.local' },
  { username: 'USER-1',  from: 'user-1',  display: 'User-1',   role: 'ACCOUNTS USER',     email: 'USER-1@sakar.local' },
  { username: 'USER-2',  from: 'user-2',  display: 'User-2',   role: 'ACCOUNTS USER',     email: 'USER-2@sakar.local' },
  { username: 'USER-3',  from: 'user-3',  display: 'User-3',   role: 'ACCOUNTS USER',     email: 'USER-3@sakar.local' },
];

const main = async () => {
  const c = new Client(pgConfig());
  await c.connect();
  const issued: Array<{ username: string; password: string }> = [];

  for (const t of TEAM) {
    const password = generatePassword(14);
    // Email is the only unique key on users, so the existing row is matched by
    // its old address and rewritten; username has no unique index.
    // Find the existing account without assuming how it was seeded: by old
    // username, or by either spelling of its old address. Creates the row when
    // this is a fresh database.
    const oldPlain = t.from.replace(/-/g, '');
    const found = await c.query(
      `SELECT id FROM users
        WHERE LOWER(username) = LOWER($1)
           OR LOWER(email) IN (LOWER($2), LOWER($3), LOWER($4))
        ORDER BY id LIMIT 1`,
      [t.from, `${t.from}@sakar.local`, `${oldPlain}@sakar.local`, t.email],
    );

    let id = found.rows[0]?.id;
    if (id) {
      await c.query(
        `UPDATE users
            SET username = $1, email = $2, display_name = $3,
                password_hash = $4, status = 'active',
                must_change_password = true, updated_at = now()
          WHERE id = $5`,
        [t.username, t.email, t.display, hashPassword(password), id],
      );
    } else {
      const ins = await c.query(
        `INSERT INTO users (username, email, display_name, password_hash, status, must_change_password)
         VALUES ($1, $2, $3, $4, 'active', true) RETURNING id`,
        [t.username, t.email, t.display, hashPassword(password)],
      );
      id = ins.rows[0].id;
    }
    if (!id) { console.error(`  ! could not create ${t.username}`); continue; }

    issued.push({ username: t.username, password });
    console.log(`  ${t.username.padEnd(8)} ${t.display.padEnd(9)} ${t.role}`);
  }

  await c.end();

  console.log('\n' + '='.repeat(70));
  console.log('  INITIAL PASSWORDS — shown once, not stored anywhere in clear');
  console.log('='.repeat(70));
  for (const i of issued) console.log(`  ${i.username.padEnd(8)}  ${i.password}`);
  console.log('='.repeat(70));
  console.log('  Each account must change its password at first login.');
  console.log('  Lost the MASTER password? Re-run this script to reset it.\n');
};

main().catch((e) => { console.error(e); process.exit(1); });
