// Shell gestures for the hidden era pages (D-B3, DESIGN-EGGS 4). One subtle, pointer-only gesture per throbber skin:
//   y1994  triple-click the globe            -> status note, eggs.open after 600 ms
//   y1997  five clicks on the sky within 3 s -> comet streak + status note, eggs.open after 900 ms (300 ms reduced)
//   y1999  rest the mouse on the pod 1.5 s   -> "Flavors" note for 4 s; a click while it shows opens at once
//   y2001  none here: its hint is the "wiki wiki" omnibox row (main, omnibox/index.ts)
// Rules: listeners are delegated on `document` and never call preventDefault/stopPropagation; the skin is read from
// html[data-skin] at event time; gestures count only while the active tab is idle; 2 s cooldown after an open. The
// gesture logic is a pure state machine (createEggGestures) with injected clock, timers and effects, so it is unit
// tested without a DOM; initShellEggs wires it to the throbber well, the status bar and a polite live region.
import type { ShellBridge } from '../common/api'
import { DEFAULT_SKIN, isSkinId, type SkinId } from '@shared/skins'
import './eggs.css'

export const EGG_NOTE_MS = 4000
export const EGG_COOLDOWN_MS = 2000
export const Y1994_OPEN_DELAY_MS = 600
export const Y1997_CLICKS = 5
export const Y1997_WINDOW_MS = 3000
export const Y1997_OPEN_DELAY_MS = 900
export const Y1997_OPEN_DELAY_REDUCED_MS = 300
export const Y1999_HOVER_MS = 1500

/** Which throbber gesture each era's egg uses (the gesture opens the egg of the skin it fired in). */
export type EggGesture = 'triple-click' | 'five-clicks' | 'rest'
export const EGG_GESTURES: Readonly<Partial<Record<SkinId, EggGesture>>> = { y1994: 'triple-click', y1997: 'five-clicks', y1999: 'rest' }

export const EGG_NOTES: Readonly<Record<EggGesture, string>> = {
  'triple-click': 'This machine is a server. DO NOT POWER IT DOWN!!',
  'five-clicks': 'A comet streaks by… retronet://cascade/',
  rest: 'Flavors: Blueberry, Tangerine… and one more. Click the pod for a taste.'
}

type Timer = ReturnType<typeof setTimeout>

export interface EggGestureDeps {
  now(): number
  setTimer(fn: () => void, ms: number): Timer
  clearTimer(t: Timer): void
  /** The skin at event time. */
  skin(): SkinId
  /** The active tab is not loading. */
  idle(): boolean
  reducedMotion(): boolean
  /** Show (text) or clear (null) the status-bar note. */
  note(text: string | null): void
  /** Start (true) or end (false) the y1997 comet on the well. */
  comet(on: boolean): void
  open(era: SkinId): void
}

export interface EggGestures {
  /** A click on the throbber well; `detail` is the event's click count. */
  click(detail: number): void
  /** A mouse pointer entered the well (pointerover with pointerType "mouse"). */
  hoverStart(): void
  /** The pointer left the well for somewhere outside it. */
  hoverEnd(): void
  /** Skin change or window blur: drop every pending timer, the note and the counters. */
  reset(): void
}

export function createEggGestures(d: EggGestureDeps): EggGestures {
  let cooldownUntil = 0
  let clicks = 0
  let firstClickAt = 0
  let openTimer: Timer | null = null
  let noteTimer: Timer | null = null
  let cometTimer: Timer | null = null
  let hoverTimer: Timer | null = null
  /** The y1999 note is showing, so a click on the pod opens. */
  let tasting = false

  const clear = (t: Timer | null): null => {
    if (t !== null) d.clearTimer(t)
    return null
  }
  const busy = (): boolean => openTimer !== null || d.now() < cooldownUntil

  function hideNote(): void {
    noteTimer = clear(noteTimer)
    tasting = false
    d.note(null)
  }
  function showNote(text: string): void {
    noteTimer = clear(noteTimer)
    d.note(text)
    noteTimer = d.setTimer(() => {
      noteTimer = null
      tasting = false
      d.note(null)
    }, EGG_NOTE_MS)
  }
  function endComet(): void {
    if (cometTimer === null) return
    cometTimer = clear(cometTimer)
    d.comet(false)
  }
  function openNow(era: SkinId): void {
    openTimer = clear(openTimer)
    cooldownUntil = d.now() + EGG_COOLDOWN_MS
    d.open(era)
  }
  function openLater(era: SkinId, ms: number): void {
    openTimer = clear(openTimer)
    openTimer = d.setTimer(() => {
      openTimer = null
      openNow(era)
    }, ms)
  }

  return {
    click(detail) {
      const skin = d.skin()
      const kind = EGG_GESTURES[skin]
      if (!d.idle()) {
        clicks = 0
        return
      }
      if (!kind || busy()) return
      if (kind === 'triple-click') {
        if (detail !== 3) return
        showNote(EGG_NOTES[kind])
        openLater(skin, Y1994_OPEN_DELAY_MS)
      } else if (kind === 'five-clicks') {
        const t = d.now()
        if (clicks === 0 || t - firstClickAt >= Y1997_WINDOW_MS) {
          clicks = 0
          firstClickAt = t
        }
        clicks++
        if (clicks < Y1997_CLICKS) return
        clicks = 0
        const reduced = d.reducedMotion()
        showNote(EGG_NOTES[kind])
        if (!reduced) {
          endComet()
          d.comet(true)
          cometTimer = d.setTimer(() => {
            cometTimer = null
            d.comet(false)
          }, Y1997_OPEN_DELAY_MS)
        }
        openLater(skin, reduced ? Y1997_OPEN_DELAY_REDUCED_MS : Y1997_OPEN_DELAY_MS)
      } else if (tasting) {
        hideNote()
        openNow(skin)
      }
    },
    hoverStart() {
      if (EGG_GESTURES[d.skin()] !== 'rest' || hoverTimer !== null || tasting) return
      hoverTimer = d.setTimer(() => {
        hoverTimer = null
        if (EGG_GESTURES[d.skin()] !== 'rest' || !d.idle() || busy()) return
        showNote(EGG_NOTES.rest)
        tasting = true
      }, Y1999_HOVER_MS)
    },
    hoverEnd() {
      hoverTimer = clear(hoverTimer)
    },
    reset() {
      clicks = 0
      hoverTimer = clear(hoverTimer)
      openTimer = clear(openTimer)
      endComet()
      if (noteTimer !== null || tasting) hideNote()
    }
  }
}

/** Wires the gestures to the shell DOM. Call once, after the frame is in the document (shell/main.ts). */
export function initShellEggs(api: ShellBridge): void {
  const root = document.documentElement
  const live = document.createElement('div')
  live.className = 'rn-sr-only'
  live.setAttribute('role', 'status')
  live.setAttribute('aria-live', 'polite')
  document.body.append(live)

  const well = (): HTMLElement | null => document.querySelector<HTMLElement>('.rn-throbber-well')
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

  const gestures = createEggGestures({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    skin: () => {
      const s = root.dataset.skin
      return isSkinId(s) ? s : DEFAULT_SKIN
    },
    idle: () => well()?.querySelector('.rn-throbber')?.getAttribute('data-state') === 'idle',
    reducedMotion: () => root.dataset.reducedMotion === 'true' || motionQuery.matches,
    note: (text) => {
      const pane = document.querySelector<HTMLElement>('.rn-statusbar__text')
      if (text === null) pane?.removeAttribute('data-egg-note')
      else pane?.setAttribute('data-egg-note', text)
      live.textContent = text ?? ''
    },
    comet: (on) => {
      const w = well()
      if (!w) return
      if (on) w.dataset.egg = 'comet'
      else delete w.dataset.egg
    },
    open: (era) => {
      // An egg: any failure is logged and otherwise ignored.
      api.eggs.open({ era }).then(
        (r) => {
          if (!r.ok) console.warn(`[shell] eggs.open failed: ${r.code} ${r.message}`)
        },
        (err: unknown) => console.warn('[shell] eggs.open threw', err)
      )
    }
  })

  const inWell = (t: EventTarget | null): boolean => t instanceof Element && t.closest('.rn-throbber-well') !== null
  document.addEventListener('click', (ev) => {
    if (inWell(ev.target)) gestures.click(ev.detail)
  })
  document.addEventListener('pointerover', (ev) => {
    if (ev.pointerType === 'mouse' && inWell(ev.target)) gestures.hoverStart()
  })
  document.addEventListener('pointerout', (ev) => {
    if (inWell(ev.target) && !inWell(ev.relatedTarget)) gestures.hoverEnd()
  })
  window.addEventListener('blur', () => gestures.reset())
  new MutationObserver(() => gestures.reset()).observe(root, { attributes: true, attributeFilter: ['data-skin'] })
}
