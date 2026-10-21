// Diagnostics only: print env + resolved pgConfig, no connection.
function pgConfig() {
  const env = process.env;
  const profile = env.GST_DB_PROFILE ?? 'production';
  if (profile === 'test') {
    return {
      host: env.PGHOST ?? env.GST_PGHOST ?? 'localhost',
      port: parseInt(env.PGPORT ?? env.GST_PGPORT ?? '5432', 10) || 5432,
      user: env.PGUSER ?? env.GST_PGUSER ?? 'postgres',
      password: env.PGPASSWORD ?? env.GST_PGPASSWORD ?? '',
      database: env.PGDATABASE ?? env.GST_PGDATABASE ?? 'gst_erp_test',
      profile,
    };
  }
  return {
    host: env.PGHOST ?? env.GST_PGHOST ?? 'localhost',
    port: parseInt(env.PGPORT ?? env.GST_PGPORT ?? '5432', 10) || 5432,
    user: env.PGUSER ?? env.GST_PGUSER ?? 'postgres',
    password: env.PGPASSWORD ?? env.GST_PGPASSWORD ?? '',
    database: env.PGDATABASE ?? env.GST_PGDATABASE ?? 'gst_erp',
    profile,
  };
}

const keys = [
  'GST_DB_PROFILE','PGHOST','GST_PGHOST','PGPORT','GST_PGPORT','PGUSER','GST_PGUSER',
  'PGPASSWORD','GST_PGPASSWORD','PGDATABASE','GST_PGDATABASE',
];
console.log('ENV_PROFILE_KVS =', Object.fromEntries(
  keys.map((k) => [k, process.env[k] ?? null])
));
const cfg = pgConfig();
const typed = {
  host: cfg.host, port: cfg.port, user: cfg.user,
  passwordType: typeof cfg.password, passwordLen: String(cfg.password).length,
  passwordPreview: String(cfg.password).slice(0, 6),
  database: cfg.database, profile: cfg.profile,
};
console.log('PGCONFIG =', JSON.stringify(typed, null, 2));
