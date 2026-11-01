// Omnibox suggestion list (DESIGN 3.2, T20). Pure: takes the profile's history/bookmark lookups and the search
// engine, returns at most MAX_SUGGESTIONS rows. Order: bookmarks, then history (deduped by URL), then one
// "Search with <engine>" row last, so Enter on the typed text (highlight -1) stays the default action.
import type { Suggestion } from '../../shared/types'
import { buildSearchUrl, type SearchEngine } from '../../shared/omnibox'

export const MAX_SUGGESTIONS = 8
const MAX_BOOKMARKS = 3
const MAX_HISTORY = 6

export interface SuggestSources {
  bookmarks(prefix: string, limit: number): Array<{ url: string; title: string }>
  history(prefix: string, limit: number): Array<{ url: string; title: string }>
}

/** Strips scheme and a trailing slash so http://a.org/ and https://a.org count as one row. */
function dedupeKey(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase()
}

/** Only addresses a user could have typed: never javascript:, data: or the UI-only retronet hosts. */
function safeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return true
    return u.protocol === 'retronet:' && u.hostname !== 'shell' && u.hostname !== 'overlay'
  } catch {
    return false
  }
}

export function buildSuggestions(text: string, sources: SuggestSources, engine: SearchEngine): Suggestion[] {
  const query = text.trim()
  if (!query) return []
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const add = (kind: Suggestion['kind'], url: string, title: string): void => {
    if (!safeUrl(url)) return
    const key = dedupeKey(url)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, url, title: title.trim().slice(0, 300) })
  }
  for (const b of sources.bookmarks(query, MAX_BOOKMARKS)) add('bookmark', b.url, b.title)
  for (const h of sources.history(query, MAX_HISTORY + MAX_BOOKMARKS)) {
    if (out.length >= MAX_SUGGESTIONS - 1) break
    add('history', h.url, h.title)
  }
  out.splice(MAX_SUGGESTIONS - 1)
  out.push({ kind: 'search', title: query.slice(0, 300), url: buildSearchUrl(query, engine) })
  return out
}
