import { readFileSync } from 'node:fs';

console.log('--- .env via readFileSync ---');
try {
  const p = './' + '.env';
  const buf = readFileSync(p);
  console.log('PATH =', p, 'SIZE =', buf.length);
  console.log(buf.toString('utf8'));
} catch (e) {
  console.log('ERR:', (e as Error).message);
}

console.log('--- .env via process.env (what the process actually sees) ---');
const want = ['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','GST_DB_PROFILE','GST_PGDATABASE'];
for (const k of want) {
  console.log(`${k}=${process.env[k] ?? '<unset>'}`);
}

console.log('--- script identity ---');
console.log('FILE =', new URL('script:///x').pathname ? 'esm' : 'cjs');
console.log('process.type =', process.type);
console.log('require exists =', typeof require !== 'undefined');
