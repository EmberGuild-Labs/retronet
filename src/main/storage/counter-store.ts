import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { createJsonStore, type JsonStore } from './json-store'

const FileSchema = z.object({ value: z.number().int().nonnegative() })
type CounterData = z.infer<typeof FileSchema>

export interface CounterStore {
  /** Increment and return the new value (the odometer shows it). */
  hit(): number
  value(): number
  readonly store: JsonStore<CounterData>
}

/** Visitor counter seeded with a random 6-digit number the first time the file is created. */
export function createCounterStore(file: string | null, opts: { seed?: () => number; debounceMs?: number } = {}): CounterStore {
  const seed = opts.seed ?? (() => randomInt(100_000, 1_000_000))
  const store = createJsonStore<CounterData>({ file, schema: FileSchema, defaults: () => ({ value: seed() }), debounceMs: opts.debounceMs })
  return {
    hit: () => store.update((d) => void d.value++).value,
    value: () => store.get().value,
    store
  }
}
