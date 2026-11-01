import { type AtomicFs, realFs, writeFileAtomic, writeFileAtomicSync, readJsonFileSync, backupCorruptFile, cleanStaleTmp } from './atomic-json'

/** Structural subset of a zod schema, so stores need no direct zod import. */
export interface StoreSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error?: unknown }
}

export interface JsonStoreOptions<T> {
  /** Absolute path of the JSON file, or null for memory mode (incognito): nothing is ever read or written. */
  file: string | null
  schema: StoreSchema<T>
  /** Value used when the file is missing or corrupt. A factory is called once per fallback. */
  defaults: T | (() => T)
  /** Trailing debounce for writes in ms. 0 writes on the next tick. Default 250. */
  debounceMs?: number
  /** Upgrade raw parsed JSON (older shape) to the current shape before schema validation. */
  migrate?: (raw: unknown) => unknown
  /** Called on write failure or when a corrupt file was set aside. */
  onError?: (err: unknown, ctx: 'write' | 'corrupt') => void
  /** Override the fs layer (tests). */
  fs?: AtomicFs
}

export interface JsonStore<T> {
  /** Current value. Treat as read-only; use update/set to change it. */
  get(): T
  /** Mutate the draft in place (return nothing) or return a replacement value. Schedules a debounced write. */
  update(fn: (draft: T) => T | void): T
  set(value: T): T
  /** Resolve once everything pending is on disk. No-op in memory mode. */
  flush(): Promise<void>
  /** Synchronous flush for the quit path. */
  flushSync(): void
  /** True when there are unsaved changes. */
  readonly dirty: boolean
  readonly memory: boolean
  /** Flush then stop. The store is removed from the global registry. */
  close(): Promise<void>
  /**
   * Called synchronously after every update/set (memory stores too), with the new value. Listener errors are
   * swallowed so one bad listener can't break a mutation. Returns an unsubscribe function.
   */
  onChange(listener: (value: T) => void): () => void
}

const registry = new Set<JsonStore<unknown>>()

/** Flush every live file-backed store. Call from `before-quit` and await it. */
export async function flushAllStores(): Promise<void> {
  await Promise.all([...registry].map((s) => s.flush()))
}

/** Last-chance synchronous flush of every live store (e.g. `will-quit`). */
export function flushAllStoresSync(): void {
  for (const s of registry) s.flushSync()
}

export function createJsonStore<T>(opts: JsonStoreOptions<T>): JsonStore<T> {
  const fs = opts.fs ?? realFs
  const debounceMs = opts.debounceMs ?? 250
  const file = opts.file
  const memory = file === null
  const makeDefaults = (): T => (typeof opts.defaults === 'function' ? (opts.defaults as () => T)() : structuredClone(opts.defaults))

  const load = (): T => {
    if (file === null) return makeDefaults()
    cleanStaleTmp(file, fs)
    const res = readJsonFileSync(file, fs)
    if (res.status === 'missing') return makeDefaults()
    if (res.status === 'ok') {
      try {
        const migrated = opts.migrate ? opts.migrate(res.value) : res.value
        const parsed = opts.schema.safeParse(migrated)
        if (parsed.success) return parsed.data
        opts.onError?.(parsed.error ?? new Error('schema validation failed'), 'corrupt')
      } catch (err) {
        opts.onError?.(err, 'corrupt')
      }
    } else {
      opts.onError?.(new Error(res.error), 'corrupt')
    }
    backupCorruptFile(file, fs)
    return makeDefaults()
  }

  let value = load()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  let closed = false
  const listeners = new Set<(v: T) => void>()
  const notify = (): void => {
    for (const l of [...listeners]) {
      try {
        l(value)
      } catch {
        /* a listener's problem, not the store's */
      }
    }
  }

  const serialize = (): string => JSON.stringify(value)

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  // Runs writes one at a time; a change during a write re-marks dirty and loops.
  const drain = (): Promise<void> => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        while (dirty && file !== null) {
          dirty = false
          try {
            await writeFileAtomic(file, serialize(), fs)
          } catch (err) {
            dirty = true // keep the data; a later update/flush retries
            opts.onError?.(err, 'write')
            return
          }
        }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  const schedule = (): void => {
    if (memory || closed) return
    dirty = true
    if (timer) return // coalesce: one pending write covers every update in the window
    timer = setTimeout(() => {
      timer = null
      void drain()
    }, debounceMs)
  }

  const store: JsonStore<T> = {
    get: () => value,
    update(fn) {
      const out = fn(value)
      if (out !== undefined) value = out
      schedule()
      notify()
      return value
    },
    set(v) {
      value = v
      schedule()
      notify()
      return value
    },
    async flush() {
      if (memory) return
      clearTimer()
      if (inflight) await inflight
      if (dirty) await drain()
    },
    flushSync() {
      if (memory || file === null) return
      clearTimer()
      if (!dirty) return
      try {
        writeFileAtomicSync(file, serialize(), fs)
        dirty = false
      } catch (err) {
        opts.onError?.(err, 'write')
      }
    },
    get dirty() {
      return dirty
    },
    memory,
    async close() {
      await store.flush()
      closed = true
      listeners.clear()
      registry.delete(store as JsonStore<unknown>)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
  if (!memory) registry.add(store as JsonStore<unknown>)
  return store
}
