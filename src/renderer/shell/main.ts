// Shell renderer entry (retronet://shell/). Builds the frame in DESIGN 2 order:
//   tab strip (T18) -> toolbar -> location row -> bookmark bar (T18) -> find bar -> [tab view] -> status bar
// and keeps it in step with main's `state` / `status` / `find` / `ui` events. It reports the heights of the bars
// above and below the content slot with layout.setInsets, so main lays the tab's WebContentsView out between them,
// and marks shell.ready once the first snapshot has painted (AC44 cold-launch timing).
import { initSkin } from '../common/skin-loader'
import { h } from '../common/dom'
import { shellApi } from '../common/api'
import { isSkinId, DEFAULT_SKIN, type SkinId } from '@shared/skins'
import type { TabState, WindowSnapshot } from '@shared/types'
import { call, createToolbar } from './toolbar'
import { createOmnibox } from './omnibox'
import { createStatusBar } from './statusbar'
import { createFindBar } from './findbar'
import { mountTabStrip } from './tabstrip'
import { mountBookmarkBar } from './bookmarkbar'
import './shell.css'

// Skin first, before anything paints (T9 handoff).
initSkin('shell')

const api = shellApi()
const platform = api.platform
const root = document.documentElement

// ---- build ----

const findbar = createFindBar(api, platform, (open) => toolbar.setFindOpen(open))
const toolbar = createToolbar({ api, platform, toggleFind: () => (findbar.isOpen ? findbar.close() : findbar.open()) })
findbar.el.id = 'rn-findbar'
const omnibox = createOmnibox({ api, platform })
const statusbar = createStatusBar(api)

const tabsHost = h('div', { class: 'rn-shell__tabs' })
const bookmarksHost = h('div', { class: 'rn-shell__bookmarks' })
/** Popup windows (D4) have no tab strip; this strip keeps the drag area and the window-control inset. */
const popupTitle = h('span', { class: 'rn-shell__popup-title' })
const popupStrip = h('div', { class: 'rn-tabstrip rn-shell__popup-strip', attrs: { hidden: true } }, h('div', { class: 'rn-titlebar-spacer' }), popupTitle)
const content = h('div', { class: 'rn-frame__content', attrs: { 'aria-hidden': 'true' } })
const header = h('header', { class: 'rn-shell__top' }, popupStrip, tabsHost, toolbar.el, omnibox.el, bookmarksHost, findbar.el)
const frame = h('div', { class: 'rn-frame' }, header, content, statusbar.el)

mountTabStrip(tabsHost, api)
mountBookmarkBar(bookmarksHost, api)

document.body.replaceChildren(frame)

// ---- skin-dependent markup ----

function skinNow(): SkinId {
  const s = root.dataset.skin
  return isSkinId(s) ? s : DEFAULT_SKIN
}
let renderedSkin: SkinId | null = null
function renderSkin(): void {
  const skin = skinNow()
  if (skin === renderedSkin) return
  renderedSkin = skin
  toolbar.render(skin)
  omnibox.render(skin)
  statusbar.render(skin)
}
renderSkin()
new MutationObserver(renderSkin).observe(root, { attributes: true, attributeFilter: ['data-skin'] })

// ---- state ----

let snap: WindowSnapshot | null = null
let activeId: number | null = null
/** Tab ids this shell has already rendered; a new id that becomes active on the new-tab page takes the omnibox. */
const seenTabs = new Set<number>()
let firstState = true

const NEWTAB_RE = /^retronet:\/\/newtab\/?$/i
const isNewTabPage = (t: TabState | undefined): boolean => !!t && (t.url === '' || NEWTAB_RE.test(t.url))

/**
 * D3: browser-standard initial focus. On launch Chromium gives the shell "initial focus", which lands on the first
 * focusable element (the + button, with a focus ring). Instead: the omnibox when the active tab is the new-tab
 * page (launch, +, Cmd+T, double-click on the strip), otherwise nothing in the shell is focused.
 */
function placeInitialFocus(tab: TabState | undefined, launch: boolean): void {
  if (snap?.popup) return
  if (isNewTabPage(tab)) {
    omnibox.focus()
    return
  }
  const a = document.activeElement
  if (launch && a instanceof HTMLElement && a !== document.body && tabsHost.contains(a)) a.blur()
}

function activeTab(s: WindowSnapshot): TabState | undefined {
  return s.activeTabId === null ? undefined : s.tabs.find((t) => t.id === s.activeTabId)
}

function applyState(next: WindowSnapshot): void {
  snap = next
  const tab = activeTab(next)
  const tabChanged = (tab?.id ?? null) !== activeId
  activeId = tab?.id ?? null

  frame.dataset.popup = next.popup ? 'true' : 'false'
  popupStrip.hidden = !next.popup
  tabsHost.hidden = next.popup
  bookmarksHost.hidden = next.popup
  toolbar.el.hidden = next.popup
  if (next.popup) popupTitle.textContent = tab?.title || tab?.url || ''

  toolbar.update(next, tab)
  omnibox.update(next, tab)
  statusbar.update(next, tab)
  if (tabChanged) findbar.reset()
  const isNew = tab !== undefined && !seenTabs.has(tab.id)
  for (const t of next.tabs) seenTabs.add(t.id)
  if (firstState) {
    firstState = false
    placeInitialFocus(tab, true)
  } else if (tabChanged && isNew) {
    placeInitialFocus(tab, false)
  }
  scheduleReady()
}

api.on('state', applyState)
api.on('status', (ev) => statusbar.status(ev))
api.on('find', (ev) => findbar.event(ev))
api.on('ui', (ev) => {
  if (ev.action === 'focus-omnibox') omnibox.focus()
  else if (ev.action === 'omnibox-picked') omnibox.picked()
})

// Local fallbacks for when focus is in the shell itself (main's shortcut handler covers web content).
document.addEventListener('keydown', (ev) => {
  const mod = platform === 'mac' ? ev.metaKey : ev.ctrlKey
  if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'l' || ev.key === 'L')) {
    ev.preventDefault()
    omnibox.focus()
  } else if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'f' || ev.key === 'F') && !snap?.popup) {
    ev.preventDefault()
    findbar.open()
  }
})

// ---- insets ----

let sent = { top: -1, bottom: -1 }
function reportInsets(): void {
  const r = content.getBoundingClientRect()
  const top = Math.max(0, Math.round(r.top))
  const bottom = Math.max(0, Math.round(window.innerHeight - r.bottom))
  if (top === sent.top && bottom === sent.bottom) return
  sent = { top, bottom }
  void call(api.layout.setInsets({ top, bottom }), 'layout.setInsets')
}
const ro = new ResizeObserver(() => reportInsets())
ro.observe(header)
ro.observe(statusbar.el)
ro.observe(content)
window.addEventListener('resize', reportInsets)
// Web fonts can change bar heights by a pixel once loaded.
void document.fonts?.ready.then(reportInsets)

// ---- ready mark ----

let readySent = false
function scheduleReady(): void {
  if (readySent) return
  readySent = true
  // Two frames: the first snapshot's DOM is committed and painted.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      reportInsets()
      void call(api.shell.ready(), 'shell.ready')
    })
  )
}
// If the first snapshot is slow (or lost), still mark ready once the frame is up.
setTimeout(scheduleReady, 1500)
reportInsets()
