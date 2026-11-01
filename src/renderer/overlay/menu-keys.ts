// Themed menu keyboard model (DESIGN-MENUS §5, PLAN-FINAL 1.2). Pure: no DOM. `menuKey` maps one keydown in one
// menu level to an action; `TypeAhead` is the 500ms prefix search. Arrows wrap and skip separators and disabled
// items (D-A6, native parity); type-ahead only moves the highlight. Also the accelerator helpers for rows.
import { parseAccelerator, type Modifier, type Platform } from '@shared/commands'

/** One row of a level as the key model sees it. Separators are `{ separator: true }`. */
export interface KeyItem {
  label: string
  enabled: boolean
  separator?: boolean
  hasSubmenu?: boolean
}

export interface KeyInput {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export type MenuKeyAction =
  | { type: 'none' }
  /** Highlight and focus this row (in the current level). */
  | { type: 'move'; index: number }
  /** Pick this row (`menu.pick`). */
  | { type: 'activate'; index: number }
  /** Open this row's submenu and focus its first enabled item. */
  | { type: 'open'; index: number }
  /** Close the current submenu and focus its parent row. */
  | { type: 'close-level' }
  /** Close the whole menu (`menu.dismiss`). */
  | { type: 'dismiss' }

export const TYPEAHEAD_MS = 500

function selectable(it: KeyItem | undefined): boolean {
  return !!it && !it.separator && it.enabled
}

/** First enabled row at or after `from` going `dir` (wrapping), or -1 when the level has none. */
export function nextEnabled(items: readonly KeyItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  for (let k = 0; k < n; k++) {
    const i = (((from + dir * k) % n) + n) % n
    if (selectable(items[i])) return i
  }
  return -1
}

export function firstEnabled(items: readonly KeyItem[]): number {
  return nextEnabled(items, 0, 1)
}

export function lastEnabled(items: readonly KeyItem[]): number {
  return nextEnabled(items, items.length - 1, -1)
}

/** Label form used for matching: NFKD without combining marks, no leading "…" or "(", lower case. */
export function matchKey(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^[\s.…(]+/, '') // NFKD turns "…" into "..."
    .toLowerCase()
}

/**
 * Type-ahead buffer (§5): printable keys accumulate until 500ms pass without one. A buffer of one repeated character
 * ("bbb") cycles through the rows starting with it; a longer buffer stays on the current row while it still matches.
 */
export class TypeAhead {
  private buffer = ''
  private last = -Infinity

  constructor(private readonly now: () => number = () => Date.now(), private readonly timeoutMs = TYPEAHEAD_MS) {}

  /** A key typed within the window would extend the buffer (Space then searches instead of activating). */
  get active(): boolean {
    return this.buffer !== '' && this.now() - this.last < this.timeoutMs
  }

  reset(): void {
    this.buffer = ''
    this.last = -Infinity
  }

  /** Adds `ch` and returns the row to highlight, or -1 for no match (the caller keeps the highlight). */
  push(ch: string, items: readonly KeyItem[], current: number): number {
    if (!this.active) this.buffer = ''
    this.buffer += ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    this.last = this.now()
    const n = items.length
    if (n === 0) return -1
    const chars = [...this.buffer]
    const repeated = chars.every((c) => c === chars[0])
    const needle = repeated ? chars[0]! : this.buffer
    // A single key (or a repeat) starts after the current row; an extended prefix starts at it.
    const start = repeated || current < 0 ? current + 1 : current
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n
      const it = items[i]!
      if (selectable(it) && matchKey(it.label).startsWith(needle)) return i
    }
    return -1
  }
}

/** A key that types a character: one code point, no Ctrl/Meta/Alt. */
export function isPrintable(ev: KeyInput): boolean {
  return [...ev.key].length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey
}

/**
 * The action for one keydown in a level. `active` is the highlighted row (-1 = none); `level` is 0 at the root.
 * Type-ahead state lives in `typeahead`, which this may update.
 */
export function menuKey(ev: KeyInput, items: readonly KeyItem[], active: number, level: number, typeahead: TypeAhead): MenuKeyAction {
  const cur = selectable(items[active]) ? active : -1
  const move = (i: number): MenuKeyAction => (i < 0 ? { type: 'none' } : { type: 'move', index: i })
  if (ev.key === ' ' && typeahead.active && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    return move(typeahead.push(' ', items, cur))
  }
  switch (ev.key) {
    case 'ArrowDown':
      return move(cur < 0 ? firstEnabled(items) : nextEnabled(items, cur + 1, 1))
    case 'ArrowUp':
      return move(cur < 0 ? lastEnabled(items) : nextEnabled(items, cur - 1, -1))
    case 'Home':
    case 'PageUp':
      return move(firstEnabled(items))
    case 'End':
    case 'PageDown':
      return move(lastEnabled(items))
    case 'Enter':
    case ' ':
      if (cur < 0) return { type: 'none' }
      return items[cur]!.hasSubmenu ? { type: 'open', index: cur } : { type: 'activate', index: cur }
    case 'ArrowRight':
      return cur >= 0 && items[cur]!.hasSubmenu ? { type: 'open', index: cur } : { type: 'none' }
    case 'ArrowLeft':
      return level > 0 ? { type: 'close-level' } : { type: 'none' }
    case 'Escape':
      return level > 0 ? { type: 'close-level' } : { type: 'dismiss' }
    case 'Tab':
      return { type: 'dismiss' }
  }
  if (isPrintable(ev)) return move(typeahead.push(ev.key, items, cur))
  return { type: 'none' }
}

/** Accelerator in registry form for this platform: 'CmdOrCtrl' becomes Cmd on macOS and Ctrl elsewhere. */
export function resolveAccel(accel: string, platform: Platform): string {
  return accel.replace(/\b(CmdOrCtrl|CommandOrControl)\b/gi, platform === 'mac' ? 'Cmd' : 'Ctrl')
}

const ARIA_MODS: ReadonlyArray<[Modifier, string]> = [
  ['Cmd', 'Meta'],
  ['Ctrl', 'Control'],
  ['Alt', 'Alt'],
  ['Shift', 'Shift']
]
const ARIA_KEYS: Readonly<Record<string, string>> = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Plus: '+',
  Esc: 'Escape',
  Return: 'Enter',
  Space: ' '
}

/** `aria-keyshortcuts` value ("Meta+Shift+P", "Control+C"), or '' when the accelerator does not parse. */
export function ariaKeyshortcuts(accel: string | undefined, platform: Platform): string {
  if (!accel) return ''
  try {
    const { modifiers, key } = parseAccelerator(resolveAccel(accel, platform))
    const mods = ARIA_MODS.filter(([m]) => modifiers.includes(m)).map(([, a]) => a)
    return [...mods, ARIA_KEYS[key] ?? key].join('+')
  } catch {
    return ''
  }
}
