// Netscape Bookmark File (the HTML every browser imports/exports). Pure module: no Electron, no DOM.
//
// The parser is a single linear pass over the text: it finds '<', reads one tag (quote-aware), and drives a small
// state machine (folder stack + "currently collecting a title"). There is no regex over the whole input and no
// backtracking, so hostile input cannot cause a ReDoS. A tag that never ends (or runs past MAX_TAG) stops the scan,
// which keeps the worst case linear instead of rescanning the tail for every '<'.
//
// Scheme filtering happens here (http/https only, credentials stripped); dedupe and the destination folder are the
// caller's job (internal-api/bookmarks-io).
import { BOOKMARK_IMPORT_MAX, BOOKMARK_IMPORT_MAX_BYTES } from '../../shared/bookmarks-import'
import { stripUrlCredentials } from '../storage/url-credentials'

// The limits live in shared/bookmarks-import (R26); these names stay for the parser and its tests.
export const MAX_NETSCAPE_BYTES = BOOKMARK_IMPORT_MAX_BYTES
export const MAX_IMPORT_BOOKMARKS = BOOKMARK_IMPORT_MAX
export const MAX_IMPORT_DEPTH = 32
export const MAX_TITLE_LEN = 1024
export const MAX_URL_LEN = 8192
const MAX_FOLDERS = 20_000
const MAX_TAG = 1024 * 1024
const MAX_RAW_TITLE = 16 * 1024

export interface ImportBookmark {
  kind: 'bookmark'
  title: string
  /** http(s) only, userinfo removed. */
  url: string
  /** Milliseconds since epoch, from ADD_DATE; undefined if absent or unparsable. */
  addedAt?: number
}
export interface ImportFolder {
  kind: 'folder'
  title: string
  /** PERSONAL_TOOLBAR_FOLDER="true" in the file. */
  toolbar?: boolean
  addedAt?: number
  children: ImportNode[]
}
export type ImportNode = ImportBookmark | ImportFolder

export type SkipReason = 'javascript' | 'file' | 'ftp' | 'place' | 'data' | 'retronet' | 'otherScheme' | 'invalid' | 'tooLong'
export interface ImportStats {
  /** Bookmarks kept in `roots`. */
  imported: number
  /** Folders created in `roots`. */
  folders: number
  skipped: Record<SkipReason, number>
  /** Sum of `skipped`. */
  skippedTotal: number
  /** A count cap was hit and the rest was dropped. */
  truncated: boolean
}
export interface ParseResult {
  roots: ImportNode[]
  stats: ImportStats
  /** Set when nothing was parsed: the input is too large or does not look like a bookmarks file. */
  error?: 'too-large' | 'not-bookmarks'
}

const SKIP_REASONS: SkipReason[] = ['javascript', 'file', 'ftp', 'place', 'data', 'retronet', 'otherScheme', 'invalid', 'tooLong']

function emptyStats(): ImportStats {
  const skipped = {} as Record<SkipReason, number>
  for (const r of SKIP_REASONS) skipped[r] = 0
  return { imported: 0, folders: 0, skipped, skippedTotal: 0, truncated: false }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Decode &amp; &lt; &gt; &quot; &apos; &nbsp; &#N; &#xH;. Unknown or malformed references stay as written. */
export function decodeEntities(s: string): string {
  let amp = s.indexOf('&')
  if (amp < 0) return s
  let out = ''
  let last = 0
  while (amp >= 0) {
    const semi = s.indexOf(';', amp + 1)
    let rep: string | null = null
    let end = amp + 1
    if (semi > amp && semi - amp <= 10) {
      const body = s.slice(amp + 1, semi)
      end = semi + 1
      if (body.charCodeAt(0) === 35) {
        const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
        const digits = body.slice(hex ? 2 : 1)
        if (digits.length > 0 && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
          const cp = parseInt(digits, hex ? 16 : 10)
          rep = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp)
        }
      } else if (Object.prototype.hasOwnProperty.call(NAMED, body)) {
        rep = NAMED[body] ?? null
      }
    }
    if (rep !== null) {
      out += s.slice(last, amp) + rep
      last = end
    }
    amp = s.indexOf('&', rep !== null ? end : amp + 1)
  }
  return out + s.slice(last)
}

interface Tag {
  name: string
  closing: boolean
  href?: string
  addDate?: string
  toolbar?: boolean
  /** Index just past '>'. */
  end: number
}

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/** Read the tag starting at `lt` (text[lt] === '<'). Returns null if it never ends within MAX_TAG. */
function readTag(text: string, lt: number): Tag | null {
  const n = text.length
  const limit = Math.min(n, lt + MAX_TAG)
  let i = lt + 1
  let closing = false
  if (text.charCodeAt(i) === 47) {
    closing = true
    i++
  }
  const ns = i
  while (i < limit) {
    const c = text.charCodeAt(i)
    if (isWs(c) || c === 62 || c === 47) break
    i++
  }
  const tag: Tag = { name: text.slice(ns, i).toLowerCase(), closing, end: 0 }
  while (i < limit) {
    const c = text.charCodeAt(i)
    if (c === 62) {
      tag.end = i + 1
      return tag
    }
    if (isWs(c) || c === 47) {
      i++
      continue
    }
    const as = i
    while (i < limit) {
      const d = text.charCodeAt(i)
      if (isWs(d) || d === 62 || d === 61 || d === 47) break
      i++
    }
    const attr = text.slice(as, i).toLowerCase()
    while (i < limit && isWs(text.charCodeAt(i))) i++
    let value = ''
    if (i < limit && text.charCodeAt(i) === 61) {
      i++
      while (i < limit && isWs(text.charCodeAt(i))) i++
      const q = text.charCodeAt(i)
      if (q === 34 || q === 39) {
        const close = text.indexOf(q === 34 ? '"' : "'", i + 1)
        if (close < 0 || close >= limit) return null
        value = text.slice(i + 1, close)
        i = close + 1
      } else {
        const vs = i
        while (i < limit) {
          const d = text.charCodeAt(i)
          if (isWs(d) || d === 62) break
          i++
        }
        value = text.slice(vs, i)
      }
      if (attr === 'href') tag.href = value
      else if (attr === 'add_date') tag.addDate = value
      else if (attr === 'personal_toolbar_folder') tag.toolbar = value.toLowerCase() === 'true'
    }
    if (i === as) i++ // a stray '=' or similar must not stall the loop
  }
  return null
}

function parseAddDate(v: string | undefined): number | undefined {
  if (!v || v.length > 18 || !/^\d+$/.test(v)) return undefined
  let n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n > 1e14) n /= 1000 // microseconds
  else if (n < 1e11) n *= 1000 // seconds
  return n < 8.64e15 ? Math.floor(n) : undefined
}

function classify(raw: string): { url: string } | { skip: SkipReason } {
  let url = ''
  // HTML exports sometimes wrap long URLs; whitespace and control characters never belong in one, so drop them.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c > 32 && c !== 127) url += raw[i]
  }
  url = url.trim()
  if (url.length === 0) return { skip: 'invalid' }
  if (url.length > MAX_URL_LEN) return { skip: 'tooLong' }
  const colon = url.indexOf(':')
  if (colon <= 0 || colon > 20) return { skip: 'invalid' }
  const scheme = url.slice(0, colon).toLowerCase()
  if (scheme === 'http' || scheme === 'https') {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { skip: 'invalid' }
    }
    if (!u.hostname) return { skip: 'invalid' }
    const stripped = stripUrlCredentials(url)
    return stripped.length > MAX_URL_LEN ? { skip: 'tooLong' } : { url: stripped }
  }
  switch (scheme) {
    case 'javascript': case 'file': case 'ftp': case 'place': case 'data': case 'retronet':
      return { skip: scheme }
    default:
      return { skip: 'otherScheme' }
  }
}

/** Parse a Netscape bookmark file. Never throws. */
export function parseNetscape(text: string): ParseResult {
  const stats = emptyStats()
  const roots: ImportNode[] = []
  if (typeof text !== 'string') return { roots, stats, error: 'not-bookmarks' }
  // Cheap guard before any scanning: UTF-16 length bounds the UTF-8 size from below, so check bytes only when close.
  if (text.length > MAX_NETSCAPE_BYTES || Buffer.byteLength(text, 'utf8') > MAX_NETSCAPE_BYTES) {
    return { roots, stats, error: 'too-large' }
  }
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = text.length

  // Each stack frame is a <DL>; `list` is where its entries go. An anonymous <DL> (no H3 before it) or a <DL> past
  // the depth cap shares its parent's list.
  interface Frame { list: ImportNode[]; folder: boolean }
  const stack: Frame[] = [{ list: roots, folder: false }]
  const cur = (): ImportNode[] => (stack[stack.length - 1] ?? stack[0]!).list
  let folderDepth = 0
  let overflow = 0
  let pending: ImportFolder | null = null // H3 seen, waiting for its <DL>
  let sawEntry = false

  type Collect = { kind: 'a'; href: string; addDate?: string } | { kind: 'h3'; folder: ImportFolder | null }
  let collecting: Collect | null = null
  let raw = ''

  const finishTitle = (): void => {
    if (!collecting) return
    let title = decodeEntities(raw).replace(/\s+/g, ' ').trim()
    if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN)
    const c = collecting
    collecting = null
    raw = ''
    if (c.kind === 'h3') {
      if (c.folder) c.folder.title = title
      return
    }
    const r = classify(decodeEntities(c.href))
    if ('skip' in r) {
      stats.skipped[r.skip]++
      stats.skippedTotal++
      return
    }
    if (stats.imported >= MAX_IMPORT_BOOKMARKS) {
      stats.truncated = true
      return
    }
    const b: ImportBookmark = { kind: 'bookmark', title: title || r.url, url: r.url }
    const at = parseAddDate(c.addDate)
    if (at !== undefined) b.addedAt = at
    cur().push(b)
    stats.imported++
  }

  while (pos < n) {
    const lt = text.indexOf('<', pos)
    if (lt < 0) {
      if (collecting && raw.length < MAX_RAW_TITLE) raw += text.slice(pos, pos + MAX_RAW_TITLE - raw.length)
      break
    }
    if (collecting && lt > pos && raw.length < MAX_RAW_TITLE) raw += text.slice(pos, Math.min(lt, pos + MAX_RAW_TITLE - raw.length))
    const next = text.charCodeAt(lt + 1)
    if (!(isAlpha(next) || next === 47 || next === 33)) {
      // a bare '<' in text ("a < b"): keep it as title text
      if (collecting && raw.length < MAX_RAW_TITLE) raw += '<'
      pos = lt + 1
      continue
    }
    if (next === 33 && text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4)
      if (close < 0) break
      pos = close + 3
      continue
    }
    const tag = readTag(text, lt)
    if (!tag) break // unterminated tag: treat the rest as garbage
    pos = tag.end
    const name = tag.name

    if (tag.closing) {
      if (name === 'a' || name === 'h3') finishTitle()
      else if (name === 'dl') {
        finishTitle()
        pending = null
        if (overflow > 0) overflow--
        else if (stack.length > 1) {
          const f = stack.pop()!
          if (f.folder) folderDepth--
        }
      }
      continue
    }

    switch (name) {
      case 'a': {
        finishTitle()
        if (tag.href !== undefined) {
          sawEntry = true
          collecting = { kind: 'a', href: tag.href, addDate: tag.addDate }
        }
        break
      }
      case 'h3': {
        finishTitle()
        sawEntry = true
        let folder: ImportFolder | null = null
        if (folderDepth < MAX_IMPORT_DEPTH && stats.folders < MAX_FOLDERS) {
          folder = { kind: 'folder', title: '', children: [] }
          if (tag.toolbar) folder.toolbar = true
          const at = parseAddDate(tag.addDate)
          if (at !== undefined) folder.addedAt = at
          cur().push(folder)
          stats.folders++
        } else {
          stats.truncated = true // too deep or too many: its children attach to the current folder
        }
        pending = folder
        collecting = { kind: 'h3', folder }
        break
      }
      case 'dl': {
        finishTitle()
        if (stack.length >= MAX_IMPORT_DEPTH * 4) {
          overflow++ // runaway <DL> nesting: remember it so the </DL>s still balance, but stop growing the stack
          pending = null
        } else if (pending) {
          stack.push({ list: pending.children, folder: true })
          folderDepth++
          pending = null
        } else {
          stack.push({ list: cur(), folder: false })
        }
        break
      }
      case 'dt': case 'dd': case 'p':
        finishTitle()
        break
      default:
        break // unknown/inline tags (b, i, br, meta, title, ...) are skipped; their text still counts as title text
    }
  }
  finishTitle()

  if (!sawEntry) return { roots: [], stats: emptyStats(), error: 'not-bookmarks' }
  return { roots, stats }
}

// ---------------------------------------------------------------------------------------------------------------

/** Structural, so the store's BookmarkNode/BookmarkTree fit without importing them. */
export interface ExportNode {
  kind: 'bookmark' | 'folder'
  title: string
  url?: string
  createdAt: number
  children?: ExportNode[]
}
export interface ExportTree {
  bar: { children: ExportNode[]; createdAt?: number }
  other: { children: ExportNode[]; createdAt?: number }
}

const MAX_EXPORT_DEPTH = 64

/** Escape for both text and double-quoted attribute values. */
export function escapeHtml(s: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < s.length; i++) {
    let rep: string | null = null
    switch (s.charCodeAt(i)) {
      case 38: rep = '&amp;'; break
      case 60: rep = '&lt;'; break
      case 62: rep = '&gt;'; break
      case 34: rep = '&quot;'; break
      case 39: rep = '&#39;'; break
    }
    if (rep !== null) {
      out += s.slice(last, i) + rep
      last = i + 1
    }
  }
  return out + s.slice(last)
}

const secs = (ms: number | undefined): number => (Number.isFinite(ms) && (ms as number) > 0 ? Math.floor((ms as number) / 1000) : 0)

/** Write a valid NETSCAPE-Bookmark-file-1 document: the bar as the PERSONAL_TOOLBAR_FOLDER, then Other's children. */
export function serializeNetscape(tree: ExportTree): string {
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ]
  const walk = (nodes: ExportNode[], depth: number): void => {
    const pad = '    '.repeat(Math.min(depth, 16))
    for (const node of nodes) {
      if (node.kind === 'folder') {
        if (depth >= MAX_EXPORT_DEPTH) continue
        out.push(`${pad}<DT><H3 ADD_DATE="${secs(node.createdAt)}">${escapeHtml(node.title)}</H3>`)
        out.push(`${pad}<DL><p>`)
        walk(node.children ?? [], depth + 1)
        out.push(`${pad}</DL><p>`)
      } else if (typeof node.url === 'string') {
        out.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${secs(node.createdAt)}">${escapeHtml(node.title)}</A>`)
      }
    }
  }
  const barAt = secs(tree.bar.createdAt)
  out.push(`    <DT><H3 ADD_DATE="${barAt}" LAST_MODIFIED="${barAt}" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>`)
  out.push('    <DL><p>')
  walk(tree.bar.children, 2)
  out.push('    </DL><p>')
  walk(tree.other.children, 1)
  out.push('</DL><p>', '')
  return out.join('\n')
}
