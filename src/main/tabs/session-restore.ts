// Session save and restore (PLAN T15, AC10). Regular windows only: popups and incognito windows are never
// saved (their tabs would leak browsing the user asked not to keep). Each profile's windows go to that
// profile's session.json through the store T8 built (it debounces and writes atomically; a corrupt file is
// backed up and replaced by an empty session by the JSON store, so a bad file just means "nothing to restore").
//
// Saving: on structural tab changes only (R5: tab set/order, committed URL, pin, mute, group, active tab; the tab
// manager's onTabStructureChanged event), debounced here, never on title/favicon/loading pushes. At quit,
// index.ts calls prepareQuit() (save now, then freeze) BEFORE it flushes the stores, so the final session is in
// that flush; the windows closing during shutdown must not overwrite it. The last window of a profile closing does not clear its session either, so
// "close the window, quit, reopen" brings it back; closing all of a profile's windows while other windows
// stay open does clear it.
//
// Restoring: on launch, for each profile whose `startup` setting is `restore`. Stored: URLs, titles, pins,
// groups, the active tab and (FIX-1) each tab's back/forward list (url + title, at most SESSION_HISTORY_MAX
// entries), restored with navigationHistory.restore. Every restored address, history entries included, goes
// through decideBrowserNavigation again (Tab.restoreHistory filters the list).
import { screen } from 'electron'
import type { GroupState, TabState } from '../../shared/types'
import { registerTabMenuHandlers } from '../commands/tab-menus'
import { logger } from '../logger'
import { decideBrowserNavigation } from '../security/navigation-guards'
import { SESSION_HISTORY_MAX } from '../../shared/ipc-contract'
import type { SessionWindowRecord } from '../storage/session-store'
import type { ProfileContext, ProfileManager, WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'
import { normalizeGroups, pickVisibleTab, registerGroupHandlers } from './groups'
import { browserTabs, onTabStructureChanged, withTabSeed } from './tab-manager'

const SAVE_DEBOUNCE_MS = 300
export const MAX_RESTORE_WINDOWS = 20
export const MAX_RESTORE_TABS = 200
const MIN_WIN = { width: 400, height: 300 }
const MAX_URL = 8192

// ---- Pure mapping (unit tested) ----

type SessionHistory = { entries: Array<{ url: string; title: string }>; index: number }
type SerializableTab = Pick<TabState, 'id' | 'url' | 'title' | 'pinned' | 'groupId' | 'muted'> & { history?: SessionHistory }

/** A saved back/forward list made consistent: capped, index in range, active entry = the tab's address. */
function cleanHistory(h: SessionHistory | undefined, url: string): SessionHistory | undefined {
  if (!h) return undefined
  const entries = h.entries.filter((e) => e.url !== '' && e.url.length <= MAX_URL).map((e) => ({ url: e.url, title: e.title.slice(0, 1024) }))
  if (entries.length < 2 || entries.length !== h.entries.length) return undefined
  const index = Math.min(Math.max(0, h.index), entries.length - 1)
  if (entries[index]!.url !== url) return undefined
  const start = entries.length > SESSION_HISTORY_MAX ? Math.min(Math.max(0, index - (SESSION_HISTORY_MAX >> 1)), entries.length - SESSION_HISTORY_MAX) : 0
  return { entries: entries.slice(start, start + SESSION_HISTORY_MAX), index: index - start }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A window's tabs, groups and bounds as the session record. Null if there is nothing worth saving. */
export function serializeWindow(input: {
  tabs: readonly SerializableTab[]
  groups: readonly GroupState[]
  activeTabId: number | null
  bounds: Rect | null
}): SessionWindowRecord | null {
  const kept = input.tabs.filter((t) => t.url !== '' && t.url.length <= MAX_URL)
  if (kept.length === 0) return null
  const known = new Set(input.groups.map((g) => g.id))
  const tabs = kept.map((t) => ({
    url: t.url,
    title: t.title.slice(0, 1024),
    pinned: t.pinned,
    groupId: !t.pinned && t.groupId !== null && known.has(t.groupId) ? t.groupId : null,
    ...(t.muted ? { muted: true } : {}),
    ...withHistory(cleanHistory(t.history, t.url))
  }))
  const used = new Set(tabs.map((t) => t.groupId).filter((g): g is string => g !== null))
  const active = kept.findIndex((t) => t.id === input.activeTabId)
  return {
    tabs,
    groups: input.groups.filter((g) => used.has(g.id)).map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })),
    activeIndex: Math.max(active, 0),
    bounds: input.bounds ? { x: input.bounds.x, y: input.bounds.y, width: input.bounds.width, height: input.bounds.height } : null
  }
}

function withHistory(h: SessionHistory | undefined): { history?: SessionHistory } {
  return h ? { history: h } : {}
}

export interface RestorePlan {
  tabs: Array<{ url: string; pinned: boolean; groupId: string | null; muted: boolean; history?: SessionHistory }>
  groups: GroupState[]
  activeIndex: number
}

/**
 * Turn a saved window into what to create: drops tabs whose address is no longer allowed, repairs group
 * references (pinned tabs and unknown ids lose their group; empty groups vanish), puts pinned tabs first,
 * keeps the active tab visible (a collapsed group around it moves focus out, or opens if nothing else can).
 */
export function planRestore(
  rec: SessionWindowRecord,
  isRestorable: (url: string) => boolean,
  maxTabs: number = MAX_RESTORE_TABS
): RestorePlan {
  const groupIds = new Set(rec.groups.map((g) => g.id))
  const entries = rec.tabs
    .map((t, orig) => ({ t, orig }))
    .filter(({ t }) => t.url !== '' && isRestorable(t.url))
    .slice(0, maxTabs)
    .map(({ t, orig }) => ({
      orig,
      url: t.url,
      pinned: t.pinned,
      groupId: !t.pinned && t.groupId !== null && groupIds.has(t.groupId) ? t.groupId : null,
      muted: t.muted === true,
      history: cleanHistory(t.history, t.url)
    }))
  // Stable: pinned first, saved order otherwise.
  const ordered = [...entries.filter((e) => e.pinned), ...entries.filter((e) => !e.pinned)]
  const used = new Set(ordered.map((e) => e.groupId).filter((g): g is string => g !== null))
  const groups = rec.groups.filter((g) => used.has(g.id)).map((g) => ({ ...g }))

  let active = 0
  if (ordered.length > 0) {
    const exact = ordered.findIndex((e) => e.orig === rec.activeIndex)
    if (exact >= 0) active = exact
    else {
      // The saved active tab is gone: the nearest survivor by saved position.
      let best = Infinity
      ordered.forEach((e, i) => {
        const d = Math.abs(e.orig - rec.activeIndex)
        if (d < best) {
          best = d
          active = i
        }
      })
    }
    const activeGroup = ordered[active]!.groupId
    const g = groups.find((x) => x.id === activeGroup)
    if (g?.collapsed) {
      const collapsed = new Set(groups.filter((x) => x.collapsed).map((x) => x.id))
      const strip = ordered.map((e, i) => ({ id: i, groupId: e.groupId }))
      const to = pickVisibleTab(strip, collapsed, active)
      if (to !== null) active = to
      else g.collapsed = false
    }
  }
  return {
    tabs: ordered.map(({ url, pinned, groupId, muted, history }) => ({ url, pinned, groupId, muted, ...withHistory(history) })),
    groups,
    activeIndex: active
  }
}

/**
 * Saved window bounds made safe for the current displays: at least a minimum size, never larger than the
 * biggest work area, and on screen (a monitor that is gone drops the position so the OS places the window).
 */
export function sanitizeBounds(b: Rect | null, workAreas: readonly Rect[]): Partial<Rect> | undefined {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return undefined
  const maxW = Math.max(MIN_WIN.width, ...workAreas.map((a) => a.width))
  const maxH = Math.max(MIN_WIN.height, ...workAreas.map((a) => a.height))
  const width = Math.min(Math.max(Math.round(b.width), MIN_WIN.width), maxW)
  const height = Math.min(Math.max(Math.round(b.height), MIN_WIN.height), maxH)
  const visible = workAreas.some((a) => {
    const w = Math.min(b.x + width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + height, a.y + a.height) - Math.max(b.y, a.y)
    return w >= 100 && h >= 50
  })
  return visible ? { x: Math.round(b.x), y: Math.round(b.y), width, height } : { width, height }
}

// ---- Saving ----

let installed = false
let frozen = false
let restoring = false
let saveTimer: NodeJS.Timeout | null = null
let profileSource: ProfileManager | null = null
const known = new Map<string, ProfileContext>()
const lastSaved = new Map<string, string>()

function isRegular(w: WindowContext): boolean {
  return !w.popup && !w.incognito && !w.profile.incognito
}

function windowRecord(w: WindowContext): SessionWindowRecord | null {
  // sessionView, not the shell snapshot: it has the address a just-opened tab is still loading (so a window
  // opened right before quit is saved), back/forward lists, and the tabs as they were if a window close is
  // in progress.
  const view = browserTabs(w).sessionView()
  return serializeWindow({
    tabs: view.tabs,
    groups: view.groups,
    activeTabId: view.activeTabId,
    bounds: w.win.isDestroyed() ? null : w.win.getNormalBounds()
  })
}

function profileStillExists(id: string): boolean {
  try {
    return profileSource?.list().some((p) => p.id === id) ?? false
  } catch {
    return false
  }
}

/** Write every known profile's session. Safe to call any time; does nothing once the app is quitting. */
export function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (frozen || restoring) return
  const byProfile = new Map<string, SessionWindowRecord[]>()
  for (const w of windowManager.all()) {
    if (!isRegular(w) || w.win.isDestroyed()) continue
    known.set(w.profile.id, w.profile)
    try {
      const rec = windowRecord(w)
      if (rec) byProfile.set(w.profile.id, [...(byProfile.get(w.profile.id) ?? []), rec])
    } catch (err) {
      logger.warn('session: could not serialize a window', err)
    }
  }
  const anyWindow = windowManager.all().length > 0
  for (const [id, ctx] of known) {
    if (!profileStillExists(id)) {
      known.delete(id)
      lastSaved.delete(id)
      continue
    }
    const windows = byProfile.get(id) ?? []
    // Last window gone and nothing else open: this is the app exiting (or macOS idling); keep what was saved.
    if (windows.length === 0 && !anyWindow) continue
    const key = JSON.stringify(windows)
    if (lastSaved.get(id) === key) continue
    try {
      ctx.stores.session.save(windows)
      lastSaved.set(id, key)
    } catch (err) {
      logger.warn(`session: save failed for profile ${id}`, err)
    }
  }
}

function scheduleSave(): void {
  if (frozen || restoring || saveTimer) return
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** Windows with group housekeeping queued for the end of the current synchronous tab operation. */
const housekeepingQueued = new WeakSet<WindowContext>()

function onStructureChanged(w: WindowContext): void {
  // Group housekeeping runs after the current (synchronous) tab operation has finished, so a group that is
  // momentarily empty in the middle of createGroupFromTab or a restore is not pruned.
  if (!housekeepingQueued.has(w)) {
    housekeepingQueued.add(w)
    queueMicrotask(() => {
      housekeepingQueued.delete(w)
      if (w.win.isDestroyed()) return
      try {
        normalizeGroups(browserTabs(w))
      } catch (err) {
        logger.warn('group housekeeping failed', err)
      }
    })
  }
  if (isRegular(w)) scheduleSave()
}

function hookWindow(w: WindowContext): void {
  // Flush a pending save while the closing window's tabs are still there.
  w.win.on('close', () => {
    if (saveTimer && isRegular(w)) saveNow()
  })
}

/**
 * Quit, step 1 (index.ts, before flushing the stores): write the final session of every profile and freeze it,
 * so the windows closing during shutdown don't overwrite it. Idempotent.
 */
export function prepareQuit(): void {
  if (frozen) return
  try {
    saveNow()
  } catch (err) {
    logger.warn('session: final save failed', err)
  }
  frozen = true
}

/**
 * Register the tab-group and tab-menu IPC handlers and start saving sessions. Call once at ready, after
 * `router.install()` and the profile manager exist, before `restoreOnLaunch`.
 */
export function installTabFeatures(profiles: ProfileManager): void {
  if (installed) return
  installed = true
  profileSource = profiles
  registerGroupHandlers()
  registerTabMenuHandlers()

  for (const w of windowManager.all()) hookWindow(w)
  windowManager.onWindowCreated(hookWindow)
  onTabStructureChanged(onStructureChanged)
  windowManager.onWindowClosed((w) => {
    if (isRegular(w)) scheduleSave()
  })
}

// ---- Restoring ----

const restorable = (url: string): boolean => decideBrowserNavigation(url, { typed: url.startsWith('file:') }) === 'allow'

function restoreWindow(profile: ProfileContext, rec: SessionWindowRecord): WindowContext | null {
  const plan = planRestore(rec, restorable)
  if (plan.tabs.length === 0) return null
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  const { result: w } = withTabSeed({ empty: true }, () => windowManager.createWindow({ profile, bounds: sanitizeBounds(rec.bounds, areas) }))
  const tabs = browserTabs(w)
  for (const g of plan.groups) tabs.upsertGroup(g)
  const created = plan.tabs.map((t) =>
    tabs.create({
      url: t.url,
      typed: t.url.startsWith('file:'),
      pinned: t.pinned,
      groupId: t.groupId,
      muted: t.muted,
      background: true,
      // Tab.restoreHistory runs each entry through decideBrowserNavigation and drops refused ones.
      ...(t.history ? { history: { entries: t.history.entries, index: t.history.index } } : {})
    })
  )
  const target = created[plan.activeIndex] ?? created.find((t) => t !== null) ?? null
  if (target) tabs.activate(target.id)
  else tabs.create({})
  return w
}

/**
 * Reopen the windows saved last time, for each profile whose startup setting is "restore". The most recently
 * used profile goes last so its windows end up focused. Returns true if at least one window was opened;
 * otherwise the caller opens the normal first window.
 */
export function restoreOnLaunch(profiles: ProfileManager): boolean {
  const lastUsedId = profiles.lastUsed().id
  const ids = profiles.list().map((p) => p.id)
  ids.sort((a, b) => Number(a === lastUsedId) - Number(b === lastUsedId))
  restoring = true
  let opened = 0
  try {
    for (const id of ids) {
      try {
        const ctx = profiles.get(id)
        if (!ctx || ctx.getSettings().startup !== 'restore') continue
        const records = ctx.stores.session.load().slice(0, MAX_RESTORE_WINDOWS)
        for (const rec of records) {
          try {
            if (restoreWindow(ctx, rec)) {
              opened++
              known.set(ctx.id, ctx)
            }
          } catch (err) {
            logger.warn(`session: could not restore a window of profile ${id}`, err)
          }
        }
      } catch (err) {
        logger.warn(`session: could not restore profile ${id}`, err)
      }
    }
  } finally {
    restoring = false
  }
  if (opened > 0) logger.info(`session: restored ${opened} window(s)`)
  scheduleSave()
  return opened > 0
}
