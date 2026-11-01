// Command dispatch (PLAN 1.3, AC5-AC8, AC21-AC23). One `runCommand` for every registry id, used by the app
// menu, the shortcut handler, the context menus and `commands.run` (shell toolbar, overlay palette).
// `registerCommands()` is the single entry point index.ts calls once (after createProfileManager): it registers
// commands.run, commands.list, find.*, profiles.menu and bookmarks.toggleCurrent, sets the app menu, and wires
// shortcuts, page context menus and wheel zoom on every shell, overlay and tab webContents (existing ones too).
import { app, BrowserWindow, Menu, webContents as allWebContents, type WebContents } from 'electron'
import {
  commandsFor,
  getCommand,
  isCommandId,
  platformKey,
  type CommandId,
  type Platform
} from '../../shared/commands'
import { NEWTAB_URL } from '../../shared/settings'
import { isSkinId } from '../../shared/skins'
import { BOOKMARK_BAR_ID } from '../../shared/types'
import { broadcastSkinToPages } from '../internal-api/misc'
import { IpcFailure, router, type CallContext } from '../ipc/router'
import { logger } from '../logger'
import { profileManager } from '../profiles/profile-manager'
import { UI_ONLY_HOSTS } from '../protocol/retronet-protocol'
import { stripUrlCredentials } from '../storage/url-credentials'
import { showMenu, type ShowMenuOptions } from '../menus/menu-host'
import { createGroupFromTab } from '../tabs/groups'
import type { Tab } from '../tabs/tab'
import { browserTabs, onTabStructureChanged } from '../tabs/tab-manager'
import type { ProfileContext, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { attachContextMenu, buildProfilesMenu, normalWindowFor, openInTab } from './context-menu'
import * as find from './find'
import { buildMenuTemplate, viewSourceUrlFor } from './menu'
import { attachShortcuts } from './shortcuts'
import { attachWheelZoom, zoomActive } from './zoom'

const PLATFORM: Platform = platformKey(process.platform)

/** Thrown for a command run with a missing or bad argument (becomes E_INVALID over IPC). */
function invalid(msg: string): never {
  throw new IpcFailure('E_INVALID', msg)
}

/** The profile that owns settings (incognito windows edit their parent's, like settings.set does). */
function settingsOwner(w: WindowContext): ProfileContext {
  if (!w.profile.incognito) return w.profile
  return profileManager().get(w.profile.id) ?? invalid('No such profile')
}

/** Every window showing this profile context (same stores), for refreshing the star or zoom. */
function windowsSharing(p: ProfileContext): WindowContext[] {
  return windowManager.all().filter((x) => x.profile === p)
}

/** Tabs the user can reach with Ctrl+Tab / Cmd+1..9: members of collapsed groups are skipped. */
function visibleTabs(w: WindowContext): readonly Tab[] {
  const tabs = browserTabs(w)
  const collapsed = new Set(tabs.groups().filter((g) => g.collapsed).map((g) => g.id))
  const activeId = tabs.active()?.id
  return tabs.list().filter((t) => !t.groupId || !collapsed.has(t.groupId) || t.id === activeId)
}

function cycleTab(w: WindowContext, delta: 1 | -1): void {
  const list = visibleTabs(w)
  if (list.length < 2) return
  const at = list.findIndex((t) => t.id === browserTabs(w).active()?.id)
  const next = list[(at + delta + list.length) % list.length]
  if (next) browserTabs(w).activate(next.id)
}

function focusOmnibox(w: WindowContext): void {
  if (w.win.isDestroyed()) return
  w.shell.focus()
  w.sendShell('ui', { action: 'focus-omnibox' })
}

/**
 * Open an internal page: reuse a tab already showing that page (same host), else take over an untouched new
 * tab, else open a new foreground tab.
 */
export function openPage(w: WindowContext, url: string): void {
  const target = normalWindowFor(w)
  const tabs = browserTabs(target)
  const host = new URL(url).host
  const existing = tabs.list().find((t) => {
    try {
      const u = new URL(t.url())
      return u.protocol === 'retronet:' && u.host === host
    } catch {
      return false
    }
  })
  if (existing) {
    tabs.activate(existing.id)
    if (url !== existing.url() && new URL(url).hash) tabs.loadUrl(existing.id, url)
  } else {
    const active = tabs.active()
    if (active && active.url() === NEWTAB_URL && !active.wc.navigationHistory.canGoBack()) tabs.loadUrl(active.id, url)
    else tabs.create({ url })
  }
  if (target !== w) target.win.focus()
}

/** Toggle a bookmark for the active tab's address (Cmd/Ctrl+D, omnibox star). Returns the new state. */
export function toggleBookmark(w: WindowContext): boolean {
  const tab = browserTabs(w).active()
  const url = tab?.state().url ?? ''
  if (!tab || !url) return false
  const store = w.profile.stores.bookmarks
  let bookmarked: boolean
  if (store.isBookmarked(url)) {
    store.removeByUrl(url)
    bookmarked = false
  } else {
    const st = tab.state()
    // F1: the store drops `user:pass@` from the url; the title fallback must not keep it either.
    const title = st.title || stripUrlCredentials(url)
    bookmarked = store.add({ parentId: BOOKMARK_BAR_ID, title, url, faviconDataUrl: st.faviconDataUrl }) !== null
  }
  for (const x of windowsSharing(w.profile)) browserTabs(x).refresh()
  return bookmarked
}

function setSkin(w: WindowContext, skin: string): void {
  if (!isSkinId(skin)) invalid('Unknown skin')
  const owner = settingsOwner(w)
  if (owner.stores.settings.get().skin === skin) return
  owner.stores.settings.patch({ skin })
  windowManager.refreshProfile(owner.id)
  broadcastSkinToPages(owner.id)
  scheduleMenuRebuild()
}

function toggleBookmarkBar(w: WindowContext): void {
  const owner = settingsOwner(w)
  owner.stores.settings.patch({ bookmarkBar: !owner.stores.settings.get().bookmarkBar })
  windowManager.refreshProfile(owner.id)
  scheduleMenuRebuild()
}

/** Command palette (overlay; T20 draws it). Commands and skins come from the shared registries, tabs from state. */
export function openPalette(w: WindowContext): void {
  if (w.popup) return
  if (w.overlayKind() === 'palette') {
    w.hideOverlay()
    return
  }
  w.showOverlay({ kind: 'palette', profiles: profileManager().list(), currentProfileId: w.profile.id }, { focus: true })
}

async function newProfile(w: WindowContext): Promise<void> {
  const name = await w.showDialog({
    kind: 'text',
    id: `new-profile-${Date.now()}`,
    title: 'New profile',
    label: 'Profile name',
    value: '',
    okLabel: 'Create'
  })
  if (typeof name !== 'string' || !name.trim()) return
  const info = profileManager().create(name)
  profileManager().newWindow(info.id)
}

function toggleDevTools(w: WindowContext): void {
  const tab = browserTabs(w).active()
  if (!tab || tab.wc.isDestroyed()) return
  if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools()
  else tab.wc.openDevTools({ mode: 'detach' })
}

/**
 * Q4: the native print dialog for the active tab. Internal pages print fine; the shell and overlay hosts are
 * never shown in a tab, and a tab whose renderer is gone has nothing to print.
 */
export function printTab(tab: Tab | null | undefined): boolean {
  if (!tab || tab.wc.isDestroyed() || tab.wc.isCrashed()) return false
  if (isUiOnlyUrl(tab.url())) return false
  tab.wc.print({}, (ok, reason) => {
    if (!ok && reason !== 'cancelled' && reason !== 'Print job canceled') logger.warn(`print failed: ${reason}`)
  })
  return true
}

function isUiOnlyUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'retronet:' && (UI_ONLY_HOSTS as readonly string[]).includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

const PAGE_URLS: Partial<Record<CommandId, string>> = {
  'page.bookmarks': 'retronet://bookmarks/',
  'page.history': 'retronet://history/',
  'page.downloads': 'retronet://downloads/',
  'page.settings': 'retronet://settings/',
  'page.shortcuts': 'retronet://shortcuts/',
  'page.about': 'retronet://about/',
  'data.clear': 'retronet://settings/#privacy'
}

/** Commands that make sense with no window open (mac, all windows closed). */
function runWithoutWindow(id: CommandId, arg?: string): void {
  const pm = profileManager()
  switch (id) {
    case 'tab.new':
    case 'window.new':
      pm.newWindow(pm.lastUsed().id)
      return
    case 'window.newIncognito':
      pm.newIncognitoWindow()
      return
    case 'profile.switch':
      if (arg) pm.switchTo(arg)
      return
    case 'app.quit':
      app.quit()
      return
    default: {
      const url = PAGE_URLS[id]
      if (url) pm.newWindow(pm.lastUsed().id, { initialUrl: url })
    }
  }
}

/**
 * Run a registry command in a window (null = no window open). `arg` is a skin id for skin.switch and a profile id
 * for profile.switch. Throws IpcFailure for bad arguments; everything else is best effort.
 */
export function runCommand(w: WindowContext | null, id: CommandId, arg?: string): void {
  const def = getCommand(id)
  if (!def) invalid('Unknown command')
  if (arg !== undefined && !def.arg) invalid(`${id} takes no argument`)
  if (!w || w.win.isDestroyed()) {
    runWithoutWindow(id, arg)
    return
  }
  const tabs = browserTabs(w)
  const pm = profileManager()
  const active = tabs.active()

  const page = PAGE_URLS[id]
  if (page) {
    openPage(w, page)
    return
  }
  const sel = /^tab\.select([1-8])$/.exec(id)
  if (sel) {
    const t = visibleTabs(w)[Number(sel[1]) - 1]
    if (t) tabs.activate(t.id)
    return
  }

  switch (id) {
    // Tabs
    case 'tab.new': {
      const target = normalWindowFor(w)
      if (browserTabs(target).create()) focusOmnibox(target)
      if (target !== w) target.win.focus()
      return
    }
    case 'tab.close':
      if (w.popup) w.close()
      else if (active) tabs.close(active.id)
      return
    case 'tab.reopenClosed':
      browserTabs(normalWindowFor(w)).reopenClosed()
      return
    case 'tab.next':
      cycleTab(w, 1)
      return
    case 'tab.previous':
      cycleTab(w, -1)
      return
    case 'tab.selectLast': {
      const list = visibleTabs(w)
      const last = list[list.length - 1]
      if (last) tabs.activate(last.id)
      return
    }
    case 'tab.togglePin':
      if (active && !w.popup) tabs.pin(active.id, !active.pinned)
      return
    case 'tab.toggleMute':
      if (active) tabs.toggleMute(active.id)
      return
    case 'tab.addToNewGroup':
      if (active && !w.popup) createGroupFromTab(tabs, active.id)
      return

    // Windows
    case 'window.new':
      pm.newWindow(w.profile.id)
      return
    case 'window.newIncognito':
      pm.newIncognitoWindow(w.profile.id)
      return
    case 'window.close':
      w.close()
      return

    // Navigation
    case 'nav.back':
      tabs.back()
      return
    case 'nav.forward':
      tabs.forward()
      return
    case 'nav.reload':
      tabs.reload()
      return
    case 'nav.hardReload':
      tabs.reload(undefined, true)
      return
    case 'nav.stop':
      tabs.stop()
      return
    case 'nav.home':
      tabs.home()
      return
    case 'omnibox.focus':
      focusOmnibox(w)
      return

    // Find
    case 'find.open':
      find.open(w)
      return
    case 'find.next':
    case 'find.previous':
      if (find.lastQuery(w) === '') find.open(w)
      else find.next(w, id === 'find.next')
      return

    // View
    case 'zoom.in':
      zoomActive(w, 'in')
      return
    case 'zoom.out':
      zoomActive(w, 'out')
      return
    case 'zoom.reset':
      zoomActive(w, 'reset')
      return
    case 'view.toggleFullscreen':
      w.win.setFullScreen(!w.win.isFullScreen())
      return
    case 'bookmarkBar.toggle':
      toggleBookmarkBar(w)
      return
    case 'bookmark.toggle':
      toggleBookmark(w)
      return

    // Tools
    case 'devtools.toggle':
      toggleDevTools(w)
      return
    case 'page.viewSource': {
      const target = active ? viewSourceUrlFor(active.url()) : null
      if (target) tabs.create({ url: target, openerId: active!.id })
      return
    }
    case 'palette.open':
      openPalette(w)
      return
    case 'file.print':
      printTab(active)
      return

    // Appearance and profiles (no argument: let the palette expand the choices)
    case 'skin.switch':
      if (arg === undefined) openPalette(w)
      else setSkin(w, arg)
      return
    case 'profile.switch':
      if (arg === undefined) openPalette(w)
      else pm.switchTo(arg)
      return
    case 'profile.new':
      void newProfile(w).catch((err: unknown) => logger.warn('new profile failed', err))
      return

    case 'app.quit':
      app.quit()
      return
    default:
      logger.warn(`command ${id} has no action`)
  }
}

/** Run from a menu, shortcut or context menu: errors are logged, never thrown into Electron callbacks. */
function runSafely(w: WindowContext | null, id: CommandId, arg?: string): void {
  try {
    runCommand(w, id, arg)
  } catch (err) {
    logger.warn(`command ${id} failed`, err instanceof IpcFailure ? err.message : err)
  }
}

// ---- Window and webContents resolution ----

function windowOfCtx(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

function resolveWc(wc: WebContents): { w: WindowContext; role: 'shell' | 'overlay' | 'tab'; tab: Tab | null } | null {
  if (wc.isDestroyed()) return null
  const info = router.senderInfo(wc)
  if (!info) return null
  const w = windowManager.get(info.windowId)
  if (!w) return null
  const tab = info.role === 'tab' && info.tabId !== undefined ? browserTabs(w).get(info.tabId) : null
  return { w, role: info.role, tab }
}

/** Window for a menu click: the BrowserWindow Electron passes, else the focused RetroNet window. */
function windowForMenu(bw: BrowserWindow | undefined): WindowContext | null {
  if (bw) {
    const own = windowManager.all().find((x) => x.win === bw)
    if (own) return own
  }
  return windowManager.focused()
}

// ---- App menu ----

let menuTimer: NodeJS.Immediate | null = null

/**
 * What the app menu shows that depends on tabs (R22/E4): the focused window, its active tab and whether
 * "View Page Source" is enabled for that tab's URL.
 */
export interface AppMenuBasis {
  windowId: number | null
  tabId: number | null
  viewSource: boolean
}

/** The basis the menu was last built with (null = never built), and how many builds ran (AC74 test counter). */
let builtBasis: AppMenuBasis | null = null
let appMenuBuilds = 0

export function appMenuBuildCount(): number {
  return appMenuBuilds
}

function basisFor(w: WindowContext | null): AppMenuBasis {
  const tab = w && !w.win.isDestroyed() ? browserTabs(w).active() : null
  return { windowId: w?.id ?? null, tabId: tab?.id ?? null, viewSource: tab ? viewSourceUrlFor(tab.url()) !== null : false }
}

/** Pure: does the menu built with `built` need a rebuild to show `now`? */
export function appMenuStale(built: AppMenuBasis | null, now: AppMenuBasis): boolean {
  return !built || built.windowId !== now.windowId || built.tabId !== now.tabId || built.viewSource !== now.viewSource
}

/** Rebuild only when the focused window's active tab or its View Source state changed since the last build. */
function refreshAppMenuIfStale(): void {
  if (appMenuStale(builtBasis, basisFor(windowManager.focused()))) scheduleMenuRebuild()
}

/**
 * R22/E4: a tab webContents navigated or took focus. Only the active tab of the focused window matters; any other
 * tab (background tabs, other windows) causes no rebuild.
 */
function onTabMenuEvent(wc: WebContents): void {
  const hit = resolveWc(wc)
  if (!hit || hit.role !== 'tab' || !hit.tab) return
  const w = windowManager.focused()
  if (hit.w !== w || browserTabs(w).active() !== hit.tab) return
  refreshAppMenuIfStale()
}

function buildAppMenu(): void {
  if (PLATFORM !== 'mac') {
    Menu.setApplicationMenu(null)
    return
  }
  appMenuBuilds++
  const w = windowManager.focused()
  builtBasis = basisFor(w)
  let profiles: Array<{ id: string; name: string }> = []
  try {
    profiles = profileManager().list()
  } catch {
    profiles = []
  }
  const settings = w ? w.profile.getSettings() : null
  const template = buildMenuTemplate(
    {
      platform: PLATFORM,
      appName: app.name || 'RetroNet',
      skin: settings?.skin ?? 'y1997',
      profiles,
      currentProfileId: w && !w.incognito ? w.profile.id : null,
      bookmarkBar: settings?.bookmarkBar ?? true,
      devUi: !app.isPackaged,
      ...(w ? { activeUrl: browserTabs(w).active()?.url() ?? '' } : {})
    },
    {
      run: (id, arg) => {
        const focused = BrowserWindow.getFocusedWindow()
        // A focused window that isn't ours (a detached DevTools window): Cmd+W closes it, not our tab.
        if (focused && !windowManager.all().some((x) => x.win === focused) && (id === 'tab.close' || id === 'window.close')) {
          focused.close()
          return
        }
        runSafely(windowForMenu(focused ?? undefined), id, arg)
      },
      inspectUi: (which) => {
        const w2 = windowManager.focused()
        if (!w2 || app.isPackaged) return
        const wc = which === 'shell' ? w2.shell : w2.overlay.webContents
        wc.openDevTools({ mode: 'detach' })
      }
    }
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Rebuild the app menu soon (radio/checkbox state: skin, profile, bookmark bar). Coalesced. */
export function scheduleMenuRebuild(): void {
  if (menuTimer) return
  menuTimer = setImmediate(() => {
    menuTimer = null
    try {
      buildAppMenu()
    } catch (err) {
      logger.error('app menu build failed', err)
    }
  })
}

// ---- webContents wiring ----

function attachAll(wc: WebContents): void {
  // "View Page Source" is enabled by the active tab's URL: refresh the menu when a tab navigates or takes focus.
  // (Registered for every webContents: a tab is only known to the router after creation.)
  // R22/E4: only the focused window's active tab, and only when View Source enablement flips (onTabMenuEvent).
  if (PLATFORM === 'mac') {
    const refresh = (): void => onTabMenuEvent(wc)
    wc.on('did-navigate', refresh)
    wc.on('did-navigate-in-page', refresh)
    wc.on('focus', refresh)
  }
  attachShortcuts(wc, PLATFORM, {
    accepts: (x) => router.senderInfo(x) !== undefined,
    run: (x, id) => {
      const hit = resolveWc(x)
      if (hit) runSafely(hit.w, id)
    },
    escape: (x) => {
      const hit = resolveWc(x)
      if (!hit || hit.role !== 'tab' || !find.findActive(hit.w)) return false
      find.close(hit.w, { notify: true, refocus: true })
      return true
    }
  })
  attachContextMenu(wc, { resolve: resolveWc })
  attachWheelZoom(wc, (x) => {
    const hit = resolveWc(x)
    return hit && hit.role === 'tab' && hit.tab ? { w: hit.w, tab: hit.tab } : null
  })
}

// ---- IPC ----

/** A shell menu trigger: below the button's rect when given, else at the point (both window-content coordinates). */
export function triggerPlacement(req: {
  x: number
  y: number
  anchor?: { x: number; y: number; width: number; height: number }
}): Pick<ShowMenuOptions, 'anchor' | 'placement'> {
  return req.anchor
    ? { anchor: { ...req.anchor }, placement: 'below' }
    : { anchor: { x: req.x, y: req.y, width: 0, height: 0 }, placement: 'point' }
}

function registerHandlers(): void {
  router.handle('commands.run', (req, ctx) => {
    if (!isCommandId(req.id)) invalid('Unknown command')
    const w = windowOfCtx(ctx)
    // The palette closes before its command runs (the command may open its own overlay, e.g. a dialog).
    if (ctx.info.role === 'overlay' && w.overlayKind() === 'palette') w.hideOverlay()
    runCommand(w, req.id, req.arg)
    return null
  })

  router.handle('commands.list', () => ({ platform: PLATFORM, commands: commandsFor(PLATFORM) }))

  router.handle('find.query', (req, ctx) => {
    find.query(windowOfCtx(ctx), req.text)
    return null
  })
  router.handle('find.next', (req, ctx) => {
    find.next(windowOfCtx(ctx), req.forward)
    return null
  })
  router.handle('find.close', (_req, ctx) => {
    find.close(windowOfCtx(ctx), { notify: false, refocus: true })
    return null
  })

  // Resolves when the menu closes, so the shell can reset aria-expanded and return focus (A7).
  router.handle('profiles.menu', async (req, ctx) => {
    const w = windowOfCtx(ctx)
    await showMenu(w, {
      kind: 'profiles',
      label: 'Profiles',
      entries: buildProfilesMenu(w, (id, arg) => runSafely(w, id, arg)),
      ...triggerPlacement(req),
      keyboard: req.keyboard === true,
      target: w.shell
    })
    return null
  })

  router.handle('bookmarks.toggleCurrent', (_req, ctx) => ({ bookmarked: toggleBookmark(windowOfCtx(ctx)) }))
}

let registered = false

/** index.ts calls this once, after createProfileManager(). Idempotent. */
export function registerCommands(): void {
  if (registered) return
  registered = true
  registerHandlers()
  app.on('web-contents-created', (_e, wc) => attachAll(wc))
  for (const wc of allWebContents.getAllWebContents()) attachAll(wc)
  windowManager.onWindowFocused(() => scheduleMenuRebuild())
  windowManager.onWindowCreated(() => scheduleMenuRebuild())
  windowManager.onWindowClosed(() => scheduleMenuRebuild())
  // Tab switches (and closes, new active tabs) in the focused window; background-window changes are ignored.
  if (PLATFORM === 'mac') {
    onTabStructureChanged((w) => {
      if (w === windowManager.focused()) refreshAppMenuIfStale()
    })
  }
  try {
    profileManager().onChange(() => scheduleMenuRebuild())
  } catch {
    // Profile manager not created yet (tests): the menu still rebuilds on window focus.
  }
  buildAppMenu()
}
