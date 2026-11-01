// retronet://history, the guestbook (T21, DESIGN 5.2, AC17, AC30, AC32). Real history entries rendered as signed
// guestbook entries, grouped by day, newest first. Search (debounced, count announced), delete one (focus moves to
// the next entry), clear all behind a confirm dialog, 100 entries per page with "Show older entries".
// The marquee is decorative (aria-hidden, sentence repeated for screen readers), pauses on hover/focus and via a
// visible Pause button (WCAG 2.2.2), and is static under reduced motion (skin CSS).
import { initSkin } from '../../common/skin-loader'
import { h, icon } from '../../common/dom'
import { pageApi } from '../../common/api'
import type { HistoryEntry } from '@shared/types'
import './page.css'

initSkin('page')

const api = pageApi('history')
const app = document.getElementById('app') as HTMLElement
const PAGE = 100
const MARQUEE = '★ Thanks for stopping by! Every page you visit signs the guestbook. ★'

setFavicon()

// ---- header + marquee ----

const pauseLabel = h('span', { class: 'rn-btn__label', text: 'Pause' })
const pauseIcon = icon('pause')
// The label itself flips (Pause / Play), so no aria-pressed: both would announce "Play, pressed".
const pauseBtn = h('button', { class: 'rn-btn rn-history__pause', attrs: { type: 'button' } }, pauseIcon, pauseLabel)
const marquee = h(
  'div',
  { class: 'rn-marquee' },
  h('div', { class: 'rn-marquee__viewport', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'rn-marquee__track', text: MARQUEE })),
  pauseBtn
)
pauseBtn.addEventListener('click', () => {
  const paused = marquee.dataset.paused !== 'true'
  marquee.dataset.paused = String(paused)
  pauseLabel.textContent = paused ? 'Play' : 'Pause'
  pauseIcon.dataset.icon = paused ? 'play' : 'pause'
})

// ---- toolbar ----

const search = h('input', {
  class: 'rn-input',
  attrs: { id: 'rn-gb-search', type: 'search', placeholder: 'Search guestbook', autocomplete: 'off', spellcheck: 'false' }
})
const clearBtn = h('button', { class: 'rn-btn rn-btn--danger', attrs: { type: 'button' } }, icon('trash'), h('span', { class: 'rn-btn__label', text: 'Clear all…' }))
const toolbar = h(
  'div',
  { class: 'rn-toolbar-row rn-history__toolbar' },
  h('label', { class: 'rn-sr-only', attrs: { for: 'rn-gb-search' }, text: 'Search guestbook' }),
  search,
  clearBtn
)
/** Stable polite region (rendered empty first): match counts, deletions, "Guestbook erased." */
const status = h('p', { class: 'rn-note rn-history__status', attrs: { role: 'status' } })

const list = h('div', { class: 'rn-history__list' })
const moreBtn = h('button', { class: 'rn-btn', attrs: { type: 'button', hidden: true }, text: 'Show older entries' })
const more = h('div', { class: 'rn-history__more' }, moreBtn)

// ---- confirm dialog (native <dialog>: focus trap, Esc, inert background for free) ----

const dlgCancel = h('button', { class: 'rn-btn', attrs: { type: 'button', autofocus: true }, text: 'Cancel' })
const dlgErase = h('button', { class: 'rn-btn rn-btn--danger', attrs: { type: 'button' }, text: 'Erase all' })
const dialog = h(
  'dialog',
  { class: 'rn-dialog rn-history__dialog', attrs: { 'aria-labelledby': 'rn-gb-dlg-title', 'aria-describedby': 'rn-gb-dlg-body' } },
  h('h2', { class: 'rn-dialog__title', attrs: { id: 'rn-gb-dlg-title' } }, icon('warning'), 'Erase the whole guestbook?'),
  h('div', { class: 'rn-dialog__body' }, h('p', { attrs: { id: 'rn-gb-dlg-body' }, text: 'This removes all history for this profile. It can’t be undone.' })),
  h('div', { class: 'rn-dialog__actions' }, dlgCancel, dlgErase)
)

app.classList.add('rn-history')
app.replaceChildren(
  h('h1', { text: 'Guestbook' }),
  marquee,
  h('p', { class: 'rn-sr-only', text: 'Thanks for stopping by! Every page you visit signs the guestbook.' }),
  toolbar,
  status,
  list,
  more
)
// Outside <main>: the page's heading rules (.rn-page h2) must not restyle the dialog title.
document.body.append(dialog)

// ---- state ----

let entries: HistoryEntry[] = []
let total = 0
let hasMore = false
let query = ''
let incognito = false
let seq = 0
let loadingTimer: number | undefined

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const numFmt = new Intl.NumberFormat()

void api.skin.get().then((r) => {
  if (r.ok) {
    incognito = r.data.incognito
    if (!entries.length) render()
  }
})
void fetchPage(true)

async function fetchPage(reset: boolean): Promise<void> {
  const mine = ++seq
  const text = query
  if (reset) {
    window.clearTimeout(loadingTimer)
    // No "loading" text for fast answers (DESIGN 5.2: only after 300 ms).
    loadingTimer = window.setTimeout(() => {
      if (mine === seq && !entries.length) list.replaceChildren(h('p', { class: 'rn-loading', text: 'Opening the guestbook...' }))
    }, 300)
  }
  moreBtn.disabled = true
  const res = await api.history.query({ text: text || undefined, offset: reset ? 0 : entries.length, limit: PAGE })
  if (mine !== seq) return
  window.clearTimeout(loadingTimer)
  moreBtn.disabled = false
  if (!res.ok) {
    renderError()
    return
  }
  entries = reset ? res.data.entries : dedupe([...entries, ...res.data.entries])
  total = res.data.total
  hasMore = res.data.hasMore
  render()
  if (reset && text) status.textContent = total === 0 ? '' : `${numFmt.format(total)} ${total === 1 ? 'entry matches' : 'entries match'}`
  else if (reset) status.textContent = ''
}

function dedupe(xs: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<number>()
  return xs.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
}

// ---- render ----

function render(): void {
  clearBtn.disabled = entries.length === 0 && !query
  moreBtn.hidden = !hasMore
  if (entries.length === 0) {
    list.replaceChildren(emptyState())
    return
  }
  const groups: Array<{ key: string; label: string; items: HistoryEntry[] }> = []
  for (const e of entries) {
    const d = new Date(e.visitedAt)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(e)
    else groups.push({ key, label: dayLabel(d), items: [e] })
  }
  list.replaceChildren(
    ...groups.map((g, i) => {
      const id = `rn-day-${i}`
      return h(
        'section',
        { class: 'rn-day', attrs: { 'aria-labelledby': id } },
        h('h2', { attrs: { id }, text: g.label }),
        h('hr', { class: 'rn-hr' }),
        ...g.items.map(entryEl)
      )
    })
  )
}

function entryEl(e: HistoryEntry): HTMLElement {
  const title = e.title.trim() || untitled(e.url)
  const href = safeHref(e.url)
  const del = h(
    'button',
    {
      class: 'rn-btn rn-btn--icon rn-hit rn-history__delete',
      data: { id: e.id },
      attrs: { type: 'button', 'aria-label': `Remove entry: ${title}`, title: 'Remove entry' }
    },
    icon('trash')
  )
  del.addEventListener('click', () => void remove(e.id))
  const titleEl = href
    ? h('a', { class: 'rn-guestbook-entry__title', attrs: { href, title }, text: title })
    : h('span', { class: 'rn-guestbook-entry__title', attrs: { title }, text: title })
  const time = new Date(e.visitedAt)
  return h(
    'article',
    { class: 'rn-guestbook-entry', attrs: { 'aria-label': `Visitor #${numFmt.format(e.id)}: ${title}` } },
    h(
      'div',
      { class: 'rn-guestbook-entry__head' },
      h('span', { class: 'rn-guestbook-entry__visitor', text: `Visitor #${numFmt.format(e.id)}` }),
      h('span', { class: 'rn-guestbook-entry__meta' }, h('time', { attrs: { datetime: time.toISOString() }, text: timeFmt.format(time) }), del)
    ),
    h(
      'div',
      { class: 'rn-guestbook-entry__body' },
      h('span', { class: 'rn-guestbook-entry__label', text: 'Signed:' }),
      titleEl,
      h('span', { class: 'rn-guestbook-entry__label', text: 'From:' }),
      h('span', { class: 'rn-guestbook-entry__url', attrs: { title: e.url }, text: e.url })
    )
  )
}

function emptyState(): HTMLElement {
  if (query) {
    const btn = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Clear search' })
    btn.addEventListener('click', () => {
      search.value = ''
      setQuery('')
      search.focus()
    })
    return h('div', { class: 'rn-empty' }, h('p', { text: `No entries match “${query}”.` }), btn)
  }
  return h(
    'div',
    { class: 'rn-empty' },
    h('p', {
      text: incognito ? "The guestbook doesn't record incognito visits." : 'Nobody has signed the guestbook yet. Go visit a few pages!'
    })
  )
}

function renderError(): void {
  const retry = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('reload'), h('span', { class: 'rn-btn__label', text: 'Try again' }))
  retry.addEventListener('click', () => void fetchPage(true))
  list.replaceChildren(h('div', { class: 'rn-empty', attrs: { role: 'alert' } }, h('p', { class: 'rn-error-text', text: "Couldn't read history." }), retry))
  moreBtn.hidden = true
}

function dayLabel(d: Date): string {
  const today = new Date()
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(today) - start(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return dayFmt.format(d)
}

// ---- actions ----

async function remove(id: number): Promise<void> {
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return
  const res = await api.history.delete({ id })
  if (!res.ok && res.code !== 'E_NOT_FOUND') {
    status.textContent = "Couldn't remove that entry. Try again."
    return
  }
  const [gone] = entries.splice(idx, 1)
  total = Math.max(0, total - 1)
  render()
  status.textContent = `Removed ${gone?.title.trim() || 'entry'}.`
  const next = entries[idx] ?? entries[idx - 1]
  const target = next ? list.querySelector<HTMLButtonElement>(`.rn-history__delete[data-id="${next.id}"]`) : null
  ;(target ?? search).focus()
  // Keep a page's worth on screen when older entries exist.
  if (entries.length === 0 && hasMore) void fetchPage(true)
}

clearBtn.addEventListener('click', () => {
  dialog.showModal()
  dlgCancel.focus()
})
dlgCancel.addEventListener('click', () => dialog.close('cancel'))
dlgErase.addEventListener('click', () => dialog.close('erase'))
dialog.addEventListener('close', () => {
  const erase = dialog.returnValue === 'erase'
  dialog.returnValue = ''
  if (!erase) {
    clearBtn.focus()
    return
  }
  void (async () => {
    const res = await api.history.clear()
    if (!res.ok) {
      status.textContent = "Couldn't erase the guestbook. Try again."
      clearBtn.focus()
      return
    }
    search.value = ''
    query = ''
    entries = []
    total = 0
    hasMore = false
    render()
    status.textContent = 'Guestbook erased.'
    search.focus()
  })()
})
// Click on the backdrop (outside the dialog box) cancels.
dialog.addEventListener('click', (ev) => {
  if (ev.target === dialog) {
    const r = dialog.getBoundingClientRect()
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
    if (!inside) dialog.close('cancel')
  }
})

let debounce: number | undefined
search.addEventListener('input', () => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => setQuery(search.value.trim()), 150)
})
search.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && search.value) {
    ev.preventDefault()
    search.value = ''
    setQuery('')
  }
})

function setQuery(q: string): void {
  if (q === query) return
  query = q
  void fetchPage(true)
}

moreBtn.addEventListener('click', () => void fetchPage(false))

// ---- helpers ----

/** Pages without a title sign with their host ("example.org"), so the URL isn't printed twice. */
function untitled(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname ? u.hostname.replace(/^www\./, '') : url
  } catch {
    return url
  }
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'retronet:' ? u.href : null
  } catch {
    return null
  }
}

function setFavicon(): void {
  if (document.querySelector('link[rel="icon"]')) return
  document.head.append(h('link', { attrs: { rel: 'icon', href: 'img/logo-16.svg', type: 'image/svg+xml' } }))
}
