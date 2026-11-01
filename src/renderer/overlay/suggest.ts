// Omnibox suggestions (DESIGN 3.2), drawn in the overlay because the tab view covers the area under the shell.
// Main sizes the overlay view to just this list, so the anchor arrives as (0, 0) + the omnibox width. Focus stays
// in the shell input: it moves the highlight (suggest-highlight) and announces the row itself, so this list is
// presentational for assistive tech (aria-hidden) and only handles pointer picks.
import { SEARCH_ENGINES } from '@shared/search-engines'
import { displayUrl as stripUserinfo } from '@shared/url-safety'
import type { OverlayEvent, Suggestion } from '@shared/types'
import { h, icon } from '../common/dom'
import { place, type Mounted, type OverlayEnv } from './ui'

type SuggestEvent = Extract<OverlayEvent, { kind: 'suggest' }>

const KIND_ICON: Record<Suggestion['kind'], string> = { history: 'history', bookmark: 'bookmark', search: 'search', url: 'globe' }

/** "Search with DuckDuckGo" from the engine whose template host matches the search URL. */
export function engineName(url: string): string {
  try {
    const host = new URL(url).host
    const e = SEARCH_ENGINES.find((x) => new URL(x.template.replace(/\{[^}]+\}|%s/g, 'q')).host === host)
    return e ? e.name : host
  } catch {
    return 'the web'
  }
}

/** Shown without scheme noise or userinfo: "example.org/path" for http(s), the full address otherwise. */
function displayUrl(url: string): string {
  return stripUserinfo(url).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
}

export interface SuggestHandle extends Mounted {
  highlight(index: number): void
  update(ev: SuggestEvent): void
}

export function mountSuggest(first: SuggestEvent, env: OverlayEnv): SuggestHandle {
  const list = h('ul', { class: 'rn-suggest rn-overlay-suggest', attrs: { role: 'listbox', 'aria-label': 'Suggestions', 'aria-hidden': 'true' } })
  let selected = -1

  const render = (ev: SuggestEvent): void => {
    place(list, ev.anchor.x, ev.anchor.y)
    list.style.width = `${Math.max(120, Math.round(ev.anchor.width))}px`
    const rows = ev.items.map((item, i) => {
      const title = item.kind === 'search' ? item.title : item.title || displayUrl(item.url)
      const secondary =
        item.kind === 'search' ? `Search with ${engineName(item.url)}` : item.title ? displayUrl(item.url) : ''
      const li = h(
        'li',
        { class: 'rn-suggest__item', attrs: { role: 'option', 'aria-selected': 'false', title: secondary ? `${title}\n${secondary}` : title }, data: { kind: item.kind } },
        icon(KIND_ICON[item.kind]),
        h('span', { class: 'rn-suggest__title', text: title }),
        secondary ? h('span', { class: 'rn-suggest__url', text: secondary }) : null
      )
      // Pick on mousedown: the click moves focus out of the shell, which dismisses the list before a click event.
      li.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        void env.api.omnibox.pick({ index: i })
      })
      return li
    })
    list.replaceChildren(...rows)
    selected = -1
    highlight(ev.selected)
  }

  function highlight(index: number): void {
    const prev = list.children[selected]
    prev?.classList.remove('rn-suggest__item--selected')
    prev?.setAttribute('aria-selected', 'false')
    selected = index
    const cur = list.children[index]
    if (!cur) return
    cur.classList.add('rn-suggest__item--selected')
    cur.setAttribute('aria-selected', 'true')
    cur.scrollIntoView({ block: 'nearest' })
  }

  render(first)
  return { root: list, highlight, update: render, onOutside: () => void env.api.omnibox.dismiss() }
}
