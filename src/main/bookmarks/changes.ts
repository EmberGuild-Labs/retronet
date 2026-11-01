// Bookmark-change push (FIX-GAPS, R5). Bookmarks change from several places (internal-api bookmarks.*, T16's
// bookmarks.toggleCurrent / Cmd+D), so this listens to the store itself (JsonStore.onChange): every mutation,
// from anywhere, asks every window that uses that store for a fresh state snapshot (the star follows at once)
// and sends the shell the `bookmarks` event (the bookmark bar re-reads its folder). Incognito windows share
// their parent profile's bookmarks store (D7), so they follow too.
//
// Several mutations in one synchronous operation (a folder move, an import) are coalesced into one push.
import { browserTabs } from '../tabs/tab-manager'
import { windowManager } from '../windows/window-manager'
import type { BookmarksStore } from '../storage/bookmarks-store'
import type { WindowContext } from '../types'

const watched = new WeakSet<object>()
const queued = new WeakSet<object>()

function pushSharing(store: BookmarksStore): void {
  for (const w of windowManager.all()) {
    if (w.profile.stores.bookmarks !== store || w.win.isDestroyed()) continue
    browserTabs(w).refresh()
    w.sendShell('bookmarks', null)
  }
}

/** Tell every window using this store that its bookmarks changed (once per synchronous burst). */
export function notifyBookmarksChanged(store: BookmarksStore): void {
  if (queued.has(store)) return
  queued.add(store)
  queueMicrotask(() => {
    queued.delete(store)
    pushSharing(store)
  })
}

/** Idempotent: push one store's mutations. */
export function watchBookmarks(store: BookmarksStore): void {
  if (watched.has(store)) return
  watched.add(store)
  store.store.onChange(() => notifyBookmarksChanged(store))
}

/** Watch the stores of every current and future window (windows are created after profiles, so this is enough). */
export function watchAllWindowBookmarks(): void {
  const hook = (w: WindowContext): void => watchBookmarks(w.profile.stores.bookmarks)
  for (const w of windowManager.all()) hook(w)
  windowManager.onWindowCreated(hook)
}
