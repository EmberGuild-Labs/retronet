// retronet://newtab (T21, DESIGN 5.1, AC31). Brand, a search box that uses the profile's engine, the top bookmarks as
// tiles, and a footer with the fake hit counter, the "Best viewed in RetroNet" badge and a link to the guestbook.
// CSP: no inline script or style, every string goes in via textContent/attributes (h()), and the only navigation
// this page starts itself is location.assign() to an http(s)/retronet URL the user typed.
import { initSkin } from '../../common/skin-loader'
import { h, icon } from '../../common/dom'
import { pageApi, type IpcResult } from '../../common/api'
import { classifyInput } from '@shared/omnibox'
import { DEFAULT_SEARCH_ENGINE_ID, getSearchEngine, type SearchEngineInfo } from '@shared/search-engines'
import { GROUP_COLORS, type BookmarkItem } from '@shared/types'
import './page.css'

initSkin('page')

const api = pageApi('newtab')
const app = document.getElementById('app') as HTMLElement
const isMac = api.platform === 'mac'

setFavicon()

// ---- engine (see BOARD T21: `search.engine` is requested; until it exists, the default engine is used) ----

type EngineBridge = { search?: { engine?: () => Promise<IpcResult<{ id: string; name: string }>> } }
let engine: SearchEngineInfo = getSearchEngine(DEFAULT_SEARCH_ENGINE_ID)

// ---- brand ----

const brand = h(
  'h1',
  { class: 'rn-newtab__brand' },
  h('img', { class: 'rn-newtab__mark', attrs: { src: 'img/logo.svg', alt: '', width: 64, height: 64 } }),
  h('img', { class: 'rn-newtab__wordmark', attrs: { src: 'img/wordmark.svg', alt: 'RetroNet', width: 117, height: 24 } })
)

const incognitoPanel = h(
  'div',
  { class: 'rn-panel rn-newtab__incognito', attrs: { hidden: true } },
  h('p', {}, icon('incognito'), ' ', h('strong', { text: "You're incognito." })),
  h('p', {
    text:
      "Pages you visit in this window won't be saved to history, and cookies are deleted when you close the last " +
      'incognito window. Downloads and bookmarks you make here are kept in your profile.'
  })
)

// ---- search ----

const input = h('input', {
  class: 'rn-input',
  attrs: {
    id: 'rn-q',
    type: 'search',
    name: 'q',
    placeholder: 'Search the web or type an address',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'rn-engine rn-search-error'
  }
})
const engineName = h('span', { text: engine.name })
const engineNote = h(
  'p',
  { class: 'rn-note rn-newtab__engine', attrs: { id: 'rn-engine' } },
  'Searching with ',
  engineName,
  ' · ',
  h('a', { attrs: { href: 'retronet://settings/' }, text: 'change in Settings' })
)
const searchError = h('p', { class: 'rn-note rn-error-text rn-newtab__error', attrs: { id: 'rn-search-error', role: 'status' } })
const form = h(
  'form',
  { class: 'rn-search', attrs: { role: 'search', 'aria-label': 'Search the web', novalidate: true } },
  h('label', { class: 'rn-sr-only', attrs: { for: 'rn-q' }, text: 'Search the web or type an address' }),
  input,
  h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: 'Search' })
)
form.addEventListener('submit', (ev) => {
  ev.preventDefault()
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }
  const res = classifyInput(text, engine)
  const url = res.kind === 'blocked' ? null : safeNavUrl(res.url)
  if (!url) {
    searchError.textContent = "That address can't be opened from the new tab page. Try the address bar."
    input.setAttribute('aria-invalid', 'true')
    return
  }
  location.assign(url)
})
input.addEventListener('input', () => {
  if (searchError.textContent) {
    searchError.textContent = ''
    input.removeAttribute('aria-invalid')
  }
})

// ---- tiles ----

const tilesHeading = h('h2', { class: 'rn-sr-only', attrs: { id: 'rn-tiles-h' }, text: 'Top bookmarks' })
const tiles = h('ul', { class: 'rn-tiles', attrs: { 'aria-labelledby': 'rn-tiles-h' } })

function renderTiles(items: readonly BookmarkItem[] | null): void {
  if (items === null) {
    tiles.replaceChildren(h('li', { class: 'rn-tile rn-tile--empty', text: "Couldn't load your bookmarks." }))
    return
  }
  if (items.length === 0) {
    const key = isMac ? '⌘D' : 'Ctrl+D'
    tiles.replaceChildren(
      h('li', { class: 'rn-tile rn-tile--empty', text: `Bookmark pages with ${key} and they'll show up here.` })
    )
    return
  }
  tiles.replaceChildren(...items.map(tile))
}

function tile(b: BookmarkItem): HTMLLIElement {
  const title = b.title.trim() || hostOf(b.url) || b.url
  const href = safeNavUrl(b.url)
  const art =
    b.faviconDataUrl && b.faviconDataUrl.startsWith('data:image/')
      ? h('img', { class: 'rn-tile__icon', attrs: { src: b.faviconDataUrl, alt: '', width: 32, height: 32 } })
      : h('span', {
          class: 'rn-tile__mono',
          data: { color: colorFor(hostOf(b.url) || title) },
          attrs: { 'aria-hidden': 'true' },
          text: monogram(title)
        })
  const label = h('span', { class: 'rn-tile__title', text: title })
  const inner = href
    ? h('a', { class: 'rn-tile', attrs: { href, title: `${title}\n${b.url}` } }, art, label)
    : h('span', { class: 'rn-tile', attrs: { title: b.url } }, art, label)
  return h('li', {}, inner)
}

// ---- footer: odometer, badge, guestbook ----

const caption = h('span', { class: 'rn-odometer__caption', text: 'You are visitor number' })
const well = h('span', { class: 'rn-odometer__well', attrs: { role: 'img', 'aria-label': 'Counting visitors…' } })
const odometer = h('p', { class: 'rn-odometer' }, caption, well)

const badge = h(
  'a',
  { class: 'rn-newtab__badge', attrs: { href: 'retronet://about/' } },
  h('img', { class: 'rn-badge-88', attrs: { src: 'img/badge-88x31.svg', alt: 'Best viewed in RetroNet', width: 88, height: 31 } })
)
const guestbook = h('a', { class: 'rn-newtab__guestbook', attrs: { href: 'retronet://history/' } }, 'Sign the guestbook ', h('span', { attrs: { 'aria-hidden': 'true' }, text: '→' }))

const footer = h('div', { class: 'rn-newtab__footer' }, odometer, badge, guestbook)

const DIGITS = 7

function digitCell(d: string): HTMLSpanElement {
  const strip = h('span', { class: 'rn-odometer__strip' }, ...'0123456789'.split('').map((n) => h('span', { text: n })))
  const cell = h('span', { class: 'rn-odometer__digit', attrs: { 'aria-hidden': 'true' } }, strip)
  setDigit(cell, d)
  return cell
}

function setDigit(cell: HTMLElement, d: string): void {
  cell.dataset.d = d
}

function renderCounter(value: number | null): void {
  if (value === null) {
    caption.textContent = "Incognito: visitors aren't counted."
    well.setAttribute('aria-label', 'Visitor counter is off in incognito')
    well.replaceChildren(...Array.from({ length: DIGITS }, () => h('span', { class: 'rn-odometer__digit', attrs: { 'aria-hidden': 'true' }, text: '-' })))
    return
  }
  caption.textContent = 'You are visitor number'
  well.setAttribute('aria-label', `You are visitor number ${value.toLocaleString('en-US')}`)
  const width = Math.max(DIGITS, String(value).length)
  const next = String(value).padStart(width, '0')
  const prev = String(Math.max(0, value - 1)).padStart(width, '0')
  // Paint the previous value, then roll only the digits that changed (DESIGN 6.2: 240ms ease-out, once per view;
  // the skin's reduced-motion rules turn the transition off, so the new value just appears).
  const cells = prev.split('').map(digitCell)
  well.replaceChildren(...cells)
  if (prev === next) return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      next.split('').forEach((d, i) => {
        const cell = cells[i]
        if (cell && cell.dataset.d !== d) setDigit(cell, d)
      })
    })
  )
}

// ---- mount ----

app.classList.add('rn-newtab')
document.body.classList.add('rn-tiled')
app.replaceChildren(brand, incognitoPanel, form, engineNote, searchError, tilesHeading, tiles, footer)

void load()

async function load(): Promise<void> {
  const [skin, counter, top, eng] = await Promise.allSettled([
    api.skin.get(),
    api.counter.hit(),
    api.bookmarks.top({ limit: 8 }),
    (api as unknown as EngineBridge).search?.engine?.() ?? Promise.resolve(null)
  ])

  const incognito = skin.status === 'fulfilled' && skin.value.ok && skin.value.data.incognito
  incognitoPanel.hidden = !incognito

  if (counter.status === 'fulfilled' && counter.value.ok) renderCounter(counter.value.data.value)
  else renderCounter(incognito ? null : 0)

  renderTiles(top.status === 'fulfilled' && top.value.ok ? top.value.data.items : null)

  if (eng.status === 'fulfilled' && eng.value && eng.value.ok) {
    engine = getSearchEngine(eng.value.data.id)
    engineName.textContent = engine.name
  }
}

// ---- helpers ----

function safeNavUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'retronet:' ? u.href : null
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function monogram(title: string): string {
  const ch = Array.from(title.replace(/^(https?:\/\/)?(www\.)?/i, '').trim())[0] ?? '?'
  return ch.toLocaleUpperCase()
}

/** djb2 over the host, so a site keeps its colour between visits (same family as the shell's profile colour). */
function colorFor(seed: string): string {
  let n = 5381
  for (let i = 0; i < seed.length; i++) n = ((n << 5) + n + seed.charCodeAt(i)) >>> 0
  return GROUP_COLORS[n % GROUP_COLORS.length] ?? 'grey'
}

function setFavicon(): void {
  if (document.querySelector('link[rel="icon"]')) return
  document.head.append(h('link', { attrs: { rel: 'icon', href: 'img/logo-16.svg', type: 'image/svg+xml' } }))
}

