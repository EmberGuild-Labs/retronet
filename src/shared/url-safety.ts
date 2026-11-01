// URL safety helpers shared by main (navigation guards) and the shell (security indicator).
// No Electron or Node imports: this file must run in the renderer too.

export type SecurityState = 'secure' | 'insecure' | 'cert-warning' | 'internal' | 'file'

/** Schemes that may be loaded as a top-level page (retronet: and file: have extra conditions). */
const WEB_SCHEMES = new Set(['http:', 'https:'])
/** Schemes that may be handed to the OS, and only after a user prompt (AC38). */
const EXTERNAL_ALLOWLIST = new Set(['mailto:', 'tel:', 'sms:'])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const VIEW_SOURCE = 'view-source:'

/**
 * The page a `view-source:` URL shows (the text after the scheme), or null when `url` is not a view-source: URL.
 * The scheme is matched through the URL parser, so `VIEW-SOURCE:` counts too. The inner URL is not validated here.
 */
export function viewSourceInner(url: string): string | null {
  const u = parse(url)
  return u?.protocol === VIEW_SOURCE ? u.href.slice(VIEW_SOURCE.length) : null
}

/** True when `url` is `view-source:` around an http(s) URL: the only source view RetroNet allows (AC54). */
export function isWebViewSource(url: string): boolean {
  const inner = viewSourceInner(url)
  // The inner URL must start with its scheme: no leading spaces or controls for the parser to quietly drop.
  const i = inner === null || !/^[a-z]/i.test(inner) ? null : parse(inner)
  return i !== null && WEB_SCHEMES.has(i.protocol)
}

export interface NavigationContext {
  /** URL of the page that is navigating, if any (page-initiated navigations). */
  currentUrl?: string
  /** Omnibox, bookmark, command or loadURL, as opposed to a page link or script. */
  browserInitiated?: boolean
  /** The user typed this URL into the omnibox (required for file:). */
  typed?: boolean
}

/**
 * Whether a top-level navigation to `url` is allowed (PLAN 1.7).
 * http(s) and about:blank always; retronet: only from a retronet: page or when browser-initiated;
 * file: only when browser-initiated and typed; view-source: only when browser-initiated and around an http(s)
 * URL (never file:, retronet:, nested view-source:, ...; pages can never open a source view).
 * Everything else (javascript:, data:, blob:, ...) is false.
 */
export function navigationSchemeAllowed(url: string, ctx: NavigationContext = {}): boolean {
  const u = parse(url)
  if (!u) return false
  if (WEB_SCHEMES.has(u.protocol)) return true
  if (u.protocol === 'about:') return url.trim().toLowerCase() === 'about:blank'
  if (u.protocol === 'retronet:') {
    if (ctx.browserInitiated) return true
    const cur = ctx.currentUrl ? parse(ctx.currentUrl) : null
    return cur?.protocol === 'retronet:'
  }
  if (u.protocol === 'file:') return ctx.browserInitiated === true && ctx.typed === true
  if (u.protocol === VIEW_SOURCE) return ctx.browserInitiated === true && isWebViewSource(url)
  return false
}

/** True for schemes that may be passed to shell.openExternal after a prompt. */
export function isExternalAllowlisted(url: string): boolean {
  const u = parse(url)
  return u !== null && EXTERNAL_ALLOWLIST.has(u.protocol)
}

/**
 * Omnibox security indicator state (AC37). A cert override for an https host shows cert-warning.
 * A source view has the state of the page it shows (AC54); any other view-source: is insecure.
 */
export function securityStateFor(url: string, certOverride = false): SecurityState {
  const u = parse(url)
  if (!u) return 'insecure'
  if (u.protocol === VIEW_SOURCE) return isWebViewSource(url) ? securityStateFor(viewSourceInner(url)!, certOverride) : 'insecure'
  switch (u.protocol) {
    case 'https:':
      return certOverride ? 'cert-warning' : 'secure'
    case 'retronet:':
      return 'internal'
    case 'about:':
      return 'internal'
    case 'file:':
      return 'file'
    default:
      return 'insecure'
  }
}

export interface UrlDisplayParts {
  /** e.g. "https" (no colon). */
  scheme: string
  /** The host exactly as the engine will connect to it: always ASCII/punycode, never decoded. */
  host: string
  /** Host with port when non-default. */
  hostPort: string
  /** Everything after the authority: path, query and hash. */
  rest: string
  /** True when any label is punycode (xn--): the host is an internationalised name. */
  isIdn: boolean
  /**
   * True when the URL carries user@ or user:pass@ (a classic spoofing trick: "google.com@evil.example").
   * Displays strip it (see displayUrl), so the real host is what the user reads and no password is shown.
   */
  hasCredentials: boolean
  /** Should the UI de-emphasise scheme and rest and highlight only `host`. */
  emphasizeHost: boolean
}

/**
 * Splits a URL for display so that the real host stands out. IDN hosts are shown in punycode
 * (xn--) so look-alike unicode names cannot impersonate another site.
 */
export function displayPartsFor(url: string): UrlDisplayParts | null {
  const u = parse(url)
  if (!u) return null
  const web = WEB_SCHEMES.has(u.protocol)
  const host = u.hostname
  const rest = (u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname) + u.search + u.hash
  return {
    scheme: u.protocol.replace(/:$/, ''),
    host,
    hostPort: u.host,
    rest: web || u.protocol === 'retronet:' ? rest : u.pathname + u.search + u.hash,
    isIdn: host.split('.').some((l) => l.toLowerCase().startsWith('xn--')),
    hasCredentials: u.username !== '' || u.password !== '',
    emphasizeHost: web
  }
}

/**
 * The URL as the omnibox shows it: userinfo removed (as major browsers do), so "http://google.com@evil.example/"
 * reads as evil.example and "user:pass@" never reaches the screen or the input's value. Other URLs are returned
 * unchanged (no re-serialisation), so the text matches what the engine reports.
 */
export function displayUrl(url: string): string {
  const u = parse(url)
  // `new URL('view-source:http://u:p@h/')` has an empty username (the userinfo sits in the opaque path), so the
  // inner URL is stripped on its own and the wrapper put back (AC73).
  if (u?.protocol === VIEW_SOURCE) {
    const inner = viewSourceInner(url)!
    const stripped = displayUrl(inner)
    return stripped === inner ? url : `${VIEW_SOURCE}${stripped}`
  }
  if (!u || (u.username === '' && u.password === '')) return url
  u.username = ''
  u.password = ''
  return u.href
}

export interface OmniboxSegments {
  /** displayUrl(url): the full text the field shows (and its accessible value). */
  text: string
  /** Scheme and "//" (dimmed). */
  before: string
  /** The registrable host the user must check (emphasised). */
  host: string
  /** Port, path, query, hash (dimmed). */
  after: string
}

/**
 * Splits the displayed URL so the host can be emphasised and the rest dimmed (DESIGN 3.2, like modern browsers).
 * Null when nothing should be emphasised (non-web schemes, unparsable text): show the text plainly.
 */
export function omniboxSegments(url: string): OmniboxSegments | null {
  const text = displayUrl(url)
  const parts = displayPartsFor(text)
  if (!parts || !parts.emphasizeHost || !parts.host) return null
  const before = `${parts.scheme}://`
  if (!text.toLowerCase().startsWith(before) || text.slice(before.length, before.length + parts.host.length).toLowerCase() !== parts.host.toLowerCase()) {
    return null
  }
  return { text, before: text.slice(0, before.length), host: text.slice(before.length, before.length + parts.host.length), after: text.slice(before.length + parts.host.length) }
}
