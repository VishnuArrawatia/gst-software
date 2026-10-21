const fs = require('fs')
const path = require('path')

const SRC_DIR = 'C:\\Users\\SAKAR\\AppData\\Local\\Temp\\freebuff-desktop-pastes'
const BOX_W = 600
const BOX_H = 600
const OUT = path.join(process.cwd(), 'output', '_logo-prep-node')
const PS = path.join(process.cwd(), 'scripts', '_png2bmp.ps1')
const TMP = path.join(OUT, '_tmp')
fs.mkdirSync(TMP, { recursive: true })

const PNG = [
  'paste-1792487107068-122664.png',
  'paste-1792487130466-122664.png',
]

function runPs(script, args) {
  const { spawnSync } = require('child_process')
  const r = spawnSync('powershell', ['-NoProfile', '-File', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20000,
  })
  return {
    exit: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  }
}

function parseBmp(buf) {
  if (buf.length < 54) throw new Error('too small for a BMP')
  if (Buffer.from(buf.slice(0, 2), 'ascii').toString('ascii') !== 'BM') throw new Error('not a BMP')
  const w = buf.readInt32LE(18)
  const h = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24 && bpp !== 32) throw new Error('unsupported bpp: ' + bpp)
  const offset = buf.readInt32LE(10)
  const rowSize = Math.floor(((w * bpp + 31) / 32) * 4)
  const topDown = h < 0
  const absH = Math.abs(h)
  const pixels = new Uint8Array(w * absH * (bpp === 32 ? 4 : 3))
  for (let y = 0; y < absH; y++) {
    const row = topDown ? y : absH - 1 - y
    const srcOff = offset + y * rowSize
    const dstOff = row * w * (bpp === 32 ? 4 : 3)
    for (let x = 0; x < w; x++) {
      const s = srcOff + x * (bpp === 32 ? 4 : 3)
      const d = dstOff + x * (bpp === 32 ? 4 : 3)
      if (bpp === 32) {
        pixels[d] = buf.readUInt8(s + 2)
        pixels[d + 1] = buf.readUInt8(s + 1)
        pixels[d + 2] = buf.readUInt8(s)
        pixels[d + 3] = buf.readUInt8(s + 3)
      } else {
        pixels[d] = buf.readUInt8(s + 2)
        pixels[d + 1] = buf.readUInt8(s + 1)
        pixels[d + 2] = buf.readUInt8(s)
      }
    }
  }
  return { w, h: absH, bpp, pixels }
}

function resizeBilinear(src, srcW, srcH, dstW, dstH, hasAlpha) {
  const out = new Uint8Array(dstW * dstH * (hasAlpha ? 4 : 3))
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * (srcH / dstH) - 0.5
    const sy = Math.max(0, Math.min(srcH - 1, fy))
    const iy = Math.floor(sy)
    const iy1 = Math.min(srcH - 1, iy + 1)
    const dy = sy - iy
    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * (srcW / dstW) - 0.5
      const sx = Math.max(0, Math.min(srcW - 1, fx))
      const ix = Math.floor(sx)
      const ix1 = Math.min(srcW - 1, ix + 1)
      const dx = sx - ix
      const si00 = (iy * srcW + ix) * (hasAlpha ? 4 : 3)
      const si10 = (iy * srcW + ix1) * (hasAlpha ? 4 : 3)
      const si01 = (iy1 * srcW + ix) * (hasAlpha ? 4 : 3)
      const si11 = (iy1 * srcW + ix1) * (hasAlpha ? 4 : 3)
      const di = (y * dstW + x) * (hasAlpha ? 4 : 3)
      for (let c = 0; c < (hasAlpha ? 4 : 3); c++) {
        const t00 = src[si00 + c]
        const t10 = src[si10 + c]
        const t01 = src[si01 + c]
        const t11 = src[si11 + c]
        const top = t00 + (t10 - t00) * dx
        const bot = t01 + (t11 - t01) * dx
        out[di + c] = Math.round(top + (bot - top) * dy)
      }
    }
  }
  return out
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return Buffer.from([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff])
}

function writePng(buf, w, h) {
  const deflate = (data) => {
    const blocks = []
    let i = 0
    while (i < data.length) {
      const len = Math.min(65535, data.length - i)
      const raw = Buffer.allocUnsafe(len + 4)
      raw.writeUInt16LE(len, 0)
      raw.writeUInt16LE(~len & 0xffff, 2)
      data.copy(raw, 4, i, i + len)
      blocks.push(raw)
      i += len
    }
    const header = Buffer.allocUnsafe(2)
    header.writeUInt16LE(0x78, 0)
    header.writeUInt8(0x01, 1)
    const crc = crc32(Buffer.concat([header, ...blocks]))
    return Buffer.concat([header, ...blocks, crc])
  }
  const compressed = deflate(buf)
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32LE(13, 0)
  ihdr.writeUInt8(0x49, 4)
  ihdr.writeUInt8(0x48, 5)
  ihdr.writeUInt8(0x44, 6)
  ihdr.writeUInt8(0x52, 7)
  ihdr.writeUInt32LE(w, 8)
  ihdr.writeUInt32LE(h, 12)
  ihdr.writeUInt8(8, 16)
  ihdr.writeUInt8(6, 17)
  ihdr.writeUInt8(0, 18)
  const chunk = (type, data) => {
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = crc32(Buffer.concat([t, data]))
    return Buffer.concat([len, t, data, crc])
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = [
    chunk('IHDR', ihdr.slice(4)),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]
  return Buffer.concat([signature, ...chunks])
}

function fitToSquare(srcBuf, outPath, labelRows) {
  const bmp = parseBmp(srcBuf)
  const hasAlpha = bmp.bpp === 32
  let w = bmp.w
  let h = bmp.h
  let fitW = w
  let fitH = h

  if (w > BOX_W) {
    const s = BOX_W / w
    w = BOX_W
    h = Math.round(h * s)
    fitW = BOX_W
    fitH = Math.round(h * (BOX_W / bmp.w))
  }
  if (h > BOX_H) {
    const s = BOX_H / h
    h = BOX_H
    w = Math.round(w * s)
    fitW = Math.round(w * (BOX_H / bmp.h))
    fitH = BOX_H
  }
  if (fitW < BOX_W || fitH < BOX_H) {
    const s = Math.min(BOX_W / fitW, BOX_H / fitH)
    fitW = Math.round(fitW * s)
    fitH = Math.round(fitH * s)
  }
  const scaled = resizeBilinear(bmp.pixels, w, h, fitW, fitH, hasAlpha)
  const out = new Uint8Array(BOX_W * BOX_H * 4)
  const dx = Math.round((BOX_W - fitW) / 2)
  const dy = Math.round((BOX_H - fitH) / 2)
  for (let y = 0; y < fitH; y++) {
    for (let x = 0; x < fitW; x++) {
      const si = (y * fitW + x) * 4
      const di = ((dy + y) * BOX_W + (dx + x)) * 4
      out[di] = scaled[si]
      out[di + 1] = scaled[si + 1]
      out[di + 2] = scaled[si + 2]
      out[di + 3] = hasAlpha ? scaled[si + 3] : 255
    }
  }
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] > 10) out[i] = 255
  }

  if (labelRows) {
    paintLabel(out, BOX_W, BOX_H, labelRows)
  }

  const png = writePng(out, BOX_W, BOX_H)
  fs.writeFileSync(outPath, png)
  return { w: BOX_W, h: BOX_H, size: png.length }
}

function paintLabel(buf, w, h, rows) {
  const text = rows.map(({ text, color }) => text).join('\n')
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -=_+!@#$%^&*()[]{}|;:,.<>?/~`'
  const glyphMap = {}
  const glyphW = 8
  const glyphH = 12
  const glyphMapByChar = {}
  const tmpCanvas = document ? null : null
  // We do not have a canvas here; if this function somehow runs outside a
  // browser, bail out cleanly rather than producing garbage.
  if (!window && !document) return
  // Not used in this script because the Node process has no canvas; left in
  // only so the function compiles. Real label rendering is done earlier by
  // the System.Drawing caller if a label variant is requested.
}

const files = [
  { name: 'paste-1792487107068-122664.png', label: null },
  { name: 'paste-1792487130466-122664.png', label: null },
]
for (const f of files) {
  const src = path.join(SRC_DIR, f.name)
  const bmp = path.join(OUT, f.name.replace(/\.png$/i, '.bmp'))
  const raw = path.join(OUT, f.name.replace(/\.png$/i, '-raw.png'))
  const square = path.join(OUT, f.name.replace(/\.png$/i, '-square.png'))
  if (!fs.existsSync(src)) {
    console.log('MISSING', src)
    continue
  }
  fs.copyFileSync(src, raw)
  console.log('RAW', raw)

  const res = runPs(PS, [src, bmp])
  console.log('PS', f.name, 'exit=' + res.exit)
  if (res.stdout) console.log('  STDOUT', res.stdout)
  if (res.stderr && res.stderr.indexOf('BMP_OK') < 0) console.log('  STDERR', res.stderr)

  if (res.exit !== 0 || !fs.existsSync(bmp)) {
    console.log('  SKIP_BMP', bmp)
    continue
  }
  console.log('BMP', bmp, 'size=' + fs.statSync(bmp).size)
  try {
    const info = fitToSquare(fs.readFileSync(bmp), square, f.label)
    console.log('SQUARE', square, 'box=' + BOX_W + 'x' + BOX_H, 'size=' + info.size)
  } catch (e) {
    console.log('  SQUARE_ERR', f.name, e.message)
  }
}
console.log('OUT', OUT)
