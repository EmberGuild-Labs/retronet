// Native context menus (AC8): the page menu of every tab (back/forward/reload, links, images, selection,
// editing, spelling, inspect), the edit menu for text fields in the shell and overlay, and the profile menu
// (`profiles.menu`). Tab and group menus are T15's (commands/tab-menus.ts). Menus are native, so they draw above
// web content without z-order tricks.
import { app, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { CommandId } from '../../shared/commands'
import { getSearchEngine, searchUrlFor } from '../../shared/search-engines'
import { profileManager } from '../profiles/profile-manager'
import { decidePageNavigation } from '../security/navigation-guards'
import type { Tab } from '../tabs/tab'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

type Item = MenuItemConstructorOptions
const sep: Item = { type: 'separator' }

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

function editItems(p: ContextMenuParams): Item[] {
  const f = p.editFlags
  return [
    { role: 'undo', enabled: f.canUndo },
    { role: 'redo', enabled: f.canRedo },
    sep,
    { role: 'cut', enabled: f.canCut },
    { role: 'copy', enabled: f.canCopy },
    { role: 'paste', enabled: f.canPaste },
    { role: 'selectAll', enabled: f.canSelectAll }
  ]
}

function spellingItems(wc: WebContents, p: ContextMenuParams): Item[] {
  if (!p.misspelledWord) return []
  const items: Item[] = p.dictionarySuggestions.slice(0, 5).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) }))
  if (items.length === 0) items.push({ label: 'No spelling suggestions', enabled: false })
  items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
  items.push(sep)
  return items
}

/** The page context menu template (exported for the harness / tests). */
export function buildPageMenu(w: WindowContext, tab: Tab, p: ContextMenuParams): Item[] {
  const wc = tab.wc
  const items: Item[] = []
  const pm = profileManager()
  const engineId = w.profile.getSettings().searchEngine
  const engine = getSearchEngine(engineId)
  const tabUrl = tab.url()

  if (p.isEditable) items.push(...spellingItems(wc, p))

  if (p.linkURL) {
    const link = p.linkURL
    if (contextOpenable(link, tabUrl)) {
      items.push(
        { id: 'ctx.openLinkTab', label: 'Open link in new tab', click: () => openInTab(w, link, { background: true, openerId: tab.id }) },
        { id: 'ctx.openLinkWindow', label: 'Open link in new window', click: () => void pm.newWindow(w.profile.id, { initialUrl: link }) },
        {
          id: 'ctx.openLinkIncognito',
          label: 'Open link in incognito window',
          click: () => void pm.newIncognitoWindow(w.profile.id, { initialUrl: link })
        }
      )
    }
    items.push({ id: 'ctx.copyLink', label: 'Copy link address', click: () => clipboard.writeText(link) }, sep)
  }

  if (p.mediaType === 'image' && p.srcURL) {
    const src = p.srcURL
    if (contextOpenable(src, tabUrl)) items.push({ id: 'ctx.openImage', label: 'Open image in new tab', click: () => openInTab(w, src, { background: true, openerId: tab.id }) })
    if (/^(https?:|data:image\/)/i.test(src)) items.push({ id: 'ctx.saveImage', label: 'Save image as...', click: () => wc.downloadURL(src) })
    items.push(
      { id: 'ctx.copyImage', label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { id: 'ctx.copyImageAddress', label: 'Copy image address', click: () => clipboard.writeText(src) },
      sep
    )
  }

  if (p.isEditable) {
    items.push(...editItems(p), sep)
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    items.push(
      { id: 'ctx.copy', role: 'copy' },
      {
        id: 'ctx.search',
        label: `Search ${engine.name} for "${truncate(text, 24)}"`,
        click: () => openInTab(w, contextSearchUrl(text, engineId), { background: false, openerId: tab.id })
      },
      sep
    )
  } else if (!p.linkURL && p.mediaType !== 'image') {
    const h = wc.navigationHistory
    items.push(
      { id: 'ctx.back', label: 'Back', enabled: h.canGoBack(), click: () => tab.back() },
      { id: 'ctx.forward', label: 'Forward', enabled: h.canGoForward(), click: () => tab.forward() },
      { id: 'ctx.reload', label: 'Reload', click: () => tab.reload() },
      sep,
      { id: 'ctx.selectAll', role: 'selectAll' },
      sep
    )
  }

  // AC7: developer tools are allowed for pages; the inspector docks in its own window.
  items.push({
    id: 'ctx.inspect',
    label: 'Inspect',
    click: () => {
      wc.inspectElement(p.x, p.y)
      if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus()
    }
  })
  return trimSeparators(items)
}

/** Edit menu for the shell's and overlay's own text fields (omnibox, find bar, palette); Inspect when unpackaged. */
export function buildUiMenu(wc: WebContents, p: ContextMenuParams): Item[] {
  const items: Item[] = p.isEditable ? editItems(p) : p.selectionText.trim() ? [{ role: 'copy' }] : []
  if (!app.isPackaged) items.push(sep, { label: 'Inspect browser UI', click: () => wc.inspectElement(p.x, p.y) })
  return trimSeparators(items)
}

function trimSeparators(items: Item[]): Item[] {
  const out: Item[] = []
  for (const it of items) {
    if (it.type === 'separator' && (out.length === 0 || out[out.length - 1]!.type === 'separator')) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1]!.type === 'separator') out.pop()
  return out
}

export interface ContextMenuDeps {
  /** Resolve a webContents to its window and role. */
  resolve(wc: WebContents): { w: WindowContext; role: 'shell' | 'overlay' | 'tab'; tab: Tab | null } | null
}

const attached = new WeakSet<WebContents>()

/** Wire the `context-menu` event of a shell, overlay or tab webContents (idempotent). */
export function attachContextMenu(wc: WebContents, deps: ContextMenuDeps): void {
  if (attached.has(wc)) return
  attached.add(wc)
  wc.on('context-menu', (_e, params) => {
    const hit = deps.resolve(wc)
    if (!hit || hit.w.win.isDestroyed()) return
    const template = hit.role === 'tab' && hit.tab ? buildPageMenu(hit.w, hit.tab, params) : buildUiMenu(wc, params)
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: hit.w.win, frame: params.frame ?? undefined })
  })
}

/** The profile button menu (`profiles.menu`): switch profile, new profile, incognito, manage. */
export function buildProfilesMenu(w: WindowContext, run: (id: CommandId, arg?: string) => void): Item[] {
  const pm = profileManager()
  const items: Item[] = pm.list().map((p) => ({
    id: `profiles.menu:${p.id}`,
    label: p.name,
    type: 'radio',
    checked: p.id === w.profile.id && !w.incognito,
    click: () => run('profile.switch', p.id)
  }))
  items.push(
    sep,
    { id: 'profiles.menu:new', label: 'New profile...', click: () => run('profile.new') },
    { id: 'profiles.menu:incognito', label: 'New incognito window', click: () => run('window.newIncognito') },
    sep,
    { id: 'profiles.menu:manage', label: 'Manage profiles...', click: () => openInTab(w, 'retronet://settings/#profiles', { background: false }) }
  )
  return items
}

export function popupMenu(w: WindowContext, template: Item[], x: number, y: number): void {
  if (w.win.isDestroyed() || template.length === 0) return
  Menu.buildFromTemplate(template).popup({ window: w.win, x: Math.round(x), y: Math.round(y) })
}
