// The macOS application menu (PLAN 1.3, AC21), built from the command registry so labels and accelerators
// can't drift from the palette and the shortcuts page. Edit uses the standard roles, so copy/paste/undo work in
// pages, the omnibox and the overlay. Secondary accelerators (Cmd+Plus, Ctrl+Tab, ...) are hidden items that
// still fire. Windows/Linux get no menu bar (the frame is custom); shortcuts.ts handles every chord there.
//
// `buildMenuTemplate` is pure (no Electron runtime), so the unit test can check that every command with an
// accelerator is present exactly once with no duplicate chords.
import type { MenuItemConstructorOptions } from 'electron'
import {
  getCommand,
  type CommandId,
  type Platform
} from '../../shared/commands'
import { SKINS, type SkinId } from '../../shared/skins'
import { displayUrl, isWebViewSource } from '../../shared/url-safety'

/**
 * AC54: the one place that turns a page URL into its view-source target (null = not viewable: only http(s)
 * pages qualify). Dispatch and the context menu both go through this, so switching the target (native
 * `view-source:` vs an internal source page) is a change to this function alone.
 */
export function viewSourceUrlFor(url: string): string | null {
  const target = `view-source:${url}`
  // One rule for "viewable" (isWebViewSource), and the inner userinfo never reaches the tab URL (AC73).
  return isWebViewSource(target) ? displayUrl(target) : null
}

export interface MenuModel {
  platform: Platform
  appName: string
  skin: SkinId
  profiles: ReadonlyArray<{ id: string; name: string }>
  /** Profile of the focused window (radio check), or null. */
  currentProfileId: string | null
  bookmarkBar: boolean
  /** Unpackaged builds only: items to inspect the shell and overlay. */
  devUi: boolean
  /** URL of the focused window's active tab (drives "View Page Source"); omitted = unknown, item stays enabled. */
  activeUrl?: string
}

export interface MenuActions {
  run(id: CommandId, arg?: string): void
  inspectUi?(which: 'shell' | 'overlay'): void
}

/** Accelerators of the role items below (explicit, so duplicates against the registry are testable). */
export const ROLE_ACCELERATORS: Readonly<Record<string, string>> = {
  hide: 'Cmd+H',
  hideOthers: 'Cmd+Alt+H',
  undo: 'Cmd+Z',
  redo: 'Cmd+Shift+Z',
  cut: 'Cmd+X',
  copy: 'Cmd+C',
  paste: 'Cmd+V',
  pasteAndMatchStyle: 'Cmd+Alt+Shift+V',
  selectAll: 'Cmd+A',
  minimize: 'Cmd+M'
}

type Item = MenuItemConstructorOptions
const sep: Item = { type: 'separator' }

export function buildMenuTemplate(model: MenuModel, actions: MenuActions): Item[] {
  const p = model.platform

  /** A visible item for a command (primary accelerator) plus hidden items for its other accelerators. */
  const cmd = (id: CommandId, extra: Partial<Item> = {}): Item[] => {
    const def = getCommand(id)
    if (!def) throw new Error(`menu: unknown command ${id}`)
    const [primary, ...rest] = def.accelerator[p]
    const items: Item[] = [
      { id, label: def.title, ...(primary ? { accelerator: primary } : {}), click: () => actions.run(id), ...extra }
    ]
    rest.forEach((accelerator, i) => {
      items.push({
        id: `${id}#${i + 2}`,
        label: def.title,
        accelerator,
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: () => actions.run(id)
      })
    })
    return items
  }
  const role = (r: NonNullable<Item['role']>, label?: string): Item => ({
    role: r,
    ...(label ? { label } : {}),
    ...(ROLE_ACCELERATORS[r] ? { accelerator: ROLE_ACCELERATORS[r] } : {})
  })

  const skinItems: Item[] = SKINS.map((s) => ({
    id: `skin.switch:${s.id}`,
    label: s.name,
    type: 'radio',
    checked: s.id === model.skin,
    click: () => actions.run('skin.switch', s.id)
  }))

  const profileItems: Item[] = model.profiles.map((pr) => ({
    id: `profile.switch:${pr.id}`,
    label: pr.name,
    type: 'radio',
    checked: pr.id === model.currentProfileId,
    click: () => actions.run('profile.switch', pr.id)
  }))

  const tabJumps: Item[] = (['tab.select1', 'tab.select2', 'tab.select3', 'tab.select4', 'tab.select5', 'tab.select6', 'tab.select7', 'tab.select8', 'tab.selectLast'] as const).flatMap(
    (id) => cmd(id)
  )

  const developer: Item[] = [
    ...cmd('page.viewSource', model.activeUrl === undefined ? {} : { enabled: viewSourceUrlFor(model.activeUrl) !== null }),
    ...cmd('devtools.toggle')
  ]
  if (model.devUi && actions.inspectUi) {
    const inspect = actions.inspectUi
    developer.push(sep, { id: 'dev.inspectShell', label: 'Inspect browser UI', click: () => inspect('shell') })
    developer.push({ id: 'dev.inspectOverlay', label: 'Inspect overlay', click: () => inspect('overlay') })
  }

  const template: Item[] = [
    {
      label: model.appName,
      submenu: [
        ...cmd('page.about'),
        sep,
        ...cmd('page.settings'),
        sep,
        { role: 'services' },
        sep,
        role('hide'),
        role('hideOthers'),
        { role: 'unhide' },
        sep,
        ...cmd('app.quit')
      ]
    },
    {
      label: 'File',
      submenu: [
        ...cmd('tab.new'),
        ...cmd('window.new'),
        ...cmd('window.newIncognito'),
        ...cmd('tab.reopenClosed'),
        sep,
        ...cmd('omnibox.focus'),
        sep,
        ...cmd('tab.close'),
        ...cmd('window.close'),
        sep,
        ...cmd('file.print')
      ]
    },
    {
      label: 'Edit',
      submenu: [
        role('undo'),
        role('redo'),
        sep,
        role('cut'),
        role('copy'),
        role('paste'),
        role('pasteAndMatchStyle'),
        { role: 'delete' },
        role('selectAll'),
        sep,
        { label: 'Find', submenu: [...cmd('find.open'), ...cmd('find.next'), ...cmd('find.previous')] }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...cmd('bookmarkBar.toggle', { type: 'checkbox', checked: model.bookmarkBar }),
        sep,
        ...cmd('nav.stop'),
        ...cmd('nav.reload'),
        ...cmd('nav.hardReload'),
        sep,
        ...cmd('zoom.reset'),
        ...cmd('zoom.in'),
        ...cmd('zoom.out'),
        sep,
        ...cmd('view.toggleFullscreen'),
        sep,
        { id: 'skin.switch', label: 'Skin', submenu: skinItems },
        sep,
        { label: 'Developer', submenu: developer }
      ]
    },
    {
      label: 'History',
      submenu: [
        ...cmd('nav.back'),
        ...cmd('nav.forward'),
        ...cmd('nav.home'),
        sep,
        ...cmd('page.history'),
        ...cmd('data.clear')
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [...cmd('bookmark.toggle'), ...cmd('page.bookmarks')]
    },
    {
      label: 'Profiles',
      submenu: [...profileItems, ...(profileItems.length ? [sep] : []), ...cmd('profile.new')]
    },
    {
      label: 'Tab',
      submenu: [
        ...cmd('tab.next'),
        ...cmd('tab.previous'),
        sep,
        ...tabJumps,
        sep,
        ...cmd('tab.togglePin'),
        ...cmd('tab.toggleMute'),
        ...cmd('tab.addToNewGroup')
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [role('minimize'), { role: 'zoom' }, sep, ...cmd('page.downloads'), sep, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: [...cmd('palette.open'), ...cmd('page.shortcuts')]
    }
  ]
  return template
}

/** Every accelerator in a template (recursively), with the item id or role that owns it. */
export function templateAccelerators(items: readonly Item[]): Array<{ owner: string; accelerator: string }> {
  const out: Array<{ owner: string; accelerator: string }> = []
  const walk = (list: readonly Item[]): void => {
    for (const it of list) {
      if (it.accelerator) out.push({ owner: it.id ?? String(it.role ?? it.label), accelerator: String(it.accelerator) })
      if (Array.isArray(it.submenu)) walk(it.submenu as Item[])
    }
  }
  walk(items)
  return out
}
