// R7: every IPC contract method has exactly one handler. Runs every registration entry point that index.ts runs
// at ready (plus the per-session permissions install, which registers permissions.respond) against the real,
// fresh router, with electron replaced by an inert stand-in. A method added to the contract without a handler,
// or registered twice, fails here instead of at runtime.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  // Any property is another stand-in, any call or `new` returns one; iterating one yields nothing. Not thenable.
  const inert = (): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? function* () {} : inert()),
      apply: () => inert(),
      construct: () => inert(),
      has: () => true
    })
  const root = inert()
  return new Proxy({}, { get: (_t, k) => (k === '__esModule' ? false : k === 'default' ? root : root[k]), has: () => true })
})

import { IPC_METHOD_NAMES } from '../../src/shared/ipc-contract'
import { router } from '../../src/main/ipc/router'
import { registerShellHandlers } from '../../src/main/ipc/shell-handlers'
import { registerOmniboxHandlers } from '../../src/main/omnibox'
import { registerInternalApiHandlers } from '../../src/main/internal-api'
import { registerCommands } from '../../src/main/commands/dispatch'
import { installTabFeatures } from '../../src/main/tabs/session-restore'
import { installHttpAuth } from '../../src/main/security/http-auth'
import { installPermissions } from '../../src/main/security/permissions'
import { createProfileStores } from '../../src/main/storage'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

/** What index.ts calls at ready, by name (checked against its source below). */
const AT_READY = ['registerShellHandlers', 'registerOmniboxHandlers', 'registerInternalApiHandlers', 'installHttpAuth', 'installTabFeatures', 'registerCommands']

describe('IPC handler coverage', () => {
  it('every contract method has exactly one handler', () => {
    const counts = new Map<string, number>()
    const handle = router.handle.bind(router)
    vi.spyOn(router, 'handle').mockImplementation(((m: string, fn: never) => {
      counts.set(m, (counts.get(m) ?? 0) + 1)
      handle(m as never, fn)
    }) as typeof router.handle)

    registerShellHandlers()
    registerOmniboxHandlers()
    registerInternalApiHandlers()
    installHttpAuth()
    const profiles = { get: () => null, lastUsed: () => null, list: () => [], markUsed: () => {} }
    installTabFeatures(profiles as never)
    registerCommands()
    // permissions.respond is registered by the first profile session's installPermissions (installSessionHooks).
    const stores = createProfileStores(null)
    const ctx = { id: 'p', name: 'P', incognito: false, partition: 'persist:p-p', session: {}, dataDir: null, stores, getSettings: () => DEFAULT_SETTINGS, info: () => ({ id: 'p', name: 'P', createdAt: 0 }) }
    const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() }
    installPermissions(ses as never, ctx as never)
    installPermissions(ses as never, ctx as never) // a second session must not register again

    const missing = IPC_METHOD_NAMES.filter((m) => !router.hasHandler(m))
    expect(missing).toEqual([])
    const notOnce = [...counts].filter(([, n]) => n !== 1)
    expect(notOnce).toEqual([])
    expect([...counts.keys()].sort()).toEqual([...IPC_METHOD_NAMES].sort())
  })

  it('index.ts calls every registration entry point the test above runs', () => {
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    for (const fn of AT_READY) expect(src, fn).toMatch(new RegExp(`\\b${fn}\\(`))
  })
})
