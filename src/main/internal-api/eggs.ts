// Hidden era pages (PLAN-FINAL 1.3, D-B3). The shell gesture calls eggs.open and the About hint calls
// eggs.openFromPage; both open the era's egg as a browser-initiated navigation from main (openPage reuses an open
// egg tab), never as a page navigation. The page only names an era: main maps it to the URL itself.
import { EGG_PAGES, eggUrl } from '../../shared/eggs'
import type { SkinId } from '../../shared/types'
import { openPage } from '../commands/dispatch'
import { IpcFailure, router } from '../ipc/router'
import type { WindowContext } from '../types'
import { windowOf } from './misc'

/** Open the era's egg in `w`. An era that is not a skin id is E_INVALID (the contract already rejects it). */
export function openEgg(w: WindowContext, era: SkinId): void {
  const url = typeof era === 'string' && Object.hasOwn(EGG_PAGES, era) ? eggUrl(era) : null
  if (!url) throw new IpcFailure('E_INVALID', 'Unknown era')
  openPage(w, url)
}

export function registerEggHandlers(): void {
  router.handle('eggs.open', (req, ctx) => {
    openEgg(windowOf(ctx), req.era)
    return null
  })
  router.handle('eggs.openFromPage', (req, ctx) => {
    openEgg(windowOf(ctx), req.era)
    return null
  })
}
