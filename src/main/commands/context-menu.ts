// Context menus (AC8, AC60, AC61): the page menu of every tab (back/forward/reload, links, images, selection,
// editing, spelling, inspect), the edit menu for text fields in the shell and overlay, and the profile menu
// (`profiles.menu`). Tab and group menus are T15's (commands/tab-menus.ts). The builders return MenuEntry[] with
// stable ids (`ctx.*`, `edit.*`, `spell.*`, `profiles.menu:*`) and run closures; menu-host draws them themed in the
// overlay, or natively when the overlay is busy or the menu is for the overlay's own fields (PLAN-FINAL 1.2).
import { app, clipboard, type ContextMenuParams, type WebContents } from 'electron'
import { platformKey, type CommandId } from '../../shared/commands'
import { getSearchEngine, searchUrlFor } from '../../shared/search-engines'
import { viewSourceUrlFor } from './menu'
import { profileManager } from '../profiles/profile-manager'
import { showMenu, type MenuEntry, type MenuItemEntry } from '../menus/menu-host'
import { decidePageNavigation } from '../security/navigation-guards'
import type { Tab } from '../tabs/tab'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

const sep: MenuEntry = { kind: 'separator' }
const MAC = platformKey(process.platform) === 'mac'

/**
 * Links and images we offer to open (R4/N3). The page chose the URL, so decide as for a page navigation from
 * this tab: retronet: targets only when the tab itself shows a retronet: page, file: never.
 */
export function contextOpenable(url: string, tabUrl: string): boolean {
  return url !== '' && decidePageNavigation(url, { kind: 'tab', currentUrl: tabUrl }) === 'allow'
}

/** "Search <engine> for ..." (R3/N2): always a search URL, never classified as typed omnibox input. */
export function contextSearchUrl(selection: string, engineId: string): string {
  return searchUrlFor(engineId, selection.trim().slice(0, 2048))
}

/** A normal (non-popup) window of the same profile context, else a new one. */
export function normalWindowFor(w: WindowContext): WindowContext {
  if (!w.popup) return w
  const other = windowManager.all().find((x) => x.profile === w.profile && !x.popup)
  if (other) return other
  return w.incognito ? profileManager().newIncognitoWindow(w.profile.id) : profileManager().newWindow(w.profile.id)
}

/** Open `url` in a tab of `w` (or its normal window when `w` is a popup). */
export function openInTab(w: WindowContext, url: string, opts: { background: boolean; openerId?: number }): void {
  const target = normalWindowFor(w)
  browserTabs(target).create({ url, background: opts.background, openerId: target === w ? opts.openerId : undefined })
  if (target !== w && !opts.background) target.win.focus()
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** Chips for the edit items (what Chromium's own field shortcuts are on each platform). */
const EDIT_ACCELS = MAC
  ? { undo: 'Cmd+Z', redo: 'Shift+Cmd+Z', cut: 'Cmd+X', copy: 'Cmd+C', paste: 'Cmd+V', selectAll: 'Cmd+A' }
  : { undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', selectAll: 'Ctrl+A' }

/** Copy (the page's selection or a field's): acts on the menu's target webContents. */
function copyItem(id: string, enabled = true): MenuItemEntry {
  return { id, label: 'Copy', accel: EDIT_ACCELS.copy, enabled, role: 'copy' }
}

function selectAllItem(id: string, enabled = true): MenuItemEntry {
  return { id, label: 'Select all', accel: EDIT_ACCELS.selectAll, enabled, role: 'selectAll' }
}

function editItems(p: ContextMenuParams): MenuEntry[] {
  const f = p.editFlags
  return [
    { id: 'edit.undo', label: 'Undo', accel: EDIT_ACCELS.undo, enabled: !!f.canUndo, role: 'undo' },
    { id: 'edit.redo', label: 'Redo', accel: EDIT_ACCELS.redo, enabled: !!f.canRedo, role: 'redo' },
    sep,
    { id: 'edit.cut', label: 'Cut', accel: EDIT_ACCELS.cut, enabled: !!f.canCut, role: 'cut' },
    copyItem('edit.copy', !!f.canCopy),
    { id: 'edit.paste', label: 'Paste', accel: EDIT_ACCELS.paste, enabled: !!f.canPaste, role: 'paste' },
    selectAllItem('edit.selectAll', !!f.canSelectAll)
  ]
}

function spellingItems(wc: WebContents, p: ContextMenuParams): MenuEntry[] {
  const word = p.misspelledWord
  if (!word) return []
  const items: MenuEntry[] = p.dictionarySuggestions.slice(0, 5).map(
    (s, i): MenuEntry => ({ id: `spell.suggest:${i}`, label: s, focusTarget: true, run: () => wc.replaceMisspelling(s) })
  )
  if (items.length === 0) items.push({ id: 'spell.none', label: 'No spelling suggestions', enabled: false })
  items.push({ id: 'spell.add', label: 'Add to dictionary', run: () => wc.session.addWordToSpellCheckerDictionary(word) })
  items.push(sep)
  return items
}

/** The page context menu entries (exported for the harness / tests). */
export function buildPageMenu(w: WindowContext, tab: Tab, p: ContextMenuParams): MenuEntry[] {
  const wc = tab.wc
  const items: MenuEntry[] = []
  const pm = profileManager()
  const engineId = w.profile.getSettings().searchEngine
  const engine = getSearchEngine(engineId)
  const tabUrl = tab.url()

  if (p.isEditable) items.push(...spellingItems(wc, p))

  if (p.linkURL) {
    const link = p.linkURL
    if (contextOpenable(link, tabUrl)) {
      items.push(
        { id: 'ctx.openLinkTab', label: 'Open link in new tab', run: () => openInTab(w, link, { background: true, openerId: tab.id }) },
        { id: 'ctx.openLinkWindow', label: 'Open link in new window', run: () => void pm.newWindow(w.profile.id, { initialUrl: link }) },
        {
          id: 'ctx.openLinkIncognito',
          label: 'Open link in incognito window',
          run: () => void pm.newIncognitoWindow(w.profile.id, { initialUrl: link })
        }
      )
    }
    items.push({ id: 'ctx.copyLink', label: 'Copy link address', run: () => clipboard.writeText(link) }, sep)
  }

  if (p.mediaType === 'image' && p.srcURL) {
    const src = p.srcURL
    if (contextOpenable(src, tabUrl)) items.push({ id: 'ctx.openImage', label: 'Open image in new tab', run: () => openInTab(w, src, { background: true, openerId: tab.id }) })
    if (/^(https?:|data:image\/)/i.test(src)) items.push({ id: 'ctx.saveImage', label: 'Save image as...', run: () => wc.downloadURL(src) })
    items.push(
      // The raw view-relative params: copyImageAt and inspectElement take tab-view coordinates.
      { id: 'ctx.copyImage', label: 'Copy image', run: () => wc.copyImageAt(p.x, p.y) },
      { id: 'ctx.copyImageAddress', label: 'Copy image address', run: () => clipboard.writeText(src) },
      sep
    )
  }

  if (p.isEditable) {
    items.push(...editItems(p), sep)
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    items.push(
      copyItem('ctx.copy'),
      {
        id: 'ctx.search',
        label: `Search ${engine.name} for "${truncate(text, 24)}"`,
        run: () => openInTab(w, contextSearchUrl(text, engineId), { background: false, openerId: tab.id })
      },
      sep
    )
  } else if (!p.linkURL && p.mediaType !== 'image') {
    const h = wc.navigationHistory
    items.push(
      { id: 'ctx.back', label: 'Back', enabled: h.canGoBack(), run: () => tab.back() },
      { id: 'ctx.forward', label: 'Forward', enabled: h.canGoForward(), run: () => tab.forward() },
      { id: 'ctx.reload', label: 'Reload', run: () => tab.reload() },
      sep,
      selectAllItem('ctx.selectAll'),
      sep
    )
  }

  // AC54: view the page's source in a tab next to this one (http(s) pages only).
  const sourceUrl = viewSourceUrlFor(tabUrl)
  if (sourceUrl) {
    items.push({
      id: 'ctx.viewSource',
      label: 'View page source',
      run: () => browserTabs(w).create({ url: sourceUrl, openerId: tab.id })
    })
  }
  // AC7: developer tools are allowed for pages; the inspector docks in its own window.
  items.push({
    id: 'ctx.inspect',
    label: 'Inspect',
    run: () => {
      wc.inspectElement(p.x, p.y)
      if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus()
    }
  })
  return trimSeparators(items)
}

/** Edit menu for the shell's and overlay's own text fields (omnibox, find bar, palette); Inspect when unpackaged. */
export function buildUiMenu(wc: WebContents, p: ContextMenuParams): MenuEntry[] {
  const items: MenuEntry[] = p.isEditable ? editItems(p) : p.selectionText.trim() ? [copyItem('edit.copy')] : []
  if (!app.isPackaged) items.push(sep, { id: 'ctx.inspectUi', label: 'Inspect browser UI', run: () => wc.inspectElement(p.x, p.y) })
  return trimSeparators(items)
}

function trimSeparators(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const it of items) {
    if (it.kind === 'separator' && (out.length === 0 || out[out.length - 1]!.kind === 'separator')) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1]!.kind === 'separator') out.pop()
  return out
}

/**
 * Stale-pick guard for a page menu (PLAN-FINAL 1.2): the tab is still in its window, its webContents lives, and it
 * still shows the same URL at the same history entry as when the menu opened.
 */
export function pageMenuValidity(w: WindowContext, tab: Tab): () => boolean {
  const url = tab.url()
  const index = tab.wc.isDestroyed() ? -1 : tab.wc.navigationHistory.getActiveIndex()
  return () =>
    !w.win.isDestroyed() &&
    browserTabs(w).get(tab.id) === tab &&
    !tab.wc.isDestroyed() &&
    tab.url() === url &&
    tab.wc.navigationHistory.getActiveIndex() === index
}

export interface ContextMenuDeps {
  /** Resolve a webContents to its window and role. */
  resolve(wc: WebContents): { w: WindowContext; role: 'shell' | 'overlay' | 'tab'; tab: Tab | null } | null
}

const attached = new WeakSet<WebContents>()

/**
 * Show the context menu for a `context-menu` event of `wc` (exported for tests). Tab params are relative to the tab
 * view, so the anchor adds the view's offset; shell and overlay params are already window-content coordinates.
 * The overlay's own fields always get the native fallback (menu-host decides from `target`).
 */
export function showContextMenu(wc: WebContents, params: ContextMenuParams, deps: ContextMenuDeps): Promise<void> {
  const hit = deps.resolve(wc)
  if (!hit || hit.w.win.isDestroyed()) return Promise.resolve()
  const { w } = hit
  if (hit.role === 'tab') {
    if (!hit.tab) return Promise.resolve()
    const entries = buildPageMenu(w, hit.tab, params)
    if (entries.length === 0) return Promise.resolve()
    const off = w.tabBounds()
    return showMenu(w, {
      kind: 'page',
      label: 'Page',
      entries,
      anchor: { x: params.x + off.x, y: params.y + off.y, width: 0, height: 0 },
      placement: 'point',
      keyboard: params.menuSourceType === 'keyboard',
      isValid: pageMenuValidity(w, hit.tab),
      target: wc
    })
  }
  const entries = buildUiMenu(wc, params)
  if (entries.length === 0) return Promise.resolve()
  return showMenu(w, {
    kind: 'edit',
    label: 'Edit',
    entries,
    anchor: { x: params.x, y: params.y, width: 0, height: 0 },
    placement: 'point',
    keyboard: params.menuSourceType === 'keyboard',
    target: wc
  })
}

/** Wire the `context-menu` event of a shell, overlay or tab webContents (idempotent). */
export function attachContextMenu(wc: WebContents, deps: ContextMenuDeps): void {
  if (attached.has(wc)) return
  attached.add(wc)
  wc.on('context-menu', (_e, params) => void showContextMenu(wc, params, deps))
}

/** The profile button menu (`profiles.menu`): switch profile, new profile, incognito, manage. */
export function buildProfilesMenu(w: WindowContext, run: (id: CommandId, arg?: string) => void): MenuEntry[] {
  const pm = profileManager()
  const items: MenuEntry[] = pm.list().map(
    (p): MenuEntry => ({
      id: `profiles.menu:${p.id}`,
      label: p.name,
      check: 'radio',
      checked: p.id === w.profile.id && !w.incognito,
      run: () => run('profile.switch', p.id)
    })
  )
  items.push(
    sep,
    { id: 'profiles.menu:new', label: 'New profile...', run: () => run('profile.new') },
    { id: 'profiles.menu:incognito', label: 'New incognito window', run: () => run('window.newIncognito') },
    sep,
    { id: 'profiles.menu:manage', label: 'Manage profiles...', run: () => openInTab(w, 'retronet://settings/#profiles', { background: false }) }
  )
  return items
}
