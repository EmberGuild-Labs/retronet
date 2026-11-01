import { describe, expect, it, vi } from 'vitest'

// groups.ts / session-restore.ts import main modules that load electron; only their pure helpers run here.
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

import { groupMenuLabel } from '../../src/main/commands/tab-menus'
import { emptyGroupIds, newGroupId, nextGroupColor, pickVisibleTab, planJoinMove, planLeaveMove } from '../../src/main/tabs/groups'
import { planRestore, sanitizeBounds, serializeWindow } from '../../src/main/tabs/session-restore'
import { createSessionStore, type SessionWindowRecord } from '../../src/main/storage/session-store'
import { SessionStateSchema } from '../../src/shared/ipc-contract'

const strip = (...groups: Array<string | null>) => groups.map((g, i) => ({ id: i + 1, groupId: g }))

describe('group colors and ids', () => {
  it('hands out unused colors first, then cycles', () => {
    expect(nextGroupColor([])).toBe('blue')
    expect(nextGroupColor(['blue', 'red'])).toBe('yellow')
    const all = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const
    expect(nextGroupColor(all)).toBe('blue')
  })
  it('makes ids that satisfy the contract and avoid collisions', () => {
    const seq = ['aa', 'aa', 'bb']
    const id = newGroupId(new Set(['g-aa']), () => seq.shift()!)
    expect(id).toBe('g-bb')
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(newGroupId(new Set()))).toBe(true)
  })
})

describe('keeping members contiguous', () => {
  it('moves a joining tab to just after the last member', () => {
    // [1:g 2:- 3:g 4:g]: tab 2 joins -> final order 1,3,4,2 (index 3)
    expect(planJoinMove(strip('g', null, 'g', 'g'), 2, 'g')).toBe(3)
    expect(planJoinMove(strip('g', 'g', null, null), 4, 'g')).toBe(2)
  })
  it('does nothing when already adjacent or when the group has no other members', () => {
    expect(planJoinMove(strip('g', 'g', 'g'), 3, 'g')).toBeNull()
    expect(planJoinMove(strip(null, 'g'), 2, 'g')).toBeNull()
  })
  it('moves a tab leaving from the middle of a group to after it', () => {
    expect(planLeaveMove(strip('g', 'g', 'g', null), 2, 'g')).toBe(2)
    expect(planLeaveMove(strip('g', 'g', 'g', null), 1, 'g')).toBeNull()
    expect(planLeaveMove(strip('g', 'g', 'g', null), 3, 'g')).toBeNull()
  })
  it('finds empty groups', () => {
    const g = (id: string) => ({ id, name: '', color: 'blue' as const, collapsed: false })
    expect(emptyGroupIds([g('a'), g('b')], strip('a', null))).toEqual(['b'])
  })
})

describe('collapse moves focus out', () => {
  it('prefers the next visible tab to the right, then the left', () => {
    const s = strip('g', 'g', null, 'h', null)
    expect(pickVisibleTab(s, new Set(['g']), 1)).toBe(3)
    expect(pickVisibleTab(s, new Set(['g', 'h']), 2 /* inside g */)).toBe(3)
    expect(pickVisibleTab(strip(null, 'g', 'g'), new Set(['g']), 3)).toBe(1)
  })
  it('skips tabs in other collapsed groups', () => {
    const s = strip('g', 'h', 'h', null)
    expect(pickVisibleTab(s, new Set(['g', 'h']), 1)).toBe(4)
  })
  it('returns null when every tab is hidden', () => {
    expect(pickVisibleTab(strip('g', 'g'), new Set(['g']), 1)).toBeNull()
  })
})

describe('serializeWindow', () => {
  const tab = (id: number, url: string, extra: Record<string, unknown> = {}) => ({
    id,
    url,
    title: `t${id}`,
    pinned: false,
    groupId: null as string | null,
    muted: undefined as boolean | undefined,
    ...extra
  })
  const grp = (id: string, extra = {}) => ({ id, name: 'Work', color: 'red' as const, collapsed: true, ...extra })

  it('maps tabs, groups and the active index, validating against the schema', () => {
    const rec = serializeWindow({
      tabs: [tab(1, 'https://a.test/', { pinned: true }), tab(2, 'https://b.test/', { groupId: 'g1' }), tab(3, 'https://c.test/', { muted: true })],
      groups: [grp('g1'), grp('unused')],
      activeTabId: 3,
      bounds: { x: 10, y: 20, width: 900, height: 700 }
    })!
    expect(rec.activeIndex).toBe(2)
    expect(rec.groups).toEqual([{ id: 'g1', name: 'Work', color: 'red', collapsed: true }])
    expect(rec.tabs[0]).toMatchObject({ pinned: true, groupId: null })
    expect(rec.tabs[1]!.groupId).toBe('g1')
    expect(rec.tabs[2]!.muted).toBe(true)
    expect(SessionStateSchema.safeParse({ version: 1, savedAt: 1, windows: [rec] }).success).toBe(true)
  })
  it('drops blank addresses, pinned tabs lose their group, unknown group ids are cleared', () => {
    const rec = serializeWindow({
      tabs: [tab(1, ''), tab(2, 'https://a.test/', { pinned: true, groupId: 'g1' }), tab(3, 'https://b.test/', { groupId: 'zzz' })],
      groups: [grp('g1')],
      activeTabId: 99,
      bounds: null
    })!
    expect(rec.tabs.map((t) => t.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(rec.tabs.map((t) => t.groupId)).toEqual([null, null])
    expect(rec.groups).toEqual([])
    expect(rec.activeIndex).toBe(0)
    expect(rec.bounds).toBeNull()
  })
  it('returns null for a window with nothing to save', () => {
    expect(serializeWindow({ tabs: [tab(1, '')], groups: [], activeTabId: 1, bounds: null })).toBeNull()
  })
})

describe('planRestore', () => {
  const rec = (over: Partial<SessionWindowRecord>): SessionWindowRecord => ({
    tabs: [],
    groups: [],
    activeIndex: 0,
    bounds: null,
    ...over
  })
  const t = (url: string, extra = {}) => ({ url, title: '', pinned: false, groupId: null as string | null, ...extra })
  const g = (id: string, collapsed = false) => ({ id, name: id, color: 'red' as const, collapsed })
  const allow = (u: string) => u.startsWith('https://')

  it('restores pinned tabs first and a collapsed named group, mapping the active tab', () => {
    const plan = planRestore(
      rec({
        tabs: [t('https://a/'), t('https://p/', { pinned: true }), t('https://g1/', { groupId: 'g' }), t('https://g2/', { groupId: 'g' })],
        groups: [g('g', true)],
        activeIndex: 1
      }),
      allow
    )
    expect(plan.tabs.map((x) => x.url)).toEqual(['https://p/', 'https://a/', 'https://g1/', 'https://g2/'])
    expect(plan.activeIndex).toBe(0)
    expect(plan.groups).toEqual([g('g', true)])
  })
  it('refuses disallowed addresses and repairs the active index to the nearest survivor', () => {
    const plan = planRestore(rec({ tabs: [t('https://a/'), t('javascript:alert(1)'), t('https://c/')], activeIndex: 1 }), allow)
    expect(plan.tabs.map((x) => x.url)).toEqual(['https://a/', 'https://c/'])
    expect(plan.activeIndex).toBe(0)
  })
  it('fixes group references: pinned tabs and unknown groups lose them, empty groups vanish', () => {
    const plan = planRestore(
      rec({ tabs: [t('https://a/', { pinned: true, groupId: 'g' }), t('https://b/', { groupId: 'nope' })], groups: [g('g')] }),
      allow
    )
    expect(plan.tabs.map((x) => x.groupId)).toEqual([null, null])
    expect(plan.groups).toEqual([])
  })
  it('moves focus out of a collapsed group, or opens it when nothing else is visible', () => {
    const moved = planRestore(rec({ tabs: [t('https://a/', { groupId: 'g' }), t('https://b/')], groups: [g('g', true)], activeIndex: 0 }), allow)
    expect(moved.activeIndex).toBe(1)
    expect(moved.groups[0]!.collapsed).toBe(true)
    const opened = planRestore(rec({ tabs: [t('https://a/', { groupId: 'g' })], groups: [g('g', true)] }), allow)
    expect(opened.activeIndex).toBe(0)
    expect(opened.groups[0]!.collapsed).toBe(false)
  })
  it('caps the tab count and handles an empty window', () => {
    const many = Array.from({ length: 10 }, (_, i) => t(`https://x${i}/`))
    expect(planRestore(rec({ tabs: many }), allow, 4).tabs).toHaveLength(4)
    expect(planRestore(rec({}), allow).tabs).toEqual([])
  })
})

describe('sanitizeBounds', () => {
  const screen1 = { x: 0, y: 0, width: 1440, height: 900 }
  it('keeps on-screen bounds', () => {
    expect(sanitizeBounds({ x: 100, y: 80, width: 1000, height: 700 }, [screen1])).toEqual({ x: 100, y: 80, width: 1000, height: 700 })
  })
  it('drops the position when the window is off every display (monitor unplugged)', () => {
    expect(sanitizeBounds({ x: 4000, y: 100, width: 1000, height: 700 }, [screen1])).toEqual({ width: 1000, height: 700 })
  })
  it('clamps absurd sizes and rejects non-finite input', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 10, height: 20000 }, [screen1])).toEqual({ x: 0, y: 0, width: 400, height: 900 })
    expect(sanitizeBounds(null, [screen1])).toBeUndefined()
    expect(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, [screen1])).toBeUndefined()
  })
})

describe('session store round trip', () => {
  it('saves what serializeWindow produced and loads it back', () => {
    const store = createSessionStore(null, { now: () => 5 })
    const rec = serializeWindow({
      tabs: [{ id: 1, url: 'https://a.test/', title: 'A', pinned: true, groupId: null, muted: undefined }],
      groups: [],
      activeTabId: 1,
      bounds: null
    })!
    store.save([rec])
    expect(store.load()).toEqual([rec])
    store.clear()
    expect(store.load()).toEqual([])
  })
})

describe('menu labels', () => {
  it('uses the name, or the color for unnamed groups', () => {
    expect(groupMenuLabel({ name: 'Work', color: 'red' })).toBe('Work')
    expect(groupMenuLabel({ name: '  ', color: 'cyan' })).toBe('Cyan group')
  })
})
