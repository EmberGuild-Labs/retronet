// Throbber (DESIGN 3.5, 6.1). Decorative only: loading is also shown by the Stop button's enabled state and the
// status text, so it is aria-hidden and never takes pointer events. The animation itself is pure CSS in each skin
// (sprite `background-position` with steps(), off the main thread); this module only flips data-state.
// Reduced motion is handled by the skin CSS (media query and html[data-reduced-motion]): it shows a static
// "loading" frame instead of looping.
import { h } from '../common/dom'

export interface Throbber {
  readonly el: HTMLElement
  /** true while the ACTIVE tab is loading. idle snaps to the idle frame at once (no "finishing the spin"). */
  set(loading: boolean): void
}

export function createThrobber(): Throbber {
  const sprite = h('span', { class: 'rn-throbber', data: { state: 'idle' } })
  const el = h('div', { class: 'rn-throbber-well', attrs: { 'aria-hidden': 'true' } }, sprite)
  let current = false
  return {
    el,
    set(loading) {
      if (loading === current) return
      current = loading
      sprite.dataset.state = loading ? 'loading' : 'idle'
    }
  }
}
