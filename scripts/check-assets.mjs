#!/usr/bin/env node
// npm run check:assets — RetroNet asset and trademark gate (AC28).
//  1. Every shipped asset must be listed (by repo-relative path) in ASSETS.md.
//  2. No trademark word may appear in shipped assets or UI source, in file contents or file names.
//  3. SVGs must be self-contained art: no <script>, <foreignObject>, <image>, or external URLs.
// Exits 1 on any failure. README.md, ASSETS.md, .team/ and tests/ are out of scope.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRADEMARK_RE } from './trademark-words.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => path.relative(root, p).split(path.sep).join('/')


// Narrow allowlist: security code that must name these URL schemes to BLOCK them. Each entry is file-scoped and
// token-scoped; the matched token is blanked before the trademark scan. Never add branding or UI strings here.
const ALLOW = [
  { file: /^src\/shared\/omnibox\.ts$/, token: /(['"])chrome(-extension|-untrusted)?\1/g, why: 'blocked URL schemes list' },
  { file: /^src\/(shared|renderer)\/.*\.ts$/, token: /\bprocess\.versions\.chrome\b|\bversions\.chrome\b/g, why: 'nominative engine version on the About page' },
]

const SCAN_DIRS = ['src/renderer', 'src/shared', 'build']
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist'])
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html', '.css', '.svg', '.json', '.txt', '.md', '.plist', '.xml', '.yml', '.yaml'])
const BINARY_ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.woff', '.woff2', '.ttf', '.otf', '.svg', '.wav', '.mp3'])
// Font license texts are third-party legal text, scanned but exempt from the trademark rule only if they ever cite one.
const LICENSE_FILE = /^src\/renderer\/public\/fonts\/licenses\//

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(root, d)))
const errors = []

// ---- 1. ASSETS.md coverage ----
const assetsMdPath = path.join(root, 'ASSETS.md')
const assetsMd = fs.existsSync(assetsMdPath) ? fs.readFileSync(assetsMdPath, 'utf8') : ''
if (!assetsMd) errors.push('ASSETS.md is missing')
const isAsset = (r) => {
  const ext = path.extname(r).toLowerCase()
  if (r.startsWith('src/renderer/public/')) {
    // skin stylesheets are code (T9), not art
    return !/^src\/renderer\/public\/skins\/[^/]+\/(skin|pages)\.css$/.test(r)
  }
  if (r.startsWith('build/')) return /^build\/(icon\.|dmg-background)/.test(r)
  if (r.startsWith('src/renderer/')) return BINARY_ASSET_EXT.has(ext) // any image/font that lands elsewhere in the UI
  return false
}
const assets = files.map(rel).filter(isAsset)
const listed = (r) => assetsMd.includes('`' + r + '`')
for (const r of assets) if (!listed(r)) errors.push(`not listed in ASSETS.md: ${r}`)

// ---- 2. trademark scan ----
let scanned = 0
for (const abs of files) {
  const r = rel(abs)
  const g = new RegExp(TRADEMARK_RE.source, 'gi')
  if (g.test(path.basename(r))) errors.push(`trademark word in file name: ${r}`)
  if (!TEXT_EXT.has(path.extname(r).toLowerCase())) continue
  let text = fs.readFileSync(abs, 'utf8')
  for (const a of ALLOW) if (a.file.test(r)) text = text.replace(a.token, (m) => ' '.repeat(m.length))
  scanned++
  text.split('\n').forEach((line, i) => {
    const m = line.match(TRADEMARK_RE)
    if (m && !LICENSE_FILE.test(r)) errors.push(`trademark word "${m[0]}" at ${r}:${i + 1}`)
  })
}

// ---- 3. SVG hygiene ----
for (const r of assets.filter((a) => a.endsWith('.svg'))) {
  const t = fs.readFileSync(path.join(root, r), 'utf8')
  if (/<script|<foreignObject|<image\b|\bon[a-z]+\s*=|(?:xlink:)?href\s*=\s*["'](?!#)/i.test(t)) errors.push(`SVG is not self-contained art (script/image/external href): ${r}`)
}

if (errors.length) {
  console.error(`check:assets FAILED (${errors.length} problem${errors.length > 1 ? 's' : ''}):`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log(`check:assets OK: ${assets.length} assets listed in ASSETS.md, ${scanned} text files scanned for trademark words, 0 problems.`)
