// Internal-page handlers that belong to no single page: skin.get, app.info, counter.hit and the cert/net error
// interstitial actions (T19). Also the helpers every internal-api module shares: the caller's own window and
// profile come from `ctx.info.windowId`, never from anything the page sends (PLAN 1.5).
import { app } from 'electron'
import { platformKey } from '../../shared/commands'
import type { SkinEvent } from '../../shared/types'
import { IpcFailure, router, sendPageEvent, type CallContext } from '../ipc/router'
import { leaveCertError, proceedCertError, retryNetError } from '../security/cert-errors'
import { browserTabs } from '../tabs/tab-manager'
import type { ProfileContext, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

/** The caller's window; E_NOT_FOUND if it closed while the call was in flight. */
export function windowOf(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

/** The caller's profile (the incognito pseudo-profile for incognito windows). */
export function profileOf(ctx: CallContext): ProfileContext {
  return windowOf(ctx).profile
}

/** Push a skin event to every internal page open in any window (incognito ones included) of a profile. */
export function broadcastSkinToPages(profileId: string): void {
  for (const w of windowManager.forProfile(profileId)) {
    const s = w.profile.getSettings()
    const ev: SkinEvent = { skin: s.skin, reducedMotion: s.reducedMotion, incognito: w.incognito }
    for (const tab of browserTabs(w).list()) sendPageEvent(tab.wc, 'skin', ev)
  }
}

export function registerMiscHandlers(): void {
  router.handle('skin.get', (_req, ctx) => {
    const w = windowOf(ctx)
    const s = w.profile.getSettings()
    return { skin: s.skin, reducedMotion: s.reducedMotion, incognito: w.incognito, platform: platformKey(process.platform) }
  })

  router.handle('app.info', () => ({
    name: 'RetroNet',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: platformKey(process.platform),
    arch: process.arch,
    packaged: app.isPackaged
  }))

  // Incognito never touches the stored counter: the odometer shows dashes.
  router.handle('counter.hit', (_req, ctx) => {
    const p = profileOf(ctx)
    if (p.incognito) return { value: null }
    return { value: p.stores.counter.hit() }
  })

  // These act on the sender's own webContents; main checks it is showing an interstitial it loaded itself.
  router.handle('certerror.proceed', (_req, ctx) => {
    if (!proceedCertError(ctx.sender)) throw new IpcFailure('E_NOT_FOUND', 'No blocked page to continue to')
    return null
  })
  router.handle('certerror.back', (_req, ctx) => {
    if (!leaveCertError(ctx.sender)) throw new IpcFailure('E_NOT_FOUND', 'No blocked page to leave')
    return null
  })
  router.handle('neterror.retry', (_req, ctx) => {
    if (!retryNetError(ctx.sender)) throw new IpcFailure('E_NOT_FOUND', 'No failed page to retry')
    return null
  })
}
