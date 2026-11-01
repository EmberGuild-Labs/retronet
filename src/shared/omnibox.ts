// Address-bar input classification (AC3, AC37). Pure, no Electron or Node imports.

/**
 * Local copy of the search-engine shape; T2's search-engines.ts may re-export or supersede it.
 * `template` holds one placeholder: `{searchTerms}`, `{q}` or `%s`.
 */
export interface SearchEngine {
  id: string
  template: string
}

/**
 * Longest omnibox input sent to main (tabs.navigate's contract cap, ipc-contract.ts). Longer text gets an inline
 * "Address too long" error in the shell rather than being cut off (Q7). Pages may still open longer URLs.
 */
export const OMNIBOX_INPUT_MAX = 8192

export const DEFAULT_SEARCH_ENGINE: SearchEngine = {
  id: 'duckduckgo',
  template: 'https://duckduckgo.com/?q={searchTerms}'
}

export type OmniboxResult =
  | { kind: 'url'; url: string; typedFile?: boolean }
  | { kind: 'search'; url: string }
  | { kind: 'blocked'; url: ''; reason: 'empty' | 'dangerous-scheme' | 'unsupported-scheme' | 'invalid' }

/** Never navigated from the omnibox, with or without spaces. */
const DANGEROUS = new Set([
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'view-source', 'chrome', 'chrome-extension',
  'chrome-untrusted', 'devtools', 'about', 'ftp', 'mailto', 'tel', 'sms', 'ws', 'wss'
])

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i
const HOST_PORT_RE = /^[^\s/?#:@]+:\d{1,5}(?:[/?#]|$)/
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

export function buildSearchUrl(query: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string {
  const enc = encodeURIComponent(query)
  const t = /\{searchTerms\}|\{q\}|%s/.test(engine.template) ? engine.template : DEFAULT_SEARCH_ENGINE.template
  return t.replace(/\{searchTerms\}|\{q\}|%s/g, () => enc)
}

function tryUrl(s: string): URL | null {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

function isIPv4(host: string): boolean {
  return IPV4_RE.test(host) && host.split('.').every((o) => Number(o) <= 255)
}

/** Does a scheme-less string look like a host (plus optional port/path)? Returns the URL to use. */
function bareHostToUrl(input: string): string | null {
  // authority is everything before the first / ? #
  const authority = input.split(/[/?#]/, 1)[0] ?? ''
  if (authority === '' || authority.includes('@')) return null

  // Bare IPv6 without brackets, e.g. "::1"
  if (/^[0-9a-f]*:[0-9a-f:]*:[0-9a-f:.]*$/i.test(authority) && !authority.includes('[')) {
    const u = tryUrl(`http://[${authority}]${input.slice(authority.length)}`)
    return u ? u.href : null
  }

  const bracketed = authority.startsWith('[')
  const hasPort = bracketed ? /\]:\d{1,5}$/.test(authority) : /:\d{1,5}$/.test(authority)
  const hostname = bracketed
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d{1,5}$/, '')
  if (authority.split(':').length > 2 && !bracketed) return null

  const lower = hostname.toLowerCase()
  const isLocal = lower === 'localhost' || lower.endsWith('.localhost')
  const isV6 = bracketed && /^\[[0-9a-f:.]+\]$/i.test(hostname)
  const isV4 = isIPv4(lower)
  const labels = lower.split('.')
  const last = labels[labels.length - 1] ?? ''
  const isDomain =
    labels.length >= 2 &&
    labels.every((l) => l.length > 0) &&
    (/^[a-z]{2,}$/.test(last) || last.startsWith('xn--') || /^[^\x00-\x7f]/.test(last)) &&
    !IPV4_RE.test(lower)
  const singleWordWithPort = hasPort && !hostname.includes('.') && !bracketed

  if (!(isLocal || isV6 || isV4 || isDomain || singleWordWithPort)) return null
  const proto = isDomain && !isLocal ? 'https' : 'http'
  const u = tryUrl(`${proto}://${input}`)
  return u ? u.href : null
}

/**
 * Decide what the user meant. url -> navigate, search -> go to engine, blocked -> do nothing.
 * Scheme-less domains get https://, localhost / IPs / host:port get http://.
 */
export function classifyInput(text: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): OmniboxResult {
  const input = text.trim()
  if (input === '') return { kind: 'blocked', url: '', reason: 'empty' }

  const schemeMatch = SCHEME_RE.exec(input)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  const looksHostPort = HOST_PORT_RE.test(input) && !input.includes('://')

  if (scheme && !looksHostPort) {
    if (input.toLowerCase() === 'about:blank') return { kind: 'url', url: 'about:blank' }
    if (DANGEROUS.has(scheme)) return { kind: 'blocked', url: '', reason: 'dangerous-scheme' }
    const hasSlashes = input.slice(scheme.length + 1).startsWith('//')
    if (scheme === 'http' || scheme === 'https' || scheme === 'retronet' || scheme === 'file') {
      if (/\s/.test(input) && scheme !== 'file') return { kind: 'search', url: buildSearchUrl(input, engine) }
      const u = tryUrl(input.replace(/\s/g, (c) => encodeURIComponent(c)))
      if (!u || (scheme !== 'file' && u.hostname === '')) return { kind: 'blocked', url: '', reason: 'invalid' }
      if (scheme === 'retronet') return { kind: 'url', url: u.href }
      if (scheme === 'file') return { kind: 'url', url: u.href, typedFile: true }
      return { kind: 'url', url: u.href }
    }
    // Unknown scheme: "foo://x" is blocked; "note: buy milk" is just a search.
    if (hasSlashes) return { kind: 'blocked', url: '', reason: 'unsupported-scheme' }
    return { kind: 'search', url: buildSearchUrl(input, engine) }
  }

  if (/\s/.test(input)) return { kind: 'search', url: buildSearchUrl(input, engine) }
  const url = bareHostToUrl(input)
  if (url) return { kind: 'url', url }
  return { kind: 'search', url: buildSearchUrl(input, engine) }
}

export type DropPayload = { kind: 'url'; url: string } | { kind: 'search'; text: string }

/**
 * What a link/text drop onto the strip should open (Q9), or null to refuse it. Untyped, like a page link: only
 * http(s) URLs and plain-text searches; file:, retronet:, javascript: and friends are refused (no typed-only
 * privileges from a drag). `search` text goes through tabs.navigate so main applies the profile's engine.
 */
export function dropPayload(uriList: string, plain: string): DropPayload | null {
  const fromList = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  const text = (fromList ?? plain).trim()
  if (!text || text.length > OMNIBOX_INPUT_MAX) return null
  const r = classifyInput(text)
  if (r.kind === 'search') return fromList ? null : { kind: 'search', text }
  if (r.kind !== 'url' || r.typedFile) return null
  return /^https?:/i.test(r.url) ? { kind: 'url', url: r.url } : null
}
