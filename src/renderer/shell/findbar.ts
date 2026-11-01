// Find bar (DESIGN 3.6; SPEC AC7). A row under the bookmark bar, right-aligned:
// "Find in page:" [input] "3 of 12" [prev] [next] [close]. Opens from the toolbar or the `find` open event
// (Cmd/Ctrl+F, prefilled with the last query); Enter = next, Shift+Enter = previous, Esc closes.
// Appears and disappears instantly (keyboard-driven, DESIGN 6.2). Showing/hiding it changes the shell's top
// inset; main.ts measures that, so this module doesn't report anything itself.
import { h, icon } from '../common/dom'
import type { ShellBridge } from '../common/api'
import type { FindEvent, Platform } from '@shared/types'
import { call, withShortcut } from './toolbar'

export interface FindBar {
  readonly el: HTMLElement
  readonly isOpen: boolean
  open(query?: string): void
  close(notifyMain?: boolean): void
  event(ev: FindEvent): void
  /** Active tab changed: results belong to the old page, so start over. */
  reset(): void
}

let uid = 0

export function createFindBar(api: ShellBridge, platform: Platform, onToggle: (open: boolean) => void = () => {}): FindBar {
  const id = `rn-find-${++uid}`
  const input = h('input', {
    class: 'rn-input',
    attrs: { id, type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search', 'aria-describedby': `${id}-count` }
  })
  // Visible count updates at once; the screen-reader copy is debounced so it doesn't chatter while typing.
  const count = h('span', { class: 'rn-findbar__count', attrs: { id: `${id}-count` } })
  const live = h('span', { class: 'rn-sr-only', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } })
  const btn = (name: string, label: string, cmd: 'find.previous' | 'find.next' | null): HTMLButtonElement =>
    h('button', { class: 'rn-btn rn-btn--icon', attrs: { type: 'button', 'aria-label': label, title: withShortcut(label, cmd, platform) } }, icon(name))
  const prev = btn('chevron-up', 'Previous match', 'find.previous')
  const next = btn('chevron-down', 'Next match', 'find.next')
  const closeBtn = btn('close', 'Close find bar', null)
  closeBtn.title = 'Close find bar (Esc)'
  const el = h(
    'div',
    { class: 'rn-findbar', attrs: { role: 'search', 'aria-label': 'Find in page', hidden: true } },
    h('label', { attrs: { for: id }, text: 'Find in page:' }),
    input,
    count,
    prev,
    next,
    closeBtn,
    live
  )

  let isOpen = false
  let countTimer: ReturnType<typeof setTimeout> | null = null
  let pendingCount = ''

  function setCount(textValue: string, noMatch: boolean, immediate = false): void {
    el.classList.toggle('rn-findbar--nomatch', noMatch)
    input.setAttribute('aria-invalid', noMatch ? 'true' : 'false')
    count.textContent = textValue
    pendingCount = textValue
    // DESIGN 3.6: announcements debounced 250 ms.
    if (countTimer) clearTimeout(countTimer)
    if (immediate) {
      live.textContent = textValue
      return
    }
    countTimer = setTimeout(() => {
      countTimer = null
      live.textContent = pendingCount
    }, 250)
  }

  function setNavEnabled(on: boolean): void {
    prev.disabled = !on
    next.disabled = !on
  }

  function query(): void {
    const text = input.value
    if (!text) {
      setCount('', false, true)
      setNavEnabled(false)
    }
    void call(api.find.query({ text: text.slice(0, 1024) }), 'find.query')
  }

  function step(forward: boolean): void {
    if (!input.value) return
    void call(api.find.next({ forward }), 'find.next')
  }

  function open(q?: string): void {
    if (q !== undefined && q !== '' && q !== input.value) input.value = q
    const wasOpen = isOpen
    isOpen = true
    el.hidden = false
    if (!wasOpen) onToggle(true)
    input.focus()
    input.select()
    if (!wasOpen && input.value) query()
    if (!input.value) setNavEnabled(false)
  }

  function close(notifyMain = true): void {
    if (!isOpen) return
    isOpen = false
    el.hidden = true
    onToggle(false)
    setCount('', false, true)
    if (notifyMain) void call(api.find.close(), 'find.close')
    if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }

  input.addEventListener('input', query)
  input.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return
    if (ev.key === 'Enter') {
      ev.preventDefault()
      step(!ev.shiftKey)
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
    }
  })
  // Esc anywhere in the bar (e.g. focus on a button) closes it too.
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ev.target !== input) {
      ev.preventDefault()
      close()
    }
  })
  prev.addEventListener('click', () => step(false))
  next.addEventListener('click', () => step(true))
  closeBtn.addEventListener('click', () => close())

  return {
    el,
    get isOpen() {
      return isOpen
    },
    open,
    close,
    event(ev) {
      if (ev.type === 'open') return open(ev.query)
      if (ev.type === 'close') return close(false)
      if (!isOpen || !input.value) return
      if (ev.matches === 0) {
        if (ev.final) setCount('No matches', true)
        setNavEnabled(false)
        return
      }
      setNavEnabled(true)
      setCount(`${Math.max(1, ev.activeMatch)} of ${ev.matches}`, false)
    },
    reset() {
      if (!isOpen) return
      setCount('', false, true)
      if (input.value) query()
    }
  }
}
