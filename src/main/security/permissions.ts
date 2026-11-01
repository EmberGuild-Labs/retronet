// Site permissions (PLAN 1.8, AC33). `installPermissions(ses, ctx)` is called by installSessionHooks() for every
// profile and incognito session.
//   - Prompted: camera, microphone (Electron's `media`, split by mediaTypes), geolocation, notifications,
//     clipboard-read. Silently allowed: fullscreen, clipboard-sanitized-write. Everything else is denied.
//   - Decisions are keyed by (REQUESTING frame origin, TOP-LEVEL origin) (S6): a top page asks as its origin
//     (key = the origin, unchanged from before); an iframe asks as "<frame origin> on <top origin>", so allowing
//     maps.example inside news.example does not let maps.example ask silently inside evil.example. The prompt
//     names the top-level host plus "embedded from <frame host>". Decisions live in ctx.stores.permissions
//     (memory-only for incognito, which gets a null-file store from T8).
//   - Only http(s) pages are ever asked or allowed: retronet:, file:, data: etc. are denied without a prompt.
//   - One prompt at a time per window; the rest wait in a queue. Allow / Block / Dismiss come back through the
//     `permissions.respond` IPC method (overlay only). Dismiss, a 60 s timeout, navigation away, tab close,
//     renderer crash or window close all deny, and none of those are remembered.
//   - After Allow for camera/microphone on macOS the OS-level permission is requested too.
import { randomBytes } from 'node:crypto'
import { systemPreferences, type Session, type WebContents } from 'electron'
import type { PermissionRequest } from '../../shared/types'
import { router } from '../ipc/router'
import { logger } from '../logger'
import type { PermissionKind, PermissionStore } from '../storage/permission-store'
import type { ProfileContext, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

export const PERMISSION_TIMEOUT_MS = 60_000
const RETRY_MS = 400
const PROMPT_WIDTH = 360
const PROMPT_ARROW_OVERLAP = 4
/** Room below the anchor for the prompt (head, kinds, buttons, count) plus its shadow. */
const PROMPT_BOX_HEIGHT = 260
const PROMPT_BOX_MARGIN = 24

type AnchorRect = { x: number; y: number; width: number; height: number }

/**
 * Overlay bounds for the prompt: just the box around it (top-left of the window), so the page stays usable
 * while a prompt is open (DESIGN 3.8). Window-content coordinates; capped to the content width.
 */
export function promptBounds(anchor: AnchorRect, contentWidth: number): AnchorRect {
  const width = Math.max(1, Math.min(contentWidth, Math.max(0, anchor.x) + PROMPT_WIDTH + PROMPT_BOX_MARGIN))
  return { x: 0, y: 0, width, height: Math.max(1, Math.round(anchor.y + PROMPT_BOX_HEIGHT)) }
}

const SILENT_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write'])

export type Decision = 'allow' | 'block' | 'dismiss'

/** Prompted kinds for an Electron permission name. Empty = not a prompted permission. */
export function promptedKinds(permission: string, mediaTypes?: readonly string[]): PermissionKind[] {
  switch (permission) {
    case 'geolocation':
    case 'notifications':
    case 'clipboard-read':
      return [permission]
    case 'media': {
      const kinds: PermissionKind[] = []
      if (mediaTypes?.includes('video')) kinds.push('camera')
      if (mediaTypes?.includes('audio')) kinds.push('microphone')
      return kinds
    }
    default:
      return []
  }
}

/** http(s) origin of a URL, or null (opaque, retronet:, file:, malformed...). */
export function webOrigin(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/** Separator of an embedded decision key; origins never contain spaces. */
export const EMBEDDED_KEY_SEPARATOR = ' on '

/** Store key for a decision: the origin itself for top-level frames, "<requesting> on <top>" for iframes. */
export function permissionKey(requestingOrigin: string, topOrigin: string): string {
  return requestingOrigin === topOrigin ? requestingOrigin : `${requestingOrigin}${EMBEDDED_KEY_SEPARATOR}${topOrigin}`
}

export interface RequestDetails {
  requestingUrl?: string
  mediaTypes?: readonly string[]
}
export interface CheckDetails {
  requestingUrl?: string
  mediaType?: string
  /** Electron: the top-level origin when the check comes from a subframe. */
  embeddingOrigin?: string
}

/** The slice of a WebContents the controller needs. */
export interface WcLike {
  readonly id: number
  getURL(): string
  isDestroyed(): boolean
  on(event: string, listener: (...args: any[]) => void): unknown
}

/** The slice of a WindowContext the controller needs. */
export interface WindowLike {
  readonly id: number
  readonly insets: Readonly<{ top: number; bottom: number }>
  tabs: { tabIdFor(wc: any): number | null }
  showOverlay: WindowContext['showOverlay']
  hideOverlay(): void
  overlayKind(): string | null
  /** Content-area rect of the tab (its width = the window content width). Optional for tests. */
  tabBounds?(): AnchorRect
}

export interface ControllerDeps {
  store: PermissionStore
  windowFor(wc: WcLike): WindowLike | null
  /** Ask the OS (macOS) for camera/microphone access. Resolves false when it is denied. */
  osAccess(kind: 'camera' | 'microphone'): Promise<boolean>
  /** Prompt anchor whose arrow tip lands under the omnibox security icon (anchorForArrowTip of the shell's measurement). */
  securityAnchor?(win: WindowLike): Promise<AnchorRect | null>
  now?: () => number
}

interface Pending {
  id: string
  wc: WcLike
  win: WindowLike
  /** Requesting frame's origin. */
  origin: string
  /** Store key: permissionKey(origin, top-level origin). */
  key: string
  /** Top-level page's host (what the prompt names). */
  host: string
  /** Requesting frame's host when it differs from the top-level origin. */
  embeddedFrom: string | null
  /** Kinds the user is asked about (kinds already remembered as allow are excluded). */
  kinds: PermissionKind[]
  callback: (granted: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
}

export function createPermissionController(deps: ControllerDeps) {
  const queues = new Map<number, Pending[]>()
  const byId = new Map<string, Pending>()
  const watched = new WeakSet<object>()
  const retry = new Map<number, ReturnType<typeof setTimeout>>()

  const newId = (): string => randomBytes(12).toString('base64url')

  function finish(p: Pending, granted: boolean): void {
    if (p.done) return
    p.done = true
    if (p.timer) clearTimeout(p.timer)
    byId.delete(p.id)
    const q = queues.get(p.win.id)
    if (q) {
      const i = q.indexOf(p)
      if (i >= 0) q.splice(i, 1)
      if (q.length === 0) queues.delete(p.win.id)
    }
    try {
      p.callback(granted)
    } catch (err) {
      logger.warn(`permission callback failed: ${String(err)}`)
    }
    pump(p.win)
  }

  function arm(p: Pending): void {
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => finish(p, false), PERMISSION_TIMEOUT_MS)
  }

  /** Show the head of the window's queue (or hide the prompt when the queue is empty). */
  function pump(win: WindowLike): void {
    const q = queues.get(win.id)
    const t = retry.get(win.id)
    if (t) {
      clearTimeout(t)
      retry.delete(win.id)
    }
    if (!q || q.length === 0) {
      if (win.overlayKind() === 'permission') win.hideOverlay()
      return
    }
    const head = q[0]!
    const kind = win.overlayKind()
    if (kind !== null && kind !== 'permission') {
      // A palette or dialog is open; do not replace it. Look again shortly (the 60 s timers keep running).
      retry.set(win.id, setTimeout(() => pump(win), RETRY_MS))
      return
    }
    if (head.wc.isDestroyed()) return finish(head, false)
    const request: PermissionRequest = {
      id: head.id,
      origin: head.origin,
      host: head.host,
      ...(head.embeddedFrom ? { embeddedFrom: head.embeddedFrom } : {}),
      kinds: head.kinds,
      position: 1,
      total: q.length
    }
    arm(head)
    // Fallback anchor (no shell measurement): just above the content area, overlapping it by 4px.
    const fallback = { x: 8, y: Math.max(0, win.insets.top - PROMPT_ARROW_OVERLAP), width: PROMPT_WIDTH, height: 0 }
    const show = (anchor: AnchorRect): void => {
      if (head.done || queues.get(win.id)?.[0] !== head) return
      const k = win.overlayKind()
      if (k !== null && k !== 'permission') return pump(win)
      const contentWidth = win.tabBounds?.().width ?? anchor.x + PROMPT_WIDTH + PROMPT_BOX_MARGIN
      win.showOverlay({ kind: 'permission', request, anchor }, { focus: true, bounds: promptBounds(anchor, contentWidth) })
    }
    if (!deps.securityAnchor) return show(fallback)
    void deps.securityAnchor(win).then(
      (a) => show(a ?? fallback),
      () => show(fallback)
    )
  }

  function watch(wc: WcLike): void {
    if (watched.has(wc)) return
    watched.add(wc)
    const cancel = (): void => cancelFor(wc)
    wc.on('did-start-navigation', (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) cancel()
    })
    wc.on('render-process-gone', cancel)
    wc.on('destroyed', cancel)
  }

  function cancelFor(wc: WcLike): void {
    for (const p of [...byId.values()]) if (p.wc === wc) finish(p, false)
  }

  function cancelWindow(windowId: number): void {
    for (const p of [...(queues.get(windowId) ?? [])]) finish(p, false)
    const t = retry.get(windowId)
    if (t) clearTimeout(t)
    retry.delete(windowId)
  }

  /** Remembered decision(s) for the kinds: 'block' if any is blocked, 'allow' if all allowed, else the unresolved kinds. */
  function evaluate(origin: string, kinds: PermissionKind[]): 'block' | 'allow' | PermissionKind[] {
    const unresolved: PermissionKind[] = []
    for (const k of kinds) {
      const d = deps.store.get(origin, k)
      if (d === 'block') return 'block'
      if (d === null) unresolved.push(k)
    }
    return unresolved.length === 0 ? 'allow' : unresolved
  }

  /** Setting `webContents` handler: ses.setPermissionRequestHandler. */
  function handleRequest(
    wc: WcLike | null,
    permission: string,
    callback: (granted: boolean) => void,
    details: RequestDetails
  ): void {
    if (SILENT_ALLOW.has(permission)) {
      // Even silent ones are limited to web pages.
      return callback(webOrigin(details.requestingUrl ?? wc?.getURL()) !== null)
    }
    const kinds = promptedKinds(permission, details.mediaTypes)
    if (kinds.length === 0) {
      logger.info(`permission denied: ${permission}`)
      return callback(false)
    }
    const origin = webOrigin(details.requestingUrl)
    const top = wc && !wc.isDestroyed() ? webOrigin(wc.getURL()) : null
    if (!wc || wc.isDestroyed() || !origin || top === null) return callback(false)
    const key = permissionKey(origin, top)
    const verdict = evaluate(key, kinds)
    if (verdict === 'block') return callback(false)
    if (verdict === 'allow') return void grantWithOs(kinds).then(callback)
    const win = deps.windowFor(wc)
    if (!win) return callback(false)
    watch(wc)
    const p: Pending = {
      id: newId(),
      wc,
      win,
      origin,
      key,
      host: new URL(top).host,
      embeddedFrom: origin === top ? null : new URL(origin).host,
      kinds: verdict,
      callback,
      timer: null,
      done: false
    }
    byId.set(p.id, p)
    const q = queues.get(win.id) ?? []
    q.push(p)
    queues.set(win.id, q)
    // Start the clock now so a request that never reaches the front still times out.
    arm(p)
    pump(win)
  }

  /** `permissions.respond`. Only a request of the calling window can be answered. */
  function respond(windowId: number, requestId: string, decision: Decision, remember: boolean): boolean {
    const p = byId.get(requestId)
    if (!p || p.win.id !== windowId) return false
    if (decision === 'dismiss') {
      finish(p, false)
      return true
    }
    const allow = decision === 'allow'
    if (remember) for (const k of p.kinds) deps.store.set(p.key, k, allow ? 'allow' : 'block')
    if (!allow) {
      finish(p, false)
      return true
    }
    // Hold the request open (and the timer stopped) while the OS dialog is up, then resolve.
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    void grantWithOs(p.kinds).then((granted) => finish(p, granted))
    return true
  }

  async function grantWithOs(kinds: PermissionKind[]): Promise<boolean> {
    for (const k of kinds) {
      if (k !== 'camera' && k !== 'microphone') continue
      try {
        if (!(await deps.osAccess(k))) return false
      } catch (err) {
        logger.warn(`OS ${k} access check failed: ${String(err)}`)
        return false
      }
    }
    return true
  }

  /** Setting `permissionCheckHandler`: synchronous, answers only from the store. */
  function check(wc: WcLike | null, permission: string, requestingOrigin: string, details: CheckDetails): boolean {
    const origin = webOrigin(requestingOrigin) ?? webOrigin(details.requestingUrl)
    if (!origin) return false
    const wcTop = wc && !wc.isDestroyed() ? webOrigin(wc.getURL()) : undefined
    if (wcTop === null) return false
    if (SILENT_ALLOW.has(permission)) return true
    // Top-level origin: Electron's embeddingOrigin for subframe checks, else the tab's page, else the requester.
    const top = webOrigin(details.embeddingOrigin) ?? wcTop ?? origin
    const key = permissionKey(origin, top)
    const mt = details.mediaType
    const kinds =
      permission === 'media'
        ? promptedKinds('media', mt === 'video' ? ['video'] : mt === 'audio' ? ['audio'] : ['video', 'audio'])
        : promptedKinds(permission)
    if (kinds.length === 0) return false
    // For an unspecified media type (device enumeration) either remembered allow is enough; a named type needs its own.
    const allowed = kinds.map((k) => deps.store.get(key, k) === 'allow')
    return mt === 'video' || mt === 'audio' ? allowed.every(Boolean) : allowed.some(Boolean)
  }

  return { handleRequest, check, respond, cancelFor, cancelWindow, pending: (windowId: number) => queues.get(windowId)?.length ?? 0 }
}

type Controller = ReturnType<typeof createPermissionController>
const controllers = new WeakMap<ProfileContext['stores']['permissions'], Controller>()
let routerRegistered = false

async function osMediaAccess(kind: 'camera' | 'microphone'): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus(kind)
  if (status === 'granted') return true
  // denied/restricted cannot be re-asked: the user must flip it in System Settings. Deny gracefully.
  if (status === 'denied' || status === 'restricted') return false
  return systemPreferences.askForMediaAccess(kind)
}

// Our own trusted shell page reports where the prompt's arrow should point (D6): x = the centre of the omnibox
// security ICON (not the whole slot, whose "Not secure" text the arrow used to cover), y = 2px below the field.
// Plain numbers only.
const SECURITY_ICON_RECT = `(() => {
  const field = document.querySelector('.rn-omnibox')
  const icon = document.querySelector('.rn-omnibox__security .rn-icon') || document.querySelector('.rn-omnibox__security')
  if (!field || !icon) return null
  const f = field.getBoundingClientRect()
  const r = icon.getBoundingClientRect()
  return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(f.bottom + 2) } : null
})()`

/**
 * The overlay puts the prompt box's top-left at the anchor and draws its arrow (base/skin.css .rn-prompt__arrow:
 * left 20px, width 20px, height 10px) poking up from the top edge. Shift the box so the arrow's tip lands on the
 * measured point.
 */
const PROMPT_ARROW_CENTER_X = 30
const PROMPT_ARROW_HEIGHT = 10

/** Anchor for a measured arrow tip (exported for tests). */
export function anchorForArrowTip(tip: { x: number; y: number }): AnchorRect {
  return { x: Math.max(0, tip.x - PROMPT_ARROW_CENTER_X), y: tip.y + PROMPT_ARROW_HEIGHT, width: PROMPT_ARROW_CENTER_X * 2, height: 0 }
}

async function measureSecurityIcon(win: WindowLike): Promise<AnchorRect | null> {
  const shell = windowManager.get(win.id)?.shell
  if (!shell || shell.isDestroyed()) return null
  const r = (await shell.executeJavaScript(SECURITY_ICON_RECT)) as { x: number; y: number } | null
  const ok = r && [r.x, r.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000)
  return ok ? anchorForArrowTip(r) : null
}

function controllerFor(ctx: ProfileContext): Controller {
  const store = ctx.stores.permissions
  let c = controllers.get(store)
  if (!c) {
    c = createPermissionController({
      store,
      windowFor: (wc) => windowManager.fromWebContents(wc as unknown as WebContents),
      osAccess: osMediaAccess,
      securityAnchor: measureSecurityIcon
    })
    controllers.set(store, c)
    const created = c
    windowManager.onWindowClosed((w) => created.cancelWindow(w.id))
  }
  return c
}

function registerRouter(): void {
  if (routerRegistered) return
  routerRegistered = true
  router.handle('permissions.respond', (req, ctx) => {
    const win = windowManager.get(ctx.info.windowId)
    if (!win) return null
    // The request belongs to exactly one controller (its profile's); try the window's profile's.
    const c = controllers.get(win.profile.stores.permissions)
    c?.respond(win.id, req.requestId, req.decision, req.remember)
    return null
  })
}

/** Called by installSessionHooks() for each profile / incognito session. */
export function installPermissions(ses: Session, ctx: ProfileContext): void {
  const c = controllerFor(ctx)
  registerRouter()
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    c.handleRequest(wc as unknown as WcLike | null, permission, callback, details as RequestDetails)
  )
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    c.check(wc as unknown as WcLike | null, permission, requestingOrigin, details as CheckDetails)
  )
  // Never let a device chooser silently pick: no USB/HID/serial/bluetooth.
  ses.setDevicePermissionHandler(() => false)
}
