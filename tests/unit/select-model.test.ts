import { describe, expect, it } from 'vitest'
import {
  ariaFor,
  choosePlacement,
  initialState,
  moveActive,
  step,
  typeahead,
  type SelectEvent,
  type SelectOption,
  type SelectState
} from '../../src/renderer/common/select-model'

const opts = (...labels: string[]): SelectOption[] => labels.map((l) => ({ value: l.toLowerCase(), label: l }))
const base = opts('Apple', 'Banana', 'Blueberry', 'Cherry')
const key = (k: string, extra: Partial<Extract<SelectEvent, { type: 'key' }>> = {}): SelectEvent => ({ type: 'key', key: k, ...extra })

function run(s: SelectState, o: readonly SelectOption[], ...evs: Array<[SelectEvent, number?]>): ReturnType<typeof step> {
  let r = { state: s, handled: false } as ReturnType<typeof step>
  for (const [e, t] of evs) r = step(r.state, o, e, t ?? 0)
  return r
}
const opened = (sel = 0, o = base): SelectState => step(initialState(o, sel), o, key('ArrowDown'), 0).state

describe('open / close', () => {
  it.each(['ArrowDown', 'ArrowUp', 'Enter', ' '])('%s opens, highlighting the selected option', (k) => {
    const r = step(initialState(base, 2), base, key(k), 0)
    expect(r.state.open).toBe(true)
    expect(r.state.active).toBe(2)
    expect(r.handled).toBe(true)
  })
  it('Alt+Down opens', () => {
    expect(step(initialState(base, 0), base, key('ArrowDown', { alt: true }), 0).state.open).toBe(true)
  })
  it('opens on the first enabled option with no selection', () => {
    const o = [{ value: 'a', label: 'A', disabled: true }, ...opts('B')]
    expect(step(initialState(o, -1), o, key('Enter'), 0).state.active).toBe(1)
  })
  it('click on the button toggles', () => {
    const a = step(initialState(base, 0), base, { type: 'click-button' }, 0)
    expect(a.state.open).toBe(true)
    expect(step(a.state, base, { type: 'click-button' }, 0).state.open).toBe(false)
  })
  it('disabled select does not open or change', () => {
    const r = step(initialState(base, 0), base, key('ArrowDown'), 0, true)
    expect(r.state.open).toBe(false)
    expect(step(initialState(base, 0), base, key('b'), 0, true).changed).toBeUndefined()
  })
})

describe('commit and revert', () => {
  it('Enter commits the active option and closes', () => {
    const r = run(initialState(base, 0), base, [key('ArrowDown')], [key('ArrowDown')], [key('Enter')])
    expect(r.state).toMatchObject({ open: false, selected: 1, active: -1 })
    expect(r.changed).toBe(1)
  })
  it('Space commits', () => {
    expect(run(initialState(base, 0), base, [key('Enter')], [key('ArrowDown')], [key(' ')]).changed).toBe(1)
  })
  it('click on an option commits', () => {
    const r = step(opened(), base, { type: 'click-option', index: 3 }, 0)
    expect(r.changed).toBe(3)
    expect(r.state.open).toBe(false)
  })
  it('click on a disabled option does nothing', () => {
    const o = [...opts('A'), { value: 'x', label: 'X', disabled: true }]
    const r = step(opened(0, o), o, { type: 'click-option', index: 1 }, 0)
    expect(r.state.open).toBe(true)
    expect(r.changed).toBeUndefined()
  })
  it('Escape closes and reverts (selection unchanged, no change event)', () => {
    const r = run(initialState(base, 0), base, [key('Enter')], [key('ArrowDown')], [key('ArrowDown')], [key('Escape')])
    expect(r.state).toMatchObject({ open: false, selected: 0, active: -1 })
    expect(r.changed).toBeUndefined()
    expect(r.handled).toBe(true)
  })
  it('Alt+Up commits and closes', () => {
    const r = run(initialState(base, 0), base, [key('Enter')], [key('ArrowDown')], [key('ArrowUp', { alt: true })])
    expect(r.state).toMatchObject({ open: false, selected: 1 })
    expect(r.changed).toBe(1)
  })
  it('Tab commits, closes and lets focus move on (not handled)', () => {
    const r = run(initialState(base, 0), base, [key('Enter')], [key('End')], [key('Tab')])
    expect(r.state).toMatchObject({ open: false, selected: 3 })
    expect(r.changed).toBe(3)
    expect(r.handled).toBe(false)
  })
  it('committing the same value fires no change', () => {
    expect(run(initialState(base, 0), base, [key('Enter')], [key('Enter')]).changed).toBeUndefined()
  })
  it('click outside closes without committing', () => {
    const r = run(initialState(base, 0), base, [key('Enter')], [key('End')], [{ type: 'click-outside' }])
    expect(r.state).toMatchObject({ open: false, selected: 0 })
    expect(r.changed).toBeUndefined()
  })
})

describe('navigation while open', () => {
  it('arrows do not wrap and skip disabled', () => {
    const o = [...opts('A', 'B'), { value: 'x', label: 'X', disabled: true }, ...opts('D')]
    let s = opened(0, o)
    s = step(s, o, key('ArrowDown'), 0).state
    s = step(s, o, key('ArrowDown'), 0).state
    expect(s.active).toBe(3)
    expect(step(s, o, key('ArrowDown'), 0).state.active).toBe(3)
    expect(step(opened(0, o), o, key('ArrowUp'), 0).state.active).toBe(0)
  })
  it('Home / End jump to first / last enabled', () => {
    const o = [{ value: 'z', label: 'Z', disabled: true }, ...opts('A', 'B'), { value: 'y', label: 'Y', disabled: true }]
    expect(step(opened(1, o), o, key('End'), 0).state.active).toBe(2)
    expect(step(opened(2, o), o, key('Home'), 0).state.active).toBe(1)
  })
  it('PageDown / PageUp move 10 and clamp', () => {
    const many = opts(...Array.from({ length: 25 }, (_, i) => `Item ${String(i).padStart(2, '0')}`))
    let s = opened(0, many)
    s = step(s, many, key('PageDown'), 0).state
    expect(s.active).toBe(10)
    s = step(s, many, key('PageDown'), 0).state
    s = step(s, many, key('PageDown'), 0).state
    expect(s.active).toBe(24)
    s = step(s, many, key('PageUp'), 0).state
    expect(s.active).toBe(14)
    expect(step({ ...s, active: 3 }, many, key('PageUp'), 0).state.active).toBe(0)
  })
  it('PageDown skips disabled rows when counting', () => {
    const o = opts('A', 'B', 'C', 'D')
    o[1]!.disabled = true
    expect(moveActive(o, 0, 1, 2)).toBe(3)
  })
  it('hover moves the highlight, but not onto a disabled option', () => {
    const o = [...opts('A', 'B'), { value: 'x', label: 'X', disabled: true }]
    expect(step(opened(0, o), o, { type: 'hover-option', index: 1 }, 0).state.active).toBe(1)
    expect(step(opened(0, o), o, { type: 'hover-option', index: 2 }, 0).state.active).toBe(0)
  })
})

describe('type-ahead', () => {
  it('closed: changes the value directly', () => {
    const r = step(initialState(base, 0), base, key('c'), 0)
    expect(r.state.selected).toBe(3)
    expect(r.changed).toBe(3)
    expect(r.state.open).toBe(false)
  })
  it('closed: repeated letter cycles', () => {
    let r = step(initialState(base, 0), base, key('b'), 0)
    expect(r.state.selected).toBe(1)
    r = step(r.state, base, key('b'), 100)
    expect(r.state.selected).toBe(2)
    r = step(r.state, base, key('b'), 200)
    expect(r.state.selected).toBe(1)
  })
  it('growing prefix narrows within 500ms', () => {
    let r = step(initialState(base, 0), base, key('b'), 0)
    r = step(r.state, base, key('l'), 300)
    expect(r.state.selected).toBe(2)
  })
  it('buffer resets after 500ms', () => {
    let r = step(initialState(base, 0), base, key('b'), 0)
    r = step(r.state, base, key('c'), 600)
    expect(r.state.selected).toBe(3)
  })
  it('no match keeps the value', () => {
    const r = step(initialState(base, 1), base, key('z'), 0)
    expect(r.state.selected).toBe(1)
    expect(r.changed).toBeUndefined()
  })
  it('open: moves only the highlight', () => {
    const r = step(opened(0), base, key('c'), 0)
    expect(r.state.active).toBe(3)
    expect(r.state.selected).toBe(0)
    expect(r.changed).toBeUndefined()
    expect(r.state.open).toBe(true)
  })
  it('Space is part of the buffer mid type-ahead, otherwise commits', () => {
    const o = opts('New York', 'Newark', 'Oslo')
    let r = step(opened(2, o), o, key('n'), 0)
    r = step(r.state, o, key('e'), 100)
    r = step(r.state, o, key('w'), 200)
    r = step(r.state, o, key(' '), 300)
    expect(r.state.open).toBe(true)
    expect(r.state.active).toBe(0)
    r = step(r.state, o, key('Enter'), 400)
    expect(r.changed).toBe(0)
  })
  it('skips disabled and ignores diacritics/case', () => {
    const o: SelectOption[] = [{ value: 'a', label: 'Ärger', disabled: true }, { value: 'b', label: 'Åland' }, ...opts('Other')]
    expect(typeahead(o, -1, 'a', { typed: '', typedAt: 0 }, 0).index).toBe(1)
    expect(typeahead(o, -1, 'A', { typed: '', typedAt: 0 }, 0).index).toBe(1)
  })
  it('ctrl/meta/alt chords are not type-ahead', () => {
    expect(step(initialState(base, 0), base, key('c', { meta: true }), 0).handled).toBe(false)
  })
})

describe('ARIA per state', () => {
  it('closed: expanded=false, no activedescendant, one selected option', () => {
    const a = ariaFor(initialState(base, 1), base, 'se')
    expect(a.combobox).toEqual({ 'aria-expanded': 'false', 'aria-activedescendant': '' })
    expect(a.options.map((o) => o['aria-selected'])).toEqual(['false', 'true', 'false', 'false'])
    expect(a.options.some((o) => o.active)).toBe(false)
  })
  it('open: expanded=true, activedescendant points at the active option id', () => {
    const s = step(opened(0), base, key('ArrowDown'), 0).state
    const a = ariaFor(s, base, 'se')
    expect(a.combobox['aria-expanded']).toBe('true')
    expect(a.combobox['aria-activedescendant']).toBe('se-opt-1')
    expect(a.options[1]!.active).toBe(true)
    expect(a.options[0]!['aria-selected']).toBe('true')
  })
  it('activedescendant is cleared again on close', () => {
    const s = step(opened(0), base, key('Escape'), 0).state
    expect(ariaFor(s, base, 'se').combobox['aria-activedescendant']).toBe('')
  })
  it('disabled adds aria-disabled; disabled options are marked', () => {
    const o = [...opts('A'), { value: 'x', label: 'X', disabled: true }]
    const a = ariaFor(initialState(o, 0), o, 'se', true)
    expect(a.combobox['aria-disabled']).toBe('true')
    expect(a.options[1]!['aria-disabled']).toBe('true')
    expect(a.options[0]!['aria-disabled']).toBeUndefined()
  })
  it('placeholder state: nothing selected', () => {
    expect(ariaFor(initialState(base, -1), base, 'se').options.every((o) => o['aria-selected'] === 'false')).toBe(true)
  })
})

describe('placement', () => {
  it('stays below when it fits', () => expect(choosePlacement(300, 100, 240)).toBe('below'))
  it('flips above when cramped below and roomier above', () => expect(choosePlacement(60, 400, 240)).toBe('above'))
  it('stays below when both sides are cramped and below is larger', () => expect(choosePlacement(80, 40, 240)).toBe('below'))
  it('short lists need only their own height', () => expect(choosePlacement(50, 400, 48)).toBe('below'))
})
