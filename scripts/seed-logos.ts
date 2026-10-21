/**
 * Attach the bundled company logos to the company master.
 *
 * Safe to re-run: it only sets logo_file when the company has none, so a logo
 * MASTER uploads later is never overwritten.
 */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { LOGO_DIR } from '../src/server/admin-api';

loadEnv();

/** Matched on the company's stored name; short names are ignored. */
const LOGOS: Array<{ match: RegExp; file: string }> = [
  { match: /sakar/i, file: 'sakar.png' },
  { match: /semo/i, file: 'semo.png' },
];

const main = async () => {
  const src = path.join(process.cwd(), 'src', 'server', 'public', 'logos');
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const c = new Client(pgConfig());
  await c.connect();
  const rows = await c.query('SELECT id, name, logo_file FROM companies ORDER BY name');

  for (const co of rows.rows) {
    if (co.logo_file) { console.log(`  skip    ${co.name} (already has a logo)`); continue; }
    const hit = LOGOS.find((l) => l.match.test(String(co.name)));
    const from = hit ? path.join(src, hit.file) : '';
    if (!hit || !fs.existsSync(from)) { console.log(`  none    ${co.name}`); continue; }
    const file = `company-${co.id}-seed.png`;
    fs.copyFileSync(from, path.join(LOGO_DIR, file));
    await c.query(
      `UPDATE companies SET logo_file = $1, logo_mime = 'image/png', logo_updated_at = now() WHERE id = $2`,
      [file, co.id],
    );
    console.log(`  logo    ${co.name} <- ${hit.file}`);
  }
  await c.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
