// FX-A (fix round 1): JsonStore change events (R5), credential stripping before anything is stored (Q6), and
// closeGroup leaving the group to housekeeping until its members have actually closed (R9).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// groups.ts imports main modules that load electron; only closeGroup runs here.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/unused', isPackaged: false, getAppPath: () => '/tmp/unused', on: () => {} },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: {}, fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  net: { fetch: vi.fn() },
  screen: { getAllDisplays: () => [] },
  Menu: { buildFromTemplate: vi.fn() },
  BrowserWindow: class {},
  WebContentsView: class {},
  webContents: { getAllWebContents: () => [] }
}))

import { createJsonStore, flushAllStores } from '../../src/main/storage/json-store'
import { stripUrlCredentials } from '../../src/main/storage/url-credentials'
import { createHistoryStore } from '../../src/main/storage/history-store'
import { createSessionStore } from '../../src/main/storage/session-store'
import { closeGroup, normalizeGroups } from '../../src/main/tabs/groups'
import type { BrowserTabManager } from '../../src/main/tabs/tab-manager'
import type { GroupState } from '../../src/shared/types'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'rn-fxa-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('R5: JsonStore.onChange', () => {
  const schema = z.object({ n: z.number() })
  it('fires after update and set (memory stores too), survives a throwing listener, unsubscribes, stops on close', async () => {
    for (const file of [null, join(dir, 'x.json')]) {
      const s = createJsonStore({ file, schema, defaults: { n: 0 }, debounceMs: 0 })
      const seen: number[] = []
      s.onChange(() => {
        throw new Error('bad listener')
      })
      const off = s.onChange((v) => void seen.push(v.n))
      s.update((d) => void (d.n = 1))
      s.set({ n: 2 })
      expect(seen).toEqual([1, 2])
      off()
      s.set({ n: 3 })
      expect(seen).toEqual([1, 2])
      const late = vi.fn()
      s.onChange(late)
      await s.close()
      s.set({ n: 4 })
      expect(late).not.toHaveBeenCalled()
    }
  })
})

describe('Q6: no credentials are ever stored', () => {
  it('stripUrlCredentials', () => {
    expect(stripUrlCredentials('http://qa:pw@127.0.0.1:8080/auth?x=1#h')).toBe('http://127.0.0.1:8080/auth?x=1#h')
    expect(stripUrlCredentials('https://www.google.com@evil.test/')).toBe('https://evil.test/')
    expect(stripUrlCredentials('https://user@x.test/')).toBe('https://x.test/')
    expect(stripUrlCredentials('https://x.test/a@b')).toBe('https://x.test/a@b')
    expect(stripUrlCredentials('https://x.test/?mail=a@b.c')).toBe('https://x.test/?mail=a@b.c')
    expect(stripUrlCredentials('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(stripUrlCredentials('not a url @')).toBe('not a url @')
    expect(stripUrlCredentials('retronet://newtab/')).toBe('retronet://newtab/')
  })

  it('history: visits, title updates and suggestions have no userinfo; an old file is cleaned on load', async () => {
    const file = join(dir, 'history.json')
    const h = createHistoryStore(file, { debounceMs: 0 })
    h.recordVisit('http://qa:pw@127.0.0.1:1234/auth', '')
    expect(h.updateTitle('http://qa:pw@127.0.0.1:1234/auth', 'Authed')).toBe(true)
    expect(h.query().entries.map((e) => [e.url, e.title])).toEqual([['http://127.0.0.1:1234/auth', 'Authed']])
    expect(h.suggest('127.0').map((s) => s.url)).toEqual(['http://127.0.0.1:1234/auth'])
    await flushAllStores()
    expect(readFileSync(file, 'utf8')).not.toContain('pw@')

    const old = join(dir, 'old-history.json')
    writeFileSync(old, JSON.stringify({ nextId: 2, entries: [{ id: 1, url: 'https://u:secret@x.test/', title: 't', visitedAt: Date.now() }] }))
    const h2 = createHistoryStore(old, { debounceMs: 0 })
    expect(h2.query().entries[0]?.url).toBe('https://x.test/')
    await flushAllStores()
    expect(readFileSync(old, 'utf8')).not.toContain('secret')
  })

  it('session: tab addresses and back/forward entries are saved without userinfo', async () => {
    const file = join(dir, 'session.json')
    const s = createSessionStore(file, { debounceMs: 0 })
    s.save([
      {
        tabs: [
          {
            url: 'https://u:p@x.test/b',
            title: 'B',
            pinned: false,
            groupId: null,
            history: { entries: [{ url: 'https://u:p@x.test/a', title: 'A' }, { url: 'https://u:p@x.test/b', title: 'B' }], index: 1 }
          }
        ],
        groups: [],
        activeIndex: 0,
        bounds: null
      }
    ])
    const tab = s.load()[0]!.tabs[0]!
    expect(tab.url).toBe('https://x.test/b')
    expect(tab.history?.entries.map((e) => e.url)).toEqual(['https://x.test/a', 'https://x.test/b'])
    await flushAllStores()
    expect(readFileSync(file, 'utf8')).not.toContain('u:p@')
  })
})

describe('R9: closeGroup', () => {
  /** Tab manager double whose closes complete later (beforeunload), or get cancelled ("Stay"). */
  function fakeTabs(members: number[], groupId: string) {
    const groups = new Map<string, GroupState>([[groupId, { id: groupId, name: 'G', color: 'blue', collapsed: false }]])
    const tabs = new Map(members.map((id) => [id, { id, groupId: groupId as string | null, pinned: false }]))
    const pending: number[] = []
    const api = {
      list: () => [...tabs.values()],
      active: () => tabs.get(members[0]!) ?? null,
      getGroup: (id: string) => groups.get(id) ?? null,
      groups: () => [...groups.values()],
      removeGroup: vi.fn((id: string) => {
        groups.delete(id)
        for (const t of tabs.values()) if (t.groupId === id) t.groupId = null
      }),
      upsertGroup: (g: GroupState) => void groups.set(g.id, g),
      close: vi.fn((id: number) => (pending.push(id), true))
    }
    const finish = (id: number): void => void tabs.delete(id)
    return { tabs: api as unknown as BrowserTabManager, api, pending, finish, groups, tabMap: tabs }
  }

  it('does not remove the group before its members close; housekeeping drops it once they are gone', () => {
    const f = fakeTabs([1, 2, 3], 'g1')
    expect(closeGroup(f.tabs, 'g1')).toBe(true)
    expect(f.api.close).toHaveBeenCalledTimes(3)
    expect(f.api.close.mock.calls.at(-1)?.[0]).toBe(1) // the active tab last
    expect(f.api.removeGroup).not.toHaveBeenCalled()
    // Tab 2 says "Stay": it keeps its group; the others go.
    f.finish(1)
    f.finish(3)
    normalizeGroups(f.tabs)
    expect(f.groups.has('g1')).toBe(true)
    expect(f.tabMap.get(2)?.groupId).toBe('g1')
    f.finish(2)
    normalizeGroups(f.tabs)
    expect(f.groups.has('g1')).toBe(false)
  })

  it('an empty group is removed at once; an unknown one is refused', () => {
    const f = fakeTabs([], 'g2')
    expect(closeGroup(f.tabs, 'g2')).toBe(true)
    expect(f.groups.has('g2')).toBe(false)
    expect(closeGroup(f.tabs, 'nope')).toBe(false)
  })
})
