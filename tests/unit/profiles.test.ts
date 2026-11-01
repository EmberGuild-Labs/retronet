import { describe, expect, it, vi } from 'vitest'

// profile-manager pulls in main modules that import electron at load time; nothing here touches it.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/unused', isPackaged: false, getAppPath: () => '/tmp/unused', on: () => {} },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: {}, fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  net: { fetch: vi.fn() },
  BrowserWindow: class {},
  WebContentsView: class {},
  webContents: { getAllWebContents: () => [] }
}))

import type { Session } from 'electron'
import { createIncognitoRegistry, incognitoPartition, isMemoryPartition, type IncognitoDeps } from '../../src/main/profiles/incognito'
import {
  AppStateSchema,
  cleanProfileName,
  emptyAppState,
  isValidPendingDelete,
  newProfileId,
  normalizeAppState,
  partitionFor,
  pickFallbackProfile,
  profileDataPaths,
  type AppState
} from '../../src/main/profiles/profile-manager'
import { createProfileStores } from '../../src/main/storage'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { ProfileContext } from '../../src/main/types'

const rec = (id: string, name = id, createdAt = 1) => ({ id, name, createdAt })

describe('app state', () => {
  it('a fresh install gets one "default" profile, which is last used', () => {
    const s = normalizeAppState(emptyAppState(), 42)
    expect(s.profiles).toEqual([{ id: 'default', name: 'Default', createdAt: 42 }])
    expect(s.lastProfileId).toBe('default')
  })

  it('drops duplicate ids and repairs a dangling lastProfileId', () => {
    const s = normalizeAppState({ profiles: [rec('a'), rec('b'), rec('a', 'dup')], lastProfileId: 'gone', pendingDeletes: [] })
    expect(s.profiles.map((p) => p.name)).toEqual(['a', 'b'])
    expect(s.lastProfileId).toBe('a')
  })

  it('never keeps a pending delete for a live profile', () => {
    const s = normalizeAppState({
      profiles: [rec('a')],
      lastProfileId: 'a',
      pendingDeletes: ['Profiles/a', 'Partitions/p-a', 'Profiles/old', 'Partitions/p-old', 'Profiles/old']
    })
    expect(s.pendingDeletes).toEqual(['Profiles/old', 'Partitions/p-old'])
  })

  it('schema rejects pending deletes outside the two allowed shapes', () => {
    for (const bad of ['../x', 'Profiles/../..', 'Profiles/a/b', '/etc', 'Partitions/a', 'Profiles/A', 'logs', 'Profiles/']) {
      expect(isValidPendingDelete(bad)).toBe(false)
      expect(AppStateSchema.safeParse({ profiles: [], lastProfileId: null, pendingDeletes: [bad] }).success).toBe(false)
    }
    expect(isValidPendingDelete('Profiles/ab12cd34')).toBe(true)
    expect(isValidPendingDelete('Partitions/p-ab12cd34')).toBe(true)
  })

  it('schema rejects profile ids that could escape a directory or partition name', () => {
    for (const id of ['..', 'a/b', 'A', '', 'a.b', '-a']) {
      expect(AppStateSchema.safeParse({ profiles: [rec(id)], lastProfileId: null, pendingDeletes: [] }).success).toBe(false)
    }
  })
})

describe('profile helpers', () => {
  it('partition and data paths follow PLAN 1.3', () => {
    expect(partitionFor('ab12')).toBe('persist:p-ab12')
    expect(profileDataPaths('ab12')).toEqual(['Profiles/ab12', 'Partitions/p-ab12'])
  })

  it('cleanProfileName trims, collapses whitespace and bounds the length', () => {
    expect(cleanProfileName('  Work   stuff ')).toBe('Work stuff')
    expect(cleanProfileName('   ')).toBeNull()
    expect(cleanProfileName('x'.repeat(64))).toBe('x'.repeat(64))
    expect(cleanProfileName('x'.repeat(65))).toBeNull()
  })

  it('newProfileId skips ids in use, pending deletes, "default" and invalid output', () => {
    const state: AppState = { profiles: [rec('aaaa0001')], lastProfileId: null, pendingDeletes: ['Partitions/p-aaaa0002'] }
    const seq = ['default', 'aaaa0001', 'aaaa0002', 'NOPE', 'aaaa0003']
    expect(newProfileId(state, () => seq.shift() as string)).toBe('aaaa0003')
    expect(newProfileId(state)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('pickFallbackProfile prefers the surviving last-used profile', () => {
    const s: AppState = { profiles: [rec('a'), rec('b'), rec('c')], lastProfileId: 'c', pendingDeletes: [] }
    expect(pickFallbackProfile(s, 'a')).toBe('c')
    expect(pickFallbackProfile({ ...s, lastProfileId: 'a' }, 'a')).toBe('b')
    expect(pickFallbackProfile({ ...s, profiles: [rec('a')] }, 'a')).toBeNull()
  })
})

describe('incognito registry', () => {
  function fakeSession() {
    return {
      clearStorageData: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
      clearHostResolverCache: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {})
    }
  }
  function setup() {
    const sessions = new Map<string, ReturnType<typeof fakeSession>>()
    const open: ProfileContext[] = []
    const hooks: string[] = []
    const closes: string[] = []
    const cancelled: string[] = []
    const deps: IncognitoDeps = {
      fromPartition: (p) => {
        const s = fakeSession()
        sessions.set(p, s)
        return s as unknown as Session
      },
      createStores: () => {
        const stores = createProfileStores(null)
        const close = stores.close
        return { ...stores, close: async () => (closes.push('closed'), close()) }
      },
      installHooks: (_ses, ctx) => void hooks.push(ctx.partition),
      cancelDownloads: (ctx) => void cancelled.push(ctx.partition),
      openProfiles: () => open
    }
    const parent = {
      id: 'work',
      name: 'Work',
      incognito: false,
      stores: createProfileStores(null),
      getSettings: () => ({ ...DEFAULT_SETTINGS, skin: 'y2001' }),
      info: () => ({ id: 'work', name: 'Work', createdAt: 5 })
    } as unknown as ProfileContext
    return { reg: createIncognitoRegistry(deps), sessions, open, hooks, closes, parent, cancelled }
  }

  it('partitions are in-memory and numbered', () => {
    expect(incognitoPartition(3)).toBe('incognito-3')
    expect(isMemoryPartition(incognitoPartition(3))).toBe(true)
    expect(isMemoryPartition('persist:p-a')).toBe(false)
  })

  it('one group per parent: windows share it, hooks installed once, memory stores, parent appearance', () => {
    const { reg, hooks, parent } = setup()
    const a = reg.contextFor(parent)
    const b = reg.contextFor(parent)
    expect(a).toBe(b)
    expect(a.incognito).toBe(true)
    expect(a.partition).toBe('incognito-1')
    expect(a.dataDir).toBeNull()
    expect(a.stores.history.store.memory).toBe(true)
    expect(a.getSettings().skin).toBe('y2001')
    expect(a.id).toBe('work')
    expect(a.name).toBe('Work')
    expect(hooks).toEqual(['incognito-1'])
    expect(() => reg.contextFor(a)).toThrow()
  })

  it('stays alive while a window uses it; last close wipes the session, closes stores, next group is fresh', async () => {
    const { reg, sessions, open, closes, parent } = setup()
    const ctx = reg.contextFor(parent)
    ctx.stores.history.recordVisit('https://example.com/', 'x')
    open.push(ctx, ctx)
    open.pop()
    await reg.windowClosed(ctx)
    expect(reg.existing('work')).toBe(ctx)
    expect(sessions.get('incognito-1')?.clearStorageData).not.toHaveBeenCalled()

    open.pop()
    await reg.windowClosed(ctx)
    const s = sessions.get('incognito-1')
    expect(s?.clearStorageData).toHaveBeenCalledTimes(1)
    expect(s?.clearCache).toHaveBeenCalledTimes(1)
    expect(closes).toEqual(['closed'])
    expect(reg.existing('work')).toBeNull()

    const next = reg.contextFor(parent)
    expect(next).not.toBe(ctx)
    expect(next.partition).toBe('incognito-2')
    expect(next.stores.history.count()).toBe(0)
  })

  it('ignores regular windows and stale contexts; destroy wipes immediately', async () => {
    const { reg, sessions, parent } = setup()
    await reg.windowClosed(parent)
    const ctx = reg.contextFor(parent)
    await reg.destroy('work')
    expect(sessions.get('incognito-1')?.clearStorageData).toHaveBeenCalledTimes(1)
    const fresh = reg.contextFor(parent)
    await reg.windowClosed(ctx) // stale: must not kill the fresh group
    expect(reg.existing('work')).toBe(fresh)
  })

  it('a failing wipe step does not stop the others', async () => {
    const { parent } = setup()
    const errors: string[] = []
    const s = fakeSession()
    s.clearStorageData.mockRejectedValueOnce(new Error('boom'))
    const reg = createIncognitoRegistry({
      fromPartition: () => s as unknown as Session,
      createStores: () => createProfileStores(null),
      installHooks: () => {},
      openProfiles: () => [],
      onError: (what) => void errors.push(what)
    })
    await reg.windowClosed(reg.contextFor(parent))
    expect(errors).toEqual(['incognito clearStorageData'])
    expect(s.clearCache).toHaveBeenCalled()
    expect(reg.existing('work')).toBeNull()
  })

  it('D7: shares the parent bookmarks store (edits persist to the parent), everything else stays its own', async () => {
    const { reg, parent } = setup()
    const ctx = reg.contextFor(parent)
    expect(ctx.stores.bookmarks).toBe(parent.stores.bookmarks)
    expect(ctx.stores.history).not.toBe(parent.stores.history)
    expect(ctx.stores.downloads).not.toBe(parent.stores.downloads)
    expect(ctx.stores.permissions).not.toBe(parent.stores.permissions)
    expect(ctx.stores.counter).not.toBe(parent.stores.counter)
    ctx.stores.bookmarks.add({ parentId: 'bar', title: 'Inc', url: 'https://inc.test/' })
    expect(parent.stores.bookmarks.isBookmarked('https://inc.test/')).toBe(true)
    ctx.stores.history.recordVisit('https://inc.test/', 'x')
    expect(parent.stores.history.count()).toBe(0)
    // Disposing the group must not close the parent's bookmarks store.
    await reg.destroy('work')
    parent.stores.bookmarks.add({ parentId: 'bar', title: 'After', url: 'https://after.test/' })
    expect(parent.stores.bookmarks.isBookmarked('https://after.test/')).toBe(true)
    const listener = vi.fn()
    parent.stores.bookmarks.store.onChange(listener)
    parent.stores.bookmarks.removeByUrl('https://after.test/')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('R11: in-flight downloads are cancelled before the session is wiped', async () => {
    const { reg, parent, cancelled, sessions } = setup()
    const ctx = reg.contextFor(parent)
    await reg.windowClosed(ctx)
    expect(cancelled).toEqual(['incognito-1'])
    expect(sessions.get('incognito-1')?.clearStorageData).toHaveBeenCalledTimes(1)
  })
})
