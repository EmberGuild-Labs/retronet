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
    popups: [] as { template: any[]; opts: any }[]
  }
})

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: any[]) => ({ popup: (opts: any) => h.popups.push({ template, opts }) })
  }
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

import { buildFolderTemplate, openDisposition, registerBookmarkBarHandlers } from '../../src/main/bookmarks/bar'
import { watchBookmarks } from '../../src/main/bookmarks/changes'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'
import { BOOKMARK_BAR_ID } from '../../src/shared/types'

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
    h.popups.length = 0
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
    store.add({ parentId: f, title: 'Inner', url: 'https://i.test/' })
    const p = call('bookmarks.barFolderMenu', { folderId: BOOKMARK_BAR_ID, x: 10.4, y: 20 })
    expect(h.popups).toHaveLength(1)
    const { template, opts } = h.popups[0]!
    expect(opts).toMatchObject({ x: 10, y: 20 })
    expect(template[0].label).toBe('F')
    expect(template[0].submenu.map((i: any) => i.label)).toEqual(['Empty', 'Inner'])
    expect(template[0].submenu[0].submenu).toEqual([{ label: '(Empty)', enabled: false }])
    template[0].submenu[1].click({}, undefined, {})
    expect(w.tabMgr.navigate).toHaveBeenCalledWith('https://i.test/', { disposition: 'current' })
    opts.callback()
    await expect(p).resolves.toBeNull()
  })

  it('unknown folder and bookmark ids are E_NOT_FOUND', () => {
    const id = store.add({ parentId: BOOKMARK_BAR_ID, title: 'A', url: 'https://a.test/' })!
    expect(() => call('bookmarks.barFolderMenu', { folderId: 'nope', x: 0, y: 0 })).toThrow(h.IpcFailure)
    expect(() => call('bookmarks.barFolderMenu', { folderId: id, x: 0, y: 0 })).toThrow(h.IpcFailure)
  })

  it('click modifiers pick the disposition', () => {
    expect(openDisposition({}, 'darwin')).toBe('current')
    expect(openDisposition({ metaKey: true }, 'darwin')).toBe('background-tab')
    expect(openDisposition({ ctrlKey: true }, 'darwin')).toBe('current')
    expect(openDisposition({ ctrlKey: true }, 'win32')).toBe('background-tab')
    expect(openDisposition({ shiftKey: true }, 'win32')).toBe('new-tab')
    const open = vi.fn()
    const t = buildFolderTemplate([{ id: 'x', kind: 'bookmark', title: 'a&b', url: 'https://x.test/', faviconDataUrl: null, createdAt: 0 }], open, 'win32')
    expect(t[0]!.label).toBe('a&&b')
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
