// HTTP authentication (Q3): Basic/Digest sign-in for sites and proxies. `installHttpAuth()` (index.ts, at ready)
// handles `app.on('login')` and the overlay's `httpAuth.respond`.
//   - Only a tab's own content may ask: the main-frame document (or a frame navigation) of the origin the tab is
//     navigating to, or any request same-origin with the committed top-level page. Cross-origin subresources and
//     iframes are cancelled without a prompt, so a page can't phish with a dialog naming another site. Proxy
//     challenges always prompt (they come from the user's own network setup).
//   - The dialog is an overlay in the tab's window and names the origin (or proxy host:port); the realm is the
//     server's text and is shown as plain text. It only shows while its tab is the active one; each window shows
//     the active tab's first waiting sign-in, so a background tab never blocks it.
//   - Cancel, a new main-frame navigation in the tab, tab close, window close or a 5 min timeout cancel the
//     sign-in (callback() with no credentials), so the server's 401 body renders.
//   - Nothing is stored by RetroNet. Chromium keeps the accepted credentials in the session's in-memory auth
//     cache (per partition, so incognito never shares or persists them); data.clear empties it.
import { randomBytes } from 'node:crypto'
import { app, webContents as allWebContents, type AuthInfo, type WebContents } from 'electron'
import { IpcFailure, router } from '../ipc/router'
import { logger } from '../logger'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

export const HTTP_AUTH_TIMEOUT_MS = 5 * 60_000
/** How often a window with waiting sign-ins checks whether its dialog can be (re)shown. */
const PUMP_MS = 250
const REALM_MAX = 200

type Credentials = { username: string; password: string } | null
type LoginCallback = (username?: string, password?: string) => void

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/**
 * Whether a server (non-proxy) challenge for `requestUrl` may prompt. `navigatingTo` is the URL of the tab's
 * main-frame navigation in progress (after redirects), `committedUrl` the page it shows now.
 */
export function authPromptAllowed(d: {
  requestUrl: string
  isRequestForNavigation: boolean
  navigatingTo: string | null
  committedUrl: string
}): boolean {
  const origin = originOf(d.requestUrl)
  if (!origin) return false
  if (d.isRequestForNavigation && origin === originOf(d.navigatingTo)) return true
  return origin === originOf(d.committedUrl)
}

/** What the dialog names: the origin for sites, host:port for proxies. */
export function authTarget(requestUrl: string, info: Pick<AuthInfo, 'isProxy' | 'host' | 'port'>): string {
  if (info.isProxy) return info.port ? `${info.host}:${info.port}` : info.host
  return originOf(requestUrl) ?? info.host
}

/** The server's realm, made safe to show: no control characters, one line, capped. */
export function cleanRealm(realm: string | undefined): string {
  const one = (realm ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > REALM_MAX ? `${one.slice(0, REALM_MAX - 1)}…` : one
}

// ---------------------------------------------------------------------------------------------------------------
// Controller (Electron-free, so the unit test can drive it with fakes)

/** The slice of a WebContents the controller needs. */
export interface AuthWc {
  readonly id: number
  isDestroyed(): boolean
}

/** The slice of a WindowContext the controller needs. */
export interface AuthWindow {
  readonly id: number
  showOverlay: WindowContext['showOverlay']
  hideOverlay(): void
  overlayKind(): string | null
  /** The webContents of the active tab, if any. */
  activeWc(): AuthWc | null
}

interface Pending {
  id: string
  wc: AuthWc
  win: AuthWindow
  /** Requests with the same target, realm and kind share one dialog and one answer. */
  key: string
  host: string
  realm: string
  isProxy: boolean
  callbacks: LoginCallback[]
  timer: ReturnType<typeof setTimeout>
  shown: boolean
}

export function createHttpAuthController(opts: { timeoutMs?: number; pumpMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? HTTP_AUTH_TIMEOUT_MS
  const pumpMs = opts.pumpMs ?? PUMP_MS
  const queues = new Map<number, Pending[]>()
  const byId = new Map<string, Pending>()
  const pumps = new Map<number, ReturnType<typeof setInterval>>()

  function finish(p: Pending, creds: Credentials): void {
    if (!byId.delete(p.id)) return
    clearTimeout(p.timer)
    const q = queues.get(p.win.id)
    if (q) {
      const i = q.indexOf(p)
      if (i >= 0) q.splice(i, 1)
      if (q.length === 0) queues.delete(p.win.id)
    }
    if (p.shown && p.win.overlayKind() === 'http-auth') p.win.hideOverlay()
    for (const cb of p.callbacks) {
      try {
        if (creds && !p.wc.isDestroyed()) cb(creds.username, creds.password)
        else cb()
      } catch (err) {
        logger.warn(`http auth callback failed: ${String(err)}`)
      }
    }
    pump(p.win)
  }

  /**
   * Show the first waiting sign-in of the window's active tab when the overlay is free; keep checking. R15: a
   * background tab's sign-in never blocks the active tab's, and a shown dialog whose tab went to the background is
   * hidden (it shows again when its tab is active).
   */
  function pump(win: AuthWindow): void {
    const q = queues.get(win.id)
    if (!q || q.length === 0) {
      const t = pumps.get(win.id)
      if (t) clearInterval(t)
      pumps.delete(win.id)
      return
    }
    if (!pumps.has(win.id)) pumps.set(win.id, setInterval(() => pump(win), pumpMs))
    const gone = q.find((p) => p.wc.isDestroyed())
    if (gone) return finish(gone, null)
    let kind = win.overlayKind()
    const active = win.activeWc()
    const shown = q.find((p) => p.shown)
    if (shown) {
      if (kind === 'http-auth' && shown.wc === active) return
      // Replaced by another overlay (palette, dialog...): wait, then show again. Its tab went to the background:
      // hide it and fall through to the active tab's sign-in, if any.
      shown.shown = false
      if (kind !== 'http-auth') return
      win.hideOverlay()
      kind = win.overlayKind()
    }
    if (kind !== null && kind !== 'http-auth') return
    const next = active ? q.find((p) => p.wc === active) : undefined
    if (!next) return
    next.shown = true
    win.showOverlay({ kind: 'http-auth', id: next.id, host: next.host, realm: next.realm, isProxy: next.isProxy }, { focus: true })
  }

  /** A challenge Electron passed to us (after preventDefault). */
  function request(r: { wc: AuthWc; win: AuthWindow; host: string; realm: string; isProxy: boolean; callback: LoginCallback }): string {
    const key = `${r.isProxy ? 'proxy' : 'server'}|${r.host}|${r.realm}`
    const same = (queues.get(r.win.id) ?? []).find((p) => p.wc === r.wc && p.key === key)
    if (same) {
      same.callbacks.push(r.callback)
      return same.id
    }
    const id = randomBytes(12).toString('base64url')
    const p: Pending = {
      id,
      wc: r.wc,
      win: r.win,
      key,
      host: r.host,
      realm: r.realm,
      isProxy: r.isProxy,
      callbacks: [r.callback],
      timer: setTimeout(() => finish(p, null), timeoutMs),
      shown: false
    }
    byId.set(id, p)
    const q = queues.get(r.win.id) ?? []
    q.push(p)
    queues.set(r.win.id, q)
    pump(r.win)
    return id
  }

  /**
   * `httpAuth.respond`. Only a request of the calling window can be answered. R18: an empty username is a real
   * answer (some servers accept it); only `cancel: true` or a missing username cancels.
   */
  function respond(windowId: number, id: string, a: { username?: string; password?: string; cancel?: boolean }): boolean {
    const p = byId.get(id)
    if (!p || p.win.id !== windowId) return false
    finish(p, a.cancel === true || a.username === undefined ? null : { username: a.username, password: a.password ?? '' })
    return true
  }

  /** Cancel every sign-in of a tab (navigation away, tab closed). */
  function cancelFor(wc: AuthWc): void {
    for (const p of [...byId.values()]) if (p.wc === wc) finish(p, null)
  }

  function cancelWindow(windowId: number): void {
    for (const p of [...byId.values()]) if (p.win.id === windowId) finish(p, null)
  }

  return { request, respond, cancelFor, cancelWindow, pending: (windowId: number) => queues.get(windowId)?.length ?? 0 }
}

// ---------------------------------------------------------------------------------------------------------------
// Electron wiring

/** URL of each tab's main-frame navigation in progress (after redirects); cleared once it commits, fails or stops. */
const navigatingTo = new WeakMap<WebContents, string>()
const tracked = new WeakSet<WebContents>()

function track(wc: WebContents, controller: ReturnType<typeof createHttpAuthController>): void {
  if (tracked.has(wc)) return
  tracked.add(wc)
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    // A new navigation (user or page) abandons any sign-in this tab was waiting on.
    controller.cancelFor(wc)
    navigatingTo.set(wc, details.url)
  })
  wc.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) navigatingTo.set(wc, details.url)
  })
  wc.on('did-navigate', () => navigatingTo.delete(wc))
  wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) navigatingTo.delete(wc)
  })
  // A navigation that never commits nor fails (204, a download) ends here.
  wc.on('did-stop-loading', () => navigatingTo.delete(wc))
  wc.once('destroyed', () => controller.cancelFor(wc))
}

function authWindow(w: WindowContext): AuthWindow {
  return {
    id: w.id,
    showOverlay: (ev, o) => w.showOverlay(ev, o),
    hideOverlay: () => w.hideOverlay(),
    overlayKind: () => w.overlayKind(),
    activeWc: () => w.tabs.activeView()?.webContents ?? null
  }
}

let installed = false

/** index.ts calls this once at ready. Idempotent. */
export function installHttpAuth(): void {
  if (installed) return
  installed = true
  const controller = createHttpAuthController()
  const windows = new Map<number, AuthWindow>()
  const windowFor = (w: WindowContext): AuthWindow => {
    let a = windows.get(w.id)
    if (!a) windows.set(w.id, (a = authWindow(w)))
    return a
  }

  app.on('web-contents-created', (_e, wc) => track(wc, controller))
  for (const wc of allWebContents.getAllWebContents()) track(wc, controller)
  windowManager.onWindowClosed((w) => {
    controller.cancelWindow(w.id)
    windows.delete(w.id)
  })

  app.on('login', (event, wc, details, authInfo, callback) => {
    // From here on we own the answer: every path below calls callback, with or without credentials.
    event.preventDefault()
    const cancel = (why: string): void => {
      logger.info(`http auth cancelled: ${why}`)
      callback()
    }
    if (!wc || wc.isDestroyed()) return cancel('no tab')
    const w = windowManager.fromWebContents(wc)
    const info = router.senderInfo(wc)
    if (!w || w.win.isDestroyed() || (info && info.role !== 'tab') || w.tabs.tabIdFor(wc) === null) return cancel('not a tab')
    if (!authInfo.isProxy) {
      const ok = authPromptAllowed({
        requestUrl: details.url,
        isRequestForNavigation: details.isRequestForNavigation === true,
        navigatingTo: navigatingTo.get(wc) ?? null,
        committedUrl: wc.getURL()
      })
      if (!ok) return cancel('cross-origin request')
    }
    controller.request({
      wc,
      win: windowFor(w),
      host: authTarget(details.url, authInfo),
      realm: cleanRealm(authInfo.realm),
      isProxy: authInfo.isProxy,
      callback
    })
  })

  // An unknown or already-settled id fails, so a stale dialog closes itself (the overlay hides on !ok).
  router.handle('httpAuth.respond', (req, ctx) => {
    if (!controller.respond(ctx.info.windowId, req.id, req)) throw new IpcFailure('E_NOT_FOUND', 'No such sign-in request')
    return null
  })
}
