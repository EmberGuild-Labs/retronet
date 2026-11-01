// PLAN-FINAL F-E2E2: the hidden era pages ("eggs"), in background mode (PLAN-FINAL §0). Local fixture server only:
// every external link an egg carries is either left unclicked or re-pointed at the loopback server first.
//   AC68 each egg renders in its own era under every active skin, with its photos, sources and credits, no CSP or
//        console errors and no motion · AC69 no bridge, unreachable from the web, never in history or suggestions,
//        bookmarkable and restored with the session · AC70 one shell gesture per skin (2 s cooldown, inert while
//        loading) and the About hints · DESIGN-EGGS §1 open question (target=_blank from an egg) · DESIGN-EGGS §8
//        screenshots → .team/screens/f2-*.png
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchApp, poll, settle, sleep, ROOT, SKIN_IDS, type RN, type WinInfo } from './helpers/launch'
import type { FixtureServer } from './helpers/server'
import { EGG_HOSTS, EGG_PAGES, isEggUrl, type EggHost } from '../../src/shared/eggs'

type Skin = (typeof SKIN_IDS)[number]
const SCREENS = join(ROOT, '.team', 'screens')
const ERA_OF = Object.fromEntries(SKIN_IDS.map((s) => [EGG_PAGES[s].slug, s])) as Record<EggHost, Skin>
const eggUrl = (slug: EggHost): string => `retronet://${slug}/`
const MODS = { meta: false, ctrl: false, shift: false, alt: false }

// ---------------------------------------------------------------- helpers

/** Switch skin (palette command) and wait until the shell wears it. */
async function setSkin(rn: RN, skin: Skin, winId?: number): Promise<void> {
  await rn.shell('commands.run', { id: 'skin.switch', arg: skin }, winId)
  await rn.waitSnap((s) => s.skin === skin, `skin ${skin}`, { windowId: winId })
  const w = await rn.win(winId)
  await poll(() => rn.js<boolean>(w.shellId, `document.documentElement.dataset.skin === ${JSON.stringify(skin)} && !document.getElementById('rn-skin')?.dataset.rnSkinPending`), `shell in ${skin}`)
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

/** Collect console errors and warnings of a webContents from now on (main-side, so nothing is injected in the page). */
async function watchConsole(rn: RN, wcId: number): Promise<void> {
  await rn.main(({ webContents }, id: number) => {
    const g = globalThis as any
    g.__eggConsole ??= {}
    if (g.__eggConsole[id]) return
    const list: string[] = (g.__eggConsole[id] = [])
    webContents.fromId(id)!.on('console-message', (e: any, level?: unknown, message?: unknown) => {
      const lv = e?.level ?? level
      const msg = e?.message ?? message
      if (lv === 'error' || lv === 'warning' || lv === 2 || lv === 3) list.push(`${String(lv)}: ${String(msg)}`)
    })
  }, wcId)
}
const consoleOf = (rn: RN, wcId: number): Promise<string[]> => rn.main((_e, id: number) => [...(((globalThis as any).__eggConsole?.[id] as string[]) ?? [])], wcId)
const clearConsole = (rn: RN, wcId: number): Promise<void> => rn.main((_e, id: number) => {
  const l = (globalThis as any).__eggConsole?.[id]
  if (l) l.length = 0
}, wcId)

/** Record every eggs.open / eggs.openFromPage that reaches main (wraps the real handler; it still runs). */
async function countEggOpens(rn: RN): Promise<void> {
  await rn.main(({ ipcMain }) => {
    const g = globalThis as any
    if (g.__eggOpens) return
    g.__eggOpens = []
    for (const m of ['eggs.open', 'eggs.openFromPage']) {
      const ch = 'rn:invoke:' + m
      const real = (ipcMain as any)._invokeHandlers.get(ch)
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, async (e: any, ...a: unknown[]) => {
        g.__eggOpens.push({ m, req: JSON.stringify(a[0]), at: Date.now() })
        if (g.__eggFail) return { ok: false, code: 'E_UNAVAILABLE', message: 'test-forced failure' }
        return real(e, ...a)
      })
    }
  })
}
const eggOpens = (rn: RN): Promise<Array<{ m: string; req: string; at: number }>> => rn.main(() => [...((globalThis as any).__eggOpens ?? [])])

const eggTabs = (s: { tabs: Array<{ url: string }> }) => s.tabs.filter((t) => isEggUrl(t.url))

/** What one egg document looks like and carries; images are scrolled into view so the lazy ones load. */
interface EggReport {
  dataSkin: string | undefined
  incognito: string | undefined
  title: string
  h1: string
  sheets: string[]
  sig: string
  bridge: string
  images: Array<{ src: string; ok: boolean; w: number }>
  credits: Array<{ id: string; file: boolean; license: boolean; author: boolean; changes: boolean }>
  photoCreditLinks: number
  sources: Array<{ id: string; ok: boolean }>
  disclaimer: string
  animated: string[]
  animations: number
  foreignResources: string[]
  footerBack: boolean
}
const REPORT_JS = `(async () => {
  const imgs = [...document.images];
  for (const i of imgs) {
    i.scrollIntoView({ block: 'center' });
    await new Promise((r) => { if (i.complete && i.naturalWidth) return r(); i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 5000) });
  }
  window.scrollTo(0, 0);
  const cs = (sel) => { const e = document.querySelector(sel); if (!e) return 'missing'; const s = getComputedStyle(e); return [s.fontFamily, s.fontSize, s.color, s.backgroundColor, s.backgroundImage].join('|') };
  const animated = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) }).map((e) => e.tagName + '.' + e.className).slice(0, 10);
  const credits = [...document.querySelectorAll('li[id^="credit-"]')].map((li) => ({ id: li.id,
    file: !!li.querySelector('a[href^="https://commons.wikimedia.org/wiki/File:"][target="_blank"]'),
    license: [...li.querySelectorAll('a[href^="https://creativecommons.org/licenses/"]')].some((a) => /CC BY(-SA)? \\d\\.\\d/.test(a.textContent)),
    author: / by \\S/.test(li.textContent), changes: /metadata removed by RetroNet\\./.test(li.textContent) }));
  const sources = [...document.querySelectorAll('li[id^="src-"]')].map((li) => { const as = [...li.querySelectorAll('a[href]')];
    return { id: li.id, ok: as.length > 0 && as.every((a) => /^https?:\\/\\//.test(a.href) && a.target === '_blank' && a.relList.contains('noopener') && a.relList.contains('noreferrer') && a.textContent.trim().length > 3) } });
  return { dataSkin: document.documentElement.dataset.skin, incognito: document.documentElement.dataset.incognito, title: document.title,
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : '',
    sheets: [...document.styleSheets].map((s) => s.href || 'inline'),
    sig: [cs('body'), cs('main'), cs('h1'), cs('h2'), cs('a[href^="https:"]'), cs('figcaption')].join(' / '),
    bridge: typeof window.retronet,
    images: imgs.map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })),
    credits, photoCreditLinks: document.querySelectorAll('figcaption a[href^="#credit-"]').length, sources,
    disclaimer: (document.querySelector('.rn-egg__disclaimer') || {}).textContent || '',
    animated, animations: document.getAnimations().length,
    foreignResources: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !n.startsWith('retronet://')),
    footerBack: !!document.querySelector('a[href="retronet://newtab/"]') }
})()`

/** Typed navigation to an egg in the active tab; returns the tab's webContents id once the document is complete. */
async function openEggTyped(rn: RN, slug: EggHost, windowId?: number): Promise<number> {
  await rn.navigate(eggUrl(slug), { windowId })
  const id = await rn.activeTabWcId(windowId)
  await poll(() => rn.js<boolean>(id, `location.href === ${JSON.stringify(eggUrl(slug))} && document.readyState === 'complete'`), `${slug} loaded`)
  return id
}

/** Center of an element in a webContents (CSS px), once it has a box. */
function center(rn: RN, wcId: number, selector: string): Promise<{ x: number; y: number }> {
  return poll(
    () =>
      rn.js<{ x: number; y: number } | null>(
        wcId,
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })()`
      ),
    `box of ${selector}`
  )
}

/** Real pointer input into a webContents: one mouseMove, then `counts` down/up pairs with those clickCounts. */
async function clicks(rn: RN, wcId: number, p: { x: number; y: number }, counts: number[], gapMs = 0): Promise<void> {
  await rn.main(async ({ webContents }, a: { id: number; x: number; y: number; counts: number[]; gap: number }) => {
    const wc = webContents.fromId(a.id)!
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y })
    for (const c of a.counts) {
      wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: c })
      wc.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: 'left', clickCount: c })
      if (a.gap) await new Promise((r) => setTimeout(r, a.gap))
    }
  }, { id: wcId, x: Math.round(p.x), y: Math.round(p.y), counts, gap: gapMs })
}
const moveTo = (rn: RN, wcId: number, p: { x: number; y: number }): Promise<void> =>
  rn.main(({ webContents }, a: { id: number; x: number; y: number }) => {
    const wc = webContents.fromId(a.id)!
    wc.sendInputEvent({ type: 'mouseMove', x: a.x - 2, y: a.y })
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y })
  }, { id: wcId, x: Math.round(p.x), y: Math.round(p.y) })

/** The throbber well's center, after checking eggs.css made it hit-testable in this skin. */
async function well(rn: RN, w: WinInfo): Promise<{ x: number; y: number }> {
  const p = await center(rn, w.shellId, '.rn-throbber-well')
  const hit = await rn.js<boolean>(w.shellId, `!!document.elementFromPoint(${p.x}, ${p.y})?.closest('.rn-throbber-well')`)
  expect(hit, 'the throbber well receives the pointer').toBe(true)
  return p
}
const throbberState = (rn: RN, w: WinInfo): Promise<string | null> => rn.js(w.shellId, `document.querySelector('.rn-throbber')?.getAttribute('data-state') ?? null`)
const statusNote = (rn: RN, w: WinInfo): Promise<string | null> => rn.js(w.shellId, `document.querySelector('.rn-statusbar__text')?.getAttribute('data-egg-note') ?? null`)
const liveText = (rn: RN, w: WinInfo): Promise<string> => rn.js(w.shellId, `[...document.querySelectorAll('body > .rn-sr-only[role="status"]')].map((e) => e.textContent).join('|')`)

/** Active tab = a web page on the fixture server, idle (so the gestures may fire and an egg opens in a new tab). */
async function onWebPage(rn: RN, server: FixtureServer, w: WinInfo, tag: string): Promise<void> {
  await rn.navigate(`${server.base}/title?t=${tag}`, { windowId: w.id })
  await poll(async () => (await throbberState(rn, w)) === 'idle', 'throbber idle')
}

/** Composite screenshot of the whole window (shell + visible views), as in menus.spec; saved as f2-<name>.png. */
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
          const al = px[si + 3]! / 255
          if (al === 0) continue
          for (let c = 0; c < 3; c++) out[di + c] = Math.round(px[si + c]! * al + out[di + c]! * (1 - al))
          out[di + 3] = 255
        }
      }
    }
    return nativeImage.createFromBitmap(out, { width: W, height: H, scaleFactor: s }).toPNG().toString('base64')
  }, w.shellId)
  mkdirSync(SCREENS, { recursive: true })
  writeFileSync(join(SCREENS, `f2-${name}.png`), Buffer.from(b64, 'base64'))
}

async function closeQuietly(rn: RN): Promise<void> {
  await rn.quit().catch(() => rn.kill())
  rmSync(rn.userData, { recursive: true, force: true })
  rmSync(rn.downloadsDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- AC68

test('AC68: each egg renders in its own era under all four active skins, with photos, sources and credits, no CSP/console errors and no motion', async ({ rn }) => {
  test.setTimeout(240_000)
  const tab = await rn.activeTabWcId()
  await watchConsole(rn, tab)
  const sigs: Record<string, Record<string, string>> = {}
  for (const active of SKIN_IDS) {
    await setSkin(rn, active)
    for (const slug of EGG_HOSTS) {
      const era = ERA_OF[slug]
      await clearConsole(rn, tab)
      expect(await openEggTyped(rn, slug), 'the same tab webContents').toBe(tab)
      const r = await rn.js<EggReport>(tab, REPORT_JS)
      const what = `${slug} under ${active}`
      expect(r.dataSkin, `${what}: static era`).toBe(era)
      expect(r.incognito).toBe('false')
      expect(r.sheets.filter((h) => /\/skins\//.test(h)), `${what}: only its era's page skin`).toEqual([`retronet://${slug}/skins/${era}/pages.css`])
      expect(r.title).toBe(`${EGG_PAGES[era].title} - RetroNet`)
      expect(r.h1.replace(/\s+/g, ' ')).toBe(EGG_PAGES[era].title)
      expect(r.bridge, `${what}: no bridge`).toBe('undefined')
      expect(r.images.map((i) => i.src).filter((src) => src.startsWith('img/eggs/')), `${what}: its two photos`).toEqual([`img/eggs/${slug}-1.jpg`, `img/eggs/${slug}-2.jpg`])
      expect(r.images.filter((i) => !i.ok), `${what}: photos load`).toEqual([])
      expect(r.credits, `${what}: credit per photo`).toHaveLength(2)
      for (const c of r.credits) expect(c, `${what}: ${c.id} has file page, author, CC license link and changes`).toEqual({ id: c.id, file: true, license: true, author: true, changes: true })
      expect(r.photoCreditLinks, `${what}: figcaption "Full credit" links`).toBe(2)
      expect(r.sources.length, `${what}: sources`).toBeGreaterThanOrEqual(5)
      expect(r.sources.filter((s) => !s.ok), `${what}: every source link is titled, https and target=_blank noopener noreferrer`).toEqual([])
      expect(r.disclaimer).toContain('have not endorsed it')
      expect(r.footerBack).toBe(true)
      expect(r.animated, `${what}: no animation or transition anywhere (E-2)`).toEqual([])
      expect(r.animations).toBe(0)
      expect(r.foreignResources, `${what}: every subresource is the egg's own`).toEqual([])
      expect(await consoleOf(rn, tab), `${what}: no CSP or console errors`).toEqual([])
      ;(sigs[slug] ??= {})[active] = r.sig
    }
  }
  // The era look is the same whatever the active skin, and the four eras differ from each other.
  for (const slug of EGG_HOSTS) expect(new Set(Object.values(sigs[slug]!)).size, `${slug}: identical in every active skin`).toBe(1)
  expect(new Set(EGG_HOSTS.map((s) => sigs[s]!.y1994)).size, 'four distinct era looks').toBe(4)

  // A live skin switch while an egg is open does not restyle it (no bridge, no skin events).
  await openEggTyped(rn, 'wikiwiki')
  for (const s of ['y1994', 'y1999'] as const) {
    await setSkin(rn, s)
    await settle(300, 'a skin event would restyle the egg')
    expect(await rn.js(tab, `document.documentElement.dataset.skin`)).toBe('y2001')
  }

  // Reduced motion on (app setting): still nothing animates.
  const st = await settingsWc(rn)
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await openEggTyped(rn, 'cascade')
  const rm = await rn.js<EggReport>(tab, REPORT_JS)
  expect(rm.animated).toEqual([])
  expect(rm.animations).toBe(0)
})

// ---------------------------------------------------------------- AC69

test('AC69: eggs have no bridge, refuse every IPC, and web pages cannot reach them (link, location, window.open, iframe, img, fetch, redirect)', async ({ rn, server }) => {
  const egg = await openEggTyped(rn, 'clamshell')
  expect(await rn.js(egg, `({ r: typeof window.retronet, p: typeof window.process, q: typeof window.require })`)).toEqual({ r: 'undefined', p: 'undefined', q: 'undefined' })
  for (const [m, req] of [['eggs.open', { era: 'y1999' }], ['eggs.openFromPage', { era: 'y1999' }], ['skin.get', {}], ['app.info', {}], ['tabs.create', {}], ['settings.get', {}]] as const) {
    expect(await rn.forge(egg, m, req), `forged ${m} from an egg`).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  }

  await rn.navigate(`${server.base}/a`)
  const web = await rn.activeTabWcId()
  const n = (await rn.snap()).tabs.length
  const sub = await rn.js<{ fetch: string; img: string }>(
    web,
    `(async () => {
      const f = document.createElement('iframe'); f.src = 'retronet://firstweb/'; document.body.append(f);
      const fetchR = await fetch('retronet://cascade/').then(() => 'loaded', () => 'blocked');
      const imgR = await new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'retronet://cascade/img/eggs/cascade-1.jpg' });
      await new Promise((r) => setTimeout(r, 500));
      return { fetch: fetchR, img: imgR } })()`
  )
  expect(sub).toEqual({ fetch: 'blocked', img: 'blocked' })
  const frames = await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.mainFrame.framesInSubtree.map((f) => f.url), web)
  expect(frames.filter((u) => u.startsWith('retronet:'))).toEqual([])

  await rn.js(web, `(() => { const a = document.createElement('a'); a.href = 'retronet://wikiwiki/'; a.textContent = 'x'; document.body.append(a); a.click(); return true })()`)
  await rn.js(web, `(() => { const a = document.createElement('a'); a.href = 'retronet://cascade/'; a.target = '_blank'; a.textContent = 'y'; document.body.append(a); a.click(); return true })()`)
  await rn.js(web, `window.open('retronet://firstweb/'); true`)
  await rn.js(web, `location.href = 'retronet://clamshell/'; true`).catch(() => undefined)
  await settle(1000, 'egg links from a web page must not open anything')
  let s = await rn.snap()
  expect(eggTabs(s).map((t) => t.url), 'only the typed egg tab exists').toEqual([])
  expect(s.tabs.length).toBe(n)
  expect(await rn.js<string>(web, 'location.href')).toBe(`${server.base}/a`)

  // A server redirect to an egg is refused too.
  await rn.shell('tabs.navigate', { input: `${server.base}/redirect?to=${encodeURIComponent('retronet://firstweb/')}` })
  await settle(1500, 'a redirect to an egg would commit')
  s = await rn.snap()
  expect(eggTabs(s)).toEqual([])
})

test('AC69: eggs never enter history or suggestions (even bookmarked), the palette or the shortcuts page; bookmarkable; restored with the session', async () => {
  test.setTimeout(120_000)
  let rn = await launchApp()
  const userData = rn.userData
  try {
    const w = await rn.win()
    for (const slug of EGG_HOSTS) {
      await rn.shell('tabs.create', { url: 'retronet://newtab/' })
      await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://newtab') && !rn.active(s).loading, 'new tab')
      await openEggTyped(rn, slug)
      if (slug === 'cascade' || slug === 'wikiwiki') expect(await rn.shell('bookmarks.toggleCurrent', {}), `bookmark ${slug}`).toEqual({ bookmarked: true })
    }
    // Bookmarked: the star shows it and the bookmarks page lists it.
    await rn.shell('tabs.create', { url: 'retronet://bookmarks/', background: true })
    const bm = await poll(async () => (await rn.wcIdsByUrl(/^retronet:\/\/bookmarks\//))[0], 'bookmarks tab')
    await poll(() => rn.js<boolean>(bm, `typeof window.retronet === 'object'`), 'bookmarks bridge')
    const tree = JSON.stringify((await rn.bridge(bm, 'bookmarks.tree', {})).data)
    expect(tree).toContain('retronet://cascade/')
    expect(tree).toContain('retronet://wikiwiki/')

    // Suggestions: by slug, URL, title words; bookmarked ones too. Only the y2001 hint row may name an egg.
    const anchor = { x: 100, y: 40, width: 400, height: 24 }
    for (const skin of SKIN_IDS) {
      await setSkin(rn, skin)
      for (const text of ['firstweb', 'cascade', 'clamshell', 'wikiwiki', 'retronet://cas', 'retronet://wikiwiki/', 'Comets', 'Wiki', 'wiki wiki wiki', 'Quick', 'Where the Web']) {
        const r = await rn.shell<{ items: Array<{ url: string; title: string }> }>('omnibox.suggest', { text, anchor })
        expect(r.items.filter((i) => isEggUrl(i.url)), `suggest "${text}" in ${skin}`).toEqual([])
      }
      const hint = await rn.shell<{ items: Array<{ url: string; title: string; kind: string }> }>('omnibox.suggest', { text: '  Wiki   WIKI ', anchor })
      const quick = await rn.shell<{ items: Array<{ url: string; title: string; kind: string }> }>('omnibox.suggest', { text: 'quick quick', anchor })
      for (const r of [hint, quick]) {
        const eggRows = r.items.filter((i) => isEggUrl(i.url))
        if (skin === 'y2001') {
          expect(r.items[0], 'the y2001 hint row leads').toEqual({ kind: 'url', title: 'Quick, quick!', url: 'retronet://wikiwiki/' })
          expect(eggRows).toHaveLength(1)
        } else expect(eggRows, `no hint row in ${skin}`).toEqual([])
      }
    }
    await rn.shell('omnibox.dismiss', {})

    // Palette commands and the shortcuts page name no egg.
    await rn.shell('tabs.create', { url: 'retronet://newtab/' })
    await rn.waitSnap((x) => rn.active(x).url.startsWith('retronet://newtab') && !rn.active(x).loading, 'new tab for shortcuts')
    const sc = await rn.openInternal('shortcuts')
    const cmds = JSON.stringify((await rn.bridge(sc, 'commands.list', {})).data)
    const text = await rn.js<string>(sc, `document.body.innerText`)
    for (const slug of EGG_HOSTS) {
      expect(cmds).not.toContain(slug)
      expect(text).not.toContain(slug)
    }
    for (const skin of SKIN_IDS) expect(cmds).not.toContain(EGG_PAGES[skin].title)

    // History: the store and the history page hold none.
    const prof = join(userData, 'Profiles', 'default')
    const histFile = join(prof, 'history.json')
    const hist = (() => {
      try {
        return readFileSync(histFile, 'utf8')
      } catch {
        return ''
      }
    })()
    for (const slug of EGG_HOSTS) expect(hist).not.toContain(slug)
    const hp = await rn.openInternal('history')
    const hq = JSON.stringify((await rn.bridge(hp, 'history.query', { text: '', limit: 100 })).data ?? (await rn.bridge(hp, 'history.query', {})).data)
    for (const slug of EGG_HOSTS) expect(hq).not.toContain(slug)
    void w
    const lastTabs = (j: any) => JSON.stringify(j.windows.map((x: any) => x.tabs.map((t: any) => t.url)))
    await rn.flush(join(prof, 'session.json'), (j) => EGG_HOSTS.every((slug) => lastTabs(j).includes(eggUrl(slug))), 'session lists every egg tab')

    // Restore: quit and relaunch with the same profile; every egg tab comes back in its era, still bridge-less.
    await rn.quit()
    rn = await launchApp({ userData })
    const s = await rn.waitSnap((x) => EGG_HOSTS.every((slug) => x.tabs.some((t) => t.url === eggUrl(slug))), 'egg tabs restored', { timeout: 20_000 })
    expect(eggTabs(s).map((t) => t.url).sort()).toEqual(EGG_HOSTS.map(eggUrl).sort())
    for (const slug of EGG_HOSTS) {
      const t = s.tabs.find((x) => x.url === eggUrl(slug))!
      await rn.shell('tabs.activate', { tabId: t.id })
      await rn.waitSnap((x) => x.activeTabId === t.id && !rn.active(x).loading, `${slug} active`)
      const id = await rn.activeTabWcId()
      await poll(() => rn.js<boolean>(id, `location.href === ${JSON.stringify(eggUrl(slug))} && document.readyState === 'complete'`), `${slug} restored`)
      expect(await rn.js(id, `({ skin: document.documentElement.dataset.skin, bridge: typeof window.retronet })`)).toEqual({ skin: ERA_OF[slug], bridge: 'undefined' })
    }
  } finally {
    await closeQuietly(rn)
  }
})

test('DESIGN-EGGS §1 open question: a target=_blank source link on an egg opens a normal foreground tab with no opener', async ({ rn, server }) => {
  const egg = await openEggTyped(rn, 'cascade')
  const eggTab = (await rn.snap()).activeTabId
  const n = (await rn.snap()).tabs.length
  // Keep the egg's own anchor (target=_blank rel="noopener noreferrer") but point it at the loopback server.
  const dest = `${server.base}/title?t=FromEgg`
  const p = await rn.js<{ x: number; y: number; rel: string; target: string; hit: boolean }>(
    egg,
    `(() => { const a = document.querySelector('li[id^="src-"] a[target="_blank"]'); a.href = ${JSON.stringify(dest)}; a.id = 'probe'; a.scrollIntoView({ block: 'center' });
      const r = a.getClientRects()[0]; const x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2;
      return { x, y, rel: a.rel, target: a.target, hit: document.elementFromPoint(x, y)?.closest('a') === a } })()`
  )
  expect(p.hit, 'the pointer lands on the link').toBe(true)
  expect(p.target).toBe('_blank')
  expect(p.rel).toBe('noopener noreferrer')
  await clicks(rn, egg, p, [1])
  const s = await rn.waitSnap((x) => x.tabs.length === n + 1 && rn.active(x).url === dest && !rn.active(x).loading, 'source link opened in a new tab')
  expect(s.activeTabId).not.toBe(eggTab)
  expect(s.tabs.find((t) => t.id === eggTab)!.url, 'the egg stays put').toBe(eggUrl('cascade'))
  const nt = await rn.activeTabWcId()
  expect(nt).not.toBe(egg)
  expect(await rn.js(nt, `({ opener: window.opener === null, referrer: document.referrer, bridge: typeof window.retronet })`)).toEqual({ opener: true, referrer: '', bridge: 'undefined' })
  expect((await rn.windows()).filter((w) => w.popup)).toEqual([])
  const req = server.requests.filter((r) => r.path.startsWith('/title?t=FromEgg'))
  expect(req).toHaveLength(1)
})

// ---------------------------------------------------------------- AC70: shell gestures

test('AC70 y1994: triple-click the globe → note then firstweb; single clicks do nothing; 2 s cooldown; inert while loading', async ({ rn, server }) => {
  await countEggOpens(rn)
  await setSkin(rn, 'y1994')
  const w = await rn.win()
  await onWebPage(rn, server, w, 'G94')
  const page = (await rn.snap()).activeTabId
  const p = await well(rn, w)

  // Existing behaviour: a single or double click on the well does nothing.
  await clicks(rn, w.shellId, p, [1])
  await clicks(rn, w.shellId, p, [1, 2])
  await settle(900, 'a single/double click would open or note')
  expect(await statusNote(rn, w)).toBeNull()
  expect(await eggOpens(rn)).toEqual([])
  expect((await rn.snap()).activeTabId).toBe(page)

  // Inert while loading: a triple-click during a slow load does nothing.
  await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=4000` })
  await poll(async () => (await throbberState(rn, w)) !== 'idle', 'throbber busy')
  await clicks(rn, w.shellId, p, [1, 2, 3])
  await settle(1000, 'a gesture during a load would note or open')
  expect(await statusNote(rn, w)).toBeNull()
  expect(await eggOpens(rn)).toEqual([])
  await poll(async () => (await throbberState(rn, w)) === 'idle', 'slow page loaded', 15_000)

  await clicks(rn, w.shellId, p, [1, 2, 3])
  expect(await poll(() => statusNote(rn, w), 'note')).toBe('This machine is a server. DO NOT POWER IT DOWN!!')
  expect(await liveText(rn, w)).toContain('DO NOT POWER IT DOWN')
  const [first] = await poll(async () => {
    const o = await eggOpens(rn)
    return o.length ? o : null
  }, 'eggs.open')
  expect(first).toMatchObject({ m: 'eggs.open', req: '{"era":"y1994"}' })
  let s = await rn.waitSnap((x) => rn.active(x).url === eggUrl('firstweb') && !rn.active(x).loading, 'firstweb active')
  expect(s.tabs.find((t) => t.id === page)!.url, 'opened in a new tab, the page stays').toBe(`${server.base}/slow?ms=4000`)

  // Cooldown: a second triple-click within 2 s of the open does nothing.
  await poll(async () => (await throbberState(rn, w)) === 'idle', 'egg idle')
  await clicks(rn, w.shellId, p, [1, 2, 3])
  await settle(Math.max(0, first!.at + 1700 - Date.now()), 'within the cooldown')
  expect(await eggOpens(rn), 'cooldown').toHaveLength(1)
  await sleep(Math.max(0, first!.at + 2300 - Date.now()))
  await clicks(rn, w.shellId, p, [1, 2, 3])
  await poll(async () => (await eggOpens(rn)).length === 2, 'second open after the cooldown')
  await settle(500, 'a reused egg tab')
  s = await rn.snap()
  expect(eggTabs(s).map((t) => t.url), 'the open egg tab is reused').toEqual([eggUrl('firstweb')])
  // The note goes away after 4 s.
  await poll(async () => (await statusNote(rn, w)) === null, 'note cleared', 6000)
})

test('AC70 y1997: five clicks within 3 s → comet + note, then cascade; reduced motion: no comet, faster open', async ({ rn, server }) => {
  await countEggOpens(rn)
  await setSkin(rn, 'y1997')
  const w = await rn.win()
  await onWebPage(rn, server, w, 'G97')
  const p = await well(rn, w)
  await rn.js(w.shellId, `(() => { window.__comet = 0; new MutationObserver(() => { if (document.querySelector('.rn-throbber-well')?.dataset.egg === 'comet') window.__comet++ }).observe(document.querySelector('.rn-throbber-well'), { attributes: true, attributeFilter: ['data-egg'] }); return true })()`)

  // Four clicks: nothing. Clicks spread over more than 3 s: nothing.
  await clicks(rn, w.shellId, p, [1, 1, 1, 1], 120)
  await settle(3200, 'four clicks, then the 3 s window passes')
  await clicks(rn, w.shellId, p, [1], 0)
  await settle(600, 'a fifth click after the window resets the count')
  expect(await statusNote(rn, w)).toBeNull()
  expect(await eggOpens(rn)).toEqual([])
  expect(await rn.js(w.shellId, 'window.__comet')).toBe(0)

  await settle(3100, 'reset window')
  await clicks(rn, w.shellId, p, [1, 1, 1, 1, 1], 120)
  expect(await poll(() => statusNote(rn, w), 'note')).toBe('A comet streaks by… retronet://cascade/')
  await poll(() => rn.js<number>(w.shellId, 'window.__comet'), 'comet streak on the well')
  const opens = await poll(async () => {
    const o = await eggOpens(rn)
    return o.length ? o : null
  }, 'eggs.open')
  expect(opens[0]).toMatchObject({ m: 'eggs.open', req: '{"era":"y1997"}' })
  await rn.waitSnap((x) => rn.active(x).url === eggUrl('cascade') && !rn.active(x).loading, 'cascade active')
  await poll(() => rn.js<boolean>(w.shellId, `!document.querySelector('.rn-throbber-well').dataset.egg`), 'comet ends')

  // Reduced motion (app setting): no comet at all; the note still shows and the open is quicker.
  const st = await settingsWc(rn)
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await poll(() => rn.js<boolean>(w.shellId, `document.documentElement.dataset.reducedMotion === 'true'`), 'shell reduced motion')
  await onWebPage(rn, server, w, 'G97b')
  await sleep(Math.max(0, opens[0]!.at + 2200 - Date.now()))
  await rn.js(w.shellId, '(window.__comet = 0, true)')
  const t0 = Date.now()
  await clicks(rn, w.shellId, p, [1, 1, 1, 1, 1], 60)
  expect(await poll(() => statusNote(rn, w), 'note (reduced)')).toBe('A comet streaks by… retronet://cascade/')
  const o2 = await poll(async () => {
    const o = await eggOpens(rn)
    return o.length === 2 ? o : null
  }, 'second eggs.open')
  expect(o2[1]!.at - t0, 'reduced-motion open after ~300 ms, not 900 ms').toBeLessThan(850)
  await rn.waitSnap((x) => rn.active(x).url === eggUrl('cascade'), 'cascade active again')
  expect(await rn.js(w.shellId, 'window.__comet'), 'no comet with reduced motion').toBe(0)
})

test('AC70 y1999: rest the mouse on the pod 1.5 s → note; a click while it shows opens clamshell; a click without it does nothing', async ({ rn, server }) => {
  await countEggOpens(rn)
  await setSkin(rn, 'y1999')
  const w = await rn.win()
  await onWebPage(rn, server, w, 'G99')
  const p = await well(rn, w)
  const away = { x: p.x + 200, y: p.y + 30 }

  // A click without the note does nothing; leaving before 1.5 s cancels the note.
  await clicks(rn, w.shellId, p, [1])
  await sleep(700)
  await moveTo(rn, w.shellId, away)
  await settle(1500, 'a cancelled hover would show the note')
  expect(await statusNote(rn, w)).toBeNull()
  expect(await eggOpens(rn)).toEqual([])

  // Rest on the pod.
  await moveTo(rn, w.shellId, p)
  const t0 = Date.now()
  await settle(1000, 'note not yet before 1.5 s')
  expect(await statusNote(rn, w)).toBeNull()
  const note = await poll(() => statusNote(rn, w), 'flavors note', 4000)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
  expect(note).toBe('Flavors: Blueberry, Tangerine… and one more. Click the pod for a taste.')
  // The candy tooltip styling (DESIGN-EGGS §4) is drawn by the ::after pseudo-element.
  const after = await rn.js<{ bg: string; radius: string }>(w.shellId, `(() => { const s = getComputedStyle(document.querySelector('.rn-statusbar__text'), '::after'); return { bg: s.backgroundColor, radius: s.borderRadius } })()`)
  expect(after).toEqual({ bg: 'rgb(255, 251, 224)', radius: '8px' })
  await clicks(rn, w.shellId, p, [1])
  const o = await poll(async () => {
    const x = await eggOpens(rn)
    return x.length ? x : null
  }, 'eggs.open')
  expect(o).toHaveLength(1)
  expect(o[0]).toMatchObject({ m: 'eggs.open', req: '{"era":"y1999"}' })
  await rn.waitSnap((x) => rn.active(x).url === eggUrl('clamshell') && !rn.active(x).loading, 'clamshell active')
  expect(await statusNote(rn, w), 'the note is cleared by the open').toBeNull()
})

/** Type into the shell's omnibox the way the keyboard does: focus + select it, then one key event per character. */
async function typeOmnibox(rn: RN, w: WinInfo, text: string): Promise<void> {
  await rn.js(w.shellId, `(() => { const i = document.querySelector('.rn-omnibox__input'); i.focus(); i.select(); return true })()`)
  await rn.main(({ webContents }, a: { id: number; text: string }) => {
    const wc = webContents.fromId(a.id)!
    for (const ch of a.text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      wc.sendInputEvent({ type: 'keyDown', keyCode })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode })
    }
  }, { id: w.shellId, text })
  await poll(() => rn.js<boolean>(w.shellId, `document.querySelector('.rn-omnibox__input').value === ${JSON.stringify(text)}`), `omnibox holds "${text}"`)
}
/** One key into the shell without re-focusing it (wc.focus() on an already focused shell closes the list). */
const shellKey = (rn: RN, w: WinInfo, keyCode: 'Down' | 'Return'): Promise<void> =>
  rn.main(({ webContents }, a: { id: number; keyCode: string }) => {
    const wc = webContents.fromId(a.id)!
    wc.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode })
    if (a.keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode })
  }, { id: w.shellId, keyCode })
const hintRow = (rn: RN, w: WinInfo): Promise<{ title: string; url: string } | null> =>
  rn.js(w.overlayId, `(() => { const r = document.querySelector('.rn-suggest__item'); return r ? { title: r.querySelector('.rn-suggest__title')?.textContent ?? '', url: r.querySelector('.rn-suggest__url')?.textContent ?? '' } : null })()`)

test('AC70 y2001: "wiki wiki" shows one hint row; pointer pick and ↓+Enter open wikiwiki (not a typed nav); plain Enter still searches', async ({ rn, server }) => {
  test.setTimeout(90_000)
  await countEggOpens(rn)
  await setSkin(rn, 'y2001')
  const w = await rn.win()
  await onWebPage(rn, server, w, 'G01')
  const page = (await rn.snap()).activeTabId
  await settle(700, 'tab focus settles before typing')

  // Pointer pick (a real mousedown on the overlay row).
  await typeOmnibox(rn, w, 'wiki wiki')
  const first = await poll(async () => {
    const r = (await rn.win()).overlayKind === 'suggest' ? await hintRow(rn, w) : null
    return r?.title === 'Quick, quick!' ? r : null
  }, 'hint row')
  expect(first, 'the row shows the title and the egg URL').toEqual({ title: 'Quick, quick!', url: 'retronet://wikiwiki' })
  const row = await center(rn, w.overlayId, '.rn-suggest__item')
  await clicks(rn, w.overlayId, row, [1])
  let s = await rn.waitSnap((x) => rn.active(x).url === eggUrl('wikiwiki') && !rn.active(x).loading, 'wikiwiki active (pointer)')
  expect(s.activeTabId).not.toBe(page)
  expect(s.tabs.find((t) => t.id === page)!.url).toBe(`${server.base}/title?t=G01`)
  expect(await eggOpens(rn), 'main opens it directly, not through eggs.open').toEqual([])

  // ↓ + Enter on the row: the egg tab is reused; the page tab is not navigated (no typed navigation).
  await rn.shell('tabs.activate', { tabId: page })
  await rn.waitSnap((x) => x.activeTabId === page, 'page tab active')
  await settle(700, 'tab focus and the omnibox blur timer settle before typing')
  await typeOmnibox(rn, w, 'quick quick')
  await poll(async () => (await hintRow(rn, w))?.title === 'Quick, quick!', 'hint row (quick quick)')
  await shellKey(rn, w, 'Down')
  await poll(() => rn.js<boolean>(w.overlayId, `!!document.querySelector('.rn-suggest__item--selected')`), 'row highlighted')
  await shellKey(rn, w, 'Return')
  s = await rn.waitSnap((x) => rn.active(x).url === eggUrl('wikiwiki'), 'wikiwiki active (keyboard)')
  await settle(500, 'a typed navigation of the page tab')
  s = await rn.snap()
  expect(s.tabs.find((t) => t.id === page)!.url).toBe(`${server.base}/title?t=G01`)
  expect(eggTabs(s)).toHaveLength(1)

  // Plain Enter (no row highlighted) searches for "wiki wiki". The profile session gets a dead proxy first, so the
  // search request never leaves the machine (loopback stays direct).
  await rn.shell('tabs.activate', { tabId: page })
  await rn.waitSnap((x) => x.activeTabId === page, 'page tab active again')
  await settle(700, 'tab focus and the omnibox blur timer settle before typing')
  const tabWc = await rn.activeTabWcId()
  await rn.main(async ({ webContents }, a: { id: number; port: number }) => {
    const wc = webContents.fromId(a.id)!
    await wc.session.setProxy({ proxyRules: `127.0.0.1:${a.port}`, proxyBypassRules: '<local>' })
    ;(globalThis as any).__searchNav = []
    wc.on('did-start-navigation', (e: any) => {
      if (e.isMainFrame ?? true) (globalThis as any).__searchNav.push(e.url)
    })
  }, { id: tabWc, port: server.deadPort })
  await typeOmnibox(rn, w, 'wiki wiki')
  await poll(async () => (await hintRow(rn, w))?.title === 'Quick, quick!', 'hint row again')
  await shellKey(rn, w, 'Return')
  const navs = await poll(async () => {
    const n = await rn.main(() => [...((globalThis as any).__searchNav as string[])])
    return n.some((u) => /^https:\/\//.test(u)) ? n : null
  }, 'search navigation')
  const search = navs.find((u) => /^https:\/\//.test(u))!
  expect(search, 'the search engine query for the phrase').toMatch(/[?&](q|p|query)=wiki(\+|%20)wiki(&|$)/)
  await settle(500, 'an egg open after plain Enter')
  s = await rn.snap()
  expect(s.activeTabId).toBe(page)
  expect(eggTabs(s)).toHaveLength(1)

  // History never got the egg (pointer and keyboard picks are not typed navigations).
  const hist = join(rn.userData, 'Profiles', 'default', 'history.json')
  await rn.flush(hist, () => true, 'history flushed').catch(() => undefined)
  let text = ''
  try {
    text = readFileSync(hist, 'utf8')
  } catch {
    text = ''
  }
  expect(text).not.toContain('wikiwiki')
})

// ---------------------------------------------------------------- AC70: About hints

/** A full key press (keyDown, char, keyUp) as a keyboard sends it; buttons activate on Enter's keypress or Space's keyup. */
async function activateKey(rn: RN, wcId: number, key: 'Return' | 'Space'): Promise<void> {
  await rn.main(({ webContents }, a: { id: number; key: string }) => {
    const wc = webContents.fromId(a.id)!
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: a.key })
    wc.sendInputEvent({ type: 'char', keyCode: a.key === 'Return' ? '\r' : ' ' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: a.key })
  }, { id: wcId, key })
}

test('AC70: About shows one keyboard-accessible hint per skin that opens the current skin egg; failures show the error banner; guards', async ({ rn, server }) => {
  test.setTimeout(120_000)
  await countEggOpens(rn)
  const about = await rn.openInternal('about')
  const aboutTab = (await rn.snap()).activeTabId
  for (const skin of SKIN_IDS) {
    await setSkin(rn, skin)
    await rn.shell('tabs.activate', { tabId: aboutTab })
    await rn.waitSnap((x) => x.activeTabId === aboutTab, 'about active')
    await poll(() => rn.js<boolean>(about, `document.documentElement.dataset.skin === ${JSON.stringify(skin)}`), `about in ${skin}`)
    const vis = await rn.js<Array<{ tag: string; era: string; type: string; name: string; desc: string; h: number }>>(
      about,
      `[...document.querySelectorAll('.rn-egg-hint')].filter((b) => b.getClientRects().length > 0).map((b) => ({ tag: b.tagName, era: b.dataset.era, type: b.type, name: b.textContent.trim(),
        desc: document.getElementById(b.getAttribute('aria-describedby'))?.textContent ?? '', h: b.getBoundingClientRect().height }))`
    )
    expect(vis, `${skin}: exactly one visible hint`).toHaveLength(1)
    expect(vis[0]).toMatchObject({ tag: 'BUTTON', era: skin, type: 'button', desc: 'Opens a hidden page.' })
    expect(vis[0]!.name.length).toBeGreaterThan(10)
    expect(vis[0]!.name).not.toMatch(/firstweb|cascade|clamshell|wikiwiki/)
    expect(vis[0]!.h, '24px target').toBeGreaterThanOrEqual(24)
    // Keyboard: focus the button, then Enter (Space for one skin).
    await rn.js(about, `(document.querySelector('.rn-egg-hint[data-era="${skin}"]').focus(), true)`)
    await activateKey(rn, about, skin === 'y1999' ? 'Space' : 'Return')
    const opens = await poll(async () => {
      const o = await eggOpens(rn)
      return o.filter((x) => x.req === JSON.stringify({ era: skin })).length ? o : null
    }, `openFromPage ${skin}`)
    expect(opens.at(-1)).toMatchObject({ m: 'eggs.openFromPage', req: JSON.stringify({ era: skin }) })
    await rn.waitSnap((x) => rn.active(x).url === eggUrl(EGG_PAGES[skin].slug) && !rn.active(x).loading, `${skin} egg active`)
  }
  // Reuse: the y2001 hint again activates the same egg tab.
  await rn.shell('tabs.activate', { tabId: aboutTab })
  const before = eggTabs(await rn.snap()).length
  await rn.js(about, `(document.querySelector('.rn-egg-hint[data-era="y2001"]').click(), true)`)
  await rn.waitSnap((x) => rn.active(x).url === eggUrl('wikiwiki'), 'wikiwiki reused')
  expect(eggTabs(await rn.snap())).toHaveLength(before)

  // A failed open shows the R24-style error banner in the hint status region.
  await rn.shell('tabs.activate', { tabId: aboutTab })
  await rn.main(() => ((globalThis as any).__eggFail = true))
  await rn.js(about, `(document.querySelector('.rn-egg-hint[data-era="y2001"]').click(), true)`)
  const banner = await poll(() => rn.js<string | null>(about, `document.querySelector('.rn-egg-hints__status .rn-banner--error')?.textContent ?? null`), 'error banner')
  expect(banner).toContain("Error: couldn't open that page.")
  await rn.main(() => ((globalThis as any).__eggFail = false))

  // Guards: bad era; other pages, web pages and the overlay cannot call either method.
  expect(await rn.forge(about, 'eggs.openFromPage', { era: 'y1900' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.forge(about, 'eggs.openFromPage', { era: 'y1994', url: 'retronet://firstweb/' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.forge(about, 'eggs.open', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  const w = await rn.win()
  expect(await rn.forge(w.shellId, 'eggs.open', { era: '__proto__' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect(await rn.forge(w.overlayId, 'eggs.open', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  const st = await settingsWc(rn)
  expect(await rn.forge(st, 'eggs.openFromPage', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  await rn.navigate(`${server.base}/a`)
  const web = await rn.activeTabWcId()
  expect(await rn.forge(web, 'eggs.openFromPage', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  expect(await rn.forge(web, 'eggs.open', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
})

// ---------------------------------------------------------------- DESIGN-EGGS §8 screenshots

test('DESIGN-EGGS §8: egg and About-hint screenshots in background mode (.team/screens/f2-*)', async ({ rn }) => {
  test.setTimeout(120_000)
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 900))
  await setSkin(rn, 'y1997')
  const w = await rn.win()
  const tab = await rn.activeTabWcId()
  for (const slug of EGG_HOSTS) {
    await openEggTyped(rn, slug)
    await rn.js(tab, REPORT_JS) // loads every photo, then scrolls back to the top
    await settle(300, 'paint')
    await shot(rn, await rn.win(), `egg-${slug}`)
  }
  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(640, 900))
  await openEggTyped(rn, 'wikiwiki')
  await rn.js(tab, REPORT_JS)
  await settle(400, 'relayout at 640')
  expect(await rn.js(tab, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`), 'no horizontal scroll at 640').toBe(true)
  await shot(rn, await rn.win(), 'egg-wikiwiki-640')

  await rn.main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 900))
  const about = await rn.openInternal('about')
  for (const skin of SKIN_IDS) {
    await setSkin(rn, skin)
    await poll(() => rn.js<boolean>(about, `document.documentElement.dataset.skin === ${JSON.stringify(skin)}`), `about in ${skin}`)
    await rn.js(about, `(() => { const b = document.querySelector('.rn-egg-hint[data-era="${skin}"]'); b.scrollIntoView({ block: 'center' }); b.focus(); return true })()`)
    await settle(300, 'paint')
    await shot(rn, await rn.win(), `egg-about-hint-${skin}`)
  }
  void w
})
