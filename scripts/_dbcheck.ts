import { loadEnv, pgConfig } from '../src/config/env';
import { Client } from 'pg';

loadEnv();
const cfg: any = pgConfig();
console.log('cfg', cfg.host, cfg.port, cfg.user, cfg.database, 'pw?', !!cfg.password);
const c = new Client({ ...cfg, connectionTimeoutMillis: 5000 });
c.connect()
  .then(async () => {
    console.log('connected');
    const r = await c.query('select count(*)::int n from sales_invoices');
    console.log('sales_invoices rows =', r.rows[0].n);
    const t = await c.query(
      "select tablename from pg_tables where schemaname='public' and tablename like 'sales%' order by 1",
    );
    console.log('tables:', t.rows.map((x: any) => x.tablename).join(','));
    const m = await c.query('select filename from schema_migrations order by filename');
    console.log('migrations:', m.rows.map((x: any) => x.filename).join(','));
    await c.end();
  })
  .catch((e) => {
    console.log('ERR:', e.message);
    process.exit(0);
  });
