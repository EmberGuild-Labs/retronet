// Generic overlay dialogs (DESIGN 3.9): `text` (new/rename profile name, etc.) and `confirm` (delete, clear all).
// Centered over a scrim, focus trapped, Esc = Cancel, Enter = OK. Answers go back with overlay.dialogResult:
// text -> the trimmed string (or null on cancel), confirm -> true / false.
import type { DialogSpec, OverlayEvent } from '@shared/types'
import { h, icon } from '../common/dom'
import { nextId, trapFocus, type Mounted, type OverlayEnv } from './ui'

type DialogEvent = Extract<OverlayEvent, { kind: 'dialog' }>
const NAME_MAX = 64

export function mountDialog(ev: DialogEvent, env: OverlayEnv): Mounted {
  const spec: DialogSpec = ev.dialog
  const { api } = env
  const titleId = nextId('rn-dialog-title')
  let answered = false

  const answer = (value: string | boolean | null): void => {
    if (answered) return
    answered = true
    void api.overlay.dialogResult({ dialogId: spec.id, value }).then((r) => {
      if (!r.ok) env.close()
    })
  }

  const cancelValue = spec.kind === 'confirm' ? false : null
  const cancel = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => answer(cancelValue) } })

  let body: HTMLElement
  let ok: HTMLButtonElement
  let initialFocus: HTMLElement
  const form = h('form', { class: 'rn-dialog__form', attrs: { novalidate: true } })

  if (spec.kind === 'text') {
    const inputId = nextId('rn-dialog-input')
    const errorId = nextId('rn-dialog-error')
    const input = h('input', {
      class: 'rn-input rn-dialog__input',
      attrs: { id: inputId, type: 'text', maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': errorId }
    })
    input.value = spec.value
    const error = h('p', { class: 'rn-dialog__error', attrs: { id: errorId } })
    error.hidden = true
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') {
        input.removeAttribute('aria-invalid')
        error.hidden = true
        error.textContent = ''
      }
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const v = input.value.trim()
      if (!v) {
        input.setAttribute('aria-invalid', 'true')
        error.textContent = `Enter a ${spec.label.toLowerCase()}.`
        error.hidden = false
        input.focus()
        return
      }
      answer(v.slice(0, NAME_MAX))
    })
    body = h('div', { class: 'rn-dialog__field' }, h('label', { attrs: { for: inputId }, text: spec.label }), input, error)
    ok = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: spec.okLabel })
    initialFocus = input
    queueMicrotask(() => input.select())
  } else {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      answer(true)
    })
    body = h('p', { class: 'rn-dialog__message', text: spec.message })
    ok = spec.danger
      ? h('button', { class: 'rn-btn rn-btn--danger', attrs: { type: 'submit' } }, icon('trash'), h('span', { class: 'rn-btn__label', text: spec.okLabel }))
      : h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: spec.okLabel })
    // Destructive confirms start on Cancel (DESIGN 3.9).
    initialFocus = spec.danger ? cancel : ok
  }

  form.append(h('div', { class: 'rn-dialog__body' }, body), h('div', { class: 'rn-dialog__actions' }, cancel, ok))
  const box = h(
    'div',
    {
      class: 'rn-dialog rn-dialog--modal',
      attrs: { role: spec.kind === 'confirm' ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }
    },
    h('h2', { class: 'rn-dialog__title', attrs: { id: titleId }, text: spec.title }),
    form
  )
  if (spec.kind === 'confirm') box.setAttribute('aria-describedby', (body.id = nextId('rn-dialog-msg')))
  trapFocus(box)
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      answer(cancelValue)
    }
  })
  const root = h('div', { class: 'rn-modal' }, h('div', { class: 'rn-scrim', attrs: { 'aria-hidden': 'true' } }), box)
  queueMicrotask(() => initialFocus.focus())

  return { root, onOutside: () => answer(cancelValue) }
}
