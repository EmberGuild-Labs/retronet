// Tab group logic (PLAN T15). T12's tab manager stores groups as plain data; the rules live here:
// create from a tab, name and color, add and remove tabs (members stay contiguous in the strip), collapse
// (hides members; an active tab inside moves focus out first), ungroup, close group, and the housekeeping that
// drops empty groups and un-collapses a group whose tab became active. Pinned tabs are never grouped.
// The pure helpers at the top have no Electron dependency and are unit tested.
import { randomBytes } from 'node:crypto'
import { NEWTAB_URL } from '../../shared/settings'
import type { GroupColor, GroupState } from '../../shared/types'
import { IpcFailure, router, type CallContext } from '../ipc/router'
import { browserTabs, type BrowserTabManager } from './tab-manager'
import { windowManager } from '../windows/window-manager'
import type { WindowContext } from '../types'

// ---- Pure helpers ----

/** Strip entry as far as the group rules care. */
export interface StripTab {
  id: number
  groupId: string | null
  pinned?: boolean
}

/** Colors handed out to new groups, in order; grey last so a fresh group is never "no color". */
const COLOR_CYCLE: readonly GroupColor[] = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey']

export function nextGroupColor(used: readonly GroupColor[]): GroupColor {
  const free = COLOR_CYCLE.find((c) => !used.includes(c))
  return free ?? COLOR_CYCLE[used.length % COLOR_CYCLE.length]!
}

export function newGroupId(taken: ReadonlySet<string>, random: () => string = () => randomBytes(5).toString('hex')): string {
  for (;;) {
    const id = `g-${random()}`
    if (!taken.has(id)) return id
  }
}

/**
 * Strip index a tab should be moved to so it sits right after the last member of `groupId`, or null when it
 * is already in place (or the group has no other members).
 */
export function planJoinMove(strip: readonly StripTab[], tabId: number, groupId: string): number | null {
  const at = strip.findIndex((t) => t.id === tabId)
  if (at < 0) return null
  const rest = strip.filter((t) => t.id !== tabId)
  let last = -1
  rest.forEach((t, i) => {
    if (t.groupId === groupId) last = i
  })
  if (last < 0) return null
  const target = last + 1
  // Already directly after the last member (same index in the final order).
  return target === at ? null : target
}

/**
 * Where a tab leaving group `groupId` goes. A tab at either edge of its group is already outside the
 * member run once it is ungrouped; one in the middle moves to just after the run. Null = stay.
 */
export function planLeaveMove(strip: readonly StripTab[], tabId: number, groupId: string): number | null {
  const at = strip.findIndex((t) => t.id === tabId)
  if (at < 0) return null
  let min = Infinity
  let max = -Infinity
  strip.forEach((t, i) => {
    if (t.id !== tabId && t.groupId === groupId) {
      min = Math.min(min, i)
      max = Math.max(max, i)
    }
  })
  if (max < 0 || at < min || at > max) return null
  return max
}

/**
 * Tab to activate when `fromId` is about to be hidden: the nearest tab to the right, then to the left, that is
 * ungrouped or in a group that is not collapsed (and is not `fromId`'s own group). Null if every tab is hidden.
 */
export function pickVisibleTab(strip: readonly StripTab[], collapsed: ReadonlySet<string>, fromId: number): number | null {
  const at = strip.findIndex((t) => t.id === fromId)
  if (at < 0) return null
  const shown = (t: StripTab): boolean => t.groupId === null || !collapsed.has(t.groupId)
  for (let i = at + 1; i < strip.length; i++) if (shown(strip[i]!)) return strip[i]!.id
  for (let i = at - 1; i >= 0; i--) if (shown(strip[i]!)) return strip[i]!.id
  return null
}

/** Groups that no tab belongs to. */
export function emptyGroupIds(groups: readonly GroupState[], strip: readonly StripTab[]): string[] {
  const used = new Set(strip.map((t) => t.groupId).filter((g): g is string => g !== null))
  return groups.filter((g) => !used.has(g.id)).map((g) => g.id)
}

// ---- Operations on a window's tab manager ----

function stripOf(tabs: BrowserTabManager): StripTab[] {
  return tabs.list().map((t) => ({ id: t.id, groupId: t.groupId, pinned: t.pinned }))
}

function memberIds(tabs: BrowserTabManager, groupId: string): number[] {
  return tabs.list().filter((t) => t.groupId === groupId).map((t) => t.id)
}

/** Make a group out of one tab. Returns the new group id, or null if the tab doesn't exist or is pinned. */
export function createGroupFromTab(tabs: BrowserTabManager, tabId: number, opts: { name?: string; color?: GroupColor } = {}): string | null {
  const tab = tabs.get(tabId)
  if (!tab || tab.pinned) return null
  const existing = tabs.groups()
  const id = newGroupId(new Set(existing.map((g) => g.id)))
  tabs.upsertGroup({ id, name: opts.name ?? '', color: opts.color ?? nextGroupColor(existing.map((g) => g.color)), collapsed: false })
  const previous = tab.groupId
  if (!tabs.setTabGroup(tabId, id)) {
    tabs.removeGroup(id)
    return null
  }
  if (previous && previous !== id) pruneEmptyGroups(tabs)
  return id
}

export function updateGroup(tabs: BrowserTabManager, groupId: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }): boolean {
  const g = tabs.getGroup(groupId)
  if (!g) return false
  const next: GroupState = {
    ...g,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {})
  }
  if (patch.collapsed === true && !g.collapsed) {
    // Move focus out before the active tab disappears from the strip.
    const active = tabs.active()
    if (active && active.groupId === groupId) {
      const collapsed = new Set(tabs.groups().filter((x) => x.collapsed).map((x) => x.id))
      collapsed.add(groupId)
      const to = pickVisibleTab(stripOf(tabs), collapsed, active.id)
      if (to !== null) tabs.activate(to)
      else {
        // Every tab is in collapsed groups: open a fresh tab to land on (major browsers do the same).
        const fresh = tabs.create({ url: NEWTAB_URL })
        if (!fresh) return false
      }
    }
    next.collapsed = true
  } else if (patch.collapsed === false) {
    next.collapsed = false
  }
  tabs.upsertGroup(next)
  return true
}

/** Move a tab into a group (next to its other members). False for unknown tab/group or a pinned tab. */
export function addTabToGroup(tabs: BrowserTabManager, groupId: string, tabId: number): boolean {
  const tab = tabs.get(tabId)
  if (!tab || tab.pinned || !tabs.getGroup(groupId)) return false
  const previous = tab.groupId
  if (previous === groupId) return true
  if (!tabs.setTabGroup(tabId, groupId)) return false
  const to = planJoinMove(stripOf(tabs), tabId, groupId)
  if (to !== null) tabs.move(tabId, to)
  if (previous) pruneEmptyGroups(tabs)
  // A tab joining a collapsed group would vanish from under the user.
  if (tabs.getGroup(groupId)?.collapsed && tabs.active()?.id === tabId) expandGroup(tabs, groupId)
  return true
}

export function removeTabFromGroup(tabs: BrowserTabManager, tabId: number): boolean {
  const tab = tabs.get(tabId)
  if (!tab) return false
  const groupId = tab.groupId
  if (!groupId) return true
  const to = planLeaveMove(stripOf(tabs), tabId, groupId)
  tabs.setTabGroup(tabId, null)
  if (to !== null) tabs.move(tabId, to)
  pruneEmptyGroups(tabs)
  return true
}

/** Dissolve a group; its tabs stay open and ungrouped. */
export function ungroup(tabs: BrowserTabManager, groupId: string): boolean {
  if (!tabs.getGroup(groupId)) return false
  tabs.removeGroup(groupId)
  return true
}

/**
 * Close every tab of a group (each lands on the closed stack with its group, so Reopen brings it back). The
 * group itself is not removed here (R9): members close asynchronously after their beforeunload, and a "Stay"
 * keeps that tab in its group. The housekeeping (normalizeGroups) drops the group once its last member is gone.
 */
export function closeGroup(tabs: BrowserTabManager, groupId: string): boolean {
  if (!tabs.getGroup(groupId)) return false
  const ids = memberIds(tabs, groupId)
  if (ids.length === 0) {
    tabs.removeGroup(groupId)
    return true
  }
  // Leave the active tab for last so focus doesn't hop through members.
  const activeId = tabs.active()?.id
  for (const id of ids.filter((i) => i !== activeId)) tabs.close(id)
  if (activeId !== undefined && ids.includes(activeId)) tabs.close(activeId)
  return true
}

function expandGroup(tabs: BrowserTabManager, groupId: string): void {
  const g = tabs.getGroup(groupId)
  if (g?.collapsed) tabs.upsertGroup({ ...g, collapsed: false })
}

export function pruneEmptyGroups(tabs: BrowserTabManager): void {
  for (const id of emptyGroupIds(tabs.groups(), stripOf(tabs))) tabs.removeGroup(id)
}

/**
 * Keep the group data consistent after any tab change: drop empty groups, and open a collapsed group whose
 * tab became the active one (switching to a hidden tab by shortcut, or reopening one). Cheap; safe to repeat.
 */
export function normalizeGroups(tabs: BrowserTabManager): void {
  pruneEmptyGroups(tabs)
  const active = tabs.active()
  if (active?.groupId) expandGroup(tabs, active.groupId)
}

// ---- IPC: groups.* (shell and overlay) ----

function windowOf(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

function requireGroup(tabs: BrowserTabManager, groupId: string): void {
  if (!tabs.getGroup(groupId)) throw new IpcFailure('E_NOT_FOUND', 'No such group')
}

/** Open the overlay group editor for a group, anchored at a rect (chip click or menu position). */
export function showGroupEditor(w: WindowContext, groupId: string, anchor: { x: number; y: number; width: number; height: number } | null): boolean {
  if (!browserTabs(w).getGroup(groupId)) return false
  w.showOverlay({ kind: 'group-editor', groupId, anchor }, { focus: true })
  return true
}

export function registerGroupHandlers(): void {
  router.handle('groups.create', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    const tab = tabs.get(req.tabId)
    if (!tab) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
    if (tab.pinned) throw new IpcFailure('E_INVALID', 'Pinned tabs cannot be grouped')
    const groupId = createGroupFromTab(tabs, req.tabId, { name: req.name, color: req.color })
    if (!groupId) throw new IpcFailure('E_INTERNAL', 'Could not create the group')
    return { groupId }
  })

  router.handle('groups.update', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    requireGroup(tabs, req.groupId)
    if (!updateGroup(tabs, req.groupId, req)) throw new IpcFailure('E_INTERNAL', 'Could not update the group')
    return null
  })

  router.handle('groups.addTab', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    requireGroup(tabs, req.groupId)
    const tab = tabs.get(req.tabId)
    if (!tab) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
    if (tab.pinned) throw new IpcFailure('E_INVALID', 'Pinned tabs cannot be grouped')
    addTabToGroup(tabs, req.groupId, req.tabId)
    return null
  })

  router.handle('groups.removeTab', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    if (!tabs.get(req.tabId)) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
    removeTabFromGroup(tabs, req.tabId)
    return null
  })

  router.handle('groups.ungroup', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    requireGroup(tabs, req.groupId)
    ungroup(tabs, req.groupId)
    return null
  })

  router.handle('groups.close', (req, ctx) => {
    const tabs = browserTabs(windowOf(ctx))
    requireGroup(tabs, req.groupId)
    closeGroup(tabs, req.groupId)
    return null
  })

  router.handle('groups.edit', (req, ctx) => {
    if (!showGroupEditor(windowOf(ctx), req.groupId, req.anchor)) throw new IpcFailure('E_NOT_FOUND', 'No such group')
    return null
  })
}
