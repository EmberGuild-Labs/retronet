// The only place that calls `ipcMain` (PLAN 1.3, AC35). Every invoke goes through `dispatch`:
//   1. the sender webContents must be registered (shell, overlay or tab) and alive,
//   2. the sending frame must be that webContents' top frame, at a retronet://<host>/ URL whose origin
//      matches, and the host must fit the sender's role (shell/overlay webContents can only be 'shell'/
//      'overlay'; tabs can only be internal page hosts),
//   3. that caller must be in the method's `callers` list (capability map),
//   4. the payload must pass the method's strict zod schema,
//   5. the handler's result must pass the response schema.
// Any failure resolves `{ok:false, code}` and is logged (method, code, role, origin; never the payload).
// Handlers never see raw IPC events and never throw across IPC.
//
// G4+ tasks register with `router.handle('<method>', (req, ctx) => result)`. Throw `IpcFailure` to return a
// specific error code; any other throw becomes E_INTERNAL.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { z } from 'zod'
import {
  callerForUrl,
  eventChannel,
  fail,
  invokeChannel,
  IPC_METHOD_NAMES,
  IPC_METHODS,
  isCallerAllowed,
  ok,
  validateRequest,
  type IpcErrorCode,
  type IpcMethodName,
  type IpcResponse,
  type IpcResult,
  type PageEventName,
  type PageEventPayload,
  type ShellEventName,
  type ShellEventPayload
} from '../../shared/ipc-contract'
import { PAGE_HOSTS, type Caller, type PageHost } from '../../shared/types'
import { logger } from '../logger'

export type SenderRole = 'shell' | 'overlay' | 'tab'

export interface SenderInfo {
  role: SenderRole
  windowId: number
  /** Set for tabs. */
  tabId?: number
}

export interface CallContext {
  method: IpcMethodName
  caller: Caller
  sender: WebContents
  info: SenderInfo
  /** Committed URL of the sending top frame (retronet://...). */
  frameUrl: string
}

export type ParsedRequest<M extends IpcMethodName> = z.output<(typeof IPC_METHODS)[M]['request']>
export type Handler<M extends IpcMethodName> = (
  req: ParsedRequest<M>,
  ctx: CallContext
) => IpcResponse<M> | Promise<IpcResponse<M>>

/** Throw from a handler to return a specific error code with a user-safe message. */
export class IpcFailure extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'IpcFailure'
  }
}

export interface Rejection {
  at: number
  method: string
  code: IpcErrorCode
  role: SenderRole | 'unknown'
  origin: string
  reason: string
}

/** Minimal surface of a raw invoke event; lets tests drive `dispatch` without Electron's ipcMain. */
export interface InvokeEventLike {
  sender: WebContents
  senderFrame: IpcMainInvokeEvent['senderFrame']
}

const PAGE_HOST_SET: ReadonlySet<string> = new Set(PAGE_HOSTS)

function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'retronet:' ? `retronet://${u.hostname}` : u.origin
  } catch {
    return '(invalid)'
  }
}

function roleAllows(role: SenderRole, caller: Caller): boolean {
  if (role === 'shell') return caller === 'shell'
  if (role === 'overlay') return caller === 'overlay'
  return PAGE_HOST_SET.has(caller)
}

// Rejection log rate limit: a hostile or buggy page looping on a bad call must not flood main.log.
const LOG_WINDOW_MS = 10_000
const LOG_MAX_PER_WINDOW = 50
const KEEP_REJECTIONS = 200

export class IpcRouter {
  private readonly handlers = new Map<IpcMethodName, Handler<IpcMethodName>>()
  private readonly senders = new Map<number, SenderInfo>()
  private readonly rejections: Rejection[] = []
  private logWindowStart = 0
  private loggedInWindow = 0
  private suppressed = 0
  private installed = false

  /** Register a handler. Each method has exactly one; registering twice is a programming error. */
  handle<M extends IpcMethodName>(method: M, handler: Handler<M>): void {
    if (!Object.hasOwn(IPC_METHODS, method)) throw new Error(`Unknown IPC method ${method}`)
    if (this.handlers.has(method)) throw new Error(`IPC method ${method} already has a handler`)
    this.handlers.set(method, handler as unknown as Handler<IpcMethodName>)
  }

  hasHandler(method: IpcMethodName): boolean {
    return this.handlers.has(method)
  }

  /**
   * Mark a webContents as a known sender. The window manager registers shell and overlay; the tab manager
   * registers each tab. Automatically forgotten when the webContents is destroyed. Returns an unregister fn.
   */
  registerSender(wc: WebContents, info: SenderInfo): () => void {
    const id = wc.id
    this.senders.set(id, { ...info })
    const forget = (): void => {
      if (this.senders.get(id)?.role === info.role) this.senders.delete(id)
    }
    wc.once('destroyed', forget)
    return forget
  }

  senderInfo(wc: WebContents): SenderInfo | undefined {
    return this.senders.get(wc.id)
  }

  /** Recent rejections (newest last), for test hooks. */
  recentRejections(): readonly Rejection[] {
    return this.rejections
  }

  /** Register one `ipcMain.handle` per contract method. Methods without a handler answer E_UNAVAILABLE. */
  install(ipc: Pick<typeof ipcMain, 'handle'> = ipcMain): void {
    if (this.installed) return
    this.installed = true
    for (const method of IPC_METHOD_NAMES) {
      ipc.handle(invokeChannel(method), (event, payload: unknown) => this.dispatch(method, event, payload))
    }
  }

  async dispatch(method: IpcMethodName, event: InvokeEventLike, payload: unknown): Promise<IpcResult<unknown>> {
    const sender = event.sender
    const info = sender && !sender.isDestroyed() ? this.senders.get(sender.id) : undefined
    const reject = (code: IpcErrorCode, reason: string, url = ''): IpcResult<never> => {
      this.recordRejection({ at: Date.now(), method, code, role: info?.role ?? 'unknown', origin: originOf(url), reason })
      return fail(code, code === 'E_INVALID' ? reason : 'Not allowed')
    }

    if (!info) return reject('E_FORBIDDEN', 'unknown sender webContents')

    let frame: InvokeEventLike['senderFrame']
    try {
      frame = event.senderFrame
    } catch {
      frame = null
    }
    if (!frame || frame.detached) return reject('E_FORBIDDEN', 'sender frame gone')
    const main = sender.mainFrame
    if (frame.parent !== null || frame.processId !== main.processId || frame.routingId !== main.routingId) {
      return reject('E_FORBIDDEN', 'not the top frame', frame.url)
    }
    const url = frame.url
    const caller = callerForUrl(url)
    if (!caller) return reject('E_FORBIDDEN', 'frame is not a retronet:// page', url)
    if (frame.origin !== `retronet://${caller}`) return reject('E_FORBIDDEN', `origin mismatch ${frame.origin}`, url)
    if (!roleAllows(info.role, caller)) return reject('E_FORBIDDEN', `${info.role} webContents cannot act as ${caller}`, url)
    if (!isCallerAllowed(method, caller)) return reject('E_FORBIDDEN', `${caller} may not call ${method}`, url)

    const parsed = validateRequest(method, payload)
    if (!parsed.ok) return reject('E_INVALID', parsed.message, url)

    const handler = this.handlers.get(method)
    if (!handler) return fail('E_UNAVAILABLE', `${method} is not available yet`)

    try {
      const ctx: CallContext = { method, caller, sender, info, frameUrl: url }
      const result = await handler(parsed.data as ParsedRequest<IpcMethodName>, ctx)
      const checked = (IPC_METHODS[method].response as z.ZodType).safeParse(result === undefined ? null : result)
      if (!checked.success) {
        logger.error(`ipc ${method}: handler returned an invalid response`, checked.error.issues.slice(0, 3))
        return fail('E_INTERNAL', 'Internal error')
      }
      return ok(checked.data)
    } catch (err) {
      if (err instanceof IpcFailure) return fail(err.code, err.message)
      logger.error(`ipc ${method}: handler threw`, err)
      return fail('E_INTERNAL', 'Internal error')
    }
  }

  private recordRejection(r: Rejection): void {
    this.rejections.push(r)
    if (this.rejections.length > KEEP_REJECTIONS) this.rejections.splice(0, this.rejections.length - KEEP_REJECTIONS)
    if (r.at - this.logWindowStart > LOG_WINDOW_MS) {
      if (this.suppressed > 0) logger.warn(`ipc rejected: ${this.suppressed} more rejections suppressed`)
      this.logWindowStart = r.at
      this.loggedInWindow = 0
      this.suppressed = 0
    }
    if (this.loggedInWindow++ < LOG_MAX_PER_WINDOW) {
      logger.warn(`ipc rejected ${r.method} ${r.code} role=${r.role} origin=${r.origin}: ${r.reason.replace(/\s+/g, ' ')}`)
    } else {
      this.suppressed++
    }
  }
}

/** The app-wide router. index.ts calls `router.install()` once at ready. */
export const router = new IpcRouter()

function alive(wc: WebContents | null | undefined): wc is WebContents {
  return !!wc && !wc.isDestroyed()
}

/** Push a shell event to a shell or overlay webContents. */
export function sendShellEvent<E extends ShellEventName>(wc: WebContents | null | undefined, event: E, payload: ShellEventPayload<E>): void {
  if (alive(wc)) wc.send(eventChannel(event), payload)
}

/**
 * Push a page event to a tab, only if its top frame is currently a retronet:// internal page (web pages never
 * receive events, even though they could not read them anyway).
 */
export function sendPageEvent<E extends PageEventName>(
  wc: WebContents | null | undefined,
  event: E,
  payload: PageEventPayload<E>,
  only?: PageHost
): void {
  if (!alive(wc)) return
  const caller = callerForUrl(wc.mainFrame.url)
  if (!caller || !PAGE_HOST_SET.has(caller) || (only && caller !== only)) return
  wc.send(eventChannel(event), payload)
}
