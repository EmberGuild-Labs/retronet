// retronet://settings "Default browser" row (AC47). Real work lives in os-integration/default-browser.ts.
import { router } from '../ipc/router'
import { getStatus, requestDefault } from '../os-integration/default-browser'

export function registerDefaultBrowserHandlers(): void {
  router.handle('defaultBrowser.status', () => getStatus())
  router.handle('defaultBrowser.set', () => requestDefault())
}
