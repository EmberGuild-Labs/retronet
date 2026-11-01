// retronet://about "Check for updates" (AC52, AC53, U5). The only caller of checkForUpdate: nothing here runs
// at import, at launch or on page load, so the network is touched only when the user clicks. Download opens
// the URL main kept from the last `available` result; the page never sends a URL.
import { app } from 'electron'
import { IpcFailure, router } from '../ipc/router'
import { browserTabs } from '../tabs/tab-manager'
import { effectiveFeedUrl, resolveOverride, type FeedGate } from '../updates/feed-config'
import { CheckThrottle, UPDATE_MIN_INTERVAL_MS, checkForUpdate } from '../updates/update-check'
import { windowOf } from './misc'

function gate(): FeedGate {
  return { packaged: app.isPackaged, e2e: process.env.RETRONET_E2E === '1' }
}

/** Main-held download URL of the last real check; null unless that check said `available`. */
let lastDownloadUrl: string | null = null
let throttle: CheckThrottle | null = null

/** Test override feeds (gated, loopback only) skip the 10 s spacing so E2E can click through states. */
function throttleFor(testFeed: boolean): CheckThrottle {
  throttle ??= new CheckThrottle(testFeed ? 0 : UPDATE_MIN_INTERVAL_MS)
  return throttle
}

export function registerUpdateHandlers(): void {
  router.handle('updates.status', () => ({
    enabled: effectiveFeedUrl(process.env, gate()) !== null,
    current: app.getVersion()
  }))

  router.handle('updates.check', async () => {
    const g = gate()
    const feedUrl = effectiveFeedUrl(process.env, g)
    if (!feedUrl) throw new IpcFailure('E_UNAVAILABLE', 'Update check is not configured')
    const { result, downloadUrl } = await checkForUpdate({
      feedUrl,
      currentVersion: app.getVersion(),
      throttle: throttleFor(resolveOverride(process.env, g) !== null)
    })
    // A `busy` answer made no request, so it keeps the previous result's download.
    if (!(result.state === 'error' && result.error === 'busy')) lastDownloadUrl = downloadUrl
    return result
  })

  // Foreground tab in the caller's window, through tabs.create so decideBrowserNavigation still applies.
  router.handle('updates.openDownload', (_req, ctx) => {
    if (!lastDownloadUrl) throw new IpcFailure('E_NOT_FOUND', 'No update to download')
    const tab = browserTabs(windowOf(ctx)).create({ url: lastDownloadUrl })
    if (!tab) throw new IpcFailure('E_FORBIDDEN', 'That download address is blocked')
    return null
  })
}

/** Unit tests only: forget the last result and the throttle. */
export function resetUpdateHandlersForTests(): void {
  lastDownloadUrl = null
  throttle = null
}
