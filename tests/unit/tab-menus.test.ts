import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    windows: new Map<number, any>(),
    shown: [] as { opts: any; close: () => void }[],
    groups: { addTabToGroup: vi.fn(), updateGroup: vi.fn(), createGroupFromTab: vi.fn(), ungroup: vi.fn(), closeGroup: vi.fn(), removeTabFromGroup: vi.fn(), showGroupEditor: vi.fn() }
  }
})

vi.mock('electron', () => ({ Menu: {}, app: { getPath: () => '' } }))
vi.mock('../../src/main/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../src/main/menus/menu-host', () => ({
  showMenu: (_w: any, opts: any) => new Promise<void>((resolve) => h.shown.push({ opts, close: resolve }))
}))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: h.IpcFailure,
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn) }
}))
vi.mock('../../src/main/windows/window-manager', () => ({ windowManager: { get: (id: number) => h.windows.get(id) ?? null } }))
vi.mock('../../src/main/tabs/groups', () => h.groups)
vi.mock('../../src/main/tabs/tab-manager', () => ({ browserTabs: (w: any) => w.tabMgr }))

import { buildGroupMenu, buildTabMenu, groupMenuLabel, registerTabMenuHandlers } from '../../src/main/commands/tab-menus'

const PICK = { mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 as const }

function mkTabs(opts: { pinned?: boolean; groupId?: string | null; groups?: any[]; count?: number; closed?: number } = {}) {
  const n = opts.count ?? 3
  const list = Array.from({ length: n }, (_, i) => ({ id: i + 1, pinned: i === 0 && !!opts.pinned }))
  const tab = {
    pinned: !!opts.pinned,
    groupId: opts.groupId ?? null,
    state: () => ({ muted: false }),
    closedRecord: () => ({ url: 'https://a.test/', entries: [], index: 0, muted: false })
  }
  const groups = opts.groups ?? []
  return {
    get: (id: number) => (id >= 1 && id <= n ? { ...tab, pinned: id === 1 && !!opts.pinned } : null),
    list: () => list,
    groups: () => groups,
    getGroup: (id: string) => groups.find((g) => g.id === id) ?? null,
    closedTabs: () => Array.from({ length: opts.closed ?? 0 }),
    create: vi.fn(),
    reload: vi.fn(),
    pin: vi.fn(),
    toggleMute: vi.fn(),
    close: vi.fn(),
    reopenClosed: vi.fn()
  } as any
}
const labels = (es: any[]): string[] => es.map((e) => (e.kind === 'separator' ? '-' : e.label))

describe('buildTabMenu', () => {
  it('has the v1 items in order, with unique ids', () => {
    const es = buildTabMenu(mkTabs(), 2)
    expect(labels(es)).toEqual([
      'New Tab to the Right', '-', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Site', '-',
      'Add Tab to New Group', '-', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', '-', 'Reopen Closed Tab'
    ])
    const ids = es.filter((e: any) => e.id).map((e: any) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('pinned tab: no group items, "Unpin Tab"', () => {
    const es = buildTabMenu(mkTabs({ pinned: true }), 1)
    expect(labels(es)).toContain('Unpin Tab')
    expect(labels(es)).not.toContain('Add Tab to New Group')
  })

  it('offers "Add Tab to Group" submenu for other groups and "Remove from Group" for a grouped tab', () => {
    const groups = [{ id: 'g1', name: 'Work', color: 'blue' }, { id: 'g2', name: '', color: 'red' }]
    const es = buildTabMenu(mkTabs({ groups, groupId: 'g1' }), 2) as any[]
    const add = es.find((e) => e.label === 'Add Tab to Group')
    expect(add.submenu.map((i: any) => i.label)).toEqual(['Red group'])
    expect(labels(es)).toContain('Remove from Group')
  })

  it('enabled flags: close others/right and reopen', () => {
    const only = Object.fromEntries((buildTabMenu(mkTabs({ count: 1 }), 1) as any[]).filter((e) => e.id).map((e) => [e.label, e.enabled]))
    expect(only['Close Other Tabs']).toBe(false)
    expect(only['Close Tabs to the Right']).toBe(false)
    expect(only['Reopen Closed Tab']).toBe(false)
    const some = Object.fromEntries((buildTabMenu(mkTabs({ closed: 1 }), 1) as any[]).filter((e) => e.id).map((e) => [e.label, e.enabled]))
    expect(some['Close Other Tabs']).toBe(true)
    expect(some['Reopen Closed Tab']).toBe(true)
  })

  it('actions run against the tab manager; unknown tab is empty', () => {
    const tabs = mkTabs()
    const es = buildTabMenu(tabs, 2) as any[]
    es.find((e) => e.label === 'Reload').run(PICK)
    expect(tabs.reload).toHaveBeenCalledWith(2)
    es.find((e) => e.label === 'Close Tabs to the Right').run(PICK)
    expect(tabs.close).toHaveBeenCalledWith(3)
    expect(buildTabMenu(tabs, 99)).toEqual([])
  })
})

describe('buildGroupMenu', () => {
  it('has Color as a radio submenu with the current colour checked', () => {
    const groups = [{ id: 'g1', name: '', color: 'green', collapsed: false }]
    const w = { tabMgr: mkTabs({ groups }) } as any
    const es = buildGroupMenu(w, 'g1', { x: 1, y: 2 }) as any[]
    expect(labels(es)).toEqual(['Edit Group...', 'New Tab in Group', 'Collapse Group', 'Color', '-', 'Ungroup', 'Close Group'])
    const color = es.find((e) => e.label === 'Color')
    expect(color.submenu.every((i: any) => i.check === 'radio')).toBe(true)
    expect(color.submenu.filter((i: any) => i.checked).map((i: any) => i.label)).toEqual(['Green'])
    expect(buildGroupMenu(w, 'nope', { x: 0, y: 0 })).toEqual([])
    expect(groupMenuLabel({ name: '', color: 'green' })).toBe('Green group')
  })
})

describe('handlers', () => {
  let tabs: any
  beforeEach(() => {
    h.handlers.clear()
    h.windows.clear()
    h.shown.length = 0
    tabs = mkTabs({ groups: [{ id: 'g1', name: 'W', color: 'blue', collapsed: false }] })
    h.windows.set(1, { id: 1, win: { isDestroyed: () => false }, tabMgr: tabs })
    registerTabMenuHandlers()
  })
  const call = (m: string, req: any) => h.handlers.get(m)!(req, { info: { windowId: 1 } })

  it('tabs.contextMenu shows a point menu and resolves on close', async () => {
    let done = false
    const p = call('tabs.contextMenu', { tabId: 2, x: 10, y: 20 }).then(() => (done = true))
    const { opts, close } = h.shown[0]!
    expect(opts).toMatchObject({ kind: 'tab', label: 'Tab', placement: 'point', anchor: { x: 10, y: 20, width: 0, height: 0 } })
    expect(opts.isValid()).toBe(true)
    await Promise.resolve()
    expect(done).toBe(false)
    close()
    await p
    expect(done).toBe(true)
  })

  it('keyboard open anchors below the rect; a gone tab invalidates the menu', () => {
    void call('tabs.contextMenu', { tabId: 2, x: 0, y: 0, anchor: { x: 5, y: 6, width: 7, height: 8 }, keyboard: true })
    const { opts } = h.shown[0]!
    expect(opts).toMatchObject({ placement: 'below', keyboard: true, anchor: { x: 5, y: 6, width: 7, height: 8 } })
    tabs.get = () => null
    expect(opts.isValid()).toBe(false)
  })

  it('groups.contextMenu uses the group kind; unknown ids are E_NOT_FOUND', async () => {
    void call('groups.contextMenu', { groupId: 'g1', x: 3, y: 4 })
    expect(h.shown[0]!.opts).toMatchObject({ kind: 'group', label: 'Tab group', placement: 'point' })
    await expect(call('groups.contextMenu', { groupId: 'zz', x: 0, y: 0 })).rejects.toBeInstanceOf(h.IpcFailure)
    await expect(call('tabs.contextMenu', { tabId: 99, x: 0, y: 0 })).rejects.toBeInstanceOf(h.IpcFailure)
  })
})
