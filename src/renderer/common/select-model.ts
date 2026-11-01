// Pure state logic for the themed select (WAI-ARIA APG select-only combobox). No DOM here, so it is
// unit-tested directly; select.ts maps DOM events to `step()` and applies the result.

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectState {
  open: boolean
  /** Index of the committed option, or -1 for none (placeholder). */
  selected: number
  /** Highlighted option while open (`aria-activedescendant`), or -1. */
  active: number
  /** Type-ahead buffer and the time of its last key. */
  typed: string
  typedAt: number
}

export type SelectEvent =
  | { type: 'key'; key: string; alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
  | { type: 'click-option'; index: number }
  | { type: 'hover-option'; index: number }
  | { type: 'click-button' }
  | { type: 'click-outside' }

export interface SelectStep {
  state: SelectState
  /** The caller should preventDefault() the key event. */
  handled: boolean
  /** Set when the committed index changed: fire onChange. */
  changed?: number
}

export const TYPEAHEAD_MS = 500
export const PAGE_STEP = 10

export function initialState(options: readonly SelectOption[], selected: number): SelectState {
  return { open: false, selected: enabledOrNone(options, selected), active: -1, typed: '', typedAt: 0 }
}

function enabledOrNone(options: readonly SelectOption[], i: number): number {
  return i >= 0 && i < options.length ? i : -1
}

export function indexOfValue(options: readonly SelectOption[], value: string): number {
  return options.findIndex((o) => o.value === value)
}

export function firstEnabled(options: readonly SelectOption[]): number {
  return options.findIndex((o) => !o.disabled)
}

export function lastEnabled(options: readonly SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i]?.disabled) return i
  return -1
}

/** Next enabled option from `from` in direction `dir`, no wrapping; stays put when none. */
export function moveActive(options: readonly SelectOption[], from: number, dir: 1 | -1, count = 1): number {
  if (from < 0) return dir === 1 ? firstEnabled(options) : lastEnabled(options)
  let at = from
  let left = count
  for (let i = from + dir; i >= 0 && i < options.length && left > 0; i += dir) {
    if (options[i]?.disabled) continue
    at = i
    left--
  }
  return at
}

/** PageUp/PageDown: up to `PAGE_STEP` enabled options, clamping at the ends. */
export function pageActive(options: readonly SelectOption[], from: number, dir: 1 | -1): number {
  return moveActive(options, from, dir, PAGE_STEP)
}

function norm(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Type-ahead: case-insensitive prefix match on the label, starting after `from` and wrapping. A buffer of one
 * repeated character ("bbb") cycles through options starting with that character. Returns the new buffer and
 * the matched index (-1 for none).
 */
export function typeahead(
  options: readonly SelectOption[],
  from: number,
  ch: string,
  prev: { typed: string; typedAt: number },
  now: number
): { typed: string; index: number } {
  const typed = now - prev.typedAt <= TYPEAHEAD_MS ? prev.typed + ch : ch
  const lower = norm(typed)
  const repeated = lower.length > 1 && [...lower].every((c) => c === lower[0])
  const needle = repeated ? (lower[0] ?? '') : lower
  const n = options.length
  // A growing prefix may still match the current option; a fresh or repeated key moves past it.
  const start = !repeated && lower.length > 1 ? Math.max(from, 0) : from + 1
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    const opt = options[i]
    if (opt && !opt.disabled && norm(opt.label).startsWith(needle)) return { typed, index: i }
  }
  return { typed, index: -1 }
}

function isPrintable(e: Extract<SelectEvent, { type: 'key' }>): boolean {
  return e.key.length === 1 && !e.ctrl && !e.meta && !e.alt
}

function openState(s: SelectState, options: readonly SelectOption[]): SelectState {
  const sel = s.selected >= 0 && !options[s.selected]?.disabled ? s.selected : firstEnabled(options)
  return { ...s, open: true, active: sel, typed: '', typedAt: 0 }
}

function closed(s: SelectState): SelectState {
  return { ...s, open: false, active: -1, typed: '', typedAt: 0 }
}

function commit(s: SelectState, index: number): SelectStep {
  const ok = index >= 0
  const next = closed(ok ? { ...s, selected: index } : s)
  return { state: next, handled: true, changed: ok && index !== s.selected ? index : undefined }
}

/** Advance the state machine by one event. `disabled` selects ignore everything except focus keys. */
export function step(
  s: SelectState,
  options: readonly SelectOption[],
  ev: SelectEvent,
  now: number,
  disabled = false
): SelectStep {
  const keep = (handled = false): SelectStep => ({ state: s, handled })
  if (disabled) return keep(ev.type === 'key' && isOpenKey(ev))
  if (ev.type === 'click-button') return s.open ? { state: closed(s), handled: true } : { state: openState(s, options), handled: true }
  if (ev.type === 'click-outside') return s.open ? { state: closed(s), handled: false } : keep()
  if (ev.type === 'hover-option') {
    if (!s.open || options[ev.index]?.disabled || !options[ev.index]) return keep()
    return { state: { ...s, active: ev.index }, handled: false }
  }
  if (ev.type === 'click-option') {
    if (!s.open || !options[ev.index] || options[ev.index]?.disabled) return keep()
    return commit(s, ev.index)
  }

  const { key } = ev
  if (!s.open) return closedKey(s, options, ev, now)

  // Open
  if (key === 'Escape') return { state: closed(s), handled: true }
  if (key === 'Tab') return { ...commit(s, s.active), handled: false } // commits, focus moves on
  if (key === 'Enter' || (key === ' ' && s.typed === '')) return commit(s, s.active)
  if (key === 'ArrowUp' && ev.alt) return commit(s, s.active)
  if (key === 'ArrowDown') return act(s, moveActive(options, s.active, 1))
  if (key === 'ArrowUp') return act(s, moveActive(options, s.active, -1))
  if (key === 'Home') return act(s, firstEnabled(options))
  if (key === 'End') return act(s, lastEnabled(options))
  if (key === 'PageDown') return act(s, pageActive(options, s.active, 1))
  if (key === 'PageUp') return act(s, pageActive(options, s.active, -1))
  if (isPrintable(ev) || (key === ' ' && s.typed !== '')) {
    const t = typeahead(options, s.active, key, s, now)
    const next = { ...s, typed: t.typed, typedAt: now, active: t.index >= 0 ? t.index : s.active }
    return { state: next, handled: true }
  }
  return keep()
}

function act(s: SelectState, active: number): SelectStep {
  return { state: { ...s, active, typed: '', typedAt: 0 }, handled: true }
}

function isOpenKey(ev: Extract<SelectEvent, { type: 'key' }>): boolean {
  return ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)
}

function closedKey(
  s: SelectState,
  options: readonly SelectOption[],
  ev: Extract<SelectEvent, { type: 'key' }>,
  now: number
): SelectStep {
  const { key } = ev
  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || (key === ' ' && s.typed === '')) {
    if (key === 'ArrowUp' && ev.alt) return { state: s, handled: true } // already closed
    return { state: openState(s, options), handled: true }
  }
  if (key === 'Home' || key === 'End') {
    const i = key === 'Home' ? firstEnabled(options) : lastEnabled(options)
    return i >= 0 ? commit(s, i) : { state: s, handled: true }
  }
  if (isPrintable(ev) || (key === ' ' && s.typed !== '')) {
    const t = typeahead(options, s.selected, key, s, now)
    const base = { ...s, typed: t.typed, typedAt: now }
    if (t.index < 0) return { state: base, handled: true }
    const next = { ...base, selected: t.index }
    return { state: next, handled: true, changed: t.index !== s.selected ? t.index : undefined }
  }
  return { state: s, handled: false }
}

/** ARIA attributes for the combobox and its options for a given state (select.ts applies them verbatim). */
export interface SelectAria {
  combobox: { 'aria-expanded': 'true' | 'false'; 'aria-activedescendant': string; 'aria-disabled'?: 'true' }
  options: Array<{ 'aria-selected': 'true' | 'false'; 'aria-disabled'?: 'true'; active: boolean }>
}

export function ariaFor(s: SelectState, options: readonly SelectOption[], idBase: string, disabled = false): SelectAria {
  return {
    combobox: {
      'aria-expanded': s.open ? 'true' : 'false',
      'aria-activedescendant': s.open && s.active >= 0 ? `${idBase}-opt-${s.active}` : '',
      ...(disabled ? { 'aria-disabled': 'true' as const } : {})
    },
    options: options.map((o, i) => ({
      'aria-selected': i === s.selected ? ('true' as const) : ('false' as const),
      ...(o.disabled ? { 'aria-disabled': 'true' as const } : {}),
      active: s.open && i === s.active
    }))
  }
}

export type Placement = 'below' | 'above'

/** Flip above when the space below is under min(listHeight, 120) and above is larger (DESIGN-MENUS 8.2). */
export function choosePlacement(spaceBelow: number, spaceAbove: number, listHeight: number): Placement {
  return spaceBelow < Math.min(listHeight, 120) && spaceAbove > spaceBelow ? 'above' : 'below'
}
