import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ handlers: new Map<string, (req: unknown, ctx: unknown) => Promise<any>>(), store: null as any, win: { id: 1 } }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: { showOpenDialog: () => { throw new Error('real dialog!') }, showSaveDialog: () => { throw new Error('real dialog!') } } }))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: class IpcFailure extends Error {
    constructor(readonly code: string, m: string) { super(m) }
  },
  router: { handle: (m: string, fn: any) => h.handlers.set(m, fn) }
}))
vi.mock('../../src/main/internal-api/misc', () => ({
  windowOf: () => ({ win: h.win }),
  profileOf: () => ({ stores: { bookmarks: h.store } })
}))

import { BOOKMARK_IMPORT_MAX_BYTES, IMPORT_ERRORS } from '../../src/shared/bookmarks-import'
import { registerBookmarksIoHandlers } from '../../src/main/internal-api/bookmarks-io'
import { setNativeDialogsForTests } from '../../src/main/native-dialogs'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'

let dir: string
let nextOpen: string | null
let nextSave: string | null
let gate: Promise<void> | null
const call = (m: string): Promise<any> => h.handlers.get(m)!({}, {})
const page = (body: string): string => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${body}</DL><p>`
const a = (u: string, t = 't'): string => `<DT><A HREF="${u}">${t}</A>\n`
const importFile = (text: string): void => { nextOpen = join(dir, 'in.html'); writeFileSync(nextOpen, text) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-bmio-'))
  h.store = createBookmarksStore(null)
  nextOpen = nextSave = null
  gate = null
  setNativeDialogsForTests({
    open: async () => { await gate; return nextOpen },
    save: async () => { await gate; return nextSave }
  })
  registerBookmarksIoHandlers()
})
afterEach(() => {
  setNativeDialogsForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('bookmarks.import', () => {
  it('cancel returns cancelled and changes nothing', async () => {
    expect(await call('bookmarks.import')).toEqual({ status: 'cancelled' })
    expect(h.store.tree().other.children).toEqual([])
  })

  it('imports into Imported, counts unsupported and duplicates', async () => {
    h.store.add({ parentId: 'bar', title: 'x', url: 'https://have.example/' })
    importFile(page(a('https://have.example/') + a('https://new.example/') + a('https://new.example/') + a('javascript:alert(1)') + a('ftp://x/')))
    const r = await call('bookmarks.import')
    expect(r).toMatchObject({ status: 'imported', folderTitle: 'Imported', added: 1, duplicates: 2, unsupported: 2, truncated: false })
    expect(h.store.tree().other.children[0]).toMatchObject({ kind: 'folder', title: 'Imported' })
  })

  it('uses "Imported (2)" when Imported exists, then (3)', async () => {
    importFile(page(a('https://a.example/')))
    expect((await call('bookmarks.import')).folderTitle).toBe('Imported')
    importFile(page(a('https://b.example/')))
    expect((await call('bookmarks.import')).folderTitle).toBe('Imported (2)')
    importFile(page(a('https://c.example/')))
    expect((await call('bookmarks.import')).folderTitle).toBe('Imported (3)')
  })

  it('is a single store mutation', async () => {
    const spy = vi.spyOn(h.store.store, 'update')
    importFile(page(a('https://a.example/') + a('https://b.example/')))
    await call('bookmarks.import')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversize file before reading it', async () => {
    nextOpen = join(dir, 'big.html')
    writeFileSync(nextOpen, '')
    const fs = await import('node:fs')
    fs.truncateSync(nextOpen, BOOKMARK_IMPORT_MAX_BYTES + 1) // sparse
    await expect(call('bookmarks.import')).rejects.toMatchObject({ code: 'E_INVALID', message: IMPORT_ERRORS.tooLarge })
  })

  it('rejects non-bookmark files and missing files', async () => {
    importFile('hello world')
    await expect(call('bookmarks.import')).rejects.toMatchObject({ code: 'E_INVALID', message: IMPORT_ERRORS.notBookmarks })
    nextOpen = join(dir, 'missing.html')
    await expect(call('bookmarks.import')).rejects.toMatchObject({ code: 'E_INVALID', message: IMPORT_ERRORS.unreadable })
    nextOpen = dir
    await expect(call('bookmarks.import')).rejects.toMatchObject({ code: 'E_INVALID', message: IMPORT_ERRORS.notAFile })
  })

  it('a file with no http(s) bookmarks leaves the tree unchanged (R23)', async () => {
    h.store.add({ parentId: 'bar', title: 'x', url: 'https://have.example/' })
    const before = JSON.stringify(h.store.tree())
    importFile(page(a('javascript:alert(1)') + a('ftp://x/') + a('https://have.example/')))
    const r = await call('bookmarks.import')
    expect(r).toMatchObject({ status: 'imported', added: 0, duplicates: 1, unsupported: 2 })
    expect(r.folderId).toBe('other')
    expect(JSON.stringify(h.store.tree())).toBe(before)
  })

  it('handles a large file and sets truncated at the parser cap', async () => {
    let body = ''
    for (let i = 0; i < 21_000; i++) body += a(`https://h${i}.example/`)
    importFile(page(body))
    const t0 = Date.now()
    const r = await call('bookmarks.import')
    expect(r.added).toBe(20_000)
    expect(r.truncated).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('a second concurrent call returns E_UNAVAILABLE', async () => {
    let release!: () => void
    gate = new Promise((r) => (release = r))
    const first = call('bookmarks.import')
    await expect(call('bookmarks.export')).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    release()
    expect(await first).toEqual({ status: 'cancelled' })
    expect(await call('bookmarks.import')).toEqual({ status: 'cancelled' })
  })
})

describe('store.importFolder cap', () => {
  it('stops at 50,000 and reports truncated', () => {
    const s = createBookmarksStore(null)
    const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'bookmark' as const, title: 't', url: `https://x${from + i}.example/` }))
    expect(s.importFolder('Imported', mk(0, 20_000)).truncated).toBe(false)
    expect(s.importFolder('Imported', mk(20_000, 20_000)).truncated).toBe(false)
    const r = s.importFolder('Imported', mk(40_000, 20_000))
    expect(r).toMatchObject({ added: 10_000, truncated: true })
    expect(s.allUrls().size).toBe(50_000)
  })

  it('adds nothing and creates no folder for an empty or all-duplicate import (R23)', () => {
    const s = createBookmarksStore(null)
    s.add({ parentId: 'bar', title: 'x', url: 'https://a.example/' })
    const before = JSON.stringify(s.tree())
    expect(s.importFolder('Imported', [])).toMatchObject({ added: 0, folderId: 'other' })
    expect(s.importFolder('Imported', [{ kind: 'folder', title: 'f', children: [{ kind: 'bookmark', title: 't', url: 'https://a.example/' }] }])).toMatchObject({ added: 0, duplicates: 1 })
    expect(JSON.stringify(s.tree())).toBe(before)
  })

  it('walks the existing tree once (R28)', () => {
    const s = createBookmarksStore(null)
    const N = 50
    for (let i = 0; i < N; i++) s.add({ parentId: 'bar', title: 't', url: `https://e${i}.example/` })
    let reads = 0
    for (const n of s.tree().bar.children) {
      const kind = n.kind
      Object.defineProperty(n, 'kind', { get: () => { reads++; return kind }, configurable: true })
    }
    s.importFolder('Imported', [{ kind: 'bookmark', title: 't', url: 'https://new.example/' }])
    expect(reads).toBeGreaterThan(N)
    expect(reads).toBeLessThanOrEqual(2 * N)
  })

  it('strips credentials and dedupes against them', () => {
    const s = createBookmarksStore(null)
    s.add({ parentId: 'bar', title: 'x', url: 'https://a.example/' })
    const r = s.importFolder('Imported', [{ kind: 'bookmark', title: 't', url: 'https://u:p@a.example/' }])
    expect(r.duplicates).toBe(1)
  })
})

describe('bookmarks.export', () => {
  it('cancel writes nothing', async () => {
    expect(await call('bookmarks.export')).toEqual({ status: 'cancelled' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('exports then re-imports (round trip) with no temp files left', async () => {
    h.store.add({ parentId: 'bar', title: 'Bar & Co', url: 'https://bar.example/?a=1&b=2' })
    h.store.add({ parentId: 'other', title: 'O', url: 'https://other.example/' })
    nextSave = join(dir, 'out.html')
    expect(await call('bookmarks.export')).toEqual({ status: 'exported', count: 2 })
    expect(readdirSync(dir)).toEqual(['out.html'])
    expect(readFileSync(nextSave, 'utf8')).toContain('NETSCAPE-Bookmark-file-1')
    h.store = createBookmarksStore(null)
    nextOpen = nextSave
    const r = await call('bookmarks.import')
    expect(r).toMatchObject({ added: 2, duplicates: 0, unsupported: 0 })
    expect(h.store.allUrls()).toEqual(new Set(['https://bar.example/?a=1&b=2', 'https://other.example/']))
  })
})
