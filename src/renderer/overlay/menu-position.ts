// Themed menu placement (DESIGN-MENUS §3, PLAN-FINAL 1.2). Pure: no DOM. The overlay covers the whole window while
// a menu is open (D-A1), so the viewport is the window. Every box keeps a 4px margin to the window edge; context
// menus open 1px off the pointer and flip left/up, button menus open below their button and flip above, submenus
// overlap their parent by 2px and flip to the left; then each is shifted (clamped) and, if still too tall, scrolls.
import type { MenuAnchor, MenuPlacement } from '@shared/menu-model'
import type { SkinId } from '@shared/skins'

/** Window margin (§3). */
export const MENU_MARGIN = 4
/** Gap between the pointer and a context menu's corner (§3.1). */
export const POINTER_GAP = 1
/** Horizontal overlap of a submenu with its parent box (§3.3). */
export const SUBMENU_OVERLAP = 2

/** Viewport-relative box, in window-content CSS px. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
  /** win32 Window Controls Overlay caption area (§3.4); null/undefined = not present. */
  caption?: Box | null
}

export interface Placed {
  left: number
  top: number
  /** The box's max-height; equal to the natural height when it fits. */
  maxHeight: number
  /** The natural height did not fit: the box scrolls (`.rn-menu--scrolls`). */
  scrolls: boolean
}

/**
 * Per-skin menu geometry (DESIGN-MENUS §3.2, §3.3). It lives here rather than in SKIN_TRAITS (src/shared/skins.ts)
 * because only this module reads it and it is pixel geometry tied to each skin's menu frame, not a shell trait.
 * Typed by SkinId, so adding a skin without menu numbers fails typecheck.
 * - belowGap: 0 where the menu abuts its button like a menu bar, 2px elsewhere.
 * - frameTop: the frame's top edge outside the padding (y1997's bevel sits inside the pad).
 */
const MENU_GEOMETRY: Readonly<Record<SkinId, { belowGap: number; frameTop: number }>> = {
  y1994: { belowGap: 0, frameTop: 1 },
  y1997: { belowGap: 0, frameTop: 0 },
  y1999: { belowGap: 2, frameTop: 1 },
  y2001: { belowGap: 2, frameTop: 1 }
}

function geometry(skin: string | undefined): { belowGap: number; frameTop: number } {
  return (skin && MENU_GEOMETRY[skin as SkinId]) || MENU_GEOMETRY.y1997
}

/** `placement: 'below'` gap for a skin id (the root's `data-skin`). */
export function belowGap(skin: string | undefined): number {
  return geometry(skin).belowGap
}

/** Submenu first-item alignment offset for a skin id. */
export function submenuFrameTop(skin: string | undefined): number {
  return geometry(skin).frameTop
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

/** The lowest allowed `top` for a box spanning [left, left + width): below the caption buttons when it overlaps them. */
function topFloor(vp: Viewport, left: number, width: number): number {
  const c = vp.caption
  if (c && left < c.right && left + width > c.left) return Math.max(MENU_MARGIN, c.bottom + MENU_MARGIN)
  return MENU_MARGIN
}

/** Pushes a placed box under the caption area if it overlaps it, shrinking it (and scrolling) when needed. */
function applyFloor(p: Placed, natural: number, width: number, vp: Viewport): Placed {
  const floor = topFloor(vp, p.left, width)
  if (p.top >= floor) return p
  const maxHeight = Math.min(natural, vp.height - MENU_MARGIN - floor)
  return { left: p.left, top: floor, maxHeight, scrolls: natural > maxHeight }
}

/** Context menu at a point (§3.1): corner at (x+1, y+1), flip left/up, shift, then scroll when taller than the window. */
export function placeAtPoint(x: number, y: number, size: Size, vp: Viewport): Placed {
  const { width: w, height: natural } = size
  const W = vp.width
  const H = vp.height
  const avail = H - 2 * MENU_MARGIN
  const scrolls = natural > avail
  const h = scrolls ? avail : natural

  let left = x + POINTER_GAP
  if (left + w > W - MENU_MARGIN) left = x - POINTER_GAP - w
  left = clamp(left, MENU_MARGIN, W - MENU_MARGIN - w)

  let top = y + POINTER_GAP
  if (top + h > H - MENU_MARGIN) top = y - POINTER_GAP - h
  top = scrolls ? MENU_MARGIN : clamp(top, MENU_MARGIN, H - MENU_MARGIN - h)

  return applyFloor({ left, top, maxHeight: h, scrolls }, natural, w, vp)
}

/** Button menu below its anchor (§3.2): flip above if there is more room there, otherwise stay below and scroll. */
export function placeBelow(anchor: MenuAnchor, size: Size, vp: Viewport, gap: number): Placed {
  if (anchor.width === 0 && anchor.height === 0) return placeAtPoint(anchor.x, anchor.y, size, vp)
  const { width: w, height: natural } = size
  const W = vp.width
  const H = vp.height
  const aBottom = anchor.y + anchor.height
  const aRight = anchor.x + anchor.width

  let left = anchor.x
  if (left + w > W - MENU_MARGIN) left = aRight - w
  left = clamp(left, MENU_MARGIN, W - MENU_MARGIN - w)

  const below = aBottom + gap
  const roomBelow = H - MENU_MARGIN - below
  const roomAbove = anchor.y - gap - MENU_MARGIN
  let placed: Placed
  if (natural <= roomBelow) {
    placed = { left, top: below, maxHeight: natural, scrolls: false }
  } else if (roomAbove > roomBelow) {
    const h = Math.min(natural, roomAbove)
    placed = { left, top: anchor.y - gap - h, maxHeight: h, scrolls: natural > h }
  } else {
    const h = Math.max(0, roomBelow)
    placed = { left, top: below, maxHeight: h, scrolls: true }
  }
  return applyFloor(placed, natural, w, vp)
}

/** Root menu placement for a spec's anchor and placement. */
export function placeRoot(anchor: MenuAnchor, placement: MenuPlacement, size: Size, vp: Viewport, gap: number): Placed {
  if (placement === 'below') return placeBelow(anchor, size, vp, gap)
  return placeAtPoint(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2, size, vp)
}

/**
 * Submenu next to its parent row (§3.3): right of the parent box with a 2px overlap, flipped to the left when it
 * does not fit (or the side with more room, clamped), its first item aligned with the parent row
 * (`top = row.top − (pad + frameTop)`), then shifted up, clamped to the margin and scrolled.
 */
export function placeSubmenu(parentBox: Box, parentRow: Box, size: Size, vp: Viewport, pad: number, frameTop: number): Placed {
  const { width: w, height: natural } = size
  const W = vp.width
  const H = vp.height

  const right = parentBox.right - SUBMENU_OVERLAP
  const leftSide = parentBox.left - w + SUBMENU_OVERLAP
  let left: number
  if (right + w <= W - MENU_MARGIN) left = right
  else if (leftSide >= MENU_MARGIN) left = leftSide
  else {
    const roomRight = W - MENU_MARGIN - right
    const roomLeft = parentBox.left + SUBMENU_OVERLAP - MENU_MARGIN
    left = roomRight >= roomLeft ? right : leftSide
  }
  left = clamp(left, MENU_MARGIN, W - MENU_MARGIN - w)

  const avail = H - 2 * MENU_MARGIN
  const scrolls = natural > avail
  const h = scrolls ? avail : natural
  let top = parentRow.top - (pad + frameTop)
  if (top + h > H - MENU_MARGIN) top = H - MENU_MARGIN - h
  if (top < MENU_MARGIN) top = MENU_MARGIN

  return applyFloor({ left, top, maxHeight: h, scrolls }, natural, w, vp)
}
