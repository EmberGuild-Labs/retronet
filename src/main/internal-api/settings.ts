// retronet://settings handlers (T19): settings get/set, the downloads-folder picker, permissions, data.clear.
// Incognito windows read and write their parent profile's settings (their own stores are memory-only and hold
// no appearance state, see profiles/incognito.ts). Skin / reduced-motion / bookmark-bar changes are pushed to
// every shell and overlay of the profile (refreshProfile, incognito windows included) and to its internal pages.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dialog } from 'electron'
import { SEARCH_ENGINES } from '../../shared/search-engines'
import type { Settings } from '../../shared/types'
import { sendPageEvent, IpcFailure, router, type CallContext } from '../ipc/router'
import { profileManager } from '../profiles/profile-manager'
import { clearCertOverrides } from '../security/cert-errors'
import { browserTabs } from '../tabs/tab-manager'
import type { ProfileContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { broadcastSkinToPages, profileOf, windowOf } from './misc'

/** The profile that owns the settings file: the parent profile for incognito windows. */
function settingsOwner(ctx: CallContext): ProfileContext {
  const p = profileOf(ctx)
  if (!p.incognito) return p
  const parent = profileManager().get(p.id)
  if (!parent) throw new IpcFailure('E_NOT_FOUND', 'No such profile')
  return parent
}

/** Apply a patch to the owner's store and fan out appearance changes. */
function applyPatch(owner: ProfileContext, patch: Partial<Settings>): Settings {
  const before = { ...owner.stores.settings.get() }
  let after: Settings
  try {
    after = owner.stores.settings.patch(patch)
  } catch {
    throw new IpcFailure('E_INVALID', 'Invalid setting')
  }
  if (after.skin !== before.skin || after.reducedMotion !== before.reducedMotion || after.bookmarkBar !== before.bookmarkBar) {
    windowManager.refreshProfile(owner.id)
  }
  if (after.skin !== before.skin || after.reducedMotion !== before.reducedMotion) broadcastSkinToPages(owner.id)
  return after
}

export function registerSettingsHandlers(): void {
  // The newtab search box label and target follow the (parent) profile's chosen engine.
  router.handle('search.engine', (_req, ctx) => {
    const id = settingsOwner(ctx).stores.settings.get().searchEngine
    const engine = SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!
    return { id: engine.id, name: engine.name }
  })
  router.handle('settings.get', (_req, ctx) => ({ ...settingsOwner(ctx).stores.settings.get() }))

  router.handle('settings.set', (req, ctx) => {
    const owner = settingsOwner(ctx)
    // The downloads folder is only ever chosen through dialog.pickFolder (native picker). A path sent by a page
    // is accepted only if it already is the current value; null (back to the OS default) is always fine.
    if (typeof req.downloadsDir === 'string' && req.downloadsDir !== owner.stores.settings.get().downloadsDir) {
      throw new IpcFailure('E_INVALID', 'Choose the downloads folder with the folder picker')
    }
    return { ...applyPatch(owner, req) }
  })

  router.handle('dialog.pickFolder', async (_req, ctx) => {
    const owner = settingsOwner(ctx)
    const win = windowOf(ctx).win
    const opts = { title: 'Choose downloads folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const res = await dialog.showOpenDialog(win, opts)
    const picked = res.canceled ? undefined : res.filePaths[0]
    if (!picked) return { path: null }
    try {
      if (!isAbsolute(picked) || !statSync(picked).isDirectory()) return { path: null }
    } catch {
      return { path: null }
    }
    applyPatch(owner, { downloadsDir: picked })
    return { path: picked }
  })

  router.handle('permissions.list', (_req, ctx) => ({ items: profileOf(ctx).stores.permissions.list() }))

  router.handle('permissions.reset', (req, ctx) => {
    profileOf(ctx).stores.permissions.reset(req.origin, req.kind)
    return null
  })

  // D3: the time range applies to history and downloads. Electron cannot time-bound cookies or cache, so those
  // are always cleared completely (the settings UI says so).
  router.handle('data.clear', async (req, ctx) => {
    const p = profileOf(ctx)
    if (req.history) p.stores.history.clear(req.range)
    if (req.downloads) {
      p.stores.downloads.clearRange(req.range)
      for (const w of windowManager.forProfile(p.id)) {
        if (w.profile.partition !== p.partition) continue
        for (const tab of browserTabs(w).list()) sendPageEvent(tab.wc, 'downloads', { type: 'reset' }, 'downloads')
      }
    }
    if (req.cookies) {
      await p.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem']
      })
      // N8: "Proceed anyway" certificate decisions are site data too; forget them with the cookies. HTTP auth
      // credentials Chromium cached for the session go with them. F2: kept-alive connections would keep using a
      // certificate the user clicked Proceed on (and its cached auth), so close them too.
      clearCertOverrides(p.session)
      await p.session.clearAuthCache()
      await p.session.closeAllConnections()
    }
    if (req.cache) await p.session.clearCache()
    return null
  })
}
