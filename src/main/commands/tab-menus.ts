// Native context menus for tabs and tab groups (PLAN T15): `tabs.contextMenu` and `groups.contextMenu`.
// Both pop up at the click position the shell reports (window content coordinates).
import { Menu, type MenuItemConstructorOptions } from 'electron'
import { GROUP_COLORS, type GroupState } from '../../shared/types'
import { IpcFailure, router, type CallContext } from '../ipc/router'
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

function popup(w: WindowContext, template: MenuItemConstructorOptions[], x: number, y: number): void {
  if (w.win.isDestroyed()) return
  Menu.buildFromTemplate(template).popup({ window: w.win, x: Math.round(x), y: Math.round(y) })
}

export function buildTabMenu(tabs: BrowserTabManager, tabId: number): MenuItemConstructorOptions[] {
  const tab = tabs.get(tabId)
  if (!tab) return []
  const list = tabs.list()
  const at = list.findIndex((t) => t.id === tabId)
  const state = tab.state()
  const groups = tabs.groups()
  const otherGroups = groups.filter((g) => g.id !== tab.groupId)

  const groupItems: MenuItemConstructorOptions[] = tab.pinned
    ? []
    : [
        { label: 'Add Tab to New Group', click: () => void createGroupFromTab(tabs, tabId) },
        ...(otherGroups.length > 0
          ? [
              {
                label: 'Add Tab to Group',
                submenu: otherGroups.map((g) => ({ label: groupMenuLabel(g), click: () => void addTabToGroup(tabs, g.id, tabId) }))
              } satisfies MenuItemConstructorOptions
            ]
          : []),
        ...(tab.groupId ? [{ label: 'Remove from Group', click: () => void removeTabFromGroup(tabs, tabId) }] : []),
        { type: 'separator' }
      ]

  return [
    { label: 'New Tab to the Right', click: () => void tabs.create({ index: at + 1, groupId: tab.groupId }) },
    { type: 'separator' },
    { label: 'Reload', click: () => void tabs.reload(tabId) },
    {
      label: 'Duplicate',
      click: () => {
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
    { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => void tabs.pin(tabId, !tab.pinned) },
    { label: state.muted ? 'Unmute Site' : 'Mute Site', click: () => void tabs.toggleMute(tabId) },
    { type: 'separator' },
    ...groupItems,
    { label: 'Close Tab', click: () => void tabs.close(tabId) },
    {
      label: 'Close Other Tabs',
      enabled: list.some((t) => t.id !== tabId && !t.pinned),
      click: () => {
        for (const t of [...tabs.list()]) if (t.id !== tabId && !t.pinned) tabs.close(t.id)
      }
    },
    {
      label: 'Close Tabs to the Right',
      enabled: list.slice(at + 1).some((t) => !t.pinned),
      click: () => {
        const ids = tabs.list().slice(at + 1).filter((t) => !t.pinned).map((t) => t.id)
        for (const id of ids) tabs.close(id)
      }
    },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: tabs.closedTabs().length > 0, click: () => void tabs.reopenClosed() }
  ]
}

export function buildGroupMenu(w: WindowContext, groupId: string, at: { x: number; y: number }): MenuItemConstructorOptions[] {
  const tabs = browserTabs(w)
  const g = tabs.getGroup(groupId)
  if (!g) return []
  return [
    // The editor is anchored where the menu opened (the chip's own rect isn't part of this call).
    { label: 'Edit Group...', click: () => void showGroupEditor(w, groupId, { x: at.x, y: at.y, width: 1, height: 1 }) },
    {
      label: 'New Tab in Group',
      click: () => {
        const members = tabs.list().filter((t) => t.groupId === groupId)
        const last = members[members.length - 1]
        const index = last ? tabs.list().indexOf(last) + 1 : undefined
        void tabs.create({ groupId, index })
      }
    },
    { label: g.collapsed ? 'Expand Group' : 'Collapse Group', click: () => void updateGroup(tabs, groupId, { collapsed: !g.collapsed }) },
    {
      label: 'Color',
      submenu: GROUP_COLORS.map((c) => ({
        label: capitalize(c),
        type: 'radio' as const,
        checked: g.color === c,
        click: () => void updateGroup(tabs, groupId, { color: c })
      }))
    },
    { type: 'separator' },
    { label: 'Ungroup', click: () => void ungroup(tabs, groupId) },
    { label: 'Close Group', click: () => void closeGroup(tabs, groupId) }
  ]
}

export function registerTabMenuHandlers(): void {
  router.handle('tabs.contextMenu', (req, ctx) => {
    const w = windowOf(ctx)
    const template = buildTabMenu(browserTabs(w), req.tabId)
    if (template.length === 0) throw new IpcFailure('E_NOT_FOUND', 'No such tab')
    popup(w, template, req.x, req.y)
    return null
  })

  router.handle('groups.contextMenu', (req, ctx) => {
    const w = windowOf(ctx)
    const template = buildGroupMenu(w, req.groupId, { x: req.x, y: req.y })
    if (template.length === 0) throw new IpcFailure('E_NOT_FOUND', 'No such group')
    popup(w, template, req.x, req.y)
    return null
  })
}
