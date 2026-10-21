import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pure-isolation sanity render of the two pasted images so the rest of the
// work can assume the source PNGs are readable on this machine. No repo file
// is changed.

const SRC = 'C:/Users/SAKAR/AppData/Local/Temp/freebuff-desktop-pastes';
const OUT = join(process.cwd(), 'output', '_preview-pastes');
mkdirSync(OUT, { recursive: true });

const paste1 = join(SRC, 'paste-1792487107068-122664.png');
const paste2 = join(SRC, 'paste-1792487130466-122664.png');

for (const [name, path] of [
  ['paste-1792487107068-122664.png', paste1],
  ['paste-1792487130466-122664.png', paste2],
]) {
  const buf = readFileSync(path);
  writeFileSync(join(OUT, name), buf);
  console.log(name, 'copied', buf.length, 'bytes ->', join(OUT, name));
}
console.log('done', OUT);
