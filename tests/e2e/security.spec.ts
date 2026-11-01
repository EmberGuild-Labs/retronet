// AC34 (hardened webPreferences, no node/bridge in web pages), AC35 (minimal bridges, every IPC handler checks
// sender + payload; forged calls rejected), AC36 (retronet:// unreachable from the web, traversal 404, CSP),
// AC37 (javascript: blocked, cert interstitial with explicit per-host proceed, file: only when typed),
// AC38 (navigation hardening: mailto prompts, unknown schemes blocked), S10 (no opener from retronet: pages).
import { test, expect, poll, settle, type RN } from './helpers/launch'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXTURES } from './helpers/server'
import { methodsFor } from '../../src/shared/ipc-contract'

const NODEISH = `({ require: typeof window.require, process: typeof window.process, retronet: typeof window.retronet, module: typeof window.module, Buffer: typeof window.Buffer })`
const NONE = { require: 'undefined', process: 'undefined', retronet: 'undefined', module: 'undefined', Buffer: 'undefined' }

async function tabCount(rn: RN): Promise<number> {
  return (await rn.snap()).tabs.length
}

test('AC34: every webContents is hardened; web pages see no node or bridge, also after leaving retronet://newtab', async ({ rn, server }) => {
  // The very first tab starts on retronet://newtab (bridge present), then goes to the web in the same webContents.
  const tab = await rn.activeTabWcId()
  expect(await rn.js<string>(tab, 'typeof window.retronet')).toBe('object')
  await rn.navigate(`${server.base}/fixtures/hostile.html`)
  expect(await rn.activeTabWcId()).toBe(tab)
  expect(await rn.js(tab, NODEISH)).toEqual(NONE)
  expect(await rn.js<string[]>(tab, 'window.__probe()')).toEqual([])

  // A popup and an incognito window too.
  await rn.js(tab, `window.open('/b?popup', 'p', 'width=400,height=300'); true`)
  await poll(async () => (await rn.windows()).some((w) => w.popup && w.snapshot.tabs[0]?.url.endsWith('/b?popup') && !w.snapshot.tabs[0].loading), 'popup')
  const wi = await rn.profiles<number>('newIncognitoWindow', 'default', `${server.base}/b?incog`)
  await rn.waitWindowReady(wi)
  expect(await rn.tabJs(NODEISH, wi)).toEqual(NONE)

  const prefs = await rn.main(({ webContents }) =>
    webContents.getAllWebContents().map((wc) => {
      const p = (wc as any).getLastWebPreferences() as Record<string, unknown> | null
      return { id: wc.id, url: wc.getURL(), type: wc.getType(), p: p && { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames, webSecurity: p.webSecurity, allowRunningInsecureContent: p.allowRunningInsecureContent, webviewTag: p.webviewTag } }
    })
  )
  const pages = prefs.filter((x) => x.p && x.type !== 'remote')
  expect(pages.length).toBeGreaterThanOrEqual(6)
  for (const x of pages) {
    expect(x.p, `${x.type} ${x.url}`).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false })
    expect(x.p!.nodeIntegrationInSubFrames ?? false).toBe(false)
    expect(x.p!.webviewTag ?? false).toBe(false)
  }
  const audits = await rn.main(() => (globalThis as any).__rn.audits() as Array<{ ok: boolean; type: string; problems: string[] }>)
  expect(audits.length).toBeGreaterThanOrEqual(6)
  expect(audits.filter((a) => !a.ok)).toEqual([])
})

test('AC35: bridges are minimal and forged IPC is rejected', async ({ rn, server }) => {
  // newtab exposes exactly its capability-map entries (ipc-contract), plus on/platform.
  const nt = await rn.activeTabWcId()
  const keys = await rn.js<Record<string, string[] | string>>(nt, `(() => { const o = {}; for (const [k, v] of Object.entries(window.retronet)) o[k] = typeof v === 'object' ? Object.keys(v).sort() : typeof v; return o })()`)
  const want: Record<string, string[] | string> = { on: 'function', platform: 'string' }
  for (const m of methodsFor('newtab')) {
    const [ns, fn] = m.split('.') as [string, string]
    ;((want[ns] ??= []) as string[]).push(fn)
  }
  for (const v of Object.values(want)) if (Array.isArray(v)) v.sort()
  expect(keys).toEqual(want)
  expect(keys.settings).toBeUndefined()
  expect(keys.history).toBeUndefined()
  expect(keys.tabs).toBeUndefined()
  expect(await rn.js(nt, `Object.isFrozen(window.retronet.counter)`)).toBe(true)

  // newtab -> settings/shell methods: refused by main even when forged past the preload.
  expect(await rn.forge(nt, 'settings.get', {})).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  expect(await rn.forge(nt, 'settings.set', { skin: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  expect(await rn.forge(nt, 'tabs.create', {})).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  expect(await rn.forge(nt, 'history.clear', {})).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  // Allowed method, bad payload: E_INVALID; prototype pollution keys rejected.
  expect(await rn.forge(nt, 'bookmarks.top', { limit: 'all' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect((await rn.forge(nt, 'bookmarks.top', '{"__proto__":{"limit":1}}')).ok).toBe(false)

  // Shell: payloads are validated.
  expect(await rn.shellCall('tabs.navigate', { input: 42 })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.shellCall('tabs.create', { url: `${server.base}/`, evil: 1 })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.shellCall('layout.setInsets', { top: -5, bottom: 0 })).toMatchObject({ ok: false, code: 'E_INVALID' })

  // A hostile web page: try EVERY registered channel from its webContents. Nothing may succeed.
  await rn.navigate(`${server.base}/fixtures/hostile.html`)
  const web = await rn.activeTabWcId()
  const channels = await rn.main(({ ipcMain }) => [...((ipcMain as any)._invokeHandlers as Map<string, unknown>).keys()].filter((k) => k.startsWith('rn:invoke:')).map((k) => k.slice('rn:invoke:'.length)))
  expect(channels.length).toBeGreaterThan(40)
  const settingsBefore = await rn.main(() => (globalThis as any).__rn.windows()[0].snapshot.skin as string)
  const tabsBefore = await tabCount(rn)
  const results: Record<string, string> = {}
  for (const m of channels) {
    const r = await rn.forge(web, m, {})
    results[m] = r.ok ? 'OK' : String(r.code)
  }
  expect(Object.entries(results).filter(([, c]) => c !== 'E_FORBIDDEN')).toEqual([])
  expect(await tabCount(rn)).toBe(tabsBefore)
  expect(await rn.main(() => (globalThis as any).__rn.windows()[0].snapshot.skin as string)).toBe(settingsBefore)

  // A webContents the router never registered is refused too.
  const stranger = await rn.main(async ({ WebContentsView }) => {
    const v = new WebContentsView()
    await v.webContents.loadURL('data:text/html,<p>x</p>')
    ;(globalThis as any).__e2eStranger = v
    return v.webContents.id
  })
  expect(await rn.forge(stranger, 'skin.get', {})).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  await rn.main(() => (globalThis as any).__e2eStranger.webContents.close())

  const rej = await rn.main(() => (globalThis as any).__rn.rejections() as unknown[])
  expect(rej.length).toBeGreaterThan(channels.length)
  expect(rn.mainLog()).toContain('ipc rejected')
})

test('AC36: retronet:// is unreachable from web pages (iframe, img, fetch, link, window.open, location, redirect)', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/fixtures/hostile.html`)
  const web = await rn.activeTabWcId()
  const n = await tabCount(rn)

  const sub = await rn.js<{ fetch: string; img: string; imp: string }>(
    web,
    `(async () => {
      const f = document.createElement('iframe'); f.src = 'retronet://newtab/'; document.body.append(f);
      const fetchR = await fetch('retronet://newtab/').then(() => 'loaded', () => 'blocked');
      const imgR = await new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'retronet://newtab/img/logo.svg' });
      const impR = await import('retronet://newtab/assets/nope.js').then(() => 'loaded', () => 'blocked');
      await new Promise((r) => setTimeout(r, 500));
      return { fetch: fetchR, img: imgR, imp: impR } })()`
  )
  expect(sub).toEqual({ fetch: 'blocked', img: 'blocked', imp: 'blocked' })
  const frames = await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.mainFrame.framesInSubtree.map((f) => f.url), web)
  expect(frames.filter((u) => u.startsWith('retronet:'))).toEqual([])

  // <a> click, window.open and location assignment (with user gesture) all stay put.
  await rn.js(web, `(() => { const a = document.createElement('a'); a.href = 'retronet://settings/'; a.id = 'evil'; a.textContent = 'x'; document.body.append(a); a.click(); return true })()`)
  await rn.js(web, `window.open('retronet://settings/'); true`)
  await rn.js(web, `location.href = 'retronet://settings/'; true`).catch(() => undefined)
  await settle(800, 'retronet: links from a web page must not open anything')
  let s = await rn.snap()
  expect(s.tabs.filter((t) => t.url.startsWith('retronet://settings'))).toEqual([])
  expect(s.tabs.length).toBe(n)
  expect(await rn.js<string>(web, 'location.href')).toBe(`${server.base}/fixtures/hostile.html`)

  // A server redirect to retronet: is refused.
  await rn.shell('tabs.navigate', { input: `${server.base}/redirect?to=${encodeURIComponent('retronet://settings/')}` })
  await rn.waitSnap((s) => !rn.active(s).loading, 'redirect settled')
  await settle(300, 'redirect to retronet: must not land')
  s = await rn.snap()
  expect(s.tabs.some((t) => t.url.startsWith('retronet://settings'))).toBe(false)
  expect((await rn.tabJs<string>('location.href')).startsWith('retronet://settings')).toBe(false)

  // The shell and overlay hosts are never loadable in a tab, even typed.
  expect(await rn.shell('tabs.navigate', { input: 'retronet://shell/' })).toEqual({ blocked: true })
  expect(await rn.shell('tabs.navigate', { input: 'retronet://overlay/' })).toEqual({ blocked: true })
})

test('AC36: internal pages: user clicks between them work, traversal 404s, strict CSP is served', async ({ rn }) => {
  // A click from retronet://newtab to retronet://history is allowed (user-clicked from an internal page).
  const nt = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(nt, `!!document.querySelector('a[href="retronet://history/"]')`), 'guestbook link on newtab')
  await rn.js(nt, `document.querySelector('a[href="retronet://history/"]').click(); true`)
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://history/') && !rn.active(s).loading, 'clicked to history')

  // ../ traversal (raw and encoded) never escapes the bundle.
  for (const u of ['retronet://newtab/..%2f..%2f..%2fpackage.json', 'retronet://newtab/%2e%2e/%2e%2e/%2e%2e/package.json', 'retronet://newtab/assets/..%5c..%5cpackage.json']) {
    await rn.shell('tabs.navigate', { input: u })
    await rn.waitSnap((s) => !rn.active(s).loading, `traversal ${u}`)
    const r = await poll(async () => {
      const x = await rn.tabJs<{ status: number; body: string }>(`({ status: performance.getEntriesByType('navigation')[0]?.responseStatus ?? -1, body: document.body ? document.body.innerText : '' })`)
      return x.status !== -1 ? x : null
    }, `traversal response ${u}`)
    expect(r.body, u).not.toContain('"devDependencies"')
    expect(r.status, u).toBe(404)
  }

  // CSP header on internal pages (read off the wire with the debugger), and it bites: no eval, no inline script.
  await rn.shell('tabs.navigate', { input: 'retronet://newtab/' })
  await rn.waitSnap((s) => rn.active(s).url === 'retronet://newtab/' && !rn.active(s).loading, 'newtab again')
  const tab = await rn.activeTabWcId()
  const csp = await rn.main(async ({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    const dbg = wc.debugger
    dbg.attach('1.3')
    const got = new Promise<string>((resolve) => {
      dbg.on('message', (_e, method, params: any) => {
        if (method === 'Network.responseReceived' && params.type === 'Document') {
          const h = params.response.headers as Record<string, string>
          resolve(h['content-security-policy'] ?? h['Content-Security-Policy'] ?? '')
        }
      })
    })
    await dbg.sendCommand('Network.enable')
    wc.reload()
    const v = await Promise.race([got, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 5000))])
    dbg.detach()
    return v
  }, tab)
  expect(csp).toContain("default-src 'none'")
  expect(csp).not.toContain('unsafe-inline')
  expect(csp).not.toContain('unsafe-eval')
  expect(csp).not.toMatch(/https?:/)
  await rn.waitSnap((s) => !rn.active(s).loading, 'reloaded newtab')
  const bites = await rn.js<{ evalR: string; inline: unknown }>(
    tab,
    `(async () => { let evalR; try { eval('1'); evalR = 'ran' } catch (e) { evalR = 'blocked' }
      const s = document.createElement('script'); s.textContent = 'window.__inl = 1'; document.head.append(s);
      await new Promise((r) => setTimeout(r, 100)); return { evalR, inline: window.__inl ?? null } })()`
  )
  expect(bites).toEqual({ evalR: 'blocked', inline: null })
})

test('AC37: javascript: blocked; file: only when typed; redirect to file: blocked', async ({ rn, server }) => {
  expect(await rn.shell('tabs.navigate', { input: 'javascript:alert(1)' })).toEqual({ blocked: true })
  expect(await rn.shell('tabs.navigate', { input: ' JaVaScRiPt:alert(1)' })).toEqual({ blocked: true })

  const fileUrl = pathToFileURL(join(FIXTURES, 'hostile.html')).href
  let s = await rn.navigate(fileUrl)
  expect(rn.active(s).security).toBe('file')

  // A web page can't send the tab to file:, by link or redirect.
  await rn.navigate(`${server.base}/a`)
  await rn.tabJs(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(fileUrl)}; document.body.append(a); a.click(); window.open(${JSON.stringify(fileUrl)}); return true })()`)
  await settle(600, 'file: links from a web page must not open anything')
  s = await rn.snap()
  expect(s.tabs.filter((t) => t.url.startsWith('file:'))).toEqual([])
  await rn.shell('tabs.navigate', { input: `${server.base}/redirect?to=${encodeURIComponent(fileUrl)}` })
  await rn.waitSnap((s) => !rn.active(s).loading, 'redirect settled')
  await settle(300, 'redirect to file: must not land')
  expect((await rn.tabJs<string>('location.href')).startsWith('file:')).toBe(false)
  expect((await rn.snap()).tabs.some((t) => t.url.startsWith('file:'))).toBe(false)
})

test('AC37: self-signed HTTPS shows the interstitial; proceeding is explicit, per host, per session', async ({ rn, server }) => {
  const target = `${server.httpsBase}/title?t=Secret%20TLS`
  await rn.shell('tabs.navigate', { input: target })
  await poll(async () => ((await rn.tabJs<string>('location.href')).startsWith('retronet://certerror/') ? true : null), 'cert interstitial')
  let s = await rn.waitSnap((s) => !rn.active(s).loading, 'interstitial loaded')
  expect(rn.active(s).security).toBe('cert-warning')
  expect(server.requests.some((r) => r.secure && r.path.startsWith('/title'))).toBe(false) // TLS refused before any request

  // A forged interstitial URL in another tab grants nothing.
  await rn.shell('tabs.create', { url: `retronet://certerror/?url=${encodeURIComponent(target)}&code=-202` })
  await rn.waitSnap((s) => s.tabs.length === 2 && !rn.active(s).loading, 'forged interstitial tab')
  const forged = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(forged, `typeof window.retronet === 'object'`), 'certerror bridge')
  expect(await rn.bridge(forged, 'certerror.proceed', {})).toMatchObject({ ok: false, code: 'E_NOT_FOUND' })
  await rn.shell('tabs.close', { tabId: (await rn.snap()).activeTabId })
  await rn.waitSnap((s) => s.tabs.length === 1 && !rn.active(s).loading, 'back to the real interstitial')

  // Explicit proceed from the real interstitial.
  expect((await rn.pageCall('certerror.proceed', {})).ok).toBe(true)
  s = await rn.waitSnap((s) => rn.active(s).url === target && !rn.active(s).loading, 'proceeded to the site')
  expect(rn.active(s).title).toBe('Secret TLS')
  expect(rn.active(s).security).toBe('cert-warning')

  // Same host, same session: a new tab loads without the interstitial.
  await rn.shell('tabs.create', { url: `${server.httpsBase}/title?t=Again` })
  s = await rn.waitSnap((s) => s.tabs.some((t) => t.title === 'Again' && !t.loading), 'second tab same host')

  // Another profile (another session) still gets the interstitial.
  const B = await rn.profiles<{ id: string }>('create', 'Other')
  const wB = await rn.profiles<number>('newWindow', B.id, target)
  await poll(async () => {
    const w = (await rn.windows()).find((x) => x.id === wB)
    if (!w || !w.snapshot.tabs[0]) return null
    return (await rn.tabJs<string>('location.href', wB)).startsWith('retronet://certerror/') ? true : null
  }, 'interstitial in another profile')

  // A plain http page shows "Not secure".
  s = await rn.navigate(`${server.base}/a`)
  expect(rn.active(s).security).toBe('insecure')
})

test('AC38: mailto prompts before leaving the app; unknown schemes are blocked without a prompt', async ({ rn, server }) => {
  // Stub the native prompt and the OS hand-off (never open a real mail app in a test).
  await rn.main(({ dialog, shell }) => {
    const g = globalThis as any
    g.__e2eDialogs = []
    g.__e2eOpened = []
    g.__e2eAnswer = 1 // Cancel
    ;(dialog as any).showMessageBox = async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string }
      g.__e2eDialogs.push({ message: opts.message, detail: opts.detail })
      return { response: g.__e2eAnswer, checkboxChecked: false }
    }
    ;(shell as any).openExternal = async (url: string) => {
      g.__e2eOpened.push(url)
    }
  })
  const state = () => rn.main(() => ({ dialogs: (globalThis as any).__e2eDialogs as Array<{ message: string; detail: string }>, opened: (globalThis as any).__e2eOpened as string[] }))

  await rn.navigate(`${server.base}/a`)
  const click = (href: string) => rn.tabJs(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; document.body.append(a); a.click(); return true })()`)
  await click('mailto:someone@example.invalid?subject=hi')
  await poll(async () => (await state()).dialogs.length === 1, 'mailto prompt')
  expect((await state()).dialogs[0]!.detail).toContain('mailto:someone@example.invalid')
  await settle(200, 'cancelled mailto must not be handed to the OS')
  expect((await state()).opened).toEqual([]) // cancelled

  await rn.main(() => {
    ;(globalThis as any).__e2eAnswer = 0 // Open
  })
  await click('mailto:someone@example.invalid')
  await poll(async () => (await state()).opened.length === 1, 'mailto handed to the OS after Open')
  expect((await state()).opened[0]).toBe('mailto:someone@example.invalid')

  // Unknown / dangerous schemes: no prompt, nothing opened, the tab stays.
  const before = (await state()).dialogs.length
  for (const href of ['foo-unknown:bar', 'ms-settings:privacy', 'vscode://file/etc/passwd', 'smb://evil/share']) await click(href)
  await settle(600, 'dangerous schemes must neither prompt nor open')
  expect((await state()).dialogs.length).toBe(before)
  expect((await state()).opened).toHaveLength(1)
  expect(await rn.tabJs<string>('location.href')).toBe(`${server.base}/a`)
})

test('S10: tabs opened from retronet: pages get no window.opener', async ({ rn, server }) => {
  const nt = await rn.activeTabWcId()
  await rn.js(nt, `window.open(${JSON.stringify(`${server.base}/b?from-newtab`)}); true`)
  const s = await rn.waitSnap((s) => s.tabs.some((t) => t.url.endsWith('/b?from-newtab') && !t.loading), 'child tab from newtab')
  expect(s.tabs.length).toBe(2)
  const [child] = await rn.wcIdsByUrl(`${server.base}/b?from-newtab`)
  expect(await rn.js(child!, 'window.opener === null')).toBe(true)

  // Same check for a link with target=_blank.
  await rn.shell('tabs.activate', { tabId: s.tabs[0]!.id })
  await rn.js(nt, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(`${server.base}/b?blank-from-newtab`)}; a.target = '_blank'; document.body.append(a); a.click(); return true })()`)
  await rn.waitSnap((s) => s.tabs.some((t) => t.url.endsWith('/b?blank-from-newtab') && !t.loading), 'blank child')
  const [child2] = await rn.wcIdsByUrl(`${server.base}/b?blank-from-newtab`)
  expect(await rn.js(child2!, 'window.opener === null')).toBe(true)

  // Web-to-web window.open keeps its opener (AC8), so the rule is specific to internal pages.
  await rn.navigate(`${server.base}/a`, { windowId: undefined })
  const web = await rn.activeTabWcId()
  await rn.js(web, `window.open('/b?web-child'); true`)
  await rn.waitSnap((s) => s.tabs.some((t) => t.url.endsWith('/b?web-child') && !t.loading), 'web child')
  const [child3] = await rn.wcIdsByUrl(`${server.base}/b?web-child`)
  expect(await rn.js(child3!, '!!window.opener')).toBe(true)
})
