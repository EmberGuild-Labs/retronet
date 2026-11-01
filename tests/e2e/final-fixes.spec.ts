// PLAN-FINAL F-E2E2: the review and security fixes, end to end in background mode (PLAN-FINAL §0). Loopback only.
//   AC72 (C1: open-url counts as user-started, dial-up only for http(s), userinfo stripped, 20 opens / 10 s) ·
//   AC73 (C2: view-source userinfo never shown or saved) · AC75 (C3: unregistered webContents audit, session
//   preloads, pdfViewerEnabled per kind) · AC76 (C4: temp file names, planted temp path) · AC77 (C5 empty import,
//   R24 About Download error, R27 default-browser retry/focus/single read, R33 quiet-errors).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, launchApp, mainLogErrors, poll, settle, sleep, ROOT, type RN } from './helpers/launch'
import { FIXTURES } from './helpers/server'

const emitOpen = (rn: RN, kind: 'url' | 'file', value: string): Promise<void> =>
  rn.main(({ app }, a: { kind: string; value: string }) => {
    app.emit(a.kind === 'file' ? 'open-file' : 'open-url', { preventDefault() {} }, a.value)
  }, { kind, value })

async function closeQuietly(rn: RN): Promise<void> {
  await rn.quit().catch(() => rn.kill())
  rmSync(rn.userData, { recursive: true, force: true })
  rmSync(rn.downloadsDir, { recursive: true, force: true })
}

async function settingsWc(rn: RN): Promise<number> {
  const existing = (await rn.wcIdsByUrl(/^retronet:\/\/settings\//))[0]
  if (existing !== undefined) return existing
  await rn.shell('tabs.create', { url: 'retronet://settings/', background: true })
  const id = await poll(async () => (await rn.wcIdsByUrl(/^retronet:\/\/settings\//))[0], 'settings tab')
  await poll(() => rn.js<boolean>(id, `typeof window.retronet === 'object'`), 'settings bridge')
  return id
}

const allUrls = async (rn: RN): Promise<string[]> => (await rn.windows()).flatMap((w) => w.snapshot.tabs.map((t) => t.url))

// ---------------------------------------------------------------- AC72 (C1)

test('AC72: opened from another app = user-started (dial-up for http only, silenced), userinfo stripped, never logged', async ({ rn, server }) => {
  await rn.silenceShell()
  const st = await settingsWc(rn)
  expect((await rn.bridge(st, 'settings.set', { dialupSound: true })).ok).toBe(true)
  const n0 = (await rn.snap()).tabs.length

  // file: first, so a 0 here is the protocol rule, not the 10 s throttle.
  const local = join(FIXTURES, 'local-page.html')
  await emitOpen(rn, 'file', local)
  await rn.waitSnap((s) => rn.active(s).url === pathToFileURL(local).href && !rn.active(s).loading, 'file tab')
  await settle(600, 'a file: open would play dial-up')
  expect(await rn.soundPlays(), 'never for file:').toBe(0)

  // http with userinfo: stripped before opening; counts as user-started → one (silent) play.
  const secret = 'opener:s3cretPW'
  const withCreds = server.base.replace('http://', `http://${secret}@`) + '/title?t=FromOtherApp'
  await emitOpen(rn, 'url', withCreds)
  const s = await rn.waitSnap((x) => rn.active(x).url === `${server.base}/title?t=FromOtherApp` && !rn.active(x).loading, 'link tab without userinfo')
  expect(s.tabs.length).toBe(n0 + 2)
  const w = await rn.win()
  const omni = await rn.js<string>(w.shellId, `document.querySelector('.rn-omnibox__input').value`)
  expect(omni).not.toContain('s3cret')
  expect((await allUrls(rn)).join(' ')).not.toContain('s3cret')
  await rn.flush(join(rn.userData, 'Profiles', 'default', 'session.json'), (j) => JSON.stringify(j).includes('FromOtherApp'), 'session saved')
  expect(readFileSync(join(rn.userData, 'Profiles', 'default', 'session.json'), 'utf8')).not.toContain('s3cret')
  expect(rn.mainLog()).not.toContain('s3cret')
  expect(rn.mainLog()).not.toContain('FromOtherApp')
  // R21: the http open is user-started, so with the setting on it plays (silenced) once.
  await poll(async () => (await rn.soundPlays()) === 1, 'dial-up played once for the http open')
})

test('AC72: after ready at most 20 external opens per 10 s are accepted; the rest are dropped and only counted', async ({ rn, server }) => {
  const n0 = (await rn.snap()).tabs.length
  for (let i = 0; i < 25; i++) await emitOpen(rn, 'url', `${server.base}/title?t=Flood${i}`)
  await poll(async () => (await rn.snap()).tabs.length >= n0 + 20, '20 flood tabs', 30_000)
  await settle(1500, 'nothing past the cap')
  const urls = await allUrls(rn)
  const flood = urls.filter((u) => u.includes('t=Flood'))
  expect(flood).toHaveLength(20)
  expect(flood).toEqual(Array.from({ length: 20 }, (_, i) => `${server.base}/title?t=Flood${i}`))
  expect(rn.mainLog()).toContain('open request rate-limited (5 dropped)')
  expect(rn.mainLog()).not.toContain('Flood')
})

// ---------------------------------------------------------------- AC73 (C2)

test('AC73: view-source with userinfo never shows or saves it (typed, page.viewSource, context menu)', async ({ rn, server }) => {
  const host = server.base.replace('http://', '')
  const typed = `view-source:http://vsuser:vsPASS@${host}/viewsrc.html`
  const clean = `view-source:${server.base}/viewsrc.html`
  const w = await rn.win()
  await rn.shell('tabs.navigate', { input: typed })
  await rn.waitSnap((s) => rn.active(s).url === clean && !rn.active(s).loading, 'typed view-source without userinfo')
  await poll(() => rn.js<boolean>(w.shellId, `document.querySelector('.rn-omnibox__input').value.includes('viewsrc.html')`), 'omnibox shows the source URL')
  expect(await rn.js<string>(w.shellId, `document.querySelector('.rn-omnibox__input').value + '|' + document.title`)).not.toMatch(/vsuser|vsPASS/)

  // A page reached with userinfo, then page.viewSource and the context-menu item.
  await rn.shell('tabs.navigate', { input: `http://vsuser:vsPASS@${host}/viewsrc.html` })
  await rn.waitSnap((s) => rn.active(s).url.endsWith('/viewsrc.html') && !rn.active(s).url.startsWith('view-source:') && !rn.active(s).loading, 'page loaded')
  await rn.shell('commands.run', { id: 'page.viewSource' })
  await poll(async () => (await allUrls(rn)).filter((u) => u.startsWith('view-source:')).length === 1, 'command opened a source tab')

  const pageWcId = await poll(async () => (await rn.wcIdsByUrl(/^http:.*\/viewsrc\.html$/))[0], 'page wc')
  await rn.shell('tabs.activate', { tabId: (await rn.snap()).tabs.find((t) => t.url.endsWith('/viewsrc.html') && !t.url.startsWith('view-source:'))!.id })
  await rn.main(({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    wc.sendInputEvent({ type: 'mouseDown', x: 300, y: 200, button: 'right', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: 300, y: 200, button: 'right', clickCount: 1 })
  }, pageWcId)
  const menu = await poll(() => rn.main((_e, id: number) => {
    const m = (globalThis as any).__rn.currentMenu(id)
    return m && m.kind === 'page' ? m : null
  }, w.id), 'page menu')
  expect(await rn.main((_e, a: { id: number; menuId: string }) => (globalThis as any).__rn.pickMenu(a.id, { menuId: a.menuId, itemId: 'ctx.viewSource', mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 }), { id: w.id, menuId: menu.menuId })).toBe(true)
  await poll(async () => (await allUrls(rn)).filter((u) => u.startsWith('view-source:')).length === 2, 'context menu opened a source tab')

  // Every view-source address (tabs, session entries and their back/forward lists) is credential-free. (The plain
  // http tab reached with userinfo is outside AC73; see the F-E2E2 report.)
  const vs = (await allUrls(rn)).filter((u) => u.startsWith('view-source:'))
  expect(vs).toEqual([clean, clean])
  const file = join(rn.userData, 'Profiles', 'default', 'session.json')
  await rn.flush(file, (j) => (JSON.stringify(j).match(/"url":"view-source:/g) ?? []).length >= 2, 'session saved')
  const saved = readFileSync(file, 'utf8').match(/view-source:[^"]*/g) ?? []
  expect(saved.length).toBeGreaterThanOrEqual(2)
  expect(saved.filter((u) => /vsuser|vsPASS|@/.test(u))).toEqual([])
  expect(rn.mainLog()).not.toMatch(/vsPASS/)
})

// ---------------------------------------------------------------- AC75 (C3)

// Amended (manager): on Electron 45.2.1 navigator.pdfViewerEnabled / navigator.plugins report the PDF plugin in
// every renderer regardless of webPreferences.plugins, so they can't tell UI from tabs. The probe SPIKE-X1/X6
// validated is whether a PDF <embed> becomes a live plugin element (exposes postMessage): tabs only.
test('AC75: the PDF plugin is live in a tab and not in the shell or overlay (plugins split)', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  const w = await rn.win()
  const probe = `(() => { const e = document.createElement('embed'); e.type = 'application/pdf'; document.body.appendChild(e); const r = typeof e.postMessage; e.remove(); return r })()`
  expect(await rn.tabJs(probe), 'tab').toBe('function')
  expect(await rn.js(w.shellId, probe), 'shell (UI webPreferences have plugins: false)').not.toBe('function')
  expect(await rn.js(w.overlayId, probe), 'overlay (UI webPreferences have plugins: false)').not.toBe('function')
})

test('AC75: every session (default, profile, incognito) passes the preload audit; every webContents audit is ok', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  const inc = await rn.profiles<number>('newIncognitoWindow')
  await rn.waitWindowReady(inc)

  const sessions = await rn.main(() => (globalThis as any).__rn.auditSessions() as Array<{ storagePath: string | null; ok: boolean; preloads: string[] }>)
  expect(sessions.length, 'default, profile and incognito sessions').toBeGreaterThanOrEqual(3)
  expect(sessions.some((x) => x.storagePath === null), 'the in-memory incognito session is included').toBe(true)
  expect(sessions.filter((x) => !x.ok || x.preloads.length)).toEqual([])

  // Audits are recorded a tick (or up to 1 s) after creation: poll until every live webContents has one.
  const audits = await poll(async () => {
    const a = await rn.main(() => (globalThis as any).__rn.audits() as Array<{ id: number; ok: boolean; problems: string[] }>)
    const live = await rn.main(({ webContents }) => webContents.getAllWebContents().filter((x) => !x.isDestroyed() && x.getType() !== 'remote').map((x) => x.id))
    return a.length >= 6 && live.every((id) => a.some((x) => x.id === id)) ? a : null
  }, 'an audit for every webContents')
  expect(audits.filter((a) => !a.ok)).toEqual([])
})

test('AC75: a webContents the router never registered fails the runtime audit', async () => {
  const rn = await launchApp()
  try {
    const id = await rn.main(async ({ WebContentsView }) => {
      const v = new WebContentsView()
      ;(globalThis as any).__e2eStranger = v
      await v.webContents.loadURL('data:text/html,<p>stranger</p>')
      return v.webContents.id
    })
    const a = await poll(async () => {
      const all = await rn.main(() => (globalThis as any).__rn.audits() as Array<{ id: number; ok: boolean; problems: string[] }>)
      return all.find((x) => x.id === id) ?? null
    }, 'stranger audited', 5000)
    expect(a.ok).toBe(false)
    expect(a.problems).toContain('not router-registered')
    await rn.main(() => (globalThis as any).__e2eStranger.webContents.close())
    await poll(() => mainLogErrors(rn.mainLog()).length > 0, 'audit failure logged')
    const errs = mainLogErrors(rn.mainLog())
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain(`audit failed for webContents ${id}`)
  } finally {
    await closeQuietly(rn)
  }
})

// ---------------------------------------------------------------- AC76 (C4)

test('AC76: store writes use a random wx temp name; a planted temp path (symlink) is never followed', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'rn-e2e-ud-'))
  const prof = join(userData, 'Profiles', 'default')
  const outside = mkdtempSync(join(tmpdir(), 'rn-e2e-victim-'))
  const victim = join(outside, 'victim.txt')
  writeFileSync(victim, 'UNTOUCHED')
  let rn = await launchApp({ userData })
  try {
    const st = await settingsWc(rn)
    expect((await rn.bridge(st, 'settings.set', { dialupSound: true })).ok).toBe(true)
    await rn.flush()
    await rn.quit()
    // Plant the old fixed temp name as a symlink to a file outside the profile.
    const planted = join(prof, 'settings.json.tmp')
    symlinkSync(victim, planted)
    rn = await launchApp({ userData })
    const pid = rn.app.process().pid
    const seen = new Set<string>()
    const watcher = watch(prof, (_ev, name) => {
      if (name) seen.add(String(name))
    })
    try {
      const st2 = await settingsWc(rn)
      for (let i = 0; i < 6 && ![...seen].some((n) => n.endsWith('.tmp') && n !== 'settings.json.tmp'); i++) {
        expect((await rn.bridge(st2, 'settings.set', { dialupSound: i % 2 === 0 })).ok).toBe(true)
        await rn.flush()
        await sleep(200)
      }
    } finally {
      watcher.close()
    }
    const temps = [...seen].filter((n) => n.startsWith('settings.json.') && n.endsWith('.tmp') && n !== 'settings.json.tmp')
    expect(temps.length, `temp files observed (${[...seen].join(', ')})`).toBeGreaterThan(0)
    for (const t of temps) expect(t).toMatch(new RegExp(`^settings\\.json\\.${pid}\\.[0-9a-f]{12}\\.tmp$`))
    expect(readFileSync(victim, 'utf8'), 'the symlink target is never written').toBe('UNTOUCHED')
    expect(JSON.parse(readFileSync(join(prof, 'settings.json'), 'utf8'))).toHaveProperty('dialupSound')
    await rn.flush()
    expect(readdirSync(prof).filter((n) => /\.\d+\.[0-9a-f]{12}\.tmp$/.test(n)), 'no temp file left behind').toEqual([])
  } finally {
    await rn.quit().catch(() => rn.kill())
    rmSync(userData, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(rn.downloadsDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- AC77

test('AC77 (C5): an import that adds nothing creates no folder and offers no "Show folder"', async ({ rn }) => {
  const bm = await rn.openInternal('bookmarks')
  const tree = async () => (await rn.page<any>('bookmarks.tree'))
  const folders = async () => (await tree()).other.children.filter((c: any) => c.kind === 'folder').map((c: any) => c.title)
  await rn.queueDialog('open', join(FIXTURES, 'bookmarks-chrome.html'))
  expect((await rn.pageCall<any>('bookmarks.import')).data).toMatchObject({ added: 4, folderTitle: 'Imported' })
  const before = await tree()
  expect(await folders()).toEqual(['Imported'])

  // Every link is a duplicate: nothing added, no "Imported (2)".
  await rn.queueDialog('open', join(FIXTURES, 'bookmarks-chrome.html'))
  expect((await rn.pageCall<any>('bookmarks.import')).data).toMatchObject({ status: 'imported', added: 0, duplicates: 4 })
  expect(await tree()).toEqual(before)

  // Only unopenable links: nothing added either. Through the page's own Import button this time.
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-imp-'))
  const junk = join(dir, 'junk.html')
  writeFileSync(junk, '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>\n<DL><p>\n<DT><A HREF="javascript:alert(1)">JS</A>\n<DT><A HREF="file:///etc/hosts">F</A>\n</DL><p>\n')
  await rn.queueDialog('open', junk)
  await rn.js(bm, `([...document.querySelectorAll('button')].find((b) => b.textContent.includes('Import')).click(), true)`)
  const banner = await poll(() => rn.js<string | null>(bm, `(() => { const b = document.querySelector('.rn-banner'); return b && /Nothing new/.test(b.textContent) ? b.textContent : null })()`), 'nothing-new banner')
  expect(banner).toContain('Nothing new to import.')
  expect(await rn.js(bm, `[...document.querySelectorAll('.rn-banner button')].some((b) => b.textContent.includes('Show folder'))`)).toBe(false)
  expect(await tree()).toEqual(before)
  rmSync(dir, { recursive: true, force: true })
})

test('AC77 (R24): a failed About Download shows the error banner in the update status region', async ({ server }) => {
  const rn = await launchApp({ overrides: { updateFeed: `${server.base}/feed/live` } })
  try {
    const ab = await rn.openInternal('about')
    server.setFeed('newer')
    await poll(() => rn.js<boolean>(ab, `!!document.getElementById('rn-update-btn')`), 'update button')
    await rn.js(ab, `(document.getElementById('rn-update-btn').click(), true)`)
    await poll(() => rn.js<boolean>(ab, `[...document.querySelectorAll('#rn-update-status button')].some((b) => b.textContent.includes('Download 9.9.9'))`), 'download offer')
    // The feed changes and another check runs before the click: main no longer has a download URL.
    server.setFeed('same')
    expect((await rn.pageCall<any>('updates.check')).data).toMatchObject({ state: 'up-to-date' })
    const tabs = (await rn.snap()).tabs.length
    await rn.js(ab, `([...document.querySelectorAll('#rn-update-status button')].find((b) => b.textContent.includes('Download 9.9.9')).click(), true)`)
    const msg = await poll(() => rn.js<string | null>(ab, `document.querySelector('#rn-update-status .rn-banner--error')?.textContent ?? null`), 'error banner')
    expect(msg).toContain("Error: couldn't open the download page.")
    expect(await rn.js(ab, `document.activeElement && document.activeElement.id`), 'focus moves to Check again').toBe('rn-update-btn')
    expect((await rn.snap()).tabs.length).toBe(tabs)
  } finally {
    await closeQuietly(rn)
  }
})

test('AC77 (R27): default-browser status: one read per focus event, retry path after a failed read, focus kept', async () => {
  // The in-memory test fake only: the user's real default-browser setting is never read or changed.
  const rn = await launchApp({ overrides: { defaultBrowser: 'fake' } })
  try {
    const st = await rn.openInternal('settings')
    await poll(() => rn.js<boolean>(st, `document.getElementById('rn-default-text').textContent === 'RetroNet is not your default browser.'`), 'status rendered')
    // Count (and optionally fail) status reads in main.
    await rn.main(({ ipcMain }) => {
      const g = globalThis as any
      g.__dbReads = 0
      g.__dbFail = false
      const ch = 'rn:invoke:defaultBrowser.status'
      const real = (ipcMain as any)._invokeHandlers.get(ch)
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, async (e: any, ...a: unknown[]) => {
        g.__dbReads++
        return g.__dbFail ? { ok: false, code: 'E_UNAVAILABLE', message: 'test-forced failure' } : real(e, ...a)
      })
    })
    const reads = () => rn.main(() => (globalThis as any).__dbReads as number)
    await settle(700, 'past the 500 ms dedupe window')
    // The window coming back fires focus and visibilitychange together: one read.
    await rn.js(st, `(window.dispatchEvent(new Event('focus')), document.dispatchEvent(new Event('visibilitychange')), true)`)
    await poll(async () => (await reads()) >= 1, 'a read')
    await settle(600, 'a second read for the same event')
    expect(await reads()).toBe(1)

    // A failed read shows "Try again"; it retries, keeps focus on the button while still failing, then recovers.
    await rn.main(() => ((globalThis as any).__dbFail = true))
    await settle(600, 'dedupe window')
    await rn.js(st, `(window.dispatchEvent(new Event('focus')), true)`)
    await poll(() => rn.js<boolean>(st, `!document.getElementById('rn-default-retry').hidden`), 'retry shown')
    expect(await rn.js(st, `document.getElementById('rn-default-text').textContent`)).toBe("Couldn't check the default browser setting.")
    expect(await rn.js(st, `document.getElementById('rn-default-btn').hidden`)).toBe(true)
    await rn.js(st, `(document.getElementById('rn-default-retry').focus(), document.getElementById('rn-default-retry').click(), true)`)
    await poll(() => rn.js<boolean>(st, `!document.getElementById('rn-default-retry').hidden && document.activeElement.id === 'rn-default-retry'`), 'still failing: retry focused')
    const r0 = await reads()
    await rn.main(() => ((globalThis as any).__dbFail = false))
    await rn.js(st, `(document.getElementById('rn-default-retry').click(), true)`)
    await poll(() => rn.js<boolean>(st, `document.getElementById('rn-default-text').textContent === 'RetroNet is not your default browser.'`), 'recovered')
    expect(await reads()).toBe(r0 + 1)
    expect(await rn.js(st, `({ retry: document.getElementById('rn-default-retry').hidden, btn: document.getElementById('rn-default-btn').hidden, focus: document.activeElement.id })`)).toEqual({ retry: true, btn: false, focus: 'rn-default-status' })
  } finally {
    await closeQuietly(rn)
  }
})

// ---------------------------------------------------------------- AC77 (R33): quiet-errors

test('AC77 (R33): after ready a non-fatal main exception is logged and the app keeps running (no dialog)', async () => {
  const rn = await launchApp()
  const stderr: string[] = []
  rn.app.process().stderr?.on('data', (d) => stderr.push(String(d)))
  try {
    expect(await rn.main(({ dialog }) => String(dialog.showErrorBox).includes('suppressed error box'))).toBe(true)
    await rn.main(() => {
      setTimeout(() => {
        throw new Error('rn-e2e-nonfatal-boom')
      }, 0)
    })
    await poll(() => rn.mainLog().includes('rn-e2e-nonfatal-boom'), 'the app handler logged it')
    await poll(() => stderr.join('').includes('non-fatal, still running'), 'quiet-errors logged it')
    await settle(500, 'an exit would happen now')
    expect(rn.app.process().exitCode).toBeNull()
    expect((await rn.windows()).length).toBe(1)
    expect(await rn.shell('tabs.navigate', { input: 'retronet://about/' })).toMatchObject({ blocked: false })
  } finally {
    await closeQuietly(rn)
  }
})

test('AC77 (R33): an exception before ready exits(1) quietly, without an error dialog', async () => {
  test.setTimeout(60_000)
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-r33-'))
  const boom = join(dir, 'boom.cjs')
  writeFileSync(boom, `'use strict'\nsetImmediate(() => { throw new Error('rn-e2e-fatal-startup') })\n`)
  const electron = require('electron') as unknown as string
  const env: Record<string, string> = { ...(process.env as Record<string, string>), RETRONET_E2E: '1', RETRONET_USER_DATA: join(dir, 'ud'), RETRONET_DOWNLOADS_DIR: join(dir, 'dl') }
  delete env.RETRONET_E2E_SHOW
  const child = spawn(electron, ['-r', join(ROOT, 'tests', 'e2e', 'helpers', 'quiet-errors.cjs'), '-r', boom, ROOT], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr!.on('data', (d) => (err += String(d)))
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(-999)
    }, 30_000)
    child.on('exit', (c) => {
      clearTimeout(t)
      resolve(c)
    })
  })
  try {
    expect(code, `exit code (stderr: ${err.slice(0, 400)})`).toBe(1)
    expect(err).toContain('fatal, exiting')
    expect(err).toContain('rn-e2e-fatal-startup')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
