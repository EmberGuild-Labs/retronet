// R5 / R2: session.json is written on structural tab changes only (never on title/favicon/loading pushes), group
// housekeeping runs once per synchronous burst, and prepareQuit() writes the final session and then freezes it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  windows: [] as any[],
  structure: [] as Array<(w: any) => void>,
  normalizeGroups: vi.fn()
}))

vi.mock('electron', () => ({ screen: { getAllDisplays: () => [] }, app: { on: vi.fn() } }))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/main/security/navigation-guards', () => ({ decideBrowserNavigation: () => 'allow' }))
vi.mock('../../src/main/commands/tab-menus', () => ({ registerTabMenuHandlers: vi.fn() }))
vi.mock('../../src/main/tabs/groups', () => ({
  normalizeGroups: h.normalizeGroups,
  registerGroupHandlers: vi.fn(),
  pickVisibleTab: vi.fn(() => null)
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({
  browserTabs: (w: any) => w.tabsApi,
  onTabStructureChanged: (l: (w: any) => void) => (h.structure.push(l), () => {}),
  withTabSeed: vi.fn()
}))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: {
    all: () => h.windows,
    onWindowCreated: () => () => {},
    onWindowClosed: () => () => {}
  }
}))

import { installTabFeatures, prepareQuit } from '../../src/main/tabs/session-restore'

function mkWindow() {
  const view = {
    tabs: [{ id: 1, url: 'https://a.test/', title: 'A', pinned: false, groupId: null, muted: false }],
    groups: [],
    activeTabId: 1
  }
  const save = vi.fn()
  const w = {
    id: 1,
    popup: false,
    incognito: false,
    profile: { id: 'p', incognito: false, stores: { session: { save } } },
    win: { isDestroyed: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), on: vi.fn() },
    requestState: vi.fn(),
    tabsApi: { sessionView: () => view }
  }
  return { w, view, save }
}

const emit = (w: unknown): void => {
  for (const l of h.structure) l(w)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('session saving', () => {
  it('saves on structural changes only, coalesces housekeeping, and freezes after prepareQuit', async () => {
    const { w, view, save } = mkWindow()
    h.windows.push(w)
    installTabFeatures({ list: () => [{ id: 'p', name: 'P', createdAt: 0 }] } as any)
    expect(h.structure).toHaveLength(1)

    // Title / favicon / loading pushes go through requestState only: nothing is saved.
    w.requestState()
    w.requestState()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()

    // A burst of structural changes: one save (debounced), one housekeeping pass.
    emit(w)
    emit(w)
    emit(w)
    await Promise.resolve()
    expect(h.normalizeGroups).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(299)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0][0].tabs[0].url).toBe('https://a.test/')

    // Nothing changed: no rewrite.
    emit(w)
    vi.advanceTimersByTime(300)
    expect(save).toHaveBeenCalledTimes(1)

    // R2: a change still inside the debounce is written by prepareQuit() itself, synchronously.
    view.tabs[0]!.url = 'https://b.test/'
    emit(w)
    prepareQuit()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]![0][0].tabs[0].url).toBe('https://b.test/')

    // Frozen: windows closing during shutdown never overwrite the final session.
    view.tabs = []
    emit(w)
    vi.advanceTimersByTime(1000)
    prepareQuit()
    expect(save).toHaveBeenCalledTimes(2)
  })
})
