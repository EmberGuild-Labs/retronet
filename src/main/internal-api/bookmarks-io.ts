// retronet://bookmarks Import... / Export... (AC49, AC50). Paths never come from IPC: both requests are empty and the
// file is chosen in a native dialog parented to the caller's window. Import: size check BEFORE reading, parse, then one
// store mutation into a new "Imported" folder. Export: atomic write. Incognito windows act on the shared parent store.
import { app } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BOOKMARK_IMPORT_MAX_BYTES, IMPORT_ERRORS } from '../../shared/bookmarks-import'
import { parseNetscape, serializeNetscape } from '../bookmarks/netscape'
import { IpcFailure, router } from '../ipc/router'
import { pickOpenFile, pickSaveFile } from '../native-dialogs'
import { writeFileAtomic } from '../storage/atomic-json'
import { profileOf, windowOf } from './misc'

const FILTERS = [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }]

function countBookmarks(nodes: ReadonlyArray<{ kind: string; children?: unknown }>): number {
  let n = 0
  for (const x of nodes) {
    if (x.kind === 'bookmark') n++
    else if (Array.isArray(x.children)) n += countBookmarks(x.children)
  }
  return n
}

function defaultExportPath(): string {
  let dir: string
  try {
    dir = app.getPath('downloads')
  } catch {
    dir = app.getPath('home')
  }
  return join(dir, `bookmarks-${new Date().toISOString().slice(0, 10)}.html`)
}

export function registerBookmarksIoHandlers(): void {
  router.handle('bookmarks.import', async (_req, ctx) => {
    const win = windowOf(ctx).win
    const store = profileOf(ctx).stores.bookmarks
    const file = await pickOpenFile(win, { title: 'Import bookmarks', filters: FILTERS })
    if (!file) return { status: 'cancelled' as const }
    let size: number
    try {
      const st = await stat(file)
      if (!st.isFile()) throw new IpcFailure('E_INVALID', IMPORT_ERRORS.notAFile)
      size = st.size
    } catch (err) {
      if (err instanceof IpcFailure) throw err
      throw new IpcFailure('E_INVALID', IMPORT_ERRORS.unreadable)
    }
    if (size > BOOKMARK_IMPORT_MAX_BYTES) throw new IpcFailure('E_INVALID', IMPORT_ERRORS.tooLarge)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      throw new IpcFailure('E_INVALID', IMPORT_ERRORS.unreadable)
    }
    const parsed = parseNetscape(text)
    if (parsed.error === 'too-large') throw new IpcFailure('E_INVALID', IMPORT_ERRORS.tooLarge)
    if (parsed.error) throw new IpcFailure('E_INVALID', IMPORT_ERRORS.notBookmarks)
    const r = store.importFolder('Imported', parsed.roots)
    return {
      status: 'imported' as const,
      folderId: r.folderId,
      folderTitle: r.folderTitle,
      added: r.added,
      duplicates: r.duplicates,
      unsupported: parsed.stats.skippedTotal + r.unsupported,
      truncated: parsed.stats.truncated || r.truncated
    }
  })

  router.handle('bookmarks.export', async (_req, ctx) => {
    const win = windowOf(ctx).win
    const store = profileOf(ctx).stores.bookmarks
    const target = await pickSaveFile(win, { title: 'Export bookmarks', defaultPath: defaultExportPath(), filters: FILTERS })
    if (!target) return { status: 'cancelled' as const }
    const tree = store.tree()
    try {
      await writeFileAtomic(target, serializeNetscape(tree))
    } catch {
      throw new IpcFailure('E_INTERNAL', `Could not write ${basename(target)}`)
    }
    return { status: 'exported' as const, count: countBookmarks([...tree.bar.children, ...tree.other.children]) }
  })
}
