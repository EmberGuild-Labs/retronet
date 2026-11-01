// Fullscreen notice (FIX-SEC overlay kind 'fullscreen-notice' {host}): "<host> is now full screen — Press Esc to
// exit". Anti-spoofing: a page that takes the whole window must not be able to hide that it did. Shown in the
// overlay (above the page, which the page cannot draw over), never takes focus, never takes clicks, fades out by
// itself. Motion: occasional state change, 200ms fade + 8px drop in, 150ms fade out (overlay.css).
import { h } from '../common/dom'
import type { Mounted, OverlayEnv } from './ui'

export interface FullscreenNoticeEvent {
  kind: 'fullscreen-notice'
  host: string
}

const VISIBLE_MS = 4000
const EXIT_MS = 150

export function isFullscreenNotice(ev: { kind: string }): ev is FullscreenNoticeEvent {
  return ev.kind === 'fullscreen-notice' && typeof (ev as { host?: unknown }).host === 'string'
}

export function mountFullscreenNotice(ev: FullscreenNoticeEvent, env: OverlayEnv, stillShown: () => boolean): Mounted {
  const host = ev.host.trim()
  const root = h(
    'div',
    { class: 'rn-fsnotice', attrs: { role: 'status', 'aria-live': 'polite' } },
    h('span', { class: 'rn-fsnotice__text' }, host ? h('b', { text: host }) : 'This page', ' is now full screen'),
    h('span', { class: 'rn-fsnotice__hint' }, 'Press ', h('kbd', { class: 'rn-kbd', text: 'Esc' }), ' to exit')
  )
  const timers: Array<ReturnType<typeof setTimeout>> = []
  timers.push(
    setTimeout(() => {
      root.classList.add('rn-fsnotice--leaving')
      timers.push(setTimeout(() => stillShown() && env.close(), EXIT_MS))
    }, VISIBLE_MS)
  )
  return {
    root,
    onOutside: () => undefined,
    destroy: () => timers.forEach(clearTimeout)
  }
}
