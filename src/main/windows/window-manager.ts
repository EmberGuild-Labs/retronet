// Window manager (PLAN 1.2/1.3). One BrowserWindow per RetroNet window:
//   - its own webContents is the shell (retronet://shell/, default session, shell preload),
//   - a WebContentsView per tab (owned by the tab manager) is attached below,
//   - an overlay WebContentsView (retronet://overlay/, transparent) is attached on top only while visible.
// The shell reports its bar heights (`layout.setInsets`); the active tab gets the content area between them.
// Frame per DESIGN 6.5: macOS hiddenInset with per-skin traffic-light y; Windows hidden + titleBarOverlay.
import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle, type WebContents, type WebContentsView } from 'electron'
import { WebContentsView as View } from 'electron'
import type { ShellEventName, ShellEventPayload } from '../../shared/ipc-contract'
import { getSkin, type SkinInfo } from '../../shared/skins'
import type { DialogSpec, OverlayEvent, Rect, WindowSnapshot } from '../../shared/types'
import { router, sendShellEvent } from '../ipc/router'
import { logger } from '../logger'
import { attachNavigationGuards } from '../security/navigation-guards'
import { uiWebPreferences } from '../security/web-prefs'
import { browserTabs, createTabManager } from '../tabs/tab-manager'
import type { Insets, ProfileContext, ShowOverlayOptions, TabManager, WindowContext } from '../types'

export const SHELL_URL = 'retronet://shell/'
export const OVERLAY_URL = 'retronet://overlay/'

/** Used until the shell reports real insets (keeps the stub shell visible above the first tab). */
const DEFAULT_INSETS: Insets = { top: 80, bottom: 24 }
const STATE_COALESCE_MS = 16
const TRAFFIC_LIGHT_X = 12
/** S4: incognito windows never show page titles (macOS persists window titles in Saved Application State). */
export const INCOGNITO_WINDOW_TITLE = 'RetroNet - Incognito'
/** S11: how long the "now full screen" notice stays up, and its overlay box (top centre of the window). */
export const FULLSCREEN_NOTICE_MS = 3000
const FULLSCREEN_NOTICE_SIZE = { width: 440, height: 64 }
const FULLSCREEN_NOTICE_TOP = 24
const POPUP_DEFAULT_SIZE = { width: 640, height: 520 }

/** The window title for a window: fixed for incognito, else "<active tab title> - RetroNet". */
export function windowTitleFor(incognito: boolean, activeTitle: string): string {
  if (incognito) return INCOGNITO_WINDOW_TITLE
  const t = activeTitle.trim()
  return t ? `${t} - RetroNet` : 'RetroNet'
}

/**
 * S11: fit page-requested popup bounds into a display's work area: the size is capped to the work area and the
 * position is moved so the whole window is on screen (no off-screen pop-unders). Missing x/y stay missing
 * (Electron centres the window); missing sizes use the popup default for the position math.
 */
export function clampToWorkArea(bounds: Partial<Rectangle>, workArea: Rectangle, fallbackSize = POPUP_DEFAULT_SIZE): Partial<Rectangle> {
  const out: Partial<Rectangle> = { ...bounds }
  const cap = (v: number | undefined, max: number): number | undefined => (v === undefined ? undefined : Math.max(1, Math.min(Math.round(v), max)))
  out.width = cap(bounds.width, workArea.width)
  out.height = cap(bounds.height, workArea.height)
  if (out.width === undefined) delete out.width
  if (out.height === undefined) delete out.height
  if (bounds.x !== undefined && bounds.y !== undefined) {
    const w = out.width ?? Math.min(fallbackSize.width, workArea.width)
    const h = out.height ?? Math.min(fallbackSize.height, workArea.height)
    out.x = Math.min(Math.max(Math.round(bounds.x), workArea.x), workArea.x + workArea.width - w)
    out.y = Math.min(Math.max(Math.round(bounds.y), workArea.y), workArea.y + workArea.height - h)
  } else {
    delete out.x
    delete out.y
  }
  return out
}

/** Host shown in the fullscreen notice (never a path). */
export function fullscreenHostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host || u.protocol.replace(/:$/, '')
  } catch {
    return ''
  }
}

export interface CreateWindowOptions {
  profile: ProfileContext
  /** Minimal popup window (D4). */
  popup?: boolean
  bounds?: Partial<Rectangle>
  /** First tab URL (stub tab manager; T12 decides how it uses it). */
  initialUrl?: string
}

/**
 * Set at `before-quit`. Quitting closes windows without asking their pages (FIX-1 decision): the quit flush
 * must always finish, and a page's "Leave site?" can't hold the app open. Tab and window closes do ask.
 */
let quitting = false
let quitHookInstalled = false
function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app.on('before-quit', () => {
    quitting = true
  })
}

function frameOptions(skin: SkinInfo, incognito: boolean): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: skin.frame.macTrafficLightY } }
  }
  if (process.platform === 'win32') {
    const bar = skin.frame.winTitleBar
    const colors = incognito ? skin.frame.winTitleBarIncognito : bar
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height: bar.height } }
  }
  return {}
}

function translate(anchor: Rect, by: Rectangle | undefined): Rect {
  return by ? { ...anchor, x: anchor.x - by.x, y: anchor.y - by.y } : anchor
}

/** Overlay anchors arrive in shell (= window content) coordinates; make them overlay-local. */
function localizeOverlayEvent(ev: Exclude<OverlayEvent, { kind: 'hide' }>, bounds?: Rectangle): OverlayEvent {
  if (!bounds) return ev
  switch (ev.kind) {
    case 'permission':
    case 'suggest':
      return { ...ev, anchor: translate(ev.anchor, bounds) }
    case 'group-editor':
      return { ...ev, anchor: ev.anchor ? translate(ev.anchor, bounds) : null }
    default:
      return ev
  }
}

/**
 * Keep the shell and overlay on their retronet:// page: T10's guards with kind 'ui' block every page-initiated
 * navigation, subframe, redirect, webview and window.open. A crashed UI renderer is reloaded.
 */
function lockUiWebContents(wc: WebContents, url: string, win: BrowserWindow): void {
  attachNavigationGuards(wc, {
    kind: 'ui',
    getUrl: () => (wc.isDestroyed() ? '' : wc.getURL()),
    openTab: () => undefined,
    openPopup: () => undefined,
    window: win,
    session: wc.session
  })
  wc.on('render-process-gone', (_e, details) => {
    logger.error(`ui renderer gone (${url}): ${details.reason}`)
    if (details.reason !== 'clean-exit' && !wc.isDestroyed()) void wc.loadURL(url).catch(() => {})
  })
}

class AppWindow implements WindowContext {
  readonly win: BrowserWindow
  readonly shell: WebContents
  readonly overlay: WebContentsView
  readonly tabs: TabManager
  readonly incognito: boolean
  readonly popup: boolean

  private _insets: Insets = { ...DEFAULT_INSETS }
  private _nativeFullscreen = false
  private _htmlFullscreen = false
  private enteredFullscreenForHtml = false
  private activeView: WebContentsView | null = null
  private overlayShown: Exclude<OverlayEvent, { kind: 'hide' }> | null = null
  private overlayBounds: Rectangle | undefined
  private overlayLoaded = false
  private overlayPending: OverlayEvent | null = null
  private focusBeforeOverlay: 'shell' | 'tab' | null = null
  private stateTimer: NodeJS.Timeout | null = null
  private noticeTimer: NodeJS.Timeout | null = null
  private shellLoaded = false
  private readonly dialogs = new Map<string, (v: string | boolean | null) => void>()
  private closed = false
  /** A close was asked for (even if a page's beforeunload is still deciding): UI load aborts are expected. */
  private closeRequested = false

  constructor(
    readonly id: number,
    readonly profile: ProfileContext,
    opts: CreateWindowOptions,
    private readonly onClosed: (w: AppWindow) => void
  ) {
    this.incognito = profile.incognito
    this.popup = opts.popup ?? false
    const skin = getSkin(profile.getSettings().skin)
    this.win = new BrowserWindow({
      width: opts.bounds?.width ?? (this.popup ? 640 : 1200),
      height: opts.bounds?.height ?? (this.popup ? 520 : 800),
      ...(opts.bounds?.x !== undefined && opts.bounds?.y !== undefined ? { x: opts.bounds.x, y: opts.bounds.y } : {}),
      minWidth: 400,
      minHeight: 300,
      show: false,
      title: windowTitleFor(this.incognito, ''),
      backgroundColor: skin.frame.winTitleBar.color,
      ...frameOptions(skin, this.incognito),
      webPreferences: uiWebPreferences()
    })
    this.shell = this.win.webContents
    this._nativeFullscreen = this.win.isFullScreen()

    this.overlay = new View({ webPreferences: uiWebPreferences() })
    this.overlay.setBackgroundColor('#00000000')

    router.registerSender(this.shell, { role: 'shell', windowId: id })
    router.registerSender(this.overlay.webContents, { role: 'overlay', windowId: id })
    lockUiWebContents(this.shell, SHELL_URL, this.win)
    lockUiWebContents(this.overlay.webContents, OVERLAY_URL, this.win)

    // We own the window title: never let the shell document's <title> (or anything else) set it (S4).
    this.win.on('page-title-updated', (e) => e.preventDefault())
    this.shell.on('did-finish-load', () => {
      this.shellLoaded = true
      this.pushState()
      // The first tab's status events were sent before the shell could hear them: re-send the active one.
      const active = browserTabs(this).active()
      if (active) this.sendShell('status', active.statusEvent())
    })
    this.overlay.webContents.on('did-finish-load', () => {
      this.overlayLoaded = true
      this.pushState()
      if (this.overlayPending) {
        sendShellEvent(this.overlay.webContents, 'overlay', this.overlayPending)
        this.overlayPending = null
      }
    })
    this.overlay.webContents.on('did-start-loading', () => {
      this.overlayLoaded = false
    })

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('resize', () => this.layout())
    this.win.on('enter-full-screen', () => this.setNativeFullscreen(true))
    this.win.on('leave-full-screen', () => this.setNativeFullscreen(false))
    // Red button / Cmd+Shift+W / last tab: the tabs' beforeunload runs first (browser-standard). While any tab is
    // left the close is held; the tab manager closes the window when its last tab goes, or a "Stay" keeps it.
    this.win.on('close', (e) => {
      this.closeRequested = true
      if (quitting || this.closed) return
      if (browserTabs(this).closeAllForWindow()) e.preventDefault()
    })
    this.win.on('closed', () => this.dispose())

    void this.shell.loadURL(SHELL_URL).catch((err: unknown) => this.uiLoadFailed('shell', err))
    void this.overlay.webContents.loadURL(OVERLAY_URL).catch((err: unknown) => this.uiLoadFailed('overlay', err))

    this.tabs = createTabManager(this, { initialUrl: opts.initialUrl })
    this.layout()
  }

  get insets(): Readonly<Insets> {
    return this._insets
  }
  get nativeFullscreen(): boolean {
    return this._nativeFullscreen
  }
  get htmlFullscreen(): boolean {
    return this._htmlFullscreen
  }

  // ---- State ----

  snapshot(): WindowSnapshot {
    const s = this.profile.getSettings()
    return {
      windowId: this.id,
      profileId: this.profile.id,
      profileName: this.profile.name,
      incognito: this.incognito,
      popup: this.popup,
      fullscreen: this._nativeFullscreen,
      ...this.tabs.snapshot(),
      skin: s.skin,
      reducedMotion: s.reducedMotion,
      bookmarkBar: s.bookmarkBar
    }
  }

  requestState(): void {
    if (this.closed || this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.pushState()
    }, STATE_COALESCE_MS)
  }

  private pushState(): void {
    if (this.closed || !this.tabs) return
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = null
    }
    const snap = this.snapshot()
    if (this.shellLoaded) sendShellEvent(this.shell, 'state', snap)
    if (this.overlayLoaded) sendShellEvent(this.overlay.webContents, 'state', snap)
    const want = windowTitleFor(this.incognito, this.incognito ? '' : this.tabs.activeTitle())
    if (this.win.getTitle() !== want) this.win.setTitle(want)
  }

  sendShell<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void {
    sendShellEvent(this.shell, event, payload)
  }

  sendOverlay<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void {
    sendShellEvent(this.overlay.webContents, event, payload)
  }

  broadcast<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void {
    this.sendShell(event, payload)
    this.sendOverlay(event, payload)
  }

  // ---- Overlay ----

  showOverlay(event: Exclude<OverlayEvent, { kind: 'hide' }>, opts: ShowOverlayOptions = {}): void {
    if (this.closed) return
    if (this.overlayShown?.kind === 'dialog' && !(event.kind === 'dialog' && event.dialog.id === this.overlayShown.dialog.id)) {
      this.resolveDialog(this.overlayShown.dialog.id, null)
    }
    if (!this.overlayShown) {
      this.focusBeforeOverlay = this.shell.isFocused() ? 'shell' : 'tab'
    }
    this.overlayShown = event
    this.overlayBounds = opts.bounds
    // Re-adding moves the view to the top of the stack.
    this.win.contentView.addChildView(this.overlay)
    this.overlay.setBounds(this.overlayBoundsNow())
    const local = localizeOverlayEvent(event, opts.bounds)
    if (this.overlayLoaded) sendShellEvent(this.overlay.webContents, 'overlay', local)
    else this.overlayPending = local
    if (opts.focus) this.overlay.webContents.focus()
  }

  hideOverlay(): void {
    if (!this.overlayShown) return
    const wasFocused = this.overlay.webContents.isFocused()
    this.overlayShown = null
    this.overlayBounds = undefined
    this.overlayPending = null
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, null)
    this.win.contentView.removeChildView(this.overlay)
    sendShellEvent(this.overlay.webContents, 'overlay', { kind: 'hide' })
    if (wasFocused) {
      if (this.focusBeforeOverlay === 'shell') this.shell.focus()
      else this.tabs.focusActive()
    }
    this.focusBeforeOverlay = null
  }

  overlayKind(): OverlayEvent['kind'] | null {
    return this.overlayShown?.kind ?? null
  }

  showDialog(dialog: DialogSpec): Promise<string | boolean | null> {
    return new Promise((resolveValue) => {
      this.resolveDialog(dialog.id, null)
      this.dialogs.set(dialog.id, resolveValue)
      this.showOverlay({ kind: 'dialog', dialog }, { focus: true })
    })
  }

  /** `overlay.dialogResult`: settle the dialog. Returns false for an unknown id. */
  resolveDialog(dialogId: string, value: string | boolean | null): boolean {
    const settle = this.dialogs.get(dialogId)
    if (!settle) return false
    this.dialogs.delete(dialogId)
    settle(value)
    return true
  }

  private overlayBoundsNow(): Rectangle {
    if (this.overlayBounds) return this.overlayBounds
    const [width, height] = this.win.getContentSize() as [number, number]
    return { x: 0, y: 0, width, height }
  }

  // ---- Layout ----

  setInsets(insets: Insets): void {
    if (insets.top === this._insets.top && insets.bottom === this._insets.bottom) return
    this._insets = { top: insets.top, bottom: insets.bottom }
    this.layout()
  }

  tabBounds(): Rectangle {
    const [width, height] = this.win.getContentSize() as [number, number]
    if (this._htmlFullscreen) return { x: 0, y: 0, width, height }
    const top = Math.min(this._insets.top, height)
    const bottom = Math.min(this._insets.bottom, height - top)
    return { x: 0, y: top, width, height: Math.max(0, height - top - bottom) }
  }

  layout(): void {
    if (this.closed) return
    if (this.activeView) this.activeView.setBounds(this.tabBounds())
    if (this.overlayShown) this.overlay.setBounds(this.overlayBoundsNow())
  }

  setActiveView(view: WebContentsView | null): void {
    if (this.closed || view === this.activeView) return
    const cv = this.win.contentView
    if (this.activeView) cv.removeChildView(this.activeView)
    this.activeView = view
    if (view) {
      cv.addChildView(view, 0) // index 0: always below the overlay
      view.setBounds(this.tabBounds())
    }
  }

  setHtmlFullscreen(on: boolean): void {
    if (this.closed || on === this._htmlFullscreen) return
    this._htmlFullscreen = on
    if (on && !this.win.isFullScreen()) {
      this.enteredFullscreenForHtml = true
      this.win.setFullScreen(true)
    } else if (!on && this.enteredFullscreenForHtml) {
      this.enteredFullscreenForHtml = false
      this.win.setFullScreen(false)
    }
    this.layout()
    this.requestState()
    if (on) this.showFullscreenNotice()
    else this.hideFullscreenNotice()
  }

  /** S11: "<host> is now full screen" notice in the overlay for FULLSCREEN_NOTICE_MS; never steals focus. */
  private showFullscreenNotice(): void {
    // Never replace a dialog, palette or permission prompt.
    if (this.overlayShown && this.overlayShown.kind !== 'fullscreen-notice') return
    const host = fullscreenHostOf(browserTabs(this).active()?.url() ?? '')
    const [width] = this.win.getContentSize() as [number, number]
    const w = Math.min(FULLSCREEN_NOTICE_SIZE.width, width)
    const bounds = { x: Math.max(0, Math.round((width - w) / 2)), y: FULLSCREEN_NOTICE_TOP, width: w, height: FULLSCREEN_NOTICE_SIZE.height }
    this.showOverlay({ kind: 'fullscreen-notice', host }, { bounds })
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => this.hideFullscreenNotice(), FULLSCREEN_NOTICE_MS)
  }

  private hideFullscreenNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = null
    if (this.overlayShown?.kind === 'fullscreen-notice') this.hideOverlay()
  }

  private setNativeFullscreen(on: boolean): void {
    this._nativeFullscreen = on
    if (!on && this._htmlFullscreen && this.enteredFullscreenForHtml) {
      // The user left native fullscreen (Esc / green button) while a page was fullscreen.
      this.enteredFullscreenForHtml = false
      this._htmlFullscreen = false
      this.hideFullscreenNotice()
    }
    this.layout()
    this.requestState()
  }

  // ---- Appearance ----

  refreshAppearance(): void {
    if (this.closed) return
    const s = this.profile.getSettings()
    const skin = getSkin(s.skin)
    if (process.platform === 'darwin') {
      this.win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y: skin.frame.macTrafficLightY })
    } else if (process.platform === 'win32') {
      const bar = skin.frame.winTitleBar
      const colors = this.incognito ? skin.frame.winTitleBarIncognito : bar
      this.win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: bar.height })
    }
    this.win.setBackgroundColor(skin.frame.winTitleBar.color)
    this.broadcast('skin', { skin: skin.id, reducedMotion: s.reducedMotion, incognito: this.incognito })
    this.requestState()
  }

  // ---- Lifecycle ----

  /**
   * Q11: a window closed before its shell/overlay finished loading rejects the load (ERR_ABORTED/ERR_FAILED).
   * That is not an error. Decided a tick later, so the window's 'closed' has had the chance to run.
   */
  private uiLoadFailed(what: 'shell' | 'overlay', err: unknown): void {
    setImmediate(() => {
      if (this.closed || this.closeRequested || quitting || this.win.isDestroyed()) {
        logger.info(`${what} load aborted (window ${this.id} closing)`)
      } else {
        logger.error(`${what} failed to load`, err)
      }
    })
  }

  close(): void {
    if (!this.closed && !this.win.isDestroyed()) this.win.close()
  }

  /**
   * R1: teardown close (profile deletion). Every tab is closed without beforeunload and the window is destroyed
   * now; 'closed' still fires, so dispose() and the closed listeners run as for a normal close.
   */
  forceClose(): void {
    if (this.closed || this.win.isDestroyed()) {
      if (!this.closed) this.dispose()
      return
    }
    this.closeRequested = true
    try {
      this.tabs?.dispose()
    } catch (err) {
      logger.error('tab manager dispose failed', err)
    }
    this.win.destroy()
    // destroy() emits 'closed' synchronously in current Electron; make sure the bookkeeping ran either way.
    if (!this.closed) this.dispose()
  }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.stateTimer) clearTimeout(this.stateTimer)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, null)
    try {
      this.tabs?.dispose()
    } catch (err) {
      logger.error('tab manager dispose failed', err)
    }
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close()
    this.onClosed(this)
  }
}

type Listener = (w: WindowContext) => void

export class WindowManager {
  private readonly windows = new Map<number, AppWindow>()
  private nextId = 1
  private lastFocusedId: number | null = null
  private readonly createdListeners = new Set<Listener>()
  private readonly closedListeners = new Set<Listener>()
  private readonly focusListeners = new Set<Listener>()

  createWindow(opts: CreateWindowOptions): WindowContext {
    installQuitHook()
    const id = this.nextId++
    const bounds = { ...opts.bounds }
    const ref = this.focused()
    if (ref && bounds.x === undefined && !ref.win.isFullScreen()) {
      // Cascade from the focused window, like other browsers.
      const b = ref.win.getBounds()
      bounds.x = b.x + 24
      bounds.y = b.y + 24
      bounds.width ??= opts.popup ? undefined : b.width
      bounds.height ??= opts.popup ? undefined : b.height
    }
    if (opts.popup) {
      // S11: page-chosen popup geometry stays on the display of the window that opened it.
      const parent = ref && !ref.win.isDestroyed() ? ref.win.getBounds() : null
      const display = parent ? screen.getDisplayMatching(parent) : screen.getPrimaryDisplay()
      const clamped = clampToWorkArea(bounds, display.workArea)
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        if (clamped[k] === undefined) delete bounds[k]
        else bounds[k] = clamped[k]
      }
    }
    const w = new AppWindow(id, opts.profile, { ...opts, bounds }, (closed) => {
      this.windows.delete(closed.id)
      if (this.lastFocusedId === closed.id) this.lastFocusedId = null
      for (const l of this.closedListeners) l(closed)
    })
    this.windows.set(id, w)
    this.lastFocusedId = id
    w.win.on('focus', () => {
      this.lastFocusedId = id
      for (const l of this.focusListeners) l(w)
    })
    for (const l of this.createdListeners) l(w)
    logger.info(`window ${id} opened (profile ${opts.profile.id}${opts.profile.incognito ? ', incognito' : ''}${opts.popup ? ', popup' : ''})`)
    return w
  }

  all(): WindowContext[] {
    return [...this.windows.values()]
  }

  get(id: number): WindowContext | null {
    return this.windows.get(id) ?? null
  }

  /** Window owning a shell, overlay or tab webContents. */
  fromWebContents(wc: WebContents): WindowContext | null {
    const info = router.senderInfo(wc)
    if (info) return this.get(info.windowId)
    for (const w of this.windows.values()) if (w.tabs.tabIdFor(wc) !== null) return w
    return null
  }

  /** Focused window, else the last focused one still open. */
  focused(): WindowContext | null {
    for (const w of this.windows.values()) if (w.win.isFocused()) return w
    return this.lastFocusedId !== null ? this.get(this.lastFocusedId) : null
  }

  forProfile(profileId: string, opts: { incognito?: boolean } = {}): WindowContext[] {
    return this.all().filter((w) => w.profile.id === profileId && (opts.incognito === undefined || w.incognito === opts.incognito))
  }

  /** After a skin / reduced-motion / bookmark-bar change: every window of the profile, incognito included. */
  refreshProfile(profileId: string): void {
    for (const w of this.forProfile(profileId)) w.refreshAppearance()
  }

  /** R1: close a window for teardown (no beforeunload, destroyed now). Unknown ids are ignored. */
  forceClose(windowId: number): void {
    this.windows.get(windowId)?.forceClose()
  }

  /** `overlay.dialogResult` from a window's overlay. */
  resolveDialog(windowId: number, dialogId: string, value: string | boolean | null): boolean {
    return this.windows.get(windowId)?.resolveDialog(dialogId, value) ?? false
  }

  /** `layout.setInsets` from a window's shell. */
  setInsets(windowId: number, insets: Insets): void {
    this.windows.get(windowId)?.setInsets(insets)
  }

  onWindowCreated(l: Listener): () => void {
    this.createdListeners.add(l)
    return () => this.createdListeners.delete(l)
  }

  onWindowClosed(l: Listener): () => void {
    this.closedListeners.add(l)
    return () => this.closedListeners.delete(l)
  }

  onWindowFocused(l: Listener): () => void {
    this.focusListeners.add(l)
    return () => this.focusListeners.delete(l)
  }
}

export const windowManager = new WindowManager()
