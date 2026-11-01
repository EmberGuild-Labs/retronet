// retronet://downloads (T22, DESIGN 5.4, AC18). Live list of this profile's downloads, newest first, with
// pause / resume / cancel / open / show in folder / remove. Updates come from the `downloads` page event
// (upsert | remove | reset) and are painted at most 4 times a second. Filenames, URLs and paths are only ever
// rendered with textContent or attributes.
import { pageApi } from '../../common/api'
import { h, icon, keyedList } from '../../common/dom'
import { initSkin } from '../../common/skin-loader'
import type { PageEventPayload } from '@shared/ipc-contract'
import './downloads.css'

initSkin('page')

type Item = Extract<PageEventPayload<'downloads'>, { type: 'upsert' }>['item']
type ActionId = 'pause' | 'resume' | 'cancel' | 'open' | 'show' | 'remove'

const api = pageApi('downloads')
const items = new Map<string, Item>()

// ---------- formatting ----------
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let i = 0
  let v = n
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${UNITS[i]}`
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)} s left`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`
  return `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min left`
}

/** Keeps the start and the extension of long names visible: "a-very-long-report-na…final.pdf". */
function middleEllipsis(name: string, max = 56): string {
  if (name.length <= max) return name
  const tail = Math.min(18, Math.floor(max / 3))
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`
}

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host || u.protocol.replace(':', '')
  } catch {
    return ''
  }
}

function statusFor(it: Item): { text: string; tone: 'muted' | 'error' | 'normal' } {
  const got = formatBytes(it.receivedBytes)
  const total = it.totalBytes > 0 ? formatBytes(it.totalBytes) : ''
  switch (it.state) {
    case 'progressing': {
      const rate = it.bytesPerSecond > 0 ? `${formatBytes(it.bytesPerSecond)}/s` : 'Starting...'
      if (!total) return { text: `${got} · ${rate}`, tone: 'normal' }
      const eta = it.bytesPerSecond > 0 ? formatEta((it.totalBytes - it.receivedBytes) / it.bytesPerSecond) : ''
      return { text: [`${got} of ${total}`, rate, eta].filter(Boolean).join(' · '), tone: 'normal' }
    }
    case 'paused':
      return { text: total ? `Paused · ${got} of ${total}` : `Paused · ${got}`, tone: 'normal' }
    case 'completed':
      return { text: `${formatBytes(it.totalBytes || it.receivedBytes)} · Done`, tone: 'normal' }
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' }
    case 'interrupted':
      return { text: `Failed: ${it.error || 'network error'}`, tone: 'error' }
    case 'missing':
      return { text: 'File moved or deleted', tone: 'muted' }
  }
}

function actionsFor(state: Item['state']): ActionId[] {
  switch (state) {
    case 'progressing':
      return ['pause', 'cancel']
    case 'paused':
      return ['resume', 'cancel']
    case 'completed':
      return ['open', 'show', 'remove']
    default:
      return ['remove']
  }
}

const ACTION_LABEL: Record<ActionId, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  open: 'Open',
  show: 'Show in folder',
  remove: 'Remove from list'
}

// ---------- page frame ----------
const announcer = h('p', { class: 'rn-sr-only', attrs: { role: 'status' } })
const notice = h('p', { class: 'rn-note rn-downloads__notice', attrs: { role: 'status' } })
const list = h('ul', { class: 'rn-downloads', attrs: { 'aria-label': 'Downloads' } })
const empty = h(
  'div',
  { class: 'rn-empty' },
  h('p', { class: 'rn-empty__title', text: 'No downloads yet.' }),
  h('p', { text: 'Files you download show up here, newest first.' })
)
empty.hidden = true
const loading = h('p', { class: 'rn-loading', text: 'Opening the downloads list...' })
const errorBox = h('div', { class: 'rn-empty' })
errorBox.hidden = true

const folderBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('folder'), h('span', { class: 'rn-btn__label', text: 'Open downloads folder' }))
const clearBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Clear list' })
clearBtn.title = 'Removes finished, cancelled and failed downloads from this list. Files stay on disk.'

folderBtn.addEventListener('click', async () => {
  const res = await api.downloads.showFolder()
  if (!res.ok) say('Unable to open the downloads folder. Check that it still exists in Settings.')
})
clearBtn.addEventListener('click', async () => {
  const res = await api.downloads.clear()
  if (!res.ok) say('Unable to clear the list. Try again.')
  else {
    say('Finished downloads removed from the list. The files are still on disk.')
    await reload()
  }
})

let noticeTimer = 0
function say(text: string): void {
  notice.textContent = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.textContent = ''), 6000)
}

const main = h(
  'main',
  { class: 'rn-page' },
  h('div', { class: 'rn-page__header' }, h('h1', { text: 'Downloads' }), h('div', { class: 'rn-page__actions' }, folderBtn, clearBtn)),
  notice,
  loading,
  errorBox,
  empty,
  list,
  announcer
)
document.getElementById('app')?.replaceWith(main)

// ---------- rows ----------
interface RowRefs {
  name: HTMLElement
  source: HTMLElement
  status: HTMLElement
  progress: HTMLElement
  fill: HTMLElement
  actions: HTMLElement
  actionKey: string
  lastState: Item['state'] | null
}
const refs = new WeakMap<HTMLElement, RowRefs>()

async function act(id: string, action: ActionId, row: HTMLElement): Promise<void> {
  const res = await api.downloads[action]({ id })
  if (res.ok) {
    if (action === 'remove') {
      items.delete(id)
      // Keep keyboard users in the list: focus the next row's first action (or the previous one).
      const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null
      paint()
      const target = next?.querySelector<HTMLButtonElement>('.rn-download__actions .rn-btn') ?? folderBtn
      target.focus()
    }
    return
  }
  const name = items.get(id)?.filename ?? 'this download'
  if (action === 'open' || action === 'show') say(`Unable to find ${name}. It may have been moved or deleted.`)
  else say(`Unable to ${ACTION_LABEL[action].toLowerCase()} ${name}. Try again.`)
  void reload()
}

function createRow(it: Item): HTMLElement {
  const fileIcon = icon('page')
  fileIcon.dataset.size = '24'
  const name = h('div', { class: 'rn-download__name' })
  const source = h('div', { class: 'rn-download__source rn-muted' })
  const status = h('div', { class: 'rn-download__status' })
  const fill = h('span', { class: 'rn-progress__fill' })
  const progress = h('div', { class: 'rn-progress', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 } }, fill)
  const actions = h('div', { class: 'rn-download__actions' })
  const row = h(
    'li',
    { class: 'rn-panel rn-download', data: { id: it.id } },
    fileIcon,
    h('div', { class: 'rn-download__info' }, name, source, status),
    actions,
    progress
  )
  refs.set(row, { name, source, status, progress, fill, actions, actionKey: '', lastState: null })
  return row
}

function patchRow(row: HTMLElement, it: Item): void {
  const r = refs.get(row)
  if (!r) return
  row.dataset.state = it.state
  const shortName = middleEllipsis(it.filename)
  if (r.name.textContent !== shortName) r.name.textContent = shortName
  r.name.title = it.path || it.filename
  const src = hostOf(it.url)
  r.source.textContent = src
  r.source.title = it.url
  const st = statusFor(it)
  r.status.textContent = st.text
  r.status.classList.toggle('rn-download__status--error', st.tone === 'error')
  r.status.classList.toggle('rn-muted', st.tone === 'muted')

  const showProgress = it.state === 'progressing' || it.state === 'paused'
  r.progress.hidden = !showProgress
  const known = it.totalBytes > 0
  const pct = known ? Math.min(100, Math.round((it.receivedBytes / it.totalBytes) * 100)) : 0
  r.progress.classList.toggle('rn-progress--indeterminate', showProgress && !known)
  r.progress.classList.toggle('rn-progress--paused', it.state === 'paused')
  r.fill.style.width = known ? `${pct}%` : ''
  r.progress.setAttribute('aria-label', `${it.filename}: ${st.text}`)
  if (known) r.progress.setAttribute('aria-valuenow', String(pct))
  else r.progress.removeAttribute('aria-valuenow')

  const key = actionsFor(it.state).join(',')
  if (key !== r.actionKey) {
    const hadFocus = r.actions.contains(document.activeElement)
    r.actions.replaceChildren(
      ...actionsFor(it.state).map((a) => {
        const b = h('button', { class: 'rn-btn', attrs: { type: 'button', 'aria-label': `${ACTION_LABEL[a]}: ${it.filename}` }, text: ACTION_LABEL[a] })
        b.addEventListener('click', () => void act(it.id, a, row))
        return b
      })
    )
    r.actionKey = key
    if (hadFocus) r.actions.querySelector<HTMLButtonElement>('.rn-btn')?.focus()
  }
  if (r.lastState && r.lastState !== it.state) announce(it)
  r.lastState = it.state
}

function announce(it: Item): void {
  const words: Partial<Record<Item['state'], string>> = {
    completed: 'finished downloading',
    paused: 'paused',
    progressing: 'resumed',
    cancelled: 'cancelled',
    interrupted: 'failed to download',
    missing: 'was moved or deleted'
  }
  const w = words[it.state]
  if (w) announcer.textContent = `${it.filename} ${w}.`
}

const rows = keyedList<Item>(list, (it) => it.id, createRow, patchRow)

function paint(): void {
  const sorted = [...items.values()].sort((a, b) => b.startedAt - a.startedAt)
  rows.update(sorted)
  empty.hidden = sorted.length > 0
  list.hidden = sorted.length === 0
  clearBtn.disabled = !sorted.some((i) => i.state !== 'progressing' && i.state !== 'paused')
}

// 4 paints per second at most (DESIGN 5.4).
let paintTimer = 0
function schedulePaint(): void {
  if (paintTimer) return
  paintTimer = window.setTimeout(() => {
    paintTimer = 0
    paint()
  }, 250)
}

async function reload(): Promise<void> {
  const res = await api.downloads.list()
  loading.hidden = true
  if (!res.ok) {
    list.hidden = true
    empty.hidden = true
    errorBox.hidden = false
    const retry = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Try again' })
    retry.addEventListener('click', () => {
      errorBox.hidden = true
      loading.hidden = false
      void reload()
    })
    errorBox.replaceChildren(h('p', { text: "Couldn't read the downloads list." }), retry)
    return
  }
  errorBox.hidden = true
  items.clear()
  for (const it of res.data.items) items.set(it.id, it)
  paint()
}

api.on('downloads', (ev) => {
  if (ev.type === 'reset') void reload()
  else if (ev.type === 'remove') {
    items.delete(ev.id)
    schedulePaint()
  } else {
    items.set(ev.item.id, ev.item)
    schedulePaint()
  }
})

list.hidden = true
void reload()
