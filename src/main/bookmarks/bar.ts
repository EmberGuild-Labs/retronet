// Bookmark bar handlers (FIX-GAPS): `bookmarks.bar` (the Bar folder's children for the caller's profile) and
// `bookmarks.barFolderMenu` (themed menu of a folder; folderId 'bar' is the bar's » overflow button and the 1997
// Bookmarks button). The call resolves when the menu closes so the shell can reset aria-expanded.
import { MENU_DEPTH_MAX, MENU_LEVEL_MAX, MENU_NODES_MAX, truncateLabel, type MenuAnchor } from '../../shared/menu-model'
import { BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID } from '../../shared/types'
import type { BookmarkNode } from '../../shared/types'
import { profileOf, windowOf } from '../internal-api/misc'
import { IpcFailure, router } from '../ipc/router'
import { showMenu, type MenuEntry, type MenuPick } from '../menus/menu-host'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'

const LABEL_MAX = 60
export const BOOKMARKS_MANAGER_URL = 'retronet://bookmarks/'

export interface MenuClickEvent {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  /** 1 = middle click. */
  button?: number
}

export function openDisposition(e: MenuClickEvent | undefined, platform: string = process.platform): 'current' | 'new-tab' | 'background-tab' {
  const mod = platform === 'darwin' ? !!e?.metaKey : !!e?.ctrlKey
  if (mod || e?.button === 1) return 'background-tab'
  return e?.shiftKey ? 'new-tab' : 'current'
}

/** A menu pick as the click event openDisposition reads. */
export function pickToClick(p: MenuPick): MenuClickEvent {
  return { metaKey: p.mods.meta, ctrlKey: p.mods.ctrl, shiftKey: p.mods.shift, button: p.button }
}

const idPart = (s: string): string => s.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 60)

function label(n: BookmarkNode): string {
  const raw = n.title.replace(/\s+/g, ' ').trim() || (n.kind === 'bookmark' ? n.url : 'Untitled folder')
  return truncateLabel(raw, LABEL_MAX)
}

interface BuildState {
  /** Nodes still allowed in the whole menu (MENU_NODES_MAX, minus the root's separator and "More" item). */
  left: number
  capped: boolean
  seq: number
}

export interface FolderTemplateOptions {
  /** Opens a bookmark; `e` carries the modifiers and button of the pick. */
  open: (url: string, e: MenuClickEvent) => void
  /** "More in Bookmarks manager…". */
  openManager?: (e: MenuClickEvent) => void
  /** Run-time check that a bookmark still exists (AC64). */
  exists?: (id: string) => boolean
}

/**
 * Menu entries for a folder's children. Ids are `bm:<nodeId>`. A level is capped at MENU_LEVEL_MAX items, the whole
 * tree at MENU_NODES_MAX nodes; a capped menu ends with a separator and "More in Bookmarks manager…". Levels count
 * the root as 1, so the 8th level holds "(Too deep)" for anything below the 7th level of real folders.
 */
export function buildFolderTemplate(children: readonly BookmarkNode[], o: FolderTemplateOptions): MenuEntry[] {
  const state: BuildState = { left: MENU_NODES_MAX - 2, capped: false, seq: 0 }
  const level = (list: readonly BookmarkNode[], depth: number, max: number): MenuEntry[] => {
    if (list.length === 0) {
      state.left--
      return [{ id: `bm:empty:${state.seq++}`, label: '(Empty)', enabled: false }]
    }
    const out: MenuEntry[] = []
    for (const n of list) {
      if (out.length >= max || state.left <= 0) {
        state.capped = true
        break
      }
      state.left--
      if (n.kind === 'folder') {
        const sub =
          depth + 2 >= MENU_DEPTH_MAX
            ? ((): MenuEntry[] => {
                state.left--
                return [{ id: `bm:deep:${state.seq++}`, label: '(Too deep)', enabled: false }]
              })()
            : level(n.children, depth + 1, MENU_LEVEL_MAX)
        out.push({ id: `bm:${idPart(n.id)}`, label: label(n), title: n.title.trim() || undefined, submenu: sub })
      } else {
        const url = n.url
        const id = n.id
        out.push({
          id: `bm:${idPart(id)}`,
          label: label(n),
          title: url,
          run: (pick) => {
            if (o.exists && !o.exists(id)) return
            o.open(url, pickToClick(pick))
          }
        })
      }
    }
    return out
  }
  const root = level(children, 0, children.length > MENU_LEVEL_MAX ? MENU_LEVEL_MAX - 2 : MENU_LEVEL_MAX)
  if (children.length > MENU_LEVEL_MAX) state.capped = true
  if (state.capped) {
    root.push({ kind: 'separator' })
    root.push({ id: 'bm:more', label: 'More in Bookmarks manager…', run: (pick) => o.openManager?.(pickToClick(pick)) })
  }
  return root
}

function openFromMenu(w: WindowContext, url: string, e: MenuClickEvent): void {
  if (w.win.isDestroyed()) return
  browserTabs(w).navigate(url, { disposition: openDisposition(e) })
}

export function registerBookmarkBarHandlers(): void {
  router.handle('bookmarks.bar', (_req, ctx) => ({ items: profileOf(ctx).stores.bookmarks.barItems() }))

  router.handle('bookmarks.barFolderMenu', async (req, ctx) => {
    const w = windowOf(ctx)
    const store = w.profile.stores.bookmarks
    const node = req.folderId === BOOKMARK_BAR_ID ? store.tree().bar : req.folderId === BOOKMARK_OTHER_ID ? store.tree().other : store.find(req.folderId)
    if (!node || node.kind !== 'folder') throw new IpcFailure('E_NOT_FOUND', 'No such folder')
    const entries = buildFolderTemplate(node.children, {
      open: (url, e) => openFromMenu(w, url, e),
      openManager: (e) => openFromMenu(w, BOOKMARKS_MANAGER_URL, e),
      exists: (id) => !!store.find(id)
    })
    const folderId = req.folderId
    const anchor: MenuAnchor = req.anchor ?? { x: req.x, y: req.y, width: 0, height: 0 }
    const name = folderId === BOOKMARK_BAR_ID ? 'Bookmarks' : node.title.trim() || 'Bookmarks'
    // Resolves when the menu closes so the bar can reset aria-expanded.
    await showMenu(w, {
      kind: 'bookmarks',
      label: name,
      entries,
      anchor,
      placement: req.anchor ? 'below' : 'point',
      keyboard: req.keyboard,
      isValid: () => folderId === BOOKMARK_BAR_ID || folderId === BOOKMARK_OTHER_ID || !!store.find(folderId)
    })
    return null
  })
}
