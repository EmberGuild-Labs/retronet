// PLAN-FINAL F-E2E1: the themed select-only comboboxes that replaced every <select> on internal pages (AC66) and
// their screenshots (AC67, DESIGN-MENUS §9 → .team/screens/f1-select-*). Background test mode (launchApp:
// RETRONET_E2E=1, quiet-errors.cjs first); Menu.prototype.popup is stubbed so no native menu can appear.
// Input is real (webContents.sendInputEvent into the page), so the APG keyboard model is exercised end to end.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, poll, ROOT, SKIN_IDS, type RN } from './helpers/launch'

const SCREENS = join(ROOT, '.team', 'screens')

async function stubNative(rn: RN): Promise<void> {
  await rn.main(({ Menu }) => {
    const g = globalThis as any
    g.__native = 0
    Menu.prototype.popup = function () {
      g.__native++
    }
  })
}

interface ComboState {
  expanded: string | null
  activedescendant: string | null
  value: string
  listHidden: boolean
  placement: string | null
  options: Array<{ id: string; text: string; selected: string | null; active: boolean }>
}

function combo(rn: RN, wc: number, id: string): Promise<ComboState> {
  return rn.js(
    wc,
    `(() => { const b = document.getElementById(${JSON.stringify(id)}); const l = document.getElementById(b.getAttribute('aria-controls'));
      return { expanded: b.getAttribute('aria-expanded'), activedescendant: b.getAttribute('aria-activedescendant'), value: b.querySelector('.rn-select__value').textContent,
        listHidden: l.hidden, placement: l.dataset.placement ?? null,
        options: [...l.querySelectorAll('[role=option]')].map((o) => ({ id: o.id, text: o.textContent, selected: o.getAttribute('aria-selected'), active: o.classList.contains('rn-select__option--active') })) } })()`
  )
}

/** Key into the page (keyDown, char for printable keys, keyUp). */
async function key(rn: RN, wc: number, keyCode: string, modifiers: string[] = []): Promise<void> {
  await rn.press(keyCode, modifiers, wc)
}

async function click(rn: RN, wc: number, x: number, y: number): Promise<void> {
  await rn.main(({ webContents }, a: { id: number; x: number; y: number }) => {
    const w = webContents.fromId(a.id)!
    w.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y })
    w.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 })
    w.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: 'left', clickCount: 1 })
  }, { id: wc, x: Math.round(x), y: Math.round(y) })
}

async function clickEl(rn: RN, wc: number, selectorExpr: string): Promise<void> {
  const c = await poll(
    () => rn.js<{ x: number; y: number } | null>(wc, `(() => { const e = ${selectorExpr}; if (!e || !e.getClientRects().length) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`),
    `element ${selectorExpr}`
  )
  await click(rn, wc, c.x, c.y)
}

/** Focus a combobox the way a keyboard user would (keyboard modality first, so :focus-visible shows). */
async function focusCombo(rn: RN, wc: number, id: string): Promise<void> {
  await key(rn, wc, 'Shift')
  await rn.js(wc, `(() => { const b = document.getElementById(${JSON.stringify(id)}); b.scrollIntoView({ block: 'center' }); b.focus(); return document.activeElement === b })()`)
}

/** Composite screenshot (shell + tab view + overlay) of the first window, hidden. */
async function shot(rn: RN, name: string, windowId?: number): Promise<void> {
  const w = await rn.win(windowId)
  const b64 = await rn.main(async ({ webContents, BrowserWindow, nativeImage }, shellId: number) => {
    const shell = webContents.fromId(shellId)!
    const bw = BrowserWindow.fromWebContents(shell)!
    const [vw] = bw.getContentSize()
    const base = await shell.capturePage()
    const { width: W, height: H } = base.getSize()
    const s = W / vw!
    const out = Buffer.from(base.toBitmap())
    for (const v of bw.contentView.children as any[]) {
      const wc = v.webContents
      if (!wc || wc.isDestroyed() || (typeof v.getVisible === 'function' && !v.getVisible())) continue
      const b = v.getBounds()
      if (b.width === 0 || b.height === 0) continue
      const img = await wc.capturePage()
      const sz = img.getSize()
      const px = img.toBitmap()
      const ox = Math.round(b.x * s)
      const oy = Math.round(b.y * s)
      for (let y = 0; y < sz.height; y++) {
        const ty = oy + y
        if (ty < 0 || ty >= H) continue
        for (let x = 0; x < sz.width; x++) {
          const tx = ox + x
          if (tx < 0 || tx >= W) continue
          const si = (y * sz.width + x) * 4
          const di = (ty * W + tx) * 4
          const a = px[si + 3]! / 255
          if (a === 0) continue
          for (let c = 0; c < 3; c++) out[di + c] = Math.round(px[si + c]! * a + out[di + c]! * (1 - a))
          out[di + 3] = 255
        }
      }
    }
    return nativeImage.createFromBitmap(out, { width: W, height: H, scaleFactor: s }).toPNG().toString('base64')
  }, w.shellId)
  mkdirSync(SCREENS, { recursive: true })
  writeFileSync(join(SCREENS, `f1-${name}.png`), Buffer.from(b64, 'base64'))
}

const settingsGet = async (rn: RN, wc: number): Promise<{ searchEngine: string }> => {
  const r = await rn.bridge<{ searchEngine: string }>(wc, 'settings.get', {})
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.data!
}

// ---------------------------------------------------------------- settings

test('AC66: Settings search engine is a labelled select-only combobox (APG keys, pointer, Esc reverts) and saves as before', async ({ rn }) => {
  await stubNative(rn)
  const st = await rn.openInternal('settings')
  expect(await rn.js(st, `document.querySelectorAll('select').length`), 'no <select> left on the page').toBe(0)
  const attrs = await rn.js<any>(
    st,
    `(() => { const b = document.getElementById('rn-search-engine'); const l = document.getElementById(b.getAttribute('aria-controls'));
      return { role: b.getAttribute('role'), popup: b.getAttribute('aria-haspopup'), tabindex: b.getAttribute('tabindex'), label: document.getElementById(b.getAttribute('aria-labelledby')).textContent,
        listRole: l.getAttribute('role'), listLabel: l.getAttribute('aria-labelledby') } })()`
  )
  expect(attrs).toEqual({ role: 'combobox', popup: 'listbox', tabindex: '0', label: 'Search engine used in the address bar', listRole: 'listbox', listLabel: 'rn-search-engine-label' })
  const start = await settingsGet(rn, st)
  let c = await combo(rn, st, 'rn-search-engine')
  const names = c.options.map((o) => o.text)
  expect(names).toEqual(['DuckDuckGo', 'Google', 'Bing', 'Brave Search', 'Ecosia'])
  const ids = ['duckduckgo', 'google', 'bing', 'brave', 'ecosia']
  const startIdx = ids.indexOf(start.searchEngine)
  expect(c.expanded).toBe('false')
  expect(c.value).toBe(names[startIdx])
  expect(c.options.filter((o) => o.selected === 'true').map((o) => o.text)).toEqual([names[startIdx]])

  // Down opens with the selected option active; Down moves; Enter commits and saves.
  await focusCombo(rn, st, 'rn-search-engine')
  await key(rn, st, 'Down')
  c = await combo(rn, st, 'rn-search-engine')
  expect(c.expanded).toBe('true')
  expect(c.listHidden).toBe(false)
  expect(c.activedescendant).toBe(c.options[startIdx]!.id)
  await key(rn, st, 'Down')
  const nextIdx = Math.min(startIdx + 1, names.length - 1)
  c = await combo(rn, st, 'rn-search-engine')
  expect(c.activedescendant).toBe(c.options[nextIdx]!.id)
  expect(await rn.js(st, `document.activeElement.id`), 'focus stays on the combobox').toBe('rn-search-engine')
  await key(rn, st, 'Return')
  c = await combo(rn, st, 'rn-search-engine')
  expect(c.expanded).toBe('false')
  expect(c.value).toBe(names[nextIdx])
  await poll(async () => (await settingsGet(rn, st)).searchEngine === ids[nextIdx], 'engine saved by keyboard')

  // Esc reverts: open, move, Esc → unchanged.
  await key(rn, st, 'Down')
  await key(rn, st, 'Home')
  await key(rn, st, 'Escape')
  c = await combo(rn, st, 'rn-search-engine')
  expect(c.expanded).toBe('false')
  expect(c.value).toBe(names[nextIdx])
  expect((await settingsGet(rn, st)).searchEngine).toBe(ids[nextIdx])

  // Alt+Down opens, End, Alt+Up commits and closes.
  await key(rn, st, 'Down', ['alt'])
  await key(rn, st, 'End')
  await key(rn, st, 'Up', ['alt'])
  c = await combo(rn, st, 'rn-search-engine')
  expect(c.expanded).toBe('false')
  expect(c.value).toBe('Ecosia')
  await poll(async () => (await settingsGet(rn, st)).searchEngine === 'ecosia', 'Alt+Up committed')

  // Closed type-ahead changes the value ("B" → Bing).
  await key(rn, st, 'B')
  await poll(async () => (await combo(rn, st, 'rn-search-engine')).value === 'Bing', 'type-ahead while closed')
  await poll(async () => (await settingsGet(rn, st)).searchEngine === 'bing', 'type-ahead saved')

  // Pointer: click the button, click an option.
  await clickEl(rn, st, `document.getElementById('rn-search-engine')`)
  await poll(async () => (await combo(rn, st, 'rn-search-engine')).expanded === 'true', 'opened by click')
  await clickEl(rn, st, `[...document.querySelectorAll('#rn-search-engine-list [role=option]')].find((o) => o.textContent === 'Google')`)
  await poll(async () => (await settingsGet(rn, st)).searchEngine === 'google', 'picked by click')
  expect((await combo(rn, st, 'rn-search-engine')).expanded).toBe('false')
  // Click outside closes without committing.
  await clickEl(rn, st, `document.getElementById('rn-search-engine')`)
  await poll(async () => (await combo(rn, st, 'rn-search-engine')).expanded === 'true', 'opened again')
  await click(rn, st, 5, 5)
  await poll(async () => (await combo(rn, st, 'rn-search-engine')).expanded === 'false', 'outside click closed it')
  expect((await settingsGet(rn, st)).searchEngine).toBe('google')

  // Persisted: a reload shows the saved engine.
  await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.reload(), st)
  await poll(async () => (await rn.js<string | null>(st, `document.getElementById('rn-search-engine')?.querySelector('.rn-select__value').textContent ?? null`)) === 'Google', 'saved engine after reload')
  expect(await rn.main(() => (globalThis as any).__native)).toBe(0)
})

test('AC66: the Clear data time range combobox value is what data.clear receives', async ({ rn }) => {
  await stubNative(rn)
  const st = await rn.openInternal('settings')
  // Record what main's data.clear handler receives (the real handler still runs, on the throwaway profile).
  await rn.main(({ ipcMain }) => {
    const g = globalThis as any
    g.__clears = []
    const map = (ipcMain as any)._invokeHandlers as Map<string, (...a: unknown[]) => unknown>
    const real = map.get('rn:invoke:data.clear')!
    map.set('rn:invoke:data.clear', (e: unknown, payload: unknown) => {
      g.__clears.push(payload)
      return real(e, payload)
    })
  })
  let c = await combo(rn, st, 'rn-clear-range')
  expect(c.options.map((o) => o.text)).toEqual(['Last hour', 'Last 24 hours', 'Last 7 days', 'All time'])
  expect(c.value).toBe('All time')
  expect(await rn.js(st, `document.getElementById('rn-clear-range').getAttribute('aria-describedby')`)).toBe('rn-clear-range-note')
  // Only history, so nothing else is touched.
  await rn.js(st, `(() => { for (const k of ['history', 'downloads', 'cookies', 'cache']) { const i = document.getElementById('rn-clear-' + k); i.checked = k === 'history' } return true })()`)
  const clearAndRead = async (): Promise<unknown> => {
    const n = await rn.main(() => (globalThis as any).__clears.length as number)
    await clickEl(rn, st, `[...document.querySelectorAll('button[type=submit]')].find((b) => b.textContent === 'Clear data')`)
    return poll(() => rn.main((_e, n: number) => (globalThis as any).__clears[n] ?? null, n), 'data.clear call')
  }
  // Keyboard: open, Home (Last hour), Enter.
  await focusCombo(rn, st, 'rn-clear-range')
  await key(rn, st, 'Down')
  await key(rn, st, 'Home')
  await key(rn, st, 'Return')
  c = await combo(rn, st, 'rn-clear-range')
  expect(c.value).toBe('Last hour')
  expect(await clearAndRead()).toEqual({ history: true, downloads: false, cookies: false, cache: false, range: 'hour' })
  // Pointer: Last 7 days.
  await clickEl(rn, st, `document.getElementById('rn-clear-range')`)
  await clickEl(rn, st, `[...document.querySelectorAll('#rn-clear-range-list [role=option]')].find((o) => o.textContent === 'Last 7 days')`)
  expect((await combo(rn, st, 'rn-clear-range')).value).toBe('Last 7 days')
  expect(await clearAndRead()).toMatchObject({ range: 'week' })
  // Tab commits the active option and moves on (Down from Last 7 days → All time).
  await focusCombo(rn, st, 'rn-clear-range')
  await key(rn, st, 'Down')
  await key(rn, st, 'Down')
  await key(rn, st, 'Tab')
  c = await combo(rn, st, 'rn-clear-range')
  expect(c.expanded).toBe('false')
  expect(c.value).toBe('All time')
  expect(await rn.js(st, `document.activeElement.id`)).not.toBe('rn-clear-range')
  expect(await clearAndRead()).toMatchObject({ range: 'all' })
})

// ---------------------------------------------------------------- bookmarks

interface Node {
  id: string
  kind: 'folder' | 'bookmark'
  title: string
  url?: string
  children?: Node[]
}
const find = (n: Node, pred: (x: Node) => boolean): Node | null => {
  if (pred(n)) return n
  for (const c of n.children ?? []) {
    const r = find(c, pred)
    if (r) return r
  }
  return null
}

test('AC66: Bookmarks page: the Folder field and the narrow-layout folder picker are themed comboboxes that move and show bookmarks', async ({ rn, server }) => {
  await stubNative(rn)
  const bm = await rn.openInternal('bookmarks')
  expect(await rn.js(bm, `document.querySelectorAll('select').length`), 'no <select> left on the page').toBe(0)
  const alpha = (await rn.bridge<{ id: string }>(bm, 'bookmarks.addFolder', { parentId: 'bar', title: 'Alpha' })).data!.id
  await rn.bridge(bm, 'bookmarks.addFolder', { parentId: alpha, title: 'Beta' })
  await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.reload(), bm)
  await poll(() => rn.js<boolean>(bm, `typeof window.retronet === 'object' && !!document.querySelector('.rn-tree [role=treeitem]')`), 'bookmarks page reloaded')

  // Add bookmark → Folder = Alpha by pointer.
  await clickEl(rn, bm, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add bookmark')`)
  const parentId = await poll(() => rn.js<string | null>(bm, `document.querySelector('[id^="rn-f-parent-"][role=combobox]')?.id ?? null`), 'Folder combobox in the form')
  const label = await rn.js(bm, `document.getElementById(document.getElementById(${JSON.stringify(parentId)}).getAttribute('aria-labelledby')).textContent`)
  expect(label).toBe('Folder')
  await rn.js(bm, `(() => { const form = document.querySelector('.rn-bm__form'); const [name, url] = form.querySelectorAll('input'); name.value = 'Picked page'; url.value = ${JSON.stringify(`${server.base}/title?t=Picked`)}; for (const i of [name, url]) i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await clickEl(rn, bm, `document.getElementById(${JSON.stringify(parentId)})`)
  await poll(async () => (await combo(rn, bm, parentId)).expanded === 'true', 'Folder list open')
  const opts = (await combo(rn, bm, parentId)).options.map((o) => o.text.replace(/ /g, ' ').trim())
  expect(opts).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
  await clickEl(rn, bm, `[...document.querySelectorAll('#${parentId}-list [role=option]')].find((o) => o.textContent.trim() === 'Alpha')`)
  expect((await combo(rn, bm, parentId)).value.trim()).toBe('Alpha')
  await clickEl(rn, bm, `[...document.querySelectorAll('.rn-bm__form button[type=submit]')][0]`)
  const tree = await poll(async () => {
    const t = (await rn.bridge<{ bar: Node; other: Node }>(bm, 'bookmarks.tree', {})).data!
    const a = find(t.bar, (x) => x.id === alpha)
    return a?.children?.some((x) => x.title === 'Picked page') ? t : null
  }, 'bookmark saved into Alpha')
  const picked = find(tree.bar, (x) => x.title === 'Picked page')!

  // Edit it and move it to Beta with the keyboard (Down to open, Down until Beta is active, Enter), then Save.
  // Show Alpha's contents (tree), then edit the new row.
  await clickEl(rn, bm, `[...document.querySelectorAll('.rn-tree [role=treeitem]')].find((x) => x.textContent.trim().startsWith('Alpha'))`)
  await poll(() => rn.js<boolean>(bm, `document.getElementById('rn-bm-folder').textContent.trim() === 'Alpha'`), 'Alpha listed')
  await clickEl(rn, bm, `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.title || '').startsWith('Edit Picked page'))`)
  const editId = `rn-f-parent-${picked.id}`
  await poll(() => rn.js<boolean>(bm, `!!document.getElementById(${JSON.stringify(editId)})`), 'edit form')
  await focusCombo(rn, bm, editId)
  await key(rn, bm, 'Down')
  for (let i = 0; i < 20; i++) {
    const st = await combo(rn, bm, editId)
    const act = st.options.find((o) => o.active)
    if (act && act.text.trim() === 'Beta') break
    await key(rn, bm, 'Down')
  }
  await key(rn, bm, 'Return')
  expect((await combo(rn, bm, editId)).value.trim()).toBe('Beta')
  await clickEl(rn, bm, `document.getElementById(${JSON.stringify(editId)}).closest('form').querySelector('button[type=submit]')`)
  await poll(async () => {
    const t = (await rn.bridge<{ bar: Node; other: Node }>(bm, 'bookmarks.tree', {})).data!
    const b = find(t.bar, (x) => x.title === 'Beta')
    return b?.children?.some((x) => x.id === picked.id) ?? false
  }, 'bookmark moved to Beta')

  // Narrow window: the folder picker replaces the tree; choosing Alpha shows Alpha.
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(640, 800))
  await poll(() => rn.js<boolean>(bm, `!!document.getElementById('rn-bm-picker')?.getClientRects().length`), 'picker visible in the narrow layout')
  expect(await rn.js(bm, `document.getElementById(document.getElementById('rn-bm-picker').getAttribute('aria-labelledby')).textContent`)).toBe('Folder')
  await focusCombo(rn, bm, 'rn-bm-picker')
  await key(rn, bm, 'Down')
  for (let i = 0; i < 20; i++) {
    const st = await combo(rn, bm, 'rn-bm-picker')
    const act = st.options.find((o) => o.active)
    if (act && act.text.trim() === 'Alpha') break
    await key(rn, bm, 'Down')
  }
  await key(rn, bm, 'Return')
  await poll(() => rn.js<boolean>(bm, `document.getElementById('rn-bm-folder').textContent.trim() === 'Alpha'`), 'Alpha shown via the picker')
  expect(await rn.main(() => (globalThis as any).__native)).toBe(0)
})

// ---------------------------------------------------------------- AC67

test('AC67: DESIGN-MENUS §9 select screenshots (closed + open per skin, y1997 flip, y1999 incognito)', async ({ rn }) => {
  test.setTimeout(180_000)
  await stubNative(rn)
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))
  const st = await rn.openInternal('settings')
  for (const skin of SKIN_IDS) {
    await rn.shell('commands.run', { id: 'skin.switch', arg: skin })
    await poll(() => rn.js<boolean>(st, `document.documentElement.dataset.skin === ${JSON.stringify(skin)}`), `settings page in ${skin}`)
    await focusCombo(rn, st, 'rn-search-engine')
    const ring = await rn.js<{ visible: boolean }>(st, `({ visible: document.getElementById('rn-search-engine').matches(':focus-visible') })`)
    expect(ring.visible, `${skin}: keyboard focus ring`).toBe(true)
    await shot(rn, `select-${skin}-closed`)
    await key(rn, st, 'Down')
    await key(rn, st, 'Down')
    const c = await combo(rn, st, 'rn-search-engine')
    expect(c.expanded).toBe('true')
    const active = c.options.findIndex((o) => o.active)
    const selected = c.options.findIndex((o) => o.selected === 'true')
    expect(active, `${skin}: the active option differs from the selected one`).not.toBe(selected)
    await shot(rn, `select-${skin}-open`)
    await key(rn, st, 'Escape')
  }

  // y1997: the bookmarks Folder field near the bottom of a short window flips above.
  await rn.shell('commands.run', { id: 'skin.switch', arg: 'y1997' })
  const bm = await rn.openInternal('bookmarks')
  await rn.bridge(bm, 'bookmarks.addFolder', { parentId: 'bar', title: 'Comet folder' })
  await rn.bridge(bm, 'bookmarks.addFolder', { parentId: 'bar', title: 'Second folder' })
  await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.reload(), bm)
  await poll(() => rn.js<boolean>(bm, `typeof window.retronet === 'object' && !!document.querySelector('.rn-tree [role=treeitem]') && document.documentElement.dataset.skin === 'y1997'`), 'bookmarks page ready')
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 520))
  await clickEl(rn, bm, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add bookmark')`)
  const pid = await poll(() => rn.js<string | null>(bm, `document.querySelector('[id^="rn-f-parent-"][role=combobox]')?.id ?? null`), 'Folder combobox')
  // Put the field near the bottom of the viewport.
  await rn.js(bm, `(() => { const b = document.getElementById(${JSON.stringify(pid)}); document.body.style.paddingBottom = '100vh'; const r = b.getBoundingClientRect(); window.scrollBy(0, r.bottom - innerHeight + 24); return true })()`)
  await key(rn, bm, 'Shift')
  await rn.js(bm, `document.getElementById(${JSON.stringify(pid)}).focus({ preventScroll: true }); true`)
  await key(rn, bm, 'Down')
  const flip = await combo(rn, bm, pid)
  expect(flip.expanded).toBe('true')
  expect(flip.placement, 'flipped above near the bottom').toBe('above')
  const inView = await rn.js<boolean>(bm, `(() => { const l = document.getElementById(${JSON.stringify(pid)} + '-list').getBoundingClientRect(); return l.top >= 0 && l.bottom <= innerHeight })()`)
  expect(inView).toBe(true)
  await shot(rn, 'select-y1997-flip')
  await key(rn, bm, 'Escape')
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))

  // y1999 incognito settings page, open.
  await rn.shell('commands.run', { id: 'skin.switch', arg: 'y1999' })
  const incId = await rn.profiles<number>('newIncognitoWindow', undefined, 'retronet://settings/')
  await rn.waitWindowReady(incId)
  await rn.main(({ BrowserWindow }, id: number) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.id === id) ?? BrowserWindow.getAllWindows()[0]!
    w.setContentSize(1280, 800)
  }, incId)
  const ist = await poll(async () => {
    const ws = await rn.windows()
    const w = ws.find((x) => x.id === incId)!
    const id = await rn.activeTabWcId(incId)
    const ok = await rn.js<boolean>(id, `location.hostname === 'settings' && !!document.getElementById('rn-search-engine') && document.documentElement.dataset.incognito === 'true' && document.documentElement.dataset.skin === 'y1999'`).catch(() => false)
    return ok && w ? id : null
  }, 'incognito settings page')
  await focusCombo(rn, ist, 'rn-search-engine')
  await key(rn, ist, 'Down')
  await key(rn, ist, 'Down')
  await poll(async () => (await combo(rn, ist, 'rn-search-engine')).expanded === 'true', 'incognito combobox open')
  const ringColor = await rn.js<string>(ist, `getComputedStyle(document.getElementById('rn-search-engine')).outlineColor`)
  test.info().annotations.push({ type: 'y1999 incognito ring', description: ringColor })
  await shot(rn, 'select-y1999-incognito-open', incId)
  expect(await rn.main(() => (globalThis as any).__native)).toBe(0)
})
