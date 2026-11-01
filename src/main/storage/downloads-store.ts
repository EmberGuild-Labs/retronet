import { z } from 'zod'
import { DownloadItemSchema } from '../../shared/ipc-contract'
import type { DownloadItem } from '../../shared/types'
import { createJsonStore, type JsonStore } from './json-store'
import { rangeCutoff, type ClearRange } from './history-store'

export const DOWNLOADS_MAX = 1000

const FileSchema = z.object({ items: z.array(DownloadItemSchema) })
type DownloadsData = z.infer<typeof FileSchema>

const isActive = (i: DownloadItem): boolean => i.state === 'progressing' || i.state === 'paused'

export interface DownloadsStore {
  /** Newest first. */
  list(): DownloadItem[]
  get(id: string): DownloadItem | null
  /** Insert or replace by id. */
  upsert(item: DownloadItem): void
  remove(id: string): boolean
  /** Drop finished, cancelled, failed and missing entries (active ones stay). Files are untouched. */
  clearFinished(): number
  /** D3: clear entries started within the range; active downloads are kept. */
  clearRange(range: ClearRange, now?: number): number
  readonly store: JsonStore<DownloadsData>
}

export function createDownloadsStore(file: string | null, opts: { now?: () => number; debounceMs?: number } = {}): DownloadsStore {
  const now = opts.now ?? Date.now
  const store = createJsonStore<DownloadsData>({
    file,
    schema: FileSchema,
    defaults: () => ({ items: [] }),
    debounceMs: opts.debounceMs
  })
  // A download that was running when the app quit cannot still be running now.
  if (store.get().items.some(isActive)) {
    store.update((d) => {
      for (const i of d.items) if (isActive(i)) Object.assign(i, { state: 'interrupted', bytesPerSecond: 0, endedAt: i.endedAt ?? now(), error: i.error ?? 'Interrupted by exit' })
    })
  }
  const drop = (pred: (i: DownloadItem) => boolean): number => {
    const before = store.get().items.length
    store.update((d) => {
      d.items = d.items.filter((i) => !pred(i))
    })
    return before - store.get().items.length
  }
  return {
    list: () => [...store.get().items].sort((a, b) => b.startedAt - a.startedAt),
    get: (id) => store.get().items.find((i) => i.id === id) ?? null,
    upsert(item) {
      store.update((d) => {
        const i = d.items.findIndex((x) => x.id === item.id)
        if (i >= 0) d.items[i] = item
        else d.items.push(item)
        if (d.items.length > DOWNLOADS_MAX) {
          const keep = d.items.filter(isActive)
          const rest = d.items.filter((x) => !isActive(x)).sort((a, b) => b.startedAt - a.startedAt)
          d.items = [...keep, ...rest.slice(0, Math.max(0, DOWNLOADS_MAX - keep.length))]
        }
      })
    },
    remove: (id) => drop((i) => i.id === id) > 0,
    clearFinished: () => drop((i) => !isActive(i)),
    clearRange(range, at = now()) {
      const cutoff = rangeCutoff(range, at)
      return drop((i) => !isActive(i) && i.startedAt >= cutoff)
    },
    store
  }
}
