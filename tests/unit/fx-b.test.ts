// FX-B: context-menu decisions (R3/N2, R4/N3), the HTTP sign-in controller (Q3) and the Print command (Q4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn(), name: 'RetroNet' },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    clipboard: { writeText: vi.fn() },
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

const created: Array<{ url?: string; typed?: boolean; background?: boolean }> = []
const navigated: string[] = []
vi.mock('../../src/main/tabs/tab-manager', () => ({
  browserTabs: () => ({
    create: (o: { url?: string; typed?: boolean; background?: boolean }) => {
      created.push(o)
      return {}
    },
    navigate: (input: string) => {
      navigated.push(input)
      return true
    }
  })
}))
const newWindow = vi.fn()
const newIncognitoWindow = vi.fn()
vi.mock('../../src/main/profiles/profile-manager', () => ({
  profileManager: () => ({ newWindow, newIncognitoWindow, list: () => [] })
}))

import { COMMANDS, findDuplicateAccelerators, getCommand } from '../../src/shared/commands'
import { buildPageMenu, contextOpenable, contextSearchUrl } from '../../src/main/commands/context-menu'
import { printTab } from '../../src/main/commands/dispatch'
import { buildMenuTemplate, templateAccelerators } from '../../src/main/commands/menu'
import { authPromptAllowed, authTarget, cleanRealm, createHttpAuthController, type AuthWindow } from '../../src/main/security/http-auth'

// ---- context menu ----

function params(p: Partial<Record<string, unknown>>): any {
  return {
    x: 1,
    y: 1,
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: {},
    ...p
  }
}

function fakeTab(url: string): any {
  return {
    id: 7,
    url: () => url,
    wc: { navigationHistory: { canGoBack: () => false, canGoForward: () => false } }
  }
}

const w: any = { popup: false, incognito: false, profile: { id: 'default', getSettings: () => ({ searchEngine: 'google' }) }, win: { focus: vi.fn() } }

function ids(items: any[]): string[] {
  return items.map((i) => i.id).filter(Boolean)
}

describe('R4/N3 context menu "Open link" uses the tab context', () => {
  it('web pages can open http(s) links but never retronet: or file:', () => {
    expect(contextOpenable('https://example.com/', 'https://site.test/')).toBe(true)
    expect(contextOpenable('retronet://settings/', 'https://site.test/')).toBe(false)
    expect(contextOpenable('retronet://history/', 'http://site.test/')).toBe(false)
    expect(contextOpenable('file:///etc/passwd', 'https://site.test/')).toBe(false)
    expect(contextOpenable('javascript:alert(1)', 'https://site.test/')).toBe(false)
    expect(contextOpenable('', 'https://site.test/')).toBe(false)
  })
  it('retronet: pages may open retronet: links, but not shell/overlay or file:', () => {
    expect(contextOpenable('retronet://settings/', 'retronet://bookmarks/')).toBe(true)
    expect(contextOpenable('retronet://shell/', 'retronet://bookmarks/')).toBe(false)
    expect(contextOpenable('file:///tmp/x.html', 'retronet://bookmarks/')).toBe(false)
    expect(contextOpenable('file:///tmp/y.html', 'file:///tmp/x.html')).toBe(false)
  })
  it('menu items for a retronet: link on a web page are absent; copy remains', () => {
    const items = buildPageMenu(w, fakeTab('https://evil.test/'), params({ linkURL: 'retronet://settings/' }))
    expect(ids(items)).not.toContain('ctx.openLinkTab')
    expect(ids(items)).not.toContain('ctx.openLinkWindow')
    expect(ids(items)).not.toContain('ctx.openLinkIncognito')
    expect(ids(items)).toContain('ctx.copyLink')
  })
  it('menu offers open-link items for an https link and the internal-page link on a retronet: page', () => {
    expect(ids(buildPageMenu(w, fakeTab('https://a.test/'), params({ linkURL: 'https://b.test/' })))).toContain('ctx.openLinkTab')
    expect(ids(buildPageMenu(w, fakeTab('retronet://history/'), params({ linkURL: 'retronet://settings/' })))).toContain('ctx.openLinkIncognito')
  })
  it('"Open image in new tab" follows the same rule', () => {
    const img = (src: string, tabUrl: string) => ids(buildPageMenu(w, fakeTab(tabUrl), params({ mediaType: 'image', srcURL: src })))
    expect(img('https://cdn.test/a.png', 'https://a.test/')).toContain('ctx.openImage')
    expect(img('file:///Users/me/a.png', 'https://a.test/')).not.toContain('ctx.openImage')
    expect(img('retronet://about/logo.png', 'https://a.test/')).not.toContain('ctx.openImage')
  })
})

describe('R3/N2 context menu "Search for" is always a search', () => {
  beforeEach(() => {
    created.length = 0
    navigated.length = 0
  })
  it('builds the engine search URL for URL-looking and file:/retronet: text', () => {
    expect(contextSearchUrl('file:///etc/passwd', 'google')).toBe('https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd')
    expect(contextSearchUrl('  retronet://settings ', 'duckduckgo')).toBe('https://duckduckgo.com/?q=retronet%3A%2F%2Fsettings')
    expect(contextSearchUrl('example.com', 'bing')).toMatch(/^https:\/\/www\.bing\.com\/search\?q=example\.com$/)
    expect(contextSearchUrl('x'.repeat(5000), 'google').length).toBeLessThan(2100)
  })
  it('clicking the menu item opens the search URL untyped, never through omnibox navigate()', () => {
    const items = buildPageMenu(w, fakeTab('https://a.test/'), params({ selectionText: 'file:///etc/passwd' }))
    const search = items.find((i: any) => i.id === 'ctx.search') as any
    expect(search.label).toBe('Search Google for "file:///etc/passwd"')
    search.click()
    expect(navigated).toEqual([])
    expect(created).toHaveLength(1)
    expect(created[0]!.url).toBe('https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd')
    expect(created[0]!.typed).toBeUndefined()
    expect(created[0]!.background).toBe(false)
  })
})

// ---- Q4 print ----

describe('Q4 Print command', () => {
  it('is registered as CmdOrCtrl+P with no duplicate chords', () => {
    const def = getCommand('file.print')
    expect(def?.accelerator.mac).toEqual(['Cmd+P'])
    expect(def?.accelerator.win).toEqual(['Ctrl+P'])
    expect(def?.palette).toBe(true)
    expect(findDuplicateAccelerators('mac')).toEqual([])
    expect(findDuplicateAccelerators('win')).toEqual([])
    expect(COMMANDS.filter((c) => c.id === 'file.print')).toHaveLength(1)
  })
  it('is in the File menu and its click runs file.print', () => {
    const run = vi.fn()
    const t = buildMenuTemplate(
      { platform: 'mac', appName: 'RetroNet', skin: 'y1997', profiles: [], currentProfileId: null, bookmarkBar: true, devUi: false },
      { run }
    )
    const file = t.find((m) => m.label === 'File')!.submenu as any[]
    const item = file.find((i) => i.id === 'file.print')
    expect(item.accelerator).toBe('Cmd+P')
    item.click()
    expect(run).toHaveBeenCalledWith('file.print')
    expect(templateAccelerators(t).filter((a) => a.accelerator === 'Cmd+P')).toHaveLength(1)
  })
  it('printTab calls webContents.print on web and internal pages, not on gone tabs', () => {
    const tab = (url: string, over: Partial<Record<string, unknown>> = {}) => {
      const print = vi.fn()
      return { print, t: { url: () => url, wc: { isDestroyed: () => false, isCrashed: () => false, print, ...over } } as any }
    }
    const web = tab('https://a.test/')
    expect(printTab(web.t)).toBe(true)
    expect(web.print).toHaveBeenCalledTimes(1)
    const internal = tab('retronet://history/')
    expect(printTab(internal.t)).toBe(true)
    expect(internal.print).toHaveBeenCalledTimes(1)
    const ui = tab('retronet://shell/')
    expect(printTab(ui.t)).toBe(false)
    expect(ui.print).not.toHaveBeenCalled()
    const dead = tab('https://a.test/', { isDestroyed: () => true })
    expect(printTab(dead.t)).toBe(false)
    expect(printTab(null)).toBe(false)
  })
})

// ---- Q3 HTTP auth ----

describe('Q3 HTTP auth: who may prompt', () => {
  it('main-frame navigation to the origin being loaded', () => {
    expect(
      authPromptAllowed({ requestUrl: 'https://intranet.test/a', isRequestForNavigation: true, navigatingTo: 'https://intranet.test/a', committedUrl: 'retronet://newtab/' })
    ).toBe(true)
  })
  it('same-origin subresource of the committed page', () => {
    expect(
      authPromptAllowed({ requestUrl: 'https://site.test/api', isRequestForNavigation: false, navigatingTo: null, committedUrl: 'https://site.test/page' })
    ).toBe(true)
  })
  it('never a cross-origin subresource or iframe', () => {
    expect(
      authPromptAllowed({ requestUrl: 'https://bank.test/img.png', isRequestForNavigation: false, navigatingTo: null, committedUrl: 'https://evil.test/' })
    ).toBe(false)
    expect(
      authPromptAllowed({ requestUrl: 'https://bank.test/', isRequestForNavigation: true, navigatingTo: 'https://evil.test/', committedUrl: 'https://evil.test/' })
    ).toBe(false)
    // A subresource can't borrow the pending navigation's origin.
    expect(
      authPromptAllowed({ requestUrl: 'https://next.test/x', isRequestForNavigation: false, navigatingTo: 'https://next.test/', committedUrl: 'https://evil.test/' })
    ).toBe(false)
    expect(authPromptAllowed({ requestUrl: 'ftp://x/', isRequestForNavigation: true, navigatingTo: 'ftp://x/', committedUrl: '' })).toBe(false)
  })
  it('names the origin or the proxy, and cleans the realm', () => {
    expect(authTarget('http://127.0.0.1:8123/secret', { isProxy: false, host: '127.0.0.1', port: 8123 })).toBe('http://127.0.0.1:8123')
    expect(authTarget('https://site.test/', { isProxy: true, host: 'proxy.lan', port: 3128 })).toBe('proxy.lan:3128')
    expect(cleanRealm('  Admin\u0000\nArea\u2028 ')).toBe('Admin Area')
    expect(cleanRealm('x'.repeat(500)).length).toBe(200)
    expect(cleanRealm(undefined)).toBe('')
  })
})

describe('Q3 HTTP auth controller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const wcA = { id: 1, destroyed: false, isDestroyed() { return this.destroyed } }
    const wcB = { id: 2, destroyed: false, isDestroyed() { return this.destroyed } }
    let kind: string | null = null
    let active: any = wcA
    const shown: any[] = []
    const win: AuthWindow & { hides: number } = {
      id: 10,
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
    const c = createHttpAuthController({ timeoutMs: 1000, pumpMs: 50 })
    return {
      c,
      win,
      wcA,
      wcB,
      shown,
      setKind: (k: string | null) => (kind = k),
      setActive: (x: any) => (active = x)
    }
  }

  it('shows the dialog, passes credentials and hides the overlay', () => {
    const s = setup()
    const cb = vi.fn()
    const id = s.c.request({ wc: s.wcA, win: s.win, host: 'http://h.test', realm: 'R', isProxy: false, callback: cb })
    expect(s.shown).toEqual([{ kind: 'http-auth', id, host: 'http://h.test', realm: 'R', isProxy: false }])
    expect(s.c.respond(99, id, { username: 'u', password: 'p' })).toBe(false) // other window can't answer
    expect(s.c.respond(10, id, { username: 'u', password: 'p' })).toBe(true)
    expect(cb).toHaveBeenCalledWith('u', 'p')
    expect(s.win.hides).toBe(1)
    expect(s.c.pending(10)).toBe(0)
  })
  it('cancel / no username / timeout / tab gone answer with no credentials', () => {
    const s = setup()
    const a = vi.fn()
    const id = s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: '', isProxy: false, callback: a })
    s.c.respond(10, id, { cancel: true, username: 'u', password: 'p' })
    expect(a).toHaveBeenCalledWith()
    const b = vi.fn()
    const id2 = s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: '', isProxy: false, callback: b })
    s.c.respond(10, id2, {}) // no username at all = cancel (R18: '' is a real answer, see fr2-a.test.ts)
    expect(b).toHaveBeenCalledWith()
    const t = vi.fn()
    s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: '', isProxy: false, callback: t })
    vi.advanceTimersByTime(1001)
    expect(t).toHaveBeenCalledWith()
    const n = vi.fn()
    s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: '', isProxy: false, callback: n })
    s.c.cancelFor(s.wcA)
    expect(n).toHaveBeenCalledWith()
    const g = vi.fn()
    s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: '', isProxy: false, callback: g })
    s.wcA.destroyed = true
    vi.advanceTimersByTime(60)
    expect(g).toHaveBeenCalledWith()
    expect(s.c.pending(10)).toBe(0)
  })
  it('waits for a busy overlay and a background tab; re-shows after being replaced', () => {
    const s = setup()
    s.setKind('palette')
    const cb = vi.fn()
    s.c.request({ wc: s.wcB, win: s.win, host: 'h', realm: '', isProxy: false, callback: cb })
    expect(s.shown).toHaveLength(0)
    s.setKind(null)
    vi.advanceTimersByTime(60)
    expect(s.shown).toHaveLength(0) // wcB is a background tab
    s.setActive(s.wcB)
    vi.advanceTimersByTime(60)
    expect(s.shown).toHaveLength(1)
    s.setKind('palette') // the user opened the palette over it
    vi.advanceTimersByTime(60)
    s.setKind(null)
    vi.advanceTimersByTime(120)
    expect(s.shown).toHaveLength(2)
    expect(cb).not.toHaveBeenCalled()
  })
  it('same tab + target + realm share one dialog; window close cancels everything', () => {
    const s = setup()
    const a = vi.fn()
    const b = vi.fn()
    const id1 = s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: 'R', isProxy: false, callback: a })
    const id2 = s.c.request({ wc: s.wcA, win: s.win, host: 'h', realm: 'R', isProxy: false, callback: b })
    expect(id2).toBe(id1)
    expect(s.c.pending(10)).toBe(1)
    s.c.request({ wc: s.wcA, win: s.win, host: 'other', realm: 'R', isProxy: false, callback: vi.fn() })
    expect(s.c.pending(10)).toBe(2)
    s.c.respond(10, id1, { username: 'u', password: 'p' })
    expect(a).toHaveBeenCalledWith('u', 'p')
    expect(b).toHaveBeenCalledWith('u', 'p')
    expect(s.shown.at(-1).host).toBe('other') // next one shown
    s.c.cancelWindow(10)
    expect(s.c.pending(10)).toBe(0)
  })
})
