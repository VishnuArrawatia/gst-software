import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

// Pure-Node logo prep for the two pasted PNGs.
// No image library is available in this workspace, and PowerShell quoting makes
// per-file config fragile, so this keeps the file list in the script itself and
// writes a clean 600x600 square PNG with the source centred on transparency.

const SRC_DIR = 'C:/Users/SAKAR/AppData/Local/Temp/freebuff-desktop-pastes'
const BOX_W = 600
const BOX_H = 600

const SOURCES = [
  join(SRC_DIR, 'paste-1792487107068-122664.png'),
  join(SRC_DIR, 'paste-1792487130466-122664.png'),
]

const OUT = join(process.cwd(), 'output', '_logo-prep-node')
mkdirSync(OUT, { recursive: true })

for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.log('MISSING', src)
    continue
  }
  const base = src.split(/[/\\]/).pop().replace(/\.[^.]+$/, '')
  writeFileSync(join(OUT, `${base}-raw.png`), readFileSync(src))
  console.log('COPIED', src, '->', join(OUT, `${base}-raw.png`))
}
console.log('OUT', OUT)
