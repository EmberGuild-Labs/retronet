import { z } from 'zod'
import { createJsonStore, type JsonStore } from './json-store'

const FileSchema = z.object({ levels: z.record(z.string(), z.number().finite()) })
type ZoomData = z.infer<typeof FileSchema>

export interface ZoomStore {
  /** Zoom level (Electron zoom-level units, 0 = 100%) for an origin; 0 when none stored. */
  get(origin: string): number
  /** Storing 0 removes the entry. */
  set(origin: string, level: number): void
  all(): Record<string, number>
  clear(): void
  readonly store: JsonStore<ZoomData>
}

export function createZoomStore(file: string | null, opts: { debounceMs?: number } = {}): ZoomStore {
  const store = createJsonStore<ZoomData>({ file, schema: FileSchema, defaults: () => ({ levels: {} }), debounceMs: opts.debounceMs })
  return {
    get: (origin) => store.get().levels[origin] ?? 0,
    set(origin, level) {
      store.update((d) => {
        if (level === 0) delete d.levels[origin]
        else d.levels[origin] = level
      })
    },
    all: () => ({ ...store.get().levels }),
    clear: () => void store.set({ levels: {} }),
    store
  }
}
