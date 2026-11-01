// retronet://shortcuts (T21, DESIGN 5.6, AC23). Generated from commands.list, so it always matches what main
// binds: one table per category, key caps in the platform's notation (⌘⇧T on macOS, Ctrl+Shift+T on Windows),
// filtered by a search box that matches the action name or the shortcut.
import { initSkin } from '../../common/skin-loader'
import { h, icon } from '../../common/dom'
import { pageApi } from '../../common/api'
import { acceleratorLabel, acceleratorParts, type Platform } from '@shared/commands'

interface CommandInfo {
  id: string
  title: string
  category: string
  accelerators: string[]
}
import './page.css'

initSkin('page')

const api = pageApi('shortcuts')
const app = document.getElementById('app') as HTMLElement

setFavicon()

const filter = h('input', {
  class: 'rn-input',
  attrs: { id: 'rn-sc-filter', type: 'search', placeholder: 'Search shortcuts', autocomplete: 'off', spellcheck: 'false' }
})
const status = h('p', { class: 'rn-note rn-shortcuts__status', attrs: { role: 'status' } })
const groupsEl = h('div', { class: 'rn-shortcuts__groups' })
const intro = h('p', { class: 'rn-muted' })

app.classList.add('rn-shortcuts')
app.replaceChildren(
  h('h1', { text: 'Keyboard shortcuts' }),
  intro,
  h('div', { class: 'rn-toolbar-row rn-shortcuts__toolbar' }, h('label', { class: 'rn-sr-only', attrs: { for: 'rn-sc-filter' }, text: 'Search shortcuts' }), filter),
  status,
  groupsEl
)

interface Row {
  cmd: CommandInfo
  el: HTMLTableRowElement
  haystack: string
}
interface Group {
  section: HTMLElement
  rows: Row[]
}
let groups: Group[] = []

void api.commands.list().then((r) => {
  if (!r.ok) {
    const retry = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('reload'), h('span', { class: 'rn-btn__label', text: 'Try again' }))
    retry.addEventListener('click', () => location.reload())
    groupsEl.replaceChildren(h('div', { class: 'rn-empty', attrs: { role: 'alert' } }, h('p', { class: 'rn-error-text', text: "Couldn't load the shortcut list." }), retry))
    return
  }
  build(r.data.platform, r.data.commands)
})

function build(platform: Platform, commands: readonly CommandInfo[]): void {
  const palette = commands.find((c) => c.id === 'palette.open')?.accelerators[0]
  intro.replaceChildren(
    'Every action below also lives in the command palette',
    ...(palette ? [' (', ...keys(palette, platform), ')'] : []),
    '. Type a few letters there to run it.'
  )
  const byCat = new Map<string, CommandInfo[]>()
  for (const c of commands) {
    const list = byCat.get(c.category) ?? []
    list.push(c)
    byCat.set(c.category, list)
  }
  groups = [...byCat].map(([cat, cmds], i) => {
    const id = `rn-sc-${i}`
    const rows: Row[] = cmds.map((cmd) => {
      const labels = cmd.accelerators.map((a) => safeLabel(a, platform))
      const keysCell = h('td', { class: 'rn-shortcuts__keys' })
      if (cmd.accelerators.length === 0) keysCell.append(h('span', { class: 'rn-muted', text: 'Palette only' }))
      cmd.accelerators.forEach((a, j) => {
        if (j > 0) keysCell.append(h('span', { class: 'rn-muted rn-shortcuts__or', text: ' or ' }))
        keysCell.append(
          h('span', { class: 'rn-shortcuts__combo' }, h('span', { class: 'rn-sr-only', text: spoken(a, platform) }), h('span', { attrs: { 'aria-hidden': 'true' } }, ...keys(a, platform)))
        )
      })
      const el = h('tr', {}, h('td', { class: 'rn-shortcuts__action', text: cmd.title }), keysCell)
      return { cmd, el, haystack: `${cmd.title} ${cat} ${labels.join(' ')}`.toLowerCase() }
    })
    const section = h(
      'section',
      { class: 'rn-shortcuts__group', attrs: { 'aria-labelledby': id } },
      h('h2', { attrs: { id }, text: cat }),
      h(
        'table',
        { class: 'rn-table' },
        h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: 'Action' }), h('th', { attrs: { scope: 'col' }, text: 'Shortcut' }))),
        h('tbody', {}, ...rows.map((r) => r.el))
      )
    )
    return { section, rows }
  })
  groupsEl.replaceChildren(...groups.map((g) => g.section))
}

function keys(accelerator: string, platform: Platform): HTMLElement[] {
  try {
    return acceleratorParts(accelerator, platform).map((k) => h('kbd', { class: 'rn-kbd', text: k }))
  } catch {
    return [h('kbd', { class: 'rn-kbd', text: accelerator })]
  }
}

function safeLabel(accelerator: string, platform: Platform): string {
  try {
    return `${acceleratorLabel(accelerator, platform)} ${accelerator}`
  } catch {
    return accelerator
  }
}

const SPOKEN: Readonly<Record<string, string>> = {
  '⌘': 'Command', '⇧': 'Shift', '⌥': 'Option', '⌃': 'Control', '←': 'Left Arrow', '→': 'Right Arrow',
  '↑': 'Up Arrow', '↓': 'Down Arrow', '⌫': 'Delete', '⌦': 'Forward Delete', '⇥': 'Tab', '↩': 'Return', '+': 'Plus'
}
/** Screen readers skip or mangle ⌘⇧ glyphs; give the combo a spoken name ("Command Shift T"). */
function spoken(accelerator: string, platform: Platform): string {
  try {
    return acceleratorParts(accelerator, platform).map((k) => SPOKEN[k] ?? k).join(' ')
  } catch {
    return accelerator
  }
}

let debounce: number | undefined
filter.addEventListener('input', () => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(applyFilter, 100)
})
filter.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && filter.value) {
    ev.preventDefault()
    filter.value = ''
    applyFilter()
  }
})

function applyFilter(): void {
  const terms = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let shown = 0
  for (const g of groups) {
    let any = false
    for (const r of g.rows) {
      const hit = terms.every((t) => r.haystack.includes(t))
      r.el.hidden = !hit
      if (hit) {
        any = true
        shown++
      }
    }
    g.section.hidden = !any
  }
  const existing = groupsEl.querySelector('.rn-shortcuts__none')
  existing?.remove()
  if (!terms.length) {
    status.textContent = ''
    return
  }
  if (shown === 0) {
    groupsEl.append(h('div', { class: 'rn-empty rn-shortcuts__none' }, h('p', { text: `No shortcuts match “${filter.value.trim()}”.` })))
    status.textContent = 'No shortcuts match.'
  } else status.textContent = `${shown} ${shown === 1 ? 'shortcut matches' : 'shortcuts match'}`
}

function setFavicon(): void {
  if (document.querySelector('link[rel="icon"]')) return
  document.head.append(h('link', { attrs: { rel: 'icon', href: 'img/logo-16.svg', type: 'image/svg+xml' } }))
}
