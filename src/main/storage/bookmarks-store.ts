import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BookmarkFolderSchema } from '../../shared/ipc-contract'
import { BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID } from '../../shared/types'
import type { BookmarkFolder, BookmarkNode } from '../../shared/ipc-contract'
import { createJsonStore, type JsonStore } from './json-store'
import { stripUrlCredentials } from './url-credentials'

type Bookmark = Extract<BookmarkNode, { kind: 'bookmark' }>

const FileSchema = z.object({ bar: BookmarkFolderSchema, other: BookmarkFolderSchema })
type BookmarkData = z.infer<typeof FileSchema>

const rootFolder = (id: string, title: string, at: number): BookmarkFolder => ({ id, kind: 'folder', title, createdAt: at, children: [] })

export interface BookmarkSuggestion {
  url: string
  title: string
}

export interface BookmarksStore {
  tree(): { bar: BookmarkFolder; other: BookmarkFolder }
  /** Bookmarks Bar children (the bar and bar folder menus). */
  barItems(): BookmarkNode[]
  find(id: string): BookmarkNode | null
  /** First bookmark with exactly this url (compared without `user:pass@`, which is never stored). */
  findByUrl(url: string): Bookmark | null
  isBookmarked(url: string): boolean
  add(input: { parentId: string; title: string; url: string; index?: number; faviconDataUrl?: string | null }): string | null
  addFolder(input: { parentId: string; title: string; index?: number }): string | null
  update(id: string, patch: { title?: string; url?: string; faviconDataUrl?: string | null }): boolean
  /** Reject moves of the roots, or of a folder into itself or its descendants. */
  move(id: string, parentId: string, index?: number): boolean
  /** Deleting a folder removes its subtree. Roots cannot be deleted. */
  remove(id: string): boolean
  /** Remove every bookmark with this url (bookmark star toggle off). */
  removeByUrl(url: string): number
  /** First n bookmarks in bar-then-other depth-first order (new tab page). */
  top(limit?: number): Bookmark[]
  suggest(prefix: string, limit?: number): BookmarkSuggestion[]
  readonly store: JsonStore<BookmarkData>
}

export function createBookmarksStore(file: string | null, opts: { now?: () => number; debounceMs?: number } = {}): BookmarksStore {
  const now = opts.now ?? Date.now
  const store = createJsonStore<BookmarkData>({
    file,
    schema: FileSchema,
    defaults: () => ({ bar: rootFolder(BOOKMARK_BAR_ID, 'Bookmarks Bar', now()), other: rootFolder(BOOKMARK_OTHER_ID, 'Other Bookmarks', now()) }),
    debounceMs: opts.debounceMs
  })
  // Roots always keep their fixed ids.
  const d0 = store.get()
  if (d0.bar.id !== BOOKMARK_BAR_ID || d0.other.id !== BOOKMARK_OTHER_ID) {
    store.update((d) => {
      d.bar.id = BOOKMARK_BAR_ID
      d.other.id = BOOKMARK_OTHER_ID
    })
  }

  const roots = (): BookmarkFolder[] => [store.get().bar, store.get().other]

  function* walk(nodes: readonly BookmarkNode[]): Generator<BookmarkNode> {
    for (const n of nodes) {
      yield n
      if (n.kind === 'folder') yield* walk(n.children)
    }
  }
  const all = (): Generator<BookmarkNode> => walk(roots())
  // F1: like history (Q6), bookmarks never keep `user:pass@`. Older files may hold such addresses; strip them.
  if ([...all()].some((n) => n.kind === 'bookmark' && stripUrlCredentials(n.url) !== n.url)) {
    store.update(() => {
      for (const n of all()) if (n.kind === 'bookmark') n.url = stripUrlCredentials(n.url)
    })
  }
  const byUrl = (url: string): ((n: BookmarkNode) => n is Bookmark) => {
    const u = stripUrlCredentials(url)
    return (n): n is Bookmark => n.kind === 'bookmark' && n.url === u
  }
  const find = (id: string): BookmarkNode | null => {
    for (const r of roots()) if (r.id === id) return r
    for (const n of all()) if (n.id === id) return n
    return null
  }
  const folder = (id: string): BookmarkFolder | null => {
    const n = find(id)
    return n && n.kind === 'folder' ? n : null
  }
  const clampIndex = (len: number, i?: number): number => (i === undefined ? len : Math.max(0, Math.min(i, len)))
  const detach = (id: string): BookmarkNode | null => {
    const search = (f: BookmarkFolder): BookmarkNode | null => {
      const i = f.children.findIndex((c) => c.id === id)
      if (i >= 0) return f.children.splice(i, 1)[0] ?? null
      for (const c of f.children) if (c.kind === 'folder') { const r = search(c); if (r) return r }
      return null
    }
    for (const r of roots()) { const hit = search(r); if (hit) return hit }
    return null
  }

  return {
    tree: () => store.get(),
    barItems: () => store.get().bar.children,
    find,
    findByUrl(url) {
      const hit = byUrl(url)
      for (const n of all()) if (hit(n)) return n
      return null
    },
    isBookmarked(url) {
      const hit = byUrl(url)
      for (const n of all()) if (hit(n)) return true
      return false
    },
    add({ parentId, title, url, index, faviconDataUrl = null }) {
      if (!folder(parentId)) return null
      const id = randomUUID()
      store.update(() => {
        const p = folder(parentId)!
        p.children.splice(clampIndex(p.children.length, index), 0, { id, kind: 'bookmark', title, url: stripUrlCredentials(url), faviconDataUrl, createdAt: now() })
      })
      return id
    },
    addFolder({ parentId, title, index }) {
      if (!folder(parentId)) return null
      const id = randomUUID()
      store.update(() => {
        const p = folder(parentId)!
        p.children.splice(clampIndex(p.children.length, index), 0, { id, kind: 'folder', title, createdAt: now(), children: [] })
      })
      return id
    },
    update(id, patch) {
      const n = find(id)
      if (!n || id === BOOKMARK_BAR_ID || id === BOOKMARK_OTHER_ID) return false
      store.update(() => {
        if (patch.title !== undefined) n.title = patch.title
        if (n.kind === 'bookmark') {
          if (patch.url !== undefined) n.url = stripUrlCredentials(patch.url)
          if (patch.faviconDataUrl !== undefined) n.faviconDataUrl = patch.faviconDataUrl
        }
      })
      return true
    },
    move(id, parentId, index) {
      if (id === BOOKMARK_BAR_ID || id === BOOKMARK_OTHER_ID) return false
      const node = find(id)
      const target = folder(parentId)
      if (!node || !target) return false
      if (node.kind === 'folder') {
        if (node.id === parentId) return false
        for (const n of walk(node.children)) if (n.id === parentId) return false
      }
      store.update(() => {
        // Index is relative to the destination list as it stands once the node has been lifted out.
        detach(id)
        target.children.splice(clampIndex(target.children.length, index), 0, node)
      })
      return true
    },
    remove(id) {
      if (id === BOOKMARK_BAR_ID || id === BOOKMARK_OTHER_ID || !find(id)) return false
      store.update(() => void detach(id))
      return true
    },
    removeByUrl(url) {
      const ids = [...all()].filter(byUrl(url)).map((n) => n.id)
      if (ids.length) store.update(() => void ids.forEach(detach))
      return ids.length
    },
    top(limit = 8) {
      const out: Bookmark[] = []
      for (const n of all()) {
        if (out.length >= limit) break
        if (n.kind === 'bookmark') out.push(n)
      }
      return out
    },
    suggest(prefix, limit = 5) {
      const p = prefix.trim().toLowerCase()
      if (!p) return []
      const out: BookmarkSuggestion[] = []
      for (const n of all()) {
        if (out.length >= limit) break
        if (n.kind !== 'bookmark') continue
        if (n.title.toLowerCase().includes(p) || n.url.replace(/^[a-z]+:\/\/(www\.)?/i, '').toLowerCase().startsWith(p)) {
          out.push({ url: n.url, title: n.title })
        }
      }
      return out
    },
    store
  }
}
