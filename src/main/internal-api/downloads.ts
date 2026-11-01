// retronet://downloads handlers (T19), all through T14's per-session DownloadService. Ids are looked up in the
// caller's own session only; open/show take an id, never a path.
import { downloadService, type DownloadService } from '../downloads/download-manager'
import { IpcFailure, router, type CallContext } from '../ipc/router'
import { profileOf } from './misc'

function serviceOf(ctx: CallContext): DownloadService {
  const s = downloadService(profileOf(ctx))
  if (!s) throw new IpcFailure('E_UNAVAILABLE', 'Downloads are not available')
  return s
}

/** Service methods that return false for an unknown or wrong-state id. */
function boolMethod(name: 'pause' | 'resume' | 'cancel' | 'show' | 'remove', message: string): void {
  const method = `downloads.${name}` as const
  router.handle(method, (req, ctx) => {
    if (!serviceOf(ctx)[name](req.id)) throw new IpcFailure('E_NOT_FOUND', message)
    return null
  })
}

export function registerDownloadHandlers(): void {
  router.handle('downloads.list', (_req, ctx) => ({ items: serviceOf(ctx).list() }))

  boolMethod('pause', 'That download cannot be paused')
  boolMethod('resume', 'That download cannot be resumed')
  boolMethod('cancel', 'That download cannot be cancelled')
  boolMethod('show', 'That file is not available')
  boolMethod('remove', 'That download cannot be removed')

  router.handle('downloads.open', async (req, ctx) => {
    try {
      await serviceOf(ctx).open(req.id)
    } catch (err) {
      if (err instanceof IpcFailure) throw err
      throw new IpcFailure('E_NOT_FOUND', 'That file is not available')
    }
    return null
  })

  router.handle('downloads.showFolder', async (_req, ctx) => {
    await serviceOf(ctx).showFolder()
    return null
  })

  router.handle('downloads.clear', (_req, ctx) => {
    serviceOf(ctx).clearFinished()
    return null
  })
}
