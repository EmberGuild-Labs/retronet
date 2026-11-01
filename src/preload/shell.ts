// Shell and overlay preload (PLAN 1.5, AC35). Exposes `window.retronet` as a named API for this caller, and
// nothing else: no ipcRenderer, no generic invoke, no channel names. It exposes only on the top frame of
// retronet://shell/ or retronet://overlay/; main's router re-checks the sender frame, the webContents and
// the payload on every call regardless.
//
// Sandboxed preloads can only require('electron') (no relative chunks, no zod), so this file has no runtime
// imports. The method lists come from main (security/web-prefs.ts builds them from ipc-contract.ts
// `methodsFor()`) in a `--rn-bridge=` process argument.
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult } from '@shared/ipc-contract'

interface BridgeSpec {
  v: 1
  invokePrefix: string
  eventPrefix: string
  /** caller host -> method names it may call */
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

function callerHost(spec: BridgeSpec): string | null {
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
      // Unserializable payload or no handler on the main side. Never surface raw errors.
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
const host = spec && callerHost(spec)
if (spec && host) contextBridge.exposeInMainWorld('retronet', buildApi(spec, host))
