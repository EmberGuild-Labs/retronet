// Main-process contracts between the window manager (T7), tab manager (T12), profile manager (T11) and the
// IPC handlers. Implementations live in their own modules; this file has no runtime code.
import type { BrowserWindow, Rectangle, Session, WebContents, WebContentsView } from 'electron'
import type { ShellEventName, ShellEventPayload } from '../shared/ipc-contract'
import type { DialogSpec, OverlayEvent, ProfileInfo, Settings, WindowSnapshot } from '../shared/types'
import type { ProfileStores } from './storage'

/** A loaded profile (or the incognito pseudo-profile) and its Chromium session. */
export interface ProfileContext {
  /** Profile id; incognito windows carry the id of the profile they were opened from. */
  readonly id: string
  readonly name: string
  readonly incognito: boolean
  /** `persist:p-<id>` or `incognito-<n>`. Never the default session (that one belongs to the shell). */
  readonly partition: string
  readonly session: Session
  /** userData/Profiles/<id>/, or null for incognito (memory-only stores). */
  readonly dataDir: string | null
  readonly stores: ProfileStores
  /** Effective settings (incognito reads its parent profile's appearance). */
  getSettings(): Settings
  info(): ProfileInfo
}

/** Height of the shell's top bars and bottom status bar, reported by the shell (`layout.setInsets`). */
export interface Insets {
  top: number
  bottom: number
}

/** Part of the WindowSnapshot the tab manager owns; the window manager adds the window/profile fields. */
export type TabsSnapshot = Pick<WindowSnapshot, 'tabs' | 'groups' | 'activeTabId' | 'canReopenClosed'>

/** What a tab manager exposes to the window manager. T12 owns the implementation and may add members. */
export interface TabManager {
  /** Tab model for the shell. Called by the window manager on every (coalesced) state push. */
  snapshot(): TabsSnapshot
  /** The view to lay out under the shell, or null (no tabs / all detached). */
  activeView(): WebContentsView | null
  /** Tab id owning a webContents in this window, or null. */
  tabIdFor(wc: WebContents): number | null
  /** Title for the OS window ("<title> - RetroNet"). */
  activeTitle(): string
  /** Focus the active tab's page (after the overlay closes). */
  focusActive(): void
  /** Close every tab's webContents. Called once when the window closes. */
  dispose(): void
}

export interface ShowOverlayOptions {
  /** Give the overlay keyboard focus (palette, dialogs, prompts). Suggestions keep focus in the shell. */
  focus?: boolean
  /**
   * Overlay view bounds in window content coordinates. Default: the whole content area. When set, every
   * `anchor` in the event is translated into overlay-local coordinates, so the overlay always positions
   * relative to its own top-left.
   */
  bounds?: Rectangle
  /**
   * PLAN-FINAL 1.2: called once when this event leaves the overlay for any reason: another `showOverlay` replaced
   * it, `hideOverlay` ran, or the window closed. It must not show or hide the overlay itself.
   */
  onDismiss?: () => void
}

export interface WindowContext {
  readonly id: number
  readonly win: BrowserWindow
  readonly profile: ProfileContext
  readonly incognito: boolean
  /** Minimal popup window (window.open with features; no tab strip, read-only address). */
  readonly popup: boolean
  /** The shell: the BrowserWindow's own webContents at retronet://shell/. */
  readonly shell: WebContents
  /** The overlay view (retronet://overlay/); attached only while visible. */
  readonly overlay: WebContentsView
  readonly tabs: TabManager
  readonly insets: Readonly<Insets>
  /** Native fullscreen (snapshot `fullscreen`) and HTML-element fullscreen of the active tab. */
  readonly nativeFullscreen: boolean
  readonly htmlFullscreen: boolean

  /** Coalesced (16 ms) WindowSnapshot push to the shell and overlay; also updates the OS window title. */
  requestState(): void
  snapshot(): WindowSnapshot
  /** Send an event to the shell only. */
  sendShell<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void
  /** Send an event to the overlay only. */
  sendOverlay<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void
  /** Send an event to both. */
  broadcast<E extends ShellEventName>(event: E, payload: ShellEventPayload<E>): void

  /** Attach the overlay on top and show `event` in it. Replaces whatever it was showing. */
  showOverlay(event: Exclude<OverlayEvent, { kind: 'hide' }>, opts?: ShowOverlayOptions): void
  /** Detach the overlay, tell it to clear, resolve any open dialog with null, refocus the tab or shell. */
  hideOverlay(): void
  /** Kind currently shown, or null when hidden. */
  overlayKind(): OverlayEvent['kind'] | null
  /** Show a dialog in the overlay; resolves with the user's value, or null if dismissed/hidden. */
  showDialog(dialog: DialogSpec): Promise<string | boolean | null>

  /** Swap the attached tab view (below the overlay) and lay it out. */
  setActiveView(view: WebContentsView | null): void
  /** HTML-element fullscreen of the active tab: the tab takes the whole window. */
  setHtmlFullscreen(on: boolean): void
  /** Bounds the active tab view gets right now. */
  tabBounds(): Rectangle
  layout(): void
  /** Re-apply skin-dependent frame bits (traffic lights, titleBarOverlay) and push skin + state. */
  refreshAppearance(): void
  close(): void
}

/** What the rest of main needs from profiles. T11 owns the implementation and may add members. */
export interface ProfileManager {
  /** Load (or return the loaded) profile context for an id. */
  get(id: string): ProfileContext | null
  /** The profile a new window should open with (last used). */
  lastUsed(): ProfileContext
  list(): ProfileInfo[]
  /** Called by the window manager when a window of this profile gains focus. */
  markUsed(id: string): void
}
