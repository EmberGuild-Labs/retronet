import { SessionStateSchema } from '../../shared/ipc-contract'
import type { z } from 'zod'
import { createJsonStore, type JsonStore } from './json-store'
import { stripUrlCredentials } from './url-credentials'

export type SessionState = z.infer<typeof SessionStateSchema>
export type SessionWindowRecord = SessionState['windows'][number]

/** Q6: the saved addresses (tabs and their back/forward lists) without user:pass@. */
function withoutCredentials(windows: SessionWindowRecord[]): SessionWindowRecord[] {
  return windows.map((w) => ({
    ...w,
    tabs: w.tabs.map((t) => ({
      ...t,
      url: stripUrlCredentials(t.url),
      ...(t.history ? { history: { ...t.history, entries: t.history.entries.map((e) => ({ ...e, url: stripUrlCredentials(e.url) })) } } : {})
    }))
  }))
}

export interface SessionStore {
  /** Saved windows (empty if none). */
  load(): SessionWindowRecord[]
  /** Replace the saved session. Callers must never pass incognito windows. */
  save(windows: SessionWindowRecord[], at?: number): void
  clear(): void
  readonly store: JsonStore<SessionState>
}

export function createSessionStore(file: string | null, opts: { now?: () => number; debounceMs?: number } = {}): SessionStore {
  const now = opts.now ?? Date.now
  const store = createJsonStore<SessionState>({
    file,
    schema: SessionStateSchema,
    defaults: () => ({ version: 1, savedAt: 0, windows: [] }),
    debounceMs: opts.debounceMs ?? 500
  })
  return {
    load: () => store.get().windows,
    save(windows, at = now()) {
      store.set({ version: 1, savedAt: at, windows: withoutCredentials(windows) })
    },
    clear: () => void store.set({ version: 1, savedAt: now(), windows: [] }),
    store
  }
}
