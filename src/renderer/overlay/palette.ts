// Command palette (AC22, AC24; DESIGN 3.7). Rows: every palette command from the shared registry with its
// shortcut, one row per skin and per profile, and the open tabs. Fuzzy filter as you type, Up/Down + Enter,
// Esc or a click outside closes, focus stays on the input (combobox + listbox pattern). Opens instantly.
import { COMMANDS, type CommandDef, type CommandId } from '@shared/commands'
import { SKINS } from '@shared/skins'
import type { OverlayEvent, ProfileInfo, TabState } from '@shared/types'
import { h, icon } from '../common/dom'
import { fuzzyMatch, highlightRuns } from './fuzzy'
import { nextId, safeFavicon, shortcutChips, trapFocus, type Mounted, type OverlayEnv } from './ui'

type PaletteEvent = Extract<OverlayEvent, { kind: 'palette' }>

interface Row {
  key: string
  label: string
  /** Extra text the filter also matches (tab URL), never shown. */
  alt?: string
  kind: '' | 'Tab' | 'Skin' | 'Profile'
  current?: boolean
  iconName: string
  favicon?: string | null
  accelerator?: string
  /** Commands win ties against tabs with the same score. */
  bias: number
  run(): void
}

const COMMAND_ICONS: Partial<Record<CommandId, string>> = {
  'tab.new': 'newtab',
  'tab.close': 'close',
  'tab.reopenClosed': 'newtab',
  'tab.togglePin': 'pin',
  'tab.toggleMute': 'muted',
  'window.newIncognito': 'incognito',
  'window.close': 'close',
  'nav.back': 'back',
  'nav.forward': 'forward',
  'nav.reload': 'reload',
  'nav.hardReload': 'reload',
  'nav.stop': 'stop',
  'nav.home': 'home',
  'omnibox.focus': 'globe',
  'find.open': 'find',
  'find.next': 'find',
  'find.previous': 'find',
  'zoom.in': 'search',
  'zoom.out': 'search',
  'zoom.reset': 'search',
  'bookmark.toggle': 'bookmark',
  'page.bookmarks': 'bookmark',
  'file.print': 'page',
  'page.history': 'history',
  'page.downloads': 'download',
  'page.settings': 'settings',
  'page.shortcuts': 'info',
  'page.about': 'info',
  'data.clear': 'trash',
  'profile.new': 'profile',
  'app.quit': 'close'
}

function commandIcon(c: CommandDef): string {
  return COMMAND_ICONS[c.id] ?? (c.category === 'Windows' ? 'page' : c.category === 'Tabs' ? 'page' : 'menu')
}

export function mountPalette(ev: PaletteEvent, env: OverlayEnv): Mounted {
  const { api, platform } = env
  const listId = nextId('rn-palette-list')
  const statusId = nextId('rn-palette-status')

  const input = h('input', {
    class: 'rn-palette__input',
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-label': 'Command',
      'aria-expanded': 'true',
      'aria-controls': listId,
      'aria-autocomplete': 'list',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Type a command, tab, skin or profile'
    }
  })
  const list = h('ul', { class: 'rn-palette__list', attrs: { id: listId, role: 'listbox', 'aria-label': 'Results' } })
  const status = h('div', { class: 'rn-sr-only', attrs: { id: statusId, role: 'status', 'aria-live': 'polite' } })
  const root = h(
    'div',
    { class: 'rn-dialog rn-palette', attrs: { role: 'dialog', 'aria-label': 'Command palette' } },
    h('h2', { class: 'rn-dialog__title', text: 'Run a command' }),
    h('div', { class: 'rn-dialog__body' }, input, list, status)
  )
  trapFocus(root)

  // ---- rows ----

  const run = (id: CommandId, arg?: string): void => {
    void api.commands.run(arg ? { id, arg } : { id }).then((r) => {
      if (!r.ok) env.close()
    })
  }

  function buildRows(): Row[] {
    const rows: Row[] = []
    const snap = env.snapshot()
    for (const c of COMMANDS) {
      if (!c.palette) continue
      if (c.arg === 'skin') {
        for (const s of SKINS) {
          rows.push({
            key: `skin:${s.id}`,
            label: `Switch skin: ${s.name}`,
            kind: 'Skin',
            current: snap?.skin === s.id,
            iconName: 'settings',
            bias: 0.5,
            run: () => run(c.id, s.id)
          })
        }
        continue
      }
      if (c.arg === 'profile') {
        for (const p of ev.profiles as ProfileInfo[]) {
          rows.push({
            key: `profile:${p.id}`,
            label: `Switch profile: ${p.name}`,
            kind: 'Profile',
            current: p.id === ev.currentProfileId,
            iconName: 'profile',
            bias: 0.5,
            run: () => run(c.id, p.id)
          })
        }
        continue
      }
      rows.push({
        key: `cmd:${c.id}`,
        label: c.title,
        kind: '',
        iconName: commandIcon(c),
        accelerator: c.accelerator[platform][0],
        bias: 1,
        run: () => run(c.id)
      })
    }
    for (const t of (snap?.tabs ?? []) as TabState[]) {
      rows.push({
        key: `tab:${t.id}`,
        label: t.title.trim() || t.url || 'Untitled',
        alt: t.url,
        kind: 'Tab',
        current: t.id === snap?.activeTabId,
        iconName: 'page',
        favicon: safeFavicon(t.faviconDataUrl),
        bias: 0,
        run: () => {
          void api.tabs.activate({ tabId: t.id }).finally(() => env.close())
        }
      })
    }
    return rows
  }

  const signature = (): string => {
    const snap = env.snapshot()
    return `${snap?.skin}|${snap?.activeTabId}|${(snap?.tabs ?? []).map((t) => `${t.id}:${t.title}:${t.url}:${t.faviconDataUrl?.length ?? 0}`).join('|')}`
  }
  let lastSig = signature()
  let rows = buildRows()
  let shown: Array<{ row: Row; positions: number[] }> = []
  let selected = 0
  let lastPointer: { x: number; y: number } | null = null

  function filter(): void {
    const q = input.value
    if (!q.trim()) {
      shown = rows.map((row) => ({ row, positions: [] }))
    } else {
      const scored: Array<{ row: Row; positions: number[]; score: number }> = []
      for (const row of rows) {
        const m = fuzzyMatch(q, row.label)
        if (m) {
          scored.push({ row, positions: m.positions, score: m.score + row.bias })
          continue
        }
        const alt = row.alt ? fuzzyMatch(q, row.alt) : null
        if (alt) scored.push({ row, positions: [], score: alt.score - 4 + row.bias })
      }
      scored.sort((a, b) => b.score - a.score)
      shown = scored
    }
    selected = shown.length > 0 ? 0 : -1
    render()
    const msg = shown.length === 0 ? 'No matching commands' : `${shown.length} result${shown.length === 1 ? '' : 's'}`
    if (status.textContent !== msg) status.textContent = msg
  }

  function rowId(i: number): string {
    return `${listId}-${i}`
  }

  function render(): void {
    const items: HTMLElement[] = []
    if (shown.length === 0) {
      items.push(h('li', { class: 'rn-palette__item rn-palette__item--empty', attrs: { role: 'presentation' }, text: 'No matching commands' }))
    }
    shown.forEach(({ row, positions }, i) => {
      const label = h('span', { class: 'rn-palette__label' })
      for (const run of highlightRuns(row.label, positions)) label.append(run.mark ? h('mark', { text: run.text }) : run.text)
      const keys = shortcutChips(row.accelerator, platform)
      const kindText = row.kind && row.current ? `Current ${row.kind.toLowerCase()}` : row.kind
      const lead = row.favicon
        ? h('img', { class: 'rn-palette__favicon', attrs: { src: row.favicon, alt: '', width: 16, height: 16, draggable: 'false' } })
        : icon(row.iconName)
      const spoken = [row.label, kindText, keys.spoken && `shortcut ${keys.spoken}`].filter(Boolean).join(', ')
      const li = h(
        'li',
        {
          class: ['rn-palette__item', i === selected && 'rn-palette__item--selected'],
          attrs: { id: rowId(i), role: 'option', 'aria-selected': i === selected ? 'true' : 'false', 'aria-label': spoken, title: row.alt ? `${row.label}\n${row.alt}` : row.label },
          data: { key: row.key }
        },
        lead,
        label,
        kindText ? h('span', { class: 'rn-palette__kind', text: kindText }) : null,
        keys.el
      )
      li.addEventListener('mousemove', (e) => {
        // Chromium sends a mousemove when rows appear under a resting pointer; only a real move takes the selection.
        const moved = lastPointer !== null && (lastPointer.x !== e.screenX || lastPointer.y !== e.screenY)
        lastPointer = { x: e.screenX, y: e.screenY }
        if (moved && selected !== i) select(i, false)
      })
      li.addEventListener('click', () => activate(i))
      items.push(li)
    })
    list.replaceChildren(...items)
    syncActive(true)
  }

  function syncActive(scroll: boolean): void {
    if (selected >= 0) input.setAttribute('aria-activedescendant', rowId(selected))
    else input.removeAttribute('aria-activedescendant')
    if (scroll && selected >= 0) list.children[selected]?.scrollIntoView({ block: 'nearest' })
  }

  function select(i: number, scroll = true): void {
    const prev = list.children[selected]
    prev?.classList.remove('rn-palette__item--selected')
    prev?.setAttribute('aria-selected', 'false')
    selected = i
    const cur = list.children[selected]
    cur?.classList.add('rn-palette__item--selected')
    cur?.setAttribute('aria-selected', 'true')
    syncActive(scroll)
  }

  function activate(i: number): void {
    const entry = shown[i]
    if (entry) entry.row.run()
  }

  input.addEventListener('input', filter)
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    const n = shown.length
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        if (n === 0) return
        const step = e.key === 'ArrowDown' ? 1 : -1
        select((selected + step + n) % n)
        return
      }
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault()
        if (n === 0) return
        select(Math.min(n - 1, Math.max(0, selected + (e.key === 'PageDown' ? 9 : -9))))
        return
      }
      case 'Enter':
        e.preventDefault()
        if (selected >= 0) activate(selected)
        return
      case 'Escape':
        e.preventDefault()
        env.close()
        return
    }
  })

  filter()
  queueMicrotask(() => input.focus())

  return {
    root,
    onOutside: () => env.close(),
    onState: () => {
      // Tabs or skin changed underneath (e.g. a tab closed): rebuild rows, keep the query and selection key.
      // Snapshots also arrive for loading/progress changes; ignore those.
      const sig = signature()
      if (sig === lastSig) return
      lastSig = sig
      const key = shown[selected]?.row.key
      rows = buildRows()
      filter()
      const at = shown.findIndex((s) => s.row.key === key)
      if (at >= 0) select(at)
    }
  }
}
