// Registers every internal-page handler (T19). index.ts calls this once at ready, after router.install().
import { registerBookmarkHandlers } from './bookmarks'
import { registerBookmarksIoHandlers } from './bookmarks-io'
import { registerDefaultBrowserHandlers } from './default-browser'
import { registerDownloadHandlers } from './downloads'
import { registerEggHandlers } from './eggs'
import { registerHistoryHandlers } from './history'
import { registerMiscHandlers } from './misc'
import { registerProfileHandlers } from './profiles'
import { registerSettingsHandlers } from './settings'
import { registerUpdateHandlers } from './updates'

export function registerInternalApiHandlers(): void {
  registerMiscHandlers()
  registerHistoryHandlers()
  registerBookmarkHandlers()
  registerDownloadHandlers()
  registerSettingsHandlers()
  registerProfileHandlers()
  registerDefaultBrowserHandlers()
  registerBookmarksIoHandlers()
  registerUpdateHandlers()
  registerEggHandlers()
}
