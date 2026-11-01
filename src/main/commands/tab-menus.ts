// Context menus for tabs and tab groups (PLAN T15): `tabs.contextMenu` and `groups.contextMenu`. Themed menus
// (PLAN-FINAL A6) shown through menu-host at the click position the shell reports (window content coordinates; the
// shell fills the window), or below the tab/chip rect when opened from the keyboard. Both calls resolve on close.
import { GROUP_COLORS, type GroupState } from '../../shared/types'
import { IpcFailure, router, type CallContext } from '../ipc/router'
import type { MenuAnchor } from '../../shared/menu-model'
import { showMenu, type MenuEntry } from '../menus/menu-host'
import {
  addTabToGroup,
  closeGroup,
  createGroupFromTab,
  removeTabFromGroup,
  showGroupEditor,
  ungroup,
  updateGroup
} from '../tabs/groups'
import { browserTabs, type BrowserTabManager } from '../tabs/tab-manager'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Menu label for a group: its name, or "<Color> group" when unnamed. */
export function groupMenuLabel(g: Pick<GroupState, 'name' | 'color'>): string {
  return g.name.trim() !== '' ? g.name : `${capitalize(g.color)} group`
}

function windowOf(ctx: CallContext): WindowContext {
  const w = windowManager.get(ctx.info.windowId)
  if (!w) throw new IpcFailure('E_NOT_FOUND', 'Window is gone')
  return w
}

/** Menu item ids must match MENU_ITEM_ID_RE; group ids are main-generated but not guaranteed to. */
const idPart = (s: string): string => s.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 60)

export function buildTabMenu(tabs: BrowserTabManager, tabId: number): MenuEntry[] {
  const tab = tabs.get(tabId)
  if (!tab) return []
  const list = tabs.list()
  const at = list.findIndex((t) => t.id === tabId)
  const state = tab.state()
  const groups = tabs.groups()
  const otherGroups = groups.filter((g) => g.id !== tab.groupId)

  const groupItems: MenuEntry[] = tab.pinned
    ? []
    : [
        { id: 'tab.group-new', label: 'Add Tab to New Group', run: () => void createGroupFromTab(tabs, tabId) },
        ...(otherGroups.length > 0
          ? [
              {
                id: 'tab.group-add',
                label: 'Add Tab to Group',
                submenu: otherGroups.map((g) => ({ id: `tab.group:${idPart(g.id)}`, label: groupMenuLabel(g), run: () => void addTabToGroup(tabs, g.id, tabId) }))
              } satisfies MenuEntry
            ]
          : []),
        ...(tab.groupId ? [{ id: 'tab.group-remove', label: 'Remove from Group', run: () => void removeTabFromGroup(tabs, tabId) }] : []),
        { kind: 'separator' }
      ]

  return [
    { id: 'tab.new-right', label: 'New Tab to the Right', run: () => void tabs.create({ index: at + 1, groupId: tab.groupId }) },
    { kind: 'separator' },
    { id: 'tab.reload', label: 'Reload', run: () => void tabs.reload(tabId) },
    {
      id: 'tab.duplicate',
      label: 'Duplicate',
      run: () => {
        const rec = tab.closedRecord()
        void tabs.create({
          url: rec.url,
          index: at + 1,
          groupId: tab.groupId,
          pinned: tab.pinned,
          muted: rec.muted,
          history: rec.entries.length > 0 ? { entries: rec.entries, index: rec.index } : undefined
        })
      }
    },
    { id: 'tab.pin', label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', run: () => void tabs.pin(tabId, !tab.pinned) },
    { id: 'tab.mute', label: state.muted ? 'Unmute Site' : 'Mute Site', run: () => void tabs.toggleMute(tabId) },
    { kind: 'separator' },
    ...groupItems,
    { id: 'tab.close', label: 'Close Tab', run: () => void tabs.close(tabId) },
    {
      id: 'tab.close-others',
      label: 'Close Other Tabs',
      enabled: list.some((t) => t.id !== tabId && !t.pinned),
      run: () => {
        for (const t of [...tabs.list()]) if (t.id !== tabId && !t.pinned) tabs.close(t.id)
      }
    },
    {
      id: 'tab.close-right',
      label: 'Close Tabs to the Right',
      enabled: list.slice(at + 1).some((t) => !t.pinned),
      run: () => {
        const ids = tabs.list().slice(at + 1).filter((t) => !t.pinned).map((t) => t.id)
        for (const id of ids) tabs.close(id)
      }
    },
    { kind: 'separator' },
    { id: 'tab.reopen', label: 'Reopen Closed Tab', enabled: tabs.closedTabs().length > 0, run: () => void tabs.reopenClosed() }
  ]
}

export function buildGroupMenu(w: WindowContext, groupId: string, at: { x: number; y: number }): MenuEntry[] {
  const tabs = browserTabs(w)
  const g = tabs.getGroup(groupId)
  if (!g) return []
  return [
    // The editor is anchored where the menu opened (the chip's own rect isn't part of this call).
    { id: 'group.edit', label: 'Edit Group...', run: () => void showGroupEditor(w, groupId, { x: at.x, y: at.y, width: 1, height: 1 }) },
    {
      id: 'group.new-tab',
      label: 'New Tab in Group',
      run: () => {
        const members = tabs.list().filter((t) => t.groupId === groupId)
        const last = members[members.length - 1]
        const index = last ? tabs.list().indexOf(last) + 1 : undefined
        void tabs.create({ groupId, index })
      }
    },
    { id: 'group.collapse', label: g.collapsed ? 'Expand Group' : 'Collapse Group', run: () => void updateGroup(tabs, groupId, { collapsed: !g.collapsed }) },
    {
      id: 'group.color',
      label: 'Color',
      submenu: GROUP_COLORS.map((c) => ({
        id: `group.color:${c}`,
        label: capitalize(c),
        check: 'radio' as const,
        checked: g.color === c,
        run: () => void updateGroup(tabs, groupId, { color: c })
      }))
    },
    { kind: 'separator' },
    { id: 'group.ungroup', label: 'Ungroup', run: () => void ungroup(tabs, groupId) },
    { id: 'group.close', label: 'Close Group', run: () => void closeGroup(tabs, groupId) }
  ]
}

interface MenuTriggerReq {
  x: number
  y: number
  anchor?: MenuAnchor
  keyboard?: boolean
}

/** Pointer: a point at the click. Keyboard: below the trigger's rect when the shell sent one. */
function placementOf(req: MenuTriggerReq): { anchor: MenuAnchor; placement: 'point' | 'below' } {
  if (req.keyboard && req.anchor) return { anchor: req.anchor, placement: 'below' }
  return { anchor: { x: req.x, y: req.y, width: 0, height: 0 }, placement: 'point' }
}

export function registerTabMenuHandlers(): void {
  router.handle('tabs.contextMenu', async (req, ctx) => {
    const w = windowOf(ctx)
    const tabs = browserTabs(w)
    const entries = buildTabMenu(tabs, req.tabId)
    if (entries.length === 0) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
    await showMenu(w, {
      kind: 'tab',
      label: 'Tab',
      entries,
      ...placementOf(req),
      keyboard: req.keyboard,
      isValid: () => !!tabs.get(req.tabId)
    })
    return null
  })

  router.handle('groups.contextMenu', async (req, ctx) => {
    const w = windowOf(ctx)
    const tabs = browserTabs(w)
    const placed = placementOf(req)
    const rect = req.keyboard && req.anchor ? req.anchor : { x: req.x, y: req.y, width: 1, height: 1 }
    const entries = buildGroupMenu(w, req.groupId, { x: rect.x, y: rect.y })
    if (entries.length === 0) throw new IpcFailure('E_NOT_FOUND', 'No such group')
    await showMenu(w, {
      kind: 'group',
      label: 'Tab group',
      entries,
      ...placed,
      keyboard: req.keyboard,
      isValid: () => !!tabs.getGroup(req.groupId)
    })
    return null
  })
}
