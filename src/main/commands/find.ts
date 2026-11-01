// Find in page (AC5). The shell's find bar sends `find.query` / `find.next` / `find.close`; main runs
// `webContents.findInPage` on the active tab and forwards each `found-in-page` result to the shell as a `find`
// event. Cmd/Ctrl+F sends `find` {type:'open', query} (the last query of the window) and, when that query is
// not empty, searches again right away, so the shell does not need to re-query on open.
import type { WebContents } from 'electron'
import type { Tab } from '../tabs/tab'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'

interface FindState {
  query: string
  /** Tab the current session runs in (null = bar closed). */
  tabId: number | null
}

const states = new WeakMap<WindowContext, FindState>()
const wired = new WeakSet<WebContents>()

function stateOf(w: WindowContext): FindState {
  let s = states.get(w)
  if (!s) {
    s = { query: '', tabId: null }
    states.set(w, s)
  }
  return s
}

/** Results and auto-close on navigation, wired once per tab webContents. */
function wire(w: WindowContext, tab: Tab): void {
  const wc = tab.wc
  if (wired.has(wc)) return
  wired.add(wc)
  wc.on('found-in-page', (_e, r) => {
    const s = stateOf(w)
    if (s.tabId !== tab.id) return
    w.sendShell('find', { type: 'result', matches: r.matches ?? 0, activeMatch: r.activeMatchOrdinal ?? 0, final: r.finalUpdate === true })
  })
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    const s = stateOf(w)
    if (s.tabId === tab.id) close(w, { notify: true, refocus: false })
  })
}

function sendEmpty(w: WindowContext): void {
  w.sendShell('find', { type: 'result', matches: 0, activeMatch: 0, final: true })
}

/** Is the find bar open in this window (main's view)? */
export function findActive(w: WindowContext): boolean {
  return stateOf(w).tabId !== null
}

export function lastQuery(w: WindowContext): string {
  return stateOf(w).query
}

/** `find.query`: start a new search for `text` in the active tab. */
export function query(w: WindowContext, text: string): void {
  const s = stateOf(w)
  const tab = browserTabs(w).active()
  // Stop a session left in another tab (the user switched tabs with the bar open).
  if (s.tabId !== null && s.tabId !== tab?.id) {
    const old = browserTabs(w).get(s.tabId)
    if (old && !old.wc.isDestroyed()) old.wc.stopFindInPage('clearSelection')
  }
  s.query = text
  if (!tab || tab.wc.isDestroyed()) {
    s.tabId = null
    sendEmpty(w)
    return
  }
  wire(w, tab)
  s.tabId = tab.id
  if (text === '') {
    tab.wc.stopFindInPage('clearSelection')
    sendEmpty(w)
    return
  }
  tab.wc.findInPage(text, { findNext: true, forward: true })
}

/** `find.next` (and Cmd/Ctrl+G, Shift+G): the next or previous match of the current query. */
export function next(w: WindowContext, forward: boolean): void {
  const s = stateOf(w)
  const tab = browserTabs(w).active()
  if (!tab || tab.wc.isDestroyed() || s.query === '') return
  if (s.tabId !== tab.id) {
    query(w, s.query)
    return
  }
  tab.wc.findInPage(s.query, { findNext: false, forward })
}

/** Cmd/Ctrl+F: show and focus the find bar, prefilled with the last query (searched again). */
export function open(w: WindowContext): void {
  const s = stateOf(w)
  w.sendShell('find', { type: 'open', query: s.query })
  w.shell.focus()
  if (s.query) query(w, s.query)
  else {
    const tab = browserTabs(w).active()
    if (tab) wire(w, tab)
    s.tabId = tab?.id ?? null
  }
}

/** `find.close` / Esc: stop the search (keeping the selected match selected) and give the page focus back. */
export function close(w: WindowContext, opts: { notify: boolean; refocus: boolean }): void {
  const s = stateOf(w)
  const tabId = s.tabId
  s.tabId = null
  if (tabId !== null) {
    const tab = browserTabs(w).get(tabId)
    if (tab && !tab.wc.isDestroyed()) {
      tab.wc.stopFindInPage('keepSelection')
      if (opts.refocus && browserTabs(w).active() === tab) tab.focus()
    }
  }
  if (opts.notify) w.sendShell('find', { type: 'close' })
}
