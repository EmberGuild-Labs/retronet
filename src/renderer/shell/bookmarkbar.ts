// Bookmark bar (T18; DESIGN 2.1-2.3, 6.3). Shows the "bar" folder's items under the address row when the window
// snapshot's `bookmarkBar` flag is on (Cmd/Ctrl+Shift+B toggles it in main). Bookmarks open in the current tab
// (Cmd/Ctrl- or middle-click: background tab, Shift-click: new tab); folders open a native menu via
// bookmarks.barFolderMenu. One Tab stop with a roving tabindex; arrows/Home/End move between items.
//
// The bar re-reads bookmarks.bar whenever it is shown and on main's `bookmarks` event (sent after any change to
// the window profile's bookmarks, from any window or page).
import type { ShellBridge } from '../common/api'
import { h, icon, keyedList } from '../common/dom'
import type { BookmarkNode, WindowSnapshot } from '@shared/types'
import './tabstrip.css'

export interface BookmarkBarHandle {
  update(snapshot: WindowSnapshot): void
  /** Re-read the bar folder now (e.g. after the shell itself changed a bookmark). */
  refresh(): void
  destroy(): void
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function mountBookmarkBar(host: HTMLElement, api: ShellBridge): BookmarkBarHandle {
  const isMac = api.platform === 'mac'
  // The bar is our own child of the host, so the shell can show/hide the host (popups) without fighting the
  // bookmarkBar flag: an empty host has no height.
  const el = h('div', { class: 'rn-bookmarkbar', attrs: { role: 'toolbar', 'aria-label': 'Bookmarks bar', hidden: true } })
  host.replaceChildren(el)
  const label = h('span', { class: 'rn-bookmarkbar__label', text: 'Links', attrs: { 'aria-hidden': 'true' } })
  const items = h('div', { class: 'rn-bookmarkbar__items' })
  const empty = h('span', {
    class: 'rn-bookmarkbar__empty',
    text: `The bookmarks bar is empty. Bookmark a page with ${isMac ? '⌘D' : 'Ctrl+D'} or file it here from the Bookmarks manager.`,
    attrs: { hidden: true }
  })
  // Items that don't fit are clipped; this button lists the whole bar folder in the native menu so none are lost.
  const more = h(
    'button',
    {
      class: 'rn-bookmarkbar__item rn-bookmarkbar__more',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More bookmarks', title: 'More bookmarks', hidden: true }
    },
    icon('chevron-right')
  )
  el.replaceChildren(label, items, more, empty)
  let overflowQueued = false
  const checkOverflow = (): void => {
    if (overflowQueued) return
    overflowQueued = true
    requestAnimationFrame(() => {
      overflowQueued = false
      // items that don't fully fit are hidden (not half-drawn) and reachable through the » menu instead
      const edge = items.getBoundingClientRect().right + 1
      let clipped = 0
      for (const c of stopsAll()) {
        const out = c.getBoundingClientRect().right > edge
        c.toggleAttribute('data-clipped', out)
        if (out) clipped++
      }
      more.hidden = clipped === 0
      if (clipped) render(false)
    })
  }
  const ro = new ResizeObserver(checkOverflow)
  ro.observe(items)
  more.addEventListener('click', () => void openFolder(more, 'bar'))

  let visible = false
  let nodes: BookmarkNode[] = []
  let roving: string | null = null
  let seq = 0

  const keyed = keyedList<BookmarkNode>(
    items,
    (n) => n.id,
    (n) =>
      n.kind === 'folder'
        ? h('button', { class: 'rn-bookmarkbar__item rn-bookmarkbar__folder', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, data: { id: n.id } })
        : h('a', { class: 'rn-bookmarkbar__item', data: { id: n.id }, attrs: { draggable: 'false' } }),
    (node, n) => {
      const title = n.title.trim() || (n.kind === 'bookmark' ? hostOf(n.url) : 'Untitled folder')
      const fav = n.kind === 'bookmark' && n.faviconDataUrl && /^data:image\//i.test(n.faviconDataUrl) ? n.faviconDataUrl : ''
      const s = `${n.kind}|${title}|${fav}|${n.kind === 'bookmark' ? n.url : ''}`
      if (node.dataset.sig === s) return
      node.dataset.sig = s
      if (n.kind === 'bookmark') {
        node.setAttribute('href', n.url)
        node.title = title === n.url ? n.url : `${title}\n${n.url}`
      } else {
        node.title = `${title} (folder)`
      }
      node.replaceChildren(
        fav
          ? h('img', { class: 'rn-bookmarkbar__favicon', attrs: { src: fav, alt: '', draggable: 'false' } })
          : icon(n.kind === 'folder' ? 'folder' : 'page'),
        h('span', { text: title })
      )
    }
  )

  function stopsAll(): HTMLElement[] {
    return [...items.children].filter((c): c is HTMLElement => c instanceof HTMLElement)
  }
  function stops(): HTMLElement[] {
    return stopsAll().filter((c) => !c.hasAttribute('data-clipped'))
  }

  function render(measure = true): void {
    if (measure) {
      keyed.update(nodes)
      empty.hidden = nodes.length > 0
      checkOverflow()
    }
    for (const c of stopsAll()) c.tabIndex = -1
    const all = stops()
    if (!el.contains(document.activeElement)) roving = null
    const stop = (roving && all.find((n) => n.dataset.id === roving)) || all[0]
    for (const n of all) n.tabIndex = n === stop ? 0 : -1
  }

  async function fetchBar(): Promise<void> {
    const mine = ++seq
    try {
      const res = await api.bookmarks.bar()
      if (mine !== seq || !res.ok) return
      nodes = res.data.items
      render()
    } catch {
      /* keep what we have */
    }
  }

  function setVisible(on: boolean): void {
    if (on === visible) return
    visible = on
    el.hidden = !on
    // T17 re-measures insets on this (in addition to any ResizeObserver it uses)
    el.dispatchEvent(new CustomEvent('rn-layoutchange', { bubbles: true }))
    if (on) void fetchBar()
  }

  function update(s: WindowSnapshot): void {
    setVisible(s.bookmarkBar && !s.popup)
  }

  // ---- input ----
  const itemOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? (t.closest<HTMLElement>('.rn-bookmarkbar__item') ?? null) : null
  const nodeOf = (n: HTMLElement): BookmarkNode | undefined => nodes.find((x) => x.id === n.dataset.id)

  async function openFolder(btn: HTMLElement, folderId = btn.dataset.id as string): Promise<void> {
    const r = btn.getBoundingClientRect()
    btn.setAttribute('aria-expanded', 'true')
    try {
      await api.bookmarks.barFolderMenu({ folderId, x: Math.round(r.left), y: Math.round(r.bottom) })
    } finally {
      btn.setAttribute('aria-expanded', 'false')
    }
  }

  function openBookmark(url: string, e: MouseEvent | KeyboardEvent): void {
    const mod = isMac ? e.metaKey : e.ctrlKey
    const middle = e instanceof MouseEvent && e.button === 1
    const disposition = mod || middle ? 'background-tab' : e.shiftKey ? 'new-tab' : 'current'
    void api.tabs.navigate({ input: url, disposition }).catch(() => undefined)
  }

  items.addEventListener('click', (e) => {
    const n = itemOf(e.target)
    if (!n) return
    e.preventDefault() // never navigate the shell itself
    const b = nodeOf(n)
    roving = n.dataset.id ?? null
    if (b?.kind === 'folder') void openFolder(n)
    else if (b) openBookmark(b.url, e)
  })
  items.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault()
  })
  items.addEventListener('auxclick', (e) => {
    const n = itemOf(e.target)
    if (!n || e.button !== 1) return
    e.preventDefault()
    const b = nodeOf(n)
    if (b?.kind === 'bookmark') openBookmark(b.url, e)
  })
  items.addEventListener('contextmenu', (e) => e.preventDefault())
  items.addEventListener('dragstart', (e) => e.preventDefault())
  items.addEventListener('keydown', (e) => {
    const n = itemOf(e.target)
    if (!n) return
    const all = stops()
    const i = all.indexOf(n)
    let target: HTMLElement | undefined
    if (e.key === 'ArrowRight') target = all[(i + 1) % all.length]
    else if (e.key === 'ArrowLeft') target = all[(i - 1 + all.length) % all.length]
    else if (e.key === 'Home') target = all[0]
    else if (e.key === 'End') target = all[all.length - 1]
    else if ((e.key === 'ArrowDown' || e.key === ' ') && nodeOf(n)?.kind === 'folder') {
      e.preventDefault()
      void openFolder(n)
      return
    } else if (e.key === ' ' && n instanceof HTMLAnchorElement) {
      e.preventDefault()
      n.click()
      return
    }
    if (!target) return
    e.preventDefault()
    for (const c of all) c.tabIndex = c === target ? 0 : -1
    roving = target.dataset.id ?? null
    target.focus()
  })

  const off = api.on('state', update)
  // A hidden bar re-reads when it is shown, so only a visible one needs to fetch now.
  const offBookmarks = api.on('bookmarks', () => {
    if (visible) void fetchBar()
  })

  return {
    update,
    refresh: () => void fetchBar(),
    destroy() {
      off()
      offBookmarks()
      ro.disconnect()
      host.replaceChildren()
    }
  }
}
