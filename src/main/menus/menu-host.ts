// Themed menu host (PLAN-FINAL 1.2). Callers build MenuEntry[] with run closures; showMenu strips the closures into
// a MenuSpec (shared/menu-model) with a fresh menuId, keeps the closures in a per-window registry and shows the spec
// in the overlay, which covers the whole window while the menu is open (D-A1). The overlay answers `menu.pick` with
// an opaque item id only; main runs the closure it registered, after checking the menu is still the current one,
// still on screen, the item is an enabled leaf and the caller's isValid() still holds. Everything else is ignored.
// When the overlay is busy with a prompt (dialog, sign-in, permission, group editor) or the menu belongs to the
// overlay's own text fields, the same entries become a native menu instead (D-A3, native-fallback.ts).
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { platformKey } from '../../shared/commands'
import {
  MENU_TITLE_MAX,
  MenuSpecSchema,
  trimSeparators,
  truncateLabel,
  type MenuAnchor,
  type MenuItemSpec,
  type MenuKind,
  type MenuPlacement,
  type MenuSpec
} from '../../shared/menu-model'
import type { OverlayEvent } from '../../shared/types'
import { router } from '../ipc/router'
import { logger } from '../logger'
import type { WindowContext } from '../types'
import { popupNative, toNativeTemplate } from './native-fallback'

// ---- Entries (what callers build) ----

/** Edit commands that act on the focused field of `ShowMenuOptions.target`. */
export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface MenuMods {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/** How the item was picked: modifiers held, and 1 for a middle click (bookmark dispositions). */
export interface MenuPick {
  mods: MenuMods
  button: 0 | 1
}

export interface MenuItemEntry {
  kind?: 'item'
  /** Unique within the menu; `MENU_ITEM_ID_RE` (e.g. 'ctx.copy', 'bm:12'). */
  id: string
  label: string
  /** Registry accelerator, shown as a chip ('CmdOrCtrl+C'). */
  accel?: string
  /** Default true. */
  enabled?: boolean
  check?: 'check' | 'radio'
  checked?: boolean
  title?: string
  /** Present = a submenu parent; it is never picked itself. */
  submenu?: MenuEntry[]
  /** The action. Runs in main on setImmediate after the overlay hid, inside try/catch. */
  run?: (pick: MenuPick) => void
  /** Edit command: `target.focus()` then `target[role]()` (when there is no `run`). */
  role?: EditRole
  /** Focus `target` before `run` (replaceMisspelling and other field actions). Implied by `role`. */
  focusTarget?: boolean
}
export interface MenuSeparatorEntry {
  kind: 'separator'
}
export type MenuEntry = MenuItemEntry | MenuSeparatorEntry

export interface ShowMenuOptions {
  kind: MenuKind
  /** Accessible name of the root menu (DESIGN-MENUS 6). */
  label: string
  entries: MenuEntry[]
  /** Window-content coordinates (tab-view params need `w.tabBounds()` x/y added). Width/height 0 = a point. */
  anchor: MenuAnchor
  placement: MenuPlacement
  /** Opened from the keyboard: the overlay highlights the first enabled item. */
  keyboard?: boolean
  /** Checked at open and again at pick; false = the pick does nothing (the tab navigated, the node is gone, ...). */
  isValid?: () => boolean
  /**
   * The webContents edit actions act on (the tab, the shell or the overlay). Its destruction closes the menu.
   * The overlay's own webContents means the overlay's text fields: always the native fallback (D-A3 b).
   */
  target?: WebContents
}

/** Overlay kinds a themed menu must not replace (D-A3 a): a prompt or half-filled form would be lost. */
export const BUSY_OVERLAY_KINDS: ReadonlySet<OverlayEvent['kind']> = new Set(['dialog', 'http-auth', 'permission', 'group-editor'])

/** Window events that close an open menu (AC64). */
const CLOSE_EVENTS = ['blur', 'resize', 'move', 'enter-full-screen', 'leave-full-screen'] as const

// ---- Spec building (pure) ----

export interface BuiltMenu {
  items: MenuItemSpec[]
  /** Pickable items only: enabled leaves. */
  actions: Map<string, MenuItemEntry>
}

/** Strip the closures: the spec tree plus the id → entry map. Null when an id repeats (a caller bug). */
export function buildMenuItems(entries: readonly MenuEntry[]): BuiltMenu | null {
  const actions = new Map<string, MenuItemEntry>()
  const seen = new Set<string>()
  let dup = false
  const walk = (list: readonly MenuEntry[]): MenuItemSpec[] =>
    list.map((e): MenuItemSpec => {
      if (e.kind === 'separator') return { kind: 'separator' }
      if (seen.has(e.id)) dup = true
      seen.add(e.id)
      const flat = e.label.replace(/\s+/g, ' ').trim()
      const label = truncateLabel(e.label)
      const title = e.title ?? (label !== flat ? flat : undefined)
      const enabled = e.enabled !== false
      const spec: MenuItemSpec = { kind: 'item', id: e.id, label, enabled }
      if (e.accel) spec.accel = e.accel
      if (e.check) {
        spec.check = e.check
        spec.checked = !!e.checked
      }
      if (title !== undefined) spec.title = title.slice(0, MENU_TITLE_MAX)
      if (e.submenu) spec.submenu = walk(e.submenu)
      else if (enabled) actions.set(e.id, e)
      return spec
    })
  const items = trimSeparators(walk(entries))
  return dup ? null : { items, actions }
}

/** Where a native fallback menu opens: the point, or under the button. */
export function nativePoint(anchor: MenuAnchor, placement: MenuPlacement): { x: number; y: number } {
  return placement === 'below' ? { x: anchor.x, y: anchor.y + anchor.height } : { x: anchor.x, y: anchor.y }
}

// ---- Registry ----

interface OpenMenu {
  readonly w: WindowContext
  readonly spec: MenuSpec
  readonly actions: Map<string, MenuItemEntry>
  readonly isValid: () => boolean
  readonly target: WebContents | null
  /** Unregister, drop the listeners and resolve showMenu. Idempotent. */
  finish(): void
}

/** One menu per window, by window id. */
const openMenus = new Map<number, OpenMenu>()
let fallbackCount = 0

function stillValid(m: { isValid: () => boolean; target: WebContents | null }): boolean {
  if (m.target && m.target.isDestroyed()) return false
  try {
    return m.isValid()
  } catch (err) {
    logger.error('menu isValid failed', err)
    return false
  }
}

function runEntry(entry: MenuItemEntry, target: WebContents | null, pick: MenuPick): void {
  try {
    const live = target && !target.isDestroyed() ? target : null
    if (live && (entry.role || entry.focusTarget)) live.focus()
    if (entry.run) entry.run(pick)
    else if (entry.role && live) live[entry.role]()
  } catch (err) {
    logger.error(`menu action ${entry.id} failed`, err)
  }
}

/** Close `m` if it is still the window's menu: hide the overlay (which restores focus) and resolve. */
function closeMenu(m: OpenMenu): void {
  if (openMenus.get(m.w.id) !== m) return
  if (m.w.overlayKind() === 'menu') m.w.hideOverlay() // fires onDismiss → finish
  m.finish()
}

function useNativeFallback(w: WindowContext, target: WebContents | undefined): boolean {
  if (target && target === w.overlay.webContents) return true
  const kind = w.overlayKind()
  return kind !== null && BUSY_OVERLAY_KINDS.has(kind)
}

function showNative(w: WindowContext, opts: ShowMenuOptions, isValid: () => boolean): Promise<void> {
  fallbackCount++
  const guard = { isValid, target: opts.target ?? null }
  const template = toNativeTemplate(opts.entries, (entry, pick) => {
    if (!stillValid(guard)) return
    setImmediate(() => runEntry(entry, guard.target, pick))
  })
  return popupNative(w.win, template, nativePoint(opts.anchor, opts.placement))
}

/**
 * Show a menu in `w` and resolve when it closes for any reason (pick, Esc, outside click, blur, resize, move,
 * fullscreen, another overlay, a new menu, the target or the window going away). A new menu in the same window
 * closes the old one first.
 */
export function showMenu(w: WindowContext, opts: ShowMenuOptions): Promise<void> {
  const isValid = opts.isValid ?? (() => true)
  const target = opts.target ?? null
  if (w.win.isDestroyed() || !stillValid({ isValid, target })) return Promise.resolve()
  if (useNativeFallback(w, opts.target)) return showNative(w, opts, isValid)

  const built = buildMenuItems(opts.entries)
  if (!built) {
    logger.error(`menu (${opts.kind}) has a repeated item id; not shown`)
    return Promise.resolve()
  }
  const parsed = MenuSpecSchema.safeParse({
    menuId: randomUUID(),
    kind: opts.kind,
    label: truncateLabel(opts.label),
    anchor: opts.anchor,
    placement: opts.placement,
    focusFirst: !!opts.keyboard,
    platform: platformKey(process.platform),
    items: built.items
  } satisfies MenuSpec)
  if (!parsed.success) {
    logger.error(`menu (${opts.kind}) failed its schema; not shown`)
    return Promise.resolve()
  }
  const spec = parsed.data

  // One menu per window: settle the old one (the overlay is replaced below, so no hide/show flicker).
  openMenus.get(w.id)?.finish()

  return new Promise<void>((resolve) => {
    let done = false
    const onClose = (): void => closeMenu(m)
    const onWindowClosed = (): void => m.finish()
    const m: OpenMenu = {
      w,
      spec,
      actions: built.actions,
      isValid,
      target,
      finish: () => {
        if (done) return
        done = true
        if (openMenus.get(w.id) === m) openMenus.delete(w.id)
        if (!w.win.isDestroyed()) {
          for (const ev of CLOSE_EVENTS) w.win.removeListener(ev as 'blur', onClose)
          w.win.removeListener('closed', onWindowClosed)
        }
        target?.removeListener('destroyed', onClose)
        resolve()
      }
    }
    openMenus.set(w.id, m)
    for (const ev of CLOSE_EVENTS) w.win.on(ev as 'blur', onClose)
    w.win.once('closed', onWindowClosed)
    target?.once('destroyed', onClose)
    // No bounds: the overlay covers the whole content area (D-A1), so the anchor needs no translation.
    w.showOverlay({ kind: 'menu', menu: spec }, { focus: true, onDismiss: () => m.finish() })
  })
}

// ---- menu.pick / menu.dismiss ----

export interface MenuPickRequest {
  menuId: string
  itemId: string
  mods: MenuMods
  button: 0 | 1
}

/**
 * `menu.pick` from window `windowId`'s overlay. Runs the item only if the menuId is that window's current menu,
 * the overlay still shows it, the item is an enabled leaf of it, and isValid() still holds. A stale pick (the
 * target changed) closes the menu without running anything. Returns whether the action was scheduled.
 */
export function pickMenu(windowId: number, req: MenuPickRequest): boolean {
  const m = openMenus.get(windowId)
  if (!m || m.spec.menuId !== req.menuId || m.w.overlayKind() !== 'menu') return false
  const entry = m.actions.get(req.itemId)
  if (!entry) return false // unknown, separator, disabled or submenu parent
  if (!stillValid(m)) {
    closeMenu(m)
    return false
  }
  closeMenu(m)
  const pick: MenuPick = { mods: { ...req.mods }, button: req.button }
  setImmediate(() => runEntry(entry, m.target, pick))
  return true
}

/** `menu.dismiss`: closes that menu only, so a late dismiss never closes a newer one. */
export function dismissMenu(windowId: number, menuId: string): boolean {
  const m = openMenus.get(windowId)
  if (!m || m.spec.menuId !== menuId) return false
  closeMenu(m)
  return true
}

/** The menu shown in a window now, or null (test hooks). */
export function currentMenu(windowId: number): MenuSpec | null {
  return openMenus.get(windowId)?.spec ?? null
}

/** How many menus went to the native fallback (test hooks). */
export function nativeFallbackCount(): number {
  return fallbackCount
}

export function registerMenuHostHandlers(): void {
  router.handle('menu.pick', (req, ctx) => {
    pickMenu(ctx.info.windowId, req)
    return null
  })
  router.handle('menu.dismiss', (req, ctx) => {
    dismissMenu(ctx.info.windowId, req.menuId)
    return null
  })
}
