// Permission prompt (AC33, DESIGN 3.8). Anchored under the address row with an arrow, so it visibly comes from the
// browser, not the page. Host in bold (never the URL path), "Remember for this site" unchecked by default,
// Block and Allow with equal weight, Close = Dismiss, Esc = Dismiss, focus starts on Block.
// The same request can be re-sent with a new position/total when the queue changes: only the counter updates.
import type { OverlayEvent, PermissionRequest } from '@shared/types'
import { h, icon } from '../common/dom'
import { clampInto, nextId, place, trapFocus, type Mounted, type OverlayEnv } from './ui'

type PermissionEvent = Extract<OverlayEvent, { kind: 'permission' }>
type Kind = PermissionRequest['kinds'][number]

const PHRASE: Record<Kind, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images you copy'
}
const ICON: Record<Kind, string> = {
  camera: 'camera',
  microphone: 'mic',
  geolocation: 'location',
  notifications: 'bell',
  'clipboard-read': 'clipboard'
}
/** Clicks that land within this window after the prompt appears are ignored (stops click-through tricks). */
const INPUT_GUARD_MS = 400

export function requestPhrase(kinds: readonly Kind[]): string {
  if (kinds.includes('camera') && kinds.includes('microphone')) {
    const rest = kinds.filter((k) => k !== 'camera' && k !== 'microphone').map((k) => PHRASE[k])
    return ['use your camera and microphone', ...rest].join(' and ')
  }
  return kinds.map((k) => PHRASE[k]).join(' and ')
}

export interface PromptHandle extends Mounted {
  /** Same request id re-sent: update the counter and keep focus and the checkbox as they are. */
  update(ev: PermissionEvent): boolean
}

export function mountPermissionPrompt(ev: PermissionEvent, env: OverlayEnv): PromptHandle {
  const { api } = env
  const req = ev.request
  const headId = nextId('rn-prompt-head')
  const shownAt = performance.now()
  let answered = false

  const count = h('span', { class: 'rn-prompt__count' })
  const setCount = (r: PermissionRequest): void => {
    count.textContent = r.total > 1 ? `${r.position} of ${r.total}` : ''
    count.hidden = r.total <= 1
  }
  setCount(req)

  const remember = h('input', { attrs: { type: 'checkbox' } })
  const respond = (decision: 'allow' | 'block' | 'dismiss'): void => {
    if (answered) return
    answered = true
    root.classList.add('rn-prompt--leaving')
    void api.permissions.respond({ requestId: req.id, decision, remember: decision !== 'dismiss' && remember.checked }).then((r) => {
      if (!r.ok) {
        answered = false
        root.classList.remove('rn-prompt--leaving')
      }
    })
  }
  const guarded = (decision: 'allow' | 'block' | 'dismiss') => (e: Event) => {
    // A pointer click right after the prompt appeared was aimed at the page, not at us.
    if (e instanceof MouseEvent && e.detail > 0 && performance.now() - shownAt < INPUT_GUARD_MS) return
    respond(decision)
  }

  const block = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Block', on: { click: guarded('block') } })
  const allow = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Allow', on: { click: guarded('allow') } })
  const close = h(
    'button',
    { class: 'rn-btn rn-btn--icon rn-prompt__close', attrs: { type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss (Esc)' }, on: { click: guarded('dismiss') } },
    icon('close')
  )
  const kindIcon = icon(ICON[req.kinds[0]!])
  kindIcon.dataset.size = '24'

  const root = h(
    'div',
    { class: 'rn-dialog rn-prompt', attrs: { role: 'alertdialog', 'aria-labelledby': headId } },
    h('span', { class: 'rn-prompt__arrow', attrs: { 'aria-hidden': 'true' } }),
    h(
      'div',
      { class: 'rn-prompt__head' },
      kindIcon,
      h('p', { attrs: { id: headId } }, h('b', { text: req.host }), ` wants to ${requestPhrase(req.kinds)}`),
      count,
      close
    ),
    h('div', { class: 'rn-dialog__body' }, h('label', { class: 'rn-check' }, remember, h('span', { text: 'Remember for this site' }))),
    h('div', { class: 'rn-dialog__actions rn-prompt__actions' }, block, allow)
  )
  trapFocus(root)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      respond('dismiss')
    }
  })

  // Top edge at the anchor (main puts it 4px into the address row); the arrow pokes up from there.
  const { left, top } = clampInto(ev.anchor.x, ev.anchor.y, 360, 160)
  place(root, left, top)
  queueMicrotask(() => block.focus())

  return {
    root,
    // Not modal for the page; a stray click outside must not count as an answer.
    onOutside: () => undefined,
    update(next) {
      if (next.request.id !== req.id) return false
      setCount(next.request)
      return true
    }
  }
}
