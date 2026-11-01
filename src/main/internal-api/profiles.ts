// profiles.* handlers for retronet://settings (T19). The profile manager does the work and throws IpcFailure
// (E_INVALID / E_NOT_FOUND), which passes straight through the router.
import { router } from '../ipc/router'
import { profileManager } from '../profiles/profile-manager'
import { profileOf, windowOf } from './misc'

export function registerProfileHandlers(): void {
  router.handle('profiles.list', (_req, ctx) => ({ profiles: profileManager().list(), currentId: profileOf(ctx).id }))

  router.handle('profiles.create', (req) => profileManager().create(req.name))

  router.handle('profiles.rename', (req) => {
    profileManager().rename(req.id, req.name)
    return null
  })

  // The manager shows the native confirmation, attached to the caller's window.
  router.handle('profiles.delete', async (req, ctx) => ({ deleted: await profileManager().delete(req.id, { parent: windowOf(ctx).win }) }))
}
