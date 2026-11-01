// Navigation hardening for every webContents (AC8, AC36, AC37, AC38, PLAN 1.7).
// The decide* functions are pure and unit-tested; attachNavigationGuards and installSubresourceGuard wire them
// to Electron. T12 calls attachNavigationGuards for each tab/popup and T7 for the shell and overlay.
import type {
  BaseWindow,
  HandlerDetails,
  OnBeforeRequestListenerDetails,
  Session,
  WebContents,
  WindowOpenHandlerResponse
} from 'electron'
import { navigationSchemeAllowed } from '@shared/url-safety'
import { UI_ONLY_HOSTS, type InternalHost } from '../protocol/retronet-protocol'
import { requestExternal } from './external-protocols'

// ---------------------------------------------------------------------------------------------------------------
// Types

/** Size and position asked for by `window.open(url, name, 'width=..,height=..')`, already clamped. */
export interface PopupFeatures {
  width?: number
  height?: number
  left?: number
  top?: number
}

/**
 * Hand-off from Electron's window-open handler. When `webContents` is set, the new tab/popup MUST adopt it
 * (`new WebContentsView({ webContents, webPreferences: <factory prefs> })`) and return it, so `window.opener`
 * works; it already has the URL loading. When it is absent (noopener), build a fresh view and load `url`.
 * Nothing else from the page's options is passed on, so a page can never influence webPreferences.
 */
export interface OpenerHandoff {
  webContents?: WebContents
}

/** What the guards need from whoever owns the webContents (shape agreed in PLAN T10). */
export interface GuardContext {
  /** 'tab' = a browser tab or popup showing web content; 'ui' = the shell or overlay. */
  kind: 'tab' | 'ui'
  /** The URL currently committed in this webContents. */
  getUrl(): string
  /** Open `url` in a new tab of `window`. With `handoff.webContents`, adopt that webContents and return it. */
  openTab(url: string, opts: { background: boolean; handoff?: OpenerHandoff }): WebContents | undefined
  /** Open a minimal popup window (D4). Same adoption rule as openTab. */
  openPopup(opts: { url: string; features: PopupFeatures; handoff?: OpenerHandoff }): WebContents | undefined
  /** The RetroNet window this webContents lives in (parent of the external-protocol prompt). */
  window: BaseWindow
  session: Session
}

export type NavDecision = 'allow' | 'external' | 'block'

export type WindowOpenDecision =
  | { action: 'deny' }
  | { action: 'external' }
  /** `withOpener`: let Electron create the webContents so `window.opener` works. Otherwise open it ourselves. */
  | { action: 'tab'; background: boolean; withOpener: boolean }
  | { action: 'popup'; features: PopupFeatures }

// ---------------------------------------------------------------------------------------------------------------
// Pure decisions

function parse(url: string | undefined | null): URL | null {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isRetronet(url: string | undefined | null): boolean {
  return parse(url)?.protocol === 'retronet:'
}

function isUiOnlyHost(u: URL): boolean {
  return u.protocol === 'retronet:' && (UI_ONLY_HOSTS as readonly string[]).includes(u.hostname.toLowerCase() as InternalHost)
}

/** Schemes we can hand to another app after a prompt. Everything else that is not navigable is blocked. */
function isExternalScheme(u: URL): boolean {
  return u.protocol === 'mailto:' || u.protocol === 'tel:' || u.protocol === 'sms:'
}

/**
 * A navigation the user started (omnibox, bookmark, command, history entry, home). T12 calls this before every
 * `loadURL` on a tab. `typed` comes from `classifyInput(...).typedFile` and is the only way to reach `file:`.
 * Tabs can never load the shell or overlay hosts.
 */
export function decideBrowserNavigation(url: string, opts: { typed?: boolean } = {}): NavDecision {
  const u = parse(url)
  if (!u) return 'block'
  if (isUiOnlyHost(u)) return 'block'
  if (navigationSchemeAllowed(url, { browserInitiated: true, typed: opts.typed === true })) return 'allow'
  return isExternalScheme(u) ? 'external' : 'block'
}

/**
 * A main-frame navigation started by page content (`will-navigate`: links, `location=`, forms).
 * retronet: targets need the current page AND the initiating frame (when known) to be retronet: pages, so an
 * http iframe inside an internal page could not do it either. file: and javascript: are never allowed here.
 */
export function decidePageNavigation(
  url: string,
  ctx: { kind: 'tab' | 'ui'; currentUrl: string; initiatorUrl?: string | null }
): NavDecision {
  if (ctx.kind === 'ui') return 'block'
  const u = parse(url)
  if (!u) return 'block'
  if (u.protocol === 'retronet:') {
    if (isUiOnlyHost(u)) return 'block'
    const initiatorOk = ctx.initiatorUrl == null || isRetronet(ctx.initiatorUrl)
    return isRetronet(ctx.currentUrl) && initiatorOk ? 'allow' : 'block'
  }
  if (navigationSchemeAllowed(url, { currentUrl: ctx.currentUrl })) return 'allow'
  return isExternalScheme(u) ? 'external' : 'block'
}

/** Schemes a subframe may load besides retronet: (which needs a retronet: parent). */
const SUBFRAME_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:'])

/**
 * A subframe navigation (`will-frame-navigate` with isMainFrame false). Iframes may load ordinary web content,
 * about:blank/srcdoc, data: and blob:, but never file:, external schemes or unknown schemes, and retronet:
 * only inside a retronet: parent (internal pages have no iframes, so in practice never).
 */
export function decideFrameNavigation(url: string, parentUrl: string | null | undefined): boolean {
  const u = parse(url)
  if (!u) return false
  if (u.protocol === 'retronet:') return !isUiOnlyHost(u) && isRetronet(parentUrl)
  return SUBFRAME_SCHEMES.has(u.protocol)
}

/** Server redirects (`will-redirect`, any frame) may only go to http(s). Blocks retronet:, file:, javascript:... */
export function decideRedirect(url: string): boolean {
  const p = parse(url)?.protocol
  return p === 'http:' || p === 'https:'
}

const FEATURE_LIMITS = { min: 100, max: 10000 }

/** Parse the `features` string of window.open into clamped popup geometry. Unknown keys are ignored. */
export function parsePopupFeatures(features: string): PopupFeatures {
  const out: PopupFeatures = {}
  for (const part of features.split(/[,;]/)) {
    const [rawKey, rawVal] = part.split('=', 2)
    const key = rawKey?.trim().toLowerCase()
    const n = Number.parseInt(rawVal?.trim() ?? '', 10)
    if (!key || !Number.isFinite(n)) continue
    if (key === 'width' || key === 'innerwidth') out.width = clamp(n, FEATURE_LIMITS.min, FEATURE_LIMITS.max)
    else if (key === 'height' || key === 'innerheight') out.height = clamp(n, FEATURE_LIMITS.min, FEATURE_LIMITS.max)
    else if (key === 'left' || key === 'screenx') out.left = clamp(n, -FEATURE_LIMITS.max, FEATURE_LIMITS.max)
    else if (key === 'top' || key === 'screeny') out.top = clamp(n, -FEATURE_LIMITS.max, FEATURE_LIMITS.max)
  }
  return out
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** True when window.open asked for a real popup: a `new-window` disposition with any features. */
function wantsPopup(details: Pick<HandlerDetails, 'disposition' | 'features'>): boolean {
  return details.disposition === 'new-window' && details.features.trim() !== ''
}

/**
 * window.open / target=_blank policy (PLAN 1.7, D4). The shell and overlay never open windows. Web pages may
 * open http(s) and about:blank, as a popup when they pass features, else as a tab (background for
 * background-tab). retronet: targets only from retronet: pages, as a plain tab without an opener. Anything a
 * retronet: page opens is a plain tab without an opener (S10).
 * mailto:/tel:/sms: go to the external prompt; everything else (file:, javascript:, data:, unknown) is denied.
 */
export function decideWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'disposition' | 'features'>,
  ctx: { kind: 'tab' | 'ui'; openerUrl: string }
): WindowOpenDecision {
  if (ctx.kind === 'ui') return { action: 'deny' }
  const u = parse(details.url)
  if (!u) return { action: 'deny' }
  const background = details.disposition === 'background-tab'
  if (u.protocol === 'retronet:') {
    return !isUiOnlyHost(u) && isRetronet(ctx.openerUrl)
      ? { action: 'tab', background, withOpener: false }
      : { action: 'deny' }
  }
  if (isExternalScheme(u)) return { action: 'external' }
  if (!navigationSchemeAllowed(details.url, { currentUrl: ctx.openerUrl })) return { action: 'deny' }
  // S10: a web page opened from an internal page never gets window.opener (no reverse tabnabbing of
  // retronet:// pages, which hold the privileged bridge). Always a plain tab, even when features were passed.
  if (isRetronet(ctx.openerUrl)) return { action: 'tab', background, withOpener: false }
  if (wantsPopup(details)) return { action: 'popup', features: parsePopupFeatures(details.features) }
  return { action: 'tab', background, withOpener: true }
}

/**
 * Subresource rule for retronet:// requests on tab sessions (closes the T5 `<img src=retronet://...>` finding).
 * Main-frame loads are left to the navigation guards. Subframes are always refused. Anything else (images,
 * scripts, styles, fonts, fetch, ...) is allowed only when it comes from a retronet: document, judged by
 * the request's initiator origin, else the requesting frame's URL, else the webContents URL. A request with
 * none of these (a web page's service worker, or main-process `ses.fetch`) is refused.
 */
export function decideRetronetSubresource(d: {
  resourceType: string
  initiatorOrigin?: string | null
  frameUrl?: string | null
  webContentsUrl?: string | null
}): boolean {
  if (d.resourceType === 'mainFrame') return true
  if (d.resourceType === 'subFrame') return false
  if (d.initiatorOrigin) return d.initiatorOrigin.startsWith('retronet://')
  if (d.frameUrl) return isRetronet(d.frameUrl)
  if (d.webContentsUrl) return isRetronet(d.webContentsUrl)
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Electron wiring

/** Optional log sink; T7 can point it at main/logger.ts. Receives no page contents, only the blocked URL kind. */
let onGuardBlock: (what: string, url: string) => void = () => {}
export function setGuardBlockLogger(fn: (what: string, url: string) => void): void {
  onGuardBlock = fn
}

/** Trim a URL for the log: scheme + host only, never paths or queries. */
function logUrl(url: string): string {
  const u = parse(url)
  return u ? `${u.protocol}//${u.host}` : '<invalid>'
}

function openExternalFrom(ctx: GuardContext, url: string): void {
  void requestExternal(url, ctx.window.isDestroyed() ? null : ctx.window)
}

/**
 * Attach every navigation guard to one webContents: will-navigate, will-frame-navigate (subframes),
 * will-redirect, the window-open handler and will-attach-webview. Call once per webContents, right after
 * creating it and before its first loadURL (tabs, popups, shell, overlay).
 */
export function attachNavigationGuards(wc: WebContents, ctx: GuardContext): void {
  wc.on('will-navigate', (e) => {
    const d = decidePageNavigation(e.url, {
      kind: ctx.kind,
      currentUrl: ctx.getUrl(),
      initiatorUrl: e.initiator ? e.initiator.url : null
    })
    if (d === 'allow') return
    e.preventDefault()
    if (d === 'external') openExternalFrom(ctx, e.url)
    else onGuardBlock('will-navigate', logUrl(e.url))
  })

  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return // handled by will-navigate
    if (ctx.kind === 'ui' || !decideFrameNavigation(e.url, e.frame?.parent?.url ?? null)) {
      e.preventDefault()
      onGuardBlock('will-frame-navigate', logUrl(e.url))
    }
  })

  wc.on('will-redirect', (e) => {
    if (decideRedirect(e.url)) return
    e.preventDefault()
    onGuardBlock('will-redirect', logUrl(e.url))
  })

  wc.on('will-attach-webview', (e) => {
    e.preventDefault()
    onGuardBlock('will-attach-webview', '')
  })

  wc.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const d = decideWindowOpen(details, { kind: ctx.kind, openerUrl: ctx.getUrl() })
    switch (d.action) {
      case 'external':
        openExternalFrom(ctx, details.url)
        return { action: 'deny' }
      case 'tab':
        if (!d.withOpener) {
          ctx.openTab(details.url, { background: d.background })
          return { action: 'deny' }
        }
        return {
          action: 'allow',
          createWindow: (options) =>
            mustReturn(ctx.openTab(details.url, { background: d.background, handoff: handoffFrom(options) }))
        }
      case 'popup':
        return {
          action: 'allow',
          createWindow: (options) =>
            mustReturn(ctx.openPopup({ url: details.url, features: d.features, handoff: handoffFrom(options) }))
        }
      default:
        onGuardBlock('window-open', logUrl(details.url))
        return { action: 'deny' }
    }
  })
}

/** Only the guest webContents crosses over; the page-influenced window options are dropped on purpose. */
function handoffFrom(options: unknown): OpenerHandoff {
  const wc = (options as { webContents?: WebContents } | null)?.webContents
  return wc ? { webContents: wc } : {}
}

function mustReturn(wc: WebContents | undefined): WebContents {
  if (!wc) throw new Error('window-open: tab owner did not create a webContents')
  return wc
}

const subresourceGuarded = new WeakSet<Session>()

/**
 * Refuse retronet:// subresources requested by non-retronet documents (see decideRetronetSubresource).
 * Install on every profile and incognito session, and on the default session too (harmless there).
 * Verified on Electron 45.2.1: session.webRequest does see protocol.handle'd custom-scheme requests.
 * NOTE: Electron allows ONE onBeforeRequest listener per session; this module owns it. Anyone else who needs
 * onBeforeRequest must extend this function instead of registering their own (it would replace this one).
 */
export function installSubresourceGuard(ses: Session): void {
  if (subresourceGuarded.has(ses)) return
  subresourceGuarded.add(ses)
  ses.webRequest.onBeforeRequest({ urls: ['retronet://*/*'] }, (d: OnBeforeRequestListenerDetails, cb) => {
    let frameUrl: string | null = null
    let webContentsUrl: string | null = null
    try {
      frameUrl = d.frame?.url ?? null
    } catch {
      frameUrl = null // frame already gone
    }
    try {
      webContentsUrl = d.webContents && !d.webContents.isDestroyed() ? d.webContents.getURL() : null
    } catch {
      webContentsUrl = null
    }
    const ok = decideRetronetSubresource({
      resourceType: d.resourceType,
      initiatorOrigin: d.initiatorOrigin ?? null,
      frameUrl,
      webContentsUrl
    })
    if (!ok) onGuardBlock('retronet-subresource', logUrl(d.url))
    cb(ok ? {} : { cancel: true })
  })
}
