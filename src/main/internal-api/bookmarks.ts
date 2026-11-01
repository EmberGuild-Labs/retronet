// retronet://bookmarks and the new-tab "top sites" handlers (T19). A store returning null/false (unknown id,
// bad parent, move into itself, root edits) becomes E_NOT_FOUND. Every change refreshes the profile's windows so
// the bookmark bar and the omnibox star follow:
// that push lives in bookmarks/changes.ts, which hooks the store itself, so it covers every caller (including
// T16's bookmarks.toggleCurrent). This module also registers the shell's bookmark bar handlers.
import { registerBookmarkBarHandlers } from '../bookmarks/bar'
import { watchAllWindowBookmarks, watchBookmarks } from '../bookmarks/changes'
import { IpcFailure, router, type CallContext } from '../ipc/router'
import { profileOf as callerProfile } from './misc'
import type { ProfileContext } from '../types'

/** The caller's profile, with its bookmark store hooked for change pushes (also done for all windows at register time). */
function profileOf(ctx: CallContext): ProfileContext {
  const p = callerProfile(ctx)
  watchBookmarks(p.stores.bookmarks)
  return p
}

function notFound(what: string): never {
  throw new IpcFailure('E_NOT_FOUND', what)
}

export function registerBookmarkHandlers(): void {
  registerBookmarkBarHandlers()
  watchAllWindowBookmarks()

  router.handle('bookmarks.top', (req, ctx) => ({ items: profileOf(ctx).stores.bookmarks.top(req.limit) }))

  router.handle('bookmarks.tree', (_req, ctx) => profileOf(ctx).stores.bookmarks.tree())

  router.handle('bookmarks.add', (req, ctx) => {
    const p = profileOf(ctx)
    const id = p.stores.bookmarks.add({ parentId: req.parentId, title: req.title, url: req.url, index: req.index })
    if (id === null) notFound('No such folder')
    return { id }
  })

  router.handle('bookmarks.addFolder', (req, ctx) => {
    const p = profileOf(ctx)
    const id = p.stores.bookmarks.addFolder({ parentId: req.parentId, title: req.title, index: req.index })
    if (id === null) notFound('No such folder')
    return { id }
  })

  router.handle('bookmarks.update', (req, ctx) => {
    const p = profileOf(ctx)
    if (!p.stores.bookmarks.update(req.id, { title: req.title, url: req.url })) notFound('No such bookmark')
    return null
  })

  router.handle('bookmarks.move', (req, ctx) => {
    const p = profileOf(ctx)
    if (!p.stores.bookmarks.move(req.id, req.parentId, req.index)) notFound('Cannot move there')
    return null
  })

  router.handle('bookmarks.remove', (req, ctx) => {
    const p = profileOf(ctx)
    if (!p.stores.bookmarks.remove(req.id)) notFound('No such bookmark')
    return null
  })
}
