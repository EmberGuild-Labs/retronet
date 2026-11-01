// AC2 (back/forward/reload/stop/home + button states), AC4 (title, favicon, omnibox URL, in-page navigation),
// AC27 (status bar: "Contacting host..." -> progress -> "Document: Done.", hover URL, error text).
import { test, expect, poll, type RN, until } from './helpers/launch'

interface ToolbarState {
  back: boolean | null
  forward: boolean | null
  stop: boolean | null
  reload: boolean | null
  omnibox: string
  security: string | null
  status: string
  statusError: string | null
}

async function toolbar(rn: RN): Promise<ToolbarState> {
  const w = await rn.win()
  return rn.js<ToolbarState>(
    w.shellId,
    `(() => {
      const en = (a) => { const b = document.querySelector('.rn-toolbar [data-action="' + a + '"]'); return b ? !b.disabled : null }
      const input = document.querySelector('.rn-omnibox__input')
      const text = document.querySelector('.rn-statusbar__text')
      return { back: en('back'), forward: en('forward'), stop: en('stop'), reload: en('reload'),
        omnibox: input ? input.value : '', security: document.querySelector('.rn-omnibox')?.getAttribute('data-security') ?? null,
        status: text ? text.textContent : '', statusError: text ? text.getAttribute('data-error') : null }
    })()`
  )
}

test('back, forward, reload, stop and home, with button states', async ({ rn, server }) => {
  let tb = await poll(async () => {
    const t = await toolbar(rn)
    // QA: wait for the shell to render the settled (not loading) state; the snapshot can be idle a frame
    // before the toolbar DOM catches up (flaked once with stop still enabled).
    return t.back !== null && t.stop === false ? t : null
  }, 'toolbar rendered')
  expect(tb).toMatchObject({ back: false, forward: false, stop: false, reload: true })

  await rn.navigate(`${server.base}/a`)
  let s = await rn.navigate(`${server.base}/b`)
  expect(rn.active(s)).toMatchObject({ canGoBack: true, canGoForward: false })
  tb = await poll(async () => ((await toolbar(rn)).back ? toolbar(rn) : null), 'back enabled')
  expect(tb).toMatchObject({ back: true, forward: false, stop: false })

  await rn.shell('tabs.back', {})
  s = await rn.waitSnap((s) => rn.active(s).url === `${server.base}/a` && !rn.active(s).loading, 'back to /a')
  expect(rn.active(s).canGoForward).toBe(true)
  tb = await poll(async () => ((await toolbar(rn)).forward ? toolbar(rn) : null), 'forward enabled')
  expect(tb.forward).toBe(true)

  await rn.shell('tabs.forward', {})
  s = await rn.waitSnap((s) => rn.active(s).url === `${server.base}/b` && !rn.active(s).loading, 'forward to /b')
  expect(rn.active(s).canGoForward).toBe(false)

  // Reload: a marker set in the page is gone afterwards.
  await rn.tabJs(`window.__marker = 42`)
  await rn.shell('tabs.reload', {})
  await poll(async () => (await rn.tabJs(`window.__marker === undefined && document.readyState === 'complete'`)) === true, 'reloaded page')

  // Stop is only enabled while loading.
  await rn.recordShellEvents(['status'])
  await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=4000` })
  await rn.waitSnap((s) => rn.active(s).loading, 'slow load started')
  tb = await poll(async () => ((await toolbar(rn)).stop ? toolbar(rn) : null), 'stop enabled while loading')
  expect(tb.stop).toBe(true)
  await rn.shell('tabs.stop', {})
  await rn.waitSnap((s) => !rn.active(s).loading, 'stopped')
  tb = await poll(async () => ((await toolbar(rn)).stop === false ? toolbar(rn) : null), 'stop disabled after stop')
  expect(tb.stop).toBe(false)
  const texts = (await rn.shellEvents<{ text: string }>('status')).map((e) => e.text)
  expect(texts).toContain('Transfer interrupted.')
  expect(texts).not.toContain('Document: Done.')

  await rn.shell('tabs.home', {})
  s = await rn.waitSnap((s) => rn.active(s).url === 'retronet://newtab/' && !rn.active(s).loading, 'home -> newtab')
  expect(rn.active(s).security).toBe('internal')
})

test('tab title, favicon and omnibox URL, including in-page navigation', async ({ rn, server }) => {
  let s = await rn.navigate(`${server.base}/a`)
  s = await rn.waitSnap((s) => !!rn.active(s).faviconDataUrl, 'favicon')
  const t = rn.active(s)
  expect(t.title).toBe('Page A')
  expect(t.faviconDataUrl!.startsWith('data:image/')).toBe(true)
  expect(t.security).toBe('insecure')

  const w = await rn.win()
  const dom = await poll(
    () =>
      rn.js<{ title: string; img: string; omni: string; sec: string | null } | null>(
        w.shellId,
        `(() => { const tab = document.querySelector('.rn-tab[aria-selected="true"]') || document.querySelector('.rn-tab'); if (!tab) return null;
          const img = tab.querySelector('img'); const input = document.querySelector('.rn-omnibox__input');
          const r = { title: tab.textContent || '', img: img ? img.getAttribute('src') || '' : '', omni: input ? input.value : '', sec: document.querySelector('.rn-omnibox')?.getAttribute('data-security') ?? null };
          return r.title.includes('Page A') && r.img ? r : null })()`
      ),
    'tab strip shows title + favicon'
  )
  expect(dom.img.startsWith('data:image/')).toBe(true)
  expect(dom.omni).toContain(`127.0.0.1:${server.base.split(':')[2]}/a`)
  expect(dom.sec).toBe('insecure')

  // In-page navigation (pushState and fragment) updates the omnibox without a load.
  await rn.tabJs(`history.pushState({}, '', '/a?pushed=1'); true`)
  s = await rn.waitSnap((s) => rn.active(s).url === `${server.base}/a?pushed=1`, 'pushState url')
  expect(rn.active(s).canGoBack).toBe(true)
  await rn.tabJs(`location.hash = 'frag'; true`)
  await rn.waitSnap((s) => rn.active(s).url === `${server.base}/a?pushed=1#frag`, 'hash url')
  await poll(async () => (await toolbar(rn)).omnibox.includes('pushed=1#frag'), 'omnibox shows in-page URL')

  // document.title changes reach the tab.
  await rn.tabJs(`document.title = 'Renamed'; true`)
  await rn.waitSnap((s) => rn.active(s).title === 'Renamed', 'title change')
})

test('status bar: Contacting host... through Document: Done., hover URL, and errors', async ({ rn, server }) => {
  await rn.recordShellEvents(['status'])
  await rn.navigate(`${server.base}/a`)
  await until(async () => (await rn.shellEvents<{ text: string }>('status')).some((e) => e.text === 'Document: Done.'), 'Document: Done. status event')
  const tabId = (await rn.snap()).activeTabId
  const evs = await rn.shellEvents<{ tabId: number; text: string; hoverUrl: string | null; error: boolean; announce: boolean }>('status')
  const texts = evs.filter((e) => e.tabId === tabId && e.hoverUrl === null).map((e) => e.text)
  const want = ['Contacting host...', 'Waiting for reply...', `Transferring data from ${server.host}...`, 'Document: Done.']
  const idx = want.map((w) => texts.indexOf(w))
  expect(idx.every((v) => v >= 0), `all phases present in ${JSON.stringify(texts)}`).toBe(true)
  expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  await poll(async () => (await toolbar(rn)).status === 'Document: Done.', 'status bar shows Document: Done.')

  // While a slow reply is pending the bar shows a progress phase, never Done.
  await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=1500` })
  const mid = await poll(async () => {
    const t = await toolbar(rn)
    return t.status === 'Contacting host...' || t.status === 'Waiting for reply...' ? t : null
  }, 'progress text while loading')
  expect(mid.status).not.toBe('Document: Done.')
  await rn.waitSnap((s) => !rn.active(s).loading && rn.active(s).title === 'Slow', 'slow done')
  await poll(async () => (await toolbar(rn)).status === 'Document: Done.', 'Done after slow')

  // Hovering a link shows its URL; leaving restores the phase text.
  await rn.navigate(`${server.base}/a`)
  const tabWc = await rn.activeTabWcId()
  const pt = await rn.js<[number, number]>(tabWc, `(() => { const b = document.getElementById('to-b').getBoundingClientRect(); return [Math.round(b.x + 5), Math.round(b.y + 5)] })()`)
  await rn.main(({ webContents }, a: { id: number; x: number; y: number }) => {
    webContents.fromId(a.id)!.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y })
  }, { id: tabWc, x: pt[0], y: pt[1] })
  await poll(async () => (await toolbar(rn)).status === `${server.base}/b`, 'hover URL in status bar')
  await rn.main(({ webContents }, id: number) => {
    webContents.fromId(id)!.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 })
  }, tabWc)
  await poll(async () => (await toolbar(rn)).status === 'Document: Done.', 'status restored after hover')

  // Connection refused: error text, flagged, and the neterror interstitial.
  const dead = `http://127.0.0.1:${server.deadPort}/`
  await rn.shell('tabs.navigate', { input: dead })
  const tb = await poll(async () => {
    const t = await toolbar(rn)
    return t.status.startsWith('Error:') ? t : null
  }, 'error status')
  expect(tb.status).toBe('Error: connection refused.')
  expect(tb.statusError).toBe('true')
  const s = await rn.waitSnap((s) => !rn.active(s).loading, 'failed load settled')
  expect(rn.active(s).url).toBe(dead)
  await poll(async () => ((await rn.tabJs<string>('location.href')).startsWith('retronet://neterror/') ? true : null), 'neterror page in tab')
})
