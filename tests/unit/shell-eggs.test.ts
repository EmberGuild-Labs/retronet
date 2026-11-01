// B7: shell egg gestures (DESIGN-EGGS 4, pure state machine) and the y2001 "wiki wiki" omnibox wiring (4.1, AC70).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class IpcFailure extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    IpcFailure,
    handlers: new Map<string, (req: any, ctx: any) => any>(),
    windows: new Map<number, any>(),
    openEgg: vi.fn()
  }
})

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp', on: vi.fn() } }))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: h.IpcFailure,
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn) }
}))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: { get: (id: number) => h.windows.get(id) ?? null, onWindowClosed: () => () => {} }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({ browserTabs: (w: any) => w.tabMgr }))
vi.mock('../../src/main/internal-api/eggs', () => ({ openEgg: h.openEgg }))
vi.mock('../../src/main/menus/menu-host', () => ({ registerMenuHostHandlers: () => {} }))
vi.mock('../../src/main/test-hooks', () => ({ markTiming: () => 0, timings: {} }))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { registerShellHandlers } from '../../src/main/ipc/shell-handlers'
import { registerOmniboxHandlers, takeEggHint } from '../../src/main/omnibox'
import type { SkinId } from '../../src/shared/skins'

// eggs.ts is a renderer module (DOM lib); this project's test tsconfig has no DOM, so it is loaded untyped through a
// non-literal path and described by the local types below. The gesture machine itself touches no DOM.
type Timer = ReturnType<typeof setTimeout>
interface EggGestureDeps {
  now(): number
  setTimer(fn: () => void, ms: number): Timer
  clearTimer(t: Timer): void
  skin(): SkinId
  idle(): boolean
  reducedMotion(): boolean
  note(text: string | null): void
  comet(on: boolean): void
  open(era: SkinId): void
}
interface EggsModule {
  EGG_COOLDOWN_MS: number
  EGG_NOTE_MS: number
  EGG_NOTES: Record<'triple-click' | 'five-clicks' | 'rest', string>
  Y1994_OPEN_DELAY_MS: number
  Y1997_OPEN_DELAY_MS: number
  Y1997_OPEN_DELAY_REDUCED_MS: number
  Y1999_HOVER_MS: number
  createEggGestures(d: EggGestureDeps): { click(detail: number): void; hoverStart(): void; hoverEnd(): void; reset(): void }
}
const EGGS_PATH: string = '../../src/renderer/shell/eggs'
const M = (await import(EGGS_PATH)) as EggsModule
const { EGG_COOLDOWN_MS, EGG_NOTE_MS, Y1994_OPEN_DELAY_MS, Y1997_OPEN_DELAY_MS, Y1997_OPEN_DELAY_REDUCED_MS, Y1999_HOVER_MS, createEggGestures } = M
const EGG_NOTES = { y1994: M.EGG_NOTES['triple-click'], y1997: M.EGG_NOTES['five-clicks'], y1999: M.EGG_NOTES.rest }

// ---------- gesture state machine ----------

function rig(skin: SkinId, opts: { idle?: boolean; reduced?: boolean } = {}) {
  const env = { skin, idle: opts.idle ?? true, reduced: opts.reduced ?? false }
  const notes: Array<string | null> = []
  const comets: boolean[] = []
  const opens: SkinId[] = []
  const deps: EggGestureDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    skin: () => env.skin,
    idle: () => env.idle,
    reducedMotion: () => env.reduced,
    note: (t) => void notes.push(t),
    comet: (on) => void comets.push(on),
    open: (era) => void opens.push(era)
  }
  return { env, notes, comets, opens, g: createEggGestures(deps) }
}

/** A click run as the browser reports it: detail counts up 1, 2, 3 … within the double-click interval. */
function clicks(g: { click(d: number): void }, n: number, gapMs = 0): void {
  for (let i = 1; i <= n; i++) {
    g.click(i)
    if (gapMs) vi.advanceTimersByTime(gapMs)
  }
}

describe('shell egg gestures (DESIGN-EGGS 4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('y1994: a triple-click shows the note, then opens after 600 ms; the note clears after 4 s', () => {
    const r = rig('y1994')
    clicks(r.g, 3)
    expect(r.notes).toEqual([EGG_NOTES.y1994])
    vi.advanceTimersByTime(Y1994_OPEN_DELAY_MS - 1)
    expect(r.opens).toEqual([])
    vi.advanceTimersByTime(1)
    expect(r.opens).toEqual(['y1994'])
    vi.advanceTimersByTime(EGG_NOTE_MS)
    expect(r.notes).toEqual([EGG_NOTES.y1994, null])
  })

  it('y1994: single and double clicks do nothing', () => {
    const r = rig('y1994')
    r.g.click(1)
    r.g.click(2)
    r.g.click(1)
    vi.advanceTimersByTime(5000)
    expect(r.opens).toEqual([])
    expect(r.notes).toEqual([])
  })

  it('2 s cooldown after an open: a second triple-click inside it is ignored, one after it works', () => {
    const r = rig('y1994')
    clicks(r.g, 3)
    clicks(r.g, 3) // while the open is pending
    vi.advanceTimersByTime(Y1994_OPEN_DELAY_MS)
    clicks(r.g, 3) // inside the cooldown
    vi.advanceTimersByTime(EGG_COOLDOWN_MS - 1)
    expect(r.opens).toEqual(['y1994'])
    vi.advanceTimersByTime(1)
    clicks(r.g, 3)
    vi.advanceTimersByTime(Y1994_OPEN_DELAY_MS)
    expect(r.opens).toEqual(['y1994', 'y1994'])
  })

  it('y1997: five clicks within 3 s run the comet and open after 900 ms', () => {
    const r = rig('y1997')
    clicks(r.g, 5, 500)
    expect(r.notes).toEqual([EGG_NOTES.y1997])
    expect(r.comets).toEqual([true])
    vi.advanceTimersByTime(Y1997_OPEN_DELAY_MS - 501)
    expect(r.opens).toEqual([])
    vi.advanceTimersByTime(1)
    expect(r.opens).toEqual(['y1997'])
    expect(r.comets).toEqual([true, false])
  })

  it('y1997: clicks spread over more than 3 s restart the count', () => {
    const r = rig('y1997')
    clicks(r.g, 4, 900) // first at 0, fourth at 2700, then t = 3600
    r.g.click(1) // 3600 ms after the first: a new run starts here (1), so this is not the fifth
    expect(r.notes).toEqual([])
    clicks(r.g, 4, 100) // 2..5 of the new run
    vi.advanceTimersByTime(Y1997_OPEN_DELAY_MS)
    expect(r.opens).toEqual(['y1997'])
  })

  it('y1997 with reduced motion: no comet, the note still shows, open after 300 ms', () => {
    const r = rig('y1997', { reduced: true })
    clicks(r.g, 5)
    expect(r.comets).toEqual([])
    expect(r.notes).toEqual([EGG_NOTES.y1997])
    vi.advanceTimersByTime(Y1997_OPEN_DELAY_REDUCED_MS - 1)
    expect(r.opens).toEqual([])
    vi.advanceTimersByTime(1)
    expect(r.opens).toEqual(['y1997'])
  })

  it('y1999: 1.5 s of mouse rest shows the note; a click while it shows opens at once', () => {
    const r = rig('y1999')
    r.g.click(1) // no note yet: nothing
    r.g.hoverStart()
    r.g.hoverStart() // pointerover again from a child: still one timer
    vi.advanceTimersByTime(Y1999_HOVER_MS - 1)
    expect(r.notes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(r.notes).toEqual([EGG_NOTES.y1999])
    r.g.click(1)
    expect(r.opens).toEqual(['y1999'])
    expect(r.notes).toEqual([EGG_NOTES.y1999, null])
  })

  it('y1999: leaving early cancels; a click after the note expires does nothing', () => {
    const r = rig('y1999')
    r.g.hoverStart()
    vi.advanceTimersByTime(1000)
    r.g.hoverEnd()
    vi.advanceTimersByTime(5000)
    expect(r.notes).toEqual([])
    r.g.hoverStart()
    vi.advanceTimersByTime(Y1999_HOVER_MS)
    r.g.hoverEnd() // the note stays after the pointer leaves
    vi.advanceTimersByTime(EGG_NOTE_MS)
    expect(r.notes).toEqual([EGG_NOTES.y1999, null])
    r.g.click(1)
    expect(r.opens).toEqual([])
  })

  it('only while the active tab is idle: clicks during a load are ignored and reset the y1997 count', () => {
    const r = rig('y1997')
    clicks(r.g, 4)
    r.env.idle = false
    r.g.click(5)
    r.env.idle = true
    r.g.click(1)
    vi.advanceTimersByTime(5000)
    expect(r.opens).toEqual([])
    const r94 = rig('y1994', { idle: false })
    clicks(r94.g, 3)
    const r99 = rig('y1999', { idle: false })
    r99.g.hoverStart()
    vi.advanceTimersByTime(Y1999_HOVER_MS)
    vi.advanceTimersByTime(5000)
    expect([...r94.opens, ...r94.notes, ...r99.notes]).toEqual([])
  })

  it('reset (skin change / blur) drops the pending open, the comet and the note', () => {
    const r = rig('y1997')
    clicks(r.g, 5)
    r.g.reset()
    expect(r.comets).toEqual([true, false])
    expect(r.notes).toEqual([EGG_NOTES.y1997, null])
    vi.advanceTimersByTime(5000)
    expect(r.opens).toEqual([])
    const r99 = rig('y1999')
    r99.g.hoverStart()
    r99.g.reset()
    vi.advanceTimersByTime(5000)
    expect(r99.notes).toEqual([])
  })

  it('the skin is read at event time; y2001 has no shell gesture', () => {
    const r = rig('y2001')
    clicks(r.g, 5)
    r.g.hoverStart()
    vi.advanceTimersByTime(5000)
    expect([...r.opens, ...r.notes]).toEqual([])
    r.env.skin = 'y1994'
    clicks(r.g, 3)
    vi.advanceTimersByTime(Y1994_OPEN_DELAY_MS)
    expect(r.opens).toEqual(['y1994'])
  })

  it('the gesture code never cancels or stops events', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/renderer/shell/eggs.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation/)
  })
})

// ---------- y2001 "wiki wiki" omnibox wiring ----------

describe('wiki wiki hint row opens through openEgg (DESIGN-EGGS 4.1, AC70)', () => {
  beforeAll(() => {
    registerOmniboxHandlers()
    registerShellHandlers()
  })

  let skin: SkinId = 'y2001'
  function makeWindow() {
    const w = {
      id: 1,
      profile: {
        getSettings: () => ({ skin, searchEngine: 'duckduckgo' }),
        stores: { bookmarks: { suggest: () => [] }, history: { suggest: () => [{ url: 'https://wiki.test/', title: 'wiki wiki' }] } }
      },
      win: { getContentSize: () => [1000, 800] },
      popup: false,
      overlayKind: vi.fn(() => 'suggest'),
      showOverlay: vi.fn(),
      hideOverlay: vi.fn(),
      sendOverlay: vi.fn(),
      sendShell: vi.fn(),
      tabMgr: { navigate: vi.fn(() => true), active: () => ({ id: 5 }), get: () => ({ id: 5 }) }
    }
    h.windows.set(1, w)
    return w
  }
  const ctx = { info: { windowId: 1 } }
  const anchor = { x: 0, y: 0, width: 400, height: 0 }
  const run = (m: string, req: unknown) => h.handlers.get(m)!(req, ctx)
  const HINT = 'retronet://wikiwiki/'

  beforeEach(() => {
    skin = 'y2001'
    h.openEgg.mockReset()
  })

  it('suggest passes the window skin: the row is only offered under y2001', () => {
    makeWindow()
    expect(run('omnibox.suggest', { text: 'wiki wiki', anchor }).items[0]).toMatchObject({ title: 'Quick, quick!', url: HINT })
    skin = 'y1997'
    expect(run('omnibox.suggest', { text: 'wiki wiki', anchor }).items.some((s: any) => s.url === HINT)).toBe(false)
  })

  it('a click (omnibox.pick) on the row calls openEgg, not a typed navigation; other rows still navigate', () => {
    const w = makeWindow()
    run('omnibox.suggest', { text: 'quick quick', anchor })
    run('omnibox.pick', { index: 0 })
    expect(h.openEgg).toHaveBeenCalledWith(w, 'y2001')
    expect(w.tabMgr.navigate).not.toHaveBeenCalled()
    const items = run('omnibox.suggest', { text: 'wiki wiki', anchor }).items
    const other = items.findIndex((s: any) => s.url === 'https://wiki.test/')
    run('omnibox.pick', { index: other })
    expect(w.tabMgr.navigate).toHaveBeenCalledWith('https://wiki.test/')
    expect(h.openEgg).toHaveBeenCalledTimes(1)
  })

  it('keyboard: down + Enter on the row (tabs.navigate with its URL) opens the egg', () => {
    const w = makeWindow()
    run('omnibox.suggest', { text: 'wiki wiki', anchor })
    run('omnibox.highlight', { index: 0 })
    run('omnibox.dismiss', {}) // the shell dismisses before it navigates; the pick grace still applies
    expect(run('tabs.navigate', { input: HINT, disposition: 'current' })).toEqual({ blocked: false })
    expect(h.openEgg).toHaveBeenCalledWith(w, 'y2001')
    expect(w.tabMgr.navigate).not.toHaveBeenCalled()
    // The state is consumed: a later typed retronet://wikiwiki/ is an ordinary typed address again.
    run('tabs.navigate', { input: HINT, disposition: 'current' })
    expect(h.openEgg).toHaveBeenCalledTimes(1)
    expect(w.tabMgr.navigate).toHaveBeenCalledWith(HINT, { tabId: undefined, disposition: 'current' })
  })

  it('plain Enter on "wiki wiki" (nothing highlighted) still searches', () => {
    const w = makeWindow()
    run('omnibox.suggest', { text: 'wiki wiki', anchor })
    run('tabs.navigate', { input: 'wiki wiki', disposition: 'current' })
    expect(h.openEgg).not.toHaveBeenCalled()
    expect(w.tabMgr.navigate).toHaveBeenCalledWith('wiki wiki', { tabId: undefined, disposition: 'current' })
  })

  it('takeEggHint refuses: another row highlighted, a different input, a skin change, or a stale list', () => {
    const w = makeWindow() as any
    run('omnibox.suggest', { text: 'wiki wiki', anchor })
    run('omnibox.highlight', { index: 1 })
    expect(takeEggHint(w, HINT)).toBe(false)
    run('omnibox.highlight', { index: 0 })
    expect(takeEggHint(w, 'https://wiki.test/')).toBe(false)
    skin = 'y1999'
    expect(takeEggHint(w, HINT)).toBe(false)
    skin = 'y2001'
    vi.useFakeTimers()
    try {
      run('omnibox.dismiss', {})
      vi.advanceTimersByTime(1500)
      expect(takeEggHint(w, HINT)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    expect(h.openEgg).not.toHaveBeenCalled()
  })
})
