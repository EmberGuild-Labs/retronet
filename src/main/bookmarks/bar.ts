// Bookmark bar handlers (FIX-GAPS): `bookmarks.bar` (the Bar folder's children for the caller's profile) and
// `bookmarks.barFolderMenu` (native menu of a folder; folderId 'bar' is the bar's » overflow button).
import { Menu, type MenuItemConstructorOptions } from 'electron'
import { BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID } from '../../shared/types'
import type { BookmarkNode } from '../../shared/types'
import { profileOf, windowOf } from '../internal-api/misc'
import { IpcFailure, router } from '../ipc/router'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'

const MAX_ITEMS = 400
const MAX_DEPTH = 8
const LABEL_MAX = 60

export interface MenuClickEvent {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  button?: number
}

export function openDisposition(e: MenuClickEvent | undefined, platform: string = process.platform): 'current' | 'new-tab' | 'background-tab' {
  const mod = platform === 'darwin' ? !!e?.metaKey : !!e?.ctrlKey
  if (mod) return 'background-tab'
  return e?.shiftKey ? 'new-tab' : 'current'
}

function label(n: BookmarkNode, platform: string): string {
  const raw = n.title.replace(/\s+/g, ' ').trim() || (n.kind === 'bookmark' ? n.url : 'Untitled folder')
  const t = raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX - 1)}…` : raw
  return platform === 'win32' ? t.replace(/&/g, '&&') : t // '&' is a mnemonic marker on Windows
}

export function buildFolderTemplate(
  children: readonly BookmarkNode[],
  open: (url: string, e: MenuClickEvent | undefined) => void,
  platform: string = process.platform,
  depth = 0
): MenuItemConstructorOptions[] {
  if (children.length === 0) return [{ label: '(Empty)', enabled: false }]
  const out: MenuItemConstructorOptions[] = []
  for (const n of children.slice(0, MAX_ITEMS)) {
    if (n.kind === 'folder') {
      out.push({
        label: label(n, platform),
        submenu: depth + 1 >= MAX_DEPTH ? [{ label: '(Too deep)', enabled: false }] : buildFolderTemplate(n.children, open, platform, depth + 1)
      })
    } else {
      const url = n.url
      out.push({ label: label(n, platform), toolTip: url, click: (_item, _win, event) => open(url, event as MenuClickEvent | undefined) })
    }
  }
  return out
}

function openFromMenu(w: WindowContext, url: string, e: MenuClickEvent | undefined): void {
  if (w.win.isDestroyed()) return
  browserTabs(w).navigate(url, { disposition: openDisposition(e) })
}

export function registerBookmarkBarHandlers(): void {
  router.handle('bookmarks.bar', (_req, ctx) => ({ items: profileOf(ctx).stores.bookmarks.barItems() }))

  router.handle('bookmarks.barFolderMenu', (req, ctx) => {
    const w = windowOf(ctx)
    const store = w.profile.stores.bookmarks
    const node = req.folderId === BOOKMARK_BAR_ID ? store.tree().bar : req.folderId === BOOKMARK_OTHER_ID ? store.tree().other : store.find(req.folderId)
    if (!node || node.kind !== 'folder') throw new IpcFailure('E_NOT_FOUND', 'No such folder')
    const menu = Menu.buildFromTemplate(buildFolderTemplate(node.children, (url, e) => openFromMenu(w, url, e)))
    // Resolve when the menu closes so the bar can reset aria-expanded.
    return new Promise<null>((resolve) => {
      if (w.win.isDestroyed()) return resolve(null)
      menu.popup({ window: w.win, x: Math.round(req.x), y: Math.round(req.y), callback: () => resolve(null) })
    })
  })
}
