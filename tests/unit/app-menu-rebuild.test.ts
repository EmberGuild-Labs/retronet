// AC74 (R22/E4): the macOS app menu rebuilds only for the active tab of the focused window, only when View Source
// enablement flips; tab and window switches refresh it; background-tab navigations cause zero rebuilds.
// Also the profiles.menu handler (showMenu, resolves on close). Nothing native is shown: Menu is stubbed.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const setApplicationMenu = vi.fn()
const appHandlers = new Map<string, (...a: any[]) => void>()
vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: true, getPath: () => '/tmp', on: (ev: string, fn: any) => appHandlers.set(ev, fn), name: 'RetroNet', quit: vi.fn() },
    BrowserWindow: Object.assign(Stub, { getFocusedWindow: () => null }),
    WebContentsView: Stub,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: (m: unknown) => setApplicationMenu(m) },
    clipboard: { writeText: vi.fn() },
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

// ---- fake windows and tabs ----
interface FakeTab {
  id: number
  u: string
  url(): string
  wc: FakeWc
}
interface FakeWc {
  handlers: Map<string, Array<(...a: any[]) => void>>
  on(ev: string, fn: (...a: any[]) => void): FakeWc
  emit(ev: string): void
  isDestroyed(): boolean
}
function fakeWc(): FakeWc {
  const wc: FakeWc = {
    handlers: new Map(),
    on(ev, fn) {
      wc.handlers.set(ev, [...(wc.handlers.get(ev) ?? []), fn])
      return wc
    },
    emit(ev) {
      for (const fn of wc.handlers.get(ev) ?? []) fn({}, '')
    },
    isDestroyed: () => false
  }
  return wc
}
const tabOwner = new Map<FakeWc, { windowId: number; tabId: number }>()
function makeTab(windowId: number, id: number, url: string): FakeTab {
  const t: FakeTab = { id, u: url, url: () => t.u, wc: fakeWc() }
  tabOwner.set(t.wc, { windowId, tabId: id })
  return t
}
function makeWindow(id: number, tabs: FakeTab[]): any {
  return { id, incognito: false, profile: { id: 'default', getSettings: () => ({ skin: 'y1997', bookmarkBar: true }) }, win: { isDestroyed: () => false }, shell: { id: `shell${id}` }, tabs, activeId: tabs[0]!.id }
}

const w1 = makeWindow(1, [makeTab(1, 11, 'https://a.test/'), makeTab(1, 12, 'https://b.test/'), makeTab(1, 13, 'retronet://history/')])
const w2 = makeWindow(2, [makeTab(2, 21, 'https://c.test/')])
const windows = [w1, w2]
let focusedWin: any = w1
const focusListeners: Array<() => void> = []
const structureListeners: Array<(w: any) => void> = []

vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: {
    focused: () => focusedWin,
    get: (id: number) => windows.find((x) => x.id === id) ?? null,
    all: () => windows,
    onWindowFocused: (l: () => void) => focusListeners.push(l),
    onWindowCreated: vi.fn(),
    onWindowClosed: vi.fn()
  }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({
  browserTabs: (w: any) => ({
    active: () => w.tabs.find((t: FakeTab) => t.id === w.activeId) ?? null,
    get: (id: number) => w.tabs.find((t: FakeTab) => t.id === id) ?? null,
    list: () => w.tabs
  }),
  onTabStructureChanged: (l: (w: any) => void) => structureListeners.push(l)
}))
const handlers = new Map<string, (req: any, ctx: any) => unknown>()
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: class extends Error {},
  router: {
    handle: (m: string, fn: any) => handlers.set(m, fn),
    senderInfo: (wc: FakeWc) => {
      const o = tabOwner.get(wc)
      return o ? { role: 'tab', windowId: o.windowId, tabId: o.tabId } : undefined
    }
  }
}))
vi.mock('../../src/main/profiles/profile-manager', () => ({
  profileManager: () => ({ list: () => [{ id: 'default', name: 'Default' }], onChange: vi.fn() })
}))
vi.mock('../../src/main/internal-api/misc', () => ({ broadcastSkinToPages: vi.fn() }))
const showMenu = vi.fn(async () => {})
vi.mock('../../src/main/menus/menu-host', () => ({ showMenu: (...a: unknown[]) => (showMenu as any)(...a) }))
vi.mock('../../src/main/commands/shortcuts', () => ({ attachShortcuts: vi.fn() }))
vi.mock('../../src/main/commands/zoom', () => ({ attachWheelZoom: vi.fn(), zoomActive: vi.fn() }))

let d: typeof import('../../src/main/commands/dispatch')
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

beforeAll(async () => {
  // The rebuild rules are mac-only (the only platform with an app menu bar).
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  d = await import('../../src/main/commands/dispatch')
  d.registerCommands()
  const created = appHandlers.get('web-contents-created')!
  for (const w of windows) for (const t of w.tabs) created({}, t.wc)
  await flush()
  setAtRegistration = setApplicationMenu.mock.calls.length
})

let setAtRegistration = 0
let base = 0
beforeEach(async () => {
  await flush()
  base = d.appMenuBuildCount()
})
const rebuilds = async (): Promise<number> => {
  await flush()
  return d.appMenuBuildCount() - base
}

describe('AC74 app menu rebuilds', () => {
  it('builds once at registration', () => {
    expect(d.appMenuBuildCount()).toBeGreaterThanOrEqual(1)
    expect(setAtRegistration).toBe(1)
  })

  it('background-tab navigations (same window or another window) cause zero rebuilds', async () => {
    for (const t of [w1.tabs[1], w1.tabs[2], w2.tabs[0]]) {
      t.u = t.u.startsWith('https') ? 'retronet://bookmarks/' : 'https://x.test/'
      t.wc.emit('did-navigate')
      t.wc.emit('did-navigate-in-page')
      t.wc.emit('focus')
    }
    // Structure changes from background navigations in either window: the focused window's active tab is unchanged.
    structureListeners.forEach((l) => l(w1))
    structureListeners.forEach((l) => l(w2))
    expect(await rebuilds()).toBe(0)
  })

  it('the active tab navigating without flipping View Source: zero rebuilds', async () => {
    w1.tabs[0].u = 'https://a.test/other'
    w1.tabs[0].wc.emit('did-navigate')
    w1.tabs[0].wc.emit('did-navigate-in-page')
    w1.tabs[0].wc.emit('focus')
    expect(await rebuilds()).toBe(0)
  })

  it('the active tab flipping View Source (http → retronet: → http): one rebuild per flip', async () => {
    w1.tabs[0].u = 'retronet://settings/'
    w1.tabs[0].wc.emit('did-navigate')
    w1.tabs[0].wc.emit('did-navigate-in-page')
    expect(await rebuilds()).toBe(1)
    w1.tabs[0].u = 'https://a.test/'
    w1.tabs[0].wc.emit('did-navigate')
    expect(await rebuilds()).toBe(2)
  })

  it('a tab switch in the focused window refreshes the menu; one in a background window does not', async () => {
    w1.activeId = 12
    structureListeners.forEach((l) => l(w1))
    expect(await rebuilds()).toBe(1)
    w2.activeId = 21
    structureListeners.forEach((l) => l(w2))
    expect(await rebuilds()).toBe(1)
  })

  it('a window switch refreshes the menu', async () => {
    focusedWin = w2
    focusListeners.forEach((l) => l())
    expect(await rebuilds()).toBe(1)
    // w1's active tab navigating is now a background navigation.
    w1.tabs[1].u = w1.tabs[1].u.startsWith('https') ? 'retronet://bookmarks/' : 'https://b.test/'
    w1.tabs[1].wc.emit('did-navigate')
    expect(await rebuilds()).toBe(1)
    focusedWin = w1
    focusListeners.forEach((l) => l())
    expect(await rebuilds()).toBe(2)
  })

  it('appMenuStale compares window, tab and View Source state', () => {
    const b = { windowId: 1, tabId: 11, viewSource: true }
    expect(d.appMenuStale(null, b)).toBe(true)
    expect(d.appMenuStale(b, { ...b })).toBe(false)
    expect(d.appMenuStale(b, { ...b, viewSource: false })).toBe(true)
    expect(d.appMenuStale(b, { ...b, tabId: 12 })).toBe(true)
    expect(d.appMenuStale(b, { ...b, windowId: 2 })).toBe(true)
  })
})

describe('profiles.menu handler', () => {
  it('shows a themed profiles menu below the button and resolves when it closes', async () => {
    let close!: () => void
    showMenu.mockImplementationOnce(() => new Promise<void>((r) => (close = r)) as any)
    const p = handlers.get('profiles.menu')!({ x: 5, y: 6, anchor: { x: 700, y: 30, width: 24, height: 24 }, keyboard: true }, { info: { windowId: 1 } }) as Promise<unknown>
    let done = false
    void p.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    const [w, o] = (showMenu.mock.calls.at(-1) as unknown) as [any, any]
    expect(w).toBe(w1)
    expect(o).toMatchObject({ kind: 'profiles', placement: 'below', anchor: { x: 700, y: 30, width: 24, height: 24 }, keyboard: true, target: w1.shell })
    expect(o.entries[0]).toMatchObject({ id: 'profiles.menu:default', check: 'radio', checked: true })
    close()
    expect(await p).toBeNull()
  })

  it('without an anchor the menu opens at the point', () => {
    expect(d.triggerPlacement({ x: 3, y: 4 })).toEqual({ anchor: { x: 3, y: 4, width: 0, height: 0 }, placement: 'point' })
  })
})
