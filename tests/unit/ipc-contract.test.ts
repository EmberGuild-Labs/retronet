import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  IPC_METHODS,
  IPC_METHOD_NAMES,
  PAGE_EVENTS,
  SHELL_EVENTS,
  TabStateSchema,
  WindowSnapshotSchema,
  OverlayEventSchema,
  BookmarkNodeSchema,
  BookmarksImportResultSchema,
  BookmarksExportResultSchema,
  DefaultBrowserStatusSchema,
  SoundEventSchema,
  UpdateCheckResultSchema,
  callerForUrl,
  eventChannel,
  invokeChannel,
  isCallerAllowed,
  isIpcMethodName,
  methodsFor,
  validateRequest,
  type IpcMethodName,
  type PageBridge,
  type ShellBridge
} from '@shared/ipc-contract'
import { PAGE_HOSTS, UI_HOSTS, type Caller, type TabState } from '@shared/types'

const tab: TabState = {
  id: 1,
  url: 'https://example.org/',
  title: 'Example',
  faviconDataUrl: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  pinned: false,
  groupId: null,
  security: 'secure',
  zoomPercent: 100,
  bookmarked: false
}

/** A valid sample request per method, so every method's schema is exercised. */
const VALID: { [M in IpcMethodName]: unknown } = {
  'tabs.create': { url: 'https://example.org/', background: true },
  'tabs.close': { tabId: 1 },
  'tabs.activate': { tabId: 2 },
  'tabs.move': { tabId: 1, index: 0 },
  'tabs.pin': { tabId: 1, pinned: true },
  'tabs.toggleMute': { tabId: 1 },
  'tabs.navigate': { input: 'example.org', disposition: 'new-tab' },
  'tabs.back': {},
  'tabs.forward': { tabId: 3 },
  'tabs.reload': { ignoreCache: true },
  'tabs.stop': {},
  'tabs.home': {},
  'tabs.contextMenu': { tabId: 1, x: 10, y: 20, anchor: { x: 8, y: 4, width: 120, height: 24 }, keyboard: true },
  'groups.create': { tabId: 1, name: 'Research', color: 'blue' },
  'groups.update': { groupId: 'g1', collapsed: true },
  'groups.addTab': { groupId: 'g1', tabId: 2 },
  'groups.removeTab': { tabId: 2 },
  'groups.ungroup': { groupId: 'g1' },
  'groups.close': { groupId: 'g1' },
  'groups.contextMenu': { groupId: 'g1', x: 0, y: 0 },
  'groups.edit': { groupId: 'g1', anchor: { x: 1, y: 2, width: 30, height: 20 } },
  'omnibox.suggest': { text: 'exa', anchor: { x: 0, y: 40, width: 600, height: 24 } },
  'omnibox.highlight': { index: -1 },
  'omnibox.dismiss': {},
  'omnibox.pick': { index: 0 },
  'find.query': { text: 'hello' },
  'find.next': { forward: false },
  'find.close': {},
  'commands.run': { id: 'skin.switch', arg: 'y1994' },
  'profiles.menu': { x: 5, y: 5 },
  'bookmarks.toggleCurrent': {},
  'bookmarks.bar': {},
  'bookmarks.barFolderMenu': { folderId: 'f1', x: 1, y: 1 },
  'layout.setInsets': { top: 96, bottom: 24 },
  'shell.ready': {},
  'overlay.close': {},
  'overlay.dialogResult': { dialogId: 'd1', value: 'Work' },
  'permissions.respond': { requestId: 'p1', decision: 'block', remember: true },
  'httpAuth.respond': { id: 'a1', username: 'u', password: 'p' },
  'menu.pick': { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'bm:f1.3', mods: { meta: false, ctrl: true, shift: false, alt: false }, button: 0 },
  'menu.dismiss': { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01' },
  'eggs.open': { era: 'y1994' },
  'skin.get': {},
  'app.info': {},
  'counter.hit': {},
  'search.engine': {},
  'bookmarks.top': { limit: 8 },
  'history.query': { text: 'foo', offset: 0, limit: 100 },
  'history.delete': { id: 12 },
  'history.clear': {},
  'bookmarks.tree': {},
  'bookmarks.add': { parentId: 'bar', title: 'Ex', url: 'https://example.org/' },
  'bookmarks.addFolder': { parentId: 'other', title: 'Reading' },
  'bookmarks.update': { id: 'b1', title: 'New' },
  'bookmarks.move': { id: 'b1', parentId: 'bar', index: 2 },
  'bookmarks.remove': { id: 'b1' },
  'bookmarks.import': {},
  'bookmarks.export': {},
  'downloads.list': {},
  'downloads.pause': { id: 'd1' },
  'downloads.resume': { id: 'd1' },
  'downloads.cancel': { id: 'd1' },
  'downloads.open': { id: 'd1' },
  'downloads.show': { id: 'd1' },
  'downloads.remove': { id: 'd1' },
  'downloads.clear': {},
  'downloads.showFolder': {},
  'settings.get': {},
  'settings.set': { skin: 'y2001', reducedMotion: true },
  'permissions.list': {},
  'permissions.reset': { origin: 'https://example.org', kind: 'camera' },
  'data.clear': { history: true, downloads: false, cookies: true, cache: true, range: 'day' },
  'profiles.list': {},
  'profiles.create': { name: 'Work' },
  'profiles.rename': { id: 'default', name: 'Home' },
  'profiles.delete': { id: 'p-2' },
  'dialog.pickFolder': {},
  'defaultBrowser.status': {},
  'defaultBrowser.set': {},
  'updates.status': {},
  'updates.check': {},
  'updates.openDownload': {},
  'eggs.openFromPage': { era: 'y2001' },
  'commands.list': {},
  'certerror.proceed': {},
  'certerror.back': {},
  'neterror.retry': {}
}

describe('IPC method table', () => {
  it('every method has a valid sample and accepts it', () => {
    expect(Object.keys(VALID).sort()).toEqual([...IPC_METHOD_NAMES].sort())
    for (const m of IPC_METHOD_NAMES) {
      const r = validateRequest(m, VALID[m])
      expect(r.ok, `${m}: ${r.ok ? '' : r.message}`).toBe(true)
    }
  })

  it('every request schema rejects an extra key (strict)', () => {
    for (const m of IPC_METHOD_NAMES) {
      const payload = { ...(VALID[m] as object), __proto_attack: 1 }
      expect(validateRequest(m, payload).ok, m).toBe(false)
    }
  })

  it('every request schema rejects non-object payloads', () => {
    for (const m of IPC_METHOD_NAMES) {
      for (const bad of [null, 42, 'x', [], true]) expect(validateRequest(m, bad).ok, `${m} ${String(bad)}`).toBe(false)
    }
  })

  it('treats a missing payload as {}', () => {
    expect(validateRequest('shell.ready', undefined).ok).toBe(true)
    expect(validateRequest('tabs.close', undefined).ok).toBe(false)
  })

  it.each([
    ['tabs.close', { tabId: '1' }],
    ['tabs.close', { tabId: 0 }],
    ['tabs.close', { tabId: 1.5 }],
    ['tabs.move', { tabId: 1, index: -1 }],
    ['tabs.pin', { tabId: 1, pinned: 'yes' }],
    ['tabs.navigate', { input: 42 }],
    ['tabs.navigate', { input: 'x', disposition: 'popup' }],
    ['groups.create', { tabId: 1, color: 'magenta' }],
    ['groups.update', { groupId: '../x' }],
    ['groups.update', { groupId: 'g1', name: 'x'.repeat(65) }],
    ['commands.run', { id: 'not.a.command' }],
    ['layout.setInsets', { top: -1, bottom: 0 }],
    ['layout.setInsets', { top: 10 }],
    ['layout.setInsets', { top: Number.POSITIVE_INFINITY, bottom: 0 }],
    ['groups.edit', { groupId: 'g1', anchor: { x: 0, y: 0, width: 1, height: 1, extra: 1 } }],
    ['permissions.respond', { requestId: 'p1', decision: 'always', remember: false }],
    ['httpAuth.respond', { id: 'a1', username: 'u', extra: 1 }],
    ['httpAuth.respond', { id: 'bad id!', cancel: true }],
    ['history.query', { limit: 10_000 }],
    ['history.delete', { id: 'abc' }],
    ['bookmarks.add', { parentId: 'bar', title: 'x', url: 'javascript:alert(1)' }],
    ['bookmarks.add', { parentId: 'bar', title: 'x', url: 'data:text/html,hi' }],
    ['bookmarks.add', { parentId: 'bar', title: 'x', url: 'example.org' }],
    ['settings.set', { skin: 'y2099' }],
    ['settings.set', { dialupSound: 'on' }],
    ['bookmarks.import', { path: '/etc/passwd' }],
    ['bookmarks.export', { path: '/tmp/out.html' }],
    ['updates.openDownload', { url: 'https://evil.test/x.dmg' }],
    ['defaultBrowser.set', { scheme: 'http' }],
    ['settings.set', { homePage: 'javascript:alert(1)' }],
    ['settings.set', { reducedMotion: 'true' }],
    ['settings.set', { telemetry: true }],
    ['data.clear', { history: true, downloads: true, cookies: true, cache: true, range: 'year' }],
    ['data.clear', { history: true, range: 'all' }],
    ['profiles.create', { name: '   ' }],
    ['profiles.delete', { id: '../../etc' }],
    ['profiles.delete', { id: 'Default' }],
    ['overlay.dialogResult', { dialogId: 'd1', value: { nested: true } }],
    ['tabs.contextMenu', { tabId: 1, x: 0, y: 0, anchor: { x: 0, y: 0, width: 1, height: 1, extra: 1 } }],
    ['tabs.contextMenu', { tabId: 1, x: 0, y: 0, keyboard: 'yes' }],
    ['profiles.menu', { x: 0, y: 0, anchor: { x: 0, y: 0, width: -1, height: 1 } }],
    ['menu.pick', { menuId: 'not-a-uuid', itemId: 'a', mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'bad id!', mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'x'.repeat(81), mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'a', mods: { meta: false, ctrl: false, shift: false }, button: 0 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'a', mods: { meta: false, ctrl: false, shift: false, alt: false, fn: true }, button: 0 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'a', mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 2 }],
    ['menu.pick', { menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01', itemId: 'a', mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0, action: 'file.print' }],
    ['menu.dismiss', {}],
    ['eggs.open', { era: 'y2099' }],
    ['eggs.open', { era: 'y1994', url: 'retronet://settings/' }],
    ['eggs.openFromPage', {}]
  ] as const)('%s rejects %j', (m, payload) => {
    expect(validateRequest(m, payload).ok).toBe(false)
  })

  it('extra-round methods take an empty request: no string field, so no path or URL crosses IPC (AC49, AC52)', () => {
    const EXTRA = ['defaultBrowser.status', 'defaultBrowser.set', 'bookmarks.import', 'bookmarks.export', 'updates.status', 'updates.check', 'updates.openDownload'] as const
    for (const m of EXTRA) {
      const req = IPC_METHODS[m].request as unknown as z.ZodObject
      expect(req, m).toBeInstanceOf(z.ZodObject)
      expect(Object.keys(req.shape), m).toEqual([])
      expect(validateRequest(m, {}).ok, m).toBe(true)
    }
  })

  it('no request schema has a file-path field (paths come from native dialogs in main, AC49)', () => {
    for (const m of IPC_METHOD_NAMES) {
      const req = IPC_METHODS[m].request as unknown as z.ZodObject
      // settings.set downloadsDir: the handler refuses any value other than null or the unchanged one (internal-api test).
      const keys = Object.keys(req.shape ?? {}).filter((k) => !(m === 'settings.set' && k === 'downloadsDir'))
      for (const k of keys) expect(k, `${m}.${k}`).not.toMatch(/path|file|dir/i)
    }
  })

  it('returns a readable message on rejection', () => {
    const r = validateRequest('tabs.close', { tabId: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('E_INVALID')
      expect(r.message).toMatch(/tabId/)
    }
  })

  it('isIpcMethodName ignores prototype keys', () => {
    expect(isIpcMethodName('tabs.create')).toBe(true)
    expect(isIpcMethodName('toString')).toBe(false)
    expect(isIpcMethodName('__proto__')).toBe(false)
  })
})

describe('capability map (PLAN 1.5)', () => {
  const expected: Record<string, string[]> = {
    newtab: ['app.info', 'bookmarks.top', 'counter.hit', 'search.engine', 'skin.get'],
    history: ['history.clear', 'history.delete', 'history.query', 'skin.get'],
    shortcuts: ['commands.list', 'skin.get'],
    about: ['app.info', 'eggs.openFromPage', 'skin.get', 'updates.check', 'updates.openDownload', 'updates.status'],
    certerror: ['certerror.back', 'certerror.proceed', 'skin.get'],
    neterror: ['neterror.retry', 'skin.get']
  }

  it.each(Object.entries(expected))('%s gets exactly its methods', (host, methods) => {
    expect(methodsFor(host as Caller).sort()).toEqual(methods)
  })

  it('bookmarks, downloads and settings pages stay inside their namespaces', () => {
    const allow: Record<string, RegExp> = {
      bookmarks: /^(bookmarks\.(tree|add|addFolder|update|move|remove|top|import|export)|skin\.get)$/,
      downloads: /^(downloads\.\w+|skin\.get)$/,
      settings: /^(settings\.(get|set)|permissions\.(list|reset)|data\.clear|profiles\.(list|create|rename|delete)|dialog\.pickFolder|defaultBrowser\.(status|set)|skin\.get)$/
    }
    for (const [host, re] of Object.entries(allow)) {
      const ms = methodsFor(host as Caller)
      expect(ms.length).toBeGreaterThan(1)
      for (const m of ms) expect(m, host).toMatch(re)
    }
  })

  it('no internal page can call shell methods, and the shell cannot call page data methods', () => {
    for (const host of PAGE_HOSTS) {
      for (const m of methodsFor(host)) expect(IPC_METHODS[m].callers, m).not.toContain('shell')
      expect(isCallerAllowed('tabs.navigate', host)).toBe(false)
      expect(isCallerAllowed('commands.run', host)).toBe(false)
    }
    expect(isCallerAllowed('settings.set', 'shell')).toBe(false)
    expect(isCallerAllowed('history.clear', 'overlay')).toBe(false)
    expect(isCallerAllowed('settings.set', 'newtab')).toBe(false)
  })

  it('menu.* is overlay-only, eggs.open is shell-only, and no page host gets either (PLAN-FINAL 2)', () => {
    expect(IPC_METHODS['menu.pick'].callers).toEqual(['overlay'])
    expect(IPC_METHODS['menu.dismiss'].callers).toEqual(['overlay'])
    expect(IPC_METHODS['eggs.open'].callers).toEqual(['shell'])
    expect(IPC_METHODS['eggs.openFromPage'].callers).toEqual(['about'])
    for (const host of PAGE_HOSTS) {
      for (const m of ['menu.pick', 'menu.dismiss', 'eggs.open'] as const) expect(isCallerAllowed(m, host), `${host} ${m}`).toBe(false)
      expect(isCallerAllowed('eggs.openFromPage', host), host).toBe(host === 'about')
    }
    expect(isCallerAllowed('eggs.openFromPage', 'shell')).toBe(false)
    expect(isCallerAllowed('menu.pick', 'shell')).toBe(false)
  })

  it('every method has at least one caller and only known callers', () => {
    const known = new Set<string>([...UI_HOSTS, ...PAGE_HOSTS])
    for (const m of IPC_METHOD_NAMES) {
      expect(IPC_METHODS[m].callers.length, m).toBeGreaterThan(0)
      for (const c of IPC_METHODS[m].callers) expect(known.has(c), `${m} ${c}`).toBe(true)
    }
  })

  it.each([
    ['retronet://shell/', 'shell'],
    ['retronet://overlay/', 'overlay'],
    ['retronet://settings/#privacy', 'settings'],
    ['retronet://certerror/?url=https%3A%2F%2Fx&code=-201', 'certerror'],
    ['RETRONET://NEWTAB/', 'newtab'],
    ['retronet://evil/', null],
    ['retronet://user@settings/', null],
    ['retronet://settings:8080/', null],
    ['https://settings/', null],
    ['https://example.org/retronet://settings/', null],
    ['file:///etc/passwd', null],
    ['not a url', null],
    ['', null]
  ])('callerForUrl(%s) = %s', (url, caller) => {
    expect(callerForUrl(url)).toBe(caller)
  })

  it('channels are prefixed and distinct', () => {
    const ch = IPC_METHOD_NAMES.map(invokeChannel)
    expect(new Set(ch).size).toBe(ch.length)
    expect(invokeChannel('tabs.create')).toBe('rn:invoke:tabs.create')
    expect(eventChannel('state')).toBe('rn:event:state')
    expect(Object.keys(SHELL_EVENTS).sort()).toEqual(['bookmarks', 'find', 'overlay', 'skin', 'sound', 'state', 'status', 'ui'])
    expect(Object.keys(PAGE_EVENTS).sort()).toEqual(['downloads', 'skin'])
  })
})

describe('record and event schemas', () => {
  it('accepts a full snapshot with DESIGN 0.2 audio fields', () => {
    const snap = {
      windowId: 1,
      profileId: 'default',
      profileName: 'Person 1',
      incognito: false,
      popup: false,
      fullscreen: false,
      tabs: [tab, { ...tab, id: 2, audible: true, muted: false, groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'Research', color: 'red', collapsed: true }],
      activeTabId: 1,
      skin: 'y1997',
      reducedMotion: false,
      bookmarkBar: true,
      canReopenClosed: false
    }
    expect(WindowSnapshotSchema.safeParse(snap).success).toBe(true)
    expect(WindowSnapshotSchema.safeParse({ ...snap, skin: 'classic' }).success).toBe(false)
  })

  it('tab security state is one of the five T3 states', () => {
    for (const s of ['secure', 'insecure', 'cert-warning', 'internal', 'file']) {
      expect(TabStateSchema.safeParse({ ...tab, security: s }).success).toBe(true)
    }
    expect(TabStateSchema.safeParse({ ...tab, security: 'ev' }).success).toBe(false)
  })

  it('overlay events include omnibox suggestions', () => {
    const anchor = { x: 0, y: 40, width: 500, height: 24 }
    const ok = OverlayEventSchema.safeParse({
      kind: 'suggest',
      anchor,
      items: [{ kind: 'history', title: 'Ex', url: 'https://example.org/' }],
      selected: -1
    })
    expect(ok.success).toBe(true)
    expect(OverlayEventSchema.safeParse({ kind: 'toast' }).success).toBe(false)
  })

  it('overlay events include themed menus (validated by MenuSpecSchema)', () => {
    const menu = {
      menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01',
      kind: 'tab',
      label: 'Tab',
      anchor: { x: 10, y: 20, width: 0, height: 0 },
      placement: 'point',
      focusFirst: false,
      platform: 'mac',
      items: [{ kind: 'item', id: 'reload', label: 'Reload', accel: 'CmdOrCtrl+R', enabled: true }, { kind: 'separator' }]
    }
    expect(OverlayEventSchema.safeParse({ kind: 'menu', menu }).success).toBe(true)
    expect(OverlayEventSchema.safeParse({ kind: 'menu', menu: { ...menu, menuId: 'm1' } }).success).toBe(false)
    expect(OverlayEventSchema.safeParse({ kind: 'menu', menu: { ...menu, kind: 'window' } }).success).toBe(false)
  })

  it('bookmark nodes are recursive', () => {
    const tree = {
      id: 'bar',
      kind: 'folder',
      title: 'Bookmarks bar',
      createdAt: 0,
      children: [
        { id: 'f1', kind: 'folder', title: 'Dev', createdAt: 1, children: [] },
        { id: 'b1', kind: 'bookmark', title: 'Ex', url: 'https://example.org/', faviconDataUrl: null, createdAt: 2 }
      ]
    }
    expect(BookmarkNodeSchema.safeParse(tree).success).toBe(true)
    const bad = { ...tree, children: [{ id: 'b2', kind: 'bookmark', title: 'x' }] }
    expect(BookmarkNodeSchema.safeParse(bad).success).toBe(false)
  })

  it('extra-round response and event schemas', () => {
    expect(DefaultBrowserStatusSchema.safeParse({ supported: false, isDefault: false, reason: 'unpackaged' }).success).toBe(true)
    expect(DefaultBrowserStatusSchema.safeParse({ supported: true, isDefault: true }).success).toBe(true)
    expect(DefaultBrowserStatusSchema.safeParse({ supported: false, isDefault: false, reason: 'nope' }).success).toBe(false)

    expect(BookmarksImportResultSchema.safeParse({ status: 'cancelled' }).success).toBe(true)
    const imported = { status: 'imported', folderId: 'f9', folderTitle: 'Imported (2)', added: 3, duplicates: 1, unsupported: 2, truncated: false }
    expect(BookmarksImportResultSchema.safeParse(imported).success).toBe(true)
    expect(BookmarksImportResultSchema.safeParse({ ...imported, added: -1 }).success).toBe(false)
    expect(BookmarksImportResultSchema.safeParse({ ...imported, folderId: '../x' }).success).toBe(false)
    expect(BookmarksExportResultSchema.safeParse({ status: 'exported', count: 10 }).success).toBe(true)
    expect(BookmarksExportResultSchema.safeParse({ status: 'exported' }).success).toBe(false)

    expect(UpdateCheckResultSchema.safeParse({ state: 'up-to-date', current: '1.0.0', latest: '1.0.0' }).success).toBe(true)
    expect(UpdateCheckResultSchema.safeParse({ state: 'available', current: '1.0.0', latest: '1.1.0', notes: '' }).success).toBe(true)
    expect(UpdateCheckResultSchema.safeParse({ state: 'available', current: '1.0.0', latest: '1.1.0' }).success).toBe(false)
    for (const error of ['network', 'timeout', 'invalid-feed', 'too-large', 'busy']) {
      expect(UpdateCheckResultSchema.safeParse({ state: 'error', current: '1.0.0', error }).success, error).toBe(true)
    }
    expect(UpdateCheckResultSchema.safeParse({ state: 'error', current: '1.0.0', error: 'redirect' }).success).toBe(false)
    expect(IPC_METHODS['updates.openDownload'].response.safeParse(null).success).toBe(true)

    expect(SHELL_EVENTS.sound).toBe(SoundEventSchema)
    expect(SoundEventSchema.safeParse({ kind: 'dialup' }).success).toBe(true)
    expect(SoundEventSchema.safeParse({ kind: 'beep' }).success).toBe(false)
    expect(SoundEventSchema.safeParse({ kind: 'dialup', volume: 1 }).success).toBe(false)
  })

  it('every response schema is a zod schema', () => {
    for (const m of IPC_METHOD_NAMES) expect(IPC_METHODS[m].response).toBeInstanceOf(z.ZodType)
  })
})

describe('bridge types', () => {
  it('maps dotted names to nested functions', () => {
    expectTypeOf<ShellBridge['tabs']['create']>().toBeFunction()
    expectTypeOf<ShellBridge['shell']['ready']>().parameters.toEqualTypeOf<[req?: Record<string, never>]>()
    expectTypeOf<PageBridge<'newtab'>['counter']['hit']>().toBeFunction()
    // A page host only sees its own namespaces.
    expectTypeOf<'settings' extends keyof PageBridge<'newtab'> ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'history' extends keyof ShellBridge ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'tabs' extends keyof PageBridge<'settings'> ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<PageBridge<'settings'>['settings']['set']>().toBeFunction()
    expectTypeOf<ShellBridge['permissions']['respond']>().toBeFunction()
    expectTypeOf<ShellBridge['tabs']['close']>().parameters.toEqualTypeOf<[req: { tabId: number }]>()
  })
})
