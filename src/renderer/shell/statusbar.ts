// Status bar (DESIGN 3.4, 2.1-2.3; SPEC AC4, AC27).
// Panes: [connection lamp] [text] [progress] [zoom] [profile (2001)]. Which panes show, and in what order, is
// skin CSS + shell.css; this module always renders all of them.
//
// Text comes from main as `status` events for EVERY tab (T12), so we keep the latest per tab and show only the
// active one. A hovered link URL replaces the phase text while present. The visible text is aria-live="off"
// (hover URLs would be noise); a separate role=status region announces only events flagged `announce`
// (user-started loads finishing, and errors).
import { displayUrl } from '@shared/url-safety'
import { SKIN_TRAITS } from '@shared/skins'
import { h, icon } from '../common/dom'
import type { ShellBridge } from '../common/api'
import type { SecurityState, SkinId, StatusEvent, TabState, WindowSnapshot } from '@shared/types'
import { call, profileColor } from './toolbar'

const LAMP: Partial<Record<SecurityState, { icon: string; label: string }>> = {
  secure: { icon: 'lock', label: 'Secure connection' },
  insecure: { icon: 'not-secure', label: 'Not secure' },
  'cert-warning': { icon: 'warning', label: 'Not secure: certificate problem' }
}

/** Phase -> how full the meter is. There is no byte-level progress for page loads, so the meter shows phases. */
function phaseOf(text: string): string {
  if (text.startsWith('Contacting host')) return 'contacting'
  if (text.startsWith('Waiting for reply')) return 'waiting'
  if (text.startsWith('Transferring data')) return 'transferring'
  return 'started'
}

export interface StatusBar {
  readonly el: HTMLElement
  /** Pane order per skin: 1997 lamp | text | ..., 2001 text | lamp | ... (DESIGN 2.2, 2.3). */
  render(skin: SkinId): void
  update(snap: WindowSnapshot, active: TabState | undefined): void
  status(ev: StatusEvent): void
}

export function createStatusBar(api: ShellBridge): StatusBar {
  const lampIcon = icon('page')
  const lamp = h('div', { class: 'rn-statusbar__pane rn-statusbar__security', attrs: { role: 'img' } }, lampIcon)
  const text = h('div', { class: 'rn-statusbar__pane rn-statusbar__text', attrs: { 'aria-live': 'off' }, data: { error: 'false' } })
  const fill = h('span', { class: 'rn-progress__fill' })
  const progress = h(
    'div',
    { class: 'rn-statusbar__pane rn-statusbar__progress', attrs: { hidden: true, 'aria-hidden': 'true' }, data: { phase: 'started' } },
    h('span', { class: 'rn-progress' }, fill)
  )
  const zoomBtn = h('button', { class: 'rn-statusbar__zoom', attrs: { type: 'button' } })
  const zoom = h('div', { class: 'rn-statusbar__pane rn-statusbar__zoompane', attrs: { hidden: true } }, zoomBtn)
  const profileName = h('span')
  const profile = h('div', { class: 'rn-statusbar__pane rn-statusbar__profile' }, profileName)
  const announcer = h('div', { class: 'rn-sr-only', attrs: { role: 'status', 'aria-live': 'polite' } })
  const el = h('footer', { class: 'rn-statusbar', attrs: { 'aria-label': 'Status' } }, lamp, text, progress, zoom, profile, announcer)

  const byTab = new Map<number, StatusEvent>()
  let activeId: number | null = null
  let loading = false

  zoomBtn.addEventListener('click', () => void call(api.commands.run({ id: 'zoom.reset' }), 'commands.run zoom.reset'))

  function paint(): void {
    const ev = activeId === null ? undefined : byTab.get(activeId)
    // A hovered link shows its real host: userinfo ("google.com@evil.example", "user:pass@") is stripped (Q6).
    const hover = ev?.hoverUrl ? displayUrl(ev.hoverUrl) : null
    const shown = hover ?? ev?.text ?? ''
    if (text.textContent !== shown) text.textContent = shown
    text.title = shown
    const isError = !hover && !!ev?.error
    text.dataset.error = isError ? 'true' : 'false'
    text.classList.toggle('rn-statusbar__text--error', isError)
    progress.hidden = !loading
    progress.dataset.phase = loading ? phaseOf(ev?.text ?? '') : 'started'
  }

  return {
    el,
    render(skin) {
      if (SKIN_TRAITS[skin].statusTextFirst) el.replaceChildren(text, lamp, progress, zoom, profile, announcer)
      else el.replaceChildren(lamp, text, progress, zoom, profile, announcer)
    },
    status(ev) {
      byTab.set(ev.tabId, ev)
      if (ev.tabId !== activeId) return
      paint()
      if (ev.announce && ev.text) {
        // Clear first so the same string twice in a row ("Document: Done.") is announced again.
        announcer.textContent = ''
        requestAnimationFrame(() => {
          announcer.textContent = ev.text
        })
      }
    },
    update(snap, tab) {
      // Forget closed tabs.
      if (byTab.size > snap.tabs.length) {
        const ids = new Set(snap.tabs.map((t) => t.id))
        for (const k of byTab.keys()) if (!ids.has(k)) byTab.delete(k)
      }
      activeId = tab?.id ?? null
      loading = !!tab?.loading

      const sec = tab ? LAMP[tab.security] : undefined
      lamp.hidden = !sec
      if (sec) {
        if (lampIcon.dataset.icon !== sec.icon) lampIcon.dataset.icon = sec.icon
        lamp.setAttribute('aria-label', sec.label)
        lamp.title = sec.label
      }

      const pct = Math.round(tab?.zoomPercent ?? 100)
      zoom.hidden = pct === 100
      zoomBtn.textContent = `${pct}%`
      zoomBtn.setAttribute('aria-label', `Zoom ${pct}%, reset to 100%`)
      zoomBtn.title = 'Reset zoom to 100%'

      profile.dataset.color = profileColor(snap.profileId)
      profileName.textContent = snap.incognito ? `${snap.profileName} (Incognito)` : snap.profileName
      profile.title = `Profile: ${snap.profileName}`
      paint()
    }
  }
}
