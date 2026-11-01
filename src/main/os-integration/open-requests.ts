// Links and files opened from other apps (PLAN-EXTRA 1.2, AC48).
//   - `installOpenRequestHandlers()` runs before ready (index.ts): macOS delivers a cold-launch link as
//     `open-url`/`open-file` before ready, and a listener added later would never see it.
//   - Requests are classified at once (open-targets.ts) and queued until `markOpenTargetReady()` (after the first
//     window or session restore). The queue is FIFO and capped at OPEN_QUEUE_MAX; extras are dropped.
//   - Each request opens a foreground tab in the most recently focused normal window (never incognito, never a
//     popup), or a new window of the last-used profile when there is none. The tab runs decideBrowserNavigation.
//   - Security S5: never log a URL or a path (an incognito user may click a link in another app). Kinds and
//     counts only.
import { app } from 'electron'
import { backgroundTestMode } from '../app-paths'
import { logger } from '../logger'
import { browserTabs, withTabSeed } from '../tabs/tab-manager'
import type { ProfileManager, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { classifyExternalOpen, urlsFromArgv, type ExternalOpenInput, type OpenTarget } from './open-targets'

export const OPEN_QUEUE_MAX = 20
/** R29: after ready, at most this many opens per window of this many ms; the rest are dropped (count only). */
export const OPEN_RATE_MAX = 20
export const OPEN_RATE_WINDOW_MS = 10_000

export interface RoutableWindow {
  readonly incognito: boolean
  readonly popup: boolean
}

/** How the queue reaches windows. Injected so the queue and routing are tested without Electron. */
export interface OpenRouter<W extends RoutableWindow> {
  /** Open windows, most recently focused first. */
  windows(): readonly W[]
  /** Open `t` as a new foreground tab of `w`; false if it was refused. */
  openTab(w: W, t: OpenTarget): boolean
  /** A new window of the last-used profile with `t` as its tab. */
  openWindow(t: OpenTarget): W | null
  /** Bring `w` to the front (restoring it if minimized). */
  focus(w: W): void
}

/** The most recently focused window that is neither incognito nor a popup. */
export function pickTargetWindow<W extends RoutableWindow>(mostRecentFirst: readonly W[]): W | null {
  return mostRecentFirst.find((w) => !w.incognito && !w.popup) ?? null
}

export class OpenRequestQueue<W extends RoutableWindow> {
  private readonly pending: OpenTarget[] = []
  private dropped = 0
  private router: OpenRouter<W> | null = null
  private closed = false
  private readonly recent: number[] = []
  private rateDropped = 0

  constructor(
    private readonly log: (msg: string) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.pending.length
  }

  /** Open now if ready, else queue (FIFO, capped). Ignored once the app is quitting. */
  push(t: OpenTarget): void {
    if (this.closed) {
      this.log('open request ignored: quitting')
      return
    }
    if (this.router) {
      if (!this.allowRate()) return
      this.route(t)
      return
    }
    if (this.pending.length >= OPEN_QUEUE_MAX) {
      this.dropped++
      this.log(`open request queue full (${this.dropped} dropped)`)
      return
    }
    this.pending.push(t)
  }

  /** Windows exist: open everything queued, in order, then route new requests directly. Idempotent. */
  ready(router: OpenRouter<W>): void {
    if (this.router) return
    this.router = router
    const queued = this.pending.splice(0)
    if (queued.length) this.log(`opening ${queued.length} queued open request(s)${this.dropped ? `, ${this.dropped} dropped` : ''}`)
    for (const t of queued) {
      if (this.closed) break
      this.route(t)
    }
  }

  /** Sliding window: false (and a count-only log) when the 21st open lands within 10 s. */
  private allowRate(): boolean {
    const t = this.now()
    while (this.recent.length && t - this.recent[0]! >= OPEN_RATE_WINDOW_MS) this.recent.shift()
    if (this.recent.length >= OPEN_RATE_MAX) {
      this.rateDropped++
      this.log(`open request rate-limited (${this.rateDropped} dropped)`)
      return false
    }
    this.recent.push(t)
    return true
  }

  /** The app is quitting: drop the queue and ignore anything else. */
  close(): void {
    this.closed = true
    this.pending.length = 0
  }

  private route(t: OpenTarget): void {
    const r = this.router
    if (!r) return
    const target = pickTargetWindow(r.windows())
    if (target) {
      if (r.openTab(target, t)) r.focus(target)
      return
    }
    const w = r.openWindow(t)
    if (w) r.focus(w)
  }
}

/** Window ids, most recently focused (or created) first. */
export class FocusOrder {
  private ids: number[] = []

  touch(id: number): void {
    this.ids = [id, ...this.ids.filter((x) => x !== id)]
  }

  remove(id: number): void {
    this.ids = this.ids.filter((x) => x !== id)
  }

  /** `items` sorted most recent first; `focused` (the OS-focused one) always leads; unknown ids go last. */
  sort<T extends { id: number }>(items: readonly T[], focused?: (t: T) => boolean): T[] {
    const rank = (t: T): number => {
      if (focused?.(t)) return -1
      const i = this.ids.indexOf(t.id)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    return [...items].sort((a, b) => rank(a) - rank(b))
  }
}

// ---- Electron wiring ----

const queue = new OpenRequestQueue<WindowContext>((msg) => logger.info(msg))
const order = new FocusOrder()
let installed = false

function receive(input: ExternalOpenInput): void {
  const t = classifyExternalOpen(input)
  if (!t) {
    logger.warn(`ignored an open-${input.kind} request`)
    return
  }
  queue.push(t)
}

/** Before ready, once: listen for `open-url`/`open-file`, track window focus order, stop at quit. */
export function installOpenRequestHandlers(): void {
  if (installed) return
  installed = true
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receive({ kind: 'url', url })
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    receive({ kind: 'file', path })
  })
  app.on('before-quit', () => queue.close())
  windowManager.onWindowCreated((w) => order.touch(w.id))
  windowManager.onWindowFocused((w) => order.touch(w.id))
  windowManager.onWindowClosed((w) => order.remove(w.id))
}

/** Windows/Linux command line (first launch or `second-instance`). Returns how many targets it queued. */
export function handleSecondInstanceArgv(argv: readonly string[], cwd: string): number {
  const targets = urlsFromArgv(argv, cwd, process.platform, { appPath: app.getAppPath() })
  for (const t of targets) queue.push(t)
  return targets.length
}

/** Something is waiting to open (so launch need not open an extra new-tab window). */
export function hasPendingOpenRequests(): boolean {
  return queue.size > 0
}

/** Call once the first window exists (after session restore / the first window): drain the queue. */
export function markOpenTargetReady(deps: { profiles: ProfileManager }): void {
  queue.ready({
    windows: () =>
      order.sort(
        windowManager.all().filter((w) => !w.win.isDestroyed()),
        (w) => w.win.isFocused()
      ),
    openTab: (w, t) => browserTabs(w).create({ url: t.url, typed: t.typed, user: true, background: false }) !== null,
    openWindow: (t) => {
      const { result: w } = withTabSeed({ empty: true }, () => windowManager.createWindow({ profile: deps.profiles.lastUsed() }))
      const tabs = browserTabs(w)
      if (!tabs.create({ url: t.url, typed: t.typed, user: true })) tabs.create({})
      return w
    },
    focus: (w) => {
      // Background test runs never raise a window (window-manager also makes focus() a no-op there).
      if (w.win.isDestroyed() || backgroundTestMode()) return
      if (w.win.isMinimized()) w.win.restore()
      w.win.focus()
    }
  })
}
