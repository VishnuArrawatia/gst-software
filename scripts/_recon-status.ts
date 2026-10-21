import { loadEnv, pgConfig } from '../src/config/env';
import { Client } from 'pg';

loadEnv();
const c = new Client({ ...(pgConfig() as any), connectionTimeoutMillis: 8000 });
await c.connect();

const q = async (label: string, sql: string) => {
  const r = await c.query(sql);
  console.log(`\n${label}`);
  for (const row of r.rows) console.log('  ', JSON.stringify(row));
};

await q('purchase_lines by gstin/period/status', `
  SELECT our_gstin, period, coalesce(match_status,'(no status)') AS status, count(*)::int n
    FROM purchase_lines GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 40`);

await q('gstr2b_lines by gstin/month', `
  SELECT our_gstin, twob_month, count(*)::int n FROM gstr2b_lines GROUP BY 1,2 ORDER BY 1,2 LIMIT 20`);

await q('gstr2b_files', `SELECT our_gstin, twob_month, file_name FROM gstr2b_files ORDER BY id LIMIT 20`);

await q('month_locks', `SELECT our_gstin, period, is_locked, locked_by FROM month_locks LIMIT 20`);

await q('recon_corrections columns allowed', `
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_rc_field'`);

console.log('\npurchase_lines columns:');
const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='purchase_lines' ORDER BY ordinal_position`);
console.log('  ' + cols.rows.map((r: any) => r.column_name).join(', '));

await c.end();
