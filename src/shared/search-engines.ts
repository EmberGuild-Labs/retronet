// Search engine registry (AC3, AC19). Names are nominative, used as settings labels only (no logos).
// The engine shape is T3's `SearchEngine` from omnibox.ts, so classifyInput(text, getSearchEngine(id)) just works.
import { buildSearchUrl, type SearchEngine } from './omnibox'

export type { SearchEngine } from './omnibox'

export const SEARCH_ENGINE_IDS = ['duckduckgo', 'google', 'bing', 'brave', 'ecosia'] as const
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number]

export interface SearchEngineInfo extends SearchEngine {
  id: SearchEngineId
  /** Display name for the settings select and the new-tab hint. */
  name: string
}

export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = 'duckduckgo'

export const SEARCH_ENGINES: readonly SearchEngineInfo[] = Object.freeze([
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={searchTerms}' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={searchTerms}' },
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q={searchTerms}' },
  { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q={searchTerms}' },
  { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q={searchTerms}' }
])

export function isSearchEngineId(id: unknown): id is SearchEngineId {
  return typeof id === 'string' && (SEARCH_ENGINE_IDS as readonly string[]).includes(id)
}

/** Unknown ids fall back to the default engine, so a stale settings value never breaks search. */
export function getSearchEngine(id: string): SearchEngineInfo {
  const found = SEARCH_ENGINES.find((e) => e.id === id)
  return found ?? (SEARCH_ENGINES[0] as SearchEngineInfo)
}

export function searchUrlFor(id: string, query: string): string {
  return buildSearchUrl(query, getSearchEngine(id))
}
