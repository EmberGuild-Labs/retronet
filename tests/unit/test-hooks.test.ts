// F-HOOKS (AC64, AC75 enablers): the gated `__rn` / `__rnDialogs` exist only when testHooksEnabled().
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ enabled: false, preloads: [] as string[] }))

vi.mock('electron', () => ({
  session: { defaultSession: { storagePath: '/d', getPreloadScripts: () => h.preloads.map((filePath) => ({ filePath })) } },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../../src/main/app-paths', () => ({ testHooksEnabled: () => h.enabled }))
vi.mock('../../src/main/ipc/router', () => ({ router: { recentRejections: () => [] } }))
vi.mock('../../src/main/native-dialogs', () => ({ setNativeDialogsForTests: vi.fn() }))
vi.mock('../../src/main/storage/json-store', () => ({ flushAllStores: vi.fn() }))
vi.mock('../../src/main/tabs/session-restore', () => ({ saveNow: vi.fn() }))
vi.mock('../../src/main/windows/window-manager', () => ({ windowManager: { all: () => [] } }))
vi.mock('../../src/main/menus/menu-host', () => ({
  currentMenu: (id: number) => (id === 1 ? { menuId: 'm1', items: [] } : null),
  nativeFallbackCount: () => 2,
  pickMenu: vi.fn(() => true),
  dismissMenu: vi.fn(() => true)
}))

const g = globalThis as Record<string, unknown>

describe('test hooks gating', () => {
  beforeEach(() => {
    vi.resetModules()
    delete g.__rn
    delete g.__rnDialogs
  })
  // The globals are non-configurable by design, so the enabled case must run last (it cannot be cleaned up).

  it('installs nothing when test hooks are disabled (packaged or no RETRONET_E2E)', async () => {
    h.enabled = false
    const { installTestHooks } = await import('../../src/main/test-hooks')
    installTestHooks()
    expect(g.__rn).toBeUndefined()
    expect(g.__rnDialogs).toBeUndefined()
    expect('__rn' in globalThis).toBe(false)
  })

  it('exposes menu, pick, dismiss and session-audit hooks when enabled', async () => {
    h.enabled = true
    h.preloads = []
    const { installTestHooks } = await import('../../src/main/test-hooks')
    installTestHooks()
    const rn = g.__rn as any
    expect(g.__rnDialogs).toBeDefined()
    expect(rn.menu(1)).toEqual({ spec: { menuId: 'm1', items: [] }, fallbackCount: 2 })
    expect(rn.menu(9).spec).toBeNull()
    expect(rn.nativeFallbackCount()).toBe(2)
    expect(rn.currentMenu(9)).toBeNull()
    expect(rn.pickMenu(1, { menuId: 'm1', itemId: 'a', mods: {}, button: 0 })).toBe(true)
    expect(rn.dismissMenu(1, 'm1')).toBe(true)
    expect(rn.auditSessions()).toEqual([{ storagePath: '/d', ok: true, preloads: [] }])
    h.preloads = ['/evil.js']
    expect(rn.auditSessions()[0].ok).toBe(false)
  })
})
