// AC21 (Chrome-convention shortcuts, sent into web content that tries to swallow keys), AC22 (command palette),
// AC23 (shortcuts listed on retronet://shortcuts). Keys go through webContents.sendInputEvent, the same
// before-input-event path a physical key takes. macOS chords (this suite runs on the mac build).
import { test, expect, poll } from './helpers/launch'

test.skip(process.platform !== 'darwin', 'chords below are the macOS set')

test('browser shortcuts work from inside a hostile page that swallows keys', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/fixtures/hostile.html`)
  await rn.recordShellEvents(['ui', 'find'])
  const hostile = await rn.activeTabWcId()

  // Cmd+T: new tab, omnibox focused; the page never sees the chord.
  await rn.press('T', ['meta'])
  let s = await rn.waitSnap((s) => s.tabs.length === 2 && rn.active(s).url === 'retronet://newtab/', 'Cmd+T')
  expect(await rn.js<string[]>(hostile, 'window.__keys')).toEqual([])
  expect((await rn.shellEvents<{ action: string }>('ui')).some((u) => u.action === 'focus-omnibox')).toBe(true)
  const [t1, t2] = s.tabs.map((t) => t.id)

  // Tab switching: Cmd+1, Cmd+9, Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Opt+Arrows.
  await rn.press('1', ['meta'])
  await rn.waitSnap((s) => s.activeTabId === t1, 'Cmd+1')
  await rn.press('9', ['meta'])
  await rn.waitSnap((s) => s.activeTabId === t2, 'Cmd+9')
  await rn.press('Tab', ['control'])
  await rn.waitSnap((s) => s.activeTabId === t1, 'Ctrl+Tab wraps')
  await rn.press('Tab', ['control', 'shift'])
  await rn.waitSnap((s) => s.activeTabId === t2, 'Ctrl+Shift+Tab')
  await rn.press('Left', ['meta', 'alt'])
  await rn.waitSnap((s) => s.activeTabId === t1, 'Cmd+Opt+Left')
  await rn.press('Right', ['meta', 'alt'])
  await rn.waitSnap((s) => s.activeTabId === t2, 'Cmd+Opt+Right')

  // Cmd+L focuses the omnibox; Cmd+F opens find (from the page).
  await rn.press('1', ['meta'])
  await rn.waitSnap((s) => s.activeTabId === t1, 'back on hostile')
  await rn.clearShellEvents()
  await rn.recordShellEvents(['ui', 'find'])
  await rn.press('L', ['meta'])
  await poll(async () => (await rn.shellEvents<{ action: string }>('ui')).some((u) => u.action === 'focus-omnibox'), 'Cmd+L')
  await rn.press('F', ['meta'])
  await poll(async () => (await rn.shellEvents<{ type: string }>('find')).some((f) => f.type === 'open'), 'Cmd+F')
  expect((await rn.shellCall('find.query', { text: 'apple' })).ok).toBe(true)
  const res = await poll(async () => (await rn.shellEvents<{ type: string; matches: number; final: boolean }>('find')).find((f) => f.type === 'result' && f.final), 'find result')
  expect(res.matches).toBe(3)
  await rn.shell('find.close', {})

  // Zoom: Cmd+= / Cmd+- / Cmd+0.
  await rn.press('=', ['meta'])
  s = await rn.waitSnap((s) => rn.active(s).zoomPercent > 100, 'Cmd+= zooms in')
  await rn.press('0', ['meta'])
  await rn.waitSnap((s) => rn.active(s).zoomPercent === 100, 'Cmd+0 resets')
  await rn.press('-', ['meta'])
  await rn.waitSnap((s) => rn.active(s).zoomPercent < 100, 'Cmd+- zooms out')
  await rn.press('0', ['meta'])

  // Cmd+R reloads (marker cleared), Cmd+D bookmarks.
  await rn.js(hostile, 'window.__marker = 1')
  await rn.press('R', ['meta'])
  await poll(async () => (await rn.js(hostile, `window.__marker === undefined && document.readyState === 'complete'`)) === true, 'Cmd+R reload')
  await rn.press('D', ['meta'])
  await rn.waitSnap((s) => rn.active(s).bookmarked, 'Cmd+D')

  // Cmd+Y history, Cmd+Shift+J downloads open internal pages.
  await rn.press('Y', ['meta'])
  await rn.waitSnap((s) => s.tabs.some((t) => t.url.startsWith('retronet://history/')), 'Cmd+Y')
  await rn.press('J', ['meta', 'shift'])
  await rn.waitSnap((s) => s.tabs.some((t) => t.url.startsWith('retronet://downloads/')), 'Cmd+Shift+J')

  // Devtools: Cmd+Opt+I toggles for the active tab.
  await rn.press('1', ['meta'])
  await rn.waitSnap((s) => s.activeTabId === t1, 'hostile active')
  await rn.press('I', ['meta', 'alt'])
  await poll(() => rn.main(({ webContents }, id: number) => webContents.fromId(id)!.isDevToolsOpened(), hostile), 'devtools open')
  await rn.press('I', ['meta', 'alt'])
  await poll(async () => !(await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.isDevToolsOpened(), hostile)), 'devtools closed')

  // Cmd+W closes the key-swallowing tab; Cmd+N opens a window.
  const before = (await rn.snap()).tabs.length
  await rn.press('W', ['meta'])
  await rn.waitSnap((s) => s.tabs.length === before - 1, 'Cmd+W')
  await rn.press('N', ['meta'], 'shell')
  await poll(async () => (await rn.windows()).filter((w) => !w.incognito).length === 2, 'Cmd+N')
  expect(await rn.js<string[]>(hostile, 'window.__keys').catch(() => [])).toEqual([])
})

test('command palette: opens with Cmd+Shift+P and toggles closed', async ({ rn }) => {
  await rn.press('P', ['meta', 'shift'], 'shell')
  await poll(async () => (await rn.win()).overlayKind === 'palette', 'palette overlay shown')
  await rn.press('P', ['meta', 'shift'], 'overlay')
  await poll(async () => (await rn.win()).overlayKind !== 'palette', 'palette closed')
  // commands.run from the overlay (what the palette does on Enter) runs the command.
  await rn.press('P', ['meta', 'shift'], 'shell')
  await poll(async () => (await rn.win()).overlayKind === 'palette', 'palette again')
  const w = await rn.win()
  expect((await rn.bridge(w.overlayId, 'commands.run', { id: 'tab.new' })).ok).toBe(true)
  await rn.waitSnap((s) => s.tabs.length === 2, 'palette ran tab.new')
  expect((await rn.win()).overlayKind).not.toBe('palette')
})

// T20 (overlay UI) renders the palette list; this drives it like a user.
test('command palette UI: lists commands with shortcuts, fuzzy filters, Enter runs, Esc closes', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Palette%20Tab`)
  await rn.press('P', ['meta', 'shift'], 'shell')
  const w = await poll(async () => {
    const x = await rn.win()
    return x.overlayKind === 'palette' ? x : null
  }, 'palette overlay')
  const items = await poll(
    () => rn.js<string[] | null>(w.overlayId, `(() => { const els = [...document.querySelectorAll('.rn-palette__item')]; return els.length ? els.map((e) => e.textContent || '') : null })()`),
    'palette items rendered'
  )
  expect(items.some((t) => t.includes('New tab'))).toBe(true)
  expect(items.some((t) => t.includes('Palette Tab')), 'open tabs listed').toBe(true)
  expect(items.some((t) => /1994|Pioneer/.test(t)), 'skins listed').toBe(true)
  expect(items.some((t) => t.includes('New tab') && /⌘|Cmd/.test(t)), 'shortcut shown').toBe(true)

  // Type a fuzzy query, Enter runs the top match.
  await rn.js(w.overlayId, `(() => { const i = document.querySelector('.rn-palette__input'); i.focus(); return true })()`)
  for (const ch of 'nwtb') await rn.press(ch, [], 'overlay')
  const filtered = await poll(
    () => rn.js<string[] | null>(w.overlayId, `(() => { const els = [...document.querySelectorAll('.rn-palette__item')].filter((e) => !e.hidden); return els.length ? els.map((e) => e.textContent || '') : null })()`),
    'filtered'
  )
  expect(filtered[0]).toContain('New tab')
  const n = (await rn.snap()).tabs.length
  await rn.press('Return', [], 'overlay')
  await rn.waitSnap((s) => s.tabs.length === n + 1, 'Enter ran New tab')

  await rn.press('P', ['meta', 'shift'], 'shell')
  await poll(async () => (await rn.win()).overlayKind === 'palette', 'palette reopened')
  await poll(async () => rn.js<boolean>((await rn.win()).overlayId, `document.activeElement?.classList.contains('rn-palette__input') ?? false`), 'palette input focused')
  await rn.press('Escape', [], 'overlay')
  await poll(async () => (await rn.win()).overlayKind !== 'palette', 'Esc closes')
})

test('shortcuts are listed on retronet://shortcuts with every palette command', async ({ rn }) => {
  const sc = await rn.openInternal('shortcuts')
  const r = await rn.bridge<{ platform: string; commands: Array<{ id: string; title: string; accelerators: string[]; palette: boolean }> }>(sc, 'commands.list', {})
  expect(r.ok).toBe(true)
  expect(r.data!.platform).toBe('mac')
  const byId = new Map(r.data!.commands.map((c) => [c.id, c]))
  for (const id of ['tab.new', 'tab.close', 'window.new', 'window.newIncognito', 'tab.reopenClosed', 'omnibox.focus', 'nav.reload', 'find.open', 'bookmark.toggle', 'page.history', 'page.downloads', 'zoom.in', 'devtools.toggle', 'view.toggleFullscreen', 'app.quit', 'palette.open']) {
    expect(byId.get(id)?.accelerators.length, `${id} has a shortcut`).toBeGreaterThan(0)
  }
  // The page renders them (T21/T22 UI).
  const text = await poll(() => rn.js<string>(sc, `document.body.innerText.includes('New tab') ? document.body.innerText : ''`), 'shortcuts page lists commands')
  expect(text).toContain('Reopen closed tab')
})
