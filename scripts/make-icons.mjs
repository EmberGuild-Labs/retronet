#!/usr/bin/env node
// npm run icons — rasterizes the RetroNet app icon and dmg background.
// Writes: build/icon.icns, build/icon.ico, build/icon.png (512), build/dmg-background.png (+@2x).
// Pure JS (resvg + hand-written ICNS/ICO containers), so it also runs on Windows/Linux CI.
// 16px and 32px slices come from the hand-pixeled SVGs, not from downscaling the 1024 master.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { dmgBackground } from './art/brand.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const B = (p) => path.join(root, 'build', p)
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const master = read('build/icon.svg')
const px16 = read('src/renderer/public/img/logo-16.svg')
const px32 = read('src/renderer/public/img/logo-32.svg')

const render = (svg, width) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng())
const png = {
  16: render(px16, 16),
  24: render(px32, 24),
  32: render(px32, 32),
  48: render(master, 48),
  64: render(master, 64),
  '64px': render(px32, 64), // 32@2x keeps the pixel look
  128: render(master, 128),
  256: render(master, 256),
  512: render(master, 512),
  1024: render(master, 1024),
}

// ---- ICNS: 'icns' header + [type, length, PNG] entries ----
function icns(entries) {
  const chunks = entries.map(([type, data]) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([h, data])
  })
  const body = Buffer.concat(chunks)
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([h, body])
}
// 16/32 @1x use the legacy is32+s8mk / il32+l8mk pair (RLE RGB planes + 8-bit mask).
// icp4/icp5 PNG slices decode as noise in iconutil/sips, so they are NOT emitted.
function legacyPair(size, rgbType, maskType) {
  const r = new Resvg(size === 16 ? px16 : px32, { fitTo: { mode: 'width', value: size } }).render()
  const { width, height } = r, data = r.pixels
  const n = width * height
  const planes = [0, 1, 2].map((c) => {
    const out = []
    for (let i = 0; i < n; i += 128) { // literal runs only: (len-1) then bytes
      const len = Math.min(128, n - i)
      out.push(len - 1)
      for (let j = 0; j < len; j++) out.push(data[(i + j) * 4 + c])
    }
    return Buffer.from(out)
  })
  const mask = Buffer.alloc(n)
  for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3]
  return [[rgbType, Buffer.concat(planes)], [maskType, mask]]
}
const icnsBuf = icns([
  ...legacyPair(16, 'is32', 's8mk'), ['ic11', png[32]],
  ...legacyPair(32, 'il32', 'l8mk'), ['ic12', png['64px']],
  ['ic07', png[128]], ['ic13', png[256]],
  ['ic08', png[256]], ['ic14', png[512]],
  ['ic09', png[512]], ['ic10', png[1024]],
])

// ---- ICO: PNG-compressed entries (Windows Vista+) ----
function ico(list) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(list.length, 4)
  let offset = 6 + 16 * list.length
  const dir = [], data = []
  for (const [size, buf] of list) {
    const d = Buffer.alloc(16)
    d.writeUInt8(size >= 256 ? 0 : size, 0); d.writeUInt8(size >= 256 ? 0 : size, 1)
    d.writeUInt8(0, 2); d.writeUInt8(0, 3); d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6)
    d.writeUInt32LE(buf.length, 8); d.writeUInt32LE(offset, 12)
    offset += buf.length; dir.push(d); data.push(buf)
  }
  return Buffer.concat([head, ...dir, ...data])
}
const icoBuf = ico([[16, png[16]], [24, png[24]], [32, png[32]], [48, png[48]], [64, png[64]], [256, png[256]]])

fs.writeFileSync(B('icon.icns'), icnsBuf)
fs.writeFileSync(B('icon.ico'), icoBuf)
fs.writeFileSync(B('icon.png'), png[512])
const dmg = dmgBackground()
fs.writeFileSync(B('dmg-background.png'), render(dmg, 660))
fs.writeFileSync(B('dmg-background@2x.png'), render(dmg, 1320))

const kb = (f) => `${(fs.statSync(B(f)).size / 1024).toFixed(1)} KB`
for (const f of ['icon.icns', 'icon.ico', 'icon.png', 'dmg-background.png', 'dmg-background@2x.png']) console.log(`icons: wrote build/${f} (${kb(f)})`)

// ---- self-check on macOS: iconutil must unpack every slice and each must decode as a real, non-noisy image ----
// Noise metric: mean absolute difference between horizontally adjacent pixels of the slice vs. the same
// slice rendered from source (nearest) -- a decoded slice must match its source closely.
if (process.platform === 'darwin') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-icns-'))
  try {
    const set = path.join(tmp, 'check.iconset')
    execFileSync('iconutil', ['-c', 'iconset', B('icon.icns'), '-o', set], { stdio: 'pipe' })
    const slices = fs.readdirSync(set).sort()
    const want = ['16x16', '16x16@2x', '32x32', '32x32@2x', '128x128', '128x128@2x', '256x256', '256x256@2x', '512x512', '512x512@2x']
    const missing = want.filter((w) => !slices.includes(`icon_${w}.png`))
    if (missing.length) throw new Error(`missing slices: ${missing.join(', ')}`)
    for (const f of slices) {
      const file = path.join(set, f)
      execFileSync('sips', ['-g', 'pixelWidth', file], { stdio: 'pipe' }) // undecodable -> throws
      const img = decodePngRgba(fs.readFileSync(file))
      // reference: same-size render of the matching source
      const w = img.width
      const ref = decodePngRgba(w <= 32 ? render(w === 16 ? px16 : px32, w) : w === 64 ? png['64px'] : render(master, w))
      let diff = 0
      for (let i = 0; i < w * w * 4; i++) diff += Math.abs(img.data[i] - ref.data[i])
      const mad = diff / (w * w * 4)
      if (mad > 12) throw new Error(`${f} is noisy / does not match its source (mean abs diff ${mad.toFixed(1)})`)
    }
    console.log(`icons: iconutil verified icon.icns (${slices.length} slices decoded + compared to source: ${slices.join(', ')})`)
  } catch (e) {
    console.error('icons: icon.icns self-check FAILED', e.stderr?.toString() || e)
    process.exitCode = 1
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// Minimal PNG decoder (8-bit RGBA/RGB, non-interlaced) for the self-check only.
function decodePngRgba(buf) {
  let p = 8, width = 0, height = 0, ct = 6; const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported PNG') }
    if (type === 'IDAT') idat.push(d)
    p += 12 + len
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0
  if (!bpp) throw new Error(`unsupported PNG color type ${ct}`)
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp, out = Buffer.alloc(width * height * 4, 255)
  const cur = Buffer.alloc(stride); let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
      cur[i] = (x + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c))) & 255
    }
    for (let x = 0; x < width; x++) for (let k = 0; k < bpp; k++) out[(y * width + x) * 4 + k] = cur[x * bpp + k]
    prev = Buffer.from(cur)
  }
  return { width, height, data: out }
}
