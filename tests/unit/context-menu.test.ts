// A5: page, edit and profile menus as MenuEntry[] (AC60, AC61) and their showMenu wiring (anchor offset, isValid,
// target). showMenu is stubbed: nothing is drawn and no native menu can pop up.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn(), name: 'RetroNet' },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: vi.fn() },
    clipboard: { writeText: vi.fn() },
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

const showMenu = vi.fn(async (_w: unknown, _o: unknown) => {})
vi.mock('../../src/main/menus/menu-host', () => ({ showMenu: (w: unknown, o: unknown) => showMenu(w, o) }))

const created: Array<{ url?: string; background?: boolean }> = []
const tabsInWindow = new Map<number, unknown>()
vi.mock('../../src/main/tabs/tab-manager', () => ({
  browserTabs: () => ({
    create: (o: { url?: string }) => {
      created.push(o)
      return {}
    },
    get: (id: number) => tabsInWindow.get(id)
  })
}))
const switched: string[] = []
vi.mock('../../src/main/profiles/profile-manager', () => ({
  profileManager: () => ({
    newWindow: vi.fn(),
    newIncognitoWindow: vi.fn(),
    list: () => [
      { id: 'default', name: 'Default' },
      { id: 'work', name: 'Work' }
    ]
  })
}))

import { buildPageMenu, buildProfilesMenu, buildUiMenu, showContextMenu } from '../../src/main/commands/context-menu'

function params(p: Partial<Record<string, unknown>> = {}): any {
  return {
    x: 10,
    y: 20,
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    menuSourceType: 'mouse',
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    ...p
  }
}

function fakeTab(url: string): any {
  let index = 0
  let cur = url
  const wc = {
    isDestroyed: () => false,
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() },
    copyImageAt: vi.fn(),
    inspectElement: vi.fn(),
    isDevToolsOpened: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, getActiveIndex: () => index }
  }
  return {
    id: 7,
    url: () => cur,
    wc,
    back: vi.fn(),
    _nav: (u: string) => {
      cur = u
      index++
    }
  }
}

const w: any = {
  id: 1,
  popup: false,
  incognito: false,
  profile: { id: 'default', getSettings: () => ({ searchEngine: 'google' }) },
  win: { focus: vi.fn(), isDestroyed: () => false },
  shell: { id: 'shell' },
  tabBounds: () => ({ x: 0, y: 84, width: 800, height: 500 })
}

const ids = (items: any[]): string[] => items.map((i) => i.id).filter(Boolean)
const kinds = (items: any[]): string => items.map((i) => (i.kind === 'separator' ? '-' : i.id)).join(' ')

beforeEach(() => {
  showMenu.mockClear()
  created.length = 0
  switched.length = 0
  tabsInWindow.clear()
})

describe('page menu item sets (AC60)', () => {
  it('plain page: back/forward/reload, select all, view source, inspect', () => {
    expect(kinds(buildPageMenu(w, fakeTab('https://a.test/'), params()))).toBe(
      'ctx.back ctx.forward ctx.reload - ctx.selectAll - ctx.viewSource ctx.inspect'
    )
  })
  it('internal page: no view source', () => {
    expect(ids(buildPageMenu(w, fakeTab('retronet://history/'), params()))).toEqual(['ctx.back', 'ctx.forward', 'ctx.reload', 'ctx.selectAll', 'ctx.inspect'])
  })
  it('link: open items only when contextOpenable, copy always', () => {
    expect(ids(buildPageMenu(w, fakeTab('https://a.test/'), params({ linkURL: 'https://b.test/' })))).toEqual([
      'ctx.openLinkTab',
      'ctx.openLinkWindow',
      'ctx.openLinkIncognito',
      'ctx.copyLink',
      'ctx.viewSource',
      'ctx.inspect'
    ])
    expect(ids(buildPageMenu(w, fakeTab('https://a.test/'), params({ linkURL: 'retronet://settings/' })))).toEqual([
      'ctx.copyLink',
      'ctx.viewSource',
      'ctx.inspect'
    ])
  })
  it('image: open (when openable), save (http/data only), copy, copy address', () => {
    expect(ids(buildPageMenu(w, fakeTab('https://a.test/'), params({ mediaType: 'image', srcURL: 'https://cdn.test/a.png' })))).toEqual([
      'ctx.openImage',
      'ctx.saveImage',
      'ctx.copyImage',
      'ctx.copyImageAddress',
      'ctx.viewSource',
      'ctx.inspect'
    ])
    const file = ids(buildPageMenu(w, fakeTab('https://a.test/'), params({ mediaType: 'image', srcURL: 'file:///a.png' })))
    expect(file).not.toContain('ctx.openImage')
    expect(file).not.toContain('ctx.saveImage')
  })
  it('selection: copy (edit role) and an engine search', () => {
    const items = buildPageMenu(w, fakeTab('https://a.test/'), params({ selectionText: '  hello  ' })) as any[]
    expect(ids(items)).toEqual(['ctx.copy', 'ctx.search', 'ctx.viewSource', 'ctx.inspect'])
    expect(items[0].role).toBe('copy')
    expect(items[1].label).toBe('Search Google for "hello"')
    items[1].run()
    expect(created[0]!.url).toBe('https://www.google.com/search?q=hello')
  })
  it('editable with a misspelling: up to 5 suggestions, add to dictionary, then edit items', () => {
    const tab = fakeTab('https://a.test/')
    const items = buildPageMenu(
      w,
      tab,
      params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tee', 'tech', 'toe'] })
    ) as any[]
    expect(kinds(items)).toBe(
      'spell.suggest:0 spell.suggest:1 spell.suggest:2 spell.suggest:3 spell.suggest:4 spell.add - edit.undo edit.redo - edit.cut edit.copy edit.paste edit.selectAll - ctx.viewSource ctx.inspect'
    )
    const s0 = items[0]
    expect(s0.label).toBe('the')
    expect(s0.focusTarget).toBe(true)
    s0.run()
    expect(tab.wc.replaceMisspelling).toHaveBeenCalledWith('the')
    items.find((i) => i.id === 'spell.add').run()
    expect(tab.wc.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('teh')
    const paste = items.find((i) => i.id === 'edit.paste')
    expect(paste.role).toBe('paste')
    expect(paste.run).toBeUndefined()
    expect(items.find((i) => i.id === 'edit.redo').enabled).toBe(false)
  })
  it('editable with a misspelling and no suggestions: a disabled placeholder', () => {
    const items = buildPageMenu(w, fakeTab('https://a.test/'), params({ isEditable: true, misspelledWord: 'qzx' })) as any[]
    expect(items[0]).toMatchObject({ id: 'spell.none', label: 'No spelling suggestions', enabled: false })
    expect(items[1].id).toBe('spell.add')
  })
  it('every id is unique and fits the model id rule', () => {
    const items = buildPageMenu(w, fakeTab('https://a.test/'), params({ isEditable: true, linkURL: 'https://b.test/', misspelledWord: 'x', dictionarySuggestions: ['y'] }))
    const all = ids(items)
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,80}$/)
  })
})

describe('UI (shell/overlay field) edit menu', () => {
  it('editable fields get the edit items plus Inspect browser UI when unpackaged', () => {
    expect(kinds(buildUiMenu({ inspectElement: vi.fn() } as any, params({ isEditable: true })))).toBe(
      'edit.undo edit.redo - edit.cut edit.copy edit.paste edit.selectAll - ctx.inspectUi'
    )
  })
  it('a selection gets Copy', () => {
    expect(ids(buildUiMenu({} as any, params({ selectionText: 'x' })))).toEqual(['edit.copy', 'ctx.inspectUi'])
  })
})

describe('showContextMenu wiring', () => {
  it('tab: page kind, anchor offset by the tab view, isValid tracks URL and history index, target is the tab wc', async () => {
    const tab = fakeTab('https://a.test/')
    tabsInWindow.set(7, tab)
    const wc = tab.wc as any
    await showContextMenu(wc, params({ menuSourceType: 'keyboard' }), { resolve: () => ({ w, role: 'tab', tab }) })
    expect(showMenu).toHaveBeenCalledTimes(1)
    const o = showMenu.mock.calls[0]![1] as any
    expect(o.kind).toBe('page')
    expect(o.anchor).toEqual({ x: 10, y: 104, width: 0, height: 0 })
    expect(o.placement).toBe('point')
    expect(o.keyboard).toBe(true)
    expect(o.target).toBe(wc)
    expect(o.isValid()).toBe(true)
    tab._nav('https://a.test/next')
    expect(o.isValid()).toBe(false)
  })
  it('isValid is false once the tab left the window', async () => {
    const tab = fakeTab('https://a.test/')
    tabsInWindow.set(7, tab)
    await showContextMenu(tab.wc, params(), { resolve: () => ({ w, role: 'tab', tab }) })
    const o = showMenu.mock.calls[0]![1] as any
    tabsInWindow.delete(7)
    expect(o.isValid()).toBe(false)
  })
  it('shell/overlay: edit kind at the raw point, target = that wc (menu-host picks native for the overlay)', async () => {
    const wc: any = { inspectElement: vi.fn() }
    await showContextMenu(wc, params({ isEditable: true }), { resolve: () => ({ w, role: 'overlay', tab: null }) })
    const o = showMenu.mock.calls[0]![1] as any
    expect(o.kind).toBe('edit')
    expect(o.anchor).toEqual({ x: 10, y: 20, width: 0, height: 0 })
    expect(o.target).toBe(wc)
    expect(o.isValid).toBeUndefined()
  })
  it('unknown webContents or destroyed window: nothing shown', async () => {
    await showContextMenu({} as any, params(), { resolve: () => null })
    await showContextMenu({} as any, params(), { resolve: () => ({ w: { ...w, win: { isDestroyed: () => true } }, role: 'shell', tab: null }) })
    expect(showMenu).not.toHaveBeenCalled()
  })
})

describe('profile menu (AC61)', () => {
  it('radio for the current profile, stable ids, runs through the command runner', () => {
    const run = vi.fn()
    const items = buildProfilesMenu(w, run) as any[]
    expect(kinds(items)).toBe('profiles.menu:default profiles.menu:work - profiles.menu:new profiles.menu:incognito - profiles.menu:manage')
    expect(items[0]).toMatchObject({ check: 'radio', checked: true })
    expect(items[1]).toMatchObject({ check: 'radio', checked: false })
    items[1].run()
    expect(run).toHaveBeenCalledWith('profile.switch', 'work')
  })
  it('incognito windows check no profile', () => {
    const items = buildProfilesMenu({ ...w, incognito: true }, vi.fn()) as any[]
    expect(items.filter((i) => i.checked)).toEqual([])
  })
})
