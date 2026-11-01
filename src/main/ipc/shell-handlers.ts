// Shell and overlay IPC handlers: layout, overlay, the shell.ready mark (T7) and the tab methods (T12).
// Other shell methods (groups, omnibox, find, commands, menus) are registered by their own modules via
// `router.handle`, never here (PLAN 4).
import { logger } from '../logger'
import { registerMenuHostHandlers } from '../menus/menu-host'
import { takeEggHint } from '../omnibox'
import { browserTabs, type BrowserTabManager, type Tab } from '../tabs/tab-manager'
import { markTiming, timings } from '../test-hooks'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { IpcFailure, router, type CallContext } from './router'

function windowOf(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

function tabsOf(ctx: CallContext): BrowserTabManager {
  return browserTabs(windowOf(ctx))
}

/** A tab of the caller's own window (a shell can never touch another window's tabs). */
function tabOf(ctx: CallContext, tabId: number | undefined): Tab {
  const tabs = tabsOf(ctx)
  const tab = tabId === undefined ? tabs.active() : tabs.get(tabId)
  if (!tab) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
  return tab
}

function registerTabHandlers(): void {
  router.handle('tabs.create', (req, ctx) => {
    const tabs = tabsOf(ctx)
    if (req.groupId !== undefined && !tabs.getGroup(req.groupId)) throw new IpcFailure('E_NOT_FOUND', 'No such group')
    const tab = tabs.create({ url: req.url, background: req.background, groupId: req.groupId })
    if (!tab) throw new IpcFailure('E_INVALID', 'That address cannot be opened')
    return { tabId: tab.id }
  })

  router.handle('tabs.close', (req, ctx) => {
    tabsOf(ctx).close(tabOf(ctx, req.tabId).id)
    return null
  })

  router.handle('tabs.activate', (req, ctx) => {
    tabsOf(ctx).activate(tabOf(ctx, req.tabId).id)
    return null
  })

  router.handle('tabs.move', (req, ctx) => {
    tabsOf(ctx).move(tabOf(ctx, req.tabId).id, req.index)
    return null
  })

  router.handle('tabs.pin', (req, ctx) => {
    tabsOf(ctx).pin(tabOf(ctx, req.tabId).id, req.pinned)
    return null
  })

  router.handle('tabs.toggleMute', (req, ctx) => {
    tabOf(ctx, req.tabId).toggleMute()
    return null
  })

  router.handle('tabs.navigate', (req, ctx) => {
    if (req.tabId !== undefined) tabOf(ctx, req.tabId)
    // ↓ + Enter on the y2001 "wiki wiki" hint row opens the egg like eggs.open (DESIGN-EGGS 4.1), not a typed nav.
    if (takeEggHint(windowOf(ctx), req.input)) return { blocked: false }
    const ok = tabsOf(ctx).navigate(req.input, { tabId: req.tabId, disposition: req.disposition })
    return { blocked: !ok }
  })

  router.handle('tabs.back', (req, ctx) => {
    tabOf(ctx, req.tabId).back()
    return null
  })

  router.handle('tabs.forward', (req, ctx) => {
    tabOf(ctx, req.tabId).forward()
    return null
  })

  router.handle('tabs.reload', (req, ctx) => {
    tabOf(ctx, req.tabId).reload(req.ignoreCache ?? false)
    return null
  })

  router.handle('tabs.stop', (req, ctx) => {
    tabOf(ctx, req.tabId).stop()
    return null
  })

  router.handle('tabs.home', (req, ctx) => {
    tabsOf(ctx).home(tabOf(ctx, req.tabId).id)
    return null
  })
}

export function registerShellHandlers(): void {
  registerTabHandlers()
  registerMenuHostHandlers()

  router.handle('layout.setInsets', (req, ctx) => {
    windowManager.setInsets(windowOf(ctx).id, req)
    return null
  })

  router.handle('overlay.close', (_req, ctx) => {
    windowOf(ctx).hideOverlay()
    return null
  })

  router.handle('overlay.dialogResult', (req, ctx) => {
    const w = windowOf(ctx)
    if (!windowManager.resolveDialog(w.id, req.dialogId, req.value)) throw new IpcFailure('E_NOT_FOUND', 'No such dialog')
    w.hideOverlay()
    return null
  })

  router.handle('shell.ready', () => {
    const first = !('shellReady' in timings)
    const ms = markTiming('shellReady')
    if (first) logger.info(`cold launch: first shell ready ${ms} ms after process start`)
    return null
  })
}
