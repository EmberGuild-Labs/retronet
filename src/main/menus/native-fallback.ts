// Native fallback for themed menus (PLAN-FINAL 1.2, D-A3). Used only when the overlay is busy with a prompt that a
// themed menu would replace (dialog, sign-in, permission, group editor), or for the overlay's own text fields. The
// same MenuEntry[] the themed path uses becomes a native template; picks go back through menu-host's runner.
// After A5/A6 this is the only file in src/main that pops up a native menu (grep test).
import { Menu, type BrowserWindow, type KeyboardEvent, type MenuItemConstructorOptions } from 'electron'
import type { MenuEntry, MenuItemEntry, MenuPick } from './menu-host'

/** Modifier state of a native menu click (no middle button in native menus). */
export function nativePick(e: KeyboardEvent | undefined): MenuPick {
  return { mods: { meta: !!e?.metaKey, ctrl: !!e?.ctrlKey, shift: !!e?.shiftKey, alt: !!e?.altKey }, button: 0 }
}

/**
 * The native template for `entries`. Enabled leaf items call `onPick`; submenu parents and disabled items never do.
 * '&' is a mnemonic marker in Windows native menus, so it is doubled there (and only here).
 */
export function toNativeTemplate(
  entries: readonly MenuEntry[],
  onPick: (entry: MenuItemEntry, pick: MenuPick) => void,
  platform: string = process.platform
): MenuItemConstructorOptions[] {
  return entries.map((e): MenuItemConstructorOptions => {
    if (e.kind === 'separator') return { type: 'separator' }
    const enabled = e.enabled !== false
    const label = platform === 'win32' ? e.label.replace(/&/g, '&&') : e.label
    const item: MenuItemConstructorOptions = { id: e.id, label, enabled }
    if (e.accel) {
      item.accelerator = e.accel
      item.registerAccelerator = false
    }
    if (e.check) {
      item.type = e.check === 'radio' ? 'radio' : 'checkbox'
      item.checked = !!e.checked
    }
    if (e.submenu) item.submenu = toNativeTemplate(e.submenu, onPick, platform)
    else if (enabled) item.click = (_mi, _win, ev) => onPick(e, nativePick(ev))
    return item
  })
}

/** Pop the template up at window-content coordinates; resolves when the menu closes. */
export function popupNative(win: BrowserWindow, template: MenuItemConstructorOptions[], at: { x: number; y: number }): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || template.length === 0) return resolve()
    Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(at.x), y: Math.round(at.y), callback: () => resolve() })
  })
}
