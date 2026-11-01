// C3 / E2 (AC75, unit part): the webContents audit fails unregistered webContents and sessions with preload
// scripts, and every BrowserWindow/WebContentsView construction in src/main takes a factory webPreferences result.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/app-paths', () => ({
  backgroundTestMode: () => false,
  preloadPath: (name: string) => `/app/out/preload/${name}.js`
}))

import type { Session, WebContents, WebPreferences } from 'electron'
import {
  AUDIT_REGISTER_GRACE_MS,
  auditSessionPreloads,
  auditWebPreferences,
  scheduleWebContentsAudit,
  tabWebPreferences,
  uiWebPreferences,
  type WebPrefsAudit
} from '../../src/main/security/web-prefs'

interface FakeWc {
  id: number
  type: string
  prefs: WebPreferences | null
  destroyed: boolean
}

function fakeWc(over: Partial<FakeWc> = {}): WebContents & { state: FakeWc } {
  const state: FakeWc = { id: 7, type: 'window', prefs: uiWebPreferences(), destroyed: false, ...over }
  return {
    state,
    get id() {
      return state.id
    },
    getType: () => state.type,
    getLastWebPreferences: () => state.prefs,
    isDestroyed: () => state.destroyed
  } as unknown as WebContents & { state: FakeWc }
}

/** Deterministic timers: `later` queues, `run()` advances the clock to the next callback and runs it. */
function fakeTimers() {
  let clock = 0
  const queue: Array<{ at: number; fn: () => void }> = []
  return {
    now: () => clock,
    later: (fn: () => void, ms: number) => void queue.push({ at: clock + ms, fn }),
    pending: () => queue.length,
    run(): void {
      queue.sort((a, b) => a.at - b.at)
      const next = queue.shift()
      if (!next) return
      clock = Math.max(clock, next.at)
      next.fn()
    }
  }
}

describe('auditWebPreferences registration check (E2)', () => {
  const registered = new Set<number>()
  const isRegistered = (wc: WebContents): boolean => registered.has(wc.id)

  it('a registered shell/overlay or tab webContents is ok', () => {
    registered.add(7)
    expect(auditWebPreferences(fakeWc(), isRegistered)).toMatchObject({ ok: true, problems: [] })
    const tab = fakeWc({ type: 'browserView', prefs: tabWebPreferences({ partition: 'persist:p1' }) })
    expect(auditWebPreferences(tab, isRegistered).ok).toBe(true)
    registered.clear()
  })

  it('an unregistered non-devtools webContents fails, even with hardened prefs', () => {
    const a = auditWebPreferences(fakeWc({ id: 99 }), isRegistered)
    expect(a.ok).toBe(false)
    expect(a.problems).toEqual(['not router-registered'])
  })

  it('devtools (remote, no prefs) is skipped and needs no registration', () => {
    const a = auditWebPreferences(fakeWc({ id: 50, type: 'remote', prefs: null }), isRegistered)
    expect(a).toMatchObject({ ok: true, skipped: 'devtools' })
  })

  it('a type other than remote without prefs is not treated as devtools', () => {
    const a = auditWebPreferences(fakeWc({ id: 51, type: 'window', prefs: null }), isRegistered)
    expect(a.ok).toBe(false)
    expect(a.problems).toEqual(['no webPreferences', 'not router-registered'])
  })

  it('without a predicate the registration check is off (the synchronous web-contents-created call)', () => {
    expect(auditWebPreferences(fakeWc({ id: 99 })).ok).toBe(true)
  })

  it('weak prefs still fail alongside registration', () => {
    registered.add(8)
    const a = auditWebPreferences(fakeWc({ id: 8, prefs: { ...uiWebPreferences(), sandbox: false } }), isRegistered)
    expect(a.problems).toEqual(['sandbox=false (want true)'])
    registered.clear()
  })
})

describe('scheduleWebContentsAudit (timing: registration happens right after construction)', () => {
  it('never audits synchronously; a webContents registered right after construction is ok', () => {
    const t = fakeTimers()
    const registered = new Set<number>()
    const results: WebPrefsAudit[] = []
    const wc = fakeWc({ id: 3 })
    scheduleWebContentsAudit(wc, (w) => registered.has(w.id), (a) => results.push(a), t)
    expect(results).toEqual([])
    registered.add(3) // what the window manager / tab code does after `new ...(...)` returns
    t.run()
    expect(results).toEqual([expect.objectContaining({ id: 3, ok: true })])
    expect(t.pending()).toBe(0)
  })

  it('a late registration within the grace period (adopted window.open guest) is ok', () => {
    const t = fakeTimers()
    const registered = new Set<number>()
    const results: WebPrefsAudit[] = []
    scheduleWebContentsAudit(fakeWc({ id: 4 }), (w) => registered.has(w.id), (a) => results.push(a), t)
    t.run()
    t.run()
    expect(results).toEqual([])
    registered.add(4)
    t.run()
    expect(results).toEqual([expect.objectContaining({ id: 4, ok: true })])
  })

  it('a never-registered webContents fails once after the grace period', () => {
    const t = fakeTimers()
    const results: WebPrefsAudit[] = []
    scheduleWebContentsAudit(fakeWc({ id: 5 }), () => false, (a) => results.push(a), t)
    let guard = 0
    while (t.pending() > 0 && guard++ < 1000) t.run()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: 5, ok: false, problems: ['not router-registered'] })
    expect(t.now()).toBeGreaterThanOrEqual(AUDIT_REGISTER_GRACE_MS)
  })

  it('a prefs failure is reported right away (no waiting for registration)', () => {
    const t = fakeTimers()
    const results: WebPrefsAudit[] = []
    const wc = fakeWc({ id: 6, prefs: { ...uiWebPreferences(), contextIsolation: false } })
    scheduleWebContentsAudit(wc, () => false, (a) => results.push(a), t)
    t.run()
    expect(results[0]?.problems).toEqual(['contextIsolation=false (want true)', 'not router-registered'])
    expect(t.pending()).toBe(0)
  })

  it('devtools is skipped; a webContents destroyed before the check is not reported', () => {
    const t = fakeTimers()
    const results: WebPrefsAudit[] = []
    scheduleWebContentsAudit(fakeWc({ id: 9, type: 'remote', prefs: null }), () => false, (a) => results.push(a), t)
    const gone = fakeWc({ id: 10 })
    scheduleWebContentsAudit(gone, () => false, (a) => results.push(a), t)
    gone.state.destroyed = true
    while (t.pending() > 0) t.run()
    expect(results).toEqual([expect.objectContaining({ id: 9, ok: true, skipped: 'devtools' })])
  })
})

describe('auditSessionPreloads (E2)', () => {
  const ses = (storagePath: string | null, files: string[]): Session =>
    ({
      storagePath,
      getPreloadScripts: () => files.map((filePath, i) => ({ id: String(i), type: 'frame', filePath }))
    }) as unknown as Session

  it('sessions without preload scripts pass', () => {
    expect(auditSessionPreloads([ses('/p/default', []), ses(null, [])])).toEqual([
      { storagePath: '/p/default', ok: true, preloads: [] },
      { storagePath: null, ok: true, preloads: [] }
    ])
  })

  it('a session with a preload script fails and names it', () => {
    const out = auditSessionPreloads([ses('/p/a', []), ses('/p/b', ['/evil/preload.js'])])
    expect(out.map((o) => o.ok)).toEqual([true, false])
    expect(out[1]?.preloads).toEqual(['/evil/preload.js'])
  })
})

// --- Factory grep test -------------------------------------------------------------------------------------

const FACTORIES = ['uiWebPreferences(', 'tabWebPreferences(', 'enforceTabPreferences(']

/** Names a file uses for BrowserWindow / WebContentsView, including `import { WebContentsView as View }`. */
function constructorNames(src: string): string[] {
  const names = new Set<string>(['BrowserWindow', 'WebContentsView'])
  for (const m of src.matchAll(/\b(?:BrowserWindow|WebContentsView)\s+as\s+(\w+)/g)) names.add(m[1] as string)
  return [...names]
}

/** The text between the parens of the call that starts at `open` (index of '('). */
function callArgs(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/**
 * Drops block comments and whole-line `//` comments (doc text may quote the pattern). Trailing `//` comments stay:
 * stripping them naively would also cut string literals such as 'retronet://x' and could hide real code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every `new BrowserWindow(...)` / `new WebContentsView(...)` (or alias) whose webPreferences isn't a factory call. */
function factoryViolations(raw: string): string[] {
  const src = stripComments(raw)
  const bad: string[] = []
  for (const name of constructorNames(src)) {
    for (const m of src.matchAll(new RegExp(`\\bnew\\s+${name}\\s*\\(`, 'g'))) {
      const args = callArgs(src, (m.index as number) + m[0].length - 1)
      const pref = /\bwebPreferences\s*:\s*([\s\S]*)/.exec(args)
      const ok = pref !== null && FACTORIES.some((f) => (pref[1] as string).trimStart().startsWith(f))
      if (!ok) bad.push(`new ${name}(${args.replace(/\s+/g, ' ').slice(0, 80)})`)
    }
  }
  return bad
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? tsFiles(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('factory grep test (E2): every window/view in src/main uses a factory webPreferences result', () => {
  const root = join(__dirname, '../../src/main')

  it('finds the known constructions and no violations', () => {
    let found = 0
    const bad: string[] = []
    for (const file of tsFiles(root)) {
      const src = stripComments(readFileSync(file, 'utf8'))
      for (const name of constructorNames(src)) found += [...src.matchAll(new RegExp(`\\bnew\\s+${name}\\s*\\(`, 'g'))].length
      for (const v of factoryViolations(src)) bad.push(`${relative(root, file)}: ${v}`)
    }
    expect(bad).toEqual([])
    // window-manager: the BrowserWindow and the overlay (aliased View); tab.ts: fresh and adopted views.
    expect(found).toBeGreaterThanOrEqual(4)
  })

  it('fails on planted fixtures', () => {
    expect(factoryViolations('const v = new WebContentsView({webPreferences:{}})')).toHaveLength(1)
    expect(factoryViolations('const w = new BrowserWindow({ width: 10 })')).toHaveLength(1)
    expect(factoryViolations('new BrowserWindow()')).toHaveLength(1)
    expect(factoryViolations('import { WebContentsView as V } from "electron"\nnew V({ webPreferences: { sandbox: false } })')).toHaveLength(1)
    expect(factoryViolations('new WebContentsView({ webPreferences: { ...uiWebPreferences(), sandbox: false } })')).toHaveLength(1)
    // Comments are not code.
    expect(factoryViolations('/** new WebContentsView({ webPreferences: {} }) */\n// new BrowserWindow({})')).toEqual([])
  })

  it('accepts factory results, including the adopted-guest form', () => {
    expect(factoryViolations('new WebContentsView({ webContents: g, webPreferences: tabWebPreferences({ session: s }) })')).toEqual([])
    expect(factoryViolations('new BrowserWindow({ show: false, webPreferences: uiWebPreferences() })')).toEqual([])
  })
})
