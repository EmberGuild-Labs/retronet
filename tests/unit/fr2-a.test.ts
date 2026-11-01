// FR2-A: HTTP sign-in head-of-line blocking (R15), empty usernames (R18) and bookmarks without `user:pass@` (F1).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn(), name: 'RetroNet' },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

import { createHttpAuthController, type AuthWindow } from '../../src/main/security/http-auth'
import { BOOKMARK_BAR_ID } from '../../src/shared/types'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'

describe('R15/R18 HTTP auth: two tabs in one window', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const tabA = { id: 1, destroyed: false, isDestroyed() { return this.destroyed } }
    const tabB = { id: 2, destroyed: false, isDestroyed() { return this.destroyed } }
    let kind: string | null = null
    let active: any = tabA
    const shown: any[] = []
    const win: AuthWindow & { hides: number } = {
      id: 7,
      hides: 0,
      showOverlay: (ev: any) => {
        kind = ev.kind
        shown.push(ev)
      },
      hideOverlay() {
        kind = null
        this.hides++
      },
      overlayKind: () => kind,
      activeWc: () => active
    }
    return { c: createHttpAuthController({ timeoutMs: 60_000, pumpMs: 50 }), win, tabA, tabB, shown, setActive: (x: any) => (active = x) }
  }

  it("a background tab's waiting sign-in does not block the active tab's", () => {
    const s = setup()
    const bg = vi.fn()
    // Tab B (background) asks first; nothing shows.
    const idB = s.c.request({ wc: s.tabB, win: s.win, host: 'http://b.test', realm: 'B', isProxy: false, callback: bg })
    expect(s.shown).toHaveLength(0)
    // The active tab A asks next: its dialog shows at once, though B is first in the queue.
    const fg = vi.fn()
    const idA = s.c.request({ wc: s.tabA, win: s.win, host: 'http://a.test', realm: 'A', isProxy: false, callback: fg })
    expect(s.shown.map((e) => e.id)).toEqual([idA])
    s.c.respond(7, idA, { username: 'u', password: 'p' })
    expect(fg).toHaveBeenCalledWith('u', 'p')
    expect(bg).not.toHaveBeenCalled()
    // B's dialog shows once B becomes the active tab.
    s.setActive(s.tabB)
    vi.advanceTimersByTime(60)
    expect(s.shown.map((e) => e.id)).toEqual([idA, idB])
  })

  it("switching tabs hides the shown dialog and shows the new active tab's", () => {
    const s = setup()
    const idA = s.c.request({ wc: s.tabA, win: s.win, host: 'http://a.test', realm: 'A', isProxy: false, callback: vi.fn() })
    const idB = s.c.request({ wc: s.tabB, win: s.win, host: 'http://b.test', realm: 'B', isProxy: false, callback: vi.fn() })
    expect(s.shown.map((e) => e.id)).toEqual([idA])
    s.setActive(s.tabB)
    vi.advanceTimersByTime(60)
    expect(s.win.hides).toBe(1)
    expect(s.shown.map((e) => e.id)).toEqual([idA, idB])
    // Back to A: B's dialog hides, A's shows again (still pending).
    s.setActive(s.tabA)
    vi.advanceTimersByTime(60)
    expect(s.win.hides).toBe(2)
    expect(s.shown.map((e) => e.id)).toEqual([idA, idB, idA])
    expect(s.c.pending(7)).toBe(2)
  })

  it('a tab with no sign-in hides the dialog and shows nothing', () => {
    const s = setup()
    s.c.request({ wc: s.tabA, win: s.win, host: 'h', realm: '', isProxy: false, callback: vi.fn() })
    s.setActive({ id: 3, isDestroyed: () => false })
    vi.advanceTimersByTime(60)
    expect(s.win.overlayKind()).toBeNull()
    expect(s.shown).toHaveLength(1)
  })

  it("R18: an empty username is an answer; cancel or no username cancels", () => {
    const s = setup()
    const a = vi.fn()
    const id = s.c.request({ wc: s.tabA, win: s.win, host: 'h', realm: '', isProxy: false, callback: a })
    expect(s.c.respond(7, id, { username: '', password: 'pw' })).toBe(true)
    expect(a).toHaveBeenCalledWith('', 'pw')
    const b = vi.fn()
    const id2 = s.c.request({ wc: s.tabA, win: s.win, host: 'h', realm: '', isProxy: false, callback: b })
    s.c.respond(7, id2, { username: '', cancel: true })
    expect(b).toHaveBeenCalledWith()
    const c = vi.fn()
    const id3 = s.c.request({ wc: s.tabA, win: s.win, host: 'h', realm: '', isProxy: false, callback: c })
    s.c.respond(7, id3, { password: 'pw' })
    expect(c).toHaveBeenCalledWith()
  })
})

describe('F1 bookmarks never keep user:pass@', () => {
  const cred = 'http://user:secret@site.test/page'
  const bare = 'http://site.test/page'

  it('add/update strip credentials; lookups match the credentialed URL', () => {
    const b = createBookmarksStore(null)
    const id = b.add({ parentId: BOOKMARK_BAR_ID, title: 'T', url: cred })!
    expect((b.find(id) as any).url).toBe(bare)
    expect(b.isBookmarked(cred)).toBe(true)
    expect(b.isBookmarked(bare)).toBe(true)
    expect(b.findByUrl(cred)?.id).toBe(id)
    expect(b.update(id, { url: 'https://a:b@other.test/' })).toBe(true)
    expect((b.find(id) as any).url).toBe('https://other.test/')
    expect(b.isBookmarked('https://x@other.test/')).toBe(true)
    expect(b.removeByUrl('https://a:b@other.test/')).toBe(1)
    expect(b.isBookmarked('https://other.test/')).toBe(false)
    expect(JSON.stringify(b.tree())).not.toContain('secret')
  })

  it('strips credentials from an older bookmarks.json on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-fr2a-'))
    const file = join(dir, 'bookmarks.json')
    const mk = (id: string, title: string) => ({ id, kind: 'folder', title, createdAt: 1, children: [] as any[] })
    const bar = mk(BOOKMARK_BAR_ID, 'Bookmarks Bar')
    const other = mk('other', 'Other Bookmarks')
    const sub = mk('f1', 'Folder')
    sub.children.push({ id: 'b2', kind: 'bookmark', title: 'Nested', url: 'https://n:pw@nested.test/', faviconDataUrl: null, createdAt: 1 })
    bar.children.push({ id: 'b1', kind: 'bookmark', title: 'Old', url: cred, faviconDataUrl: null, createdAt: 1 }, sub)
    writeFileSync(file, JSON.stringify({ bar, other }))
    const b = createBookmarksStore(file, { debounceMs: 0 })
    expect((b.find('b1') as any)?.url).toBe(bare)
    expect((b.find('b2') as any)?.url).toBe('https://nested.test/')
    expect(b.isBookmarked(cred)).toBe(true)
    await b.store.flush()
    const disk = readFileSync(file, 'utf8')
    expect(disk).not.toContain('secret')
    expect(disk).not.toContain('pw@')
  })
})
