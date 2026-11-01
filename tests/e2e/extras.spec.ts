// PLAN-EXTRA X17: E2E for the extra round, local fixture servers only. Every window stays hidden (background test
// mode), no real native dialog is ever shown (the `__rnDialogs` hook answers them), and the dial-up sound is
// silenced in every shell before it could play (RN.silenceShell).
//   AC47 default browser (test fake) · AC48 open-url / open-file · AC49, AC50 bookmark import/export ·
//   AC51 PDF in a tab · AC52, AC53 update check · AC54 view source · AC55 dial-up trigger rules
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, launchApp, poll, settle, sleep, type RN } from './helpers/launch'
import { FIXTURES, PDF_VIEWER_ORIGIN, type FixtureServer } from './helpers/server'

interface Node {
  id: string
  kind: 'folder' | 'bookmark'
  title: string
  url?: string
  children?: Node[]
}
interface Tree {
  bar: Node
  other: Node
}

const urls = (n: Node | Node[]): string[] =>
  (Array.isArray(n) ? n : [n]).flatMap((x) => (x.kind === 'bookmark' ? [x.url!] : urls(x.children ?? [])))

async function closeQuietly(rn: RN): Promise<void> {
  await rn.quit().catch(() => rn.kill())
  rmSync(rn.userData, { recursive: true, force: true })
  rmSync(rn.downloadsDir, { recursive: true, force: true })
}

/** Every window's tab URLs, once none is still '' (X7: snapshots show '' until the first commit). */
async function allTabs(rn: RN): Promise<Array<{ id: number; incognito: boolean; urls: string[]; active: string }>> {
  return poll(async () => {
    const ws = await rn.windows()
    const out = ws.map((w) => ({
      id: w.id,
      incognito: w.incognito,
      urls: w.snapshot.tabs.map((t) => t.url),
      active: w.snapshot.tabs.find((t) => t.id === w.snapshot.activeTabId)?.url ?? ''
    }))
    return out.every((w) => w.urls.every((u) => u)) ? out : null
  }, 'committed tab urls')
}

const emitOpen = (rn: RN, kind: 'url' | 'file', value: string): Promise<void> =>
  rn.main(({ app }, a: { kind: string; value: string }) => {
    app.emit(a.kind === 'file' ? 'open-file' : 'open-url', { preventDefault() {} }, a.value)
  }, { kind, value })

// ============================== AC47: default browser ==============================

test('AC47: default browser row with the test fake: not default, click, then default', async () => {
  const rn = await launchApp({ overrides: { defaultBrowser: 'fake' } })
  try {
    const st = await rn.openInternal('settings')
    expect(await rn.page('defaultBrowser.status')).toEqual({ supported: true, isDefault: false })
    const row = () =>
      rn.js<{ text: string; hidden: boolean; disabled: boolean }>(
        st,
        `(() => { const b = document.getElementById('rn-default-btn'); return { text: document.getElementById('rn-default-text').textContent, hidden: b.hidden, disabled: b.disabled } })()`
      )
    const before = await poll(async () => {
      const r = await row()
      return r.text ? r : null
    }, 'default-browser status rendered')
    expect(before).toEqual({ text: 'RetroNet is not your default browser.', hidden: false, disabled: false })
    await rn.js(st, `document.getElementById('rn-default-btn').click()`)
    const after = await poll(async () => {
      const r = await row()
      return r.text === 'RetroNet is your default browser.' ? r : null
    }, 'status says default after the click')
    expect(after.hidden).toBe(true)
    expect(await rn.page('defaultBrowser.status')).toEqual({ supported: true, isDefault: true })
  } finally {
    await closeQuietly(rn)
  }
})

test('AC47: without the fake, an unpackaged build disables the button and explains why', async ({ rn }) => {
  const st = await rn.openInternal('settings')
  expect(await rn.page('defaultBrowser.status')).toEqual({ supported: false, isDefault: false, reason: 'unpackaged' })
  const r = await poll(
    () => rn.js<{ text: string; disabled: boolean } | null>(st, `(() => { const t = document.getElementById('rn-default-text').textContent; return t ? { text: t, disabled: document.getElementById('rn-default-btn').disabled } : null })()`),
    'status rendered'
  )
  expect(r.disabled).toBe(true)
  expect(r.text).toMatch(/installed app, not in a development build/)
  // set() is refused, not faked.
  expect(await rn.page('defaultBrowser.set')).toEqual({ requested: false, isDefault: false })
})

// ============================== AC48: opened from other apps ==============================

test('AC48: open-url opens a foreground tab in the normal window even when an incognito window is newer', async ({ rn, server }) => {
  const normal = (await rn.win()).id
  const incId = await rn.profiles<number>('newIncognitoWindow')
  await rn.waitWindowReady(incId)
  const before = await allTabs(rn)
  const incBefore = before.find((w) => w.id === incId)!.urls

  await emitOpen(rn, 'url', `${server.base}/title?t=From%20Mail`)
  const after = await poll(async () => {
    const t = await allTabs(rn)
    const n = t.find((w) => w.id === normal)!
    return n.urls.length === before.find((w) => w.id === normal)!.urls.length + 1 ? t : null
  }, 'link tab in the normal window')
  const n = after.find((w) => w.id === normal)!
  expect(n.active).toBe(`${server.base}/title?t=From%20Mail`)
  expect(after.find((w) => w.id === incId)!.urls).toEqual(incBefore)

  // Other schemes and non-HTML files open nothing anywhere.
  for (const bad of ['retronet://settings', 'javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,<b>x</b>']) await emitOpen(rn, 'url', bad)
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-open-'))
  const txt = join(dir, 'notes.txt')
  writeFileSync(txt, 'not html')
  await emitOpen(rn, 'file', txt)
  await settle(1000, 'no tab for rejected open requests')
  const still = await allTabs(rn)
  expect(still.map((w) => w.urls.length)).toEqual(after.map((w) => w.urls.length))
  expect(still.flatMap((w) => w.urls).some((u) => /^(retronet:\/\/settings|javascript:|data:)|etc\/hosts|notes\.txt/.test(u))).toBe(false)

  // An .html file opens its file:// URL.
  const local = join(FIXTURES, 'local-page.html')
  await emitOpen(rn, 'file', local)
  const withFile = await poll(async () => {
    const t = await allTabs(rn)
    return t.find((w) => w.id === normal)!.active === pathToFileURL(local).href ? t : null
  }, 'file tab active')
  expect(withFile.find((w) => w.id === incId)!.urls).toEqual(incBefore)
  const wc = await rn.activeTabWcId(normal)
  await poll(() => rn.js<boolean>(wc, `document.body && document.body.innerText.includes('LOCAL-PAGE-MARKER')`), 'local page rendered')

  // Logs never carry the URL or the path (only counts).
  const log = rn.mainLog()
  expect(log).not.toContain('From%20Mail')
  expect(log).not.toContain('notes.txt')
  expect(log).not.toContain('etc/hosts')
  rmSync(dir, { recursive: true, force: true })
})

test('AC48: links that arrive before the first window are queued (max 20) and opened in order', async ({ server }) => {
  const links = Array.from({ length: 25 }, (_, i) => ({ kind: 'url' as const, value: `${server.base}/title?t=Q${i}` }))
  const bad = ['retronet://settings', 'javascript:alert(1)', 'file:///etc/hosts'].map((value) => ({ kind: 'url' as const, value }))
  const rn = await launchApp({ preOpen: [...bad, ...links] })
  try {
    const pre = await rn.main(() => (globalThis as any).__rnPreOpen)
    expect(pre).toEqual({ readyAtEmit: false, count: 28 })
    const t = await poll(async () => {
      const all = await allTabs(rn)
      return all.length === 1 && all[0]!.urls.length >= 20 ? all : null
    }, '20 queued tabs', 30_000)
    await settle(1500, 'nothing past the queue cap')
    const final = await allTabs(rn)
    expect(final).toHaveLength(1)
    expect(final[0]!.urls).toEqual(links.slice(0, 20).map((l) => l.value))
    expect(final[0]!.active).toBe(links[19]!.value)
    expect(t[0]!.urls.some((u) => u.startsWith('retronet://newtab'))).toBe(false)
  } finally {
    await closeQuietly(rn)
  }
})

// ============================== AC49, AC50: bookmark import / export ==============================

test('AC49/AC50: import three styles, re-import counts duplicates, export round trip, cancel changes nothing', async ({ rn }) => {
  const bm = await rn.openInternal('bookmarks')
  const tree = async () => (await rn.page<Tree>('bookmarks.tree'))
  const imp = async (fixture: string | null) => {
    await rn.queueDialog('open', fixture === null ? null : join(FIXTURES, fixture))
    return rn.pageCall<any>('bookmarks.import')
  }
  const t0 = await tree()

  // Cancel: nothing changes.
  expect(await imp(null)).toEqual({ ok: true, data: { status: 'cancelled' } })
  expect(await tree()).toEqual(t0)

  const chrome = await imp('bookmarks-chrome.html')
  expect(chrome.data).toMatchObject({ status: 'imported', folderTitle: 'Imported', added: 4, duplicates: 0, unsupported: 2, truncated: false })
  const firefox = await imp('bookmarks-firefox.html')
  expect(firefox.data).toMatchObject({ status: 'imported', folderTitle: 'Imported (2)', added: 4, duplicates: 0, unsupported: 2 })
  const messy = await imp('bookmarks-messy.html')
  expect(messy.data).toMatchObject({ status: 'imported', folderTitle: 'Imported (3)', added: 4, duplicates: 1, unsupported: 1 })

  let t = await tree()
  const imported = t.other.children!.filter((c) => c.kind === 'folder' && c.title.startsWith('Imported'))
  expect(imported.map((f) => f.title)).toEqual(['Imported', 'Imported (2)', 'Imported (3)'])
  // The file's folder tree is kept.
  const c = imported[0]!
  expect(c.children!.map((x) => x.title)).toEqual(['Bookmarks bar', 'Other One'])
  expect(c.children![0]!.children!.map((x) => x.title)).toEqual(['Chrome One', 'News'])
  expect(urls(c.children![0]!.children![1]!)).toEqual(['https://example.com/chrome/news', 'http://example.com/chrome/news2'])
  expect(imported[1]!.children!.map((x) => x.title)).toEqual(['Help and Tutorials', 'Bookmarks Toolbar', 'Other Bookmarks'])
  expect(urls(imported[2]!)).toEqual(['https://example.net/messy/a', 'https://example.net/messy/b', 'https://example.net/messy/c', 'https://example.net/messy/d'])
  const all = urls([t.bar, t.other])
  expect(all.every((u) => /^https?:\/\//.test(u) || u.startsWith('retronet://'))).toBe(true)

  // The page shows the new folders (bridge calls skip the button's own refresh, so reload it).
  await rn.shell('tabs.reload', {})
  await poll(() => rn.js<boolean>(bm, `document.body.innerText.includes('Imported (3)')`).catch(() => false), 'bookmarks page lists the imports')

  // Re-import: everything is a duplicate.
  const again = await imp('bookmarks-chrome.html')
  expect(again.data).toMatchObject({ status: 'imported', added: 0, duplicates: 4, unsupported: 2 })

  // Export through the save-dialog hook to a temp path.
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-export-'))
  const out = join(dir, 'exported.html')
  t = await tree()
  const httpCount = urls([t.bar, t.other]).filter((u) => /^https?:/.test(u)).length
  await rn.queueDialog('save', out)
  const ex = await rn.pageCall<any>('bookmarks.export')
  expect(ex.ok).toBe(true)
  expect(ex.data).toMatchObject({ status: 'exported' })
  expect(ex.data.count).toBe(urls([t.bar, t.other]).length)
  const text = readFileSync(out, 'utf8')
  expect(text.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
  expect(text).toMatch(/<META HTTP-EQUIV="Content-Type" CONTENT="text\/html; charset=UTF-8">/i)
  expect(text).toContain('PERSONAL_TOOLBAR_FOLDER="true"')
  expect(text).toContain('News &amp; Views')
  // Re-importing the export adds nothing: every http(s) entry is a duplicate.
  await rn.queueDialog('open', out)
  const round = await rn.pageCall<any>('bookmarks.import')
  expect(round.data).toMatchObject({ status: 'imported', added: 0, duplicates: httpCount })

  // Export cancelled: no file.
  const out2 = join(dir, 'never.html')
  expect(await rn.pageCall('bookmarks.export')).toEqual({ ok: true, data: { status: 'cancelled' } })
  expect(existsSync(out2)).toBe(false)

  // Every dialog went through the test hook (never a real one), and IPC accepts no path.
  const calls = await rn.dialogCalls()
  expect(calls.map((x) => x.kind)).toEqual(['open', 'open', 'open', 'open', 'open', 'save', 'open', 'save'])
  expect(await rn.forge(bm, 'bookmarks.import', { path: '/etc/passwd' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.forge(bm, 'bookmarks.export', { path: join(dir, 'forged.html') })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(existsSync(join(dir, 'forged.html'))).toBe(false)
  rmSync(dir, { recursive: true, force: true })
})

test('AC49: a hostile bookmark file imports as inert text; huge and non-bookmark files are rejected', async ({ rn }) => {
  const bm = await rn.openInternal('bookmarks')
  // Through the real button, so the page renders the result.
  await rn.queueDialog('open', join(FIXTURES, 'bookmarks-malicious.html'))
  await rn.js(bm, `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Import'))?.click()`)
  const banner = await poll(() => rn.js<string>(bm, `(document.querySelector('.rn-banner') || {}).textContent || ''`), 'import banner')
  expect(banner).toMatch(/Imported \d+ bookmarks? into “Imported”/)
  expect(banner).toMatch(/can't open/)

  const t = await rn.page<Tree>('bookmarks.tree')
  const folder = t.other.children!.find((c) => c.title === 'Imported')!
  const got = urls(folder)
  expect(got.some((u) => /^(javascript|data|file|retronet):/i.test(u.trim()))).toBe(false)
  expect(got.every((u) => /^https:\/\/example\.com\//.test(u))).toBe(true)
  expect(got).toContain('https://example.com/evil/creds') // credentials stripped
  expect(got.some((u) => u.includes('alice') || u.includes('secret'))).toBe(false)
  const titles = JSON.stringify(folder)
  expect(titles).toContain(`<img src=x onerror=\\"window.__pwned='title'\\">Evil title`)

  // Open the folder in the page: titles render as text, nothing runs, no injected elements.
  await rn.js(bm, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show folder')?.click()`)
  await poll(() => rn.js<boolean>(bm, `document.body.innerText.includes("onerror=")`), 'hostile title rendered as text')
  await settle(500, 'no injected handler fires')
  const dom = await rn.js<{ pwned: string; imgs: number; bold: number }>(
    bm,
    `({ pwned: typeof window.__pwned, imgs: document.querySelectorAll('img[src="x"]').length, bold: [...document.querySelectorAll('b')].filter((b) => b.textContent === 'Folder').length })`
  )
  expect(dom).toEqual({ pwned: 'undefined', imgs: 0, bold: 0 })

  // Over 10 MB: refused before reading. Not a bookmark file: refused.
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-bad-'))
  const big = join(dir, 'big.html')
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
  await rn.queueDialog('open', big)
  expect(await rn.pageCall('bookmarks.import')).toMatchObject({ ok: false, code: 'E_INVALID', message: 'File is too large' })
  const notes = join(dir, 'notes.html')
  writeFileSync(notes, '<!doctype html><title>Just a page</title><p>no links here</p>')
  await rn.queueDialog('open', notes)
  expect(await rn.pageCall('bookmarks.import')).toMatchObject({ ok: false, code: 'E_INVALID', message: 'That is not a bookmarks file' })
  // UI message for the too-large case.
  await rn.queueDialog('open', big)
  await rn.js(bm, `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Import'))?.click()`)
  await poll(() => rn.js<boolean>(bm, `((document.querySelector('.rn-banner') || {}).textContent || '').includes('larger than 10 MB')`), 'too-large banner')
  const after = await rn.page<Tree>('bookmarks.tree')
  expect(after.other.children!.filter((c) => c.title.startsWith('Imported'))).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

// ============================== AC51: PDF in a tab ==============================

interface FrameInfo {
  url: string
  parent: string | null
}

function framesOf(rn: RN, tabUrl: string): Promise<FrameInfo[] | null> {
  return rn.main(({ webContents }, u: string) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)
    return wc ? wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, parent: f.parent?.url ?? null })) : null
  }, tabUrl)
}

async function expectPdfViewer(rn: RN, pdfUrl: string, windowId?: number): Promise<void> {
  // The viewer's index.html loads under the tab, with the PDF itself as its content frame.
  await poll(async () => {
    const f = await framesOf(rn, pdfUrl)
    return f && f.some((x) => x.parent?.startsWith(`${PDF_VIEWER_ORIGIN}/index.html`) && x.url === pdfUrl) ? f : null
  }, 'PDF viewer frame tree', 15_000)
  const s = await rn.snap(windowId)
  expect(rn.active(s).url).toBe(pdfUrl)
  const viewer = await poll(
    () =>
      rn.main(async ({ webContents }, u: string) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)!
        const f = wc.mainFrame.framesInSubtree.find((x) => x.url.startsWith(`chrome-extension:`) && x.url.endsWith('/index.html'))
        if (!f) return null
        const main = await wc.executeJavaScript('typeof retronet')
        const inner = (await f.executeJavaScript(`(() => { const v = document.querySelector('pdf-viewer'); return v ? JSON.stringify({ toolbar: !!(v.shadowRoot && v.shadowRoot.querySelector('viewer-toolbar')), retronet: typeof retronet }) : null })()`)) as string | null
        return inner ? { main: String(main), ...(JSON.parse(inner) as object) } : null
      }, pdfUrl),
    'viewer element'
  )
  expect(viewer).toEqual({ main: 'undefined', toolbar: true, retronet: 'undefined' })
  // The page itself painted (white page pixels in the hidden tab's capture).
  await poll(
    () =>
      rn.main(async ({ webContents }, u: string) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)!
        const bmp = (await wc.capturePage()).toBitmap()
        let white = 0
        for (let i = 0; i < bmp.length; i += 4 * 13) if (bmp[i]! > 245 && bmp[i + 1]! > 245 && bmp[i + 2]! > 245) white++
        return white > 1000
      }, pdfUrl),
    'PDF page painted',
    15_000,
    500
  )
}

const downloadCount = (rn: RN): Promise<number> =>
  rn.main(() => Object.values((globalThis as any).__rnDownloads ?? {}).reduce((n: number, s: any) => n + s.list().length, 0) as number)

test('AC51: a PDF renders in the tab (profile and incognito), no download, audits ok, viewer not frameable', async ({ rn, server }) => {
  const pdf = `${server.base}/doc.pdf`
  await rn.shell('tabs.navigate', { input: pdf })
  await expectPdfViewer(rn, pdf)
  expect(await downloadCount(rn)).toBe(0)
  expect(readdirSync(rn.downloadsDir)).toEqual([])

  // Incognito window.
  const incId = await rn.profiles<number>('newIncognitoWindow')
  await rn.waitWindowReady(incId)
  const ipdf = `${pdf}?incognito=1`
  await rn.shell('tabs.navigate', { input: ipdf }, incId)
  await expectPdfViewer(rn, ipdf, incId)
  expect(await downloadCount(rn)).toBe(0)
  expect(readdirSync(rn.downloadsDir)).toEqual([])

  // Every webContents audit is ok (the viewer adds no guest webContents).
  const audits = await rn.main(() => (globalThis as any).__rn.audits() as Array<{ ok: boolean; url: string; problems: string[] }>)
  expect(audits.filter((a) => !a.ok)).toEqual([])
  const types = await rn.main(() => (globalThis as any).__rn.webContents() as Array<{ type: string; url: string }>)
  expect(types.some((w) => w.url.startsWith('chrome-extension:'))).toBe(false)

  // A web page that frames the viewer directly does not get it.
  const hostile = `${server.base}/hostile-extras.html`
  await rn.navigate(hostile)
  await settle(1500, 'viewer iframe would have loaded')
  const f = (await framesOf(rn, hostile))!
  expect(f.length, 'the hostile iframe exists').toBeGreaterThan(1)
  expect(f.some((x) => x.url.startsWith(PDF_VIEWER_ORIGIN))).toBe(false)
  const viewerInFrame = await rn.main(async ({ webContents }, u: string) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)!
    const out: string[] = []
    for (const fr of wc.mainFrame.framesInSubtree) {
      if (fr === wc.mainFrame) continue
      out.push(String(await fr.executeJavaScript(`String(!!document.querySelector('pdf-viewer'))`).catch(() => 'unreachable')))
    }
    return out
  }, hostile)
  expect(viewerInFrame.includes('true')).toBe(false)
})

// ============================== AC52, AC53: update check ==============================

test('AC52: with no feed configured the About page has no update UI and check is unavailable', async ({ rn }) => {
  const ab = await rn.openInternal('about')
  expect(await rn.page('updates.status')).toMatchObject({ enabled: false })
  await settle(800, 'update section would have appeared')
  expect(await rn.js<boolean>(ab, `!!document.getElementById('rn-update-btn') || !!document.querySelector('.rn-update')`)).toBe(false)
  expect(await rn.pageCall('updates.check')).toMatchObject({ ok: false, code: 'E_UNAVAILABLE' })
})

async function clickCheck(rn: RN, ab: number, server: FixtureServer): Promise<string> {
  const hits = server.feedHits()
  await rn.js(ab, `(document.getElementById('rn-update-status').replaceChildren(), document.getElementById('rn-update-btn').click(), true)`)
  const text = await poll(() => rn.js<string>(ab, `(() => { const b = document.querySelector('#rn-update-status .rn-banner'); return b ? b.textContent : '' })()`), 'update banner')
  expect(server.feedHits(), 'exactly one feed request per click').toBe(hits + 1)
  return text
}

test('AC52/AC53: feed override: zero requests until the click, one per click, every result state', async ({ server }) => {
  const rn = await launchApp({ overrides: { updateFeed: `${server.base}/feed/live` } })
  try {
    expect(server.feedHits(), 'no request during launch').toBe(0)
    await settle(10_000, 'AC53: 10 s idle with a feed configured')
    expect(server.feedHits(), 'no request after 10 s idle').toBe(0)
    const ab = await rn.openInternal('about')
    await poll(() => rn.js<boolean>(ab, `!!document.getElementById('rn-update-btn')`), 'update button')
    await settle(1000, 'About load must not check')
    expect(server.feedHits(), 'no request from the About page load').toBe(0)

    // Newer: version + notes as literal text + Download opens the feed URL in a new tab.
    server.setFeed('newer')
    const newer = await clickCheck(rn, ab, server)
    expect(newer).toContain('RetroNet 9.9.9 is available.')
    const notes = await rn.js<{ text: string; tags: number }>(ab, `(() => { const n = document.querySelector('.rn-update__notes'); return { text: n.textContent, tags: n.querySelectorAll('*').length } })()`)
    expect(notes).toEqual({ text: 'Fixes <b>x</b> & more', tags: 0 })
    const n0 = (await rn.snap()).tabs.length
    await rn.js(ab, `[...document.querySelectorAll('#rn-update-status button')].find((b) => b.textContent.includes('Download 9.9.9')).click()`)
    const s = await rn.waitSnap((x) => x.tabs.length === n0 + 1, 'download tab opened')
    await poll(async () => (await rn.snap()).tabs.some((t) => t.url === server.updateDownloadUrl), 'download tab at the feed URL')
    expect(s.tabs.length).toBe(n0 + 1)
    expect(server.feedHits(), 'Download makes no feed request').toBe(1)
    await rn.shell('tabs.activate', { tabId: s.tabs.find((t) => t.url.startsWith('retronet://about'))?.id ?? s.tabs[0]!.id })

    server.setFeed('same')
    expect(await clickCheck(rn, ab, server)).toContain("You're up to date.")
    server.setFeed('invalid')
    expect(await clickCheck(rn, ab, server)).toContain("couldn't be read")
    server.setFeed('http-url')
    expect(await clickCheck(rn, ab, server)).toContain("couldn't be read")
    server.setFeed('huge')
    expect(await clickCheck(rn, ab, server)).toContain('too large')
    server.setFeed('redirect')
    expect(await clickCheck(rn, ab, server)).toContain("couldn't reach the update server")
    expect(server.requests.filter((r) => r.path === '/feed/newer'), 'redirect not followed').toHaveLength(0)

    // A second check while one is in flight answers busy and sends nothing.
    server.setFeed('slow')
    const hits = server.feedHits()
    const both = await rn.js<Array<{ ok: boolean; data?: { state: string; error?: string } }>>(ab, `Promise.all([window.retronet.updates.check(), new Promise((r) => setTimeout(r, 200)).then(() => window.retronet.updates.check())])`)
    expect(both[0]).toMatchObject({ ok: true, data: { state: 'up-to-date' } })
    expect(both[1]).toMatchObject({ ok: true, data: { state: 'error', error: 'busy' } })
    expect(server.feedHits()).toBe(hits + 1)
    // Nothing was installed or downloaded.
    expect(await downloadCount(rn)).toBe(0)
  } finally {
    await closeQuietly(rn)
  }
})

// ============================== AC54: view source ==============================

/**
 * Native menus must never reach the screen (PLAN-FINAL §0): anything that falls back to a native menu is recorded
 * instead of shown. Page context menus are themed (AC60) and read through the gated `__rn.menu()` hook.
 */
async function stubMenus(rn: RN): Promise<void> {
  await rn.main(({ Menu }) => {
    Menu.prototype.popup = function () {
      ;(globalThis as any).__lastMenu = this
    }
  })
}

/** Right-click the page in `wcId` and return the themed page menu's top-level item ids (the menu stays open). */
async function contextMenuIds(rn: RN, wcId: number): Promise<string[]> {
  const w = await rn.win()
  const before = await rn.main((_e, id: number) => (globalThis as any).__rn.currentMenu(id)?.menuId ?? null, w.id)
  await rn.main(({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    wc.sendInputEvent({ type: 'mouseDown', x: 300, y: 200, button: 'right', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: 300, y: 200, button: 'right', clickCount: 1 })
  }, wcId)
  return poll(() => rn.main((_e, a: { id: number; before: string | null }) => {
    const m = (globalThis as any).__rn.currentMenu(a.id)
    return m && m.menuId !== a.before && m.kind === 'page' ? (m.items.map((i: any) => i.id).filter(Boolean) as string[]) : null
  }, { id: w.id, before }), 'themed context menu')
}

/** Pick an item of the window's open themed menu through the real menu.pick validation. */
async function pickContextItem(rn: RN, itemId: string): Promise<void> {
  const w = await rn.win()
  const ok = await rn.main((_e, a: { id: number; itemId: string }) => {
    const m = (globalThis as any).__rn.currentMenu(a.id)
    return !!m && (globalThis as any).__rn.pickMenu(a.id, { menuId: m.menuId, itemId: a.itemId, mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 })
  }, { id: w.id, itemId })
  expect(ok, `pick ${itemId}`).toBe(true)
}

/** Close the window's open themed menu (if any) and wait until it is gone. */
async function dismissContextMenu(rn: RN): Promise<void> {
  const w = await rn.win()
  await rn.main((_e, id: number) => {
    const m = (globalThis as any).__rn.currentMenu(id)
    if (m) (globalThis as any).__rn.dismissMenu(id, m.menuId)
  }, w.id)
  await poll(() => rn.main((_e, id: number) => (globalThis as any).__rn.currentMenu(id) === null, w.id), 'menu closed')
}

test('AC54: every entry point opens view-source next to the page; guards; no bridge; no history', async ({ rn, server }) => {
  await stubMenus(rn)
  const page = `${server.base}/viewsrc.html`
  const vs = `view-source:${page}`
  await rn.navigate(page)
  const tabWc = await rn.activeTabWcId()
  const pageTab = (await rn.snap()).activeTabId

  /** Runs `open`, then expects one new active tab at pageIndex+1 showing the source; closes it again. */
  const expectSourceTab = async (what: string, open: () => Promise<unknown>) => {
    await rn.shell('tabs.activate', { tabId: pageTab })
    await rn.waitSnap((s) => s.activeTabId === pageTab, 'page tab active')
    const s0 = await rn.snap()
    const idx = s0.tabs.findIndex((t) => t.id === pageTab)
    await open()
    const s = await rn.waitSnap((x) => x.tabs.length === s0.tabs.length + 1 && rn.active(x).url === vs && !rn.active(x).loading, `${what}: source tab`)
    expect(s.tabs.findIndex((t) => t.id === s.activeTabId), `${what}: next to the page`).toBe(idx + 1)
    const wc = await rn.activeTabWcId()
    const inside = await poll(
      () => rn.js<{ text: string; retronet: string; title: string } | null>(wc, `document.body && document.body.innerText.includes('VIEWSRC-MARKER') ? { text: document.body.innerText, retronet: typeof retronet, title: document.title } : null`),
      `${what}: source rendered`
    )
    expect(inside.text).toContain('<html')
    expect(inside.text).toContain('document.title = "script ran"')
    expect(inside.retronet).toBe('undefined')
    expect(inside.title).not.toBe('script ran')
    await rn.shell('tabs.close', { tabId: s.activeTabId })
    await rn.waitSnap((x) => x.tabs.length === s0.tabs.length, `${what}: source tab closed`)
  }

  await expectSourceTab('Cmd+Alt+U', () => rn.press('U', ['meta', 'alt'], 'tab'))
  await expectSourceTab('palette command', () => rn.shell('commands.run', { id: 'page.viewSource' }))
  await expectSourceTab('View menu item', async () => {
    const item = await poll(() => rn.main(({ Menu }) => {
      const m = Menu.getApplicationMenu()?.getMenuItemById('page.viewSource')
      return m && m.enabled ? { label: m.label } : null
    }), 'View > View page source enabled')
    expect(item.label).toBe('View page source')
    await rn.main(({ Menu, BrowserWindow }, shellId: number) => {
      const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.id === shellId) ?? BrowserWindow.getAllWindows()[0]
      Menu.getApplicationMenu()!.getMenuItemById('page.viewSource')!.click(undefined, bw)
    }, (await rn.win()).shellId)
  })
  await expectSourceTab('context menu', async () => {
    const ids = await contextMenuIds(rn, tabWc)
    expect(ids).toContain('ctx.viewSource')
    await pickContextItem(rn, 'ctx.viewSource')
  })

  // A link inside a source view opens the plain target (no opener).
  await rn.shell('commands.run', { id: 'page.viewSource' })
  await rn.waitSnap((x) => rn.active(x).url === vs && !rn.active(x).loading, 'source view for the link test')
  const sw = await rn.activeTabWcId()
  const n0 = (await rn.snap()).tabs.length
  await poll(() => rn.js<boolean>(sw, `[...document.querySelectorAll('a')].some((x) => x.textContent.includes('/b'))`), 'link in source view')
  await rn.js(sw, `[...document.querySelectorAll('a')].find((x) => x.textContent === '/b').click()`)
  await rn.waitSnap((s) => s.tabs.length === n0 + 1 && s.tabs.some((t) => t.url === `${server.base}/b`), 'plain tab from the source link')
  const bWc = (await rn.wcIdsByUrl(`${server.base}/b`)).slice(-1)[0]!
  expect(await rn.js<string>(bWc, 'String(window.opener)')).toBe('null')

  // Typed view-source:http works; retronet:, file: and nested are blocked.
  await rn.navigate(`view-source:${server.base}/a`)
  for (const bad of ['view-source:retronet://settings/', 'view-source:file:///etc/hosts', `view-source:view-source:${page}`]) {
    await rn.shellCall('tabs.navigate', { input: bad })
    await rn.shellCall('tabs.create', { url: bad })
  }
  await settle(1000, 'blocked view-source targets would load')
  const all = await rn.main(() => (globalThis as any).__rn.webContents() as Array<{ url: string }>)
  expect(all.some((w) => /^view-source:(retronet|file|view-source):/.test(w.url))).toBe(false)

  // Internal pages: the command is a no-op, the menu item is disabled, the context menu has no entry.
  const st = await rn.openInternal('settings')
  const nSettings = (await rn.snap()).tabs.length
  await rn.shell('commands.run', { id: 'page.viewSource' })
  await rn.press('U', ['meta', 'alt'], 'tab')
  await settle(800, 'no source tab for an internal page')
  expect((await rn.snap()).tabs.length).toBe(nSettings)
  await poll(() => rn.main(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('page.viewSource')?.enabled === false), 'menu item disabled on retronet:')
  expect(await contextMenuIds(rn, st)).not.toContain('ctx.viewSource')
  await dismissContextMenu(rn)

  // Web pages cannot reach view-source: (link, window.open, redirect).
  const hostile = `${server.base}/hostile-extras.html`
  await rn.navigate(hostile)
  const hw = await rn.activeTabWcId()
  const nh = (await rn.snap()).tabs.length
  expect(await rn.js<string>(hw, 'window.__opened')).toBe('null')
  await rn.js(hw, `document.getElementById('vs-link').click()`)
  await settle(1000, 'link to view-source would navigate')
  let s = await rn.snap()
  expect(rn.active(s).url).toBe(hostile)
  expect(s.tabs.length).toBe(nh)
  await rn.shell('tabs.navigate', { input: `${server.base}/redirect-view-source` })
  await settle(1500, 'redirect to view-source would commit')
  s = await rn.snap()
  expect(rn.active(s).url.startsWith('view-source:')).toBe(false)

  // History: real pages yes, view-source never.
  const dir = join(rn.userData, 'Profiles', 'default')
  await rn.flush(join(dir, 'history.json'), (j) => JSON.stringify(j).includes('/viewsrc.html'), 'history saved')
  const hist = readFileSync(join(dir, 'history.json'), 'utf8')
  expect(hist).toContain('/viewsrc.html')
  expect(hist).not.toContain('view-source:')
})

// ============================== AC55: dial-up sound (silenced) ==============================

test('AC55: dial-up plays once for a user-started load, never for links, reloads, throttle, incognito or mute', async ({ rn, server }) => {
  test.setTimeout(90_000)
  const w = await rn.win()
  await rn.silenceShell()
  expect(await rn.soundPlays()).toBe(0)

  // Default off: an omnibox navigation plays nothing.
  await rn.navigate(`${server.base}/a`)
  await settle(300, 'no play with the default setting')
  expect(await rn.soundPlays()).toBe(0)
  const st = await rn.openInternal('settings')
  expect(await rn.js<boolean>(st, `document.getElementById('rn-dialup').checked`)).toBe(false)
  expect((await rn.bridge(st, 'settings.set', { dialupSound: true })).ok).toBe(true)

  // On: omnibox navigation → 1.
  await rn.navigate(`${server.base}/a?dial=1`)
  await poll(async () => (await rn.soundPlays()) === 1, 'one play')
  // Within 10 s: a second typed navigation stays at 1.
  await rn.navigate(`${server.base}/b?dial=throttled`)
  await settle(300, 'throttled play')
  expect(await rn.soundPlays()).toBe(1)

  // After the throttle window: link click, reload and back/forward still play nothing.
  await sleep(10_500)
  await rn.navigate(`${server.base}/a?dial=2`, { expectUrl: `${server.base}/a?dial=2` }).catch(() => undefined)
  await poll(async () => (await rn.soundPlays()) === 2, 'second play after 10 s')
  await sleep(10_500)
  const tab = await rn.activeTabWcId()
  await rn.js(tab, `document.getElementById('to-b').click()`)
  await rn.waitSnap((s) => rn.active(s).url === `${server.base}/b` && !rn.active(s).loading, 'link navigation')
  await rn.shell('tabs.reload', { tabId: (await rn.snap()).activeTabId })
  await settle(800, 'reload')
  await rn.shell('tabs.back', { tabId: (await rn.snap()).activeTabId })
  await rn.waitSnap((s) => rn.active(s).url === `${server.base}/a?dial=2` && !rn.active(s).loading, 'back')
  await settle(300, 'back/forward')
  expect(await rn.soundPlays(), 'link, reload and back do not play').toBe(2)
  // Positive control: the throttle has expired, so a typed load plays again.
  await rn.navigate(`${server.base}/a?dial=3`)
  await poll(async () => (await rn.soundPlays()) === 3, 'typed load plays after link/reload/back')

  // Incognito window: never.
  const incId = await rn.profiles<number>('newIncognitoWindow')
  await rn.waitWindowReady(incId)
  await rn.silenceShell(incId)
  await rn.navigate(`${server.base}/a?dial=incognito`, { windowId: incId })
  await settle(500, 'incognito would play')
  expect(await rn.soundPlays(incId)).toBe(0)

  // A second normal window (own throttle): muted tab → 0; unmuted → 1.
  const w2 = await rn.profiles<number>('newWindow', 'default')
  await rn.waitWindowReady(w2)
  await rn.silenceShell(w2)
  await rn.shell('tabs.toggleMute', { tabId: (await rn.snap(w2)).activeTabId }, w2)
  await rn.waitSnap((s) => rn.active(s).muted === true, 'tab muted', { windowId: w2 })
  await rn.navigate(`${server.base}/a?dial=muted`, { windowId: w2 })
  await settle(500, 'muted tab would play')
  expect(await rn.soundPlays(w2)).toBe(0)
  await rn.shell('tabs.toggleMute', { tabId: (await rn.snap(w2)).activeTabId }, w2)
  await rn.waitSnap((s) => !rn.active(s).muted, 'tab unmuted', { windowId: w2 })
  await rn.navigate(`${server.base}/b?dial=unmuted`, { windowId: w2 })
  await poll(async () => (await rn.soundPlays(w2)) === 1, 'unmuted window plays')
  expect(await rn.soundPlays(w.id)).toBe(3)
})
