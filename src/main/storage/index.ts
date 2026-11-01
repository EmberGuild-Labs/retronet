import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBookmarksStore, type BookmarksStore } from './bookmarks-store'
import { createCounterStore, type CounterStore } from './counter-store'
import { createDownloadsStore, type DownloadsStore } from './downloads-store'
import { createHistoryStore, type HistoryStore } from './history-store'
import { flushAllStores } from './json-store'
import { createPermissionStore, type PermissionStore } from './permission-store'
import { createSessionStore, type SessionStore } from './session-store'
import { createSettingsStore, type SettingsStore } from './settings-store'
import { createZoomStore, type ZoomStore } from './zoom-store'

export interface ProfileStores {
  history: HistoryStore
  bookmarks: BookmarksStore
  downloads: DownloadsStore
  settings: SettingsStore
  session: SessionStore
  counter: CounterStore
  zoom: ZoomStore
  permissions: PermissionStore
  /** Flush then unregister every store (profile/incognito disposal). */
  close(): Promise<void>
}

/**
 * All domain stores for one profile. Pass the profile directory for a persistent profile, or null for
 * incognito: every store then runs in memory and nothing is written.
 */
export function createProfileStores(dir: string | null): ProfileStores {
  if (dir) mkdirSync(dir, { recursive: true })
  const f = (name: string): string | null => (dir ? join(dir, name) : null)
  const s = {
    history: createHistoryStore(f('history.json')),
    bookmarks: createBookmarksStore(f('bookmarks.json')),
    downloads: createDownloadsStore(f('downloads.json')),
    settings: createSettingsStore(f('settings.json')),
    session: createSessionStore(f('session.json')),
    counter: createCounterStore(f('counter.json')),
    zoom: createZoomStore(f('zoom.json')),
    permissions: createPermissionStore(f('permissions.json'))
  }
  return {
    ...s,
    close: async () => {
      await Promise.all(Object.values(s).map((x) => x.store.close()))
    }
  }
}

/** Flush every live store (await in `before-quit`). Re-exported from json-store. */
export const flushAll = flushAllStores
export { flushAllStoresSync as flushAllSync } from './json-store'
