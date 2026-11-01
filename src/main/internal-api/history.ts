// retronet://history (guestbook) handlers (T19). Always the caller's own profile's store; incognito windows
// see their memory-only store.
import { IpcFailure, router } from '../ipc/router'
import { profileOf } from './misc'

export function registerHistoryHandlers(): void {
  router.handle('history.query', (req, ctx) => profileOf(ctx).stores.history.query(req))

  router.handle('history.delete', (req, ctx) => {
    if (!profileOf(ctx).stores.history.delete(req.id)) throw new IpcFailure('E_NOT_FOUND', 'No such entry')
    return null
  })

  router.handle('history.clear', (_req, ctx) => {
    profileOf(ctx).stores.history.clear('all')
    return null
  })
}
