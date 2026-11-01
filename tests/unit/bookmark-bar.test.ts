import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    shown: [] as { opts: any; close: () => void }[]
  }
})

vi.mock('electron', () => ({ Menu: {}, app: { getPath: () => '' } }))
vi.mock('../../src/main/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../src/main/menus/menu-host', async (orig) => ({
  ...(await orig<typeof import('../../src/main/menus/menu-host')>()),
  showMenu: (_w: any, opts: any) => new Promise<void>((resolve) => h.shown.push({ opts, close: resolve }))
}))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: h.IpcFailure,
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn) },
  sendPageEvent: vi.fn()
}))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: { get: (id: number) => h.windows.get(id) ?? null, all: () => [...h.windows.values()], onWindowCreated: () => () => {} }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({ browserTabs: (w: any) => w.tabMgr }))

import { buildFolderTemplate, openDisposition, pickToClick, registerBookmarkBarHandlers } from '../../src/main/bookmarks/bar'
import { watchBookmarks } from '../../src/main/bookmarks/changes'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'
import { buildMenuItems } from '../../src/main/menus/menu-host'
import { MENU_NODES_MAX, MenuSpecSchema, menuDepth } from '../../src/shared/menu-model'
import { BOOKMARK_BAR_ID, type BookmarkNode } from '../../src/shared/types'

function mkWindow(id: number, bookmarks: any) {
  return {
    id,
    profile: { id: 'p', stores: { bookmarks } },
    win: { isDestroyed: () => false },
    tabMgr: { refresh: vi.fn(), navigate: vi.fn() }
  } as any
}
const call = (m: string, req: any, windowId = 1) => h.handlers.get(m)!(req, { info: { windowId } })

describe('bookmark bar handlers', () => {
  let store: ReturnType<typeof createBookmarksStore>
  let w: any
  beforeEach(() => {
    h.handlers.clear()
    h.windows.clear()
    h.shown.length = 0
    store = createBookmarksStore(null)
    w = mkWindow(1, store)
    h.windows.set(1, w)
    registerBookmarkBarHandlers()
  })

  it('bookmarks.bar returns the Bar children', () => {
    const f = store.addFolder({ parentId: BOOKMARK_BAR_ID, title: 'F' })!
    store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })
    store.add({ parentId: f, title: 'Inner', url: 'https://i.test/' })
    const r = call('bookmarks.bar', {})
    expect(r.items.map((n: any) => n.title)).toEqual(['F', 'A'])
  })

  it('barFolderMenu builds nested submenus and resolves when the menu closes', async () => {
    const f = store.addFolder({ parentId: BOOKMARK_BAR_ID, title: 'F' })!
    store.addFolder({ parentId: f, title: 'Empty' })
    const inner = store.add({ parentId: f, title: 'Inner', url: 'https://i.test/' })!
    let settled = false
    const p = call('bookmarks.barFolderMenu', { folderId: BOOKMARK_BAR_ID, x: 10, y: 20, anchor: { x: 5, y: 6, width: 30, height: 12 }, keyboard: true }).then((r: any) => ((settled = true), r))
    expect(h.shown).toHaveLength(1)
    const { opts, close } = h.shown[0]!
    expect(opts).toMatchObject({ kind: 'bookmarks', placement: 'below', anchor: { x: 5, y: 6, width: 30, height: 12 }, keyboard: true })
    const e = opts.entries
    expect(e[0].label).toBe('F')
    expect(e[0].submenu.map((i: any) => i.label)).toEqual(['Empty', 'Inner'])
    expect(e[0].submenu[0].submenu).toEqual([{ id: expect.stringMatching(/^bm:empty:/), label: '(Empty)', enabled: false }])
    expect(e[0].submenu[1].id).toBe(`bm:${inner}`)
    e[0].submenu[1].run({ mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 })
    expect(w.tabMgr.navigate).toHaveBeenCalledWith('https://i.test/', { disposition: 'current' })
    await Promise.resolve()
    expect(settled).toBe(false)
    close()
    await expect(p).resolves.toBeNull()
  })

  it('without an anchor the menu opens at the point', () => {
    store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })
    void call('bookmarks.barFolderMenu', { folderId: BOOKMARK_BAR_ID, x: 3, y: 4 })
    expect(h.shown[0]!.opts).toMatchObject({ placement: 'point', anchor: { x: 3, y: 4, width: 0, height: 0 } })
  })

  it('a bookmark deleted while the menu is open is not opened', () => {
    const id = store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })!
    void call('bookmarks.barFolderMenu', { folderId: BOOKMARK_BAR_ID, x: 0, y: 0 })
    store.remove(id)
    h.shown[0]!.opts.entries[0].run({ mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 })
    expect(w.tabMgr.navigate).not.toHaveBeenCalled()
    expect(h.shown[0]!.opts.isValid()).toBe(true) // the Bar itself is still there
  })

  it('unknown folder and bookmark ids are E_NOT_FOUND', async () => {
    const id = store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })!
    await expect(call('bookmarks.barFolderMenu', { folderId: 'nope', x: 0, y: 0 })).rejects.toBeInstanceOf(h.IpcFailure)
    await expect(call('bookmarks.barFolderMenu', { folderId: id, x: 0, y: 0 })).rejects.toBeInstanceOf(h.IpcFailure)
  })

  it('click modifiers and middle click pick the disposition', () => {
    expect(openDisposition({}, 'darwin')).toBe('current')
    expect(openDisposition({ metaKey: true }, 'darwin')).toBe('background-tab')
    expect(openDisposition({ ctrlKey: true }, 'darwin')).toBe('current')
    expect(openDisposition({ ctrlKey: true }, 'win32')).toBe('background-tab')
    expect(openDisposition({ shiftKey: true }, 'win32')).toBe('new-tab')
    expect(openDisposition({ button: 1 }, 'win32')).toBe('background-tab')
    expect(openDisposition({ button: 1, shiftKey: true }, 'darwin')).toBe('background-tab')
    expect(pickToClick({ mods: { meta: true, ctrl: false, shift: true, alt: false }, button: 1 })).toEqual({ metaKey: true, ctrlKey: false, shiftKey: true, button: 1 })
  })
})

const bm = (i: number): BookmarkNode => ({ id: `b${i}`, kind: 'bookmark', title: `T${i}`, url: `https://x.test/${i}`, faviconDataUrl: null, createdAt: 0 })
const folder = (id: string, children: BookmarkNode[], title = id): BookmarkNode => ({ id, kind: 'folder', title, children, createdAt: 0 }) as BookmarkNode
const opts = { open: vi.fn(), openManager: vi.fn() }
const count = (items: any[]): number => items.reduce((n, i) => n + 1 + (i.submenu ? count(i.submenu) : 0), 0)
const PICK = { mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 as const }

describe('buildFolderTemplate', () => {
  it('uses plain labels (no & escaping), full text as title, and truncates at 60', () => {
    const long = 'x'.repeat(100)
    const t = buildFolderTemplate([{ ...bm(1), title: 'a&b' }, { ...bm(2), title: long }], opts) as any[]
    expect(t[0].label).toBe('a&b')
    expect(t[0].title).toBe('https://x.test/1')
    expect(t[1].label).toHaveLength(60)
    expect(t[1].label.endsWith('…')).toBe(true)
  })

  it('empty folders show a disabled (Empty) item', () => {
    expect(buildFolderTemplate([], opts)).toEqual([{ id: expect.any(String), label: '(Empty)', enabled: false }])
  })

  it('stays within 8 levels: the 8th level is a disabled (Too deep) item and the spec validates', () => {
    let node: BookmarkNode = folder('f10', [])
    for (let i = 9; i >= 1; i--) node = folder(`f${i}`, [node])
    const t = buildFolderTemplate([node], opts)
    expect(menuDepth(buildMenuItems(t)!.items)).toBe(8)
    let cur: any = t[0]
    let levels = 1
    while (cur.submenu) {
      cur = cur.submenu[0]
      levels++
    }
    expect(levels).toBe(8)
    expect(cur).toMatchObject({ label: '(Too deep)', enabled: false })
  })

  it('caps a level at 400 items with a separator and "More in Bookmarks manager…"', () => {
    const t = buildFolderTemplate(Array.from({ length: 450 }, (_, i) => bm(i)), opts) as any[]
    expect(t).toHaveLength(400)
    expect(t[397].label).toBe('T397')
    expect(t[398]).toEqual({ kind: 'separator' })
    expect(t[399].label).toBe('More in Bookmarks manager…')
    t[399].run(PICK)
    expect(opts.openManager).toHaveBeenCalledWith({ metaKey: false, ctrlKey: false, shiftKey: false, button: 0 })
  })

  it('caps the whole tree at 5000 nodes and ends the root with the More item', () => {
    const folders = Array.from({ length: 20 }, (_, f) => folder(`g${f}`, Array.from({ length: 400 }, (_, i) => bm(f * 1000 + i))))
    const t = buildFolderTemplate(folders, opts) as any[]
    expect(count(t)).toBeLessThanOrEqual(MENU_NODES_MAX)
    expect(t[t.length - 1].label).toBe('More in Bookmarks manager…')
    expect(t[t.length - 2]).toEqual({ kind: 'separator' })
    const spec = buildMenuItems(t)!.items
    expect(MenuSpecSchema.safeParse({ menuId: crypto.randomUUID(), kind: 'bookmarks', label: 'B', anchor: { x: 0, y: 0, width: 0, height: 0 }, placement: 'point', focusFirst: false, platform: 'mac', items: spec }).success).toBe(true)
  })

  it('an uncapped menu has no More item; ids are unique', () => {
    const t = buildFolderTemplate([bm(1), folder('f', [bm(2)])], opts) as any[]
    expect(t.map((i) => i.label)).toEqual(['T1', 'f'])
    expect(buildMenuItems(t)).not.toBeNull()
  })
})

describe('bookmark change push', () => {
  it('any store mutation refreshes windows sharing the store and sends them the bookmarks event, once per burst', async () => {
    h.windows.clear()
    const store = createBookmarksStore(null)
    const other = createBookmarksStore(null)
    const w1 = { ...mkWindow(1, store), sendShell: vi.fn() }
    const w2 = { ...mkWindow(2, other), sendShell: vi.fn() }
    // An incognito window shares its parent's store (D7): it follows too.
    const w3 = { ...mkWindow(3, store), sendShell: vi.fn() }
    h.windows.set(1, w1)
    h.windows.set(2, w2)
    h.windows.set(3, w3)
    watchBookmarks(store)
    watchBookmarks(store) // idempotent
    const id = store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })!
    store.update(id, { title: 'B' }) // same burst
    expect(w1.tabMgr.refresh).not.toHaveBeenCalled() // coalesced to the end of the synchronous burst
    await Promise.resolve()
    expect(w1.tabMgr.refresh).toHaveBeenCalledTimes(1)
    expect(w1.sendShell).toHaveBeenCalledTimes(1)
    expect(w1.sendShell).toHaveBeenCalledWith('bookmarks', null)
    expect(w3.sendShell).toHaveBeenCalledWith('bookmarks', null)
    expect(w2.tabMgr.refresh).not.toHaveBeenCalled()
    expect(w2.sendShell).not.toHaveBeenCalled()
    store.removeByUrl('https://a.test/')
    await Promise.resolve()
    expect(w1.tabMgr.refresh).toHaveBeenCalledTimes(2)
    expect(w1.sendShell).toHaveBeenCalledTimes(2)
  })
})
