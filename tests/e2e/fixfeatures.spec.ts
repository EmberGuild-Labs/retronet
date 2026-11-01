// Fix round 1 coverage (FX-E): Print command (Q4), HTTP Basic auth dialog (Q3), incognito bookmarks (D7),
// userinfo URL display (Q5/Q6). Specs follow the documented behaviour on .team/BOARD.md "FIX ROUND 1";
// all features have landed (FX-A..FX-D), so nothing is fixme any more.
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect, poll, settle, readJson } from './helpers/launch'
import type { RN } from './helpers/launch'

test('Q4: Print... is a palette command bound to Cmd+P (native dialog not opened)', async ({ rn }) => {
  const sc = await rn.openInternal('shortcuts')
  const r = await rn.bridge<{ commands: Array<{ id: string; accelerators: string[]; palette: boolean }> }>(sc, 'commands.list', {})
  expect(r.ok).toBe(true)
  const print = r.data!.commands.find((c) => c.id === 'file.print')
  expect(print, 'file.print registered').toBeTruthy()
  expect(print!.palette).toBe(true)
  expect(print!.accelerators.join(' ')).toMatch(/P/)
})


const authId = (rn: RN, overlayId: number) =>
  rn.js<string | null>(overlayId, `document.querySelector('.rn-modal[data-auth-id]')?.dataset.authId ?? null`)
const submitAuth = (rn: RN, overlayId: number, user: string, pass: string) =>
  rn.js(overlayId, `(() => { const u = document.querySelector('.rn-http-auth input[type=text]'); const p = document.querySelector('.rn-http-auth input[type=password]'); u.value = ${JSON.stringify(user)}; p.value = ${JSON.stringify(pass)}; [...document.querySelectorAll('.rn-http-auth button')].find((b) => b.textContent === 'Sign in').click(); return true })()`)

// FX-B: src/main/security/http-auth.ts + overlay kind 'http-auth' + httpAuth.respond.
test('Q3: HTTP Basic auth: wrong creds re-prompt, right creds load, Cancel shows the 401 body, cross-origin subresources never prompt', async ({ rn, server }) => {
  await rn.shell('tabs.navigate', { input: `${server.base}/basic-auth` })
  await poll(async () => (await rn.win()).overlayKind === 'http-auth', 'http-auth overlay')
  const w = await rn.win()
  const id1 = await poll(() => authId(rn, w.overlayId), 'dialog mounted')
  const text = await rn.js<string>(w.overlayId, `document.querySelector('.rn-http-auth').innerText`)
  expect(text).toContain('RetroNet Test')

  // Wrong credentials through the real dialog: Chromium asks again, as a NEW dialog id.
  await submitAuth(rn, w.overlayId, 'alice', 'nope')
  const id2 = await poll(async () => {
    const x = await authId(rn, (await rn.win()).overlayId)
    return x && x !== id1 ? x : null
  }, 're-prompt after wrong credentials')
  expect(id2).not.toBe(id1)
  expect(rn.active(await rn.snap()).title).not.toBe('Authed')

  // Right credentials: the page loads and the dialog goes away.
  await submitAuth(rn, w.overlayId, 'alice', 'wonder')
  await rn.waitSnap((s) => rn.active(s).title === 'Authed' && !rn.active(s).loading, 'authenticated page')
  await poll(async () => (await rn.win()).overlayKind === null, 'dialog closed after success')

  // A stale dialog id is rejected.
  const stale = await rn.bridge(w.overlayId, 'httpAuth.respond', { id: id1, cancel: true })
  expect(stale.ok).toBe(false)

  // Another origin that sends a 401 on the top-level page and also on cross-origin subresources.
  let srv: Server | undefined
  try {
    const hits: string[] = []
    srv = createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`)
      if (req.url === '/page') {
        const port = (srv!.address() as { port: number }).port
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<title>Plain</title><img src="http://localhost:${port}/locked.png"><iframe src="http://localhost:${port}/locked-frame"></iframe><script>fetch('http://localhost:${port}/locked-fetch',{credentials:'include'}).catch(()=>{})</script>`)
        return
      }
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Other realm"', 'content-type': 'text/html' })
      res.end('<title>Nope401</title><p>401 body</p>')
    })
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port

    // Cancel (Esc) leaves the server's own 401 page.
    await rn.shell('tabs.navigate', { input: `http://127.0.0.1:${port}/locked` })
    await poll(async () => (await rn.win()).overlayKind === 'http-auth', 'second dialog')
    await poll(() => authId(rn, w.overlayId), 'second dialog mounted')
    await rn.press('Escape', [], 'overlay')
    await rn.waitSnap((s) => rn.active(s).title === 'Nope401' && !rn.active(s).loading, '401 body after cancel')
    await poll(async () => (await rn.win()).overlayKind === null, 'dialog closed after cancel')

    // Cross-origin img/iframe/fetch to localhost (a different origin than 127.0.0.1): no dialog, ever.
    await rn.navigate(`http://127.0.0.1:${port}/page`)
    await poll(() => hits.some((h) => h.includes('/locked-frame')) && hits.some((h) => h.includes('/locked-fetch')), 'subresources requested')
    await settle(800, 'no sign-in dialog from cross-origin subresources')
    expect((await rn.win()).overlayKind).toBe(null)
    expect(rn.active(await rn.snap()).title).toBe('Plain')
  } finally {
    srv?.close()
  }
})

// FX-A: D7 = incognito shares the parent profile's BOOKMARKS store; history/downloads/cookies stay memory-only.
test('D7: a bookmark added in an incognito window lands in the parent profile bookmarks.json; incognito history never reaches disk', async ({ rn, server }) => {
  const prof = join(rn.userData, 'Profiles', 'default')
  const wi = await rn.profiles<number>('newIncognitoWindow', undefined, `${server.base}/title?t=IncogMark`)
  await rn.waitWindowReady(wi)
  await rn.waitSnap((s) => rn.active(s).url.includes('IncogMark') && !rn.active(s).loading, 'incognito page loaded', { windowId: wi })

  // Star via the toolbar command, then add another through the bookmarks page API.
  const r = await rn.shell<{ bookmarked: boolean }>('bookmarks.toggleCurrent', {}, wi)
  expect(r.bookmarked).toBe(true)
  await rn.waitSnap((s) => rn.active(s).bookmarked === true, 'incognito star on', { windowId: wi })
  const bm = await rn.openInternal('bookmarks', wi)
  const added = await rn.bridge(bm, 'bookmarks.add', { parentId: 'bar', title: 'FromIncognito', url: `${server.base}/b` })
  expect(added.ok).toBe(true)

  // The regular window sees both in its bar.
  const regular = (await rn.windows()).find((x) => !x.incognito)!
  const bar = await rn.shellCall<{ items: Array<{ title: string }> }>('bookmarks.bar', {}, regular.id)
  expect(bar.data!.items.some((n) => n.title === 'FromIncognito')).toBe(true)

  // On disk: the parent's bookmarks.json has both; history.json has neither the incognito page nor its URL.
  await rn.flush(join(prof, 'bookmarks.json'), (j) => JSON.stringify(j).includes('FromIncognito') && JSON.stringify(j).includes('IncogMark'), 'bookmarks.json with incognito bookmarks')
  expect(readFileSync(join(prof, 'bookmarks.json'), 'utf8')).toContain('FromIncognito')
  await rn.flush()
  const hist = readJson(join(prof, 'history.json'))
  expect(JSON.stringify(hist ?? {})).not.toContain('IncogMark')
  expect(JSON.stringify(hist ?? {})).not.toContain(`${server.base}/b`)
})

// FX-A (storage) + FX-C (display): Q6.
test('Q6: userinfo URLs: no user:pass@ in history.json/session.json, omnibox shows neither credentials nor spoofable host', async ({ rn, server }) => {
  const prof = join(rn.userData, 'Profiles', 'default')
  const withCreds = server.base.replace('http://', 'http://qa:pw@') + '/title?t=Creds'
  await rn.navigate(withCreds, { expectUrl: (u) => u.includes('/title?t=Creds') })
  await rn.shell('tabs.create', { url: server.base.replace('http://', 'http://google.com@') + '/title?t=Spoof' })
  await rn.waitSnap((s) => s.tabs.length === 2 && s.tabs.every((t) => !t.loading), 'second tab loaded')

  const w = await rn.win()
  const omni = await poll(() => rn.js<{ value: string; display: string; title: string }>(w.shellId,
    `(() => { const i = document.querySelector('.rn-omnibox__input'); const d = document.querySelector('.rn-omnibox__display'); return i && i.value ? { value: i.value, display: d ? d.textContent : '', title: [...document.querySelectorAll('.rn-tab')].map((t) => t.title).join('|') } : null })()`), 'omnibox value')
  for (const field of [omni.value, omni.display, omni.title]) {
    expect(field).not.toMatch(/qa:pw|pw@|google\.com@/)
  }
  expect(omni.value).toContain('/title?t=Spoof')

  await rn.flush(join(prof, 'history.json'), (j) => JSON.stringify(j).includes('t=Creds') && JSON.stringify(j).includes('t=Spoof'), 'history.json with both pages')
  await rn.flush(join(prof, 'session.json'), (j) => JSON.stringify(j).includes('t=Creds') && JSON.stringify(j).includes('t=Spoof'), 'session.json with both tabs')
  for (const f of ['history.json', 'session.json']) {
    const txt = readFileSync(join(prof, f), 'utf8')
    expect(txt, f).not.toMatch(/qa:pw|pw@|google\.com@/)
  }
})

// FX-C D3: launch focus.
test('D3: at launch the omnibox, not the + button, holds focus', async ({ rn }) => {
  const w = await rn.win()
  const cls = await poll(() => rn.js<string>(w.shellId, `document.activeElement && document.activeElement.className ? String(document.activeElement.className) : ''`).then((c) => (c.includes('rn-omnibox__input') ? c : null)), 'omnibox focused at launch')
  expect(cls).toContain('rn-omnibox__input')
})

// FX-C D11: host emphasis layer.
test('D11: unfocused omnibox shows the host emphasis layer; the input value stays the full URL', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  const w = await rn.win()
  await rn.js(w.shellId, `(document.activeElement && document.activeElement.blur(), true)`)
  const o = await poll(() => rn.js<{ display: string; host: string; value: string } | null>(w.shellId,
    `(() => { const i = document.querySelector('.rn-omnibox__input'); const d = document.querySelector('.rn-omnibox__display'); if (!i || !d || i.value !== ${JSON.stringify(server.base + '/a')}) return null; return { display: getComputedStyle(d).display, host: document.querySelector('.rn-omnibox__host').textContent, value: i.value } })()`), 'emphasis layer for /a')
  expect(o.display).not.toBe('none')
  expect(o.host).toBe('127.0.0.1')
  expect(o.value).toBe(`${server.base}/a`)
  // Focusing the field to edit swaps back to plain text.
  await rn.js(w.shellId, `(document.querySelector('.rn-omnibox__input').focus(), true)`)
  await poll(() => rn.js<boolean>(w.shellId, `getComputedStyle(document.querySelector('.rn-omnibox__display')).display === 'none'`), 'emphasis layer hidden while editing')
})

// FX-C Q7: over-long input.
test('Q7: a 9000-character address shows "Address too long" and does not navigate', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  const w = await rn.win()
  const before = rn.active(await rn.snap()).url
  const long = `${server.base}/long?q=${'y'.repeat(9000)}`
  await rn.js(w.shellId, `(() => { const i = document.querySelector('.rn-omnibox__input'); i.focus(); i.value = ${JSON.stringify(long)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await rn.press('Enter', [], 'shell')
  const err = await poll(() => rn.js<string | null>(w.shellId, `(() => { const e = document.querySelector('.rn-omnibox__error'); return e && !e.hidden ? e.textContent : null })()`), 'inline error')
  expect(err).toMatch(/^Address too long/)
  await settle(500, 'over-long address must not navigate')
  const s = await rn.snap()
  expect(s.tabs.length).toBe(1)
  expect(rn.active(s).url).toBe(before)
  expect(server.requests.some((r) => r.path.startsWith('/long'))).toBe(false)
})

// FX-C Q9: link drops on the tab strip.
test('Q9: dropping a link on the tab strip opens/navigates; file:, retronet: and javascript: drops are refused', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/a`)
  const w = await rn.win()
  const drop = (sel: string, uri: string, frac: number) => rn.js<{ accepted: boolean }>(w.shellId, `(() => {
    const t = document.querySelector(${JSON.stringify(sel)}); const r = t.getBoundingClientRect();
    const dt = new DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(uri)});
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width * ${frac}, clientY: r.top + r.height / 2 };
    const over = new DragEvent('dragover', at); t.dispatchEvent(over);
    t.dispatchEvent(new DragEvent('drop', at));
    return { accepted: over.defaultPrevented } })()`)

  // Refused schemes first: no tab, no navigation, whether dropped on the empty strip or on a tab.
  for (const bad of ['file:///etc/passwd', 'retronet://history/', 'javascript:alert(1)']) {
    await drop('.rn-tabstrip__tabs', bad, 0.99)
    await drop('.rn-tab', bad, 0.5)
  }
  await settle(600, 'refused drops must open nothing')
  let s = await rn.snap()
  expect(s.tabs.length).toBe(1)
  expect(rn.active(s).url).toBe(`${server.base}/a`)

  // An http link on the empty strip opens a new tab.
  const ok = await drop('.rn-tabstrip__tabs', `${server.base}/title?t=Dropped`, 0.99)
  expect(ok.accepted).toBe(true)
  s = await rn.waitSnap((x) => x.tabs.length === 2 && x.tabs.some((t) => t.url.includes('t=Dropped')), 'dropped link opened a tab')
  expect(s.tabs.every((t) => !t.url.startsWith('file:') && !t.url.startsWith('javascript:'))).toBe(true)
})

// FX-B R4/N3: page context menu only offers openable link targets.
test('R4/N3: link context menu omits "Open in new tab" for file:/retronet:/javascript: links, keeps it for http', async ({ rn, server }) => {
  // Native menus never reach the screen (PLAN-FINAL §0); the page menu itself is themed and read via __rn.menu().
  await rn.main(({ Menu }) => {
    Menu.prototype.popup = function () {
      ;(globalThis as any).__lastMenu = this
    }
  })
  await rn.navigate(`${server.base}/fixtures/ctx-links.html`)
  const tab = await rn.activeTabWcId()
  const win = (await rn.win()).id
  const ctx = async (id: string): Promise<string[]> => {
    const box = await rn.js<{ x: number; y: number }>(tab, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + 10) } })()`)
    const before = await rn.main((_e, w: number) => (globalThis as any).__rn.currentMenu(w)?.menuId ?? null, win)
    await rn.main(({ webContents }, a: { id: number; x: number; y: number }) => {
      const wc = webContents.fromId(a.id)!
      wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'right', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: 'right', clickCount: 1 })
    }, { id: tab, ...box })
    const ids = await poll(() => rn.main((_e, a: { w: number; before: string | null }) => {
      const m = (globalThis as any).__rn.currentMenu(a.w)
      return m && m.menuId !== a.before ? (m.items.map((i: any) => i.id).filter(Boolean) as string[]) : null
    }, { w: win, before }), `context menu for #${id}`)
    // Close it again (Esc in the overlay) so the next right-click starts clean.
    await rn.press('Escape', [], 'overlay')
    await poll(() => rn.main((_e, w: number) => (globalThis as any).__rn.currentMenu(w) === null, win), 'menu closed')
    return ids
  }
  const http = await ctx('l-http')
  expect(http).toEqual(expect.arrayContaining(['ctx.openLinkTab', 'ctx.openLinkWindow', 'ctx.openLinkIncognito', 'ctx.copyLink']))
  for (const id of ['l-file', 'l-rn', 'l-js']) {
    const ids = await ctx(id)
    expect(ids, id).toContain('ctx.copyLink')
    expect(ids, id).not.toContain('ctx.openLinkTab')
    expect(ids, id).not.toContain('ctx.openLinkWindow')
    expect(ids, id).not.toContain('ctx.openLinkIncognito')
  }
})

// FR2-A R15: a background tab's waiting sign-in must not hide the active tab's dialog; switching tabs swaps them.
test('R15: two tabs waiting on HTTP auth: the dialog follows the active tab', async ({ rn, server }) => {
  const s0 = await rn.snap()
  const tab1 = s0.activeTabId
  await rn.shell('tabs.navigate', { input: `${server.base}/basic-auth?t=1` })
  await poll(async () => (await rn.win()).overlayKind === 'http-auth', 'tab 1 dialog')
  const w = await rn.win()
  const id1 = await poll(() => authId(rn, w.overlayId), 'tab 1 dialog mounted')

  // Tab 2 asks while in the background: tab 1's dialog stays.
  const tab2 = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/basic-auth?t=2`, background: true })).tabId
  await settle(600, 'tab 2 challenge queued')
  expect(await authId(rn, w.overlayId)).toBe(id1)

  // Activate tab 2: its own dialog shows (a new id), though tab 1's was queued first.
  await rn.shell('tabs.activate', { tabId: tab2 })
  const id2 = await poll(async () => {
    const x = (await rn.win()).overlayKind === 'http-auth' ? await authId(rn, w.overlayId) : null
    return x && x !== id1 ? x : null
  }, 'tab 2 dialog after switching')
  await submitAuth(rn, w.overlayId, 'alice', 'wonder')
  await rn.waitSnap((s) => rn.active(s).id === tab2 && rn.active(s).title === 'Authed' && !rn.active(s).loading, 'tab 2 signed in')

  // Back to tab 1: its dialog is still waiting and shows again.
  await rn.shell('tabs.activate', { tabId: tab1 })
  await poll(async () => ((await rn.win()).overlayKind === 'http-auth' ? (await authId(rn, w.overlayId)) === id1 : false), 'tab 1 dialog again')
  expect(id2).not.toBe(id1)
  await rn.press('Escape', [], 'overlay')
  await rn.waitSnap((s) => rn.active(s).id === tab1 && rn.active(s).title === 'Denied' && !rn.active(s).loading, 'tab 1 401 body after cancel')
})
