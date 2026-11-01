// PLAN-FINAL F-E2E1: themed menus (AC60-AC65, AC67 menu screenshots). Every window stays hidden (background test
// mode, RETRONET_E2E=1 via launchApp, quiet-errors.cjs first). Native menus never reach the screen: every test stubs
// Menu.prototype.popup before anything can open one, and records what would have been shown instead.
// Themed menus are read through the gated `__rn.menu()/currentMenu()` hooks (F-HOOKS) and driven with real input
// (webContents.sendInputEvent) into the overlay, so picks go through the overlay's `menu.pick` and main's checks.
//   AC60 page menus · AC61 tab/group/bookmark/profile/edit menus · AC62 placement · AC63 keyboard + ARIA ·
//   AC64 lifecycle + stale picks · AC65 native fallback · AC67 screenshots (DESIGN-MENUS §9 → .team/screens/f1-*)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, poll, settle, sleep, ROOT, SKIN_IDS, type RN, type WinInfo } from './helpers/launch'
import type { FixtureServer } from './helpers/server'

const SCREENS = join(ROOT, '.team', 'screens')
const NO_MODS = { meta: false, ctrl: false, shift: false, alt: false }

interface Item {
  kind: 'item' | 'separator'
  id?: string
  label?: string
  enabled?: boolean
  check?: 'check' | 'radio'
  checked?: boolean
  title?: string
  accel?: string
  submenu?: Item[]
}
interface Spec {
  menuId: string
  kind: string
  label: string
  anchor: { x: number; y: number; width: number; height: number }
  placement: 'point' | 'below'
  focusFirst: boolean
  items: Item[]
}
interface Box {
  left: number
  top: number
  right: number
  bottom: number
  level: string
  scrolls: boolean
  scrollH: number
  clientH: number
}

/** Top-level ids, '-' for separators. */
const flat = (items: Item[]): string[] => items.map((i) => (i.kind === 'separator' ? '-' : (i.id as string)))
const labels = (items: Item[]): string[] => items.filter((i) => i.kind === 'item').map((i) => i.label as string)

// ---------------------------------------------------------------- helpers

/** Native menus are recorded, never shown (PLAN-FINAL §0). `__native` keeps the menu, its ids and its callback. */
async function stubNative(rn: RN): Promise<void> {
  await rn.main(({ Menu }) => {
    const g = globalThis as any
    g.__native = []
    Menu.prototype.popup = function (opts?: { callback?: () => void }) {
      g.__native.push({ menu: this, ids: this.items.map((i: any) => (i.type === 'separator' ? '-' : i.id)), cb: opts?.callback })
    }
  })
}
const nativeMenus = (rn: RN): Promise<string[][]> => rn.main(() => (globalThis as any).__native.map((n: any) => n.ids as string[]))
const fallbackCount = (rn: RN): Promise<number> => rn.main(() => (globalThis as any).__rn.nativeFallbackCount() as number)
/** Close every recorded native menu (as the OS would on Esc). */
const closeNatives = (rn: RN): Promise<void> =>
  rn.main(() => {
    for (const n of (globalThis as any).__native) n.cb?.()
  })

const currentMenu = (rn: RN, winId: number): Promise<Spec | null> =>
  rn.main((_e, id: number) => (globalThis as any).__rn.currentMenu(id) as Spec | null, winId)

const overlayKind = async (rn: RN, winId: number): Promise<string | null> => (await rn.win(winId)).overlayKind

/** The overlay's visible root menu: ids in DOM order ('-' = separator), labels and roles. */
function rootDom(rn: RN, w: WinInfo): Promise<{ ids: string[]; labels: string[]; roles: string[]; ariaLabel: string | null } | null> {
  return rn.js(
    w.overlayId,
    `(() => { const l = document.querySelector('.rn-menu-layer'); if (!l || l.hidden) return null;
      const m = l.querySelector('.rn-menu:not(.rn-menu--sub)'); if (!m) return null;
      const kids = [...m.children];
      return { ids: kids.map((c) => c.getAttribute('role') === 'separator' ? '-' : c.dataset.itemId),
        labels: kids.filter((c) => c.dataset.itemId).map((c) => c.querySelector('.rn-menu__label').textContent),
        roles: kids.map((c) => c.getAttribute('role')), ariaLabel: m.getAttribute('aria-label') } })()`
  )
}

/** Waits for a new themed menu (other than `not`) of `kind`, and for the overlay to have drawn exactly its root level. */
async function waitMenu(rn: RN, w: WinInfo, opts: { kind?: string; not?: string | null } = {}): Promise<Spec> {
  const spec = await poll(async () => {
    const m = await currentMenu(rn, w.id)
    return m && m.menuId !== opts.not && (!opts.kind || m.kind === opts.kind) ? m : null
  }, `themed ${opts.kind ?? ''} menu`)
  const want = JSON.stringify(flat(spec.items))
  await poll(async () => {
    const d = await rootDom(rn, w)
    return d && JSON.stringify(d.ids) === want ? d : null
  }, `overlay drew the ${spec.kind} menu`)
  return spec
}

async function menuGone(rn: RN, w: WinInfo, what = 'menu closed'): Promise<void> {
  await poll(async () => (await currentMenu(rn, w.id)) === null && (await overlayKind(rn, w.id)) !== 'menu', what)
}

/** Close whatever menu the window shows through the hook (any depth of open submenus). */
async function closeAll(rn: RN, w: WinInfo): Promise<void> {
  await rn.main((_e, id: number) => {
    const m = (globalThis as any).__rn.currentMenu(id)
    if (m) (globalThis as any).__rn.dismissMenu(id, m.menuId)
  }, w.id)
  await menuGone(rn, w)
}

async function escapeMenu(rn: RN, w: WinInfo): Promise<void> {
  await rn.press('Escape', [], 'overlay', w.id)
  await menuGone(rn, w, 'menu closed by Esc')
}

/** A full Enter keystroke (keyDown, char, keyUp): what activates a focused <button>. */
async function enterKey(rn: RN, wcId: number): Promise<void> {
  await rn.main(({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }, wcId)
}

type Btn = 'left' | 'right' | 'middle'
/** A real click (move, down, up) into a webContents at view coordinates. */
async function click(rn: RN, wcId: number, x: number, y: number, button: Btn = 'left', modifiers: string[] = []): Promise<void> {
  await rn.main(({ webContents }, a: { id: number; x: number; y: number; button: Btn; modifiers: string[] }) => {
    const wc = webContents.fromId(a.id)!
    const mods = a.modifiers as Array<'meta' | 'shift' | 'control' | 'alt'>
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y, modifiers: mods })
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: a.button, clickCount: 1, modifiers: mods })
    wc.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: a.button, clickCount: 1, modifiers: mods })
  }, { id: wcId, x: Math.round(x), y: Math.round(y), button, modifiers })
}

async function hover(rn: RN, wcId: number, x: number, y: number): Promise<void> {
  await rn.main(({ webContents }, a: { id: number; x: number; y: number }) => {
    // A real mouse sends a series of moves; menus ignore a pointer that hasn't moved (AC63), so approach the target.
    const wc = webContents.fromId(a.id)!
    wc.sendInputEvent({ type: 'mouseMove', x: a.x - 3, y: a.y })
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y })
  }, { id: wcId, x: Math.round(x), y: Math.round(y) })
}

/** Center of an element (CSS px of that document). */
function center(rn: RN, wcId: number, selector: string): Promise<{ x: number; y: number; left: number; top: number; width: number; height: number }> {
  return poll(
    () =>
      rn.js(
        wcId,
        `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length && !x.closest('[hidden]')); if (!e) return null;
          const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height } })()`
      ),
    `element ${selector}`
  )
}

const rowSel = (itemId: string): string => `.rn-menu:not([hidden]) [data-item-id=${JSON.stringify(itemId)}]`

/** Pointer-pick a row of the open themed menu (real overlay input → menu.pick). */
async function pickRow(rn: RN, w: WinInfo, itemId: string, button: Btn = 'left', modifiers: string[] = []): Promise<void> {
  const c = await center(rn, w.overlayId, rowSel(itemId))
  await click(rn, w.overlayId, c.x, c.y, button, modifiers)
}

/** Visible menu boxes in the overlay plus its viewport. */
function boxes(rn: RN, w: WinInfo): Promise<{ boxes: Box[]; vw: number; vh: number }> {
  return rn.js(
    w.overlayId,
    `(() => ({ vw: innerWidth, vh: innerHeight, boxes: [...document.querySelectorAll('.rn-menu')].filter((m) => !m.hidden && m.getClientRects().length).map((m) => {
      const r = m.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, level: m.dataset.level, scrolls: m.classList.contains('rn-menu--scrolls'), scrollH: m.scrollHeight, clientH: m.clientHeight } }) }))()`
  )
}

/** The overlay's focused element: its item id / label, or the menu box. */
function overlayFocus(rn: RN, w: WinInfo): Promise<{ id: string | null; label: string | null; cls: string; level: string | null }> {
  return rn.js(
    w.overlayId,
    `(() => { const a = document.activeElement; return { id: a?.dataset?.itemId ?? null, label: a?.querySelector?.('.rn-menu__label')?.textContent ?? null, cls: a?.className ?? '', level: a?.closest?.('.rn-menu')?.dataset.level ?? null } })()`
  )
}

async function rightClick(rn: RN, wcId: number, x: number, y: number): Promise<void> {
  await click(rn, wcId, x, y, 'right')
}

/** Right-click in the active tab at view coords and wait for the themed page menu. */
async function pageMenuAt(rn: RN, w: WinInfo, x: number, y: number): Promise<Spec> {
  const before = (await currentMenu(rn, w.id))?.menuId ?? null
  await rightClick(rn, await rn.activeTabWcId(w.id), x, y)
  return waitMenu(rn, w, { kind: 'page', not: before })
}

async function pageMenuOn(rn: RN, w: WinInfo, selector: string, dx?: number): Promise<Spec> {
  const tab = await rn.activeTabWcId(w.id)
  const c = await center(rn, tab, selector)
  return pageMenuAt(rn, w, dx === undefined ? c.x : c.left + dx, c.y)
}

/** Switch skin (palette command) and wait until shell and overlay wear it. */
async function setSkin(rn: RN, skin: string, winId?: number): Promise<void> {
  await rn.shell('commands.run', { id: 'skin.switch', arg: skin }, winId)
  await rn.waitSnap((s) => s.skin === skin, `skin ${skin}`, { windowId: winId })
  const w = await rn.win(winId)
  await poll(() => rn.js<boolean>(w.overlayId, `document.documentElement.dataset.skin === ${JSON.stringify(skin)}`), `overlay in ${skin}`)
  await poll(() => rn.js<boolean>(w.shellId, `document.documentElement.dataset.skin === ${JSON.stringify(skin)} && !document.getElementById('rn-skin')?.dataset.rnSkinPending`), `shell in ${skin}`)
}

/** The test page: a selection paragraph, a link, an image, a text field and empty space, at fixed spots. */
const CTX_HTML = `<p id="sel" style="position:absolute;left:40px;top:30px;margin:0;font:16px serif">needle words here</p>
<a id="lnk" href="/b" style="position:absolute;left:40px;top:80px;display:block;width:240px;height:30px;font:16px serif">a plain link</a>
<img id="img" alt="" src="/fav.png" style="position:absolute;left:40px;top:140px;width:64px;height:64px">
<input id="fld" value="field text" spellcheck="false" style="position:absolute;left:40px;top:240px;width:220px;height:24px">
<div id="blank" style="position:absolute;left:420px;top:300px;width:200px;height:120px"></div>`

async function openCtxPage(rn: RN, server: FixtureServer, windowId?: number): Promise<number> {
  await rn.navigate(`${server.base}/title?t=Menus`, { windowId })
  const tab = await rn.activeTabWcId(windowId)
  await rn.js(tab, `document.body.innerHTML = ${JSON.stringify(CTX_HTML)}; document.body.style.margin = '0'; true`)
  await poll(() => rn.js<boolean>(tab, `document.getElementById('img').complete && document.getElementById('img').naturalWidth > 0`), 'fixture image loaded')
  return tab
}

/** Select the paragraph's text (so the page menu is a selection menu). */
const selectPara = (rn: RN, tab: number): Promise<unknown> =>
  rn.js(tab, `(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('sel')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString() })()`)

const VIEW = ['ctx.viewSource', 'ctx.inspect']
const PAGE_ITEMS = {
  plain: ['ctx.back', 'ctx.forward', 'ctx.reload', '-', 'ctx.selectAll', '-', ...VIEW],
  link: ['ctx.openLinkTab', 'ctx.openLinkWindow', 'ctx.openLinkIncognito', 'ctx.copyLink', '-', ...VIEW],
  image: ['ctx.openImage', 'ctx.saveImage', 'ctx.copyImage', 'ctx.copyImageAddress', '-', ...VIEW],
  selection: ['ctx.copy', 'ctx.search', '-', ...VIEW],
  editable: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', '-', ...VIEW]
}
// v1's labels (commit 362dc6d context-menu.ts); v1's role items took Electron's role labels for Copy / Select all.
const PAGE_LABELS = {
  plain: ['Back', 'Forward', 'Reload', 'Select all', 'View page source', 'Inspect'],
  link: ['Open link in new tab', 'Open link in new window', 'Open link in incognito window', 'Copy link address', 'View page source', 'Inspect'],
  image: ['Open image in new tab', 'Save image as...', 'Copy image', 'Copy image address', 'View page source', 'Inspect'],
  editable: ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all', 'View page source', 'Inspect']
}

/**
 * A composite screenshot of the hidden window (shell, then every child view at its bounds, overlay last with alpha),
 * saved to .team/screens/f1-<name>.png. capturePage works on hidden windows; BrowserWindow.capturePage alone would
 * only return the shell.
 */
async function shot(rn: RN, w: WinInfo, name: string): Promise<void> {
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

/** Settings page in a background tab (for settings.set); returns its webContents id. */
async function settingsWc(rn: RN, windowId?: number): Promise<number> {
  const existing = (await rn.wcIdsByUrl(/^retronet:\/\/settings\//))[0]
  if (existing !== undefined) return existing
  await rn.shell('tabs.create', { url: 'retronet://settings/', background: true }, windowId)
  const id = await poll(async () => (await rn.wcIdsByUrl(/^retronet:\/\/settings\//))[0], 'settings tab')
  await poll(() => rn.js<boolean>(id, `typeof window.retronet === 'object'`), 'settings bridge')
  return id
}

/** Bookmarks page in a background tab (for bookmarks.add / addFolder); returns its webContents id. */
async function bookmarksWc(rn: RN, windowId?: number): Promise<number> {
  const existing = (await rn.wcIdsByUrl(/^retronet:\/\/bookmarks\//))[0]
  if (existing !== undefined) return existing
  await rn.shell('tabs.create', { url: 'retronet://bookmarks/', background: true }, windowId)
  const id = await poll(async () => (await rn.wcIdsByUrl(/^retronet:\/\/bookmarks\//))[0], 'bookmarks tab')
  await poll(() => rn.js<boolean>(id, `typeof window.retronet === 'object'`), 'bookmarks bridge')
  return id
}

async function addFolder(rn: RN, bm: number, parentId: string, title: string): Promise<string> {
  const r = await rn.bridge<{ id: string }>(bm, 'bookmarks.addFolder', { parentId, title })
  if (!r.ok) throw new Error(`addFolder ${title}: ${JSON.stringify(r)}`)
  return r.data!.id
}

async function addBookmark(rn: RN, bm: number, parentId: string, title: string, url: string): Promise<string> {
  const r = await rn.bridge<{ id: string }>(bm, 'bookmarks.add', { parentId, title, url })
  if (!r.ok) throw new Error(`add ${title}: ${JSON.stringify(r)}`)
  return r.data!.id
}

/** Many bookmarks in one page round trip (sequential, in order). */
async function addMany(rn: RN, bm: number, parentId: string, n: number, base: string, prefix: string): Promise<void> {
  const r = await rn.js<boolean>(
    bm,
    `(async () => { for (let i = 1; i <= ${n}; i++) { const r = await window.retronet.bookmarks.add({ parentId: ${JSON.stringify(parentId)}, title: ${JSON.stringify(prefix)} + ' ' + i, url: ${JSON.stringify(base)} + '/title?t=' + i }); if (!r.ok) return false } return true })()`
  )
  expect(r, `added ${n} bookmarks`).toBe(true)
}

/** Shell bar button of a bookmark folder by title, once the bar shows it. */
const barFolder = (rn: RN, w: WinInfo, title: string) =>
  poll(
    () =>
      rn.js<{ x: number; y: number } | null>(
        w.shellId,
        `(() => { const b = [...document.querySelectorAll('.rn-bookmarkbar__folder')].find((x) => x.textContent.trim() === ${JSON.stringify(title)} && x.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
      ),
    `bar folder ${title}`
  )

/** Fire-and-forget a shell bridge call that resolves only when its menu closes. */
const shellFire = (rn: RN, w: WinInfo, expr: string): Promise<unknown> => rn.js(w.shellId, `(() => { window.__menuCall = ${expr}.then((r) => (window.__menuRes = r)); return true })()`)

// ---------------------------------------------------------------- AC60

test('AC60: page menus are themed in all four skins with the v1 items (link, image, selection, editable, plain, internal page)', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await stubNative(rn)
  await openCtxPage(rn, server)
  const tab = await rn.activeTabWcId()
  for (const skin of SKIN_IDS) {
    await setSkin(rn, skin)
    const w = await rn.win()
    const check = async (what: keyof typeof PAGE_ITEMS, open: () => Promise<Spec>) => {
      const spec = await open()
      expect(flat(spec.items), `${skin} ${what} ids`).toEqual(PAGE_ITEMS[what])
      expect(spec.kind).toBe('page')
      expect(spec.label).toBe('Page')
      expect(spec.placement).toBe('point')
      const dom = (await rootDom(rn, w))!
      expect(dom.labels, `${skin} ${what}: the overlay draws main's labels`).toEqual(labels(spec.items))
      if (what in PAGE_LABELS) expect(dom.labels, `${skin} ${what} labels as v1`).toEqual(PAGE_LABELS[what as keyof typeof PAGE_LABELS])
      expect(dom.ariaLabel).toBe('Page')
      expect(await overlayKind(rn, w.id)).toBe('menu')
      await escapeMenu(rn, w)
      return spec
    }
    await check('link', () => pageMenuOn(rn, w, '#lnk', 200))
    await check('image', () => pageMenuOn(rn, w, '#img'))
    await check('editable', () => pageMenuOn(rn, w, '#fld'))
    await check('plain', () => pageMenuOn(rn, w, '#blank'))
    const sel = await check('selection', async () => {
      await selectPara(rn, tab)
      return pageMenuOn(rn, w, '#sel', 20)
    })
    expect(sel.items[1]!.label).toMatch(/^Search .+ for "needle words here"$/)
    await rn.js(tab, `getSelection().removeAllRanges(); true`)
  }
  // An internal page: themed too, and no "View page source" (AC54 rule kept).
  const st = await rn.openInternal('settings')
  const w = await rn.win()
  const before = (await currentMenu(rn, w.id))?.menuId ?? null
  await rightClick(rn, st, 600, 20)
  const internal = await waitMenu(rn, w, { kind: 'page', not: before })
  expect(flat(internal.items)).not.toContain('ctx.viewSource')
  expect(flat(internal.items)).toContain('ctx.inspect')
  await escapeMenu(rn, w)
  expect(await nativeMenus(rn), 'no native menu was ever requested').toEqual([])
  expect(await fallbackCount(rn)).toBe(0)
})

test('AC60: misspelled word: up to 5 suggestions or "No spelling suggestions", Add to dictionary; a pick replaces in the focused field; Paste pastes', async ({ rn, server }) => {
  await stubNative(rn)
  const tab = await openCtxPage(rn, server)
  const w = await rn.win()
  // Hidden windows get no OS spell-check pass, so the misspelling arrives as Chromium's own context-menu params
  // (PLAN-FINAL F-E2E1 allows this). replaceMisspelling and the dictionary call are spied; the dictionary call is
  // NOT passed through (on macOS it would teach the user's system dictionary a word).
  await rn.main(({ webContents }, id: number) => {
    const g = globalThis as any
    const wc = webContents.fromId(id)!
    g.__spell = { replaced: [] as string[], added: [] as string[], calls: [] as string[] }
    const orig = wc.replaceMisspelling.bind(wc)
    wc.replaceMisspelling = (s: string) => {
      g.__spell.replaced.push(s)
      g.__spell.calls.push('replace')
      orig(s)
    }
    const focus = wc.focus.bind(wc)
    wc.focus = () => {
      g.__spell.calls.push('focus')
      focus()
    }
    wc.session.addWordToSpellCheckerDictionary = (word: string) => {
      g.__spell.added.push(word)
      return true
    }
  }, tab)
  const emit = async (suggestions: string[]) => {
    const before = (await currentMenu(rn, w.id))?.menuId ?? null
    const c = await center(rn, tab, '#fld')
    await rn.js(tab, `(() => { const f = document.getElementById('fld'); f.value = 'Thsi field'; f.focus(); f.setSelectionRange(0, 4); return true })()`)
    await rn.main(({ webContents }, a: { id: number; x: number; y: number; sug: string[] }) => {
      const wc = webContents.fromId(a.id)!
      const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false }
      wc.emit(
        'context-menu',
        { preventDefault() {}, sender: wc },
        { x: a.x, y: a.y, frame: wc.mainFrame, linkURL: '', linkText: '', pageURL: wc.getURL(), frameURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: true, selectionText: 'Thsi', titleText: '', altText: '', suggestedFilename: '', selectionRect: { x: 0, y: 0, width: 0, height: 0 }, selectionStartOffset: 0, referrerPolicy: {}, misspelledWord: 'Thsi', dictionarySuggestions: a.sug, frameCharset: 'UTF-8', formControlType: 'input-text', spellcheckEnabled: true, menuSourceType: 'mouse', mediaFlags: {}, editFlags: flags }
      )
    }, { id: tab, x: Math.round(c.x), y: Math.round(c.y), sug: suggestions })
    return waitMenu(rn, w, { kind: 'page', not: before })
  }
  const many = await emit(['This', 'Thai', 'Tho', 'Thus', 'Thin', 'Thy', 'Then'])
  expect(flat(many.items)).toEqual([
    'spell.suggest:0', 'spell.suggest:1', 'spell.suggest:2', 'spell.suggest:3', 'spell.suggest:4', 'spell.add', '-',
    ...PAGE_ITEMS.editable
  ])
  expect(labels(many.items).slice(0, 6)).toEqual(['This', 'Thai', 'Tho', 'Thus', 'Thin', 'Add to dictionary'])
  await pickRow(rn, w, 'spell.suggest:0')
  await menuGone(rn, w)
  const spell = await poll(() => rn.main(() => ((globalThis as any).__spell.replaced.length ? (globalThis as any).__spell : null)), 'replaceMisspelling ran')
  expect(spell.replaced).toEqual(['This'])
  // R-2: main focuses the tab (hidden windows have no OS focus to observe) before it replaces.
  expect(spell.calls.slice(-2), 'the tab is focused, then the replacement runs').toEqual(['focus', 'replace'])
  expect(await rn.js(tab, `document.activeElement.id`), 'the field still has DOM focus').toBe('fld')

  const none = await emit([])
  expect(flat(none.items).slice(0, 3)).toEqual(['spell.none', 'spell.add', '-'])
  expect(none.items[0]!.enabled).toBe(false)
  await pickRow(rn, w, 'spell.add')
  await menuGone(rn, w)
  expect(await poll(() => rn.main(() => ((globalThis as any).__spell.added.length ? (globalThis as any).__spell.added : null)), 'add to dictionary')).toEqual(['Thsi'])

  // Paste into the page field and into the omnibox (R-2: the edit action acts on the field that had focus).
  // The user's clipboard text is put back afterwards.
  // (Playwright's electron module wraps clipboard calls in promises: await them.)
  const saved = await rn.main(async (e) => ({ text: String(await (e as any).clipboard.readText()) }))
  expect(typeof saved.text).toBe('string')
  try {
    await rn.main(async (e) => {
      await (e as any).clipboard.writeText('PASTED-F1')
    })
    await rn.js(tab, `(() => { const f = document.getElementById('fld'); f.value = 'x'; f.focus(); f.setSelectionRange(1, 1); return true })()`)
    await pageMenuOn(rn, w, '#fld')
    await pickRow(rn, w, 'edit.paste')
    await menuGone(rn, w)
    await poll(() => rn.js<boolean>(tab, `document.getElementById('fld').value === 'xPASTED-F1'`), 'pasted into the page field')

    const omni = await center(rn, w.shellId, '.rn-omnibox__input')
    await rn.js(w.shellId, `(() => { const i = document.querySelector('.rn-omnibox__input'); i.focus(); i.select(); return true })()`)
    const before = (await currentMenu(rn, w.id))?.menuId ?? null
    await rightClick(rn, w.shellId, omni.x, omni.y)
    const edit = await waitMenu(rn, w, { kind: 'edit', not: before })
    expect(edit.label).toBe('Edit')
    expect(flat(edit.items).slice(0, 7)).toEqual(['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll'])
    await pickRow(rn, w, 'edit.paste')
    await menuGone(rn, w)
    await poll(() => rn.js<boolean>(w.shellId, `document.querySelector('.rn-omnibox__input').value.includes('PASTED-F1')`), 'pasted into the omnibox')
  } finally {
    await rn.main(async (e, s: { text: string }) => {
      await (e as any).clipboard.writeText(s.text)
    }, saved)
  }
  expect(await fallbackCount(rn)).toBe(0)
})

test('AC60/AC61: picks run in main by item id: link in a background tab, Back, the find bar edit menu', async ({ rn, server }) => {
  await stubNative(rn)
  await rn.navigate(`${server.base}/a`)
  await openCtxPage(rn, server)
  const w = await rn.win()
  const s0 = await rn.snap()
  await pageMenuOn(rn, w, '#lnk', 200)
  await pickRow(rn, w, 'ctx.openLinkTab')
  const s1 = await rn.waitSnap((s) => s.tabs.length === s0.tabs.length + 1 && s.tabs.some((t) => t.url === `${server.base}/b`), 'link opened in a new tab')
  expect(s1.activeTabId, 'background tab').toBe(s0.activeTabId)

  // Back is enabled after a navigation; picking it goes back.
  const plain = await pageMenuOn(rn, w, '#blank')
  expect(plain.items.find((i) => i.id === 'ctx.back')!.enabled).toBe(true)
  expect(plain.items.find((i) => i.id === 'ctx.forward')!.enabled).toBe(false)
  await pickRow(rn, w, 'ctx.back')
  await rn.waitSnap((s) => rn.active(s).url === `${server.base}/a` && !rn.active(s).loading, 'went back')

  // The find bar's own field gets the themed edit menu.
  await rn.shell('commands.run', { id: 'find.open' })
  const find = await center(rn, w.shellId, '.rn-findbar input')
  const before = (await currentMenu(rn, w.id))?.menuId ?? null
  await rightClick(rn, w.shellId, find.x, find.y)
  const edit = await waitMenu(rn, w, { kind: 'edit', not: before })
  expect(flat(edit.items)).toContain('edit.paste')
  await escapeMenu(rn, w)
  expect(await nativeMenus(rn)).toEqual([])
})

// ---------------------------------------------------------------- AC63

test('AC63: keyboard and ARIA in the page menu (wrap, skip disabled, Home/End, type-ahead, Enter, Tab, Esc)', async ({ rn, server }) => {
  await stubNative(rn)
  await openCtxPage(rn, server)
  const w = await rn.win()
  const tab = await rn.activeTabWcId()
  const spec = await pageMenuOn(rn, w, '#blank')
  expect(spec.focusFirst).toBe(false)
  // Roles and states.
  const aria = await rn.js<any>(
    w.overlayId,
    `(() => { const m = document.querySelector('.rn-menu:not(.rn-menu--sub)'); const row = (id) => m.querySelector('[data-item-id="' + id + '"]');
      return { role: m.getAttribute('role'), label: m.getAttribute('aria-label'), roles: [...m.querySelectorAll('[data-item-id]')].map((r) => r.getAttribute('role')),
        seps: [...m.querySelectorAll('.rn-menu__separator')].map((s) => s.getAttribute('role')), back: row('ctx.back').getAttribute('aria-disabled'),
        fwd: row('ctx.forward').getAttribute('aria-disabled'), selKeys: row('ctx.selectAll').getAttribute('aria-keyshortcuts'),
        accelHidden: row('ctx.selectAll').querySelector('.rn-menu__accel').getAttribute('aria-hidden'), focus: document.activeElement === m } })()`
  )
  expect(aria.role).toBe('menu')
  expect(aria.label).toBe('Page')
  expect(new Set(aria.roles)).toEqual(new Set(['menuitem']))
  expect(aria.seps).toEqual(['separator', 'separator'])
  expect(aria.back, 'Back enabled (the tab came from the start page)').toBeNull()
  expect(aria.fwd, 'Forward disabled').toBe('true')
  expect(aria.selKeys).toMatch(/^(Meta|Control)\+A$/)
  expect(aria.accelHidden).toBe('true')
  expect(aria.focus, 'pointer-opened: focus on the menu, no row highlighted').toBe(true)

  // Down highlights Back, then skips the disabled Forward; wraps at both ends; Home/End.
  const at = async () => (await overlayFocus(rn, w)).id
  await rn.press('Down', [], 'overlay')
  expect(await at()).toBe('ctx.back')
  await rn.press('Down', [], 'overlay')
  expect(await at(), 'Down skips the disabled Forward').toBe('ctx.reload')
  await rn.press('Up', [], 'overlay')
  expect(await at(), 'Up skips it too').toBe('ctx.back')
  await rn.press('Up', [], 'overlay')
  expect(await at(), 'Up wraps from the first enabled item to the last').toBe('ctx.inspect')
  await rn.press('Down', [], 'overlay')
  expect(await at(), 'Down wraps to the first enabled item').toBe('ctx.back')
  await rn.press('End', [], 'overlay')
  expect(await at()).toBe('ctx.inspect')
  await rn.press('Home', [], 'overlay')
  expect(await at()).toBe('ctx.back')
  // Type-ahead: "v" → View page source, "s" → Select all.
  await rn.press('V', [], 'overlay')
  expect(await at()).toBe('ctx.viewSource')
  await sleep(600)
  await rn.press('S', [], 'overlay')
  expect(await at()).toBe('ctx.selectAll')
  const active = await rn.js<string[]>(w.overlayId, `[...document.querySelectorAll('.rn-menu__item--active')].map((r) => r.dataset.itemId)`)
  expect(active, 'the highlight is the focused row').toEqual(['ctx.selectAll'])
  // Tab closes without picking.
  await rn.press('Tab', [], 'overlay')
  await menuGone(rn, w, 'Tab closed the menu')
  // Enter activates: Select all selects the page.
  await pageMenuOn(rn, w, '#blank')
  await rn.press('S', [], 'overlay')
  expect(await at()).toBe('ctx.selectAll')
  await rn.press('Return', [], 'overlay')
  await menuGone(rn, w)
  await poll(() => rn.js<boolean>(tab, `getSelection().toString().includes('needle words here')`), 'Select all ran in the page')
  // Esc closes. (Focus going back to the page webContents is not observable here: a hidden window never has OS
  // focus, so window-manager's isFocused() gate skips the restore. Shell triggers' DOM focus return is checked below.)
  await pageMenuOn(rn, w, '#blank')
  await escapeMenu(rn, w)
})

test('AC63/AC61: Shift+F10 on a tab and a group chip opens the menu below with the first item focused; submenus by keyboard; focus returns', async ({ rn, server }) => {
  await stubNative(rn)
  await rn.navigate(`${server.base}/a`)
  const s0 = await rn.snap()
  const t1 = s0.activeTabId
  const { tabId: t2 } = await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/b`, background: true })
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: t2, name: 'Work', color: 'blue' })
  await rn.waitSnap((s) => s.groups.some((g) => g.id === groupId), 'group exists')
  const w = await rn.win()

  // Tab: Shift+F10 on the focused tab.
  await poll(() => rn.js<boolean>(w.shellId, `(() => { const t = document.querySelector('.rn-tab[data-tab-id="${t1}"]'); if (!t) return false; t.focus(); return document.activeElement === t })()`), 'tab focused')
  await rn.press('F10', ['shift'], 'shell')
  const tabMenu = await waitMenu(rn, w, { kind: 'tab' })
  expect(tabMenu.focusFirst).toBe(true)
  expect(tabMenu.placement).toBe('below')
  const tabRect = await center(rn, w.shellId, `.rn-tab[data-tab-id="${t1}"]`)
  expect(Math.round(tabMenu.anchor.x)).toBe(Math.round(tabRect.left))
  expect(Math.round(tabMenu.anchor.y)).toBe(Math.round(tabRect.top))
  expect(flat(tabMenu.items)).toEqual([
    'tab.new-right', '-', 'tab.reload', 'tab.duplicate', 'tab.pin', 'tab.mute', '-',
    'tab.group-new', 'tab.group-add', '-', 'tab.close', 'tab.close-others', 'tab.close-right', '-', 'tab.reopen'
  ])
  expect(labels(tabMenu.items)).toEqual([
    'New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Site', 'Add Tab to New Group', 'Add Tab to Group',
    'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab'
  ])
  expect(tabMenu.items.find((i) => i.id === 'tab.reopen')!.enabled).toBe(false)
  expect((await overlayFocus(rn, w)).id, 'keyboard-opened: first item focused').toBe('tab.new-right')
  // The menu box sits below the tab.
  const tb = (await boxes(rn, w)).boxes[0]!
  expect(tb.top).toBeGreaterThanOrEqual(tabRect.top + tabRect.height - 1)
  await escapeMenu(rn, w)
  expect(await rn.js<boolean>(w.shellId, `document.activeElement === document.querySelector('.rn-tab[data-tab-id="${t1}"]')`), 'focus back on the tab').toBe(true)

  // Group chip: Shift+F10, Down to Color, Right opens the submenu with the radio state, Left/Esc close one level.
  await poll(() => rn.js<boolean>(w.shellId, `(() => { const c = document.querySelector('.rn-group-chip[data-group-id="${groupId}"]'); if (!c) return false; c.focus(); return document.activeElement === c })()`), 'chip focused')
  await rn.press('F10', ['shift'], 'shell')
  const gm = await waitMenu(rn, w, { kind: 'group' })
  expect(gm.label).toBe('Tab group')
  expect(flat(gm.items)).toEqual(['group.edit', 'group.new-tab', 'group.collapse', 'group.color', '-', 'group.ungroup', 'group.close'])
  expect(labels(gm.items)).toEqual(['Edit Group...', 'New Tab in Group', 'Collapse Group', 'Color', 'Ungroup', 'Close Group'])
  const colors = gm.items.find((i) => i.id === 'group.color')!.submenu!
  expect(colors.map((c) => c.label)).toEqual(['Grey', 'Blue', 'Red', 'Yellow', 'Green', 'Pink', 'Purple', 'Cyan', 'Orange'])
  expect(colors.filter((c) => c.checked).map((c) => c.id)).toEqual(['group.color:blue'])
  expect((await overlayFocus(rn, w)).id).toBe('group.edit')
  for (let i = 0; i < 3; i++) await rn.press('Down', [], 'overlay')
  expect((await overlayFocus(rn, w)).id).toBe('group.color')
  const parentAria = () => rn.js<any>(w.overlayId, `(() => { const r = document.querySelector('[data-item-id="group.color"]'); return { popup: r.getAttribute('aria-haspopup'), expanded: r.getAttribute('aria-expanded'), active: r.classList.contains('rn-menu__item--active') } })()`)
  expect(await parentAria()).toEqual({ popup: 'menu', expanded: 'false', active: true })
  await rn.press('Right', [], 'overlay')
  expect(await overlayFocus(rn, w)).toMatchObject({ id: 'group.color:grey', level: '1' })
  expect(await parentAria(), 'the parent row keeps the highlight').toEqual({ popup: 'menu', expanded: 'true', active: true })
  const sub = await rn.js<any>(w.overlayId, `(() => { const m = document.querySelector('.rn-menu--sub:not([hidden])'); return { role: m.getAttribute('role'), labelledby: m.getAttribute('aria-labelledby'), roles: [...m.querySelectorAll('[data-item-id]')].map((r) => r.getAttribute('role') + ':' + r.getAttribute('aria-checked')) } })()`)
  expect(sub.role).toBe('menu')
  expect(sub.labelledby).toBeTruthy()
  expect(sub.roles).toEqual(['menuitemradio:false', 'menuitemradio:true', ...Array(7).fill('menuitemradio:false')])
  await rn.press('Left', [], 'overlay')
  expect(await overlayFocus(rn, w)).toMatchObject({ id: 'group.color', level: '0' })
  expect((await boxes(rn, w)).boxes.length, 'Left closed the submenu').toBe(1)
  await rn.press('Return', [], 'overlay') // Enter on a parent opens it
  expect((await overlayFocus(rn, w)).id).toBe('group.color:grey')
  await rn.press('Escape', [], 'overlay')
  expect((await overlayFocus(rn, w)).id, 'Esc closes one level').toBe('group.color')
  expect(await currentMenu(rn, w.id)).not.toBeNull()
  await rn.press('Right', [], 'overlay')
  await rn.press('Down', [], 'overlay')
  await rn.press('Down', [], 'overlay')
  expect((await overlayFocus(rn, w)).id).toBe('group.color:red')
  await rn.press('Return', [], 'overlay')
  await menuGone(rn, w)
  await rn.waitSnap((s) => s.groups.find((g) => g.id === groupId)?.color === 'red', 'colour picked by keyboard')
  await poll(() => rn.js<boolean>(w.shellId, `document.activeElement?.dataset?.groupId === ${JSON.stringify(groupId)}`), 'focus back on the chip')

  // Profile button by keyboard (Enter = click with detail 0): first item focused; Esc returns focus, aria-expanded reset.
  await rn.js(w.shellId, `document.querySelector('.rn-profile-btn').focus(); true`)
  await enterKey(rn, w.shellId)
  const pm = await waitMenu(rn, w, { kind: 'profiles' })
  expect(pm.focusFirst).toBe(true)
  expect(pm.placement).toBe('below')
  expect(await rn.js(w.shellId, `document.querySelector('.rn-profile-btn').getAttribute('aria-expanded')`)).toBe('true')
  const first = flat(pm.items)[0]!
  expect((await overlayFocus(rn, w)).id).toBe(first)
  await escapeMenu(rn, w)
  await poll(() => rn.js<boolean>(w.shellId, `document.activeElement === document.querySelector('.rn-profile-btn') && document.querySelector('.rn-profile-btn').getAttribute('aria-expanded') === 'false'`), 'profile button refocused, collapsed')
  expect(await nativeMenus(rn)).toEqual([])
})

test('AC63: a keyboard-opened menu keeps its first item highlighted when the mouse last rested over an earlier menu', async ({ rn, server }) => {
  // KNOWN PRODUCT BUG (left failing on purpose, owner: src/renderer/overlay/menu.ts, A3).
  // Repro: open any themed menu, rest the pointer on one of its rows, close it with Esc, then open a menu from the
  // keyboard (Shift+F10 on a group chip). The new full-window layer appears under the resting pointer; Chromium
  // dispatches a pointerover for it without any movement, onPointerOver takes it as "pointer on the empty layer",
  // clears the highlight and focuses the menu box. The first item is no longer highlighted (AC63 / DESIGN-MENUS §5).
  // Arrow keys still work, so the impact is the missing initial highlight only.
  await stubNative(rn)
  const tab = await openCtxPage(rn, server)
  const w = await rn.win()
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: (await rn.snap()).activeTabId, color: 'blue' })
  await pageMenuOn(rn, w, '#blank')
  const row = await center(rn, w.overlayId, rowSel('ctx.reload'))
  await hover(rn, w.overlayId, row.x, row.y)
  await escapeMenu(rn, w)
  void tab
  await poll(() => rn.js<boolean>(w.shellId, `(() => { const c = document.querySelector('.rn-group-chip[data-group-id="${groupId}"]'); if (!c) return false; c.focus(); return document.activeElement === c })()`), 'chip focused')
  await rn.press('F10', ['shift'], 'shell')
  const gm = await waitMenu(rn, w, { kind: 'group' })
  expect(gm.focusFirst).toBe(true)
  await settle(400, 'a stray pointerover would clear the highlight')
  expect((await overlayFocus(rn, w)).id, 'first item still highlighted').toBe('group.edit')
})

// ---------------------------------------------------------------- AC61

test('AC61: tab menu by pointer with the "Add Tab to Group" submenu; profile menu radio; a submenu pick runs', async ({ rn, server }) => {
  await stubNative(rn)
  await rn.navigate(`${server.base}/a`)
  const s0 = await rn.snap()
  const t1 = s0.activeTabId
  const { tabId: t2 } = await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/b`, background: true })
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: t2, name: 'Errands', color: 'green' })
  const w = await rn.win()
  const tabC = await center(rn, w.shellId, `.rn-tab[data-tab-id="${t1}"]`)
  await rightClick(rn, w.shellId, tabC.x, tabC.y)
  const tm = await waitMenu(rn, w, { kind: 'tab' })
  expect(tm.placement).toBe('point')
  expect(tm.focusFirst).toBe(false)
  const addTo = tm.items.find((i) => i.id === 'tab.group-add')!
  expect(addTo.submenu!.map((i) => i.label)).toEqual(['Errands'])
  // Hover the parent: the submenu opens after the hover delay; pick its item by pointer.
  const parent = await center(rn, w.overlayId, rowSel('tab.group-add'))
  await hover(rn, w.overlayId, parent.x, parent.y)
  const subItem = addTo.submenu![0]!.id!
  await poll(() => rn.js<boolean>(w.overlayId, `!!document.querySelector(${JSON.stringify(rowSel(subItem))})`), 'submenu opened on hover')
  const sb = await boxes(rn, w)
  expect(sb.boxes.length).toBe(2)
  // The submenu's first item lines up with the parent row (DESIGN-MENUS §3.3).
  const subRow = await center(rn, w.overlayId, rowSel(subItem))
  expect(Math.abs(subRow.y - parent.y)).toBeLessThanOrEqual(3)
  await pickRow(rn, w, subItem)
  await menuGone(rn, w)
  await rn.waitSnap((s) => s.tabs.find((t) => t.id === t1)?.groupId === groupId, 'tab added to the group via the submenu')

  // Profile menu by pointer: radio on the current profile; "Manage profiles..." opens settings.
  const pb = await center(rn, w.shellId, '.rn-profile-btn')
  await click(rn, w.shellId, pb.x, pb.y)
  const pm = await waitMenu(rn, w, { kind: 'profiles' })
  const radios = pm.items.filter((i) => i.check === 'radio')
  expect(radios.length).toBeGreaterThanOrEqual(1)
  expect(radios.filter((r) => r.checked).length).toBe(1)
  expect(flat(pm.items).slice(-5)).toEqual(['-', 'profiles.menu:new', 'profiles.menu:incognito', '-', 'profiles.menu:manage'])
  expect(labels(pm.items).slice(-3)).toEqual(['New profile...', 'New incognito window', 'Manage profiles...'])
  const radioRole = await rn.js(w.overlayId, `document.querySelector(${JSON.stringify(rowSel(radios[0]!.id!))}).getAttribute('role') + ':' + document.querySelector(${JSON.stringify(rowSel(radios[0]!.id!))}).getAttribute('aria-checked')`)
  expect(radioRole).toBe('menuitemradio:true')
  await pickRow(rn, w, 'profiles.menu:manage')
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://settings/'), 'Manage profiles opened settings')
  expect(await nativeMenus(rn)).toEqual([])
})

test('AC61: bookmark folder menus: nested submenus, (Empty), (Too deep), dispositions by modifier and middle click; » overflow and the Bookmarks button', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await stubNative(rn)
  await rn.navigate(`${server.base}/a`)
  const bm = await bookmarksWc(rn)
  const top = await addFolder(rn, bm, 'bar', 'Top')
  const inner = await addFolder(rn, bm, top, 'Inner')
  await addBookmark(rn, bm, top, 'Page One', `${server.base}/title?t=One`)
  await addBookmark(rn, bm, inner, 'Deep Page', `${server.base}/title?t=Deep`)
  await addFolder(rn, bm, inner, 'Nothing here')
  // A chain 9 folders deep (the 8th menu level shows "(Too deep)").
  let p = await addFolder(rn, bm, 'bar', 'Chain')
  for (let i = 2; i <= 9; i++) p = await addFolder(rn, bm, p, `Chain ${i}`)
  const w = await rn.win()
  const pageTab = (await rn.snap()).activeTabId

  const openTop = async () => {
    const f = await barFolder(rn, w, 'Top')
    const before = (await currentMenu(rn, w.id))?.menuId ?? null
    await click(rn, w.shellId, f.x, f.y)
    return waitMenu(rn, w, { kind: 'bookmarks', not: before })
  }
  const m = await openTop()
  expect(m.label).toBe('Top')
  expect(m.placement).toBe('below')
  expect(labels(m.items)).toEqual(['Inner', 'Page One'])
  expect(await rn.js(w.shellId, `[...document.querySelectorAll('.rn-bookmarkbar__folder')].find((x) => x.textContent.trim() === 'Top').getAttribute('aria-expanded')`)).toBe('true')
  // Keyboard into Inner → its submenu has the bookmark and the empty folder whose submenu is "(Empty)".
  await rn.press('Down', [], 'overlay')
  await rn.press('Right', [], 'overlay')
  const inside = await rn.js<string[]>(w.overlayId, `[...document.querySelectorAll('.rn-menu--sub:not([hidden]) .rn-menu__label')].map((l) => l.textContent)`)
  expect(inside).toEqual(['Deep Page', 'Nothing here'])
  await rn.press('Down', [], 'overlay')
  await rn.press('Right', [], 'overlay')
  const empty = await rn.js<any>(w.overlayId, `(() => { const ms = [...document.querySelectorAll('.rn-menu--sub:not([hidden])')]; const last = ms[ms.length - 1]; const r = last.querySelector('[data-item-id]'); return { n: ms.length, text: r.textContent, disabled: r.getAttribute('aria-disabled') } })()`)
  expect(empty).toEqual({ n: 2, text: '(Empty)', disabled: 'true' })
  // Esc closes one level at a time: three presses close (Empty), Inner and the root.
  for (let i = 0; i < 3; i++) await rn.press('Escape', [], 'overlay')
  await menuGone(rn, w)
  expect(await rn.js(w.shellId, `[...document.querySelectorAll('.rn-bookmarkbar__folder')].find((x) => x.textContent.trim() === 'Top').getAttribute('aria-expanded')`)).toBe('false')

  // Dispositions (AC61): Cmd/Ctrl-click → background tab, Shift-click → new active tab, middle → background, plain → current.
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  const n0 = (await rn.snap()).tabs.length
  await openTop()
  await pickRow(rn, w, flat(m.items)[1]!, 'left', [mod])
  let s = await rn.waitSnap((x) => x.tabs.length === n0 + 1, 'Cmd-click: new tab')
  expect(s.activeTabId, 'Cmd-click opens in the background').toBe(pageTab)
  await openTop()
  await pickRow(rn, w, flat(m.items)[1]!, 'middle')
  s = await rn.waitSnap((x) => x.tabs.length === n0 + 2, 'middle click: new tab')
  expect(s.activeTabId, 'middle click opens in the background').toBe(pageTab)
  await openTop()
  await pickRow(rn, w, flat(m.items)[1]!, 'left', ['shift'])
  s = await rn.waitSnap((x) => x.tabs.length === n0 + 3 && x.activeTabId !== pageTab && rn.active(x).url !== '', 'Shift-click: new active tab')
  expect(rn.active(s).url).toBe(`${server.base}/title?t=One`)
  await rn.shell('tabs.activate', { tabId: pageTab })
  await rn.waitSnap((x) => x.activeTabId === pageTab, 'back on the page tab')
  await openTop()
  await pickRow(rn, w, flat(m.items)[1]!)
  s = await rn.waitSnap((x) => rn.active(x).url === `${server.base}/title?t=One`, 'plain pick: current tab')
  expect(s.activeTabId).toBe(pageTab)
  expect(s.tabs.length).toBe(n0 + 3)

  // "(Too deep)": open Chain and walk Right to the deepest level.
  const chain = await barFolder(rn, w, 'Chain')
  await click(rn, w.shellId, chain.x, chain.y)
  const cm = await waitMenu(rn, w, { kind: 'bookmarks' })
  let deepest: Item[] = cm.items
  let levels = 1
  while (deepest[0]?.submenu) {
    deepest = deepest[0].submenu
    levels++
  }
  expect(levels).toBe(8)
  expect(deepest.map((i) => [i.label, i.enabled])).toEqual([['(Too deep)', false]])
  await rn.press('Down', [], 'overlay')
  for (let i = 0; i < 7; i++) await rn.press('Right', [], 'overlay')
  const tooDeep = await rn.js<string[]>(w.overlayId, `(() => { const ms = [...document.querySelectorAll('.rn-menu:not([hidden])')]; return [String(ms.length), ms[ms.length - 1].textContent] })()`)
  expect(tooDeep).toEqual(['8', '(Too deep)'])
  const all = await boxes(rn, w)
  for (const b of all.boxes) {
    expect(b.left).toBeGreaterThanOrEqual(4)
    expect(b.right).toBeLessThanOrEqual(all.vw - 4)
  }
  await closeAll(rn, w)

  // The Bookmarks button next to the location bar (y1997's main bookmarks access) and the » overflow both list the bar.
  await setSkin(rn, 'y1997')
  const bb = await center(rn, w.shellId, '.rn-locationbar__bookmarks')
  await click(rn, w.shellId, bb.x, bb.y)
  const bmMenu = await waitMenu(rn, w, { kind: 'bookmarks' })
  expect(bmMenu.label).toBe('Bookmarks')
  expect(labels(bmMenu.items)).toEqual(['Top', 'Chain'])
  await escapeMenu(rn, w)
  await addMany(rn, bm, 'bar', 40, server.base, 'Overflow bookmark with a long title')
  const more = await poll(() => rn.js<{ x: number; y: number } | null>(w.shellId, `(() => { const b = document.querySelector('.rn-bookmarkbar__more'); if (!b || b.hidden || !b.getClientRects().length) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`), '» overflow button')
  await click(rn, w.shellId, more.x, more.y)
  const ov = await waitMenu(rn, w, { kind: 'bookmarks' })
  expect(ov.items.filter((i) => i.kind === 'item').length).toBe(42)
  await escapeMenu(rn, w)
  expect(await nativeMenus(rn)).toEqual([])
})

test('AC61: a capped bookmark menu ends with "More in Bookmarks manager…", which opens the manager', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await stubNative(rn)
  const bm = await bookmarksWc(rn)
  const big = await addFolder(rn, bm, 'bar', 'Big')
  await addMany(rn, bm, big, 401, server.base, 'Item')
  const w = await rn.win()
  const f = await barFolder(rn, w, 'Big')
  const t0 = performance.now()
  await click(rn, w.shellId, f.x, f.y)
  const m = await waitMenu(rn, w, { kind: 'bookmarks' })
  const openMs = performance.now() - t0
  const ids = flat(m.items)
  expect(ids.length).toBe(400)
  expect(ids.slice(-2)).toEqual(['-', 'bm:more'])
  expect(m.items[m.items.length - 1]!.label).toBe('More in Bookmarks manager…')
  test.info().annotations.push({ type: 'timing', description: `401-item folder menu open → drawn: ${Math.round(openMs)} ms` })
  const b = (await boxes(rn, w)).boxes[0]!
  expect(b.scrolls, 'taller than the window: the menu scrolls').toBe(true)
  await rn.press('End', [], 'overlay')
  expect((await overlayFocus(rn, w)).id).toBe('bm:more')
  await rn.press('Return', [], 'overlay')
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://bookmarks/'), 'manager opened')
})

// ---------------------------------------------------------------- AC62

test('AC62: placement: four corners flip and shift inside the 4px margin; submenus flip at the right edge; 150% zoom; tall menus scroll', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await stubNative(rn)
  const tab = await openCtxPage(rn, server)
  const w = await rn.win()
  const tb = (await rn.main(() => (globalThis as any).__rn.windows()[0].tabBounds)) as { x: number; y: number; width: number; height: number }
  const inside = (all: { boxes: Box[]; vw: number; vh: number }, what: string) => {
    for (const b of all.boxes) {
      expect(b.left, `${what} left margin`).toBeGreaterThanOrEqual(4 - 0.5)
      expect(b.top, `${what} top margin`).toBeGreaterThanOrEqual(4 - 0.5)
      expect(b.right, `${what} right margin`).toBeLessThanOrEqual(all.vw - 4 + 0.5)
      expect(b.bottom, `${what} bottom margin`).toBeLessThanOrEqual(all.vh - 4 + 0.5)
    }
  }
  const corners = [
    { name: 'top-left', x: 3, y: 3 },
    { name: 'top-right', x: tb.width - 3, y: 3 },
    { name: 'bottom-left', x: 3, y: tb.height - 3 },
    { name: 'bottom-right', x: tb.width - 3, y: tb.height - 3 }
  ]
  for (const c of corners) {
    const spec = await pageMenuAt(rn, w, c.x, c.y)
    expect(spec.anchor, `${c.name}: anchor = params + tab view offset`).toEqual({ x: c.x + tb.x, y: c.y + tb.y, width: 0, height: 0 })
    const all = await boxes(rn, w)
    inside(all, c.name)
    const b = all.boxes[0]!
    const ax = spec.anchor.x
    const ay = spec.anchor.y
    if (c.name.endsWith('right')) expect(b.right, `${c.name}: flipped left of the pointer`).toBeLessThanOrEqual(ax)
    else expect(b.left, `${c.name}: right of the pointer`).toBeGreaterThanOrEqual(ax)
    if (c.name.startsWith('bottom')) expect(b.bottom, `${c.name}: flipped above the pointer`).toBeLessThanOrEqual(ay)
    else expect(b.top, `${c.name}: below the pointer`).toBeGreaterThanOrEqual(ay)
    await escapeMenu(rn, w)
  }

  // Submenu at the right edge: a group menu opened at the far right puts Color's submenu on the left.
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: (await rn.snap()).activeTabId, color: 'grey' })
  const vw = (await boxes(rn, w)).vw
  await shellFire(rn, w, `window.retronet.groups.contextMenu({ groupId: ${JSON.stringify(groupId)}, x: ${vw - 6}, y: 60 })`)
  await waitMenu(rn, w, { kind: 'group' })
  const color = await center(rn, w.overlayId, rowSel('group.color'))
  await hover(rn, w.overlayId, color.x, color.y)
  await poll(async () => (await boxes(rn, w)).boxes.length === 2, 'Color submenu open')
  const sub = await boxes(rn, w)
  inside(sub, 'submenu at the right edge')
  expect(sub.boxes[1]!.right, 'submenu flipped to the left of its parent').toBeLessThanOrEqual(sub.boxes[0]!.left + 3)
  await closeAll(rn, w)

  // R-1: at 150% page zoom the params are already view (DIP) coordinates: the menu opens at the pointer and the hit
  // test found the link under it. No scaling is needed.
  await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.setZoomFactor(1.5), tab)
  await poll(() => rn.js<boolean>(tab, `innerWidth < ${tb.width - 10}`), 'zoom applied')
  const css = await center(rn, tab, '#lnk') // CSS px at 150%
  const vx = Math.round((css.left + 200) * 1.5) // the link box past its text (macOS selects a right-clicked word)
  const vy = Math.round(css.y * 1.5)
  const zs = await pageMenuAt(rn, w, vx, vy)
  expect(flat(zs.items), 'the link under the pointer at 150%').toEqual(PAGE_ITEMS.link)
  expect(zs.anchor).toEqual({ x: vx + tb.x, y: vy + tb.y, width: 0, height: 0 })
  const zb = await boxes(rn, w)
  inside(zb, '150% zoom')
  expect(Math.abs(zb.boxes[0]!.left - (vx + tb.x))).toBeLessThanOrEqual(2)
  expect(Math.abs(zb.boxes[0]!.top - (vy + tb.y))).toBeLessThanOrEqual(2)
  await escapeMenu(rn, w)
  // Bottom-right corner at 150%: still flipped inside.
  await pageMenuAt(rn, w, tb.width - 3, tb.height - 3)
  inside(await boxes(rn, w), '150% bottom-right')
  await escapeMenu(rn, w)
  await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.setZoomFactor(1), tab)

  // Taller than the window: 60 bookmarks in a bar folder at 1280×500 → clamped to the margins and scrolled.
  const bm = await bookmarksWc(rn)
  const tall = await addFolder(rn, bm, 'bar', 'Tall')
  await addMany(rn, bm, tall, 60, server.base, 'Tall item')
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 500))
  await poll(() => rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize()[1] === 500), 'window at 1280×500')
  const tf = await barFolder(rn, w, 'Tall')
  await click(rn, w.shellId, tf.x, tf.y)
  await waitMenu(rn, w, { kind: 'bookmarks' })
  const tallBoxes = await boxes(rn, w)
  expect(tallBoxes.vh).toBe(500)
  inside(tallBoxes, 'tall menu')
  expect(tallBoxes.boxes[0]!.scrolls).toBe(true)
  expect(tallBoxes.boxes[0]!.scrollH).toBeGreaterThan(tallBoxes.boxes[0]!.clientH)
  await rn.press('End', [], 'overlay')
  const last = await rn.js<{ top: number; bottom: number }>(w.overlayId, `(() => { const r = document.activeElement.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })()`)
  expect(last.bottom, 'End scrolls the last row into view').toBeLessThanOrEqual(tallBoxes.boxes[0]!.bottom + 0.5)
  await escapeMenu(rn, w)
})

// ---------------------------------------------------------------- AC64

test('AC64: one menu per window; Esc, swallowed outside click, blur, resize and another overlay close it; stale and foreign picks do nothing', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await stubNative(rn)
  const tab = await openCtxPage(rn, server)
  const w = await rn.win()
  const pickVia = (winId: number, menuId: string, itemId: string) =>
    rn.main((_e, a: { winId: number; menuId: string; itemId: string }) => (globalThis as any).__rn.pickMenu(a.winId, { menuId: a.menuId, itemId: a.itemId, mods: { meta: false, ctrl: false, shift: false, alt: false }, button: 0 }) as boolean, { winId, menuId, itemId })

  // One menu per window: a tab menu replaces the page menu, which can then neither be picked nor dismissed.
  const page = await pageMenuOn(rn, w, '#blank')
  const t = rn.active(await rn.snap()).id
  await shellFire(rn, w, `window.retronet.tabs.contextMenu({ tabId: ${t}, x: 300, y: 20 })`)
  const tm = await waitMenu(rn, w, { kind: 'tab', not: page.menuId })
  expect(await pickVia(w.id, page.menuId, 'ctx.reload'), 'old menuId').toBe(false)
  expect(await rn.main((_e, a: { id: number; m: string }) => (globalThis as any).__rn.dismissMenu(a.id, a.m), { id: w.id, m: page.menuId }), 'late dismiss of the old menu').toBe(false)
  expect((await currentMenu(rn, w.id))!.menuId, 'the newer menu is still open').toBe(tm.menuId)
  // Unknown, disabled, separator-free submenu parent ids are ignored and leave the menu open.
  expect(await pickVia(w.id, tm.menuId, 'no.such.item')).toBe(false)
  expect(await pickVia(w.id, tm.menuId, 'tab.reopen'), 'disabled item').toBe(false)
  // A forged menu.pick from the shell (not the overlay) is refused by the router.
  const forged = await rn.forge(w.shellId, 'menu.pick', { menuId: tm.menuId, itemId: 'tab.close', mods: NO_MODS, button: 0 })
  expect(forged.ok).toBe(false)
  expect((await currentMenu(rn, w.id))!.menuId).toBe(tm.menuId)
  expect((await rn.snap()).tabs.length).toBe(1)
  // The shell's call resolves when the menu closes.
  expect(await rn.js(w.shellId, `window.__menuRes === undefined`)).toBe(true)
  await escapeMenu(rn, w)
  await poll(() => rn.js<boolean>(w.shellId, `window.__menuRes !== undefined`), 'tabs.contextMenu resolved on close')

  // Group menu: a submenu parent id is not pickable.
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: t, color: 'cyan' })
  await shellFire(rn, w, `window.retronet.groups.contextMenu({ groupId: ${JSON.stringify(groupId)}, x: 200, y: 20 })`)
  const gm = await waitMenu(rn, w, { kind: 'group' })
  expect(await pickVia(w.id, gm.menuId, 'group.color'), 'submenu parent').toBe(false)
  expect(await currentMenu(rn, w.id)).not.toBeNull()
  await escapeMenu(rn, w)

  // Outside click is swallowed: it closes the menu and does not click the link underneath.
  const url0 = rn.active(await rn.snap()).url
  const link = await center(rn, tab, '#lnk')
  const tb = (await rn.main(() => (globalThis as any).__rn.windows()[0].tabBounds)) as { x: number; y: number }
  await pageMenuOn(rn, w, '#blank')
  await click(rn, w.overlayId, link.left + 10 + tb.x, link.y + tb.y)
  await menuGone(rn, w, 'outside click closed the menu')
  await settle(600, 'a click-through would navigate to /b')
  expect(rn.active(await rn.snap()).url).toBe(url0)

  // Window blur, resize, move and fullscreen events close it.
  for (const ev of ['blur', 'resize', 'move', 'enter-full-screen'] as const) {
    await pageMenuOn(rn, w, '#blank')
    await rn.main(({ BrowserWindow }, e: string) => BrowserWindow.getAllWindows()[0]!.emit(e as 'blur'), ev)
    await menuGone(rn, w, `${ev} closed the menu`)
  }
  // A real resize closes it as well.
  await pageMenuOn(rn, w, '#blank')
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760))
  await menuGone(rn, w, 'setContentSize closed the menu')
  // Another overlay (the palette) takes over.
  await pageMenuOn(rn, w, '#blank')
  await rn.shell('commands.run', { id: 'palette.open' })
  await poll(async () => (await overlayKind(rn, w.id)) === 'palette' && (await currentMenu(rn, w.id)) === null, 'palette replaced the menu')
  await rn.press('Escape', [], 'overlay')
  await poll(async () => (await overlayKind(rn, w.id)) === null, 'palette closed')

  // Stale pick: the tab navigated after the menu opened → Reload does nothing (no new request) and the menu closes.
  const stale = await pageMenuOn(rn, w, '#blank')
  await rn.main(({ webContents }, a: { id: number; url: string }) => void webContents.fromId(a.id)!.loadURL(a.url), { id: tab, url: `${server.base}/b` })
  await rn.waitSnap((s) => rn.active(s).url === `${server.base}/b` && !rn.active(s).loading, 'tab navigated')
  const hitsB = server.requests.filter((r) => r.path === '/b').length
  expect(await pickVia(w.id, stale.menuId, 'ctx.reload'), 'stale pick').toBe(false)
  await settle(800, 'a stale Reload would request /b again')
  expect(server.requests.filter((r) => r.path === '/b').length).toBe(hitsB)
  await menuGone(rn, w)

  // The target tab closes → its menu closes.
  const { tabId: t2 } = await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/a` })
  await rn.waitSnap((s) => s.activeTabId === t2 && !rn.active(s).loading, 'second tab')
  await pageMenuAt(rn, w, 300, 300)
  await rn.shell('tabs.close', { tabId: t2 })
  await menuGone(rn, w, 'closing the tab closed its menu')

  // Another window cannot pick this window's menu.
  const m1 = await pageMenuAt(rn, w, 300, 300)
  await rn.shell('commands.run', { id: 'window.new' })
  const w2 = await poll(async () => (await rn.windows()).find((x) => x.id !== w.id && x.shellUrl === 'retronet://shell/'), 'second window')
  await rn.waitWindowReady(w2.id)
  const hitsB2 = server.requests.filter((r) => r.path === '/b').length
  expect(await pickVia(w2.id, m1.menuId, 'ctx.reload'), 'pick through another window').toBe(false)
  // The other window's overlay may send menu.pick, but it reaches only its own window's registry.
  await rn.forge(w2.overlayId, 'menu.pick', { menuId: m1.menuId, itemId: 'ctx.reload', mods: NO_MODS, button: 0 })
  await settle(800, 'a foreign pick would reload /b')
  expect(server.requests.filter((r) => r.path === '/b').length).toBe(hitsB2)
  expect(await nativeMenus(rn)).toEqual([])
})

// ---------------------------------------------------------------- AC65

test('AC65: native fallback while sign-in or the group editor is up (prompt kept), and for the overlay\'s own text fields', async ({ rn, server }) => {
  await stubNative(rn)
  await rn.navigate(`${server.base}/a`)
  const tab = await rn.activeTabWcId()
  const w = await rn.win()
  const fb0 = await fallbackCount(rn)

  // Sign-in prompt up: a page right-click becomes a native menu, the prompt stays.
  await rn.shell('tabs.navigate', { input: `${server.base}/basic-auth` })
  await poll(async () => (await overlayKind(rn, w.id)) === 'http-auth', 'http-auth overlay')
  const authBefore = await rn.js<string | null>(w.overlayId, `document.querySelector('.rn-modal[data-auth-id]')?.dataset.authId ?? null`)
  await rightClick(rn, tab, 300, 200)
  await poll(async () => (await fallbackCount(rn)) === fb0 + 1, 'fallback used')
  const natives = await nativeMenus(rn)
  expect(natives.length).toBe(1)
  expect(natives[0]).toContain('ctx.inspect')
  expect(await overlayKind(rn, w.id), 'sign-in prompt not replaced').toBe('http-auth')
  expect(await rn.js(w.overlayId, `document.querySelector('.rn-modal[data-auth-id]')?.dataset.authId ?? null`)).toBe(authBefore)
  expect(await currentMenu(rn, w.id)).toBeNull()
  await closeNatives(rn)
  await rn.press('Escape', [], 'overlay')
  await poll(async () => (await overlayKind(rn, w.id)) === null, 'sign-in cancelled')

  // Group editor up: the tab strip's group menu goes native too.
  const t = rn.active(await rn.snap()).id
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: t, color: 'pink' })
  await rn.shell('groups.edit', { groupId, anchor: { x: 200, y: 10, width: 40, height: 20 } })
  await poll(async () => (await overlayKind(rn, w.id)) === 'group-editor', 'group editor')
  await shellFire(rn, w, `window.retronet.groups.contextMenu({ groupId: ${JSON.stringify(groupId)}, x: 200, y: 20 })`)
  await poll(async () => (await fallbackCount(rn)) === fb0 + 2, 'fallback for the group menu')
  expect((await nativeMenus(rn))[1]).toContain('group.color')
  expect(await overlayKind(rn, w.id)).toBe('group-editor')
  // A native pick still goes through main's runner (Collapse Group).
  await rn.main(() => {
    const n = (globalThis as any).__native[1]
    n.menu.getMenuItemById('group.collapse').click()
    n.cb?.()
  })
  await rn.waitSnap((s) => s.groups.find((g) => g.id === groupId)?.collapsed === true, 'native pick ran')
  await poll(() => rn.js<boolean>(w.shellId, `window.__menuRes !== undefined`), 'groups.contextMenu resolved after the native menu closed')
  await rn.press('Escape', [], 'overlay')
  await poll(async () => (await overlayKind(rn, w.id)) === null, 'editor closed')

  // The palette's own input keeps a native edit menu; the palette stays open.
  await rn.shell('commands.run', { id: 'palette.open' })
  await poll(async () => (await overlayKind(rn, w.id)) === 'palette', 'palette')
  const input = await center(rn, w.overlayId, '.rn-palette__input')
  await rightClick(rn, w.overlayId, input.x, input.y)
  await poll(async () => (await fallbackCount(rn)) === fb0 + 3, 'fallback for the palette field')
  expect((await nativeMenus(rn))[2]).toEqual(expect.arrayContaining(['edit.paste', 'edit.selectAll']))
  expect(await overlayKind(rn, w.id), 'palette not torn down').toBe('palette')
  await closeNatives(rn)

  // The macOS app menu stays native (no themed replacement).
  if (process.platform === 'darwin') expect(await rn.main(({ Menu }) => Menu.getApplicationMenu() !== null)).toBe(true)
})

// ---------------------------------------------------------------- AC67

test('AC67: DESIGN-MENUS §9 menu screenshots in background mode (.team/screens/f1-menu-*)', async ({ rn, server }) => {
  test.setTimeout(300_000)
  await stubNative(rn)
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))
  await rn.navigate(`${server.base}/a`)
  await openCtxPage(rn, server)
  const w = await rn.win()
  const opaque: Record<string, unknown> = {}

  /** Link menu at mid-window, pointer on "Copy link address". */
  const linkScene = async (win: WinInfo, name: string) => {
    const tab = await rn.activeTabWcId(win.id)
    // Busy red text where the menu will be drawn: any transparency in the menu surface would show it (A3's note that
    // y1999/y2001 compute background-color: transparent; their surface is a background-image gradient).
    await rn.js(tab, `(() => { const l = document.getElementById('lnk'); l.style.left = '560px'; l.style.top = '250px';
      if (!document.getElementById('behind')) { const d = document.createElement('div'); d.id = 'behind'; d.setAttribute('aria-hidden', 'true');
        d.style.cssText = 'position:absolute;left:600px;top:290px;width:560px;height:300px;overflow:hidden;color:#d00;font:bold 18px monospace;pointer-events:none;z-index:-1';
        d.textContent = 'BEHIND THE MENU '.repeat(200); document.body.append(d) } return true })()`)
    await pageMenuOn(rn, win, '#lnk', 200)
    const row = await center(rn, win.overlayId, rowSel('ctx.copyLink'))
    await hover(rn, win.overlayId, row.x, row.y)
    await poll(() => rn.js<boolean>(win.overlayId, `document.querySelector(${JSON.stringify(rowSel('ctx.copyLink'))}).classList.contains('rn-menu__item--active')`), 'hover highlight')
    opaque[name] = await rn.js(win.overlayId, `(() => { const m = document.querySelector('.rn-menu'); const cs = getComputedStyle(m); return { bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 80), anim: m.getAnimations({ subtree: true }).length } })()`)
    await shot(rn, win, name)
    await escapeMenu(rn, win)
  }

  for (const skin of SKIN_IDS) {
    await setSkin(rn, skin)
    await linkScene(w, `menu-${skin}`)
    // D20: page menu with the accelerator column (Back/Forward/Reload), right-aligned and tabular.
    await pageMenuAt(rn, w, 300, 120)
    const accel = await rn.js<any>(w.overlayId, `(() => { const els = [...document.querySelectorAll('.rn-menu__accel')].filter((e) => e.textContent.trim()); const cs = els.map((e) => getComputedStyle(e)); const rights = els.map((e) => Math.round(e.getBoundingClientRect().right)); return { n: els.length, align: cs[0]?.textAlign, tab: cs[0]?.fontVariantNumeric, rights } })()`)
    expect(accel.n, 'accelerators shown').toBeGreaterThan(0)
    expect(accel.align).toBe('end')
    expect(accel.tab).toContain('tabular-nums')
    expect(new Set(accel.rights).size, 'accel right edges aligned').toBe(1)
    await shot(rn, w, `menu-${skin}-accel`)
    await escapeMenu(rn, w)
    // Group menu via Shift+F10 on the chip → Down to Color → Right.
    const t = rn.active(await rn.snap()).id
    const snap = await rn.snap()
    let gid = snap.groups[0]?.id
    if (!gid) gid = (await rn.shell<{ groupId: string }>('groups.create', { tabId: t, name: 'Reading', color: 'purple' })).groupId
    await poll(() => rn.js<boolean>(w.shellId, `(() => { const c = document.querySelector('.rn-group-chip[data-group-id="${gid}"]'); if (!c) return false; c.focus(); return document.activeElement === c })()`), 'chip focused')
    await rn.press('F10', ['shift'], 'shell')
    await waitMenu(rn, w, { kind: 'group' })
    // Home first: after the link scene's hover, the first-item highlight is lost (see the AC63 stale-pointer test).
    await rn.press('Home', [], 'overlay')
    await poll(async () => (await overlayFocus(rn, w)).id === 'group.edit', 'first item focused')
    for (let i = 0; i < 3; i++) await rn.press('Down', [], 'overlay')
    await rn.press('Right', [], 'overlay')
    await poll(async () => (await overlayFocus(rn, w)).level === '1', 'Color submenu focused')
    await shot(rn, w, `menu-${skin}-submenu`)
    await rn.press('Escape', [], 'overlay')
    await escapeMenu(rn, w)
  }

  // y1997: tab menu with the "Add Tab to Group" submenu open; flip at (W−10, H−10).
  await setSkin(rn, 'y1997')
  const { tabId: t2 } = await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/b`, background: true })
  await rn.waitSnap((s) => s.tabs.some((t) => t.id === t2), 'second tab')
  const tc = await center(rn, w.shellId, `.rn-tab[data-tab-id="${t2}"]`)
  await rightClick(rn, w.shellId, tc.x, tc.y)
  await waitMenu(rn, w, { kind: 'tab' })
  const add = await center(rn, w.overlayId, rowSel('tab.group-add'))
  await hover(rn, w.overlayId, add.x, add.y)
  await poll(async () => (await boxes(rn, w)).boxes.length === 2, 'Add Tab to Group submenu')
  await shot(rn, w, 'menu-y1997-checks')
  await closeAll(rn, w)
  const tb = (await rn.main(() => (globalThis as any).__rn.windows()[0].tabBounds)) as { x: number; y: number; width: number; height: number }
  await pageMenuAt(rn, w, tb.width - 10, tb.height - 10)
  await shot(rn, w, 'menu-y1997-flip')
  await escapeMenu(rn, w)

  // Forced colors (optional scene): y1997 page menu with forced-colors emulated in the overlay.
  await rn.main(async ({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  }, w.overlayId)
  await linkScene(w, 'menu-forced-colors')
  await rn.main(async ({ webContents }, id: number) => {
    const wc = webContents.fromId(id)!
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] })
    wc.debugger.detach()
  }, w.overlayId)

  // y1999: a folder chain 3 deep ending in (Empty); reduced motion identical to the plain link scene.
  await setSkin(rn, 'y1999')
  const bm = await bookmarksWc(rn)
  const a = await addFolder(rn, bm, 'bar', 'Gumdrops')
  await addBookmark(rn, bm, a, 'Grape page', `${server.base}/title?t=Grape`)
  const b2 = await addFolder(rn, bm, a, 'Lime folder')
  await addBookmark(rn, bm, b2, 'Lime page', `${server.base}/title?t=Lime`)
  await addFolder(rn, bm, b2, 'Empty jar')
  const gf = await barFolder(rn, w, 'Gumdrops')
  await click(rn, w.shellId, gf.x, gf.y)
  await waitMenu(rn, w, { kind: 'bookmarks' })
  await rn.press('Down', [], 'overlay')
  await rn.press('Down', [], 'overlay')
  await rn.press('Right', [], 'overlay')
  await rn.press('Down', [], 'overlay')
  await rn.press('Right', [], 'overlay')
  await poll(async () => (await boxes(rn, w)).boxes.length === 3, '3 levels open')
  const levels = await rn.js<any[]>(w.overlayId, `[...document.querySelectorAll('.rn-menu:not([hidden])')].map((m) => ({ top: m.querySelector('[data-item-id]').getBoundingClientRect().top, expandedTop: document.querySelector('[aria-controls="' + m.id + '"]')?.getBoundingClientRect().top ?? null }))`)
  for (const l of levels.slice(1)) expect(Math.abs(l.top - l.expandedTop), 'submenu first item aligned with its parent row').toBeLessThanOrEqual(2)
  await shot(rn, w, 'menu-y1999-deep')
  for (let i = 0; i < 3; i++) await rn.press('Escape', [], 'overlay')
  await menuGone(rn, w)
  const st = await settingsWc(rn)
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await poll(() => rn.js<boolean>(w.overlayId, `document.documentElement.dataset.reducedMotion === 'true'`), 'overlay reduced motion')
  await rn.shell('tabs.activate', { tabId: (await rn.snap()).tabs[0]!.id })
  await openCtxPage(rn, server)
  await linkScene(w, 'menu-y1999-reduced')
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: false })).ok).toBe(true)

  // y2001: 60 bookmarks at 1280×500, clamped and scrolled.
  await setSkin(rn, 'y2001')
  const tall = await addFolder(rn, bm, 'bar', 'Sixty')
  await addMany(rn, bm, tall, 60, server.base, 'Horizon link')
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 500))
  await poll(() => rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize()[1] === 500), '1280×500')
  const sf = await barFolder(rn, w, 'Sixty')
  await click(rn, w.shellId, sf.x, sf.y)
  await waitMenu(rn, w, { kind: 'bookmarks' })
  expect((await boxes(rn, w)).boxes[0]!.scrolls).toBe(true)
  await shot(rn, w, 'menu-y2001-scroll')
  await escapeMenu(rn, w)
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))

  // y1994: last screen of a capped menu.
  await setSkin(rn, 'y1994')
  const cap = await addFolder(rn, bm, 'bar', 'Capped')
  await addMany(rn, bm, cap, 401, server.base, 'Pioneer link')
  const cf = await barFolder(rn, w, 'Capped')
  await click(rn, w.shellId, cf.x, cf.y)
  await waitMenu(rn, w, { kind: 'bookmarks' })
  await rn.press('End', [], 'overlay')
  expect((await overlayFocus(rn, w)).id).toBe('bm:more')
  await shot(rn, w, 'menu-y1994-bookmarks-cap')
  await escapeMenu(rn, w)

  // Incognito: the link scene in each skin.
  const incId = await rn.profiles<number>('newIncognitoWindow', undefined, `${server.base}/a`)
  await rn.waitWindowReady(incId)
  const wi = await rn.win(incId)
  expect(wi.incognito).toBe(true)
  await openCtxPage(rn, server, incId)
  for (const skin of SKIN_IDS) {
    await setSkin(rn, skin, incId)
    await poll(() => rn.js<boolean>(wi.overlayId, `document.documentElement.dataset.incognito === 'true'`), 'overlay incognito')
    await linkScene(wi, `menu-${skin}-incognito`)
  }
  writeFileSync(join(SCREENS, 'f1-menu-surfaces.json'), JSON.stringify(opaque, null, 2))
  // No motion in any menu (DESIGN-MENUS §0).
  for (const [k, v] of Object.entries(opaque)) expect((v as { anim: number }).anim, `${k}: no animations`).toBe(0)
  expect(await nativeMenus(rn)).toEqual([])
})
