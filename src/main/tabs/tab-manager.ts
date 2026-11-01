// Tab manager (PLAN 1.3, T12). One per window: the strip order (pinned first), the active tab, groups as plain
// data (T15 owns the group logic and calls the mutators below), and the closed-tab stack (10 per window).
// The window manager calls `createTabManager(ctx, { initialUrl })` once per window, after the shell and overlay
// exist. Other modules reach the full API through `browserTabs(windowContext)`.
import type { WebContents, WebContentsView, NavigationEntry } from 'electron'
import { classifyInput } from '../../shared/omnibox'
import { getSearchEngine } from '../../shared/search-engines'
import { NEWTAB_URL } from '../../shared/settings'
import type { GroupState } from '../../shared/types'
import { logger } from '../logger'
import { decideBrowserNavigation, type OpenerHandoff, type PopupFeatures } from '../security/navigation-guards'
import { requestExternal } from '../security/external-protocols'
import type { TabManager, TabsSnapshot, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { Tab, type TabHost } from './tab'

export { Tab } from './tab'

export interface TabManagerOptions {
  initialUrl?: string
}

export const CLOSED_STACK_MAX = 10

export interface CreateTabOptions {
  /** Address to load (browser-initiated; checked with decideBrowserNavigation). Default: the new-tab page. */
  url?: string
  /** `url` came from the user typing it (the only way to load file:). */
  typed?: boolean
  /** Keep the current tab active. */
  background?: boolean
  /** Strip index (clamped into the pinned / unpinned region). Default: the end, or after the opener. */
  index?: number
  pinned?: boolean
  groupId?: string | null
  muted?: boolean
  openerId?: number | null
  /** Adopt a window.open guest (already loading `url`). */
  adopt?: WebContents
  /** Reopen-closed: restore this back/forward list instead of loading `url`. */
  history?: { entries: NavigationEntry[]; index: number }
}

export interface ClosedTab {
  url: string
  title: string
  index: number
  pinned: boolean
  groupId: string | null
  /** The group as it was, so reopening can recreate it if it was closed meanwhile. */
  group: GroupState | null
  muted: boolean
  entries: NavigationEntry[]
  activeIndex: number
}

/** A tab as session restore saves it (FIX-1: with its back/forward list). */
export interface SessionTab {
  id: number
  url: string
  title: string
  pinned: boolean
  groupId: string | null
  muted: boolean
  history?: { entries: Array<{ url: string; title: string }>; index: number }
}

export interface SessionView {
  tabs: SessionTab[]
  groups: GroupState[]
  activeTabId: number | null
}

export type NavigateDisposition = 'current' | 'new-tab' | 'background-tab'

/** Full tab API for T15/T16/T17/T18/T19 (the window manager only sees the TabManager part). */
export interface BrowserTabManager extends TabManager {
  readonly window: WindowContext
  /** Tabs in strip order (pinned first). */
  list(): readonly Tab[]
  get(tabId: number): Tab | null
  active(): Tab | null
  create(opts?: CreateTabOptions): Tab | null
  /** Close a tab (pushes it on the closed stack). Closing the last tab closes the window. */
  close(tabId: number): boolean
  activate(tabId: number): boolean
  /** Move to strip index `index` (clamped into the tab's pinned / unpinned region). */
  move(tabId: number, index: number): boolean
  pin(tabId: number, pinned: boolean): boolean
  toggleMute(tabId: number): boolean
  /** Raw omnibox text: classified with the profile's search engine. Returns false when blocked. */
  navigate(input: string, opts?: { tabId?: number; disposition?: NavigateDisposition }): boolean
  /** A known URL (bookmark, history, command). Browser-initiated, not typed. */
  loadUrl(tabId: number, url: string): boolean
  back(tabId?: number): boolean
  forward(tabId?: number): boolean
  reload(tabId?: number, ignoreCache?: boolean): boolean
  stop(tabId?: number): boolean
  home(tabId?: number): boolean
  /** Pop the closed-tab stack (Cmd/Ctrl+Shift+T). Returns the new tab, or null if the stack is empty. */
  reopenClosed(): Tab | null
  closedTabs(): readonly ClosedTab[]
  // Group data (logic in T15's groups.ts)
  groups(): readonly GroupState[]
  getGroup(groupId: string): GroupState | null
  /** Insert or replace a group (name, color, collapsed). */
  upsertGroup(group: GroupState): void
  /** Drop a group and clear its members' groupId (the tabs stay open). */
  removeGroup(groupId: string): void
  /** Set or clear a tab's group. Unknown group ids are refused. Pinned tabs can't be grouped. */
  setTabGroup(tabId: number, groupId: string | null): boolean
  /** Push the snapshot (after an outside change: bookmarks, zoom). */
  refresh(): void
  /**
   * The window is being closed: run every tab's beforeunload (browser-standard). Returns false when there is
   * nothing to wait for (no tabs left: let the window close now). Otherwise the tabs close as their pages
   * agree and the window closes with the last one; a "Stay" on any tab cancels the rest (those tabs stay, no
   * further prompts). Tabs that did close meanwhile are on the closed-tab stack.
   */
  closeAllForWindow(): boolean
  /** What session restore saves. While a window close is in progress, the tabs as they were when it began. */
  sessionView(): SessionView
}

/** The full API of a window's tab manager. */
export function browserTabs(w: WindowContext): BrowserTabManager {
  return w.tabs as BrowserTabManager
}

// ---- Seeding the first tab of a new window (popups, links from popups, session restore) ----

interface TabSeed {
  /** Adopt this window.open guest as the first tab. */
  adopt?: WebContents
  url?: string
  /** Open the window with no tab (the caller adds tabs right after, e.g. session restore). */
  empty?: boolean
  /** Filled in by createTabManager: the first tab's webContents. */
  created?: WebContents
}

let pendingSeed: TabSeed | null = null

/**
 * Run `create` (which must call windowManager.createWindow synchronously) with a seed for that window's first tab.
 * Returns what `create` returned plus the first tab's webContents.
 */
export function withTabSeed<T>(seed: Omit<TabSeed, 'created'>, create: () => T): { result: T; firstTab: WebContents | undefined } {
  const s: TabSeed = { ...seed }
  pendingSeed = s
  try {
    const result = create()
    return { result, firstTab: s.created }
  } finally {
    pendingSeed = null
  }
}

let nextTabId = 1

// ---- Structural changes (R5) ----
// What session restore saves changed: the tab set or order, a tab's committed URL, pin, mute, group membership,
// a group itself, or the active tab. Title, favicon, loading and status pushes are not structural.

type StructureListener = (w: WindowContext) => void
const structureListeners = new Set<StructureListener>()

/** Listen for structural tab changes in any window (called synchronously, after the change). */
export function onTabStructureChanged(listener: StructureListener): () => void {
  structureListeners.add(listener)
  return () => void structureListeners.delete(listener)
}

function emitStructureChanged(w: WindowContext): void {
  for (const l of [...structureListeners]) {
    try {
      l(w)
    } catch (err) {
      logger.warn('tab structure listener failed', err)
    }
  }
}

class TabManagerImpl implements BrowserTabManager, TabHost {
  private order: Tab[] = []
  private activeId: number | null = null
  private readonly groupMap = new Map<string, GroupState>()
  private closed: ClosedTab[] = []
  /** User closes waiting for the page's beforeunload, with the closed-stack record taken at request time. */
  private readonly pendingClose = new Map<Tab, ClosedTab | null>()
  /** A window close waiting for its tabs' beforeunload. */
  private windowClose: { pending: Set<Tab>; cancelled: boolean; view: SessionView } | null = null
  private disposed = false

  constructor(readonly window: WindowContext) {}

  // ---- TabManager (window manager side) ----

  snapshot(): TabsSnapshot {
    return {
      tabs: this.order.map((t) => t.state()),
      groups: [...this.groupMap.values()].map((g) => ({ ...g })),
      activeTabId: this.activeId,
      canReopenClosed: this.closed.length > 0
    }
  }

  activeView(): WebContentsView | null {
    return this.active()?.view ?? null
  }

  tabIdFor(wc: WebContents): number | null {
    return this.order.find((t) => t.wc === wc)?.id ?? null
  }

  activeTitle(): string {
    return this.active()?.title() ?? ''
  }

  focusActive(): void {
    this.active()?.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const tabs = this.order
    this.order = []
    this.activeId = null
    this.pendingClose.clear()
    this.windowClose = null
    for (const t of tabs) t.close()
  }

  /** State push plus the structural-change event (session save, group housekeeping). */
  private structural(): void {
    this.window.requestState()
    if (!this.disposed) emitStructureChanged(this.window)
  }

  // ---- TabHost (tab side) ----

  changed(tab: Tab): void {
    if (this.disposed || tab.isDisposed) return
    this.window.requestState()
  }

  committed(tab: Tab): void {
    if (this.disposed || tab.isDisposed) return
    this.structural()
  }

  status(tab: Tab): void {
    if (this.disposed || tab.isDisposed) return
    this.window.sendShell('status', tab.statusEvent())
  }

  isActive(tab: Tab): boolean {
    return tab.id === this.activeId
  }

  openTab(from: Tab, url: string, opts: { background: boolean; handoff?: OpenerHandoff }): WebContents | undefined {
    if (this.disposed) return undefined
    if (this.window.popup) return openInNormalWindow(this.window, url, opts)
    const tab = this.create({ url, background: opts.background, adopt: opts.handoff?.webContents, openerId: from.id })
    return tab?.wc
  }

  openPopup(_from: Tab, opts: { url: string; features: PopupFeatures; handoff?: OpenerHandoff }): WebContents | undefined {
    if (this.disposed) return undefined
    const f = opts.features
    const bounds = {
      ...(f.width !== undefined ? { width: f.width } : {}),
      ...(f.height !== undefined ? { height: f.height } : {}),
      ...(f.left !== undefined && f.top !== undefined ? { x: f.left, y: f.top } : {})
    }
    const { firstTab } = withTabSeed({ adopt: opts.handoff?.webContents, url: opts.url }, () =>
      windowManager.createWindow({ profile: this.window.profile, popup: true, bounds })
    )
    return firstTab
  }

  gone(tab: Tab): void {
    if (this.disposed || !this.order.includes(tab)) return
    const rec = this.pendingClose.get(tab)
    if (rec !== undefined) {
      this.pendingClose.delete(tab)
      this.pushClosedRecord(rec)
    }
    this.detach(tab, false)
    this.windowCloseSettled(tab)
  }

  closeCancelled(tab: Tab): void {
    this.pendingClose.delete(tab)
    if (this.windowClose?.pending.has(tab)) this.windowClose.cancelled = true
    this.windowCloseSettled(tab)
  }

  suppressUnloadPrompt(tab: Tab): boolean {
    return this.windowClose !== null && this.windowClose.cancelled && this.windowClose.pending.has(tab)
  }

  /** One tab of a window close answered; when all have and one said "Stay", the window stays open. */
  private windowCloseSettled(tab: Tab): void {
    const wc = this.windowClose
    if (!wc || !wc.pending.delete(tab) || wc.pending.size > 0) return
    // All tabs gone: detach() is closing the window; keep the frozen session view until it has. Cancelled (or
    // a tab appeared meanwhile): the window stays, and the survivors are saved as they are.
    if (wc.cancelled || this.order.length > 0) {
      this.windowClose = null
      this.structural()
    }
  }

  // ---- Window close / session ----

  closeAllForWindow(): boolean {
    if (this.disposed || this.order.length === 0) return false
    if (this.windowClose) return true
    const view = this.liveSessionView()
    const pending = new Set(this.order)
    this.windowClose = { pending, cancelled: false, view }
    // The active tab last, so the strip doesn't flip through tabs while they go.
    const queue = [...this.order].sort((a, b) => Number(a.id === this.activeId) - Number(b.id === this.activeId))
    for (const t of queue) {
      if (this.disposed) break
      // A tab that had a user close in flight already: wait for that one (its gone/closeCancelled settles it).
      if (t.isClosing) continue
      this.close(t.id)
      // close() may have finished synchronously (no handler, crashed tab): gone() already settled it.
    }
    return true
  }

  sessionView(): SessionView {
    return this.windowClose?.view ?? this.liveSessionView()
  }

  private liveSessionView(): SessionView {
    return {
      tabs: this.order.map((t) => {
        const rec = t.sessionRecord()
        return {
          id: t.id,
          url: rec.url,
          title: rec.title,
          pinned: t.pinned,
          groupId: t.groupId,
          muted: !t.wc.isDestroyed() && t.wc.isAudioMuted(),
          ...(rec.history ? { history: rec.history } : {})
        }
      }),
      groups: [...this.groupMap.values()].map((g) => ({ ...g })),
      activeTabId: this.activeId
    }
  }

  // ---- Queries ----

  list(): readonly Tab[] {
    return this.order
  }

  get(tabId: number): Tab | null {
    return this.order.find((t) => t.id === tabId) ?? null
  }

  active(): Tab | null {
    return this.activeId === null ? null : this.get(this.activeId)
  }

  closedTabs(): readonly ClosedTab[] {
    return this.closed
  }

  private pinnedCount(): number {
    let n = 0
    while (n < this.order.length && this.order[n]!.pinned) n++
    return n
  }

  private resolve(tabId?: number): Tab | null {
    return tabId === undefined ? this.active() : this.get(tabId)
  }

  // ---- Create / close / activate / move / pin ----

  create(opts: CreateTabOptions = {}): Tab | null {
    if (this.disposed) return null
    const url = opts.url ?? NEWTAB_URL
    // Check before building anything, so a refused address leaves no stray tab behind. Adopted guests and
    // restored histories were already vetted (by the window-open guard / when they were first loaded).
    if (!opts.adopt && !opts.history && decideBrowserNavigation(url, { typed: opts.typed === true }) !== 'allow') {
      return null
    }
    const pinned = opts.pinned ?? false
    const groupId = !pinned && opts.groupId && this.groupMap.has(opts.groupId) ? opts.groupId : null
    const tab = new Tab(this, {
      id: nextTabId++,
      adopt: opts.adopt,
      pinned,
      groupId,
      openerId: opts.openerId ?? null,
      muted: opts.muted
    })
    this.order.splice(this.insertionIndex(tab, opts.index), 0, tab)
    if (opts.history) tab.restoreHistory(opts.history.entries, opts.history.index)
    else if (!opts.adopt) tab.load(url, { typed: opts.typed, user: false })
    if (!opts.background || this.activeId === null) this.activate(tab.id)
    else this.structural()
    return tab
  }

  /** Where a new tab goes: explicit index, after its opener's other children, after its group, or the end. */
  private insertionIndex(tab: Tab, index: number | undefined): number {
    const pc = this.pinnedCount()
    const [lo, hi] = tab.pinned ? [0, pc] : [pc, this.order.length]
    if (index !== undefined) return Math.min(Math.max(index, lo), hi)
    if (tab.pinned) return pc
    if (tab.openerId !== null) {
      const at = this.order.findIndex((t) => t.id === tab.openerId)
      if (at >= 0) {
        let i = Math.max(at + 1, lo)
        while (i < this.order.length && this.order[i]!.openerId === tab.openerId) i++
        return i
      }
    }
    if (tab.groupId) {
      let last = -1
      this.order.forEach((t, i) => {
        if (t.groupId === tab.groupId) last = i
      })
      if (last >= 0) return last + 1
    }
    return hi
  }

  /**
   * User close. The page's beforeunload runs first ("Leave site?" prompt if it objects), so the tab leaves the
   * strip asynchronously, through gone(). Crashed / dead tabs go at once.
   */
  close(tabId: number): boolean {
    const tab = this.get(tabId)
    if (!tab || this.disposed) return false
    if (tab.isClosing) return true
    // Record first: with no beforeunload handler, Electron emits the webContents 'close' (-> gone()) synchronously
    // inside requestClose(), and gone() must already find the record.
    const rec = this.closedEntry(tab)
    this.pendingClose.set(tab, rec)
    if (tab.requestClose()) return true
    this.pendingClose.delete(tab)
    if (!this.order.includes(tab)) return true
    this.pushClosedRecord(rec)
    this.detach(tab, true)
    this.windowCloseSettled(tab)
    return true
  }

  private pushClosedRecord(rec: ClosedTab | null): void {
    if (!rec) return
    this.closed.push(rec)
    if (this.closed.length > CLOSED_STACK_MAX) this.closed.splice(0, this.closed.length - CLOSED_STACK_MAX)
  }

  private closedEntry(tab: Tab): ClosedTab | null {
    try {
      const rec = tab.closedRecord()
      if (!rec.url || rec.entries.length === 0) return null
      const group = tab.groupId ? (this.groupMap.get(tab.groupId) ?? null) : null
      return {
        url: rec.url,
        title: rec.title,
        index: this.order.indexOf(tab),
        pinned: tab.pinned,
        groupId: tab.groupId,
        group: group ? { ...group } : null,
        muted: rec.muted,
        entries: rec.entries,
        activeIndex: rec.index
      }
    } catch (err) {
      logger.warn('closed-tab record failed', err)
      return null
    }
  }

  /** Remove a tab from the strip, pick the next active tab, and close the window when it was the last. */
  private detach(tab: Tab, closeWebContents: boolean): void {
    const idx = this.order.indexOf(tab)
    if (idx < 0) return
    const wasActive = tab.id === this.activeId
    this.order.splice(idx, 1)
    for (const t of this.order) if (t.openerId === tab.id) t.openerId = null
    if (wasActive) {
      this.activeId = null
      // browser-standard: the tab to the right takes over, else the one to the left.
      const next = this.order[idx] ?? this.order[idx - 1] ?? null
      if (next) this.activate(next.id)
      else this.window.setActiveView(null)
    }
    if (closeWebContents) tab.close()
    if (this.order.length === 0) {
      // Last tab gone: the window goes too (deferred, so the IPC reply and events can finish first).
      setImmediate(() => {
        if (!this.disposed && this.order.length === 0) this.window.close()
      })
    }
    this.structural()
  }

  activate(tabId: number): boolean {
    const tab = this.get(tabId)
    if (!tab || this.disposed) return false
    if (this.activeId === tabId) return true
    if (this.window.htmlFullscreen) this.window.setHtmlFullscreen(false)
    this.activeId = tabId
    this.window.setActiveView(tab.view)
    if (!this.window.shell.isFocused()) tab.focus()
    this.window.sendShell('status', tab.statusEvent())
    this.structural()
    return true
  }

  move(tabId: number, index: number): boolean {
    const tab = this.get(tabId)
    if (!tab) return false
    const from = this.order.indexOf(tab)
    this.order.splice(from, 1)
    const pc = this.pinnedCount()
    const [lo, hi] = tab.pinned ? [0, pc] : [pc, this.order.length]
    this.order.splice(Math.min(Math.max(index, lo), hi), 0, tab)
    this.structural()
    return true
  }

  pin(tabId: number, pinned: boolean): boolean {
    const tab = this.get(tabId)
    if (!tab) return false
    if (tab.pinned === pinned) return true
    this.order.splice(this.order.indexOf(tab), 1)
    const pc = this.pinnedCount()
    tab.pinned = pinned
    // Pinned tabs leave their group (as in other browsers) and go to the end of the pinned run; unpinned tabs
    // go to the start of the normal run.
    if (pinned) tab.groupId = null
    this.order.splice(pc, 0, tab)
    this.structural()
    return true
  }

  toggleMute(tabId: number): boolean {
    const tab = this.get(tabId)
    if (!tab) return false
    tab.toggleMute()
    this.structural()
    return true
  }

  // ---- Navigation ----

  navigate(input: string, opts: { tabId?: number; disposition?: NavigateDisposition } = {}): boolean {
    const engine = getSearchEngine(this.window.profile.getSettings().searchEngine)
    const r = classifyInput(input, engine)
    if (r.kind === 'blocked') return false
    const typed = r.kind === 'url' && r.typedFile === true
    const d = decideBrowserNavigation(r.url, { typed })
    if (d === 'block') return false
    if (d === 'external') {
      void requestExternal(r.url, this.window.win.isDestroyed() ? null : this.window.win)
      return true
    }
    const disposition = opts.disposition ?? 'current'
    if (disposition !== 'current') {
      return this.create({ url: r.url, typed, background: disposition === 'background-tab' }) !== null
    }
    const tab = this.resolve(opts.tabId)
    if (!tab) return this.create({ url: r.url, typed }) !== null
    const ok = tab.load(r.url, { typed, user: true })
    if (ok && tab.id === this.activeId) tab.focus()
    return ok
  }

  loadUrl(tabId: number, url: string): boolean {
    return this.get(tabId)?.load(url, { user: true }) ?? false
  }

  back(tabId?: number): boolean {
    const t = this.resolve(tabId)
    t?.back()
    return t !== null
  }

  forward(tabId?: number): boolean {
    const t = this.resolve(tabId)
    t?.forward()
    return t !== null
  }

  reload(tabId?: number, ignoreCache = false): boolean {
    const t = this.resolve(tabId)
    t?.reload(ignoreCache)
    return t !== null
  }

  stop(tabId?: number): boolean {
    const t = this.resolve(tabId)
    t?.stop()
    return t !== null
  }

  home(tabId?: number): boolean {
    const t = this.resolve(tabId)
    if (!t) return false
    const home = this.window.profile.getSettings().homePage || NEWTAB_URL
    return t.load(home, { user: true }) || t.load(NEWTAB_URL, { user: true })
  }

  reopenClosed(): Tab | null {
    const rec = this.closed.pop()
    if (!rec) return null
    let groupId = rec.groupId
    if (groupId && !this.groupMap.has(groupId)) {
      if (rec.group) this.groupMap.set(rec.group.id, { ...rec.group })
      else groupId = null
    }
    const tab = this.create({
      url: rec.url,
      index: rec.index,
      pinned: rec.pinned,
      groupId,
      muted: rec.muted,
      history: { entries: rec.entries, index: rec.activeIndex }
    })
    if (!tab) this.structural()
    return tab
  }

  // ---- Groups (data only) ----

  groups(): readonly GroupState[] {
    return [...this.groupMap.values()]
  }

  getGroup(groupId: string): GroupState | null {
    const g = this.groupMap.get(groupId)
    return g ? { ...g } : null
  }

  upsertGroup(group: GroupState): void {
    this.groupMap.set(group.id, { ...group })
    this.structural()
  }

  removeGroup(groupId: string): void {
    if (!this.groupMap.delete(groupId)) return
    for (const t of this.order) if (t.groupId === groupId) t.groupId = null
    this.structural()
  }

  setTabGroup(tabId: number, groupId: string | null): boolean {
    const tab = this.get(tabId)
    if (!tab || (groupId !== null && (!this.groupMap.has(groupId) || tab.pinned))) return false
    tab.groupId = groupId
    this.structural()
    return true
  }

  refresh(): void {
    this.window.requestState()
  }
}

/** A link opened from a popup window lands in a normal window of the same profile (or a new one). */
function openInNormalWindow(from: WindowContext, url: string, opts: { background: boolean; handoff?: OpenerHandoff }): WebContents | undefined {
  const target = windowManager
    .forProfile(from.profile.id, { incognito: from.incognito })
    .find((w) => !w.popup && w.profile === from.profile)
  if (target) {
    const tab = browserTabs(target).create({ url, background: opts.background, adopt: opts.handoff?.webContents })
    if (tab && !opts.background) target.win.focus()
    return tab?.wc
  }
  return withTabSeed({ adopt: opts.handoff?.webContents, url }, () => windowManager.createWindow({ profile: from.profile })).firstTab
}

export function createTabManager(ctx: WindowContext, opts: TabManagerOptions = {}): TabManager {
  const seed = pendingSeed
  pendingSeed = null
  const mgr = new TabManagerImpl(ctx)
  if (seed?.empty) return mgr
  const tab = seed?.adopt
    ? mgr.create({ adopt: seed.adopt, url: seed.url })
    : (mgr.create({ url: seed?.url ?? opts.initialUrl ?? NEWTAB_URL }) ?? mgr.create({ url: NEWTAB_URL }))
  if (seed) seed.created = tab?.wc
  return mgr
}
