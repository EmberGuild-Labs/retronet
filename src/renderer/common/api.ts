// Typed client over the preload bridge (PLAN 1.5). Shell and overlay call shellApi(); internal pages call
// pageApi('<host>'), which only types that host's methods (the preload only exposes those at runtime).
import type { IpcErrorCode, IpcResult, PageBridge, ShellBridge } from '@shared/ipc-contract'
import type { PageHost } from '@shared/types'

export type { IpcResult, PageBridge, ShellBridge } from '@shared/ipc-contract'

function bridge(): unknown {
  const b = window.retronet
  if (!b) throw new Error('RetroNet bridge is missing: this page is not running under a RetroNet preload')
  return b
}

export function shellApi(): ShellBridge {
  return bridge() as ShellBridge
}

export function pageApi<H extends PageHost>(_host: H): PageBridge<H> {
  return bridge() as PageBridge<H>
}

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

/** Returns the data of a successful call, or throws IpcError. For UI code that prefers try/catch. */
export async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const res = await call
  if (res.ok) return res.data
  throw new IpcError(res.code, res.message)
}
