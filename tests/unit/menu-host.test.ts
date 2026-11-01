// PLAN-FINAL A2: the themed menu host (registry, menu.pick/menu.dismiss validation, close triggers, busy-kind native
// fallback, focus-then-run) and window-manager's ShowOverlayOptions.onDismiss.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (req: any, ctx: any) => any>(),
  popups: [] as { template: any[]; opts: any }[],
  sent: [] as { wc: any; event: string; payload: any }[],
  errors: [] as string[]
}))

vi.mock('electron', async () => {
  const { EventEmitter: EE } = await import('node:events')
  class FakeWebContents extends EE {
    focused = false
    destroyed = false
    isFocused = () => this.focused
    isDestroyed = () => this.destroyed
    focus = vi.fn(() => void (this.focused = true))
    loadURL = vi.fn(() => Promise.resolve())
    close = vi.fn()
    getURL = () => ''
    send = vi.fn()
  }
  class BrowserWindow extends EE {
    webContents = new FakeWebContents()
    children: any[] = []
    contentView = {
      addChildView: (v: any) => {
        this.children = this.children.filter((c) => c !== v)
        this.children.push(v)
      },
      removeChildView: (v: any) => void (this.children = this.children.filter((c) => c !== v))
    }
    destroyed = false
    title = ''
    constructor(_opts: any) {
      super()
    }
    isDestroyed = () => this.destroyed
    isFullScreen = () => false
    isFocused = () => false
    getContentSize = () => [1000, 700]
    getTitle = () => this.title
    setTitle = (t: string) => void (this.title = t)
    show = vi.fn()
    close = vi.fn()
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    bounds: any = null
    setBackgroundColor = vi.fn()
    setBounds = (b: any) => void (this.bounds = b)
  }
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn(), dock: { hide: vi.fn() } },
    BrowserWindow,
    WebContentsView,
    Menu: { buildFromTemplate: (template: any[]) => ({ popup: (opts: any) => h.popups.push({ template, opts }) }) },
    screen: {}
  }
})
vi.mock('../../src/main/ipc/router', () => ({
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn), registerSender: vi.fn(), senderInfo: () => undefined },
  sendShellEvent: (wc: any, event: string, payload: any) => void h.sent.push({ wc, event, payload })
}))
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (m: string) => void h.errors.push(m) }
}))
vi.mock('../../src/main/security/navigation-guards', () => ({ attachNavigationGuards: vi.fn() }))
vi.mock('../../src/main/security/web-prefs', () => ({ uiWebPreferences: () => ({}) }))
vi.mock('../../src/main/tabs/tab-manager', () => ({
  createTabManager: () => ({ snapshot: () => ({ tabs: [], groups: [], activeTabId: null, canReopenClosed: false }), activeTitle: () => '', focusActive: vi.fn(), dispose: vi.fn(), tabIdFor: () => null }),
  browserTabs: () => ({ active: () => null, closeAllForWindow: () => false })
}))

import {
  BUSY_OVERLAY_KINDS,
  buildMenuItems,
  currentMenu,
  dismissMenu,
  nativeFallbackCount,
  pickMenu,
  registerMenuHostHandlers,
  showMenu,
  type MenuEntry,
  type MenuPick,
  type ShowMenuOptions
} from '../../src/main/menus/menu-host'
import { nativePick, toNativeTemplate } from '../../src/main/menus/native-fallback'
import { WindowManager } from '../../src/main/windows/window-manager'
import { MenuSpecSchema } from '@shared/menu-model'

// ---- A fake WindowContext with window-manager's overlay semantics (replace → old onDismiss; hide → onDismiss) ----

class FakeWc extends EventEmitter {
  destroyed = false
  focus = vi.fn()
  isDestroyed = () => this.destroyed
  paste = vi.fn()
  copy = vi.fn()
  undo = vi.fn()
  redo = vi.fn()
  cut = vi.fn()
  selectAll = vi.fn()
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function fakeWindow(id: number) {
  const win = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed: () => win.destroyed })
  let shown: any = null
  let onDismiss: (() => void) | null = null
  const w: any = {
    id,
    win,
    overlay: { webContents: new FakeWc() },
    shows: [] as any[],
    hides: 0,
    overlayKind: () => shown?.kind ?? null,
    showOverlay: (ev: any, opts: any = {}) => {
      const prev = onDismiss
      shown = ev
      onDismiss = opts.onDismiss ?? null
      w.shows.push({ ev, opts })
      prev?.()
    },
    hideOverlay: () => {
      if (!shown) return
      const prev = onDismiss
      shown = null
      onDismiss = null
      w.hides++
      prev?.()
    },
    close: () => {
      win.destroyed = true
      win.emit('closed')
    }
  }
  return w
}

type Run = ReturnType<typeof vi.fn<(pick: MenuPick) => void>>

const NO_MODS = { meta: false, ctrl: false, shift: false, alt: false }
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function opts(entries: MenuEntry[], extra: Partial<ShowMenuOptions> = {}): ShowMenuOptions {
  return { kind: 'page', label: 'Page', entries, anchor: { x: 10, y: 20, width: 0, height: 0 }, placement: 'point', ...extra }
}

function sampleEntries(runs: Record<'a' | 'off' | 'parent' | 'child', Run>): MenuEntry[] {
  return [
    { id: 'a', label: 'Alpha', run: runs.a },
    { kind: 'separator' },
    { id: 'off', label: 'Disabled', enabled: false, run: runs.off },
    {
      id: 'parent',
      label: 'More',
      run: runs.parent,
      submenu: [{ id: 'child', label: 'Child', run: runs.child }]
    }
  ]
}

/** Open a menu and return its live state. */
function open(w: any, entries: MenuEntry[], extra: Partial<ShowMenuOptions> = {}) {
  let closed = false
  const p = showMenu(w, opts(entries, extra)).then(() => void (closed = true))
  const spec = currentMenu(w.id)!
  return { p, spec, isClosed: () => closed }
}

const pick = (windowId: number, menuId: string, itemId: string, mods = NO_MODS, button: 0 | 1 = 0) =>
  pickMenu(windowId, { menuId, itemId, mods, button })

describe('buildMenuItems', () => {
  it('strips closures, keeps only enabled leaves pickable and trims separators', () => {
    const run = vi.fn()
    const built = buildMenuItems([
      { kind: 'separator' },
      { id: 'x', label: 'X', run, accel: 'CmdOrCtrl+C' },
      { kind: 'separator' },
      { kind: 'separator' },
      { id: 'r', label: 'Radio', check: 'radio', checked: true, run },
      { id: 'd', label: 'D', enabled: false, run },
      { id: 's', label: 'Sub', submenu: [{ id: 's1', label: 'S1', run }] },
      { kind: 'separator' }
    ])!
    expect(built.items).toEqual([
      { kind: 'item', id: 'x', label: 'X', enabled: true, accel: 'CmdOrCtrl+C' },
      { kind: 'separator' },
      { kind: 'item', id: 'r', label: 'Radio', enabled: true, check: 'radio', checked: true },
      { kind: 'item', id: 'd', label: 'D', enabled: false },
      { kind: 'item', id: 's', label: 'Sub', enabled: true, submenu: [{ kind: 'item', id: 's1', label: 'S1', enabled: true }] }
    ])
    expect([...built.actions.keys()].sort()).toEqual(['r', 's1', 'x'])
    expect(JSON.stringify(built.items)).not.toContain('run')
  })

  it('truncates long labels and keeps the full text as the title', () => {
    const long = 'word '.repeat(80)
    const built = buildMenuItems([{ id: 'l', label: long }])!
    const it0 = built.items[0] as any
    expect(it0.label.length).toBeLessThanOrEqual(200)
    expect(it0.label.endsWith('…')).toBe(true)
    expect(it0.title).toBe(long.trim())
  })

  it('rejects repeated ids', () => {
    expect(buildMenuItems([{ id: 'a', label: 'A' }, { id: 's', label: 'S', submenu: [{ id: 'a', label: 'A2' }] }])).toBeNull()
  })
})

describe('showMenu + menu.pick / menu.dismiss', () => {
  let w: any
  let w2: any
  let runs: Record<'a' | 'off' | 'parent' | 'child', Run>
  beforeEach(() => {
    h.handlers.clear()
    h.errors.length = 0
    h.popups.length = 0
    registerMenuHostHandlers()
    w = fakeWindow(1)
    w2 = fakeWindow(2)
    runs = { a: vi.fn(), off: vi.fn(), parent: vi.fn(), child: vi.fn() }
  })
  afterEach(() => {
    w.hideOverlay()
    w2.hideOverlay()
  })

  it('shows a schema-valid spec in a full-window, focused overlay', () => {
    const { spec } = open(w, sampleEntries(runs), { keyboard: true })
    expect(MenuSpecSchema.safeParse(spec).success).toBe(true)
    expect(spec.focusFirst).toBe(true)
    expect(spec.anchor).toEqual({ x: 10, y: 20, width: 0, height: 0 })
    const last = w.shows.at(-1)
    expect(last.ev).toEqual({ kind: 'menu', menu: spec })
    expect(last.opts.focus).toBe(true)
    expect(last.opts.bounds).toBeUndefined() // D-A1: whole content area
    expect(typeof last.opts.onDismiss).toBe('function')
  })

  it('runs the picked action in main by id, after the overlay hid, on setImmediate', async () => {
    const { p, spec, isClosed } = open(w, sampleEntries(runs))
    expect(pick(1, spec.menuId, 'a', { ...NO_MODS, meta: true }, 1)).toBe(true)
    expect(w.overlayKind()).toBeNull()
    expect(runs.a).not.toHaveBeenCalled() // not synchronously
    await p
    expect(isClosed()).toBe(true)
    await flush()
    expect(runs.a).toHaveBeenCalledWith({ mods: { ...NO_MODS, meta: true }, button: 1 })
    expect(currentMenu(1)).toBeNull()
  })

  it('a submenu child is pickable', async () => {
    const { spec } = open(w, sampleEntries(runs))
    expect(pick(1, spec.menuId, 'child')).toBe(true)
    await flush()
    expect(runs.child).toHaveBeenCalledOnce()
  })

  it('through the registered IPC handler, using the sender window', async () => {
    const { spec } = open(w, sampleEntries(runs))
    expect(h.handlers.get('menu.pick')!({ menuId: spec.menuId, itemId: 'a', mods: NO_MODS, button: 0 }, { info: { windowId: 1 } })).toBeNull()
    await flush()
    expect(runs.a).toHaveBeenCalledOnce()
  })

  describe('AC64 rejections: nothing runs, the menu stays', () => {
    const cases: [string, (spec: any) => boolean][] = [
      ['unknown menuId', () => pick(1, '00000000-0000-4000-8000-000000000000', 'a')],
      ['unknown item id', (s) => pick(1, s.menuId, 'nope')],
      ['disabled item', (s) => pick(1, s.menuId, 'off')],
      ['submenu parent', (s) => pick(1, s.menuId, 'parent')],
      ['another window (same menuId)', (s) => pick(2, s.menuId, 'a')],
      ['handler from another window', (s) => h.handlers.get('menu.pick')!({ menuId: s.menuId, itemId: 'a', mods: NO_MODS, button: 0 }, { info: { windowId: 2 } }) === true]
    ]
    for (const [name, attempt] of cases) {
      it(name, async () => {
        const { spec, isClosed } = open(w, sampleEntries(runs))
        expect(attempt(spec)).toBe(false)
        await flush()
        for (const r of Object.values(runs)) expect(r).not.toHaveBeenCalled()
        expect(isClosed()).toBe(false)
        expect(currentMenu(1)).toBe(spec)
        expect(w.overlayKind()).toBe('menu')
      })
    }
  })

  it('stale menuId: a pick for the previous menu does nothing after a new one opened', async () => {
    const first = open(w, sampleEntries(runs))
    const second = open(w, [{ id: 'b', label: 'B', run: runs.parent }])
    await first.p
    expect(first.isClosed()).toBe(true)
    expect(pick(1, first.spec.menuId, 'a')).toBe(false)
    await flush()
    expect(runs.a).not.toHaveBeenCalled()
    expect(currentMenu(1)).toBe(second.spec)
  })

  it('a pick when the overlay no longer shows the menu does nothing', async () => {
    const { spec } = open(w, sampleEntries(runs))
    w.showOverlay({ kind: 'palette', profiles: [], currentProfileId: 'p' }) // another overlay took over
    expect(pick(1, spec.menuId, 'a')).toBe(false)
    await flush()
    expect(runs.a).not.toHaveBeenCalled()
  })

  it('a pick after isValid() turned false (tab navigated) does not run and closes the menu', async () => {
    let valid = true
    const { p, spec } = open(w, sampleEntries(runs), { isValid: () => valid })
    valid = false
    expect(pick(1, spec.menuId, 'a')).toBe(false)
    await p
    await flush()
    expect(runs.a).not.toHaveBeenCalled()
    expect(w.overlayKind()).toBeNull()
  })

  it('a throwing isValid() counts as invalid', async () => {
    let calls = 0
    const { spec } = open(w, sampleEntries(runs), {
      isValid: () => {
        if (calls++ > 0) throw new Error('boom')
        return true
      }
    })
    expect(pick(1, spec.menuId, 'a')).toBe(false)
    await flush()
    expect(runs.a).not.toHaveBeenCalled()
  })

  it('the target tab closing closes the menu, and a late pick does nothing', async () => {
    const target = new FakeWc()
    const { p, spec, isClosed } = open(w, sampleEntries(runs), { target: target as any })
    target.destroy()
    await p
    expect(isClosed()).toBe(true)
    expect(w.overlayKind()).toBeNull()
    expect(pick(1, spec.menuId, 'a')).toBe(false)
    await flush()
    expect(runs.a).not.toHaveBeenCalled()
  })

  it('is not shown when isValid() is already false or the target is gone', async () => {
    await showMenu(w, opts(sampleEntries(runs), { isValid: () => false }))
    const gone = new FakeWc()
    gone.destroyed = true
    await showMenu(w, opts(sampleEntries(runs), { target: gone as any }))
    expect(w.shows).toHaveLength(0)
  })

  it('menu.dismiss closes only the current menu; an old menuId leaves the newer one open', async () => {
    const first = open(w, sampleEntries(runs))
    const second = open(w, sampleEntries(runs))
    expect(dismissMenu(1, first.spec.menuId)).toBe(false)
    expect(h.handlers.get('menu.dismiss')!({ menuId: first.spec.menuId }, { info: { windowId: 1 } })).toBeNull()
    expect(currentMenu(1)).toBe(second.spec)
    expect(w.overlayKind()).toBe('menu')
    expect(dismissMenu(2, second.spec.menuId)).toBe(false) // other window
    expect(dismissMenu(1, second.spec.menuId)).toBe(true)
    await second.p
    expect(second.isClosed()).toBe(true)
    expect(w.hides).toBe(1)
  })

  it('one menu per window; menus in different windows are independent', async () => {
    const a = open(w, sampleEntries(runs))
    const b = open(w2, sampleEntries(runs))
    expect(currentMenu(1)).toBe(a.spec)
    expect(currentMenu(2)).toBe(b.spec)
    const c = open(w, sampleEntries(runs))
    await a.p
    expect(a.isClosed()).toBe(true)
    expect(b.isClosed()).toBe(false)
    expect(currentMenu(1)).toBe(c.spec)
    expect(w.hides).toBe(0) // replaced in place, no hide/show flicker
  })

  it('another overlay replacing the menu resolves it (onDismiss)', async () => {
    const { p, spec } = open(w, sampleEntries(runs))
    w.showOverlay({ kind: 'dialog', dialog: { id: 'd' } })
    await p
    expect(currentMenu(1)).toBeNull()
    expect(pick(1, spec.menuId, 'a')).toBe(false)
  })

  for (const ev of ['blur', 'resize', 'move', 'enter-full-screen', 'leave-full-screen']) {
    it(`window ${ev} closes the menu`, async () => {
      const { p } = open(w, sampleEntries(runs))
      w.win.emit(ev)
      await p
      expect(w.overlayKind()).toBeNull()
      expect(w.win.listenerCount(ev)).toBe(0) // listeners removed
    })
  }

  it('R-14: the window closing resolves a pending menu', async () => {
    const { p, isClosed } = open(w, sampleEntries(runs))
    w.close()
    await p
    expect(isClosed()).toBe(true)
    expect(currentMenu(1)).toBeNull()
  })

  it('edit actions focus the target first, then run on it', async () => {
    const target = new FakeWc()
    const order: string[] = []
    target.focus.mockImplementation(() => void order.push('focus'))
    target.paste.mockImplementation(() => void order.push('paste'))
    const replace = vi.fn(() => void order.push('replace'))
    const { spec } = open(w, [{ id: 'edit.paste', label: 'Paste', role: 'paste' }, { id: 'spell.0', label: 'word', run: replace, focusTarget: true }], {
      kind: 'edit',
      label: 'Edit',
      target: target as any
    })
    expect(pick(1, spec.menuId, 'edit.paste')).toBe(true)
    await flush()
    expect(order).toEqual(['focus', 'paste'])
    const again = open(w, [{ id: 'spell.0', label: 'word', run: replace, focusTarget: true }], { target: target as any })
    pick(1, again.spec.menuId, 'spell.0')
    await flush()
    expect(order).toEqual(['focus', 'paste', 'focus', 'replace'])
  })

  it('a throwing action is caught and logged', async () => {
    const { spec } = open(w, [{ id: 'x', label: 'X', run: () => { throw new Error('nope') } }])
    pick(1, spec.menuId, 'x')
    await flush()
    expect(h.errors.some((e) => e.includes('menu action x failed'))).toBe(true)
  })

  it('a menu that fails its schema (bad id) or repeats an id is not shown', async () => {
    await showMenu(w, opts([{ id: 'bad id!', label: 'X' }]))
    await showMenu(w, opts([{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]))
    expect(w.shows).toHaveLength(0)
    expect(h.errors).toHaveLength(2)
  })

  describe('D-A3 native fallback', () => {
    for (const kind of ['dialog', 'http-auth', 'permission', 'group-editor'] as const) {
      it(`while the overlay shows ${kind}: native popup, the prompt stays`, async () => {
        w.showOverlay({ kind })
        const before = nativeFallbackCount()
        const p = showMenu(w, opts(sampleEntries(runs), { anchor: { x: 5.4, y: 7, width: 30, height: 20 }, placement: 'below' }))
        expect(w.overlayKind()).toBe(kind)
        expect(currentMenu(1)).toBeNull()
        expect(nativeFallbackCount()).toBe(before + 1)
        expect(h.popups).toHaveLength(1)
        const { template, opts: popOpts } = h.popups[0]!
        expect(popOpts).toMatchObject({ window: w.win, x: 5, y: 27 })
        template[0].click(null, null, { metaKey: true })
        await flush()
        expect(runs.a).toHaveBeenCalledWith({ mods: { ...NO_MODS, meta: true }, button: 0 })
        popOpts.callback()
        await p
      })
    }
    it('covers exactly the busy kinds', () => {
      expect([...BUSY_OVERLAY_KINDS].sort()).toEqual(['dialog', 'group-editor', 'http-auth', 'permission'])
    })

    it('transient overlays (suggest, palette, fullscreen-notice) are replaced by the themed menu', () => {
      for (const kind of ['suggest', 'palette', 'fullscreen-notice']) {
        w.showOverlay({ kind })
        open(w, sampleEntries(runs))
        expect(w.overlayKind()).toBe('menu')
      }
      expect(h.popups).toHaveLength(0)
    })

    it("the overlay's own text fields always get the native menu", async () => {
      w.showOverlay({ kind: 'palette' })
      const p = showMenu(w, opts([{ id: 'edit.copy', label: 'Copy', role: 'copy' }], { kind: 'edit', target: w.overlay.webContents }))
      expect(w.overlayKind()).toBe('palette')
      expect(h.popups).toHaveLength(1)
      h.popups[0]!.template[0].click(null, null, undefined)
      await flush()
      expect(w.overlay.webContents.focus).toHaveBeenCalled()
      expect(w.overlay.webContents.copy).toHaveBeenCalled()
      h.popups[0]!.opts.callback()
      await p
    })

    it('a native pick after isValid() turned false does nothing', async () => {
      let valid = true
      w.showOverlay({ kind: 'dialog' })
      void showMenu(w, opts(sampleEntries(runs), { isValid: () => valid }))
      valid = false
      h.popups[0]!.template[0].click(null, null, undefined)
      await flush()
      expect(runs.a).not.toHaveBeenCalled()
    })
  })
})

describe('toNativeTemplate', () => {
  it('maps items, checks, submenus and accelerators; disabled items and parents have no click', () => {
    const onPick = vi.fn()
    const t = toNativeTemplate(
      [
        { id: 'a', label: 'A & B', accel: 'CmdOrCtrl+C' },
        { kind: 'separator' },
        { id: 'r', label: 'R', check: 'radio', checked: true },
        { id: 'c', label: 'C', check: 'check' },
        { id: 'd', label: 'D', enabled: false },
        { id: 's', label: 'S', submenu: [{ id: 's1', label: 'S1' }] }
      ],
      onPick,
      'win32'
    )
    expect(t[0]).toMatchObject({ id: 'a', label: 'A && B', enabled: true, accelerator: 'CmdOrCtrl+C', registerAccelerator: false })
    expect(t[1]).toEqual({ type: 'separator' })
    expect(t[2]).toMatchObject({ type: 'radio', checked: true })
    expect(t[3]).toMatchObject({ type: 'checkbox', checked: false })
    expect(t[4]!.click).toBeUndefined()
    expect(t[5]!.click).toBeUndefined()
    expect((t[5]!.submenu as any[])[0].click).toBeTypeOf('function')
    expect(toNativeTemplate([{ id: 'a', label: 'A & B' }], onPick, 'darwin')[0]!.label).toBe('A & B')
    ;(t[0]!.click as any)(null, null, { shiftKey: true })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), { mods: { ...NO_MODS, shift: true }, button: 0 })
    expect(nativePick(undefined)).toEqual({ mods: NO_MODS, button: 0 })
  })
})

describe('window-manager ShowOverlayOptions.onDismiss', () => {
  const profile: any = {
    id: 'p',
    name: 'P',
    incognito: false,
    getSettings: () => ({ skin: 'y1997', reducedMotion: false, bookmarkBar: true }),
    info: () => ({})
  }

  it('fires once on replacement, on hide and on window close; never for the new event', () => {
    const wm = new WindowManager()
    const w = wm.createWindow({ profile })
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    w.showOverlay({ kind: 'palette', profiles: [], currentProfileId: 'p' }, { onDismiss: first })
    w.showOverlay({ kind: 'fullscreen-notice', host: 'x' }, { onDismiss: second })
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    w.hideOverlay()
    expect(second).toHaveBeenCalledOnce()
    w.hideOverlay()
    expect(second).toHaveBeenCalledOnce()
    w.showOverlay({ kind: 'fullscreen-notice', host: 'x' }, { onDismiss: third })
    ;(w.win as any).emit('closed')
    expect(third).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
  })

  it('a throwing onDismiss does not break the overlay', () => {
    const wm = new WindowManager()
    const w = wm.createWindow({ profile })
    w.showOverlay({ kind: 'fullscreen-notice', host: 'x' }, {
      onDismiss: () => {
        throw new Error('x')
      }
    })
    expect(() => w.hideOverlay()).not.toThrow()
    expect(w.overlayKind()).toBeNull()
  })

  it('a menu event shown with bounds gets an overlay-local anchor', () => {
    const wm = new WindowManager()
    const w = wm.createWindow({ profile })
    h.sent.length = 0
    ;(w.overlay.webContents as any).emit('did-finish-load')
    const menu = { menuId: '00000000-0000-4000-8000-000000000000', kind: 'page', label: 'Page', anchor: { x: 50, y: 60, width: 0, height: 0 }, placement: 'point', focusFirst: false, platform: 'mac', items: [] as [] } as const
    w.showOverlay({ kind: 'menu', menu }, { bounds: { x: 10, y: 20, width: 100, height: 100 } })
    const ev = h.sent.filter((s) => s.event === 'overlay').at(-1)!.payload
    expect(ev.menu.anchor).toEqual({ x: 40, y: 40, width: 0, height: 0 })
  })
})
