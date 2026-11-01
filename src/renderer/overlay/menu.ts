// Themed menus (PLAN-FINAL 1.2, DESIGN-MENUS §1-§5). Draws the MenuSpec main sends in a full-window transparent
// layer (D-A1): the root menu box at its anchor and submenus as sibling boxes, built lazily the first time they open
// (5000-node bookmark menus stay cheap). Answers with `menu.pick {menuId, itemId, mods, button}` or `menu.dismiss`;
// main hides the overlay either way. A press on the layer outside every box is swallowed and dismisses. Nothing
// animates (§0). Labels go in via textContent only.
import { truncateLabel, type MenuItemNode, type MenuItemSpec, type MenuSpec } from '@shared/menu-model'
import type { OverlayEvent } from '@shared/types'
import { h } from '../common/dom'
import { ariaKeyshortcuts, firstEnabled, menuKey, resolveAccel, TypeAhead, type KeyItem } from './menu-keys'
import { belowGap, placeRoot, placeSubmenu, submenuFrameTop, type Box, type Placed, type Viewport } from './menu-position'
import { shortcutChips, type Mounted, type OverlayEnv } from './ui'

type MenuEvent = Extract<OverlayEvent, { kind: 'menu' }>

/** Hover time on a parent row before its submenu opens (§4). */
export const SUBMENU_OPEN_MS = 200
/** Grace period before an open submenu closes when the pointer moves to a sibling row (§4). */
export const SUBMENU_GRACE_MS = 300

export interface MenuHandle extends Mounted {
  /** Measures and places the root box. Call once the root is in the document. */
  place(): void
}

interface Level {
  depth: number
  el: HTMLElement
  specs: MenuItemSpec[]
  /** One per spec; null for separators. */
  rows: Array<HTMLElement | null>
  keyItems: KeyItem[]
  active: number
  parent: Level | null
  /** Index of the parent row in `parent`. */
  parentIndex: number
  child: Level | null
}

interface Mods {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

const modsOf = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): Mods => ({
  meta: e.metaKey,
  ctrl: e.ctrlKey,
  shift: e.shiftKey,
  alt: e.altKey
})

let mountSeq = 0

function viewport(): Viewport {
  const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } })
    .windowControlsOverlay
  let caption: Box | null = null
  if (wco?.visible) {
    const r = wco.getTitlebarAreaRect()
    // The titlebar area is the space *left* of the caption buttons; the buttons sit to its right.
    caption = { left: r.right, top: 0, right: window.innerWidth, bottom: r.bottom }
  }
  return { width: window.innerWidth, height: window.innerHeight, caption }
}

function box(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

export function mountMenu(ev: MenuEvent, env: OverlayEnv): MenuHandle {
  const spec: MenuSpec = ev.menu
  const { api } = env
  const platform = spec.platform
  const seq = ++mountSeq
  let menuSeq = 0
  const nextMenuId = (): string => `rn-menu-${seq}-${menuSeq++}`

  const layer = h('div', { class: 'rn-menu-layer', data: { kind: spec.kind } })
  const typeahead = new TypeAhead()
  const built = new Map<HTMLElement, Level>()
  let done = false
  let armed = false
  let openTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let graceLevel: Level | null = null
  let altAlone = false

  // ---- building ----

  function buildRow(it: MenuItemNode, rowId: string, subId: string | null): HTMLElement {
    const role = it.check === 'check' ? 'menuitemcheckbox' : it.check === 'radio' ? 'menuitemradio' : 'menuitem'
    const accel = it.accel ? resolveAccel(it.accel, platform) : undefined
    const chips = shortcutChips(accel, platform).el
    if (chips) chips.removeAttribute('aria-hidden') // the accel column itself is aria-hidden
    const shortcut = ariaKeyshortcuts(accel, platform)
    return h(
      'div',
      {
        class: ['rn-menu__item', /^bm:(empty|deep):/.test(it.id) ? 'rn-menu__item--placeholder' : null],
        attrs: {
          role,
          id: rowId,
          tabindex: '-1',
          'aria-checked': it.check ? String(!!it.checked) : null,
          'aria-disabled': it.enabled ? null : 'true',
          'aria-haspopup': subId ? 'menu' : null,
          'aria-expanded': subId ? 'false' : null,
          'aria-controls': subId,
          'aria-keyshortcuts': shortcut || null
        },
        data: { itemId: it.id }
      },
      h('span', { class: 'rn-menu__check', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'rn-menu__label', text: truncateLabel(it.label) }),
      h('span', { class: 'rn-menu__accel', attrs: { 'aria-hidden': 'true' } }, chips),
      h('span', { class: 'rn-menu__arrow', attrs: { 'aria-hidden': 'true' } })
    )
  }

  function buildLevel(specs: MenuItemSpec[], id: string, parent: Level | null, parentIndex: number): Level {
    const depth = parent ? parent.depth + 1 : 0
    const el = h('div', {
      class: ['rn-menu', parent ? 'rn-menu--sub' : null],
      attrs: {
        role: 'menu',
        id,
        tabindex: '-1',
        'aria-label': parent ? null : spec.label,
        'aria-labelledby': parent ? (parent.rows[parentIndex]?.id ?? null) : null
      },
      data: { level: depth }
    })
    if (specs.some((s) => s.kind !== 'separator' && s.check)) el.dataset.hasChecks = ''
    const level: Level = { depth, el, specs, rows: [], keyItems: [], active: -1, parent, parentIndex, child: null }
    specs.forEach((it, i) => {
      if (it.kind === 'separator') {
        level.rows.push(null)
        level.keyItems.push({ label: '', enabled: false, separator: true })
        el.append(h('div', { class: 'rn-menu__separator', attrs: { role: 'separator' } }))
        return
      }
      const subId = it.submenu ? nextMenuId() : null
      const row = buildRow(it, `${id.replace('rn-menu-', 'rn-mi-')}-${i}`, subId)
      level.rows.push(row)
      level.keyItems.push({ label: it.label, enabled: it.enabled, hasSubmenu: !!it.submenu })
      el.append(row)
    })
    built.set(el, level)
    return level
  }

  /** Writes a placement to a box and re-measures once if the scrollbar padding changed its width. */
  function applyPlacement(level: Level, compute: () => Placed): void {
    const el = level.el
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.maxHeight = ''
    let p = compute()
    if (p.scrolls !== el.classList.contains('rn-menu--scrolls')) {
      el.classList.toggle('rn-menu--scrolls', p.scrolls)
      p = compute()
    }
    el.style.left = `${Math.round(p.left)}px`
    el.style.top = `${Math.round(p.top)}px`
    el.style.maxHeight = `${Math.floor(p.maxHeight)}px`
    // Truncated labels (or a spec title) get a tooltip; the accessible name stays the full label (§3).
    level.rows.forEach((row, i) => {
      const it = level.specs[i]
      if (!row || it?.kind !== 'item') return
      const label = row.querySelector<HTMLElement>('.rn-menu__label')
      const truncated = !!label && label.scrollWidth > label.clientWidth
      if (it.title !== undefined || truncated) row.title = it.title ?? it.label
      else row.removeAttribute('title')
    })
  }

  function naturalSize(el: HTMLElement): { width: number; height: number } {
    return { width: el.offsetWidth, height: el.scrollHeight + (el.offsetHeight - el.clientHeight) }
  }

  const root = buildLevel(spec.items, nextMenuId(), null, -1)
  layer.append(root.el)

  // ---- state ----

  function setActive(level: Level, index: number, opts: { focus: boolean; scroll: boolean }): void {
    if (level.active !== index) {
      level.rows[level.active]?.classList.remove('rn-menu__item--active')
      level.active = index
    }
    const row = level.rows[index]
    if (!row) return
    row.classList.add('rn-menu__item--active')
    if (opts.focus) row.focus({ preventScroll: true })
    if (opts.scroll) row.scrollIntoView({ block: 'nearest' })
  }

  function clearActive(level: Level): void {
    level.rows[level.active]?.classList.remove('rn-menu__item--active')
    level.active = -1
  }

  function closeChild(level: Level): void {
    const child = level.child
    if (!child) return
    closeChild(child)
    clearActive(child)
    child.el.hidden = true
    level.child = null
    level.rows[child.parentIndex]?.setAttribute('aria-expanded', 'false')
    if (graceLevel === level) cancelGrace()
  }

  function openChild(level: Level, index: number, focusFirst: boolean): void {
    const it = level.specs[index]
    const row = level.rows[index]
    if (it?.kind !== 'item' || !it.submenu || !row || !it.enabled) return
    if (level.child && level.child.parentIndex !== index) closeChild(level)
    let child = level.child
    if (!child) {
      const subId = row.getAttribute('aria-controls') ?? nextMenuId()
      const existing = document.getElementById(subId)
      child = existing && built.get(existing) ? built.get(existing)! : buildLevel(it.submenu, subId, level, index)
      if (!child.el.isConnected) layer.append(child.el)
      child.el.hidden = false
      level.child = child
      row.setAttribute('aria-expanded', 'true')
      const sub = child
      const frameTop = submenuFrameTop(document.documentElement.dataset.skin)
      applyPlacement(sub, () => {
        const pad = parseFloat(getComputedStyle(sub.el).paddingTop) || 0
        return placeSubmenu(box(level.el), box(row), naturalSize(sub.el), viewport(), pad, frameTop)
      })
    }
    setActive(level, index, { focus: !focusFirst, scroll: false })
    if (focusFirst) {
      const first = firstEnabled(child.keyItems)
      if (first >= 0) setActive(child, first, { focus: true, scroll: true })
      else child.el.focus({ preventScroll: true })
      typeahead.reset()
    }
  }

  function levelOf(node: EventTarget | null): Level | null {
    const el = node instanceof Element ? node.closest('.rn-menu') : null
    return el instanceof HTMLElement ? (built.get(el) ?? null) : null
  }

  function rowIndex(level: Level, node: EventTarget | null): number {
    const row = node instanceof Element ? node.closest('.rn-menu__item') : null
    return row ? level.rows.indexOf(row as HTMLElement) : -1
  }

  function cancelOpen(): void {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
  }

  function cancelGrace(): void {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = null
    graceLevel = null
  }

  // ---- results ----

  function finish(): void {
    done = true
    cancelOpen()
    cancelGrace()
    layer.hidden = true
  }

  function dismiss(): void {
    if (done) return
    finish()
    void api.menu.dismiss({ menuId: spec.menuId })
  }

  function pick(level: Level, index: number, mods: Mods, button: 0 | 1): void {
    if (done) return
    const it = level.specs[index]
    if (it?.kind !== 'item' || !it.enabled) return
    if (it.submenu) {
      if (button === 0) openChild(level, index, false)
      return
    }
    finish()
    api.menu.pick({ menuId: spec.menuId, itemId: it.id, mods, button }).catch(() => void api.menu.dismiss({ menuId: spec.menuId }))
  }

  // ---- keyboard ----

  function onKeyDown(e: KeyboardEvent): void {
    if (done) return
    if (platform === 'win') altAlone = e.key === 'Alt' && !e.repeat ? true : false
    if (e.key === 'F10' && e.shiftKey) return void e.preventDefault()
    if (e.key === 'ContextMenu') return void e.preventDefault()
    const level = levelOf(document.activeElement) ?? deepest()
    const action = menuKey(e, level.keyItems, level.active, level.depth, typeahead)
    if (action.type === 'none') {
      if (e.key === 'Tab' || e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    switch (action.type) {
      case 'move':
        if (level.child && level.child.parentIndex !== action.index) closeChild(level)
        setActive(level, action.index, { focus: true, scroll: true })
        return
      case 'open':
        cancelOpen()
        openChild(level, action.index, true)
        return
      case 'activate':
        pick(level, action.index, modsOf(e), 0)
        return
      case 'close-level': {
        const parent = level.parent
        if (!parent) return
        closeChild(parent)
        setActive(parent, level.parentIndex, { focus: true, scroll: true })
        typeahead.reset()
        return
      }
      case 'dismiss':
        dismiss()
        return
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (platform === 'win' && e.key === 'Alt' && altAlone) {
      altAlone = false
      dismiss()
    }
  }

  function deepest(): Level {
    let l = root
    while (l.child) l = l.child
    return l
  }

  // ---- pointer ----

  function onPointerDown(e: PointerEvent): void {
    if (done) return
    const level = levelOf(e.target)
    if (!level) {
      // Outside every box: swallowed, closes the menu (D-A1).
      e.preventDefault()
      dismiss()
      return
    }
    armed = true
    if (e.button === 1) e.preventDefault() // no autoscroll
    if (e.button === 0) e.preventDefault() // keep focus on the highlighted row
  }

  function onPointerUp(e: PointerEvent): void {
    // Only a press that started inside the menu after it opened can activate (§4: the opening release never picks).
    if (done || !armed || e.button !== 0) return
    armed = false
    const level = levelOf(e.target)
    if (!level) return
    const i = rowIndex(level, e.target)
    if (i < 0) return
    cancelOpen()
    pick(level, i, modsOf(e), 0)
  }

  function onAuxClick(e: MouseEvent): void {
    if (done || e.button !== 1) return
    e.preventDefault()
    const level = levelOf(e.target)
    if (!level) return
    const i = rowIndex(level, e.target)
    const it = level.specs[i]
    if (i < 0 || it?.kind !== 'item' || it.submenu) return
    pick(level, i, modsOf(e), 1)
  }

  // Native menus ignore the pointer until it really moves: opening a menu (or the full-window layer
  // appearing under a resting mouse) makes Chromium fire pointerover without any movement, which must
  // not steal a keyboard-opened menu's first-item highlight (AC63).
  // Only keyboard-opened menus (focusFirst) wait for real movement; pointer-opened ones react at once.
  let pointerMoved = !spec.focusFirst
  let restX: number | undefined
  let restY: number | undefined
  function onPointerMove(e: PointerEvent): void {
    if (done || pointerMoved) return
    if (restX === undefined || restY === undefined) {
      restX = e.clientX
      restY = e.clientY
      return
    }
    if (e.clientX === restX && e.clientY === restY) return
    pointerMoved = true
    onPointerOver(e)
  }

  function onPointerOver(e: PointerEvent): void {
    if (done) return
    if (!pointerMoved) {
      if (restX === undefined) {
        restX = e.clientX
        restY = e.clientY
      }
      return
    }
    const level = levelOf(e.target)
    if (!level) {
      // Empty layer: clear highlights except open submenu parents; submenus stay open.
      cancelOpen()
      for (let l: Level | null = root; l; l = l.child) {
        if (l.active >= 0 && l.child?.parentIndex !== l.active) {
          const hadFocus = l.rows[l.active] === document.activeElement
          clearActive(l)
          if (hadFocus) l.el.focus({ preventScroll: true })
        }
      }
      return
    }
    // Inside a submenu: the pointer reached it, so it stays open and its parent keeps the highlight.
    if (level.parent && level.parent.child === level) {
      if (graceLevel === level.parent) cancelGrace()
      setActive(level.parent, level.parentIndex, { focus: false, scroll: false })
    }
    const i = rowIndex(level, e.target)
    if (i < 0) return // separator or padding
    if (i === level.active && level.rows[i] === document.activeElement) return
    cancelOpen()
    typeahead.reset()
    const ki = level.keyItems[i]!
    if (ki.enabled) setActive(level, i, { focus: true, scroll: false })
    else {
      if (level.active >= 0 && level.child?.parentIndex !== level.active) clearActive(level)
      level.el.focus({ preventScroll: true })
    }
    // A sibling of the open submenu's parent: close it after the grace period unless the pointer gets there first.
    if (level.child && level.child.parentIndex !== i) {
      if (!graceTimer) {
        graceLevel = level
        graceTimer = setTimeout(() => {
          graceTimer = null
          graceLevel = null
          closeChild(level)
          if (level.active >= 0) setActive(level, level.active, { focus: true, scroll: false })
        }, SUBMENU_GRACE_MS)
      }
    } else if (level.child && level.child.parentIndex === i && graceLevel === level) {
      cancelGrace()
    }
    if (ki.enabled && ki.hasSubmenu && level.child?.parentIndex !== i) {
      openTimer = setTimeout(() => {
        openTimer = null
        if (graceLevel === level) cancelGrace()
        openChild(level, i, false)
      }, SUBMENU_OPEN_MS)
    }
  }

  const swallow = (e: Event): void => e.preventDefault()

  layer.addEventListener('pointerdown', onPointerDown)
  layer.addEventListener('pointerup', onPointerUp)
  layer.addEventListener('auxclick', onAuxClick)
  layer.addEventListener('pointerover', onPointerOver)
  layer.addEventListener('pointermove', onPointerMove)
  layer.addEventListener('contextmenu', swallow)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)

  return {
    root: layer,
    onOutside: dismiss,
    place() {
      const gap = belowGap(document.documentElement.dataset.skin)
      applyPlacement(root, () => placeRoot(spec.anchor, spec.placement, naturalSize(root.el), viewport(), gap))
      const first = spec.focusFirst ? firstEnabled(root.keyItems) : -1
      if (first >= 0) setActive(root, first, { focus: true, scroll: true })
      else root.el.focus({ preventScroll: true })
    },
    destroy() {
      cancelOpen()
      cancelGrace()
      done = true
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }
}
