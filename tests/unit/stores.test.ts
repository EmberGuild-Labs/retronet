import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCounterStore } from '../../src/main/storage/counter-store'
import { createPermissionStore } from '../../src/main/storage/permission-store'
import { createSessionStore } from '../../src/main/storage/session-store'
import { createSettingsStore } from '../../src/main/storage/settings-store'
import { createZoomStore } from '../../src/main/storage/zoom-store'
import { createProfileStores, flushAll } from '../../src/main/storage'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'rn-stores-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('settings store', () => {
  it('defaults, patches, validates and persists', async () => {
    const file = join(dir, 'settings.json')
    const s = createSettingsStore(file, { debounceMs: 0 })
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    expect(s.patch({ skin: 'y1997', bookmarkBar: false })).toMatchObject({ skin: 'y1997', bookmarkBar: false, startup: 'restore' })
    expect(() => s.patch({ homePage: 'javascript:alert(1)' })).toThrow()
    expect(() => s.patch({ bogus: 1 } as never)).toThrow()
    await s.store.flush()
    expect(createSettingsStore(file).get().skin).toBe('y1997')
  })
  it('fills missing keys on an older file', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ skin: 'y2001', future: true }))
    expect(createSettingsStore(file).get()).toEqual({ ...DEFAULT_SETTINGS, skin: 'y2001' })
  })
})

describe('session store', () => {
  const win = { tabs: [{ url: 'https://a/', title: 'A', pinned: false, groupId: null }], groups: [], activeIndex: 0, bounds: null }
  it('saves and restores windows', async () => {
    const file = join(dir, 'session.json')
    const s = createSessionStore(file, { debounceMs: 0 })
    expect(s.load()).toEqual([])
    s.save([win], 5)
    await s.store.flush()
    expect(createSessionStore(file).load()).toEqual([win])
    s.clear()
    expect(s.load()).toEqual([])
  })
})

describe('counter store', () => {
  it('seeds a 6-digit number once and increments', async () => {
    const file = join(dir, 'counter.json')
    const c = createCounterStore(file, { debounceMs: 0 })
    const v = c.value()
    expect(v).toBeGreaterThanOrEqual(100_000)
    expect(v).toBeLessThan(1_000_000)
    expect(c.hit()).toBe(v + 1)
    await c.store.flush()
    expect(createCounterStore(file, { seed: () => 1 }).value()).toBe(v + 1)
  })
})

describe('zoom store', () => {
  it('maps origin to level; 0 removes', () => {
    const z = createZoomStore(null)
    expect(z.get('https://a.test')).toBe(0)
    z.set('https://a.test', 1.5)
    expect(z.get('https://a.test')).toBe(1.5)
    z.set('https://a.test', 0)
    expect(z.all()).toEqual({})
  })
})

describe('permission store', () => {
  it('remembers, overwrites, lists and resets', () => {
    const p = createPermissionStore(null, { now: () => 7 })
    expect(p.get('https://a.test', 'camera')).toBeNull()
    p.set('https://a.test', 'camera', 'allow')
    p.set('https://a.test', 'camera', 'block')
    p.set('https://a.test', 'geolocation', 'block')
    p.set('https://b.test', 'camera', 'allow')
    expect(p.get('https://a.test', 'camera')).toBe('block')
    expect(p.list()).toHaveLength(3)
    expect(p.reset('https://a.test', 'camera')).toBe(1)
    expect(p.reset('https://a.test')).toBe(1)
    expect(p.list().map((x) => x.origin)).toEqual(['https://b.test'])
  })
})

describe('createProfileStores', () => {
  it('persists per profile directory and reloads', async () => {
    const a = createProfileStores(join(dir, 'a'))
    a.history.recordVisit('https://a.test/', 'A')
    a.bookmarks.add({ parentId: 'bar', title: 'x', url: 'https://x/' })
    a.permissions.set('https://a.test', 'camera', 'allow')
    await flushAll()
    // only stores that changed are written
    expect(readdirSync(join(dir, 'a')).sort()).toEqual(['bookmarks.json', 'history.json', 'permissions.json'])
    const b = createProfileStores(join(dir, 'b'))
    expect(b.history.count()).toBe(0)
    const a2 = createProfileStores(join(dir, 'a'))
    expect(a2.history.count()).toBe(1)
    expect(a2.bookmarks.isBookmarked('https://x/')).toBe(true)
    expect(a2.permissions.get('https://a.test', 'camera')).toBe('allow')
    await Promise.all([a.close(), b.close(), a2.close()])
  })

  it('memory mode (null dir) never touches the disk', async () => {
    const before = readdirSync(dir)
    const s = createProfileStores(null)
    s.history.recordVisit('https://a.test/', 'A')
    s.bookmarks.add({ parentId: 'bar', title: 'x', url: 'https://x/' })
    s.downloads.upsert({ id: 'd', url: 'u', filename: 'f', path: '/p', state: 'completed', receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, startedAt: 1, endedAt: 1, error: null })
    s.settings.patch({ skin: 'y2001' })
    s.session.save([])
    s.counter.hit()
    s.zoom.set('https://a.test', 1)
    s.permissions.set('https://a.test', 'camera', 'allow')
    await s.close()
    await flushAll()
    expect(readdirSync(dir)).toEqual(before)
    for (const st of [s.history, s.bookmarks, s.downloads, s.settings, s.session, s.counter, s.zoom, s.permissions]) expect(st.store.memory).toBe(true)
    expect(existsSync(join(dir, 'history.json'))).toBe(false)
  })

  it('resets a corrupt file and keeps the original aside', () => {
    const d = join(dir, 'c')
    createProfileStores(d).history.store.close()
    writeFileSync(join(d, 'history.json'), '{not json')
    const s = createProfileStores(d)
    expect(s.history.count()).toBe(0)
    expect(readdirSync(d).some((f) => f.startsWith('history.json.corrupt-'))).toBe(true)
    expect(readFileSync(join(d, readdirSync(d).find((f) => f.includes('corrupt'))!), 'utf8')).toBe('{not json')
  })
})
