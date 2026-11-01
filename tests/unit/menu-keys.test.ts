// PLAN-FINAL 1.2 / A3: themed menu keyboard model (DESIGN-MENUS §5, D-A6) and type-ahead.
import { describe, expect, it } from 'vitest'
import {
  TypeAhead,
  ariaKeyshortcuts,
  firstEnabled,
  lastEnabled,
  matchKey,
  menuKey,
  nextEnabled,
  resolveAccel,
  type KeyInput,
  type KeyItem
} from '../../src/renderer/overlay/menu-keys'

const it_ = (label: string, extra: Partial<KeyItem> = {}): KeyItem => ({ label, enabled: true, ...extra })
const sep: KeyItem = { label: '', enabled: false, separator: true }

// 0 Back(disabled) 1 Forward 2 --- 3 Reload 4 Bookmark(disabled) 5 Save as… 6 --- 7 Bold(sub) 8 Blue 9 Brown
const items: KeyItem[] = [
  it_('Back', { enabled: false }),
  it_('Forward'),
  sep,
  it_('Reload'),
  it_('Bookmark', { enabled: false }),
  it_('Save as…'),
  sep,
  it_('Bold', { hasSubmenu: true }),
  it_('Blue'),
  it_('Brown')
]

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods
})

function clock(): { now: () => number; advance(ms: number): void } {
  let t = 1000
  return { now: () => t, advance: (ms) => void (t += ms) }
}

describe('enabled navigation', () => {
  it('first/last skip separators and disabled items', () => {
    expect(firstEnabled(items)).toBe(1)
    expect(lastEnabled(items)).toBe(9)
    expect(nextEnabled([sep, it_('x', { enabled: false })], 0, 1)).toBe(-1)
    expect(firstEnabled([])).toBe(-1)
  })
})

describe('menuKey', () => {
  const ta = (): TypeAhead => new TypeAhead(clock().now)
  it('Down/Up skip separators and disabled items and wrap', () => {
    expect(menuKey(key('ArrowDown'), items, 1, 0, ta())).toEqual({ type: 'move', index: 3 })
    expect(menuKey(key('ArrowDown'), items, 3, 0, ta())).toEqual({ type: 'move', index: 5 })
    expect(menuKey(key('ArrowDown'), items, 9, 0, ta())).toEqual({ type: 'move', index: 1 }) // wraps past disabled Back
    expect(menuKey(key('ArrowUp'), items, 1, 0, ta())).toEqual({ type: 'move', index: 9 })
    expect(menuKey(key('ArrowUp'), items, 5, 0, ta())).toEqual({ type: 'move', index: 3 })
  })
  it('with nothing highlighted Down goes to the first and Up to the last enabled item', () => {
    expect(menuKey(key('ArrowDown'), items, -1, 0, ta())).toEqual({ type: 'move', index: 1 })
    expect(menuKey(key('ArrowUp'), items, -1, 0, ta())).toEqual({ type: 'move', index: 9 })
  })
  it('Home/End and PageUp/PageDown go to the first/last enabled item', () => {
    expect(menuKey(key('Home'), items, 8, 0, ta())).toEqual({ type: 'move', index: 1 })
    expect(menuKey(key('PageUp'), items, 8, 0, ta())).toEqual({ type: 'move', index: 1 })
    expect(menuKey(key('End'), items, 1, 0, ta())).toEqual({ type: 'move', index: 9 })
    expect(menuKey(key('PageDown'), items, 1, 0, ta())).toEqual({ type: 'move', index: 9 })
  })
  it('Enter/Space activate a leaf, open a parent; nothing with no highlight', () => {
    expect(menuKey(key('Enter'), items, 3, 0, ta())).toEqual({ type: 'activate', index: 3 })
    expect(menuKey(key(' '), items, 3, 0, ta())).toEqual({ type: 'activate', index: 3 })
    expect(menuKey(key('Enter'), items, 7, 0, ta())).toEqual({ type: 'open', index: 7 })
    expect(menuKey(key('Enter'), items, -1, 0, ta())).toEqual({ type: 'none' })
    expect(menuKey(key('Enter'), items, 0, 0, ta())).toEqual({ type: 'none' }) // a disabled row never activates
  })
  it('Right opens a submenu only on a parent; Left closes one level, not at the root', () => {
    expect(menuKey(key('ArrowRight'), items, 7, 0, ta())).toEqual({ type: 'open', index: 7 })
    expect(menuKey(key('ArrowRight'), items, 3, 0, ta())).toEqual({ type: 'none' })
    expect(menuKey(key('ArrowLeft'), items, 3, 1, ta())).toEqual({ type: 'close-level' })
    expect(menuKey(key('ArrowLeft'), items, 3, 0, ta())).toEqual({ type: 'none' })
  })
  it('Esc closes one level, and the menu at the root', () => {
    expect(menuKey(key('Escape'), items, 3, 2, ta())).toEqual({ type: 'close-level' })
    expect(menuKey(key('Escape'), items, 3, 0, ta())).toEqual({ type: 'dismiss' })
  })
  it('Tab and Shift+Tab dismiss the whole menu from any level', () => {
    expect(menuKey(key('Tab'), items, 3, 0, ta())).toEqual({ type: 'dismiss' })
    expect(menuKey(key('Tab', { shiftKey: true }), items, 3, 2, ta())).toEqual({ type: 'dismiss' })
  })
  it('ignores modified printable keys', () => {
    expect(menuKey(key('r', { metaKey: true }), items, 1, 0, ta())).toEqual({ type: 'none' })
  })
})

describe('type-ahead', () => {
  it('matches a case-insensitive prefix, skipping disabled items', () => {
    const t = new TypeAhead(clock().now)
    expect(t.push('R', items, 1)).toBe(3)
    t.reset()
    expect(t.push('b', items, -1)).toBe(7) // Back and Bookmark are disabled
  })
  it('cycles through matches with one repeated character', () => {
    const c = clock()
    const t = new TypeAhead(c.now)
    expect(menuKey(key('b'), items, 1, 0, t)).toEqual({ type: 'move', index: 7 })
    c.advance(100)
    expect(menuKey(key('b'), items, 7, 0, t)).toEqual({ type: 'move', index: 8 })
    c.advance(100)
    expect(menuKey(key('b'), items, 8, 0, t)).toEqual({ type: 'move', index: 9 })
    c.advance(100)
    expect(menuKey(key('b'), items, 9, 0, t)).toEqual({ type: 'move', index: 7 }) // wraps
  })
  it('extends the buffer within 500ms and resets after', () => {
    const c = clock()
    const t = new TypeAhead(c.now)
    expect(t.push('b', items, -1)).toBe(7)
    c.advance(200)
    expect(t.push('r', items, 7)).toBe(9) // "br" → Brown
    c.advance(499)
    expect(t.active).toBe(true)
    c.advance(1)
    expect(t.active).toBe(false)
    expect(t.push('s', items, 9)).toBe(5) // fresh buffer "s"
  })
  it('keeps the current row while an extended prefix still matches it', () => {
    const c = clock()
    const t = new TypeAhead(c.now)
    const list = [it_('Reload'), it_('Reopen'), it_('Rename')]
    expect(t.push('r', list, -1)).toBe(0)
    c.advance(50)
    expect(t.push('e', list, 0)).toBe(0)
    c.advance(50)
    expect(t.push('o', list, 0)).toBe(1)
  })
  it('no match keeps the highlight (returns -1 → none)', () => {
    const t = new TypeAhead(clock().now)
    expect(menuKey(key('z'), items, 3, 0, t)).toEqual({ type: 'none' })
  })
  it('Space within the buffer window searches instead of activating', () => {
    const c = clock()
    const t = new TypeAhead(c.now)
    const list = [it_('Save as…'), it_('Save page'), it_('Select all')]
    expect(menuKey(key('s'), list, -1, 0, t)).toEqual({ type: 'move', index: 0 })
    c.advance(50)
    expect(menuKey(key('a'), list, 0, 0, t)).toEqual({ type: 'move', index: 0 })
    c.advance(50)
    expect(menuKey(key('v'), list, 0, 0, t)).toEqual({ type: 'move', index: 0 })
    c.advance(50)
    expect(menuKey(key('e'), list, 0, 0, t)).toEqual({ type: 'move', index: 0 })
    c.advance(50)
    expect(menuKey(key(' '), list, 0, 0, t)).toEqual({ type: 'move', index: 0 })
    c.advance(50)
    expect(menuKey(key('p'), list, 0, 0, t)).toEqual({ type: 'move', index: 1 })
    c.advance(600)
    expect(menuKey(key(' '), list, 1, 0, t)).toEqual({ type: 'activate', index: 1 })
  })
  it('normalizes accents and strips a leading "…" or "("', () => {
    expect(matchKey('(Empty)')).toBe('empty)')
    expect(matchKey('…More')).toBe('more')
    expect(matchKey('Égal')).toBe('egal')
    const t = new TypeAhead(clock().now)
    expect(t.push('e', [it_('Back'), it_('(Empty)')], 0)).toBe(1)
  })
})

describe('accelerators', () => {
  it('resolves CmdOrCtrl per platform', () => {
    expect(resolveAccel('CmdOrCtrl+Shift+P', 'mac')).toBe('Cmd+Shift+P')
    expect(resolveAccel('CmdOrCtrl+C', 'win')).toBe('Ctrl+C')
  })
  it('builds aria-keyshortcuts', () => {
    expect(ariaKeyshortcuts('Cmd+Shift+P', 'mac')).toBe('Meta+Shift+P')
    expect(ariaKeyshortcuts('CmdOrCtrl+Shift+P', 'win')).toBe('Control+Shift+P')
    expect(ariaKeyshortcuts('Alt+Left', 'win')).toBe('Alt+ArrowLeft')
    expect(ariaKeyshortcuts('Cmd+Plus', 'mac')).toBe('Meta++')
    expect(ariaKeyshortcuts(undefined, 'mac')).toBe('')
    expect(ariaKeyshortcuts('Bogus+X', 'mac')).toBe('')
  })
})
