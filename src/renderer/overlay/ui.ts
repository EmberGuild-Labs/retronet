// Small helpers shared by the overlay components: the component lifecycle, focus trapping, positioning,
// shortcut chips and safe favicons.
import { acceleratorParts, type Platform } from '@shared/commands'
import type { ShellBridge } from '@shared/ipc-contract'
import type { WindowSnapshot } from '@shared/types'
import { h } from '../common/dom'

export interface OverlayEnv {
  api: ShellBridge
  platform: Platform
  /** Latest WindowSnapshot (null until the first `state`). */
  snapshot(): WindowSnapshot | null
  /** Asks main to hide the overlay (it then sends `hide`, which tears the component down). */
  close(): void
}

/** A mounted overlay component. `onState` runs on every snapshot while it is shown. */
export interface Mounted {
  root: HTMLElement
  /** Click on the transparent area outside the component (palette/dialog cancel; prompt ignores it). */
  onOutside?(): void
  onState?(snap: WindowSnapshot): void
  destroy?(): void
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0)
}

/** Keeps Tab / Shift+Tab inside `container` (DESIGN 3.7, 3.9, 6.3). */
export function trapFocus(container: HTMLElement): void {
  container.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return
    const list = focusables(container)
    if (list.length === 0) {
      ev.preventDefault()
      return
    }
    const first = list[0]!
    const last = list[list.length - 1]!
    const active = document.activeElement as HTMLElement | null
    if (ev.shiftKey && (active === first || !container.contains(active))) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && (active === last || !container.contains(active))) {
      ev.preventDefault()
      first.focus()
    }
  })
}

/** Clamp a left/top so a box of `w` x `h` stays inside the overlay viewport with `margin` px to spare. */
export function clampInto(left: number, top: number, w: number, hgt: number, margin = 8): { left: number; top: number } {
  const maxLeft = Math.max(margin, window.innerWidth - w - margin)
  const maxTop = Math.max(margin, window.innerHeight - hgt - margin)
  return { left: Math.min(Math.max(margin, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) }
}

/** Absolute position in overlay pixels. CSSOM writes are allowed by the CSP (only inline style attributes are not). */
export function place(el: HTMLElement, left: number, top: number): void {
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}

const SPOKEN: Readonly<Record<string, string>> = {
  '⌘': 'Command',
  '⇧': 'Shift',
  '⌥': 'Option',
  '⌃': 'Control',
  '←': 'Left',
  '→': 'Right',
  '↑': 'Up',
  '↓': 'Down',
  '↩': 'Return',
  '⌫': 'Delete',
  '[': 'Left bracket',
  ']': 'Right bracket',
  '.': 'Period',
  ',': 'Comma',
  '=': 'Equals',
  '-': 'Minus',
  '+': 'Plus'
}

/** `.rn-kbd` chips for an accelerator, plus a spoken form for the accessible name ("Command Shift N"). */
export function shortcutChips(accelerator: string | undefined, platform: Platform): { el: HTMLElement | null; spoken: string } {
  if (!accelerator) return { el: null, spoken: '' }
  let parts: string[]
  try {
    parts = acceleratorParts(accelerator, platform)
  } catch {
    return { el: null, spoken: '' }
  }
  const el = h('span', { class: 'rn-overlay-keys', attrs: { 'aria-hidden': 'true' } }, ...parts.map((p) => h('kbd', { class: 'rn-kbd', text: p })))
  return { el, spoken: parts.map((p) => SPOKEN[p] ?? p).join(' ') }
}

/** Page favicons are shown only from data:image/ URLs (security ask, T18); anything else gets the page icon. */
export function safeFavicon(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.[a-z.]*icon|bmp);/i.test(url) ? url : null
}

let uid = 0
export function nextId(prefix: string): string {
  return `${prefix}-${++uid}`
}
