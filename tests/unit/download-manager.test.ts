import path from 'node:path'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' }, shell: {}, webContents: { getAllWebContents: () => [] }, ipcMain: {}, session: {} }))

import {
  applyState,
  bytesPerSecond,
  canTransition,
  dedupeFilename,
  downloadService,
  installDownloads,
  isRiskyToOpen,
  quarantineValue,
  resolveSavePath,
  sanitizeFilename,
  stateFromElectron,
  throttleDownload
} from '../../src/main/downloads/download-manager'
import { createProfileStores } from '../../src/main/storage'
import type { ProfileContext } from '../../src/main/types'
import type { DownloadItem, DownloadState } from '../../src/shared/types'

describe('sanitizeFilename', () => {
  const cases: [string, string][] = [
    ['report.pdf', 'report.pdf'],
    ['../../evil.sh', 'evil.sh'],
    ['..\\..\\evil.bat', 'evil.bat'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Windows\\system32\\x.dll', 'x.dll'],
    ['.bashrc', 'bashrc'],
    ['...hidden', 'hidden'],
    ['..', 'download'],
    ['.', 'download'],
    ['', 'download'],
    ['   ', 'download'],
    ['a\u0000b\u001f.txt', 'ab.txt'],
    ['a\u202egnp.exe', 'agnp.exe'],
    ['we"ird<>:|?*.txt', 'weird.txt'],
    ['trailing. . ', 'trailing'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['NUL.tar.gz', '_NUL.tar.gz'],
    ['lpt1', '_lpt1'],
    ['COM10.txt', 'COM10.txt'],
    ['caf\u0065\u0301.txt', 'caf\u00e9.txt'],
    ['日本語のファイル.pdf', '日本語のファイル.pdf'],
    ['emoji 😀.png', 'emoji 😀.png']
  ]
  for (const [input, want] of cases) it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => expect(sanitizeFilename(input)).toBe(want))

  it('caps very long names at 200 bytes and keeps the extension', () => {
    const out = sanitizeFilename('a'.repeat(5000) + '.pdf')
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200)
    expect(out.endsWith('.pdf')).toBe(true)
  })
  it('does not split multi-byte characters when truncating', () => {
    const out = sanitizeFilename('日'.repeat(500) + '.txt')
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200)
    expect(out).not.toContain('\ufffd')
    expect(out.endsWith('.txt')).toBe(true)
  })
  it('caps a huge extension', () => {
    expect(Buffer.byteLength(sanitizeFilename('x.' + 'e'.repeat(1000)))).toBeLessThanOrEqual(200)
  })
  it('never yields a path separator, dot-names or controls', () => {
    for (const s of ['a/b', '..%2f..', '\n\r', '\u202e', './.', 'x/..', 'a\\']) {
      const out = sanitizeFilename(s)
      expect(out).not.toMatch(/[\\/\u0000-\u001f]/)
      expect(out).not.toMatch(/^\./)
      expect(['.', '..', '']).not.toContain(out)
    }
  })
})

describe('dedupeFilename / resolveSavePath', () => {
  it('returns the name when free', () => expect(dedupeFilename('a.txt', () => false)).toBe('a.txt'))
  it('adds (n) before the extension', () => {
    const taken = new Set(['a.txt', 'a (1).txt'])
    expect(dedupeFilename('a.txt', (c) => taken.has(c))).toBe('a (2).txt')
  })
  it('handles extensionless and multi-dot names', () => {
    expect(dedupeFilename('README', (c) => c === 'README')).toBe('README (1)')
    expect(dedupeFilename('x.tar.gz', (c) => c === 'x.tar.gz')).toBe('x.tar (1).gz')
  })
  it('always lands directly inside the folder', () => {
    const dir = '/home/u/Downloads'
    for (const s of ['../../evil.sh', '/etc/cron.d/x', '..\\..\\x', 'a/b/c.txt', '\u202e', '']) {
      const p = resolveSavePath(dir, s, () => false)
      expect(dirname(p)).toBe(dir)
    }
    expect(resolveSavePath(dir, '../../evil.sh', () => false)).toBe(join(dir, 'evil.sh'))
  })
  it('de-duplicates against reserved paths', () => {
    const taken = new Set([join('/d', 'f.bin')])
    expect(resolveSavePath('/d', 'f.bin', (p) => taken.has(p))).toBe(join('/d', 'f (1).bin'))
  })
  it('R6: a filesystem or drive root works as the downloads folder (posix and win32)', () => {
    expect(resolveSavePath('/', 'a.txt', () => false, path.posix)).toBe('/a.txt')
    expect(resolveSavePath('/', '../../etc/passwd', () => false, path.posix)).toBe('/passwd')
    expect(resolveSavePath('D:\\', 'a.txt', () => false, path.win32)).toBe('D:\\a.txt')
    expect(resolveSavePath('D:\\', '..\\..\\x.bin', () => false, path.win32)).toBe('D:\\x.bin')
    expect(resolveSavePath('D:\\', 'C:\\Windows\\evil.dll', () => false, path.win32)).toBe('D:\\evil.dll')
    expect(resolveSavePath('C:\\Users\\u\\Downloads', 'r.pdf', () => false, path.win32)).toBe('C:\\Users\\u\\Downloads\\r.pdf')
    expect(resolveSavePath('C:\\Users\\u\\Downloads\\', 'r.pdf', () => false, path.win32)).toBe('C:\\Users\\u\\Downloads\\r.pdf')
    expect(resolveSavePath('\\\\server\\share\\dl', 'r.pdf', () => false, path.win32)).toBe('\\\\server\\share\\dl\\r.pdf')
    const taken = new Set(['D:\\f.bin'])
    expect(resolveSavePath('D:\\', 'f.bin', (p) => taken.has(p), path.win32)).toBe('D:\\f (1).bin')
    // Reserved device names are made harmless on every platform's path rules.
    expect(path.win32.dirname(resolveSavePath('D:\\', 'CON.txt', () => false, path.win32))).toBe('D:\\')
  })
})

describe('isRiskyToOpen', () => {
  for (const f of ['x.exe', 'x.APP', 'a.sh', 'a.command', 'a.pkg', 'a.dmg', 'a.js', 'a.jar', 'a.lnk', 'a.webloc', 'noext', 'x.ps1'])
    it(`${f} is risky`, () => expect(isRiskyToOpen(f)).toBe(true))
  for (const f of ['a.pdf', 'b.PNG', 'c.txt', 'd.zip', 'e.mp4']) it(`${f} is fine`, () => expect(isRiskyToOpen(f)).toBe(false))
})

const rec = (state: DownloadState, o: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'a', url: 'http://x/', filename: 'f', path: '/d/f', state, receivedBytes: 5, totalBytes: 10, bytesPerSecond: 7,
  startedAt: 1, endedAt: null, error: null, ...o
})

describe('state transitions', () => {
  it('maps electron states', () => {
    expect(stateFromElectron('progressing', false)).toBe('progressing')
    expect(stateFromElectron('progressing', true)).toBe('paused')
    expect(stateFromElectron('interrupted', false)).toBe('interrupted')
    expect(stateFromElectron('cancelled', false)).toBe('cancelled')
  })
  it('pause and resume round trip', () => {
    const p = applyState(rec('progressing'), 'paused', 100)
    expect(p.state).toBe('paused')
    expect(p.bytesPerSecond).toBe(0)
    expect(p.endedAt).toBeNull()
    expect(applyState(p, 'progressing', 200).state).toBe('progressing')
  })
  it('completed and cancelled are final', () => {
    for (const s of ['completed', 'cancelled'] as const) {
      for (const to of ['progressing', 'paused', 'interrupted', 'cancelled', 'completed'] as const) {
        if (to !== s) expect(canTransition(s, to)).toBe(false)
      }
    }
    const done = applyState(rec('progressing'), 'completed', 500)
    expect(done.endedAt).toBe(500)
    expect(applyState(done, 'progressing', 600)).toBe(done)
  })
  it('completed can become missing, missing is final', () => {
    expect(canTransition('completed', 'missing')).toBe(true)
    expect(canTransition('missing', 'completed')).toBe(false)
    expect(canTransition('progressing', 'missing')).toBe(false)
  })
  it('interrupted records error and can resume', () => {
    const i = applyState(rec('progressing'), 'interrupted', 300, 'Connection interrupted')
    expect(i.error).toBe('Connection interrupted')
    expect(i.endedAt).toBe(300)
    const r = applyState(i, 'progressing', 400)
    expect(r.state).toBe('progressing')
    expect(r.error).toBeNull()
    expect(r.endedAt).toBeNull()
  })
  it('cancel from paused', () => expect(applyState(rec('paused'), 'cancelled', 9).state).toBe('cancelled'))
  it('speed', () => {
    expect(bytesPerSecond(0, 0, 1000, 1000)).toBe(1000)
    expect(bytesPerSecond(0, 0, 10, 0)).toBe(0)
    expect(bytesPerSecond(100, 0, 50, 1000)).toBe(0)
  })
})

describe('S1 quarantine value / S9 throttle', () => {
  it('quarantineValue = 0083;<hex seconds>;RetroNet;<UPPER uuid>', () => {
    expect(quarantineValue(0x6ae65161 * 1000 + 999, 'abcdef01-2345-6789-abcd-ef0123456789')).toBe('0083;6ae65161;RetroNet;ABCDEF01-2345-6789-ABCD-EF0123456789')
  })
  it('first download per page is free; more need a user gesture after the previous one', () => {
    const st = { allowed: 0, lastGestureAt: 0, lastAllowedAt: 0 }
    expect(throttleDownload(st, 1000)).toBe(true)
    expect(throttleDownload(st, 1100)).toBe(false)
    expect(throttleDownload(st, 1200)).toBe(false)
    st.lastGestureAt = 1300
    expect(throttleDownload(st, 1400)).toBe(true)
    expect(throttleDownload(st, 1500)).toBe(false) // one gesture buys one download
    st.allowed = 0 // new page load
    expect(throttleDownload(st, 1600)).toBe(true)
  })
})

describe('installDownloads (fake session)', () => {
  class FakeItem extends EventEmitter {
    saved = ''
    paused = false
    constructor(private name: string) { super() }
    getURL = () => 'http://x/' + this.name
    getFilename = () => this.name
    getTotalBytes = () => 100
    getReceivedBytes = () => 40
    isPaused = () => this.paused
    canResume = () => true
    setSavePath = (p: string) => void (this.saved = p)
    pause = () => { this.paused = true; this.emit('updated', {}, 'progressing') }
    resume = () => { this.paused = false; this.emit('updated', {}, 'progressing') }
    cancel = () => this.emit('done', {}, 'cancelled')
  }
  const setup = (dataDir: string | null, dlDir: string) => {
    process.env.RETRONET_E2E = '1'
    process.env.RETRONET_DOWNLOADS_DIR = dlDir
    const ses = new EventEmitter()
    const stores = createProfileStores(dataDir)
    const ctx = { id: 'p', name: 'p', incognito: dataDir === null, partition: 'x', session: ses, dataDir, stores, getSettings: () => stores.settings.get() } as unknown as ProfileContext
    installDownloads(ses as never, ctx)
    return { ses, stores, svc: downloadService(ctx)! }
  }

  it('records, pauses, resumes, completes; names are contained and de-duplicated', async () => {
    const dl = mkdtempSync(join(tmpdir(), 'rn-dlm-'))
    const data = mkdtempSync(join(tmpdir(), 'rn-dlm-data-'))
    try {
      const { ses, stores, svc } = setup(data, dl)
      const a = new FakeItem('../../x.bin')
      const b = new FakeItem('../../x.bin')
      ses.emit('will-download', {}, a)
      ses.emit('will-download', {}, b)
      expect(dirname(a.saved)).toBe(dl)
      expect(dirname(b.saved)).toBe(dl)
      expect(a.saved).not.toBe(b.saved)
      const [first] = stores.downloads.list().filter((r) => r.path === a.saved)
      expect(first?.state).toBe('progressing')
      expect(svc.pause(first!.id)).toBe(true)
      expect(stores.downloads.get(first!.id)?.state).toBe('paused')
      expect(svc.resume(first!.id)).toBe(true)
      expect(stores.downloads.get(first!.id)?.state).toBe('progressing')
      writeFileSync(a.saved, 'x')
      a.emit('done', {}, 'completed')
      // S1: on macOS completion waits for the quarantine write (real /usr/bin/xattr on the temp file).
      await vi.waitFor(() => expect(stores.downloads.get(first!.id)?.state).toBe('completed'))
      if (process.platform === 'darwin') {
        const q = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', a.saved]).toString().trim()
        expect(q).toMatch(/^0083;[0-9a-f]+;RetroNet;[0-9A-F-]{36}$/)
      }
      expect(svc.pause(first!.id)).toBe(false)
      expect(svc.remove(first!.id)).toBe(true)
      expect(svc.cancel('nope')).toBe(false)
      expect(svc.show('nope')).toBe(false)
      b.emit('done', {}, 'cancelled')
      expect(stores.downloads.list().some((r) => r.state === 'cancelled')).toBe(true)
    } finally {
      rmSync(dl, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('N1: the throttle resets on a committed main-frame navigation only; R11 cancelAll; Q6 no userinfo in records', () => {
    const dl = mkdtempSync(join(tmpdir(), 'rn-dlm-'))
    try {
      const { ses, stores, svc } = setup(null, dl)
      const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false })
      const a = new FakeItem('a.bin')
      a.getURL = () => 'https://user:secret@x.test/a.bin'
      ses.emit('will-download', {}, a, wc)
      expect(a.saved).not.toBe('') // first one per page is free
      expect(stores.downloads.list()[0]?.url).toBe('https://x.test/a.bin')
      // Script `location=` to an attachment: starts a navigation that never commits. No free download.
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.test/b.bin' })
      const b = new FakeItem('b.bin')
      let bCancelled = false
      b.cancel = () => (bCancelled = true)
      ses.emit('will-download', {}, b, wc)
      expect(bCancelled).toBe(true)
      expect(b.saved).toBe('')
      // A committed page load resets it.
      wc.emit('did-navigate', {}, 'https://x.test/next')
      const c = new FakeItem('c.bin')
      ses.emit('will-download', {}, c, wc)
      expect(c.saved).not.toBe('')
      // R11: everything still running is cancelled at once.
      expect(svc.cancelAll()).toBe(2)
      expect(stores.downloads.list().every((r) => r.state === 'cancelled')).toBe(true)
      expect(svc.cancelAll()).toBe(0)
    } finally {
      rmSync(dl, { recursive: true, force: true })
    }
  })

  it('incognito (memory stores) leaves no record on disk', async () => {
    const dl = mkdtempSync(join(tmpdir(), 'rn-dlm-'))
    try {
      const { ses, stores } = setup(null, dl)
      const a = new FakeItem('secret.txt')
      ses.emit('will-download', {}, a)
      writeFileSync(a.saved, 'x')
      a.emit('done', {}, 'completed')
      await vi.waitFor(() => expect(stores.downloads.list()[0]?.state).toBe('completed'))
      await stores.close()
      expect(existsSync(join(dl, 'downloads.json'))).toBe(false)
      expect(readdirSync(dl).filter((f) => f.endsWith('.json'))).toEqual([])
    } finally {
      rmSync(dl, { recursive: true, force: true })
    }
  })
})
