// Tab strip (T18; DESIGN 2.1-2.5, 3.3, 6.2-6.5). Renders the window snapshot's tabs and group chips into the
// `.rn-tabstrip` markup the skins style, and turns pointer and keyboard input into tabs.* / groups.* calls.
//
// - Keyed rendering: one node per tab id and per group id, patched in place, so 30+ tabs re-render with no thrash.
//   Layout is read only on pointer drags, scroll-button checks (ResizeObserver) and when the active tab changes.
// - Interaction: pointerdown activates (like other browsers), middle-click or × closes, drag reorders with
//   neighbours sliding out of the way (150ms transform, instant under reduced motion) and can join or leave a
//   group, a chip click toggles collapse, F2 on a chip opens the overlay group editor, right-click (or Shift+F10 /
//   the context-menu key) opens the native tab/group menu.
// - Keyboard: the tablist is one Tab stop with a roving tabindex (DESIGN 6.3). Arrows/Home/End move focus,
//   Enter/Space activates, Delete/Backspace closes, Cmd/Ctrl+Shift+Arrow or PageUp/PageDown moves the tab.
import type { ShellBridge } from '../common/api'
import { h, icon, keyedList } from '../common/dom'
import { displayUrl } from '@shared/url-safety'
import { dropPayload } from '@shared/omnibox'
import type { GroupState, TabState, WindowSnapshot } from '@shared/types'
import './tabstrip.css'

export interface TabStripHandle {
  /** Render a snapshot now (mount already subscribes to `state`; use this to feed a cached one). */
  update(snapshot: WindowSnapshot): void
  /** Focus the active tab (F6 / keyboard entry into the strip). */
  focus(): void
  destroy(): void
}

type Item = { kind: 'tab'; tab: TabState; group: GroupState | null; last: boolean } | { kind: 'chip'; group: GroupState; count: number }

const DRAG_THRESHOLD = 5
const EDGE_SCROLL = 28

/** Visible label for a tab: its title, or the host while the first title hasn't arrived. */
export function tabLabel(tab: TabState): string {
  if (tab.title.trim()) return tab.title
  try {
    const u = new URL(tab.url)
    if (u.protocol === 'retronet:' && u.host === 'newtab') return 'New Tab'
    if (u.host) return u.host
  } catch {
    /* fall through */
  }
  return tab.url || 'New Tab'
}

function groupName(g: GroupState): string {
  return g.name.trim() || `Unnamed ${g.color} group`
}

function isDataImage(src: string | null): src is string {
  return !!src && /^data:image\//i.test(src)
}

/** Builds the strip order: pinned tabs, then tabs with a chip before each group's first member. */
export function buildItems(s: WindowSnapshot): Item[] {
  const groups = new Map(s.groups.map((g) => [g.id, g]))
  const counts = new Map<string, number>()
  for (const t of s.tabs) if (t.groupId && groups.has(t.groupId)) counts.set(t.groupId, (counts.get(t.groupId) ?? 0) + 1)
  const items: Item[] = []
  const chipped = new Set<string>()
  s.tabs.forEach((tab, i) => {
    const group = !tab.pinned && tab.groupId ? (groups.get(tab.groupId) ?? null) : null
    if (group && !chipped.has(group.id)) {
      chipped.add(group.id)
      items.push({ kind: 'chip', group, count: counts.get(group.id) ?? 0 })
    }
    const next = s.tabs[i + 1]
    items.push({ kind: 'tab', tab, group, last: !!group && next?.groupId !== group.id })
  })
  return items
}

const keyOf = (it: Item): string => (it.kind === 'tab' ? `t${it.tab.id}` : `g${it.group.id}`)

export function mountTabStrip(el: HTMLElement, api: ShellBridge): TabStripHandle {
  el.classList.add('rn-tabstrip')
  el.replaceChildren()
  const isMac = api.platform === 'mac'

  const list = h('div', { class: 'rn-tabstrip__tabs', attrs: { role: 'tablist', 'aria-label': 'Tabs', 'aria-orientation': 'horizontal' } })
  const drop = h('div', { class: 'rn-tabstrip__drop', attrs: { 'aria-hidden': 'true', hidden: true } })
  const newBtn = h(
    'button',
    {
      class: 'rn-btn rn-btn--icon rn-tabstrip__new',
      attrs: { type: 'button', 'aria-label': 'New tab', title: `New tab (${isMac ? '⌘T' : 'Ctrl+T'})` }
    },
    icon('newtab')
  )
  const scrollLeft = h(
    'button',
    { class: 'rn-btn rn-tabstrip__scroll', attrs: { type: 'button', tabindex: -1, 'aria-label': 'Scroll tabs left', title: 'Scroll tabs left', hidden: true } },
    icon('chevron-left')
  )
  const scrollRight = h(
    'button',
    { class: 'rn-btn rn-tabstrip__scroll', attrs: { type: 'button', tabindex: -1, 'aria-label': 'Scroll tabs right', title: 'Scroll tabs right', hidden: true } },
    icon('chevron-right')
  )
  el.append(
    h('div', { class: 'rn-titlebar-spacer', attrs: { 'aria-hidden': 'true' } }),
    list,
    newBtn,
    h('div', { class: 'rn-tabstrip__fill', attrs: { 'aria-hidden': 'true' } }),
    scrollLeft,
    scrollRight,
    h('span', { class: 'rn-incognito-badge' }, icon('incognito'), 'Incognito')
  )

  let snap: WindowSnapshot | null = null
  let items: Item[] = []
  let lastActive: number | null = null
  /** The roving tab stop (an item key); null = the active tab. */
  let rovingKey: string | null = null
  let pendingFocus: string | null = null
  const reduced = (): boolean =>
    document.documentElement.dataset.reducedMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- per-item nodes ----
  interface TabNode extends HTMLElement {
    _fav?: HTMLElement
    _favKey?: string
    _title?: HTMLElement
    _audio?: HTMLElement | null
    _audioKey?: string
  }

  function createItem(it: Item): HTMLElement {
    if (it.kind === 'chip') {
      const chip = h('button', { class: 'rn-group-chip', attrs: { type: 'button' }, data: { groupId: it.group.id } })
      return chip
    }
    const node: TabNode = h('div', { class: 'rn-tab', attrs: { role: 'tab' }, data: { tabId: it.tab.id } })
    node._title = h('span', { class: 'rn-tab__title' })
    const close = h('button', {
      class: 'rn-tab__close',
      attrs: { type: 'button', tabindex: -1, 'aria-label': 'Close tab', title: `Close tab (${isMac ? '⌘W' : 'Ctrl+W'})` }
    }, icon('close'))
    node.append(node._title, close)
    return node
  }

  function patchChip(chip: HTMLElement, g: GroupState, count: number): void {
    const named = !!g.name.trim()
    chip.className = g.collapsed ? 'rn-group-chip rn-group-chip--collapsed' : 'rn-group-chip'
    chip.dataset.color = g.color
    chip.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true')
    const tabs = `${count} ${count === 1 ? 'tab' : 'tabs'}`
    chip.setAttribute('aria-label', `Group ${named ? g.name : 'unnamed'}, ${g.color}, ${tabs}`)
    chip.title = `${named ? g.name : 'Unnamed group'} (${tabs}). Click to ${g.collapsed ? 'expand' : 'collapse'}, F2 or right-click to edit`
    const sig = `${g.collapsed}|${g.name}|${count}`
    if (chip.dataset.sig === sig) return
    chip.dataset.sig = sig
    chip.replaceChildren(
      icon(g.collapsed ? 'chevron-right' : 'chevron-down'),
      named ? h('span', { class: 'rn-group-chip__name', text: g.name }) : h('span', { class: 'rn-group-chip__swatch' }),
      ...(g.collapsed || !named ? [h('span', { class: 'rn-group-chip__count', text: `(${count})` })] : [])
    )
  }

  function patchTab(node: TabNode, it: Extract<Item, { kind: 'tab' }>): void {
    const { tab, group } = it
    const active = snap?.activeTabId === tab.id
    const audible = !!tab.audible && !tab.muted
    const label = tabLabel(tab)
    const cls = ['rn-tab']
    if (active) cls.push('rn-tab--active')
    if (tab.pinned) cls.push('rn-tab--pinned')
    if (tab.loading) cls.push('rn-tab--loading')
    if (audible) cls.push('rn-tab--audible')
    if (tab.muted) cls.push('rn-tab--muted')
    if (it.last) cls.push('rn-tab--group-last')
    if (node.classList.contains('rn-tab--dragging')) cls.push('rn-tab--dragging')
    if (node.classList.contains('rn-tab--drop-target')) cls.push('rn-tab--drop-target')
    node.className = cls.join(' ')
    if (group) node.dataset.groupColor = group.color
    else delete node.dataset.groupColor
    node.hidden = !!group?.collapsed
    node.setAttribute('aria-selected', active ? 'true' : 'false')
    const extras = [
      tab.pinned && 'pinned',
      tab.loading && 'loading',
      audible && 'playing audio',
      tab.muted && 'muted',
      group && `in group ${groupName(group)}`
    ].filter(Boolean)
    node.setAttribute('aria-label', extras.length ? `${label}, ${extras.join(', ')}` : label)
    const shownUrl = displayUrl(tab.url) // never a user:pass@ in the tooltip (Q6)
    node.title = label === shownUrl || !shownUrl ? label : `${label}\n${shownUrl}`
    if (node._title && node._title.textContent !== label) node._title.textContent = label

    // favicon slot: loading spinner sprite > page favicon (data: only, CSP) > generic page icon
    const favKey = tab.loading ? 'loading' : isDataImage(tab.faviconDataUrl) ? tab.faviconDataUrl : 'page'
    if (node._favKey !== favKey) {
      const fav: HTMLElement =
        favKey === 'loading' || favKey === 'page'
          ? h('span', { class: 'rn-tab__favicon rn-icon', data: { icon: favKey }, attrs: { 'aria-hidden': 'true' } })
          : h('img', { class: 'rn-tab__favicon', attrs: { src: favKey, alt: '', draggable: 'false' } })
      if (node._fav) node._fav.replaceWith(fav)
      else node.prepend(fav)
      node._fav = fav
      node._favKey = favKey
    }

    // audio: a toggle button on normal tabs, a decorative dot on pinned ones (DESIGN 3.3)
    const audioKey = !tab.audible && !tab.muted ? '' : `${tab.pinned ? 'p' : 'n'}${tab.muted ? 'm' : 'a'}`
    if (node._audioKey !== audioKey) {
      node._audio?.remove()
      node._audio = null
      if (audioKey) {
        const a = tab.pinned
          ? h('span', { class: 'rn-tab__audio', attrs: { 'aria-hidden': 'true' } })
          : h(
              'button',
              {
                class: 'rn-tab__audio',
                attrs: { type: 'button', tabindex: -1, 'aria-label': tab.muted ? 'Unmute tab' : 'Mute tab', title: tab.muted ? 'Unmute tab' : 'Mute tab' }
              },
              icon(tab.muted ? 'muted' : 'audio')
            )
        node._title?.after(a)
        node._audio = a
      }
      node._audioKey = audioKey
    }
  }

  const keyed = keyedList<Item>(list, keyOf, createItem, (node, it) => {
    if (it.kind === 'chip') patchChip(node, it.group, it.count)
    else patchTab(node as TabNode, it)
  })

  // ---- render ----
  function focusables(): HTMLElement[] {
    return items.map((it) => keyed.get(keyOf(it))).filter((n): n is HTMLElement => !!n && !n.hidden)
  }

  function render(): void {
    if (!snap) return
    el.hidden = snap.popup
    items = buildItems(snap)
    keyed.update(items)
    list.append(drop) // keep the indicator last so it never splits the keyed order

    // roving tabindex: the focused/remembered item, else the active tab, else the first visible item
    const visible = focusables()
    const activeKey = snap.activeTabId !== null ? `t${snap.activeTabId}` : null
    if (!list.contains(document.activeElement)) rovingKey = null
    const stop = (rovingKey && visible.find((n) => keyFor(n) === rovingKey)) || visible.find((n) => keyFor(n) === activeKey) || visible[0]
    for (const n of list.children) if (n instanceof HTMLElement && n !== drop) n.tabIndex = n === stop ? 0 : -1

    if (pendingFocus) {
      const target = visible.find((n) => keyFor(n) === pendingFocus)
      pendingFocus = null
      if (target) focusItem(target)
    } else if (list.contains(document.activeElement) && document.activeElement instanceof HTMLElement && !visible.includes(document.activeElement)) {
      if (stop) focusItem(stop)
    }

    if (snap.activeTabId !== lastActive) {
      lastActive = snap.activeTabId
      const n = activeKey ? keyed.get(activeKey) : undefined
      if (n && !n.hidden) requestAnimationFrame(() => n.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
    queueOverflowCheck()
  }

  function keyFor(n: HTMLElement): string {
    return n.dataset.tabId ? `t${n.dataset.tabId}` : `g${n.dataset.groupId}`
  }

  function focusItem(n: HTMLElement): void {
    for (const c of list.children) if (c instanceof HTMLElement && c !== drop) c.tabIndex = c === n ? 0 : -1
    rovingKey = keyFor(n)
    n.focus({ preventScroll: true })
    n.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // ---- overflow + scroll buttons ----
  let overflowQueued = false
  function queueOverflowCheck(): void {
    if (overflowQueued) return
    overflowQueued = true
    requestAnimationFrame(() => {
      overflowQueued = false
      const over = list.scrollWidth > list.clientWidth + 1
      scrollLeft.hidden = !over
      scrollRight.hidden = !over
      scrollLeft.disabled = list.scrollLeft <= 0
      scrollRight.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1
    })
  }
  const ro = new ResizeObserver(queueOverflowCheck)
  ro.observe(list)
  list.addEventListener('scroll', queueOverflowCheck, { passive: true })
  const scrollBy = (dir: number): void =>
    list.scrollBy({ left: dir * Math.max(120, list.clientWidth * 0.75), behavior: reduced() ? 'auto' : 'smooth' })
  scrollLeft.addEventListener('click', () => scrollBy(-1))
  scrollRight.addEventListener('click', () => scrollBy(1))
  // vertical wheels scroll the strip sideways when it overflows (trackpads already send deltaX)
  list.addEventListener(
    'wheel',
    (e) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      list.scrollLeft += e.deltaY
      e.preventDefault()
    },
    { passive: false }
  )

  // ---- actions ----
  const tabOf = (id: number): TabState | undefined => snap?.tabs.find((t) => t.id === id)
  const itemEl = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest<HTMLElement>('.rn-tab, .rn-group-chip') ?? null) : null
  const ignore = (p: Promise<unknown>): void => void p.catch(() => undefined)

  function activate(id: number): void {
    if (snap?.activeTabId !== id) ignore(api.tabs.activate({ tabId: id }))
  }
  function closeTab(id: number, viaKeyboard = false): void {
    if (viaKeyboard) {
      const vis = focusables()
      const i = vis.findIndex((n) => n.dataset.tabId === String(id))
      const next = vis[i + 1] ?? vis[i - 1]
      pendingFocus = next ? keyFor(next) : null
    }
    ignore(api.tabs.close({ tabId: id }))
  }
  function menuAt(n: HTMLElement, e?: MouseEvent): { x: number; y: number } {
    if (e && (e.clientX || e.clientY)) return { x: Math.round(e.clientX), y: Math.round(e.clientY) }
    const r = n.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.bottom) }
  }
  function openMenu(n: HTMLElement, e?: MouseEvent): void {
    const at = menuAt(n, e)
    if (n.dataset.tabId) ignore(api.tabs.contextMenu({ tabId: Number(n.dataset.tabId), ...at }))
    else if (n.dataset.groupId) ignore(api.groups.contextMenu({ groupId: n.dataset.groupId, ...at }))
  }
  function editGroup(chip: HTMLElement): void {
    const r = chip.getBoundingClientRect()
    ignore(api.groups.edit({ groupId: chip.dataset.groupId as string, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } }))
  }
  function moveTab(id: number, delta: number): void {
    if (!snap) return
    const tab = tabOf(id)
    if (!tab) return
    const from = snap.tabs.indexOf(tab)
    const to = from + delta
    const peer = snap.tabs[to]
    if (!peer || peer.pinned !== tab.pinned) return
    pendingFocus = `t${id}`
    ignore(api.tabs.move({ tabId: id, index: to }))
  }

  newBtn.addEventListener('click', () => ignore(api.tabs.create({})))

  list.addEventListener('click', (e) => {
    const t = e.target as Element
    const n = itemEl(t)
    if (!n) return
    if (n.dataset.groupId) {
      const g = snap?.groups.find((x) => x.id === n.dataset.groupId)
      if (g) ignore(api.groups.update({ groupId: g.id, collapsed: !g.collapsed }))
      rovingKey = keyFor(n)
      return
    }
    const id = Number(n.dataset.tabId)
    if (t.closest('.rn-tab__close')) closeTab(id)
    else if (t.closest('button.rn-tab__audio')) ignore(api.tabs.toggleMute({ tabId: id }))
  })
  // middle-click closes; stop the middle-button autoscroll cursor
  list.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault()
  })
  list.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const n = itemEl(e.target)
    if (n?.dataset.tabId) {
      e.preventDefault()
      closeTab(Number(n.dataset.tabId))
    }
  })
  list.addEventListener('contextmenu', (e) => {
    const n = itemEl(e.target)
    if (!n) return
    e.preventDefault()
    openMenu(n, e)
  })
  // double-click on empty strip space opens a new tab (the window-drag areas handle zoom/minimise themselves)
  list.addEventListener('dblclick', (e) => {
    if (e.target === list) ignore(api.tabs.create({}))
  })

  list.addEventListener('keydown', (e) => {
    const n = itemEl(e.target)
    if (!n) return
    const vis = focusables()
    const i = vis.indexOf(n)
    const mod = isMac ? e.metaKey : e.ctrlKey
    const tabId = n.dataset.tabId ? Number(n.dataset.tabId) : null
    if (tabId !== null && ((mod && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) || (e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')))) {
      e.preventDefault()
      moveTab(tabId, e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 1)
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let target: HTMLElement | undefined
    switch (e.key) {
      case 'ArrowLeft':
        target = vis[(i - 1 + vis.length) % vis.length]
        break
      case 'ArrowRight':
        target = vis[(i + 1) % vis.length]
        break
      case 'Home':
        target = vis[0]
        break
      case 'End':
        target = vis[vis.length - 1]
        break
      case 'Enter':
      case ' ':
        if (tabId !== null) {
          e.preventDefault()
          activate(tabId)
        }
        return // chips are buttons: Enter/Space click them natively
      case 'Delete':
      case 'Backspace':
        if (tabId !== null) {
          e.preventDefault()
          closeTab(tabId, true)
        }
        return
      case 'F2':
        if (n.dataset.groupId) {
          e.preventDefault()
          editGroup(n)
        }
        return
      case 'F10':
        if (!e.shiftKey) return
        e.preventDefault()
        openMenu(n)
        return
      case 'ContextMenu':
        e.preventDefault()
        openMenu(n)
        return
      default:
        return
    }
    e.preventDefault()
    if (target) focusItem(target)
  })
  list.addEventListener('focusin', (e) => {
    const n = itemEl(e.target)
    if (n) rovingKey = keyFor(n)
  })

  // ---- drag reorder (pointer events) ----
  interface Unit {
    el: HTMLElement
    item: Item
    left: number
    width: number
  }
  interface Drag {
    id: number
    el: HTMLElement
    pointerId: number
    startX: number
    lastX: number
    started: boolean
    pinned: boolean
    units: Unit[]
    origSlot: number
    slot: number
    shift: number
    origLeft: number
    width: number
    startScroll: number
    raf: number
  }
  let drag: Drag | null = null

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return
    const t = e.target as Element
    const n = itemEl(t)
    if (!n?.dataset.tabId || t.closest('.rn-tab__close, button.rn-tab__audio')) return
    const id = Number(n.dataset.tabId)
    const tab = tabOf(id)
    if (!tab) return
    activate(id)
    drag = {
      id,
      el: n,
      pointerId: e.pointerId,
      startX: e.clientX,
      lastX: e.clientX,
      started: false,
      pinned: tab.pinned,
      units: [],
      origSlot: 0,
      slot: 0,
      shift: 0,
      origLeft: 0,
      width: 0,
      startScroll: list.scrollLeft,
      raf: 0
    }
    n.setPointerCapture(e.pointerId)
  })

  function beginDrag(d: Drag): void {
    d.started = true
    const all = items
      .map((it) => ({ it, el: keyed.get(keyOf(it)) }))
      .filter((x): x is { it: Item; el: HTMLElement } => !!x.el && !x.el.hidden)
    const zone = all.filter(({ it }) => (it.kind === 'tab' ? it.tab.pinned : false) === d.pinned)
    const style = getComputedStyle(d.el)
    d.origLeft = d.el.offsetLeft
    d.width = d.el.offsetWidth + parseFloat(style.marginRight || '0') + parseFloat(style.marginLeft || '0')
    d.units = []
    d.origSlot = 0
    for (const { it, el: uel } of zone) {
      if (uel === d.el) {
        d.origSlot = d.units.length
        continue
      }
      d.units.push({ el: uel, item: it, left: uel.offsetLeft, width: uel.offsetWidth })
    }
    d.slot = d.origSlot
    el.classList.add('rn-tabstrip--dragging')
    d.el.classList.add('rn-tab--dragging')
  }

  function layoutDrag(d: Drag): void {
    // keep the tab inside its zone (pinned tabs among pinned, others after them)
    const first = d.units[0]
    const last = d.units[d.units.length - 1]
    const lo = Math.min(d.origLeft, first?.left ?? d.origLeft) - d.origLeft
    const hi = Math.max(d.origLeft, last ? last.left + last.width - d.el.offsetWidth : d.origLeft) - d.origLeft
    const dx = Math.min(hi, Math.max(lo, d.lastX - d.startX + (list.scrollLeft - d.startScroll)))
    d.el.style.transform = `translateX(${dx}px)`
    const center = d.origLeft + d.el.offsetWidth / 2 + dx
    let slot = 0
    for (const u of d.units) if (u.left + u.width / 2 < center) slot++
    d.slot = slot
    d.units.forEach((u, i) => {
      // units between the old and new slot slide over by the dragged tab's width
      const off = i >= slot && i < d.origSlot ? d.width : i >= d.origSlot && i < slot ? -d.width : 0
      u.el.style.transform = off ? `translateX(${off}px)` : ''
    })
    // drop indicator sits at the leading edge of the slot
    const before = d.units[slot - 1]
    const after = d.units[slot]
    let x = d.origLeft
    if (slot > d.origSlot && before) x = before.left + before.width - d.el.offsetWidth
    else if (slot < d.origSlot && after) x = after.left
    x -= 3
    drop.style.transform = `translateX(${Math.round(x)}px)`
    drop.hidden = false
  }

  function autoScroll(d: Drag): void {
    cancelAnimationFrame(d.raf)
    const r = list.getBoundingClientRect()
    const v = d.lastX < r.left + EDGE_SCROLL ? -8 : d.lastX > r.right - EDGE_SCROLL ? 8 : 0
    if (!v) return
    const step = (): void => {
      if (drag !== d) return
      const before = list.scrollLeft
      list.scrollLeft += v
      if (list.scrollLeft !== before) layoutDrag(d)
      d.raf = requestAnimationFrame(step)
    }
    d.raf = requestAnimationFrame(step)
  }

  list.addEventListener('pointermove', (e) => {
    const d = drag
    if (!d || e.pointerId !== d.pointerId) return
    d.lastX = e.clientX
    if (!d.started) {
      if (Math.abs(d.lastX - d.startX) < DRAG_THRESHOLD) return
      beginDrag(d)
    }
    layoutDrag(d)
    autoScroll(d)
  })

  function endDrag(commit: boolean): void {
    const d = drag
    drag = null
    if (!d) return
    cancelAnimationFrame(d.raf)
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    if (!d.started) return
    // settle instantly: the new order is rendered optimistically below, so nothing should slide back
    el.classList.remove('rn-tabstrip--dragging')
    el.classList.add('rn-tabstrip--settling')
    d.el.classList.remove('rn-tab--dragging')
    d.el.style.transform = ''
    for (const u of d.units) u.el.style.transform = ''
    drop.hidden = true
    if (commit && snap && d.slot !== d.origSlot) commitDrop(d)
    requestAnimationFrame(() => el.classList.remove('rn-tabstrip--settling'))
  }

  function commitDrop(d: Drag): void {
    const s = snap as WindowSnapshot
    const tab = tabOf(d.id)
    if (!tab) return
    const left = d.units[d.slot - 1]?.item
    const right = d.units[d.slot]?.item
    const rest = s.tabs.filter((t) => t.id !== d.id)
    const indexOfTab = (id: number): number => rest.findIndex((t) => t.id === id)
    const firstMember = (gid: string): number => rest.findIndex((t) => t.groupId === gid)
    const lastMember = (gid: string): number => {
      for (let i = rest.length - 1; i >= 0; i--) if (rest[i]?.groupId === gid) return i
      return -1
    }

    // index in the order without the dragged tab (tab-manager splices it out first, then clamps to its zone)
    let index: number
    if (right) index = right.kind === 'tab' ? indexOfTab(right.tab.id) : firstMember(right.group.id)
    else if (left) index = left.kind === 'tab' ? indexOfTab(left.tab.id) + 1 : lastMember(left.group.id) + 1
    else index = d.pinned ? 0 : rest.length
    if (index < 0) index = rest.length

    // group membership from the neighbours: right after an open chip or between two members = join that group;
    // at a group's edge it stays in its own group; anywhere else it leaves.
    let joinGroup: string | null = null
    if (!d.pinned) {
      const lg = left?.kind === 'tab' ? left.group : left?.kind === 'chip' && !left.group.collapsed ? left.group : null
      const rg = right?.kind === 'tab' ? right.group : null
      if (left?.kind === 'chip' && !left.group.collapsed) joinGroup = left.group.id
      else if (lg && rg && lg.id === rg.id) joinGroup = lg.id
      else if (tab.groupId && (lg?.id === tab.groupId || rg?.id === tab.groupId)) joinGroup = tab.groupId
      // dropping right after a collapsed group's chip puts it after the whole group
      if (left?.kind === 'chip' && left.group.collapsed) index = lastMember(left.group.id) + 1
    }

    // optimistic local order so the strip doesn't flash the old order before the next snapshot
    const moved: TabState = { ...tab, groupId: d.pinned ? tab.groupId : joinGroup }
    const next = [...rest]
    next.splice(Math.min(Math.max(index, 0), next.length), 0, moved)
    snap = { ...s, tabs: next }
    render()

    const calls: Array<() => Promise<unknown>> = []
    if (!d.pinned && joinGroup !== tab.groupId) {
      calls.push(() => (joinGroup ? api.groups.addTab({ groupId: joinGroup, tabId: d.id }) : api.groups.removeTab({ tabId: d.id })))
    }
    calls.push(() => api.tabs.move({ tabId: d.id, index }))
    void calls.reduce<Promise<unknown>>((p, c) => p.then(c, c), Promise.resolve()).catch(() => undefined)
  }

  list.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true)
  })
  list.addEventListener('pointercancel', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false)
  })
  list.addEventListener('lostpointercapture', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true)
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && drag?.started) {
      e.preventDefault()
      endDrag(false)
    }
  }
  window.addEventListener('keydown', onKey, true)

  // ---- link / text drops from pages and other apps (Q9) ----
  // Over the middle half of a tab: load it there (the tab is outlined). Elsewhere: a new tab, inserted where the
  // drop indicator shows (between tabs, or at the end over empty strip space).
  type DropAt = { kind: 'tab'; tabId: number; el: HTMLElement } | { kind: 'insert'; index: number }
  let dropTabEl: HTMLElement | null = null
  const acceptsDrop = (e: DragEvent): boolean => {
    const types = Array.from(e.dataTransfer?.types ?? [])
    return !drag && !types.includes('Files') && (types.includes('text/uri-list') || types.includes('text/plain'))
  }
  function dropAt(e: DragEvent): DropAt {
    const s = snap
    const n = itemEl(e.target)
    if (s && n?.dataset.tabId) {
      const id = Number(n.dataset.tabId)
      const r = n.getBoundingClientRect()
      const t = (e.clientX - r.left) / Math.max(1, r.width)
      const i = s.tabs.findIndex((x) => x.id === id)
      if (t >= 0.25 && t <= 0.75) return { kind: 'tab', tabId: id, el: n }
      return { kind: 'insert', index: t < 0.25 ? i : i + 1 }
    }
    return { kind: 'insert', index: s ? s.tabs.length : 0 }
  }
  function showDrop(at: DropAt | null): void {
    const target = at?.kind === 'tab' ? at.el : null
    if (dropTabEl !== target) {
      dropTabEl?.classList.remove('rn-tab--drop-target')
      target?.classList.add('rn-tab--drop-target')
      dropTabEl = target
    }
    el.classList.toggle('rn-tabstrip--drop', !!at)
    if (!at || at.kind === 'tab' || !snap) {
      if (!drag) drop.hidden = true
      return
    }
    // indicator at the leading edge of the tab now at `index`, else after the last visible tab
    const tabAt = snap.tabs[at.index]
    const node = tabAt ? keyed.get(`t${tabAt.id}`) : undefined
    const vis = focusables()
    const lastEl = vis[vis.length - 1]
    const x = node && !node.hidden ? node.offsetLeft : lastEl ? lastEl.offsetLeft + lastEl.offsetWidth : 0
    drop.style.transform = `translateX(${Math.round(x - 1)}px)`
    drop.hidden = false
  }
  el.addEventListener('dragover', (e) => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    showDrop(dropAt(e))
  })
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
    showDrop(null)
  })
  el.addEventListener('drop', (e) => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    const at = dropAt(e)
    showDrop(null)
    const dt = e.dataTransfer
    const payload = dt ? dropPayload(dt.getData('text/uri-list'), dt.getData('text/plain')) : null
    if (!payload) return
    if (at.kind === 'tab') {
      activate(at.tabId)
      ignore(api.tabs.navigate({ input: payload.kind === 'url' ? payload.url : payload.text, tabId: at.tabId, disposition: 'current' }))
      return
    }
    if (payload.kind === 'search') {
      ignore(api.tabs.navigate({ input: payload.text, disposition: 'new-tab' }))
      return
    }
    const want = at.index
    void api.tabs.create({ url: payload.url }).then((res) => {
      if (res.ok && snap && want < snap.tabs.length) ignore(api.tabs.move({ tabId: res.data.tabId, index: want }))
    }, () => undefined)
  })

  const off = api.on('state', (s) => update(s))

  function update(s: WindowSnapshot): void {
    snap = s
    if (drag?.started) return // finish the gesture against the layout it started with; next snapshot renders
    render()
  }

  return {
    update,
    focus() {
      const stop = focusables().find((n) => n.tabIndex === 0)
      if (stop) focusItem(stop)
    },
    destroy() {
      off()
      ro.disconnect()
      window.removeEventListener('keydown', onKey, true)
      el.replaceChildren()
    }
  }
}
