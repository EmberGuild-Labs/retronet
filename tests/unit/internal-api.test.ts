import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
    sendPageEvent: vi.fn(),
    windows: new Map<number, any>(),
    refreshProfile: vi.fn(),
    pm: {} as any,
    service: null as any,
    showOpenDialog: vi.fn(),
    cert: { proceed: vi.fn(), leave: vi.fn(), retry: vi.fn() }
  }
})

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', isPackaged: false }, dialog: { showOpenDialog: h.showOpenDialog } }))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: h.IpcFailure,
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn) },
  sendPageEvent: h.sendPageEvent
}))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: {
    get: (id: number) => h.windows.get(id) ?? null,
    forProfile: (pid: string) => [...h.windows.values()].filter((w) => w.profile.id === pid),
    refreshProfile: h.refreshProfile,
    all: () => [...h.windows.values()],
    onWindowCreated: () => () => {}
  }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({ browserTabs: (w: any) => w.tabMgr }))
vi.mock('../../src/main/profiles/profile-manager', () => ({ profileManager: () => h.pm }))
vi.mock('../../src/main/downloads/download-manager', () => ({ downloadService: () => h.service }))
vi.mock('../../src/main/security/cert-errors', () => ({
  proceedCertError: h.cert.proceed,
  leaveCertError: h.cert.leave,
  retryNetError: h.cert.retry,
  clearCertOverrides: vi.fn()
}))

import { clearCertOverrides } from '../../src/main/security/cert-errors'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'
import { createCounterStore } from '../../src/main/storage/counter-store'
import { createDownloadsStore } from '../../src/main/storage/downloads-store'
import { createHistoryStore } from '../../src/main/storage/history-store'
import { createPermissionStore } from '../../src/main/storage/permission-store'
import { createSettingsStore } from '../../src/main/storage/settings-store'
import { registerInternalApiHandlers } from '../../src/main/internal-api'
import { IPC_METHODS } from '../../src/shared/ipc-contract'

function mkProfile(id: string, incognito: boolean, stores: any, partition = incognito ? `incognito-${id}` : `persist:p-${id}`) {
  return {
    id,
    incognito,
    partition,
    stores,
    session: { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) },
    getSettings: () => stores.settings.get()
  } as any
}
function mkStores() {
  return {
    history: createHistoryStore(null),
    bookmarks: createBookmarksStore(null),
    downloads: createDownloadsStore(null),
    settings: createSettingsStore(null),
    counter: createCounterStore(null, { seed: () => 1000 }),
    permissions: createPermissionStore(null)
  }
}
function mkWindow(id: number, profile: any) {
  const wc = { id: id * 10 }
  return { id, profile, incognito: profile.incognito, win: { id: `win${id}`, isDestroyed: () => false }, sendShell: vi.fn(), tabMgr: { list: () => [{ wc }], refresh: vi.fn() }, wc } as any
}

let stores: ReturnType<typeof mkStores>
let profile: any
let w1: any
const ctxFor = (windowId = 1, sender: any = { id: 99 }) => ({ info: { role: 'tab', windowId }, sender, caller: 'newtab' }) as any
const call = (m: string, req: any = {}, ctx = ctxFor()) => Promise.resolve().then(() => h.handlers.get(m)!(req, ctx))
const code = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e.code)) as string | null

beforeAll(() => registerInternalApiHandlers())
beforeEach(() => {
  vi.clearAllMocks()
  h.windows.clear()
  stores = mkStores()
  profile = mkProfile('a', false, stores)
  w1 = mkWindow(1, profile)
  h.windows.set(1, w1)
  h.pm = {
    list: () => [{ id: 'a', name: 'A', createdAt: 1 }],
    get: (id: string) => (id === 'a' ? profile : null),
    create: vi.fn((name: string) => ({ id: 'b', name, createdAt: 2 })),
    rename: vi.fn(),
    delete: vi.fn(async () => true)
  }
  h.service = null
})

describe('registration', () => {
  it('registers every internal page method this task owns, and only methods with a page caller', () => {
    const wired = [...h.handlers.keys()]
    for (const m of wired) expect(Object.hasOwn(IPC_METHODS, m)).toBe(true)
    const pageOnly = Object.keys(IPC_METHODS).filter((m) => {
      const c = (IPC_METHODS as any)[m].callers as string[]
      return c.every((x) => !['shell', 'overlay'].includes(x)) && m !== 'commands.list'
    })
    expect(pageOnly.filter((m) => !h.handlers.has(m))).toEqual([])
    // Extra round (X2): wired through registerInternalApiHandlers; X8/X9/X10 replace the stub bodies.
    for (const m of ['defaultBrowser.status', 'defaultBrowser.set', 'bookmarks.import', 'bookmarks.export', 'updates.status', 'updates.check', 'updates.openDownload']) {
      expect(h.handlers.has(m), m).toBe(true)
    }
  })
})

describe('misc', () => {
  it('counter.hit increments, and is null in incognito without touching the stored counter', async () => {
    expect(await call('counter.hit')).toEqual({ value: 1001 })
    expect(await call('counter.hit')).toEqual({ value: 1002 })
    const inc = mkProfile('a', true, mkStores())
    h.windows.set(2, mkWindow(2, inc))
    expect(await call('counter.hit', {}, ctxFor(2))).toEqual({ value: null })
    expect(stores.counter.value()).toBe(1002)
    expect(inc.stores.counter.value()).toBe(1000)
  })
  it('skin.get reflects the caller window (incognito flag) and app.info has versions', async () => {
    h.windows.set(2, mkWindow(2, mkProfile('a', true, stores)))
    expect(await call('skin.get')).toMatchObject({ skin: 'y1997', incognito: false })
    expect(await call('skin.get', {}, ctxFor(2))).toMatchObject({ incognito: true })
    expect(await call('app.info')).toMatchObject({ name: 'RetroNet', version: '9.9.9', packaged: false })
  })
  it('unknown window -> E_NOT_FOUND', async () => {
    expect(await code(call('counter.hit', {}, ctxFor(77)))).toBe('E_NOT_FOUND')
  })
  it('cert/net actions act on the sender webContents and map false to E_NOT_FOUND', async () => {
    const sender = { id: 5 }
    h.cert.proceed.mockReturnValue(true)
    h.cert.leave.mockReturnValue(false)
    h.cert.retry.mockReturnValue(true)
    expect(await call('certerror.proceed', {}, ctxFor(1, sender))).toBeNull()
    expect(h.cert.proceed).toHaveBeenCalledWith(sender)
    expect(await code(call('certerror.back', {}, ctxFor(1, sender)))).toBe('E_NOT_FOUND')
    expect(await call('neterror.retry', {}, ctxFor(1, sender))).toBeNull()
    expect(h.cert.retry).toHaveBeenCalledWith(sender)
  })
})

describe('history', () => {
  it('queries, deletes and clears the caller profile only', async () => {
    const other = mkStores()
    h.windows.set(2, mkWindow(2, mkProfile('b', false, other)))
    const e = stores.history.recordVisit('https://a.test/', 'A')
    other.history.recordVisit('https://b.test/', 'B')
    const q = (await call('history.query', { text: 'a.test' })) as any
    expect(q.total).toBe(1)
    expect((await call('history.query', {}, ctxFor(2)) as any).entries[0].url).toBe('https://b.test/')
    expect(await code(call('history.delete', { id: 999 }))).toBe('E_NOT_FOUND')
    expect(await call('history.delete', { id: e.id })).toBeNull()
    expect(stores.history.count()).toBe(0)
    await call('history.clear')
    expect(other.history.count()).toBe(1)
  })
})

describe('bookmarks', () => {
  it('CRUD with E_NOT_FOUND on null/false, and windows refresh', async () => {
    const { id } = (await call('bookmarks.add', { parentId: 'bar', title: 'T', url: 'https://x.test/' })) as any
    expect(w1.tabMgr.refresh).toHaveBeenCalled()
    expect(((await call('bookmarks.top', { limit: 5 })) as any).items.map((i: any) => i.url)).toEqual(['https://x.test/'])
    expect(await code(call('bookmarks.add', { parentId: 'nope', title: 'T', url: 'https://x.test/' }))).toBe('E_NOT_FOUND')
    expect(await code(call('bookmarks.addFolder', { parentId: 'nope', title: 'F' }))).toBe('E_NOT_FOUND')
    expect(await call('bookmarks.update', { id, title: 'U' })).toBeNull()
    expect(await code(call('bookmarks.update', { id: 'zzz', title: 'U' }))).toBe('E_NOT_FOUND')
    const f = (await call('bookmarks.addFolder', { parentId: 'bar', title: 'F' })) as any
    expect(await call('bookmarks.move', { id, parentId: f.id })).toBeNull()
    expect(await code(call('bookmarks.move', { id: f.id, parentId: f.id }))).toBe('E_NOT_FOUND')
    expect(((await call('bookmarks.tree')) as any).bar.children).toHaveLength(1)
    expect(await call('bookmarks.remove', { id })).toBeNull()
    expect(await code(call('bookmarks.remove', { id }))).toBe('E_NOT_FOUND')
  })
})

describe('downloads', () => {
  it('E_UNAVAILABLE without a service; false -> E_NOT_FOUND; list uses service.list', async () => {
    expect(await code(call('downloads.list'))).toBe('E_UNAVAILABLE')
    h.service = {
      list: vi.fn(() => [{ id: 'd1' }]),
      pause: vi.fn(() => false),
      resume: vi.fn(() => true),
      cancel: vi.fn(() => true),
      show: vi.fn(() => true),
      remove: vi.fn(() => false),
      open: vi.fn(async () => {
        throw new Error('not an openable download')
      }),
      showFolder: vi.fn(async () => {}),
      clearFinished: vi.fn(() => 2)
    }
    expect(((await call('downloads.list')) as any).items).toEqual([{ id: 'd1' }])
    expect(await code(call('downloads.pause', { id: 'd1' }))).toBe('E_NOT_FOUND')
    expect(await call('downloads.resume', { id: 'd1' })).toBeNull()
    expect(await call('downloads.cancel', { id: 'd1' })).toBeNull()
    expect(await call('downloads.show', { id: 'd1' })).toBeNull()
    expect(await code(call('downloads.remove', { id: 'd1' }))).toBe('E_NOT_FOUND')
    expect(await code(call('downloads.open', { id: 'd1' }))).toBe('E_NOT_FOUND')
    expect(await call('downloads.showFolder')).toBeNull()
    expect(await call('downloads.clear')).toBeNull()
    expect(h.service.clearFinished).toHaveBeenCalled()
  })
})

describe('settings', () => {
  it('get/set returns the full result and broadcasts skin changes only when they change', async () => {
    expect(await call('settings.set', { searchEngine: 'google' })).toMatchObject({ searchEngine: 'google' })
    expect(h.refreshProfile).not.toHaveBeenCalled()
    const r = (await call('settings.set', { skin: 'y2001', reducedMotion: true })) as any
    expect(r).toMatchObject({ skin: 'y2001', reducedMotion: true })
    expect(h.refreshProfile).toHaveBeenCalledWith('a')
    expect(h.sendPageEvent).toHaveBeenCalledWith(w1.wc, 'skin', { skin: 'y2001', reducedMotion: true, incognito: false })
    expect(((await call('settings.get')) as any).skin).toBe('y2001')
  })
  it('incognito windows write the parent profile and the page event keeps each window incognito flag', async () => {
    const inc = mkWindow(2, mkProfile('a', true, mkStores()))
    inc.profile.getSettings = () => stores.settings.get()
    h.windows.set(2, inc)
    await call('settings.set', { skin: 'y1994' }, ctxFor(2))
    expect(stores.settings.get().skin).toBe('y1994')
    expect(h.sendPageEvent).toHaveBeenCalledWith(inc.wc, 'skin', expect.objectContaining({ skin: 'y1994', incognito: true }))
    expect(h.sendPageEvent).toHaveBeenCalledWith(w1.wc, 'skin', expect.objectContaining({ skin: 'y1994', incognito: false }))
  })
  it('refuses a downloadsDir path from IPC but accepts null and the unchanged value', async () => {
    expect(await code(call('settings.set', { downloadsDir: '/tmp/evil' }))).toBe('E_INVALID')
    expect(stores.settings.get().downloadsDir).toBeNull()
    expect(await call('settings.set', { downloadsDir: null })).toMatchObject({ downloadsDir: null })
  })
  it('pickFolder stores the native-picked directory, returns null on cancel', async () => {
    h.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await call('dialog.pickFolder')).toEqual({ path: null })
    h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp'] })
    expect(await call('dialog.pickFolder')).toEqual({ path: '/tmp' })
    expect(stores.settings.get().downloadsDir).toBe('/tmp')
    expect(await call('settings.set', { downloadsDir: '/tmp' })).toMatchObject({ downloadsDir: '/tmp' })
    h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/definitely/not/here'] })
    expect(await call('dialog.pickFolder')).toEqual({ path: null })
  })
  it('permissions list/reset use the caller profile', async () => {
    stores.permissions.set('https://a.test', 'camera', 'allow')
    stores.permissions.set('https://a.test', 'microphone', 'block')
    expect(((await call('permissions.list')) as any).items).toHaveLength(2)
    await call('permissions.reset', { origin: 'https://a.test', kind: 'camera' })
    expect(stores.permissions.list().map((p) => p.kind)).toEqual(['microphone'])
    await call('permissions.reset', { origin: 'https://a.test' })
    expect(stores.permissions.list()).toEqual([])
  })
  it('data.clear: range applies to history and downloads (reset pushed), cookies/cache are all-time', async () => {
    const now = Date.now()
    stores.history.recordVisit('https://old.test/', 'old', now - 3 * 24 * 3600e3)
    stores.history.recordVisit('https://new.test/', 'new', now - 1000)
    const rec = (id: string, at: number) => ({ id, url: 'u', filename: 'f', path: '/x', state: 'completed', receivedBytes: 1, totalBytes: 1, bytesPerSecond: 0, startedAt: at, endedAt: at, error: null }) as any
    stores.downloads.upsert(rec('old', now - 3 * 24 * 3600e3))
    stores.downloads.upsert(rec('new', now - 1000))
    await call('data.clear', { history: true, downloads: true, cookies: false, cache: false, range: 'day' })
    expect(stores.history.query().entries.map((e) => e.url)).toEqual(['https://old.test/'])
    expect(stores.downloads.list().map((d) => d.id)).toEqual(['old'])
    expect(h.sendPageEvent).toHaveBeenCalledWith(w1.wc, 'downloads', { type: 'reset' }, 'downloads')
    expect(profile.session.clearStorageData).not.toHaveBeenCalled()
    expect(clearCertOverrides).not.toHaveBeenCalled()
    await call('data.clear', { history: false, downloads: false, cookies: true, cache: true, range: 'hour' })
    // N8: cert "Proceed anyway" decisions and the HTTP auth cache go with the cookies.
    expect(clearCertOverrides).toHaveBeenCalledTimes(1)
    expect(clearCertOverrides).toHaveBeenCalledWith(profile.session)
    expect(profile.session.clearAuthCache).toHaveBeenCalledTimes(1)
    expect(profile.session.closeAllConnections).toHaveBeenCalledTimes(1) // F2
    expect(profile.session.clearStorageData).toHaveBeenCalledTimes(1)
    expect(profile.session.clearStorageData.mock.calls[0][0].storages).toContain('cookies')
    expect(profile.session.clearCache).toHaveBeenCalledTimes(1)
    expect(stores.history.count()).toBe(1)
  })
})

describe('profiles', () => {
  it('list uses the caller profile as current; manager failures pass through', async () => {
    expect(await call('profiles.list')).toEqual({ profiles: [{ id: 'a', name: 'A', createdAt: 1 }], currentId: 'a' })
    expect(await call('profiles.create', { name: 'B' })).toMatchObject({ id: 'b', name: 'B' })
    h.pm.rename.mockImplementation(() => {
      throw new h.IpcFailure('E_NOT_FOUND', 'No such profile')
    })
    expect(await code(call('profiles.rename', { id: 'zz', name: 'n' }))).toBe('E_NOT_FOUND')
    expect(await call('profiles.delete', { id: 'b' })).toEqual({ deleted: true })
    expect(h.pm.delete).toHaveBeenCalledWith('b', { parent: w1.win })
  })
})
