// Registers every internal-page handler (T19). index.ts calls this once at ready, after router.install().
import { registerBookmarkHandlers } from './bookmarks'
import { registerDownloadHandlers } from './downloads'
import { registerHistoryHandlers } from './history'
import { registerMiscHandlers } from './misc'
import { registerProfileHandlers } from './profiles'
import { registerSettingsHandlers } from './settings'

export function registerInternalApiHandlers(): void {
  registerMiscHandlers()
  registerHistoryHandlers()
  registerBookmarkHandlers()
  registerDownloadHandlers()
  registerSettingsHandlers()
  registerProfileHandlers()
}
