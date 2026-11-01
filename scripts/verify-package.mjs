#!/usr/bin/env node
// npm run verify:package [path/to/RetroNet.app | path/to/RetroNet.dmg]
// Checks the packaged macOS app: architectures, ad-hoc signature, Info.plist, fuses, asar contents.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let target = process.argv[2] ?? path.join(root, 'dist/mac-universal/RetroNet.app')
let mount = null
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: root })
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status }
}

try {
  if (target.endsWith('.dmg')) {
    mount = fs.mkdtempSync(path.join(os.tmpdir(), 'retronet-verify-'))
    execFileSync('hdiutil', ['attach', target, '-nobrowse', '-readonly', '-mountpoint', mount])
    target = path.join(mount, 'RetroNet.app')
  }
  if (!fs.existsSync(target)) { console.error('App not found: ' + target); process.exit(2) }
  console.log('Verifying ' + target)
  const plist = (key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(target, 'Contents/Info.plist')])
  const exe = path.join(target, 'Contents/MacOS/RetroNet')

  // Architectures
  const archs = run('lipo', ['-archs', exe]).out.trim().split(/\s+/)
  check('universal binary (arm64 + x86_64)', archs.includes('arm64') && archs.includes('x86_64'), archs.join(' '))

  // Signature
  const cs = run('codesign', ['--verify', '--deep', '--strict', target])
  check('codesign --verify --deep --strict', cs.status === 0, cs.status === 0 ? '' : cs.out.trim())
  const dv = run('codesign', ['-dv', target]).out
  check('ad-hoc signature', /Signature=adhoc/.test(dv))

  // Info.plist
  const lsmin = plist('LSMinimumSystemVersion').out.trim()
  check('LSMinimumSystemVersion 13.0', lsmin === '13.0', lsmin)
  const bid = plist('CFBundleIdentifier').out.trim()
  check('CFBundleIdentifier xyz.proxnode.retronet', bid === 'xyz.proxnode.retronet', bid)
  for (const k of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSLocationUsageDescription', 'NSLocationWhenInUseUsageDescription']) {
    const v = plist(k)
    check(`Info.plist ${k}`, v.status === 0 && v.out.trim().length > 10)
  }
  const urlTypes = run('plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', path.join(target, 'Contents/Info.plist')])
  let schemes = []
  try { schemes = JSON.parse(urlTypes.out).flatMap((t) => t.CFBundleURLSchemes ?? []) } catch { /* reported below */ }
  check('CFBundleURLTypes has http + https', schemes.includes('http') && schemes.includes('https'), schemes.join(' '))
  const docTypes = run('plutil', ['-extract', 'CFBundleDocumentTypes', 'json', '-o', '-', path.join(target, 'Contents/Info.plist')])
  let docs = []
  try { docs = JSON.parse(docTypes.out) } catch { /* reported below */ }
  check('CFBundleDocumentTypes has an HTML type (public.html)', docs.some((d) => (d.LSItemContentTypes ?? []).includes('public.html')))
  check('app icon present', fs.existsSync(path.join(target, 'Contents/Resources/icon.icns')))

  // Fuses
  const fuses = run('npx', ['--no-install', '@electron/fuses', 'read', '--app', target]).out
  const want = {
    RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true, LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: false
  }
  for (const [name, on] of Object.entries(want)) {
    const m = fuses.match(new RegExp(`${name} is (Enabled|Disabled)`))
    check(`fuse ${name} ${on ? 'on' : 'off'}`, !!m && (m[1] === 'Enabled') === on, m ? m[1] : 'missing')
  }

  // asar contents
  const asar = path.join(target, 'Contents/Resources/app.asar')
  const list = run('npx', ['--no-install', '@electron/asar', 'list', asar]).out.split('\n').filter(Boolean)
  console.log(`INFO  asar entries: ${list.length}`)
  const bad = list.filter((f) => /\.map$/.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /\/(tests?|fixtures|__tests__|\.team)\//.test(f) || /\/\.env/.test(f))
  check('no source maps / tests / fixtures in asar', bad.length === 0, bad.slice(0, 5).join(', '))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retronet-asar-'))
  run('npx', ['--no-install', '@electron/asar', 'extract', asar, tmp])
  const grep = (pattern) => run('grep', ['-rIlE', pattern, tmp]).out.split('\n').filter(Boolean).map((f) => path.relative(tmp, f))
  const personal = grep('/Users/|/home/[a-z]')
  check('no personal paths (/Users/, /home/) in asar', personal.length === 0, personal.slice(0, 5).join(', '))
  const infra = grep('proxnode|ghp_|github_pat_|BEGIN (RSA |EC )?PRIVATE KEY').filter(() => true)
  // the bundle id is allowed to appear
  const infraReal = infra.filter((f) => run('grep', ['-rhoE', 'proxnode[^"\' ]*|ghp_|github_pat_|PRIVATE KEY', path.join(tmp, f)]).out.split('\n').filter(Boolean).some((m) => m !== 'proxnode.retronet'))
  check('no infra/secret strings (bundle id excepted)', infraReal.length === 0, infraReal.slice(0, 5).join(', '))
  fs.rmSync(tmp, { recursive: true, force: true })
} finally {
  if (mount) spawnSync('hdiutil', ['detach', mount, '-force'])
}
const failed = results.filter((r) => !r).length
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
