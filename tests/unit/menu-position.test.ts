// PLAN-FINAL 1.2 / A3: themed menu placement (DESIGN-MENUS §3): flip, shift, scroll and submenu offsets.
import { describe, expect, it } from 'vitest'
import {
  MENU_MARGIN,
  belowGap,
  placeAtPoint,
  placeBelow,
  placeRoot,
  placeSubmenu,
  submenuFrameTop,
  type Box
} from '../../src/renderer/overlay/menu-position'

const vp = { width: 1280, height: 800 }
const size = { width: 200, height: 300 }

describe('placeAtPoint (context menus)', () => {
  it('opens 1px right of and below the pointer in the top-left corner', () => {
    expect(placeAtPoint(10, 10, size, vp)).toEqual({ left: 11, top: 11, maxHeight: 300, scrolls: false })
  })
  it('flips left at the right edge (top-right corner)', () => {
    const p = placeAtPoint(1270, 10, size, vp)
    expect(p.left).toBe(1270 - 1 - 200)
    expect(p.top).toBe(11)
  })
  it('flips up at the bottom edge (bottom-left corner)', () => {
    const p = placeAtPoint(10, 790, size, vp)
    expect(p.left).toBe(11)
    expect(p.top).toBe(790 - 1 - 300)
  })
  it('flips left and up in the bottom-right corner, keeping the 4px margin', () => {
    const p = placeAtPoint(1270, 790, size, vp)
    expect(p).toEqual({ left: 1069, top: 489, maxHeight: 300, scrolls: false })
    expect(p.left + size.width).toBeLessThanOrEqual(vp.width - MENU_MARGIN)
  })
  it('shifts (clamps) when the flip would cross the opposite margin', () => {
    const small = { width: 300, height: 200 }
    const p = placeAtPoint(250, 150, { width: 400, height: 250 }, small)
    expect(p.left).toBe(MENU_MARGIN) // 250+1+400 > 296, flipped to -151, clamped to 4; 400 > 292 wide: stays at 4
    expect(p.top).toBe(MENU_MARGIN) // flipped to -101, clamped
  })
  it('flips exactly at the edge boundary and not one pixel before', () => {
    // fits: 1075 + 200 = 1275 <= 1276
    expect(placeAtPoint(1074, 10, size, vp).left).toBe(1075)
    expect(placeAtPoint(1076, 10, size, vp).left).toBe(1076 - 1 - 200)
  })
  it('scrolls a menu taller than the window: top = 4, max-height = H - 8', () => {
    const p = placeAtPoint(100, 400, { width: 200, height: 2000 }, vp)
    expect(p).toEqual({ left: 101, top: 4, maxHeight: 792, scrolls: true })
  })
  it('stays below the win32 caption buttons when it overlaps them', () => {
    const caption: Box = { left: 1100, top: 0, right: 1280, bottom: 32 }
    const p = placeAtPoint(1270, 2, size, { ...vp, caption })
    expect(p.top).toBe(36)
    expect(placeAtPoint(10, 2, size, { ...vp, caption }).top).toBe(MENU_MARGIN) // no overlap: only the margin applies
  })
})

describe('placeBelow (button menus)', () => {
  const button = { x: 100, y: 40, width: 80, height: 24 }
  it('opens under the button with the skin gap', () => {
    expect(placeBelow(button, size, vp, 0)).toEqual({ left: 100, top: 64, maxHeight: 300, scrolls: false })
    expect(placeBelow(button, size, vp, 2).top).toBe(66)
  })
  it('flips above when it does not fit below and there is more room above', () => {
    const low = { x: 100, y: 700, width: 80, height: 24 }
    const p = placeBelow(low, size, vp, 2)
    expect(p).toEqual({ left: 100, top: 700 - 2 - 300, maxHeight: 300, scrolls: false })
  })
  it('stays below and scrolls when below has more room', () => {
    const p = placeBelow(button, { width: 200, height: 2000 }, vp, 0)
    expect(p).toEqual({ left: 100, top: 64, maxHeight: 800 - 4 - 64, scrolls: true })
  })
  it('flips above and scrolls when above has more room but still not enough', () => {
    const low = { x: 100, y: 600, width: 80, height: 24 }
    const p = placeBelow(low, { width: 200, height: 2000 }, vp, 0)
    expect(p).toEqual({ left: 100, top: 4, maxHeight: 596, scrolls: true })
  })
  it('aligns right edges near the right window edge, then clamps', () => {
    const right = { x: 1200, y: 40, width: 70, height: 24 }
    expect(placeBelow(right, size, vp, 0).left).toBe(1270 - 200)
    const tiny = { width: 210, height: 800 }
    expect(placeBelow({ x: 150, y: 40, width: 20, height: 24 }, size, tiny, 0).left).toBe(MENU_MARGIN) // 170-200 = -30 → clamped to [4, 6]
  })
  it('treats a 0×0 anchor as a point', () => {
    expect(placeBelow({ x: 50, y: 60, width: 0, height: 0 }, size, vp, 2)).toEqual(placeAtPoint(50, 60, size, vp))
  })
  it('placeRoot routes by placement', () => {
    expect(placeRoot(button, 'below', size, vp, 0)).toEqual(placeBelow(button, size, vp, 0))
    expect(placeRoot({ x: 10, y: 10, width: 0, height: 0 }, 'point', size, vp, 0)).toEqual(placeAtPoint(10, 10, size, vp))
  })
})

describe('placeSubmenu', () => {
  const parentBox: Box = { left: 100, top: 100, right: 300, bottom: 500 }
  const row: Box = { left: 104, top: 200, right: 296, bottom: 224 }
  it('opens right of the parent with a 2px overlap, first item aligned to the row', () => {
    const p = placeSubmenu(parentBox, row, size, vp, 4, 1)
    expect(p).toEqual({ left: 298, top: 200 - 5, maxHeight: 300, scrolls: false })
  })
  it('flips to the left of the parent when it does not fit on the right', () => {
    const pb: Box = { left: 1000, top: 100, right: 1200, bottom: 500 }
    expect(placeSubmenu(pb, row, size, vp, 4, 0).left).toBe(1000 - 200 + 2)
  })
  it('uses the side with more room and clamps when neither side fits', () => {
    const narrow = { width: 500, height: 800 }
    const pb: Box = { left: 150, top: 100, right: 350, bottom: 500 }
    // right: 348+300 > 496; left: 150-300+2 < 4. Room right 148, left 148: right wins ties, clamped to 496-300.
    expect(placeSubmenu(pb, row, { width: 300, height: 100 }, narrow, 4, 1).left).toBe(196)
    const pb2: Box = { left: 300, top: 100, right: 450, bottom: 500 }
    expect(placeSubmenu(pb2, row, { width: 320, height: 100 }, narrow, 4, 1).left).toBe(MENU_MARGIN)
  })
  it('shifts up to fit at the bottom, then clamps to the margin', () => {
    const lowRow: Box = { left: 104, top: 700, right: 296, bottom: 724 }
    expect(placeSubmenu(parentBox, lowRow, size, vp, 4, 1).top).toBe(800 - 4 - 300)
  })
  it('scrolls a submenu taller than the window', () => {
    const p = placeSubmenu(parentBox, row, { width: 200, height: 5000 }, vp, 4, 1)
    expect(p).toEqual({ left: 298, top: 4, maxHeight: 792, scrolls: true })
  })
})

describe('skin geometry', () => {
  it('below gap is 0 in y1994/y1997 and 2 in y1999/y2001', () => {
    expect([belowGap('y1994'), belowGap('y1997'), belowGap('y1999'), belowGap('y2001')]).toEqual([0, 0, 2, 2])
  })
  it('frame top is 0 only in y1997', () => {
    expect([submenuFrameTop('y1994'), submenuFrameTop('y1997'), submenuFrameTop('y1999'), submenuFrameTop('y2001')]).toEqual([1, 0, 1, 1])
  })
})
