import { describe, expect, it, vi } from 'vitest'

// session-restore.ts imports main modules that load electron; only its pure helpers run here.
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

import { planRestore, serializeWindow } from '../../src/main/tabs/session-restore'
import { createSessionStore } from '../../src/main/storage/session-store'
import { BookmarkUrlSchema, SESSION_HISTORY_MAX, SessionStateSchema } from '../../src/shared/ipc-contract'
import { DEFAULT_SETTINGS, HomePageSchema, SettingsPatchSchema, SettingsSchema } from '../../src/shared/settings'

describe('home page and bookmark addresses (FIX-1 item 5)', () => {
  it.each([
    ['https://example.org/', true],
    ['http://localhost:8080/x', true],
    ['http://127.0.0.1/', true],
    ['http://[::1]:3000/', true],
    ['https://xn--bcher-kva.example/', true],
    ['https://bücher.example/', true],
    ['retronet://bookmarks/', true],
    ['https://not a url', false],
    ['https://not%20a%20url/', false],
    [' https://example.org/', false],
    ['https://example.org/a b', false],
    ['https://example.org/\t', false],
    ['https://exa\nmple.org/', false],
    ['https://-bad-.example/', false],
    ['https://a..b/', false],
    ['javascript:alert(1)', false]
  ])('%j valid=%s', (url, valid) => {
    expect(HomePageSchema.safeParse(url).success).toBe(valid)
    expect(SettingsPatchSchema.safeParse({ homePage: url }).success).toBe(valid)
    expect(BookmarkUrlSchema.safeParse(url).success).toBe(valid)
  })

  it('bookmarks still allow file: and refuse data:', () => {
    expect(BookmarkUrlSchema.safeParse('file:///Users/me/a.html').success).toBe(true)
    expect(BookmarkUrlSchema.safeParse('data:text/html,hi').success).toBe(false)
  })

  it('a stored home page that no longer validates falls back to the default instead of failing the file', () => {
    const parsed = SettingsSchema.parse({ homePage: 'https://not a url', skin: 'y2001' })
    expect(parsed).toEqual({ ...DEFAULT_SETTINGS, skin: 'y2001' })
    expect(SettingsSchema.parse({ homePage: 'https://ok.example/' }).homePage).toBe('https://ok.example/')
  })
})

const hist = (n: number, index: number) => ({
  entries: Array.from({ length: n }, (_, i) => ({ url: `https://h.test/${i}`, title: `H${i}` })),
  index
})

describe('session back/forward history (FIX-1 item 4)', () => {
  const tab = (id: number, url: string, extra: Record<string, unknown> = {}) => ({
    id,
    url,
    title: `t${id}`,
    pinned: false,
    groupId: null as string | null,
    muted: false,
    ...extra
  })

  it('saves a consistent history and drops one whose active entry is not the tab address', () => {
    const rec = serializeWindow({
      tabs: [tab(1, 'https://h.test/1', { history: hist(3, 1) }), tab(2, 'https://other.test/', { history: hist(3, 1) }), tab(3, 'https://c.test/')],
      groups: [],
      activeTabId: 1,
      bounds: null
    })!
    expect(rec.tabs[0]!.history).toEqual(hist(3, 1))
    expect(rec.tabs[1]!.history).toBeUndefined()
    expect('history' in rec.tabs[2]!).toBe(false)
    expect(SessionStateSchema.safeParse({ version: 1, savedAt: 1, windows: [rec] }).success).toBe(true)
  })

  it(`caps a long list to ${SESSION_HISTORY_MAX} entries around the active one`, () => {
    const rec = serializeWindow({ tabs: [tab(1, 'https://h.test/80', { history: hist(100, 80) })], groups: [], activeTabId: 1, bounds: null })!
    const h = rec.tabs[0]!.history!
    expect(h.entries).toHaveLength(SESSION_HISTORY_MAX)
    expect(h.entries[h.index]!.url).toBe('https://h.test/80')
  })

  it('on disk: old files (no history) load, malformed history is dropped, long lists are cut', () => {
    const base = { url: 'https://a.test/', title: 'A', pinned: false, groupId: null }
    const file = {
      version: 1,
      savedAt: 1,
      windows: [
        {
          tabs: [base, { ...base, history: { entries: 'nope', index: 0 } }, { ...base, history: { entries: [], index: 0 } }, { ...base, url: 'https://h.test/90', history: hist(120, 90) }],
          groups: [],
          activeIndex: 0,
          bounds: null
        }
      ]
    }
    const parsed = SessionStateSchema.parse(file)
    const tabs = parsed.windows[0]!.tabs
    expect(tabs).toHaveLength(4)
    expect(tabs[0]!.history).toBeUndefined()
    expect(tabs[1]!.history).toBeUndefined()
    expect(tabs[2]!.history).toBeUndefined()
    expect(tabs[3]!.history!.entries).toHaveLength(SESSION_HISTORY_MAX)
    expect(tabs[3]!.history!.entries[tabs[3]!.history!.index]!.url).toBe('https://h.test/90')
  })

  it('planRestore carries history for restorable tabs; the store round-trips it', () => {
    const rec = serializeWindow({ tabs: [tab(1, 'https://h.test/2', { history: hist(4, 2) })], groups: [], activeTabId: 1, bounds: null })!
    const plan = planRestore(rec, (u) => u.startsWith('https://'))
    expect(plan.tabs[0]!.history).toEqual(hist(4, 2))
    const store = createSessionStore(null, { now: () => 5 })
    store.save([rec])
    expect(store.load()).toEqual([rec])
  })
})
