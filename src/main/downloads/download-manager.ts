// T14: per-session download manager (PLAN 1.8, AC18). `installDownloads(ses, ctx)` is called by
// installSessionHooks() for every profile and incognito session.
//
// Security rules:
// - The server never chooses a path. Only a sanitized basename is used, always inside the downloads folder
//   (the settings folder, or the OS Downloads dir), and never overwrites an existing file.
// - open/show act on ids the store recorded, never on a path from IPC. Executable-like files are revealed in
//   the folder instead of launched.
// - Incognito uses the memory-only downloads store (no record on disk).
// - macOS: every finished file gets com.apple.quarantine (S1) BEFORE it is marked completed, so Gatekeeper
//   checks downloaded apps/dmgs/zips. open() only launches a file whose quarantine attribute is present.
// - Automatic downloads are throttled per tab (S9): see DownloadThrottle.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import * as nodePath from 'node:path'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import * as electron from 'electron'
import type { DownloadItem as ElectronDownloadItem, Session, WebContents } from 'electron'
import type { DownloadItem, DownloadState, DownloadsEvent } from '../../shared/types'
import { sendPageEvent } from '../ipc/router'
import { stripUrlCredentials } from '../storage/url-credentials'
import type { ProfileContext } from '../types'

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested; no Electron at call time)
// ---------------------------------------------------------------------------------------------

const MAX_NAME_BYTES = 200
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
// C0/C1 controls, bidi overrides/isolates (filename spoofing), zero-width chars, BOM, line/paragraph separators.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff<>:"|?*]', 'g')

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

function truncateBytes(s: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const b = byteLength(ch)
    if (n + b > max) break
    out += ch
    n += b
  }
  return out
}

/** Split into [stem, ext] where ext includes the dot; a leading-dot-only name has no ext. */
function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.')
  if (i <= 0) return [name, '']
  return [name.slice(0, i), name.slice(i)]
}

/**
 * Turn a server-suggested name into a safe single path component. Never returns '', '.', '..', a name with a
 * separator, control or bidi characters, a leading dot, a trailing dot/space, or a reserved Windows device name.
 */
export function sanitizeFilename(raw: string, fallback = 'download'): string {
  let name = String(raw ?? '').normalize('NFC')
  // Keep only the last component, whatever separator style the server used.
  name = name.split(/[\\/]/).pop() ?? ''
  name = name.replace(BAD_CHARS, '')
  name = name.replace(/\s+/g, ' ').trim()
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!name) name = fallback
  let [stem, ext] = splitExt(name)
  // Cap the extension too, so one huge "extension" cannot eat the budget.
  if (byteLength(ext) > 32) ext = truncateBytes(ext, 32)
  // Windows treats everything before the first dot as the device name (CON.tar.gz is still CON).
  if (RESERVED_WIN.test(name.split('.')[0] ?? '')) stem = `_${stem}`
  stem = stem.replace(/[.\s]+$/, '')
  if (!stem) stem = fallback
  const budget = Math.max(1, MAX_NAME_BYTES - byteLength(ext) - 8) // 8 spare bytes for " (NNNN)"
  stem = truncateBytes(stem, budget).replace(/[.\s]+$/, '') || fallback
  return stem + ext
}

/** "name.ext" -> "name (1).ext", "name (2).ext", ... first one for which `taken` is false. */
export function dedupeFilename(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const [stem, ext] = splitExt(name)
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${randomUUID().slice(0, 8)})${ext}`
}

/** The path functions resolveSavePath uses (node:path by default; tests pass path.win32 / path.posix). */
export type PathApi = Pick<typeof nodePath, 'resolve' | 'join' | 'relative' | 'isAbsolute' | 'basename' | 'dirname'>

/**
 * Final save path for a download: sanitized, de-duplicated, and verified to sit directly inside `dir`.
 * `exists` reports files on disk or reserved by in-flight downloads. Containment is checked with path.relative
 * (R6), so a drive or filesystem root (`D:\`, `/`) works as the downloads folder.
 */
export function resolveSavePath(dir: string, suggested: string, exists: (absPath: string) => boolean, p: PathApi = nodePath): string {
  const root = p.resolve(dir)
  const name = dedupeFilename(sanitizeFilename(suggested), (c) => exists(p.join(root, c)))
  const full = p.join(root, name)
  const rel = p.relative(root, full)
  if (rel !== name || p.isAbsolute(rel) || rel.startsWith('..') || p.basename(full) !== name || p.dirname(full) !== root) {
    throw new Error('refusing a save path outside the downloads folder')
  }
  return full
}

const EXECUTABLE_EXTS = new Set(
  [
    'app', 'command', 'terminal', 'workflow', 'action', 'scpt', 'scptd', 'osax', 'pkg', 'mpkg', 'dmg', 'iso', 'img',
    'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'pl', 'py', 'rb', 'php', 'jar', 'class', 'run', 'bin', 'out', 'elf',
    'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'msp', 'msc', 'dll', 'cpl', 'gadget', 'hta', 'vb', 'vbs', 'vbe',
    'js', 'jse', 'ws', 'wsf', 'wsh', 'ps1', 'psm1', 'reg', 'lnk', 'url', 'webloc', 'inetloc', 'desktop', 'appimage',
    'apk', 'deb', 'rpm', 'xip', 'dylib', 'kext', 'plugin', 'service', 'prefpane', 'saver', 'mobileconfig', 'jnlp'
  ].map((e) => e.toLowerCase())
)

/** True for files that must never be launched by us (we reveal them instead). Extensionless files count too. */
export function isRiskyToOpen(filename: string): boolean {
  const ext = extname(filename).slice(1).toLowerCase()
  return ext === '' || EXECUTABLE_EXTS.has(ext)
}

const TERMINAL: ReadonlySet<DownloadState> = new Set(['completed', 'cancelled'])
const ACTIVE: ReadonlySet<DownloadState> = new Set(['progressing', 'paused'])
export const isActiveState = (s: DownloadState): boolean => ACTIVE.has(s)

/** Map Electron's updated/done states onto ours. */
export function stateFromElectron(electronState: 'progressing' | 'interrupted' | 'completed' | 'cancelled', paused: boolean): DownloadState {
  if (electronState === 'progressing') return paused ? 'paused' : 'progressing'
  return electronState
}

/**
 * Allowed state transitions. completed and cancelled are final (except a completed file later found gone ->
 * 'missing'); interrupted may be resumed; missing is final.
 */
export function canTransition(from: DownloadState, to: DownloadState): boolean {
  if (from === to) return true
  if (from === 'missing') return false
  if (TERMINAL.has(from)) return from === 'completed' && to === 'missing'
  if (from === 'interrupted') return to === 'progressing' || to === 'paused' || to === 'cancelled' || to === 'completed'
  // progressing | paused
  return to !== 'missing'
}

/** Speed in bytes/second from two samples; 0 when no time has passed or bytes went backwards. */
export function bytesPerSecond(prevBytes: number, prevAt: number, bytes: number, at: number): number {
  const dt = (at - prevAt) / 1000
  if (dt <= 0 || bytes < prevBytes) return 0
  return Math.round((bytes - prevBytes) / dt)
}

/** Apply a transition to a record, returning the next record (or the same one if the move is not allowed). */
export function applyState(item: DownloadItem, to: DownloadState, now: number, error: string | null = null): DownloadItem {
  if (!canTransition(item.state, to)) return item
  const ended = !isActiveState(to) && to !== 'interrupted' ? (item.endedAt ?? now) : to === 'interrupted' ? now : null
  return {
    ...item,
    state: to,
    bytesPerSecond: isActiveState(to) && to === 'progressing' ? item.bytesPerSecond : 0,
    endedAt: ended,
    error: to === 'interrupted' ? (error ?? item.error ?? 'Download interrupted') : null
  }
}

/** com.apple.quarantine value: flags 0083 (downloaded, user-approved-to-ask), hex epoch seconds, agent, event id. */
export function quarantineValue(now: number, uuid: string): string {
  return `0083;${Math.floor(now / 1000).toString(16)};RetroNet;${uuid.toUpperCase()}`
}

export interface DownloadThrottleState {
  /** Downloads allowed since the tab's last main-frame navigation. */
  allowed: number
  /** Time of the last user input (mouse down / key down / tap) in the tab, 0 = none. */
  lastGestureAt: number
  /** Time of the last allowed download, 0 = none. */
  lastAllowedAt: number
}

/**
 * S9 rule (the usual browser "multiple automatic downloads", simplified): the first download after a page load is
 * free; every further one needs a user input in that tab after the previous allowed download, otherwise it is
 * cancelled. A new main-frame navigation resets the count. Mutates `st` when allowed.
 */
export function throttleDownload(st: DownloadThrottleState, now: number): boolean {
  const ok = st.allowed === 0 || st.lastGestureAt > st.lastAllowedAt
  if (ok) {
    st.allowed++
    st.lastAllowedAt = now
  }
  return ok
}

const XATTR = '/usr/bin/xattr'
const QUARANTINE = 'com.apple.quarantine'

/** Write the quarantine attribute (argv only, never a shell). Resolves false on any failure. */
function writeQuarantine(path: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(XATTR, ['-w', QUARANTINE, quarantineValue(Date.now(), randomUUID()), path], { timeout: 10_000 }, (err) => done(!err))
  })
}

function hasQuarantine(path: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(XATTR, ['-p', QUARANTINE, path], { timeout: 10_000 }, (err, stdout) => done(!err && String(stdout).trim().length > 0))
  })
}

/** macOS: make sure a file carries quarantine (write it if missing). Other platforms: true (MOTW is v1.1). */
async function ensureQuarantine(path: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (await hasQuarantine(path)) return true
  return writeQuarantine(path)
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface DownloadService {
  /** Store records, newest first; completed files that vanished are flagged 'missing'. */
  list(): DownloadItem[]
  pause(id: string): boolean
  resume(id: string): boolean
  /** Cancel an active download (Chromium deletes the partial file). */
  cancel(id: string): boolean
  /** Open a completed download. 'revealed' = shown in its folder instead (risky type). Never auto-run by us. */
  open(id: string): Promise<'opened' | 'revealed'>
  /** Reveal a recorded download in the OS file manager. */
  show(id: string): boolean
  /** Reveal the newest recorded file, or open the configured downloads folder when there is none. */
  showFolder(): Promise<void>
  /** Forget one finished/cancelled/failed entry (the file stays). Active ones are refused. */
  remove(id: string): boolean
  /** Forget all finished entries; pushes a 'reset' to the page. */
  clearFinished(): number
  /** The folder new downloads go to right now. */
  downloadsDir(): string
  /** Cancel every in-flight download (R11: an incognito group going away). Returns how many were cancelled. */
  cancelAll(): number
}

const services = new WeakMap<Session, DownloadService>()

/** The service for a session, or null before installDownloads ran. T19's downloads.* handlers use it. */
export function downloadService(ctx: Pick<ProfileContext, 'session'>): DownloadService | null {
  return services.get(ctx.session) ?? null
}

interface Live {
  item: ElectronDownloadItem
  rec: DownloadItem
  lastSampleBytes: number
  lastSampleAt: number
  lastPushAt: number
}

const PUSH_INTERVAL_MS = 250

function testOverrideDir(): string | null {
  // Tests only: never honoured in a packaged app.
  const dir = process.env.RETRONET_E2E === '1' ? process.env.RETRONET_DOWNLOADS_DIR : undefined
  if (!dir || electron.app.isPackaged || !isAbsolute(dir)) return null
  return dir
}

function configuredDir(ctx: ProfileContext): string {
  const override = testOverrideDir()
  if (override) return override
  const custom = ctx.getSettings().downloadsDir
  if (custom && isAbsolute(custom)) return resolve(custom)
  return electron.app.getPath('downloads')
}

function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    // Unwritable custom folder: fall back to the OS Downloads dir rather than failing the download.
    const fallback = electron.app.getPath('downloads')
    mkdirSync(fallback, { recursive: true })
    return fallback
  }
}

const isRegularFile = (p: string): boolean => {
  try {
    const st = lstatSync(p)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

export function installDownloads(ses: Session, ctx: ProfileContext): void {
  if (services.has(ses)) return
  const store = ctx.stores.downloads
  const live = new Map<string, Live>()
  const reserved = new Set<string>()
  // Completed downloads whose quarantine write failed: never opened, only revealed.
  const unquarantined = new Set<string>()

  const pagesOfSession = (): WebContents[] => electron.webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === ses)
  const pushPage = (ev: DownloadsEvent): void => {
    for (const wc of pagesOfSession()) sendPageEvent(wc, 'downloads', ev, 'downloads')
  }
  const pushShell = (): void => {
    // Lazy: window-manager imports profile code, so a top-level import here would be a cycle.
    void import('../windows/window-manager')
      .then(({ windowManager }) => {
        for (const w of windowManager.all()) if (w.profile.partition === ctx.partition) w.requestState()
      })
      .catch(() => undefined)
  }
  const save = (rec: DownloadItem, notifyShell = false): void => {
    store.upsert(rec)
    pushPage({ type: 'upsert', item: rec })
    if (notifyShell) pushShell()
  }

  const startedRecord = (item: ElectronDownloadItem, path: string): DownloadItem => {
    const now = Date.now()
    return {
      id: randomUUID(),
      url: stripUrlCredentials(item.getURL()).slice(0, 4096),
      filename: basename(path),
      path,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
      bytesPerSecond: 0,
      startedAt: now,
      endedAt: null,
      error: null
    }
  }

  // S9: per-tab automatic-download throttle; listeners are attached at the tab's first download.
  const throttles = new WeakMap<WebContents, DownloadThrottleState>()
  const throttleFor = (wc: WebContents): DownloadThrottleState => {
    let st = throttles.get(wc)
    if (st) return st
    const fresh: DownloadThrottleState = { allowed: 0, lastGestureAt: 0, lastAllowedAt: 0 }
    st = fresh
    throttles.set(wc, fresh)
    wc.on('input-event', (_ev, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown' || input.type === 'gestureTap') {
        fresh.lastGestureAt = Date.now()
      }
    })
    // N1: only a committed main-frame document resets the count. A navigation that merely starts (script
    // `location=` to an attachment, which never commits) must not hand out another free download.
    wc.on('did-navigate', () => {
      fresh.allowed = 0
    })
    return fresh
  }

  const onWillDownload = (_e: unknown, item: ElectronDownloadItem, wc?: WebContents): void => {
    // Main-process downloads (no webContents) are always ours to start and are not throttled.
    if (wc && !wc.isDestroyed() && !throttleDownload(throttleFor(wc), Date.now())) {
      item.cancel()
      return
    }
    let path: string
    try {
      const dir = ensureDir(configuredDir(ctx))
      path = resolveSavePath(dir, item.getFilename(), (p) => reserved.has(p) || existsSync(p) || isDanglingLink(p))
    } catch {
      item.cancel()
      return
    }
    reserved.add(path)
    item.setSavePath(path)
    const rec = startedRecord(item, path)
    const entry: Live = { item, rec, lastSampleBytes: 0, lastSampleAt: rec.startedAt, lastPushAt: 0 }
    live.set(rec.id, entry)
    save(rec, true)

    const progress = (): void => {
      const now = Date.now()
      const received = item.getReceivedBytes()
      const next: DownloadItem = {
        ...entry.rec,
        receivedBytes: received,
        totalBytes: Math.max(0, item.getTotalBytes()),
        bytesPerSecond: item.isPaused() ? 0 : bytesPerSecond(entry.lastSampleBytes, entry.lastSampleAt, received, now)
      }
      entry.lastSampleBytes = received
      entry.lastSampleAt = now
      entry.rec = next
    }

    item.on('updated', (_ev, st) => {
      progress()
      const to = stateFromElectron(st, item.isPaused())
      const moved = applyState(entry.rec, to, Date.now(), st === 'interrupted' ? 'Connection interrupted' : null)
      const changed = moved.state !== entry.rec.state
      entry.rec = moved
      const now = Date.now()
      if (changed || now - entry.lastPushAt >= PUSH_INTERVAL_MS) {
        entry.lastPushAt = now
        save(entry.rec)
      }
    })

    item.once('done', (_ev, st) => {
      progress()
      const received = item.getReceivedBytes()
      const finish = (quarantineFailed: boolean): void => {
        live.delete(rec.id)
        reserved.delete(path)
        let next = applyState(entry.rec, stateFromElectron(st, false), Date.now(), st === 'interrupted' ? 'Download failed' : null)
        if (st === 'completed') next = { ...next, receivedBytes: received, totalBytes: Math.max(received, next.totalBytes) }
        else next = { ...next, receivedBytes: received }
        entry.rec = next
        if (quarantineFailed) unquarantined.add(rec.id)
        save(next, true)
      }
      // S1: quarantine first, then mark completed (the page only offers Open once it is completed).
      if (st === 'completed' && process.platform === 'darwin') {
        void writeQuarantine(path).then((ok) => finish(!ok))
      } else {
        finish(false)
      }
    })
  }

  const isDanglingLink = (p: string): boolean => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }

  ses.on('will-download', onWillDownload)

  const recorded = (id: string): DownloadItem | null => store.get(id)

  const service: DownloadService = {
    list() {
      return store.list().map((rec) => {
        if (rec.state === 'completed' && !isRegularFile(rec.path)) {
          const missing = applyState(rec, 'missing', Date.now())
          store.upsert(missing)
          return missing
        }
        return rec
      })
    },
    pause(id) {
      const l = live.get(id)
      if (!l || l.item.isPaused() || l.rec.state !== 'progressing') return false
      l.item.pause()
      return true
    },
    resume(id) {
      const l = live.get(id)
      if (!l || !l.item.canResume()) return false
      l.item.resume()
      return true
    },
    cancel(id) {
      const l = live.get(id)
      if (!l) return false
      l.item.cancel()
      return true
    },
    async open(id) {
      const rec = recorded(id)
      if (!rec || rec.state !== 'completed' || !isRegularFile(rec.path)) throw new Error('not an openable download')
      // S1: launch only files that carry quarantine (re-checked; covers records from earlier runs too).
      if (isRiskyToOpen(rec.filename) || unquarantined.has(id) || !(await ensureQuarantine(rec.path))) {
        electron.shell.showItemInFolder(rec.path)
        return 'revealed'
      }
      const err = await electron.shell.openPath(rec.path)
      if (err) throw new Error(err)
      return 'opened'
    },
    show(id) {
      const rec = recorded(id)
      if (!rec || !isRegularFile(rec.path)) return false
      electron.shell.showItemInFolder(rec.path)
      return true
    },
    async showFolder() {
      const newest = store.list().find((r) => r.state === 'completed' && isRegularFile(r.path))
      if (newest) {
        electron.shell.showItemInFolder(newest.path)
        return
      }
      const err = await electron.shell.openPath(ensureDir(configuredDir(ctx)))
      if (err) throw new Error(err)
    },
    remove(id) {
      const rec = recorded(id)
      if (!rec || isActiveState(rec.state) || live.has(id)) return false
      const ok = store.remove(id)
      if (ok) pushPage({ type: 'remove', id })
      return ok
    },
    clearFinished() {
      const n = store.clearFinished()
      pushPage({ type: 'reset' })
      return n
    },
    downloadsDir: () => configuredDir(ctx),
    cancelAll() {
      let n = 0
      for (const l of [...live.values()]) {
        try {
          l.item.cancel()
          n++
        } catch {
          /* already finished */
        }
      }
      return n
    }
  }
  services.set(ses, service)

  // Test-only handle (unpackaged AND RETRONET_E2E=1), like test-hooks.ts. Snapshots + control for the harness.
  if (!electron.app.isPackaged && process.env.RETRONET_E2E === '1') {
    const g = globalThis as unknown as { __rnDownloads?: Record<string, DownloadService> }
    ;(g.__rnDownloads ??= {})[ctx.partition] = service
  }
}
