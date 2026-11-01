// Themed in-page dropdown replacing <select> on internal pages (PLAN-FINAL 1.2, DESIGN-MENUS 8). WAI-ARIA APG
// select-only combobox: focus stays on the combobox div, the highlight is `aria-activedescendant`. All state
// transitions live in select-model.ts; this file maps DOM events to it and renders the result.
// Text always goes through textContent (h() does this); no innerHTML.

import { h } from './dom'
import {
  ariaFor,
  choosePlacement,
  indexOfValue,
  initialState,
  step,
  type SelectEvent,
  type SelectOption,
  type SelectState
} from './select-model'

export type { SelectOption } from './select-model'

export interface SelectConfig {
  /** Id of the combobox element (the old <select> id), so labels and tests find it. */
  id: string
  /** Id of the visible label element (a <label for> cannot name a div). */
  labelledBy: string
  options: readonly SelectOption[]
  /** Initial value; unknown or omitted shows the placeholder. */
  value?: string
  onChange?: (value: string) => void
  describedBy?: string
  disabled?: boolean
  /** Text shown while no option is selected. */
  placeholder?: string
}

/** `<select>`-like surface on the root element. */
export interface SelectApi {
  value: string
  options: readonly SelectOption[]
  disabled: boolean
  /** The combobox element (focus target). */
  readonly button: HTMLElement
  /** Replaces the change handler. */
  onChange: ((value: string) => void) | undefined
}

export type SelectElement = HTMLDivElement & SelectApi

const ROW_PX = 24
const MAX_ROWS = 10
const EDGE_PX = 4

export function createSelect(cfg: SelectConfig): SelectElement {
  let options = cfg.options
  let disabled = cfg.disabled ?? false
  let onChange = cfg.onChange
  let state: SelectState = initialState(options, indexOfValue(options, cfg.value ?? ''))
  const listId = `${cfg.id}-list`
  const optId = (i: number): string => `${cfg.id}-opt-${i}`

  const valueEl = h('span', { class: 'rn-select__value' })
  const button = h(
    'div',
    {
      class: 'rn-select__button',
      attrs: {
        id: cfg.id,
        role: 'combobox',
        tabindex: 0,
        'aria-labelledby': cfg.labelledBy,
        'aria-describedby': cfg.describedBy,
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'aria-controls': listId,
        'aria-activedescendant': ''
      }
    },
    valueEl,
    h('span', { class: 'rn-select__chevron', attrs: { 'aria-hidden': 'true' } })
  )
  const listbox = h('div', {
    class: 'rn-select__listbox',
    attrs: { role: 'listbox', id: listId, 'aria-labelledby': cfg.labelledBy, tabindex: -1, hidden: true }
  })
  const root = h('div', { class: 'rn-select', data: { open: 'false' } }, button, listbox) as SelectElement

  function buildOptions(): void {
    listbox.replaceChildren(
      ...options.map((o, i) =>
        h(
          'div',
          { class: 'rn-select__option', attrs: { role: 'option', id: optId(i) } },
          h('span', { class: 'rn-select__check', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'rn-select__text', text: o.label })
        )
      )
    )
  }

  function render(): void {
    const aria = ariaFor(state, options, cfg.id, disabled)
    for (const [k, v] of Object.entries(aria.combobox)) button.setAttribute(k, v)
    if (!disabled) button.removeAttribute('aria-disabled')
    root.dataset.open = aria.combobox['aria-expanded']
    listbox.hidden = !state.open
    const rows = listbox.children
    aria.options.forEach((a, i) => {
      const row = rows[i] as HTMLElement | undefined
      if (!row) return
      row.setAttribute('aria-selected', a['aria-selected'])
      if (a['aria-disabled']) row.setAttribute('aria-disabled', 'true')
      else row.removeAttribute('aria-disabled')
      row.classList.toggle('rn-select__option--active', a.active)
    })
    const sel = options[state.selected]
    valueEl.textContent = sel ? sel.label : (cfg.placeholder ?? '')
    valueEl.classList.toggle('rn-select__value--placeholder', !sel)
    button.removeAttribute('title')
    if (sel && valueEl.scrollWidth > valueEl.clientWidth) button.title = sel.label
    if (state.open && state.active >= 0) (rows[state.active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  /** Size and place the open list inside the viewport: below, flipped above when cramped. */
  function place(): void {
    const r = button.getBoundingClientRect()
    const vh = document.documentElement.clientHeight || window.innerHeight
    const below = Math.max(0, vh - r.bottom - EDGE_PX)
    const above = Math.max(0, r.top - EDGE_PX)
    listbox.style.maxHeight = ''
    const cssMax = parseFloat(getComputedStyle(listbox).maxHeight)
    const natural = Math.min(listbox.scrollHeight, Number.isFinite(cssMax) ? cssMax : ROW_PX * MAX_ROWS)
    const placement = choosePlacement(below, above, natural)
    listbox.dataset.placement = placement
    listbox.style.maxHeight = `${Math.floor(Math.min(natural, placement === 'below' ? below : above))}px`
  }

  function apply(next: ReturnType<typeof step>): void {
    const wasOpen = state.open
    state = next.state
    render()
    if (!wasOpen && state.open) {
      place()
      render() // re-scroll the active option into the now-sized list
      document.addEventListener('pointerdown', onOutside, true)
    } else if (wasOpen && !state.open) {
      document.removeEventListener('pointerdown', onOutside, true)
    }
    const picked = next.changed !== undefined ? options[next.changed] : undefined
    if (picked) onChange?.(picked.value)
  }

  function dispatch(ev: SelectEvent): ReturnType<typeof step> {
    const res = step(state, options, ev, Date.now(), disabled)
    apply(res)
    return res
  }

  function onOutside(e: Event): void {
    if (!root.contains(e.target as Node)) dispatch({ type: 'click-outside' })
  }

  button.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.isComposing) return
    const res = dispatch({ type: 'key', key: ke.key, alt: ke.altKey, ctrl: ke.ctrlKey, meta: ke.metaKey, shift: ke.shiftKey })
    if (res.handled) ke.preventDefault()
  })
  button.addEventListener('click', () => dispatch({ type: 'click-button' }))
  // Focus leaving while open (not via the list, which never takes focus) closes without committing.
  button.addEventListener('blur', () => {
    if (state.open) dispatch({ type: 'click-outside' })
  })
  // Keep focus on the combobox when pressing inside the list.
  listbox.addEventListener('mousedown', (e) => e.preventDefault())
  listbox.addEventListener('click', (e) => {
    const row = (e.target as Element).closest('.rn-select__option')
    if (row) dispatch({ type: 'click-option', index: Array.prototype.indexOf.call(listbox.children, row) })
  })
  listbox.addEventListener('mousemove', (e) => {
    const row = (e.target as Element).closest('.rn-select__option')
    if (!row) return
    const index = Array.prototype.indexOf.call(listbox.children, row)
    if (index !== state.active) dispatch({ type: 'hover-option', index })
  })

  Object.defineProperties(root, {
    value: {
      get: () => options[state.selected]?.value ?? '',
      set: (v: string) => {
        // Programmatic set never fires onChange (as with <select>.value).
        state = { ...state, selected: indexOfValue(options, v) }
        render()
      }
    },
    options: {
      get: () => options,
      set: (next: readonly SelectOption[]) => {
        const keep = options[state.selected]?.value
        options = next
        state = { ...initialState(options, keep === undefined ? -1 : indexOfValue(options, keep)) }
        buildOptions()
        render()
      }
    },
    disabled: {
      get: () => disabled,
      set: (d: boolean) => {
        disabled = d
        if (d && state.open) state = { ...state, open: false, active: -1 }
        render()
      }
    },
    button: { get: () => button },
    onChange: { get: () => onChange, set: (fn: ((v: string) => void) | undefined) => (onChange = fn) }
  })

  buildOptions()
  render()
  return root
}
