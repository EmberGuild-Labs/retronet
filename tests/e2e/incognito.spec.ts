// AC13 (Cmd+Shift+N opens an in-memory incognito window, marked in every skin), AC14 (no history, bookmark-visit,
// download-history, cookies/storage/cache on disk; closing the last window destroys the data), AC15 (isolated from
// the regular session, never restored). Also S4: no incognito page title reaches macOS Saved Application State.
import { test, settle, expect, launchApp, poll, SKIN_IDS, mainLogErrors, type RN } from './helpers/launch'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

function walk(dir: string, out: Record<string, string> = {}, root = dir): Record<string, string> {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, root)
    else {
      try {
        const st = statSync(p)
        out[relative(root, p)] = `${st.mtimeMs}:${st.size}`
      } catch {
        /* vanished */
      }
    }
  }
  return out
}

function filesContaining(dir: string, needle: string): string[] {
  return Object.keys(walk(dir)).filter((rel) => {
    try {
      return readFileSync(join(dir, rel)).includes(needle)
    } catch {
      return false
    }
  })
}

async function incognitoWindows(rn: RN): Promise<number[]> {
  return (await rn.windows()).filter((w) => w.incognito).map((w) => w.id)
}

test('Cmd+Shift+N opens an incognito window, marked in every skin', async ({ rn }) => {
  await rn.press('N', ['meta', 'shift'], 'shell')
  const [id] = await poll(async () => {
    const ids = await incognitoWindows(rn)
    return ids.length === 1 ? ids : null
  }, 'incognito window')
  const w = await rn.waitWindowReady(id)
  expect(w.snapshot.incognito).toBe(true)
  expect(await rn.profiles<Array<{ partition: string }>>('incognito')).toHaveLength(1)
  const part = await rn.profiles<string>('partitionOfWindow', id)
  expect(part.startsWith('persist:')).toBe(false)
  expect(await rn.main(({ session }, p: string) => session.fromPartition(p).isPersistent(), part)).toBe(false)

  for (const skin of SKIN_IDS) {
    await rn.shell('commands.run', { id: 'skin.switch', arg: skin }, id)
    const marked = await poll(
      () =>
        rn.js<{ attr: string | null; badge: boolean; skin: string | undefined } | null>(
          w.shellId,
          `(() => { const b = document.querySelector('.rn-incognito-badge'); const cs = b && getComputedStyle(b); const r = b && b.getBoundingClientRect();
            const out = { attr: document.documentElement.getAttribute('data-incognito'), badge: !!(b && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0), skin: document.documentElement.dataset.skin };
            return out.skin === ${JSON.stringify(skin)} ? out : null })()`
        ),
      `skin ${skin} applied in incognito`
    )
    expect(marked, `incognito marked in ${skin}`).toEqual({ attr: 'true', badge: true, skin })
  }
  // The regular window is not marked.
  const regular = (await rn.windows()).find((x) => !x.incognito)!
  const plain = await rn.js<{ attr: string | null; badge: boolean }>(
    regular.shellId,
    `(() => { const b = document.querySelector('.rn-incognito-badge'); return { attr: document.documentElement.getAttribute('data-incognito'), badge: !!(b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0) } })()`
  )
  expect(plain).toEqual({ attr: 'false', badge: false })
})

/** Waits until the file tree under `dir` stops changing (cookie/session writes finished). */
async function stableWalk(dir: string): Promise<void> {
  let prev = ''
  await poll(() => {
    const cur = JSON.stringify(walk(dir))
    const same = cur === prev
    prev = cur
    return same
  }, 'user-data tree stable', 10_000, 300)
}

test('incognito leaves nothing on disk, is isolated, and is gone after the last window closes', async ({ server }) => {
  let rn = await launchApp()
  const ud = rn.userData
  const token = `incogsecret${Date.now()}`
  try {
    // Regular browsing first, so the profile's files exist; flush them to get a stable baseline.
    await rn.navigate(`${server.base}/set?v=regular`)
    await rn.main(async ({ session }) => session.fromPartition('persist:p-default').cookies.flushStore())
    await rn.flush()
    await stableWalk(ud)
    const before = walk(ud)

    const wi = await rn.profiles<number>('newIncognitoWindow', 'default', `${server.base}/set?v=${token}`)
    await rn.waitWindowReady(wi)
    // Visit, title, localStorage, a bookmark visit and a download, all inside incognito.
    await rn.navigate(`${server.base}/title?t=${token}-title`, { windowId: wi })
    await rn.tabJs(`localStorage.setItem('k', ${JSON.stringify(token)}); true`, wi)
    await rn.shell('tabs.navigate', { input: `${server.base}/download?name=${token}.txt` }, wi)
    await poll(() => existsSync(join(rn.downloadsDir, `${token}.txt`)), 'incognito download saved')

    // AC15: the regular session can't see the incognito cookie, and vice versa.
    await rn.profiles('newWindow', 'default', `${server.base}/echo?tag=regular-after`)
    await poll(() => 'regular-after' in server.seen, 'regular echo')
    expect(server.seen['regular-after']).toBe('who=regular')
    const wi2 = await rn.profiles<number>('newIncognitoWindow', 'default', `${server.base}/echo?tag=incog-2`)
    await poll(() => 'incog-2' in server.seen, 'incognito echo')
    expect(server.seen['incog-2']).toBe(`who=${token}`)
    await rn.waitWindowReady(wi2)

    // History/downloads pages inside incognito read memory stores only (empty of regular data, no writes).
    const dl = await rn.openInternal('downloads', wi)
    const items = await rn.bridge<{ items: Array<{ filename: string }> }>(dl, 'downloads.list', {})
    expect(items.ok).toBe(true)

    // S4: window titles of incognito windows never carry the page title.
    const titles = await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((b) => b.getTitle()))
    await rn.navigate(`${server.base}/title?t=${token}-title`, { windowId: wi2 })
    await settle(200, 'incognito page title must not reach any window title')
    const titles2 = await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((b) => b.getTitle()))
    expect([...titles, ...titles2].filter((t) => t.includes(token)), 'incognito page title in a window title (S4)').toEqual([])

    // Close every incognito window: the in-memory partition is dropped and its cookies are gone.
    const part = await rn.profiles<string>('partitionOfWindow', wi)
    await rn.main(({ BrowserWindow, webContents }) => {
      for (const w of (globalThis as any).__rn.windows()) if (w.incognito) BrowserWindow.fromWebContents(webContents.fromId(w.shellId)!)?.close()
    })
    await poll(async () => (await rn.profiles<unknown[]>('incognito')).length === 0, 'incognito group destroyed')
    expect(await rn.main(async ({ session }, p: string) => (await session.fromPartition(p).cookies.get({})).length, part)).toBe(0)
    const wi3 = await rn.profiles<number>('newIncognitoWindow', 'default', `${server.base}/echo?tag=incog-3`)
    await poll(() => 'incog-3' in server.seen, 'fresh incognito echo')
    expect(server.seen['incog-3']).toBe('')
    await rn.waitWindowReady(wi3)

    await rn.main(async ({ session }) => session.fromPartition('persist:p-default').cookies.flushStore())
    await rn.flush()
    await rn.quit()

    // AC14: nothing incognito on disk. JSON stores unchanged except the regular window's session/history;
    // no file mentions the token (cookie value, URL, title, localStorage, download record).
    const after = walk(ud)
    expect(Object.keys(after).filter((k) => /incognito/i.test(k))).toEqual([])
    expect(filesContaining(ud, token)).toEqual([])
    const hist = JSON.parse(readFileSync(join(ud, 'Profiles', 'default', 'history.json'), 'utf8')) as { entries: Array<{ url: string }> }
    expect(hist.entries.some((e) => e.url.includes(token))).toBe(false)
    const dlFile = join(ud, 'Profiles', 'default', 'downloads.json')
    if (existsSync(dlFile)) expect(readFileSync(dlFile, 'utf8')).not.toContain(token)
    // No new partition (Chromium storage dir) appeared besides the regular profile's own.
    const added = Object.keys(after).filter((k) => !(k in before))
    test.info().annotations.push({ type: 'files added during incognito', description: added.join(', ') || '(none)' })
    expect(added.filter((k) => k.startsWith('Partitions/') && !k.startsWith('Partitions/p-default/'))).toEqual([])
    expect(added.filter((k) => k.startsWith('Profiles/') && !k.startsWith('Profiles/default/'))).toEqual([])

    // S4: macOS Saved Application State (dev runs as Electron's bundle id; packaged as xyz.proxnode.retronet).
    if (process.platform === 'darwin') {
      const sas = join(homedir(), 'Library', 'Saved Application State')
      for (const id of ['xyz.proxnode.retronet.savedState', 'com.github.Electron.savedState']) {
        expect(filesContaining(join(sas, id), token), `${id} holds an incognito title`).toEqual([])
      }
    }

    // AC15: relaunch restores no incognito window or URL.
    rn = await launchApp({ userData: ud })
    await rn.waitWindowReady()
    await settle(500, 'no incognito window should be restored')
    const wins = await rn.windows()
    expect(wins.some((w) => w.incognito)).toBe(false)
    const urls = (await rn.main(() => (globalThis as any).__rn.webContents() as Array<{ url: string }>)).map((x) => x.url)
    expect(urls.filter((u) => u.includes(token))).toEqual([])
    expect(mainLogErrors(rn.mainLog())).toEqual([])
  } finally {
    await rn.quit().catch(() => rn.kill())
    rmSync(ud, { recursive: true, force: true })
  }
})

test('incognito counter and history stay in memory', async ({ rn, server }) => {
  const wi = await rn.profiles<number>('newIncognitoWindow', 'default')
  await rn.waitWindowReady(wi)
  const nt = await rn.openInternal('newtab', wi)
  expect(await rn.bridge(nt, 'counter.hit', {})).toMatchObject({ ok: true, data: { value: null } })
  await rn.navigate(`${server.base}/title?t=IncogVisit`, { windowId: wi })
  const h = await rn.openInternal('history', wi)
  const q = await rn.bridge<{ entries: Array<{ url: string }> }>(h, 'history.query', {})
  expect(q.ok).toBe(true)
  // The regular profile's history never sees the incognito visit.
  const hr = await rn.openInternal('history')
  const qr = await rn.bridge<{ entries: Array<{ url: string }> }>(hr, 'history.query', {})
  expect(qr.data!.entries.some((e) => e.url.includes('IncogVisit'))).toBe(false)
})
