// Toolbar (DESIGN 2.1-2.3, 3.1, 2.6): navigation buttons, page actions, profile button, menu, throbber.
// The button set and classes differ per skin (1994 text-first, 1997 big icon+label, 2001 round back/forward plus
// flat icon buttons), so the row is rebuilt whenever html[data-skin] changes; button state is re-applied from the
// last snapshot right after, so a live skin switch never shows stale enabled/disabled states.
import { h, icon } from '../common/dom'
import type { IpcResult, ShellBridge } from '../common/api'
import { commandShortcutLabel } from '@shared/commands'
import type { CommandId, Platform, SkinId, TabState, WindowSnapshot } from '@shared/types'
import { GROUP_COLORS, type GroupColor } from '@shared/types'
import { createThrobber, type Throbber } from './throbber'

/** Awaits an IPC call; failures are logged, never thrown (a missing handler must not break the shell). */
export async function call<T>(p: Promise<IpcResult<T>> | undefined, what: string): Promise<T | undefined> {
  if (!p) return undefined
  try {
    const res = await p
    if (res.ok) return res.data
    console.warn(`[shell] ${what} failed: ${res.code} ${res.message}`)
  } catch (err) {
    console.warn(`[shell] ${what} threw`, err)
  }
  return undefined
}

/** Profile colour is derived in the renderer (DESIGN 0.2): a stable hash of the id onto the 9 group colours. */
export function profileColor(profileId: string): GroupColor {
  let hash = 5381
  for (let i = 0; i < profileId.length; i++) hash = ((hash << 5) + hash + profileId.charCodeAt(i)) >>> 0
  return GROUP_COLORS[hash % GROUP_COLORS.length] ?? 'grey'
}

/** "Back (⌘[)" style tooltip: the label plus the primary shortcut on this platform, if any. */
export function withShortcut(label: string, id: CommandId | null, platform: Platform): string {
  const keys = id ? commandShortcutLabel(id, platform) : ''
  return keys ? `${label} (${keys})` : label
}

type Action = 'back' | 'forward' | 'reload' | 'home' | 'stop' | 'find' | 'downloads'

interface ActionDef {
  label: string
  /** Short visible label where the skin's big buttons need one (1997 "Saves"). */
  short?: string
  icon: string
  command: CommandId
}

const ACTIONS: Record<Action, ActionDef> = {
  back: { label: 'Back', icon: 'back', command: 'nav.back' },
  forward: { label: 'Forward', icon: 'forward', command: 'nav.forward' },
  reload: { label: 'Reload', icon: 'reload', command: 'nav.reload' },
  home: { label: 'Home', icon: 'home', command: 'nav.home' },
  stop: { label: 'Stop', icon: 'stop', command: 'nav.stop' },
  find: { label: 'Find', icon: 'find', command: 'find.open' },
  downloads: { label: 'Downloads', short: 'Saves', icon: 'download', command: 'page.downloads' }
}

/** Order per skin (DESIGN 2.1-2.3). 'sep' = etched separator. */
const LAYOUT: Record<SkinId, ReadonlyArray<Action | 'sep'>> = {
  y1994: ['back', 'forward', 'reload', 'home', 'stop', 'find'],
  y1997: ['back', 'forward', 'reload', 'home', 'find', 'downloads', 'stop'],
  y2001: ['back', 'forward', 'sep', 'reload', 'home', 'find', 'downloads', 'stop', 'sep']
}

export interface ToolbarDeps {
  api: ShellBridge
  platform: Platform
  /** Toggle the find bar (handled in the shell, no round trip). */
  toggleFind(): void
}

export interface Toolbar {
  readonly el: HTMLElement
  render(skin: SkinId): void
  update(snap: WindowSnapshot, active: TabState | undefined): void
  /** Find button shows pressed (sunken) while the find bar is open. */
  setFindOpen(open: boolean): void
}

export function createToolbar(deps: ToolbarDeps): Toolbar {
  const { api, platform } = deps
  const el = h('div', { class: 'rn-toolbar', attrs: { role: 'group', 'aria-label': 'Navigation' } })
  const throbber: Throbber = createThrobber()
  let buttons = new Map<Action, HTMLButtonElement>()
  let profileBtn: HTMLButtonElement | null = null
  let lastSnap: WindowSnapshot | null = null
  let lastActive: TabState | undefined
  let findOpen = false

  const run = (id: CommandId): Promise<unknown> => call(api.commands?.run({ id }), `commands.run ${id}`)

  async function perform(action: Action, ev: MouseEvent): Promise<void> {
    const tabId = lastActive?.id
    switch (action) {
      case 'back':
        return void (await call(api.tabs.back({ tabId }), 'tabs.back'))
      case 'forward':
        return void (await call(api.tabs.forward({ tabId }), 'tabs.forward'))
      case 'reload':
        // Shift-click = reload ignoring the cache (era and modern convention).
        return void (await call(api.tabs.reload({ tabId, ignoreCache: ev.shiftKey }), 'tabs.reload'))
      case 'home':
        return void (await call(api.tabs.home({ tabId }), 'tabs.home'))
      case 'stop':
        return void (await call(api.tabs.stop({ tabId }), 'tabs.stop'))
      case 'find':
        return deps.toggleFind()
      case 'downloads': {
        const res = await api.commands?.run({ id: 'page.downloads' }).catch(() => undefined)
        if (!res?.ok) await call(api.tabs.create({ url: 'retronet://downloads/' }), 'tabs.create downloads')
        return
      }
    }
  }

  function actionButton(action: Action, skin: SkinId, index: number): HTMLButtonElement {
    const def = ACTIONS[action]
    const tip = withShortcut(def.label, def.command, platform)
    let btn: HTMLButtonElement
    if (skin === 'y2001' && (action === 'back' || action === 'forward')) {
      // Round glossy buttons; Back carries a visible label, Forward is icon-only (DESIGN 2.3).
      btn = h(
        'button',
        { class: 'rn-btn rn-btn--round', attrs: { type: 'button', title: tip, 'aria-label': action === 'forward' ? def.label : null } },
        icon(def.icon),
        action === 'back' ? h('span', { class: 'rn-btn__label', text: def.label }) : null
      )
    } else if (skin === 'y2001') {
      btn = h('button', { class: 'rn-btn rn-btn--icon', attrs: { type: 'button', title: tip, 'aria-label': def.label } }, icon(def.icon))
      btn.lastElementChild?.setAttribute('data-size', '24')
    } else {
      const visible = skin === 'y1997' && def.short ? def.short : def.label
      btn = h(
        'button',
        {
          class: 'rn-btn rn-btn--labeled',
          // The visible label must be part of the accessible name (WCAG 2.5.3): "Saves" button reads "Saves, Downloads".
          attrs: { type: 'button', title: tip, 'aria-label': visible !== def.label ? `${visible} (${def.label})` : null }
        },
        icon(def.icon),
        h('span', { class: 'rn-btn__label', text: visible })
      )
    }
    btn.dataset.action = action
    if (action === 'find') {
      btn.setAttribute('aria-pressed', findOpen ? 'true' : 'false')
      btn.setAttribute('aria-controls', 'rn-findbar')
    }
    btn.dataset.order = String(index)
    btn.addEventListener('click', (ev) => void perform(action, ev))
    return btn
  }

  function render(skin: SkinId): void {
    const focusedAction = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.rn-toolbar [data-action]')?.dataset.action
    buttons = new Map()
    const kids: HTMLElement[] = []
    LAYOUT[skin].forEach((item, i) => {
      if (item === 'sep') {
        kids.push(h('span', { class: 'rn-toolbar__sep', attrs: { 'aria-hidden': 'true' } }))
        return
      }
      const b = actionButton(item, skin, i)
      buttons.set(item, b)
      kids.push(b)
    })
    profileBtn = h('button', { class: 'rn-btn rn-btn--icon rn-profile-btn', attrs: { type: 'button', 'aria-haspopup': 'menu' } })
    profileBtn.addEventListener('click', () => {
      const r = profileBtn?.getBoundingClientRect()
      if (!r) return
      void call(api.profiles?.menu({ x: Math.round(r.left), y: Math.round(r.bottom) }), 'profiles.menu')
    })
    const menuTip = withShortcut('Command palette', 'palette.open', platform)
    const menuBtn = h('button', { class: 'rn-btn rn-btn--icon', attrs: { type: 'button', title: menuTip, 'aria-label': 'Command palette' } }, icon('menu'))
    menuBtn.addEventListener('click', () => void run('palette.open'))
    el.replaceChildren(...kids, h('div', { class: 'rn-toolbar__spacer' }), profileBtn, menuBtn, throbber.el)
    if (lastSnap) update(lastSnap, lastActive)
    if (focusedAction) buttons.get(focusedAction as Action)?.focus()
  }

  function update(snap: WindowSnapshot, active: TabState | undefined): void {
    lastSnap = snap
    lastActive = active
    const loading = active?.loading ?? false
    const set = (a: Action, enabled: boolean): void => {
      const b = buttons.get(a)
      if (!b || b.disabled !== enabled) return
      // Disabling the focused button (Stop when a load ends, Back at the start of history) would drop focus to
      // <body>; hand it to Reload, the control that is always available, instead.
      const hadFocus = !enabled && document.activeElement === b
      b.disabled = !enabled
      if (hadFocus) {
        const fallback = buttons.get('reload')
        if (fallback && fallback !== b && !fallback.disabled) fallback.focus()
      }
    }
    set('back', !!active?.canGoBack)
    set('forward', !!active?.canGoForward)
    set('reload', !!active)
    set('home', !!active)
    set('stop', loading)
    set('find', !!active)
    throbber.set(loading)

    if (profileBtn) {
      const color = profileColor(snap.profileId)
      profileBtn.dataset.color = color
      const name = snap.profileName || 'Profile'
      if (snap.incognito) {
        if (profileBtn.dataset.kind !== 'incognito') profileBtn.replaceChildren(icon('incognito'))
        profileBtn.dataset.kind = 'incognito'
        profileBtn.setAttribute('aria-label', `Incognito, profile ${name}. Switch profile`)
        profileBtn.title = `Incognito (${name})`
      } else {
        const letter = (name.trim()[0] ?? 'P').toUpperCase()
        if (profileBtn.dataset.kind !== 'letter' || profileBtn.textContent !== letter) profileBtn.replaceChildren(letter)
        profileBtn.dataset.kind = 'letter'
        profileBtn.setAttribute('aria-label', `Profile: ${name}. Switch profile`)
        profileBtn.title = `Profile: ${name}`
      }
    }
  }

  function setFindOpen(open: boolean): void {
    findOpen = open
    buttons.get('find')?.setAttribute('aria-pressed', open ? 'true' : 'false')
  }

  return { el, render, update, setFindOpen }
}
