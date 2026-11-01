// Omnibox suggestion handlers (DESIGN 3.2, T20): omnibox.suggest / highlight / dismiss (shell) and omnibox.pick
// (overlay). The list is drawn by the overlay view, sized to just the dropdown so the rest of the window (page,
// shell) keeps its clicks; keyboard focus stays in the shell input, which drives the highlight.
// Wiring: call registerOmniboxHandlers() once after router.install() (index.ts).
import { IpcFailure, router, type CallContext } from '../ipc/router'
import { windowManager } from '../windows/window-manager'
import { browserTabs } from '../tabs/tab-manager'
import { getSearchEngine } from '../../shared/search-engines'
import type { Rect, Suggestion } from '../../shared/types'
import type { WindowContext } from '../types'
import { buildSuggestions } from './suggestions'

export { buildSuggestions, MAX_SUGGESTIONS } from './suggestions'

/** Row height and frame allowance of `.rn-suggest` in the skins (24px rows, 1px border + 2px padding). */
const ROW_H = 24
const FRAME = 6
/** Room for the 1997/2001 drop shadows, which would otherwise be clipped by the overlay view's bounds. */
const SHADOW = 10
/** A click on a row focuses the overlay, the shell blurs and dismisses: keep the list pickable this long after. */
const PICK_GRACE_MS = 1000

interface SuggestState {
  items: Suggestion[]
  selected: number
  /** Set when dismissed; a pick that arrives within PICK_GRACE_MS of it still works. */
  dismissedAt: number | null
}

const states = new Map<number, SuggestState>()

function windowOf(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

/** Overlay view bounds for the dropdown: the omnibox width, as tall as its rows, clamped to the window. */
function dropdownBounds(w: WindowContext, anchor: Rect, rows: number): Rect {
  const [cw, ch] = w.win.getContentSize() as [number, number]
  const x = Math.max(0, Math.round(anchor.x))
  const y = Math.max(0, Math.round(anchor.y))
  const width = Math.max(1, Math.min(Math.round(anchor.width) + SHADOW, cw - x))
  const height = Math.max(1, Math.min(rows * ROW_H + FRAME + SHADOW, ch - y))
  return { x, y, width, height }
}

/** Another overlay (palette, prompt, dialog, editor, notice) owns the view: never replace it with a dropdown. */
function overlayBusy(w: WindowContext): boolean {
  const kind = w.overlayKind()
  return kind !== null && kind !== 'suggest'
}

export function registerOmniboxHandlers(): void {
  router.handle('omnibox.suggest', (req, ctx) => {
    const w = windowOf(ctx)
    const stores = w.profile.stores
    const engine = getSearchEngine(w.profile.getSettings().searchEngine)
    const items = buildSuggestions(
      req.text,
      { bookmarks: (p, n) => stores.bookmarks.suggest(p, n), history: (p, n) => stores.history.suggest(p, n) },
      engine
    )
    states.set(w.id, { items, selected: -1, dismissedAt: null })
    if (items.length === 0) {
      if (w.overlayKind() === 'suggest') w.hideOverlay()
    } else if (!overlayBusy(w) && !w.popup) {
      const bounds = dropdownBounds(w, req.anchor, Math.min(items.length, 8))
      w.showOverlay({ kind: 'suggest', anchor: { ...req.anchor, x: bounds.x, y: bounds.y }, items, selected: -1 }, { bounds })
    }
    return { items }
  })

  router.handle('omnibox.highlight', (req, ctx) => {
    const w = windowOf(ctx)
    const s = states.get(w.id)
    if (!s) return null
    s.selected = req.index < s.items.length ? req.index : -1
    if (w.overlayKind() === 'suggest') w.sendOverlay('overlay', { kind: 'suggest-highlight', selected: s.selected })
    return null
  })

  router.handle('omnibox.dismiss', (_req, ctx) => {
    const w = windowOf(ctx)
    const s = states.get(w.id)
    if (s) s.dismissedAt = Date.now()
    if (w.overlayKind() === 'suggest') w.hideOverlay()
    return null
  })

  router.handle('omnibox.pick', (req, ctx) => {
    const w = windowOf(ctx)
    const s = states.get(w.id)
    const live = s && (s.dismissedAt === null || Date.now() - s.dismissedAt < PICK_GRACE_MS)
    const item = live ? s.items[req.index] : undefined
    if (!item) throw new IpcFailure('E_NOT_FOUND', 'No such suggestion')
    states.delete(w.id)
    if (w.overlayKind() === 'suggest') w.hideOverlay()
    w.sendShell('ui', { action: 'omnibox-picked' })
    browserTabs(w).navigate(item.url)
    return null
  })

  windowManager.onWindowClosed((w) => states.delete(w.id))
}
