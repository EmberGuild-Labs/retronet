// retronet:// scheme (PLAN 1.6). Serves only bundled files from out/renderer, with a strict CSP on every response.
// The resolver is a pure function so it can be unit-tested without Electron (AC36).
import { promises as fsp } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import * as electron from 'electron'
import type { Session } from 'electron'
import { EGG_HOSTS } from '../../shared/eggs'

export const RETRONET_SCHEME = 'retronet'

/**
 * Every host the scheme answers. Anything else is a 404. The egg hosts (D-B1) are served like any page, from
 * `pages/<slug>/index.html` with the same CSP and headers, but they are not in PAGE_HOSTS, so they get no bridge.
 */
export const INTERNAL_HOSTS = [
  'shell',
  'overlay',
  'newtab',
  'history',
  'bookmarks',
  'downloads',
  'settings',
  'shortcuts',
  'about',
  'certerror',
  'neterror',
  ...EGG_HOSTS
] as const
export type InternalHost = (typeof INTERNAL_HOSTS)[number]

/** Hosts that only the shell and overlay webContents (default session) may load. */
export const UI_ONLY_HOSTS: readonly InternalHost[] = ['shell', 'overlay']

/** Top-level dirs under out/renderer that may be served below `/`. Note `pages/`, `shell/` etc. are not here. */
export const ASSET_DIRS = ['assets', 'skins', 'fonts', 'img'] as const

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Served extensions. A file with any other extension is never served, so nosniff always has a real type. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

const HOST_SET: ReadonlySet<string> = new Set(INTERNAL_HOSTS)
const ASSET_DIR_SET: ReadonlySet<string> = new Set(ASSET_DIRS)
// One path segment: no leading dot (rules out `.`, `..` and hidden files), no `%`, `\`, `:`, NUL, spaces or controls.
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_URL_LENGTH = 2048

/** The headers sent on every response, 200 or not. Never includes Access-Control-Allow-Origin. */
export function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Web pages may not embed internal resources (img, script, font) even though the scheme is secure.
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache'
  }
}

export function mimeTypeFor(file: string): string | null {
  return MIME_TYPES[extname(file).toLowerCase()] ?? null
}

interface Resolved {
  host: InternalHost
  file: string
}

function resolveInternal(url: string, root: string): Resolved | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
  // The path part of the raw string, before any query or fragment. Queries are page data, never part of the path.
  const cut = url.search(/[?#]/)
  const raw = cut === -1 ? url : url.slice(0, cut)
  // Reject anything that needs decoding or normalising: `%` (so `%2e`, `%2f`, `%5c`, `%00`, double encoding),
  // backslashes, NUL, whitespace and other controls. Real internal URLs never contain them.
  if (/[%\\\s\u0000-\u001f\u007f]/.test(raw)) return null

  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${RETRONET_SCHEME}:`) return null
  if (u.username !== '' || u.password !== '' || u.port !== '') return null
  if (!HOST_SET.has(u.hostname)) return null
  const host = u.hostname as InternalHost

  const pathname = u.pathname === '' ? '/' : u.pathname
  // If URL parsing rewrote the path (dot segments, case, etc.) the input was not canonical: reject it.
  const canonical = `${RETRONET_SCHEME}://${host}${u.pathname}`
  if (raw !== canonical && raw !== `${RETRONET_SCHEME}://${host}`) return null

  const rootAbs = resolve(root)
  let file: string
  if (pathname === '/') {
    file = UI_ONLY_HOSTS.includes(host) ? join(rootAbs, host, 'index.html') : join(rootAbs, 'pages', host, 'index.html')
  } else {
    const segments = pathname.slice(1).split('/')
    if (segments.length < 2) return null
    if (!ASSET_DIR_SET.has(segments[0] ?? '')) return null
    if (!segments.every((s) => SEGMENT_RE.test(s))) return null
    file = resolve(rootAbs, ...segments)
  }
  // Belt and braces: whatever happened above, the file must sit strictly inside the root.
  if (!file.startsWith(rootAbs + sep)) return null
  if (mimeTypeFor(file) === null) return null
  return { host, file }
}

/**
 * Map a retronet:// URL to an absolute file under `root`, or null if it must not be served.
 * `/` maps to `<root>/pages/<host>/index.html` (shell and overlay: `<root>/<host>/index.html`). Any other path
 * must start with an allowlisted dir (ASSET_DIRS) and have a known extension.
 */
export function resolveInternalPath(url: string, root: string): string | null {
  return resolveInternal(url, root)?.file ?? null
}

/** The host of a retronet:// URL if it is an allowlisted internal host, else null. */
export function internalHostOf(url: string): InternalHost | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${RETRONET_SCHEME}:` || !HOST_SET.has(u.hostname)) return null
    return u.hostname as InternalHost
  } catch {
    return null
  }
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: responseHeaders('text/plain; charset=utf-8') })
}

export interface RetronetProtocolOptions {
  /** 'serve' only on the default session (shell and overlay). Profile and incognito sessions use 'block'. */
  uiOnlyHosts: 'serve' | 'block'
  /** Directory holding the built renderer. Defaults to `<appPath>/out/renderer`. */
  root?: string
}

/** The request handler, exported for tests and harnesses. `installRetronetProtocol` is the normal entry point. */
export function createRetronetHandler(opts: Required<RetronetProtocolOptions>): (req: Request) => Promise<Response> {
  const root = resolve(opts.root)
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'Method Not Allowed')
    const hit = resolveInternal(req.url, root)
    if (!hit) return errorResponse(404, 'Not Found')
    if (opts.uiOnlyHosts === 'block' && UI_ONLY_HOSTS.includes(hit.host)) return errorResponse(404, 'Not Found')
    const type = mimeTypeFor(hit.file)
    if (!type) return errorResponse(404, 'Not Found')
    try {
      const body = await fsp.readFile(hit.file)
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: responseHeaders(type)
      })
    } catch {
      return errorResponse(404, 'Not Found')
    }
  }
}

/**
 * Must run before `app` is ready. `standard` gives each host its own origin (so relative URLs and same-origin
 * module scripts work), `secure` makes it a secure context, `supportFetchAPI` lets `ses.fetch` reach it.
 * `corsEnabled` is deliberately off: same-origin ES module scripts load without it (verified, see BOARD T5).
 * Never `bypassCSP`, `allowServiceWorkers` or `stream`.
 */
export function registerRetronetSchemePrivileged(): void {
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: RETRONET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/**
 * Install the handler on one session. Call it for EVERY session: the default session (uiOnlyHosts 'serve') and
 * each profile `persist:p-<id>` and incognito partition (uiOnlyHosts 'block'). Safe to call again on the same
 * session; the previous handler is replaced.
 */
export function installRetronetProtocol(ses: Session, opts: RetronetProtocolOptions): void {
  const root = opts.root ?? join(electron.app.getAppPath(), 'out', 'renderer')
  if (ses.protocol.isProtocolHandled(RETRONET_SCHEME)) ses.protocol.unhandle(RETRONET_SCHEME)
  ses.protocol.handle(RETRONET_SCHEME, createRetronetHandler({ uiOnlyHosts: opts.uiOnlyHosts, root }))
}
