// Omnibox suggestion list (DESIGN 3.2, T20). Pure: takes the profile's history/bookmark lookups and the search
// engine, returns at most MAX_SUGGESTIONS rows. Order: bookmarks, then history (deduped by URL), then one
// "Search with <engine>" row last, so Enter on the typed text (highlight -1) stays the default action.
import type { SkinId, Suggestion } from '../../shared/types'
import { eggUrl, isEggUrl } from '../../shared/eggs'
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

/**
 * Only addresses a user could have typed: never javascript:, data: or the UI-only retronet hosts. The hidden era
 * pages never appear either, even when bookmarked (D-B2).
 */
function safeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return true
    return u.protocol === 'retronet:' && u.hostname !== 'shell' && u.hostname !== 'overlay' && !isEggUrl(url)
  } catch {
    return false
  }
}

/** The phrases that reveal the y2001 egg (DESIGN-EGGS 4.1). Compared trimmed, lower-cased, spaces collapsed. */
export const EGG_HINT_PHRASES: readonly string[] = ['wiki wiki', 'quick quick']
const EGG_HINT_ERA: SkinId = 'y2001'
const EGG_HINT_TITLE = 'Quick, quick!'

/**
 * The one generated egg row (manager-approved exception to D-B2): only under the y2001 skin and only for the exact
 * phrases. It is the hint itself, so it is built here rather than passed through safeUrl's egg refusal.
 */
export function eggHintRow(text: string, skin: SkinId | undefined): Suggestion | null {
  if (skin !== EGG_HINT_ERA) return null
  const phrase = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!EGG_HINT_PHRASES.includes(phrase)) return null
  const url = eggUrl(EGG_HINT_ERA)
  return url ? { kind: 'url', title: EGG_HINT_TITLE, url } : null
}

/**
 * The era a picked row opens through openEgg (the same path as eggs.open), or null for any ordinary row. Only the
 * generated hint row qualifies: kind 'url', the hint title and exactly the y2001 egg URL.
 */
export function eggHintEra(item: Suggestion | undefined): SkinId | null {
  if (!item || item.kind !== 'url' || item.title !== EGG_HINT_TITLE) return null
  return item.url === eggUrl(EGG_HINT_ERA) ? EGG_HINT_ERA : null
}

export interface SuggestOptions {
  /** The window's current skin; enables the y2001 egg hint row. */
  skin?: SkinId
}

export function buildSuggestions(text: string, sources: SuggestSources, engine: SearchEngine, opts: SuggestOptions = {}): Suggestion[] {
  const query = text.trim()
  if (!query) return []
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const hint = eggHintRow(query, opts.skin)
  if (hint) out.push(hint)
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
