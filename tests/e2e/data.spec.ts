// AC16 bookmarks (Cmd+D, edit/delete, folders, bar toggle Cmd+Shift+B, manager page), AC17 history (recorded,
// search, delete one, clear all), AC18 downloads (start, progress, pause/resume, cancel, listed + persisted,
// downloads folder; S1 quarantine xattr), AC19 settings (round trip + persistence, clear browsing data).
import { test, expect, poll, settle } from './helpers/launch'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Node {
  id: string
  kind: 'bookmark' | 'folder'
  title: string
  url?: string
  children?: Node[]
}
interface Tree {
  bar: Node
  other: Node
}
interface Dl {
  id: string
  filename: string
  path: string
  state: string
  receivedBytes: number
  totalBytes: number
}

test('bookmarks: Cmd+D, manager page CRUD with folders, bar toggle', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Bookmark%20Me`)
  await rn.press('D', ['meta'], 'tab')
  let s = await rn.waitSnap((s) => rn.active(s).bookmarked, 'star on after Cmd+D')
  const pageUrl = rn.active(s).url

  const bmTab = (await rn.shell<{ tabId: number }>('tabs.create', { url: 'retronet://bookmarks/' })).tabId
  await rn.waitSnap((s) => s.activeTabId === bmTab && !rn.active(s).loading, 'bookmarks tab')
  const bm = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(bm, `typeof window.retronet === 'object'`), 'bookmarks bridge')
  let tree = (await rn.bridge<Tree>(bm, 'bookmarks.tree', {})).data!
  const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)]
  const mine = [...all(tree.bar), ...all(tree.other)].find((n) => n.url === pageUrl)
  expect(mine, 'Cmd+D bookmark in the tree').toBeTruthy()
  expect(mine!.title).toBe('Bookmark Me')

  const folder = (await rn.bridge<{ id: string }>(bm, 'bookmarks.addFolder', { parentId: 'bar', title: 'Retro' })).data!.id
  const added = await rn.bridge<{ id: string }>(bm, 'bookmarks.add', { parentId: folder, title: 'Page B', url: `${server.base}/b` })
  expect(added.ok).toBe(true)
  expect((await rn.bridge(bm, 'bookmarks.update', { id: added.data!.id, title: 'Page B (edited)' })).ok).toBe(true)
  expect((await rn.bridge(bm, 'bookmarks.move', { id: mine!.id, parentId: folder })).ok).toBe(true)
  tree = (await rn.bridge<Tree>(bm, 'bookmarks.tree', {})).data!
  const f = tree.bar.children!.find((n) => n.id === folder)!
  expect(f.kind).toBe('folder')
  expect(f.children!.map((n) => n.title).sort()).toEqual(['Bookmark Me', 'Page B (edited)'])
  expect(await rn.bridge(bm, 'bookmarks.move', { id: folder, parentId: folder })).toMatchObject({ ok: false, code: 'E_NOT_FOUND' })
  expect(await rn.bridge(bm, 'bookmarks.add', { parentId: 'bar', title: 'x', url: 'javascript:alert(1)' })).toMatchObject({ ok: false })

  // Removing the starred bookmark clears the star on its tab.
  expect((await rn.bridge(bm, 'bookmarks.remove', { id: mine!.id })).ok).toBe(true)
  s = await rn.waitSnap((s) => s.tabs.some((t) => t.url === pageUrl && !t.bookmarked), 'star off after remove')

  // Bookmark bar: the shell reads its items (FIX-GAPS bookmarks.bar handler) ...
  const bar = await rn.shellCall<{ items: Node[] }>('bookmarks.bar', {})
  expect(bar.ok, `bookmarks.bar: ${JSON.stringify(bar)}`).toBe(true)
  expect(bar.data!.items.some((n) => n.id === folder)).toBe(true)
  // ... and Cmd+Shift+B toggles it, persisted in settings.
  const before = (await rn.snap()).bookmarkBar
  await rn.press('B', ['meta', 'shift'], 'shell')
  await rn.waitSnap((s) => s.bookmarkBar === !before, 'bookmark bar toggled')
  await rn.flush(join(rn.userData, 'Profiles', 'default', 'settings.json'), (j) => j.bookmarkBar === !before, 'bookmarkBar persisted')
  const settings = JSON.parse(readFileSync(join(rn.userData, 'Profiles', 'default', 'settings.json'), 'utf8'))
  expect(settings.bookmarkBar).toBe(!before)
})

test('history: recorded per visit, searchable, delete one, clear all', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Alpha%20Page`)
  await rn.navigate(`${server.base}/title?t=Beta%20Page`)
  await rn.navigate(`${server.base}/title?t=Gamma%20Page`)
  const h = await rn.openInternal('history')
  let q = await rn.bridge<{ entries: Array<{ id: number; url: string; title: string; visitedAt: number }>; total: number }>(h, 'history.query', {})
  expect(q.ok).toBe(true)
  const titles = q.data!.entries.map((e) => e.title)
  expect(titles.slice(0, 3)).toEqual(['Gamma Page', 'Beta Page', 'Alpha Page']) // newest first
  expect(q.data!.entries.some((e) => e.url.startsWith('retronet:'))).toBe(false)

  q = await rn.bridge(h, 'history.query', { text: 'beta' })
  expect(q.data!.entries.map((e) => e.title)).toEqual(['Beta Page'])
  const beta = q.data!.entries[0]!
  expect((await rn.bridge(h, 'history.delete', { id: beta.id })).ok).toBe(true)
  q = await rn.bridge(h, 'history.query', {})
  expect(q.data!.entries.some((e) => e.id === beta.id)).toBe(false)
  expect(await rn.bridge(h, 'history.delete', { id: 999999 })).toMatchObject({ ok: false, code: 'E_NOT_FOUND' })

  expect((await rn.bridge(h, 'history.clear', {})).ok).toBe(true)
  q = await rn.bridge(h, 'history.query', {})
  expect(q.data!.total).toBe(0)
  await rn.flush(join(rn.userData, 'Profiles', 'default', 'history.json'), (j) => Array.isArray(j.entries) && j.entries.length === 0, 'history cleared on disk')
  const disk = JSON.parse(readFileSync(join(rn.userData, 'Profiles', 'default', 'history.json'), 'utf8'))
  expect(disk.entries).toEqual([])
})

test('downloads: complete with quarantine, pause/resume, cancel, listed and persisted', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  await rn.shell('tabs.navigate', { input: `${server.base}/download?name=hello.txt&size=100` })
  const file = join(rn.downloadsDir, 'hello.txt')
  await poll(() => existsSync(file) && statSync(file).size === 100, 'hello.txt saved')

  const dl = (await rn.shell<{ tabId: number }>('tabs.create', { url: 'retronet://downloads/' })).tabId
  await rn.waitSnap((s) => s.activeTabId === dl && !rn.active(s).loading, 'downloads tab')
  const page = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(page, `typeof window.retronet === 'object'`), 'downloads bridge')
  const list = async () => (await rn.bridge<{ items: Dl[] }>(page, 'downloads.list', {})).data!.items
  const hello = await poll(async () => (await list()).find((i) => i.filename === 'hello.txt' && i.state === 'completed'), 'completed record')
  expect(hello.path).toBe(file)

  // S1: downloaded files carry com.apple.quarantine so Gatekeeper checks them.
  if (process.platform === 'darwin') {
    let q = ''
    try {
      q = execFileSync('xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf8' })
    } catch {
      q = ''
    }
    expect(q, 'com.apple.quarantine on the downloaded file').not.toBe('')
  }

  // Slow download: progress, pause (no progress), resume to completion.
  await rn.shellCall('tabs.navigate', { input: `${server.base}/download-slow?name=slow.bin` })
  await rn.shell('tabs.activate', { tabId: dl })
  const slow = await poll(async () => (await list()).find((i) => i.filename === 'slow.bin' && i.state === 'progressing' && i.receivedBytes > 0), 'slow progressing')
  expect((await rn.bridge(page, 'downloads.pause', { id: slow.id })).ok).toBe(true)
  const paused = await poll(async () => (await list()).find((i) => i.id === slow.id && i.state === 'paused'), 'paused')
  await settle(600, 'paused download must not make progress')
  const still = (await list()).find((i) => i.id === slow.id)!
  expect(still.state).toBe('paused')
  expect(still.receivedBytes - paused.receivedBytes).toBeLessThan(200_000)
  expect((await rn.bridge(page, 'downloads.resume', { id: slow.id })).ok).toBe(true)
  const done = await poll(async () => (await list()).find((i) => i.id === slow.id && i.state === 'completed'), 'resumed + completed', 30_000)
  expect(statSync(done.path).size).toBe(2_000_000)

  // Cancel removes the partial file.
  const other = await rn.profiles<number>('newWindow', 'default', `${server.base}/download-slow?name=cancel.bin`)
  void other
  const c = await poll(async () => (await list()).find((i) => i.filename === 'cancel.bin' && i.state === 'progressing' && i.receivedBytes > 0), 'cancel.bin progressing')
  expect((await rn.bridge(page, 'downloads.cancel', { id: c.id })).ok).toBe(true)
  await poll(async () => (await list()).find((i) => i.id === c.id && i.state === 'cancelled'), 'cancelled')
  await poll(() => !existsSync(join(rn.downloadsDir, 'cancel.bin')), 'partial file removed after cancel')
  expect(existsSync(join(rn.downloadsDir, 'cancel.bin'))).toBe(false)
  expect(await rn.bridge(page, 'downloads.cancel', { id: 'nope' })).toMatchObject({ ok: false, code: 'E_NOT_FOUND' })

  // Persisted per profile.
  await rn.flush(join(rn.userData, 'Profiles', 'default', 'downloads.json'), (j) => ['hello.txt', 'slow.bin', 'cancel.bin'].every((n) => (j.items ?? []).some((i: Dl) => i.filename === n)), 'downloads persisted')
  const disk = JSON.parse(readFileSync(join(rn.userData, 'Profiles', 'default', 'downloads.json'), 'utf8')) as { items: Dl[] }
  expect(disk.items.map((i) => i.filename).sort()).toEqual(expect.arrayContaining(['hello.txt', 'slow.bin', 'cancel.bin']))

  // Clear finished entries (files stay on disk).
  expect((await rn.bridge(page, 'downloads.clear', {})).ok).toBe(true)
  expect((await list()).filter((i) => i.state === 'completed')).toEqual([])
  expect(existsSync(file)).toBe(true)
})

test('settings: round trip, validation, persistence and clear browsing data', async ({ rn, server }) => {
  const st = await rn.openInternal('settings')
  const cur = await rn.bridge<Record<string, unknown>>(st, 'settings.get', {})
  expect(cur.data).toMatchObject({ skin: 'y1997', searchEngine: 'duckduckgo', homePage: 'retronet://newtab/', startup: 'restore', downloadsDir: null, reducedMotion: false })

  const home = `${server.base}/title?t=Home%20Sweet%20Home`
  const set = await rn.bridge<Record<string, unknown>>(st, 'settings.set', { searchEngine: 'bing', homePage: home, startup: 'newtab' })
  expect(set.data).toMatchObject({ searchEngine: 'bing', homePage: home, startup: 'newtab' })
  expect(await rn.bridge(st, 'settings.set', { homePage: 'javascript:alert(1)' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.bridge(st, 'settings.set', { searchEngine: 'evil' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.bridge(st, 'settings.set', { downloadsDir: '/etc' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  await rn.flush(join(rn.userData, 'Profiles', 'default', 'settings.json'), (j) => j.searchEngine === 'bing' && j.homePage === home, 'settings persisted')
  const disk = JSON.parse(readFileSync(join(rn.userData, 'Profiles', 'default', 'settings.json'), 'utf8'))
  expect(disk).toMatchObject({ searchEngine: 'bing', homePage: home, startup: 'newtab' })

  // Home uses the configured home page.
  await rn.shell('tabs.home', {})
  await rn.waitSnap((s) => rn.active(s).url === home && !rn.active(s).loading, 'home page from settings')

  // Clear browsing data: history + cookies.
  await rn.navigate(`${server.base}/set?v=clearme`)
  const st2 = await rn.openInternal('settings')
  expect((await rn.bridge(st2, 'data.clear', { history: true, downloads: true, cookies: true, cache: true, range: 'all' })).ok).toBe(true)
  const cookies = await rn.main(async ({ session }) => (await session.fromPartition('persist:p-default').cookies.get({})).length)
  expect(cookies).toBe(0)
  const hist = await rn.openInternal('history')
  expect((await rn.bridge<{ total: number }>(hist, 'history.query', {})).data!.total).toBe(0)

  // Per-site permission list is reachable (empty here).
  const st3 = await rn.openInternal('settings')
  expect(await rn.bridge(st3, 'permissions.list', {})).toMatchObject({ ok: true, data: { items: [] } })
})
