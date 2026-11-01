import { z } from 'zod'
import { HistoryEntrySchema } from '../../shared/ipc-contract'
import type { HistoryEntry } from '../../shared/types'
import { createJsonStore, type JsonStore } from './json-store'
import { stripUrlCredentials } from './url-credentials'

export const HISTORY_MAX_ENTRIES = 30_000
export const HISTORY_MAX_AGE_MS = 90 * 24 * 3600 * 1000

export type ClearRange = 'hour' | 'day' | 'week' | 'all'
const RANGE_MS: Record<Exclude<ClearRange, 'all'>, number> = { hour: 3600e3, day: 24 * 3600e3, week: 7 * 24 * 3600e3 }

/** Start of a clear range in epoch ms (entries at or after it are cleared); 0 for 'all'. */
export function rangeCutoff(range: ClearRange, now: number): number {
  return range === 'all' ? 0 : now - RANGE_MS[range]
}

const HistoryFileSchema = z.object({
  /** Next visitor number. Never reused, even after deletes or clears. */
  nextId: z.number().int().positive(),
  /** Oldest first, ascending id. */
  entries: z.array(HistoryEntrySchema)
})
type HistoryData = z.infer<typeof HistoryFileSchema>

export interface HistoryQuery {
  text?: string
  offset?: number
  limit?: number
}
export interface HistoryPage {
  entries: HistoryEntry[]
  total: number
  hasMore: boolean
}
export interface HistorySuggestion {
  url: string
  title: string
}
export interface DayGroup {
  /** Local date, YYYY-MM-DD. */
  day: string
  entries: HistoryEntry[]
}

/** Group newest-first entries by local calendar day (guestbook layout). Order is preserved. */
export function groupByDay(entries: readonly HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const e of entries) {
    const d = new Date(e.visitedAt)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.entries.push(e)
    else groups.push({ day, entries: [e] })
  }
  return groups
}

export interface HistoryStore {
  /** Record a visit; returns the new entry (id = visitor number). */
  recordVisit(url: string, title: string, at?: number): HistoryEntry
  /** Set the title of the most recent entry for this url. */
  updateTitle(url: string, title: string): boolean
  /** Newest first, optional case-insensitive substring match over title and url. */
  query(q?: HistoryQuery): HistoryPage
  delete(id: number): boolean
  deleteRange(fromMs: number, toMs?: number): number
  /** Clear by D3 range. Returns the number removed. */
  clear(range: ClearRange, now?: number): number
  /** Unique urls whose url or title starts with / contains the prefix, most recent first. */
  suggest(prefix: string, limit?: number): HistorySuggestion[]
  count(): number
  /** Drop entries over the age/size caps. Runs automatically on load and on record. */
  prune(now?: number): void
  readonly store: JsonStore<HistoryData>
}

export function createHistoryStore(file: string | null, opts: { now?: () => number; debounceMs?: number } = {}): HistoryStore {
  const now = opts.now ?? Date.now
  const store = createJsonStore<HistoryData>({
    file,
    schema: HistoryFileSchema,
    defaults: () => ({ nextId: 1, entries: [] }),
    debounceMs: opts.debounceMs
  })
  // Keep nextId ahead of every id even if the file was hand-edited.
  const fix = (d: HistoryData): void => {
    const top = d.entries.reduce((m, e) => Math.max(m, e.id), 0)
    if (d.nextId <= top) d.nextId = top + 1
  }
  const prune = (at = now()): void => {
    const d = store.get()
    const cutoff = at - HISTORY_MAX_AGE_MS
    let drop = 0
    while (drop < d.entries.length && (d.entries[drop]!.visitedAt < cutoff || d.entries.length - drop > HISTORY_MAX_ENTRIES)) drop++
    if (drop > 0) store.update((x) => void x.entries.splice(0, drop))
  }
  fix(store.get())
  // Q6: older files may hold addresses with user:pass@; never keep them.
  if (store.get().entries.some((e) => stripUrlCredentials(e.url) !== e.url)) {
    store.update((d) => {
      for (const e of d.entries) e.url = stripUrlCredentials(e.url)
    })
  }
  prune()

  const matches = (e: HistoryEntry, t: string): boolean => e.title.toLowerCase().includes(t) || e.url.toLowerCase().includes(t)
  const remove = (pred: (e: HistoryEntry) => boolean): number => {
    const before = store.get().entries.length
    store.update((d) => {
      d.entries = d.entries.filter((e) => !pred(e))
    })
    return before - store.get().entries.length
  }

  return {
    recordVisit(rawUrl, title, at = now()) {
      const url = stripUrlCredentials(rawUrl)
      const entry: HistoryEntry = { id: store.get().nextId, url, title, visitedAt: at }
      store.update((d) => {
        d.entries.push(entry)
        d.nextId = entry.id + 1
      })
      // Cheap check; full prune only when a cap could be hit.
      const first = store.get().entries[0]
      if (store.get().entries.length > HISTORY_MAX_ENTRIES || (first && first.visitedAt < at - HISTORY_MAX_AGE_MS)) prune(at)
      return entry
    },
    updateTitle(rawUrl, title) {
      const url = stripUrlCredentials(rawUrl)
      const entries = store.get().entries
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.url === url) {
          if (entries[i]!.title !== title) store.update((d) => void (d.entries[i]!.title = title))
          return true
        }
      }
      return false
    },
    query({ text, offset = 0, limit = 100 } = {}) {
      const t = text?.trim().toLowerCase()
      const all = store.get().entries
      const out: HistoryEntry[] = []
      let total = 0
      for (let i = all.length - 1; i >= 0; i--) {
        if (t && !matches(all[i]!, t)) continue
        if (total >= offset && out.length < limit) out.push(all[i]!)
        total++
      }
      return { entries: out, total, hasMore: offset + out.length < total }
    },
    delete: (id) => remove((e) => e.id === id) > 0,
    deleteRange: (from, to = Infinity) => remove((e) => e.visitedAt >= from && e.visitedAt <= to),
    clear(range, at = now()) {
      const cutoff = rangeCutoff(range, at)
      return remove((e) => e.visitedAt >= cutoff)
    },
    suggest(prefix, limit = 5) {
      const p = prefix.trim().toLowerCase()
      if (!p) return []
      const bare = (u: string): string => u.replace(/^[a-z]+:\/\/(www\.)?/i, '').toLowerCase()
      const seen = new Set<string>()
      const hits: HistorySuggestion[] = []
      const all = store.get().entries
      for (let i = all.length - 1; i >= 0 && hits.length < limit; i--) {
        const e = all[i]!
        if (seen.has(e.url)) continue
        if (bare(e.url).startsWith(p) || e.title.toLowerCase().includes(p)) {
          seen.add(e.url)
          hits.push({ url: e.url, title: e.title })
        }
      }
      return hits
    },
    count: () => store.get().entries.length,
    prune,
    store
  }
}
