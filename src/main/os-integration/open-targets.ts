// What other apps may open in RetroNet (PLAN-EXTRA 1.2, AC48). Pure: no Electron, the file check is injected.
//   - URLs (macOS `open-url`, Windows/Linux argv): http(s) only. retronet:, file:, javascript:, data: and every
//     other scheme are refused; the tab still runs decideBrowserNavigation on what we accept (untyped).
//   - Files (macOS `open-file`, argv paths): an existing local .html/.htm/.xhtml/.shtml file. It becomes a
//     `file:` URL with typed:true, because the user opened it, which is the only other way to reach file:.
import { statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAllowedAddress } from '../../shared/settings'

export const OPEN_URL_MAX = 8192
const PATH_MAX = 4096
const URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])
export const OPEN_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm', '.xhtml', '.shtml'])

export type ExternalOpenInput = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/** Something to open in a tab: the address and whether it counts as typed (file: only). */
export interface OpenTarget {
  url: string
  typed: boolean
}

/** True when `path` is an existing regular file (symlinks followed). Injected so tests need no disk. */
export type IsFile = (path: string) => boolean

export const isRegularFile: IsFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A URL or file handed to us by the OS, or null when it must be ignored. */
export function classifyExternalOpen(input: ExternalOpenInput, isFile: IsFile = isRegularFile): OpenTarget | null {
  if (input.kind === 'url') {
    const url = input.url
    if (typeof url !== 'string' || url.length === 0 || url.length > OPEN_URL_MAX) return null
    if (!isAllowedAddress(url, URL_SCHEMES)) return null
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return { url: u.href, typed: false }
  }
  const path = input.path
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX || path.includes('\0')) return null
  if (!isAbsolute(path)) return null
  if (!OPEN_FILE_EXTENSIONS.has(extname(path).toLowerCase())) return null
  if (!isFile(path)) return null
  return { url: pathToFileURL(path).href, typed: true }
}

const looksLikeUrl = (arg: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)

/**
 * Windows/Linux: the URLs and .html files on a command line (first launch or `second-instance`). Skips
 * argv[0], switches, `.` and the app path. macOS delivers links through `open-url`/`open-file`, so it gets [].
 * Relative file paths resolve against `cwd` (the launching process's directory).
 */
export function urlsFromArgv(
  argv: readonly string[],
  cwd: string,
  platform: NodeJS.Platform,
  opts: { appPath?: string; isFile?: IsFile } = {}
): OpenTarget[] {
  if (platform === 'darwin') return []
  const out: OpenTarget[] = []
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg === '' || arg === '.' || arg.startsWith('-')) continue
    if (opts.appPath && resolve(cwd, arg) === resolve(opts.appPath)) continue
    const target = looksLikeUrl(arg)
      ? classifyExternalOpen({ kind: 'url', url: arg }, opts.isFile)
      : classifyExternalOpen({ kind: 'file', path: resolve(cwd, arg) }, opts.isFile)
    if (target) out.push(target)
  }
  return out
}
