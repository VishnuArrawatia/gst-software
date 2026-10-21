import { readFileSync } from 'node:fs';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

function fileExists(p: string) {
  try { accessSync(p, constants.F_OK); return true; } catch { return false; }
}

const candidates = [
  './.env',
  './env',
  '../.env',
  resolve(process.cwd(), '.env'),
];

console.log('CWD =', process.cwd());
for (const c of candidates) {
  console.log(`CANDIDATE ${c} EXISTS=${fileExists(c)}`);
  if (fileExists(c)) {
    try {
      const txt = readFileSync(c, 'utf8');
      const m = txt.match(/^PGPASSWORD\s*=\s*(.*)$/m);
      console.log(`  PGPASSWORD LINE = ${m ? m[0].trim() : 'none'}`);
    } catch (e) {
      console.log(`  READ ERR: ${e}`);
    }
  }
}

const want = ['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','GST_DB_PROFILE','GST_PGDATABASE','GST_PGHOST','GST_PGPORT','GST_PGUSER','GST_PGPASSWORD'];
console.log('--- process.env (at probe load time) ---');
for (const k of want) {
  console.log(`${k}=${process.env[k] ?? '<unset>'}`);
}
