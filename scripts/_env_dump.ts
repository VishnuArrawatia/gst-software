import fs from 'fs';
import path from 'node:path';

const root = process.cwd();
console.log('CWD =', root);
console.log('--- .env raw bytes ---');
try {
  const p = path.resolve(root, '.env');
  console.log('PATH =', p, 'EXISTS =', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    console.log('SIZE =', buf.length);
    console.log(buf.toString('utf8'));
  }
} catch (e) {
  console.log('ERR .env:', (e as Error).message);
}

console.log('--- server.log tail ---');
try {
  const p = path.resolve(root, 'output', 'server.log');
  console.log('PATH =', p, 'EXISTS =', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    console.log('TOTAL_LINES =', lines.length);
    console.log(lines.slice(-40).join('\n'));
  }
} catch (e) {
  console.log('ERR server.log:', (e as Error).message);
}
