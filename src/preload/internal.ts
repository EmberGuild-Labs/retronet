// Internal-page preload, attached to every tab (PLAN 1.5, AC35). It exposes `window.retronet` ONLY when the
// top frame is a retronet://<page host>/ document, and then only that host's methods (the capability map in
// ipc-contract.ts). Web pages get nothing. The preload re-runs on every cross-document navigation, so a
// tab that moves from retronet://newtab/ to http:// loses the bridge. Main's router enforces the same rule
// from the sender frame URL, so this check is a convenience, not the security boundary.
//
// Sandboxed preloads can only require('electron'), so this file has no runtime imports (see shell.ts). The
// per-host method lists come from main in a `--rn-bridge=` process argument (security/web-prefs.ts).
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult } from '@shared/ipc-contract'

interface BridgeSpec {
  v: 1
  invokePrefix: string
  eventPrefix: string
  /** page host -> method names it may call */
  methods: Record<string, string[]>
  events: string[]
}

// The preload is type-checked with the node config (no DOM lib); declare the two globals it reads.
declare const window: { readonly top: unknown }
declare const location: { readonly protocol: string; readonly hostname: string }

const ARG = '--rn-bridge='

function readSpec(): BridgeSpec | null {
  const arg = process.argv.find((a) => a.startsWith(ARG))
  if (!arg) return null
  try {
    const spec = JSON.parse(decodeURIComponent(arg.slice(ARG.length))) as BridgeSpec
    return spec.v === 1 ? spec : null
  } catch {
    return null
  }
}

function pageHost(spec: BridgeSpec): string | null {
  if (window !== window.top || location.protocol !== 'retronet:') return null
  const host = location.hostname.toLowerCase()
  return Object.hasOwn(spec.methods, host) ? host : null
}

function call(spec: BridgeSpec, method: string): (req?: unknown) => Promise<IpcResult<unknown>> {
  const channel = spec.invokePrefix + method
  return async (req) => {
    try {
      return (await ipcRenderer.invoke(channel, req)) as IpcResult<unknown>
    } catch {
      return { ok: false, code: 'E_UNAVAILABLE', message: `${method} is unavailable` }
    }
  }
}

function buildApi(spec: BridgeSpec, host: string): Record<string, unknown> {
  const api: Record<string, Record<string, unknown>> = {}
  for (const method of spec.methods[host] ?? []) {
    const [ns, fn] = method.split('.') as [string, string]
    ;(api[ns] ??= {})[fn] = call(spec, method)
  }
  const events: ReadonlySet<string> = new Set(spec.events)
  return {
    ...Object.fromEntries(Object.entries(api).map(([k, v]) => [k, Object.freeze(v)])),
    platform: process.platform === 'darwin' ? 'mac' : 'win',
    on(event: string, cb: (payload: unknown) => void): () => void {
      if (!events.has(event) || typeof cb !== 'function') throw new TypeError(`Unknown event: ${String(event)}`)
      const channel = spec.eventPrefix + event
      const listener = (_e: unknown, payload: unknown): void => cb(payload)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  }
}

const spec = readSpec()
const host = spec && pageHost(spec)
if (spec && host) contextBridge.exposeInMainWorld('retronet', buildApi(spec, host))
