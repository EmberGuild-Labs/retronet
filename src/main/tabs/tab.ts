// One browser tab (PLAN T12): a WebContentsView in the window's profile session, with T10's guards attached
// before anything loads. Maps webContents events to TabState fields and to the status bar phases of
// DESIGN 3.4 (the strings must match exactly). The tab manager owns ordering, activation and the closed stack;
// a Tab only reports changes through its TabHost.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, WebContentsView, type MessageBoxSyncOptions, type NavigationEntry, type Session, type WebContents } from 'electron'
import { SESSION_HISTORY_MAX } from '../../shared/ipc-contract'
import { NEWTAB_URL } from '../../shared/settings'
import type { StatusEvent, TabState } from '../../shared/types'
import { securityStateFor } from '../../shared/url-safety'
import { rendererRoot } from '../app-paths'
import { router } from '../ipc/router'
import { logger } from '../logger'
import {
  CERTERROR_URL,
  getBlockedNavigation,
  isCertErrorCode,
  isCertOverridden,
  NETERROR_URL,
  retryNetError,
  showInterstitial
} from '../security/cert-errors'
import { requestExternal } from '../security/external-protocols'
import {
  attachNavigationGuards,
  decideBrowserNavigation,
  type OpenerHandoff,
  type PopupFeatures
} from '../security/navigation-guards'
import { tabWebPreferences } from '../security/web-prefs'
import type { WindowContext } from '../types'

// ---- Status strings (DESIGN 3.4; three ASCII periods) ----
export const STATUS_CONTACTING = 'Contacting host...'
export const STATUS_WAITING = 'Waiting for reply...'
export const STATUS_DONE = 'Document: Done.'
export const STATUS_INTERRUPTED = 'Transfer interrupted.'
export const statusTransferring = (host: string): string => `Transferring data from ${host}...`

/** Chromium net error code to the short reason of DESIGN 3.4 (`Error: <reason>.`). */
export function errorStatusFor(code: number): string {
  if (isCertErrorCode(code)) return 'Error: certificate problem.'
  switch (code) {
    case -105: // ERR_NAME_NOT_RESOLVED
    case -137: // ERR_NAME_RESOLUTION_FAILED
      return 'Error: host not found.'
    case -102: // ERR_CONNECTION_REFUSED
      return 'Error: connection refused.'
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return 'Error: connection timed out.'
    case -106: // ERR_INTERNET_DISCONNECTED
      return 'Error: you are offline.'
    case -100: // ERR_CONNECTION_CLOSED
    case -101: // ERR_CONNECTION_RESET
      return 'Error: connection reset.'
    case -324: // ERR_EMPTY_RESPONSE
      return 'Error: empty reply from host.'
    case -312: // ERR_UNSAFE_PORT (e.g. :1, :25): Chromium refuses these ports before connecting
      return 'Error: port not allowed.'
    default:
      return 'Error: the page could not be loaded.'
  }
}

const ERR_ABORTED = -3
/** A user-closed tab whose page neither unloads nor asks within this time is closed anyway (hung renderer). */
export const CLOSE_TIMEOUT_MS = 3000

export type UnloadReason = 'leave' | 'reload' | 'close'

/**
 * The native beforeunload confirm (browser-standard). The safe choice (stay) is both the default and the cancel
 * button, so Enter / Esc keep the page. Returns the options and the index of the "proceed" button.
 */
export function unloadPromptOptions(reason: UnloadReason): { options: MessageBoxSyncOptions; proceedId: number } {
  const reload = reason === 'reload'
  return {
    options: {
      type: 'warning',
      title: reload ? 'Reload site?' : 'Leave site?',
      message: reload ? 'Reload site?' : 'Leave site?',
      detail: 'Changes you made may not be saved.',
      buttons: reload ? ['Cancel', 'Reload'] : ['Stay', 'Leave'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    proceedId: 1
  }
}
const FAVICON_MAX_BYTES = 64 * 1024
const FAVICON_TIMEOUT_MS = 10_000
const FAVICON_CACHE_MAX = 20

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isInterstitialUrl(url: string): boolean {
  return url.startsWith(CERTERROR_URL) || url.startsWith(NETERROR_URL)
}

/** Zoom-store key: the web origin, or `retronet://<host>` for internal pages. Null when there is none. */
export function zoomOriginOf(url: string): string | null {
  const u = parse(url)
  if (!u) return null
  if (u.protocol === 'retronet:') return `retronet://${u.hostname}`
  return u.origin && u.origin !== 'null' ? u.origin : null
}

/** History records real pages only: never retronet:, about:, data: or interstitials. */
function isHistoryUrl(url: string): boolean {
  const p = parse(url)?.protocol
  return p === 'http:' || p === 'https:' || p === 'file:'
}

// Internal pages get the RetroNet mark as their favicon. Read from the bundle (never fetched through the tab
// session: T10's subresource guard refuses main-process retronet:// requests).
let logoDataUrl: string | null | undefined
function internalFavicon(): string | null {
  if (logoDataUrl === undefined) {
    try {
      const svg = readFileSync(join(rendererRoot(), 'img', 'logo-16.svg'))
      logoDataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`
    } catch {
      logoDataUrl = null
    }
  }
  return logoDataUrl
}

// ---- Favicon target policy (S2) ----

// Image types we turn into data: URLs; anything else is refused. SVG is allowed because the shell renders
// favicons only through <img src>, where SVG never runs script.
const FAVICON_MIME = /^image\/(png|x-icon|vnd\.microsoft\.icon|ico|gif|jpeg|jpg|webp|bmp|avif|svg\+xml)$/

/** Accept only the strict image MIME allowlist (parameters already stripped, lowercased). */
export function isFaviconMime(type: string): boolean {
  return FAVICON_MIME.test(type)
}

// Common two-label public suffixes, so "a.example.co.uk" and "b.example.co.uk" are one site but "x.co.uk" and
// "y.co.uk" are not. Without a full Public Suffix List this is conservative: unknown suffixes fall back to the
// last two labels, which can only make sites look *more* different from a ccTLD's point of view than they are
// for the common cases listed here.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'ne.jp',
  'or.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'co.in', 'co.za', 'com.sg', 'com.hk', 'com.tw',
  'github.io', 'gitlab.io', 'pages.dev', 'netlify.app', 'vercel.app', 'herokuapp.com', 'blogspot.com'
])

const stripBrackets = (h: string): string => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h)
const isIPv4 = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
const isIPv6 = (h: string): boolean => h.includes(':')

/** Loopback, private, link-local, CGNAT, unspecified and local-only names. `host` is a URL hostname. */
export function isPrivateHost(rawHost: string): boolean {
  const host = stripBrackets(rawHost.toLowerCase()).replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (isIPv4(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (isIPv6(host)) {
    if (host === '::' || host === '::1') return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
    if (mapped) return isPrivateHost(mapped[1]!)
    if (host.startsWith('::ffff:')) return true // hex-form mapped v4: treat as private rather than parse it
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  }
  return !host.includes('.') // single-label intranet names
}

/** Approximate registrable domain ("site"); IP literals are their own site. */
export function siteOf(rawHost: string): string {
  const host = stripBrackets(rawHost.toLowerCase()).replace(/\.$/, '')
  if (isIPv4(host) || isIPv6(host)) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/**
 * May this page's tab fetch this favicon URL? data:image/ is always fine (no request). Otherwise both must be
 * http(s), the icon must be same-site with the page, an https page only loads https icons, and a public page
 * never reaches a private/loopback host (S2). DNS answers are not checked (a public name resolving to a private
 * address is a known limitation; the request is still credential-less and its body is only read as an image).
 */
export function faviconAllowed(pageUrl: string, iconUrl: string): boolean {
  const page = parse(pageUrl)
  const icon = parse(iconUrl)
  if (!page || !icon) return false
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false
  if (icon.protocol !== 'http:' && icon.protocol !== 'https:') return false
  if (icon.username || icon.password) return false
  if (page.protocol === 'https:' && icon.protocol !== 'https:') return false
  if (isPrivateHost(icon.hostname) && !isPrivateHost(page.hostname)) return false
  return siteOf(icon.hostname) === siteOf(page.hostname)
}

/**
 * Favicon as a data: URL (the shell CSP allows no remote images). Fetched through the tab's own session with
 * no credentials and no redirects, strict image MIME allowlist, at most 64 KB, 10 s timeout. `signal` lets the
 * tab abort it when a newer icon or navigation supersedes it. Null on any problem.
 */
async function fetchFavicon(ses: Session, pageUrl: string, url: string, signal: AbortSignal): Promise<string | null> {
  if (url.startsWith('data:')) {
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(url) && url.length <= FAVICON_MAX_BYTES * 1.4 ? url : null
  }
  if (!faviconAllowed(pageUrl, url)) return null
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), FAVICON_TIMEOUT_MS)
  try {
    const res = await ses.fetch(url, { signal: abort.signal, credentials: 'omit', redirect: 'error' })
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (!res.ok || !isFaviconMime(type) || declared > FAVICON_MAX_BYTES || !res.body) {
      abort.abort()
      return null
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > FAVICON_MAX_BYTES) {
        abort.abort()
        return null
      }
      chunks.push(value)
    }
    if (size === 0) return null
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** What a tab needs from its manager. */
export interface TabHost {
  readonly window: WindowContext
  /** Something in TabState changed: push a (coalesced) snapshot. */
  changed(tab: Tab): void
  /** A main-frame navigation committed (new URL): a structural change, saved in the session. */
  committed(tab: Tab): void
  /** Status text or hover URL changed. */
  status(tab: Tab): void
  isActive(tab: Tab): boolean
  /** target=_blank / window.open from this tab (T10 guard callback). */
  openTab(from: Tab, url: string, opts: { background: boolean; handoff?: OpenerHandoff }): WebContents | undefined
  openPopup(from: Tab, opts: { url: string; features: PopupFeatures; handoff?: OpenerHandoff }): WebContents | undefined
  /** The page closed itself (window.close()), a user close went through, or its webContents went away. */
  gone(tab: Tab): void
  /** A user close was cancelled by the page's beforeunload ("Stay"). */
  closeCancelled(tab: Tab): void
  /** True when a closing tab's beforeunload should not ask (its window close was already cancelled): stay. */
  suppressUnloadPrompt(tab: Tab): boolean
}

export interface TabInit {
  id: number
  /** Adopt this webContents (window.open with an opener; already loading). */
  adopt?: WebContents
  pinned?: boolean
  groupId?: string | null
  openerId?: number | null
  muted?: boolean
}

export class Tab {
  readonly id: number
  readonly view: WebContentsView
  readonly wc: WebContents
  pinned: boolean
  groupId: string | null
  /** Tab that opened this one (link/window.open), for insertion order. */
  openerId: number | null

  private readonly host: TabHost
  private loading = false
  private audible = false
  private faviconDataUrl: string | null = null
  private faviconToken = 0
  /** The one in-flight favicon fetch of this tab (S2); aborted when superseded, on navigation and on close. */
  private faviconAbort: AbortController | null = null
  /** Favicons by page URL, so back/forward (which may not re-announce the icon) keeps showing it. */
  private readonly faviconCache = new Map<string, string>()
  private statusText = ''
  private statusError = false
  private statusAnnounce = false
  private hoverUrl: string | null = null
  /** The current main-frame load was started by the user (omnibox, reload, home): announce Done. */
  private userStarted = false
  private userStopped = false
  /** The current load failed; keep its error text through the interstitial load. */
  private failed = false
  /** The current main-frame navigation is to an interstitial (status keeps the error text). */
  private quiet = false
  private historyUrl: string | null = null
  private crashed = false
  private disposed = false
  /** A user close is waiting for the page's beforeunload. */
  private closing = false
  private closeTimer: NodeJS.Timeout | null = null
  /** reload() was called and its beforeunload (if any) has not been answered yet. */
  private reloadPending = false
  /** The address last asked for (load / restore), so a tab that has not committed yet can still be saved. */
  private pendingUrl: string | null = null

  constructor(host: TabHost, init: TabInit) {
    this.host = host
    this.id = init.id
    this.pinned = init.pinned ?? false
    this.groupId = init.groupId ?? null
    this.openerId = init.openerId ?? null
    const ses = host.window.profile.session
    // An adopted guest already has prefs inherited from its (hardened) opener; Electron ignores webPreferences
    // when `webContents` is given. Fresh views always get the factory prefs.
    this.view = init.adopt
      ? new WebContentsView({ webContents: init.adopt, webPreferences: tabWebPreferences({ session: ses }) })
      : new WebContentsView({ webPreferences: tabWebPreferences({ session: ses }) })
    this.wc = this.view.webContents
    if (init.muted) this.wc.setAudioMuted(true)
    router.registerSender(this.wc, { role: 'tab', windowId: host.window.id, tabId: this.id })
    // Guards first: before the first loadURL (or right away for an adopted, already-loading guest).
    attachNavigationGuards(this.wc, {
      kind: 'tab',
      getUrl: () => (this.wc.isDestroyed() ? '' : this.wc.getURL()),
      openTab: (url, opts) => host.openTab(this, url, opts),
      openPopup: (opts) => host.openPopup(this, opts),
      window: host.window.win,
      session: ses
    })
    this.wire()
  }

  // ---- Navigation ----

  /**
   * Browser-initiated navigation (omnibox, bookmark, home, command). Runs T10's decision first: 'external'
   * goes to the OS prompt, 'block' does nothing. Returns false when blocked.
   */
  load(url: string, opts: { typed?: boolean; user?: boolean } = {}): boolean {
    if (this.wc.isDestroyed()) return false
    const d = decideBrowserNavigation(url, { typed: opts.typed === true })
    if (d === 'block') return false
    if (d === 'external') {
      void requestExternal(url, this.host.window.win.isDestroyed() ? null : this.host.window.win)
      return true
    }
    this.userStarted = opts.user ?? true
    this.pendingUrl = url
    void this.wc.loadURL(url).catch(() => undefined) // failures arrive as did-fail-load
    return true
  }

  /** Reopen-closed: bring back the whole back/forward list. Falls back to loading the active entry. */
  restoreHistory(entries: NavigationEntry[], index: number): void {
    const ok = (e: NavigationEntry): boolean => decideBrowserNavigation(e.url, { typed: e.url.startsWith('file:') }) === 'allow'
    const safe = entries.filter(ok)
    if (safe.length === 0) {
      this.load(NEWTAB_URL, { user: false })
      return
    }
    const removedBefore = entries.slice(0, index).filter((e) => !ok(e)).length
    const at = Math.min(Math.max(0, index - removedBefore), safe.length - 1)
    this.pendingUrl = safe[at]!.url
    this.wc.navigationHistory.restore({ entries: safe, index: at }).catch(() => undefined)
  }

  back(): void {
    if (!this.wc.isDestroyed() && this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack()
  }

  forward(): void {
    if (!this.wc.isDestroyed() && this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward()
  }

  reload(ignoreCache = false): void {
    if (this.wc.isDestroyed()) return
    this.userStarted = true
    // Reload on a network error page means "try the failed address again".
    if (this.url().startsWith(NETERROR_URL) && retryNetError(this.wc)) return
    this.reloadPending = true
    if (ignoreCache) this.wc.reloadIgnoringCache()
    else this.wc.reload()
  }

  stop(): void {
    if (this.wc.isDestroyed()) return
    if (this.loading) this.userStopped = true
    this.wc.stop()
  }

  toggleMute(): void {
    if (this.wc.isDestroyed()) return
    this.wc.setAudioMuted(!this.wc.isAudioMuted())
    this.host.changed(this)
  }

  /** Re-read the zoom level (T16 changes it through the webContents). */
  zoomPercent(): number {
    return this.wc.isDestroyed() ? 100 : Math.round(this.wc.getZoomFactor() * 100)
  }

  // ---- State ----

  url(): string {
    return this.wc.isDestroyed() ? '' : this.wc.getURL()
  }

  /** What the omnibox shows: interstitials show the address the user was trying to reach. */
  displayUrl(): string {
    const url = this.url()
    if (isInterstitialUrl(url)) {
      const blocked = getBlockedNavigation(this.wc)
      if (blocked) return blocked.url
    }
    return url
  }

  title(): string {
    if (this.wc.isDestroyed()) return ''
    const t = this.wc.getTitle()
    // Chromium uses the URL as the title until the page sets one; show the host instead (DESIGN 3.3).
    if (!t || t === this.wc.getURL()) {
      const u = parse(this.displayUrl())
      return u?.host || t
    }
    return t
  }

  state(): TabState {
    const alive = !this.wc.isDestroyed()
    const url = this.displayUrl()
    const ses = this.host.window.profile.session
    const blocked = alive && isInterstitialUrl(this.url()) ? getBlockedNavigation(this.wc) : undefined
    // Q5: a load that failed (net error page, or the moment before it shows) never gets the padlock, whatever
    // the scheme of the address it was trying: neutral state, like other browsers's info icon on error pages.
    const security =
      blocked?.kind === 'cert'
        ? 'cert-warning'
        : blocked?.kind === 'net' || (alive && this.failed)
          ? 'internal'
          : securityStateFor(url || NEWTAB_URL, isCertOverridden(ses, url))
    let bookmarked = false
    try {
      bookmarked = url !== '' && this.host.window.profile.stores.bookmarks.isBookmarked(url)
    } catch {
      bookmarked = false
    }
    return {
      id: this.id,
      url,
      title: this.title(),
      faviconDataUrl: this.faviconDataUrl,
      loading: alive && this.loading,
      canGoBack: alive && this.wc.navigationHistory.canGoBack(),
      canGoForward: alive && this.wc.navigationHistory.canGoForward(),
      pinned: this.pinned,
      groupId: this.groupId,
      security,
      zoomPercent: this.zoomPercent(),
      bookmarked,
      audible: alive && this.audible,
      muted: alive && this.wc.isAudioMuted()
    }
  }

  statusEvent(): StatusEvent {
    return { tabId: this.id, text: this.statusText, error: this.statusError, hoverUrl: this.hoverUrl, announce: this.statusAnnounce }
  }

  /**
   * Data for the closed-tab stack. Interstitial entries are dropped like in sessionRecord (R12); an active
   * interstitial becomes the address it was blocking, so reopening tries that address again.
   */
  closedRecord(): { url: string; title: string; entries: NavigationEntry[]; index: number; muted: boolean } {
    const h = this.wc.navigationHistory
    const url = this.displayUrl()
    const title = this.title()
    const all = h.getAllEntries()
    const active = h.getActiveIndex()
    const entries: NavigationEntry[] = []
    let index = -1
    all.forEach((e, i) => {
      if (i === active) {
        index = entries.length
        if (isInterstitialUrl(e.url)) {
          if (url && !isInterstitialUrl(url)) entries.push({ url, title })
          else index = Math.max(0, entries.length - 1)
          return
        }
      }
      if (isInterstitialUrl(e.url)) return
      entries.push({ url: e.url, title: e.title, ...(e.pageState ? { pageState: e.pageState } : {}) })
    })
    return {
      url,
      title,
      entries,
      index: entries.length === 0 ? 0 : Math.min(Math.max(index, 0), entries.length - 1),
      muted: this.wc.isAudioMuted()
    }
  }

  /**
   * Data for session.json: the address (the one being loaded if nothing has committed yet) and the back/forward
   * list without interstitials or page state, at most SESSION_HISTORY_MAX entries around the active one. The
   * list is left out when there is nothing to go back or forward to, or when the active entry is an interstitial.
   */
  sessionRecord(): { url: string; title: string; history?: { entries: Array<{ url: string; title: string }>; index: number } } {
    const url = this.displayUrl() || this.pendingUrl || ''
    const title = this.title()
    if (this.wc.isDestroyed()) return { url, title }
    const h = this.wc.navigationHistory
    const all = h.getAllEntries()
    const active = h.getActiveIndex()
    if (all.length < 2 || active < 0 || active >= all.length || isInterstitialUrl(all[active]!.url)) return { url, title }
    const keep = (e: NavigationEntry): boolean => e.url !== '' && e.url.length <= 8192 && !isInterstitialUrl(e.url)
    const entries = all.filter(keep).map((e) => ({ url: e.url, title: e.title.slice(0, 1024) }))
    let index = active - all.slice(0, active).filter((e) => !keep(e)).length
    if (entries.length < 2) return { url, title }
    let start = 0
    if (entries.length > SESSION_HISTORY_MAX) {
      start = Math.min(Math.max(0, index - (SESSION_HISTORY_MAX >> 1)), entries.length - SESSION_HISTORY_MAX)
      index -= start
    }
    return { url, title, history: { entries: entries.slice(start, start + SESSION_HISTORY_MAX), index } }
  }

  focus(): void {
    if (!this.wc.isDestroyed()) this.wc.focus()
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.closing = false
    this.clearCloseTimer()
    this.abortFavicon()
    if (!this.wc.isDestroyed()) this.wc.close()
  }

  /**
   * A user close (Cmd+W, the tab's x, close others...): run the page's beforeunload first, like other browsers. Returns
   * false when the tab must simply be closed now (crashed, or already gone); otherwise the close completes
   * through TabHost.gone() or is cancelled through TabHost.closeCancelled() ("Stay").
   */
  requestClose(): boolean {
    if (this.disposed || this.wc.isDestroyed() || this.crashed) return false
    if (this.closing) return true
    this.closing = true
    this.wc.close({ waitForBeforeUnload: true })
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      if (this.closing && !this.disposed) {
        logger.warn(`tab ${this.id} did not unload in ${CLOSE_TIMEOUT_MS} ms; closing it`)
        this.close()
        this.host.gone(this)
      }
    }, CLOSE_TIMEOUT_MS)
    return true
  }

  get isClosing(): boolean {
    return this.closing
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // ---- Event wiring ----

  private abortFavicon(): void {
    this.faviconAbort?.abort()
    this.faviconAbort = null
  }

  private setStatus(text: string, opts: { error?: boolean; announce?: boolean } = {}): void {
    this.statusText = text
    this.statusError = opts.error ?? false
    this.statusAnnounce = opts.announce ?? false
    this.host.status(this)
  }

  private wire(): void {
    const wc = this.wc
    const changed = (): void => this.host.changed(this)

    wc.on('did-start-loading', () => {
      this.loading = true
      changed()
    })

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      this.reloadPending = false
      this.quiet = isInterstitialUrl(details.url)
      if (this.quiet) return
      this.failed = false
      this.crashed = false
      this.setStatus(STATUS_CONTACTING)
    })

    wc.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame && !this.quiet && !details.isSameDocument) this.setStatus(STATUS_CONTACTING)
    })

    wc.on('did-navigate', (_e, url) => {
      this.onCommit(url, false)
      if (!this.quiet && !this.failed) this.setStatus(STATUS_WAITING)
      this.host.committed(this)
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      this.onCommit(url, true)
      this.host.committed(this)
    })

    wc.on('dom-ready', () => {
      if (this.quiet || this.failed) return
      const host = parse(wc.getURL())?.host
      if (host) this.setStatus(statusTransferring(host))
    })

    wc.on('did-fail-load', (_e, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      if (code === ERR_ABORTED) {
        // A newer navigation replaced this one, or the user pressed Stop (did-stop-loading shows the text).
        return
      }
      if (isInterstitialUrl(validatedUrl)) return
      this.failed = true
      this.setStatus(errorStatusFor(code), { error: true, announce: true })
      // Cert errors are turned into the certerror interstitial by T10's cert-errors.ts.
      if (isCertErrorCode(code)) return
      if (parse(validatedUrl)?.protocol === 'retronet:') return
      showInterstitial(wc, { kind: 'net', url: validatedUrl, code: description || String(code) })
    })

    wc.on('did-stop-loading', () => {
      this.loading = false
      if (!this.quiet && !this.failed && !this.crashed) {
        if (this.userStopped) this.setStatus(STATUS_INTERRUPTED)
        else if (wc.getURL() === NEWTAB_URL) this.setStatus('') // DESIGN 3.4: idle new tab is empty
        else this.setStatus(STATUS_DONE, { announce: this.userStarted })
      }
      this.userStarted = false
      this.userStopped = false
      changed()
    })

    wc.on('page-title-updated', (_e, title) => {
      if (this.historyUrl && this.historyUrl === wc.getURL() && title) {
        try {
          this.host.window.profile.stores.history.updateTitle(this.historyUrl, title)
        } catch (err) {
          logger.warn('history title update failed', err)
        }
      }
      changed()
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      const pageUrl = wc.getURL()
      if (parse(pageUrl)?.protocol === 'retronet:') return
      const candidate = favicons.find((f) => /^data:image\//i.test(f) || faviconAllowed(pageUrl, f))
      if (!candidate) return
      const token = ++this.faviconToken
      this.abortFavicon()
      const abort = new AbortController()
      this.faviconAbort = abort
      void fetchFavicon(wc.session, pageUrl, candidate, abort.signal).then((data) => {
        if (this.faviconAbort === abort) this.faviconAbort = null
        if (token !== this.faviconToken || wc.isDestroyed() || wc.getURL() !== pageUrl) return
        this.faviconDataUrl = data
        if (data) {
          this.faviconCache.delete(pageUrl)
          this.faviconCache.set(pageUrl, data)
          if (this.faviconCache.size > FAVICON_CACHE_MAX) this.faviconCache.delete(this.faviconCache.keys().next().value as string)
        }
        changed()
      })
    })

    // The page's onbeforeunload asked to stay. Without a handler Electron silently cancels the navigation /
    // reload / close; ask the user instead (default: stay). preventDefault() = ignore the page and proceed.
    wc.on('will-prevent-unload', (e) => {
      const reason: UnloadReason = this.closing ? 'close' : this.reloadPending ? 'reload' : 'leave'
      this.reloadPending = false
      if (this.closing && this.host.suppressUnloadPrompt(this)) {
        // Another tab's "Stay" already cancelled this window close: stay without asking again.
        this.closing = false
        this.clearCloseTimer()
        this.host.closeCancelled(this)
        return
      }
      const { options, proceedId } = unloadPromptOptions(reason)
      const win = this.host.window.win
      // Suspend the hung-renderer fallback while the user decides.
      this.clearCloseTimer()
      const choice = win.isDestroyed() ? dialog.showMessageBoxSync(options) : dialog.showMessageBoxSync(win, options)
      if (choice === proceedId) {
        e.preventDefault()
        return
      }
      if (this.closing) {
        this.closing = false
        this.host.closeCancelled(this)
      }
    })

    wc.on('update-target-url', (_e, url) => {
      const next = url ? url : null
      if (next === this.hoverUrl) return
      this.hoverUrl = next
      this.host.status(this)
    })

    wc.on('audio-state-changed', (e) => {
      this.audible = e.audible
      changed()
    })

    wc.on('enter-html-full-screen', () => {
      if (this.host.isActive(this)) this.host.window.setHtmlFullscreen(true)
    })
    wc.on('leave-html-full-screen', () => {
      if (this.host.isActive(this)) this.host.window.setHtmlFullscreen(false)
    })

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      logger.warn(`tab ${this.id} renderer gone: ${details.reason}`)
      this.crashed = true
      this.loading = false
      this.setStatus('Error: the page crashed.', { error: true, announce: true })
      changed()
    })

    // window.close() from the page. Electron emits 'close' on the webContents (not in the typings).
    ;(wc as unknown as NodeJS.EventEmitter).on('close', () => this.host.gone(this))
    wc.once('destroyed', () => {
      this.abortFavicon()
      this.clearCloseTimer()
      if (!this.disposed) {
        this.disposed = true
        this.host.gone(this)
      }
    })
  }

  /** Main-frame commit: favicon, history, per-origin zoom. */
  private onCommit(url: string, sameDocument: boolean): void {
    const profile = this.host.window.profile
    const prevHistoryUrl = this.historyUrl
    if (!sameDocument) {
      this.faviconToken++
      this.abortFavicon()
      this.faviconDataUrl = parse(url)?.protocol === 'retronet:' ? internalFavicon() : (this.faviconCache.get(url) ?? null)
      const origin = zoomOriginOf(url)
      if (origin) {
        try {
          this.wc.setZoomLevel(profile.stores.zoom.get(origin))
        } catch (err) {
          logger.warn('zoom restore failed', err)
        }
      }
    }
    if (profile.incognito || !isHistoryUrl(url)) {
      if (!sameDocument) this.historyUrl = null
      return
    }
    // In-page navigations (pushState, #hash) count as a visit only when more than the fragment changed.
    if (sameDocument && prevHistoryUrl && prevHistoryUrl.split('#')[0] === url.split('#')[0]) return
    try {
      const title = this.wc.getTitle()
      profile.stores.history.recordVisit(url, title && title !== url ? title : '')
      this.historyUrl = url
    } catch (err) {
      logger.warn('history record failed', err)
    }
  }
}
