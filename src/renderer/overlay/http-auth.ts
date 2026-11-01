// HTTP sign-in dialog (Q3, styled as DESIGN 3.9 dialogs). Main sends `http-auth` with the origin (or proxy
// host:port) and the server's realm; the realm is shown as plain text in quotes after "The site says:" (or "The
// proxy says:"), so it can't pass for browser text. An empty username is sent as '' (R18; some servers accept it).
// Username + password (type=password), Cancel / Sign in, focus on Username, Esc = Cancel, Enter = Sign in. A
// click outside does nothing (no accidental cancel). The answer goes back with httpAuth.respond; main then hides
// the overlay.
import type { OverlayEvent } from '@shared/types'
import { h } from '../common/dom'
import { nextId, trapFocus, type Mounted, type OverlayEnv } from './ui'

type HttpAuthEvent = Extract<OverlayEvent, { kind: 'http-auth' }>
const FIELD_MAX = 1024

export function mountHttpAuth(ev: HttpAuthEvent, env: OverlayEnv): Mounted {
  const { api } = env
  const titleId = nextId('rn-dialog-title')
  const msgId = nextId('rn-dialog-msg')
  const userId = nextId('rn-auth-user')
  const passId = nextId('rn-auth-pass')
  let answered = false

  const respond = (a: { username?: string; password?: string; cancel?: boolean }): void => {
    if (answered) return
    answered = true
    void api.httpAuth.respond({ id: ev.id, ...a }).then((r) => {
      if (!r.ok) env.close()
    })
  }
  const cancel = (): void => respond({ cancel: true })

  const field = (id: string, label: string, type: 'text' | 'password', autocomplete: string): [HTMLElement, HTMLInputElement] => {
    const input = h('input', {
      class: 'rn-input rn-dialog__input',
      attrs: { id, type, maxlength: FIELD_MAX, autocomplete, spellcheck: 'false', autocapitalize: 'off' }
    })
    return [h('div', { class: 'rn-dialog__field' }, h('label', { attrs: { for: id }, text: label }), input), input]
  }
  const [userRow, user] = field(userId, 'Username', 'text', 'username')
  const [passRow, pass] = field(passId, 'Password', 'password', 'current-password')
  passRow.classList.add('rn-dialog__field--last')

  const target = h('strong', { class: 'rn-http-auth__host', text: ev.host })
  const message = h(
    'div',
    { class: 'rn-dialog__message', attrs: { id: msgId } },
    h('p', {}, ev.isProxy ? 'The proxy ' : '', target, ' requires a username and password.'),
    ev.realm ? h('p', { class: 'rn-http-auth__realm' }, ev.isProxy ? 'The proxy says: ' : 'The site says: ', h('q', { text: ev.realm })) : null,
    !ev.isProxy && ev.host.startsWith('http:')
      ? h('p', { class: 'rn-http-auth__warning', text: 'Your connection to this site is not private.' })
      : null
  )

  const form = h('form', { class: 'rn-dialog__form', attrs: { novalidate: true } })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    respond({ username: user.value.slice(0, FIELD_MAX), password: pass.value.slice(0, FIELD_MAX) })
  })
  const cancelBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Cancel', on: { click: cancel } })
  const ok = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: 'Sign in' })
  form.append(h('div', { class: 'rn-dialog__body' }, message, userRow, passRow), h('div', { class: 'rn-dialog__actions' }, cancelBtn, ok))

  const box = h(
    'div',
    {
      class: 'rn-dialog rn-dialog--modal rn-http-auth',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': msgId }
    },
    h('h2', { class: 'rn-dialog__title', attrs: { id: titleId }, text: ev.isProxy ? 'Proxy sign in' : 'Sign in' }),
    form
  )
  trapFocus(box)
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  })
  const root = h('div', { class: 'rn-modal' }, h('div', { class: 'rn-scrim', attrs: { 'aria-hidden': 'true' } }), box)
  queueMicrotask(() => user.focus())

  // Outside clicks are ignored: the dialog only closes through Cancel, Sign in or Esc.
  return { root, onOutside: () => user.focus() }
}
