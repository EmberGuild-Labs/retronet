// AC24 (live skin switch from palette command and settings, no restart or tab reload, persisted per profile),
// AC25 (skins visibly differ), AC26 (throbber animates while loading, idle after), AC32 (reduced motion).
// AC56 (the fourth skin y1999: settings card + thumbnail, palette, View > Skin menu, incognito treatment, reduced
// motion static frame, every page renders without CSP errors or missing assets).
import { test, expect, launchApp, poll, settle, SKIN_IDS, type RN } from './helpers/launch'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

interface Look {
  skin: string | undefined
  link: string | null
  btnBg: string
  btnRadius: string
  tabFont: string
  omniFont: string
  stripBg: string
}

async function look(rn: RN, skin: string): Promise<Look> {
  const w = await rn.win()
  return poll(
    () =>
      rn.js<Look | null>(
        w.shellId,
        `(() => { const root = document.documentElement; if (root.dataset.skin !== ${JSON.stringify(skin)}) return null;
          const link = document.getElementById('rn-skin'); if (!link || link.dataset.rnSkinPending) return null;
          const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null };
          const btn = cs('.rn-toolbar [data-action="reload"]'), tab = cs('.rn-tab'), omni = cs('.rn-omnibox__input'), strip = cs('.rn-tabstrip');
          return { skin: root.dataset.skin, link: link.getAttribute('href'), btnBg: btn ? btn.backgroundImage + '|' + btn.backgroundColor : '', btnRadius: btn ? btn.borderRadius : '',
            tabFont: tab ? tab.fontFamily : '', omniFont: omni ? omni.fontFamily : '', stripBg: strip ? strip.backgroundImage + '|' + strip.backgroundColor : '' } })()`
      ),
    `skin ${skin} applied`
  )
}

test('skins switch live from the palette command and settings without reloading the tab', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Keep%20Me`)
  const tab = await rn.activeTabWcId()
  const origin0 = await rn.js<number>(tab, 'performance.timeOrigin')
  await rn.js(tab, 'window.__alive = 1')

  const looks: Record<string, Look> = {}
  for (const skin of ['y1994', 'y2001', 'y1999', 'y1997'] as const) {
    // commands.run is exactly what the palette sends.
    await rn.shell('commands.run', { id: 'skin.switch', arg: skin })
    await rn.waitSnap((s) => s.skin === skin, `snapshot skin ${skin}`)
    looks[skin] = await look(rn, skin)
    expect(looks[skin]!.link).toContain(skin)
  }
  // AC25: every pair of skins differs in toolbar buttons and tab strip; the address bar keeps a pixel font.
  const pairs = SKIN_IDS.flatMap((a, i) => SKIN_IDS.slice(i + 1).map((b) => [a, b] as const))
  expect(pairs.length).toBe(6)
  for (const [a, b] of pairs) {
    const la = looks[a]!
    const lb = looks[b]!
    expect(la.btnBg + la.btnRadius + la.stripBg + la.tabFont, `${a} vs ${b}`).not.toBe(lb.btnBg + lb.btnRadius + lb.stripBg + lb.tabFont)
  }
  for (const skin of SKIN_IDS) expect(looks[skin]!.omniFont, `${skin} omnibox font`).toMatch(/VT323|Pixelify|Silkscreen/i)
  expect(looks.y2001!.btnRadius).not.toBe(looks.y1994!.btnRadius)

  // From the settings page (in a second tab); internal pages follow live too.
  await rn.shell('tabs.create', { url: 'retronet://settings/' })
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://settings/') && !rn.active(s).loading, 'settings tab')
  const st = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(st, `typeof window.retronet === 'object'`), 'settings bridge')
  const origin1 = await rn.js<number>(st, 'performance.timeOrigin')
  expect((await rn.bridge(st, 'settings.set', { skin: 'y2001' })).ok).toBe(true)
  await rn.waitSnap((s) => s.skin === 'y2001', 'skin from settings')
  await poll(() => rn.js<boolean>(st, `document.documentElement.dataset.skin === 'y2001'`), 'settings page re-skinned')
  expect(await rn.js<number>(st, 'performance.timeOrigin')).toBe(origin1)

  // The web tab never reloaded.
  expect(await rn.js<number>(tab, 'performance.timeOrigin')).toBe(origin0)
  expect(await rn.js<number>(tab, 'window.__alive')).toBe(1)

  // Bad skin ids are rejected.
  expect(await rn.shellCall('commands.run', { id: 'skin.switch', arg: 'y2077' })).toMatchObject({ ok: false, code: 'E_INVALID' })
})

test('the skin choice persists per profile across restart', async () => {
  let rn = await launchApp()
  const ud = rn.userData
  try {
    const other = await rn.profiles<{ id: string }>('create', 'Other')
    await rn.shell('commands.run', { id: 'skin.switch', arg: 'y1994' })
    await rn.waitSnap((s) => s.skin === 'y1994', 'y1994')
    const w2 = await rn.profiles<number>('newWindow', other.id)
    await rn.waitWindowReady(w2)
    expect((await rn.snap(w2)).skin).toBe('y1997') // other profile keeps the default
    await new Promise((r) => setTimeout(r, 1000))
    await rn.quit()
    expect(JSON.parse(readFileSync(join(ud, 'Profiles', 'default', 'settings.json'), 'utf8')).skin).toBe('y1994')
    rn = await launchApp({ userData: ud })
    const wins = await poll(async () => {
      const all = await rn.windows()
      return all.length === 2 ? all : null
    }, 'both windows restored')
    expect(wins.find((w) => w.profileId === 'default')!.snapshot.skin).toBe('y1994')
    expect(wins.find((w) => w.profileId === other.id)!.snapshot.skin).toBe('y1997')
  } finally {
    await rn.quit().catch(() => rn.kill())
    // A cleanup error must not hide the test's own failure (the app may still be flushing on a slow quit).
    try {
      rmSync(ud, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      /* temp dir; left for the OS */
    }
  }
})

test('throbber animates while loading and idles after; reduced motion stops the animation', async ({ rn, server }) => {
  const w = await rn.win()
  const throbber = () =>
    rn.js<{ state: string | null; running: number; rm: string | null }>(
      w.shellId,
      // getAnimations({subtree}) includes ::before/::after (the 2001 orb animates pseudo-elements).
      `(() => { const t = document.querySelector('.rn-throbber'); return { state: t ? t.getAttribute('data-state') : null, running: t ? t.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length : -1, rm: document.documentElement.getAttribute('data-reduced-motion') } })()`
    )
  for (const skin of SKIN_IDS) {
    await rn.shell('commands.run', { id: 'skin.switch', arg: skin })
    await rn.waitSnap((s) => s.skin === skin, skin)
    await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=1500&s=${skin}` })
    const loading = await poll(async () => {
      const t = await throbber()
      return t.state === 'loading' && t.running > 0 ? t : null
    }, `${skin} throbber loading + animating`)
    expect(loading.running).toBeGreaterThan(0)
    await rn.waitSnap((s) => !rn.active(s).loading, `${skin} load done`)
    const idle = await poll(async () => {
      const t = await throbber()
      return t.state === 'idle' ? t : null
    }, `${skin} throbber idle`)
    expect(idle.running, `${skin} idle throbber is still`).toBe(0)
  }

  // Reduced motion (settings toggle): no animation while loading, static frame.
  const st = await rn.openInternal('settings')
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await rn.waitSnap((s) => s.reducedMotion, 'reducedMotion in snapshot')
  await poll(async () => (await throbber()).rm === 'true', 'data-reduced-motion on shell')
  await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=1500&rm=1` })
  const rm = await poll(async () => {
    const t = await throbber()
    return t.state === 'loading' ? t : null
  }, 'reduced-motion loading')
  await new Promise((r) => setTimeout(r, 100))
  expect((await throbber()).running, 'no throbber animation under reduced motion').toBe(0)
  await rn.waitSnap((s) => !rn.active(s).loading, 'rm load done')
})

// ---------------- AC56: the fourth skin (y1999) ----------------

test('y1999 is offered everywhere: settings card with its thumbnail, palette, View > Skin menu', async ({ rn }) => {
  // Settings card + thumbnail (the image must really load, no 404).
  const st = await rn.openInternal('settings')
  const card = await poll(
    () =>
      rn.js<{ name: string; src: string; w: number; complete: boolean } | null>(
        st,
        `(() => { const i = document.querySelector('input[type="radio"][value="y1999"]'); const c = i && i.closest('.rn-radio-card'); const img = c && c.querySelector('img');
          return img && img.complete && img.naturalWidth > 0 ? { name: c.querySelector('.rn-radio-card__name').textContent.trim(), src: img.getAttribute('src'), w: img.naturalWidth, complete: img.complete } : null })()`
      ),
    'y1999 settings card with a loaded thumbnail'
  )
  expect(card.name).toBe('1999 Gumdrop')
  expect(card.src).toContain('skin-y1999')
  expect(await rn.js<number>(st, `document.querySelectorAll('.rn-radio-cards input[type="radio"]').length`)).toBe(SKIN_IDS.length)

  // Palette: one "Switch skin" row per skin, y1999 included.
  await rn.press('P', ['meta', 'shift'], 'shell')
  const w = await poll(async () => {
    const x = await rn.win()
    return x.overlayKind === 'palette' ? x : null
  }, 'palette overlay')
  const items = await poll(
    () => rn.js<string[] | null>(w.overlayId, `(() => { const els = [...document.querySelectorAll('.rn-palette__item')]; return els.length ? els.map((e) => e.textContent || '') : null })()`),
    'palette items'
  )
  expect(items.some((t) => t.includes('1999 Gumdrop')), 'palette lists the y1999 skin').toBe(true)
  await rn.press('Escape', [], 'overlay')
  await poll(async () => (await rn.win()).overlayKind !== 'palette', 'palette closed')

  // View > Skin menu item: present, and clicking it switches live.
  const item = await rn.main(({ Menu }) => {
    const m = Menu.getApplicationMenu()?.getMenuItemById('skin.switch:y1999')
    return m ? { label: m.label, type: m.type } : null
  })
  expect(item).toMatchObject({ label: '1999 Gumdrop' })
  await rn.main(({ Menu, BrowserWindow }) => {
    Menu.getApplicationMenu()!.getMenuItemById('skin.switch:y1999')!.click(undefined, BrowserWindow.getAllWindows()[0])
  })
  await rn.waitSnap((s) => s.skin === 'y1999', 'menu switched to y1999')
  await poll(() => rn.js<boolean>(st, `document.documentElement.dataset.skin === 'y1999'`), 'settings page follows y1999')
})

test('y1999: incognito treatment, reduced-motion static throbber frame', async ({ rn, server }) => {
  await rn.shell('commands.run', { id: 'skin.switch', arg: 'y1999' })
  await rn.waitSnap((s) => s.skin === 'y1999', 'y1999')
  const w = await rn.win()
  const toolbarLook = (shellId: number) =>
    rn.js<{ skin: string | undefined; incognito: string | null; strip: string; throbber: string }>(
      shellId,
      `(() => { const r = document.documentElement; const s = getComputedStyle(document.querySelector('.rn-tabstrip')); const t = getComputedStyle(document.querySelector('.rn-throbber'));
        return { skin: r.dataset.skin, incognito: r.getAttribute('data-incognito'), strip: s.backgroundImage + '|' + s.backgroundColor, throbber: t.backgroundImage } })()`
    )
  const normal = await poll(async () => {
    const l = await toolbarLook(w.shellId)
    return l.skin === 'y1999' ? l : null
  }, 'normal y1999 shell')

  // Incognito window of this profile: same skin, an obviously different strip and the incognito throbber sprite.
  const incId = await rn.profiles<number>('newIncognitoWindow')
  const inc = await rn.waitWindowReady(incId)
  expect(inc.snapshot.skin).toBe('y1999')
  const dark = await poll(async () => {
    const l = await toolbarLook(inc.shellId)
    return l.skin === 'y1999' && l.incognito === 'true' ? l : null
  }, 'incognito y1999 shell')
  expect(dark.strip).not.toBe(normal.strip)
  expect(dark.throbber).toContain('throbber-incognito')
  expect(normal.throbber).not.toContain('throbber-incognito')

  // Reduced motion: loading shows the static busy frame (12 → -384px), no running animation.
  const set = await rn.openInternal('settings')
  expect((await rn.bridge(set, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await poll(() => rn.js<boolean>(w.shellId, `document.documentElement.getAttribute('data-reduced-motion') === 'true'`), 'data-reduced-motion')
  await rn.shell('tabs.navigate', { input: `${server.base}/slow?ms=1500&y1999rm=1` })
  const t = await poll(
    () =>
      rn.js<{ state: string | null; pos: string; running: number } | null>(
        w.shellId,
        `(() => { const t = document.querySelector('.rn-throbber'); if (t.getAttribute('data-state') !== 'loading') return null; return { state: t.getAttribute('data-state'), pos: getComputedStyle(t).backgroundPosition, running: t.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length } })()`
      ),
    'y1999 reduced-motion loading'
  )
  expect(t.running).toBe(0)
  expect(t.pos).toBe('-384px 0px')
  await rn.waitSnap((s) => !rn.active(s).loading, 'rm load done')
})

test('y1999: every internal page, the shell and the overlay render with no CSP errors or missing assets', async ({ rn, server }) => {
  // Collect console output of every webContents (present and future) in main.
  await rn.main(({ app, webContents }) => {
    const g = globalThis as any
    g.__x17Console = []
    const hook = (wc: Electron.WebContents) => {
      wc.on('console-message', (e: any, level?: unknown, message?: unknown) => {
        const msg = String(e?.message ?? message ?? '')
        const lvl = String(e?.level ?? level ?? '')
        g.__x17Console.push({ url: wc.getURL(), level: lvl, message: msg.slice(0, 400) })
      })
    }
    for (const wc of webContents.getAllWebContents()) hook(wc)
    app.on('web-contents-created', (_e, wc) => hook(wc))
  })
  await rn.shell('commands.run', { id: 'skin.switch', arg: 'y1999' })
  await rn.waitSnap((s) => s.skin === 'y1999', 'y1999')
  const w = await rn.win()
  // Shell and overlay both carry the skin.
  for (const id of [w.shellId, w.overlayId]) await poll(() => rn.js<boolean>(id, `document.documentElement.dataset.skin === 'y1999'`), `wc ${id} on y1999`)

  const pages = ['newtab', 'settings', 'bookmarks', 'history', 'downloads', 'about', 'shortcuts']
  for (const host of pages) {
    const id = await rn.openInternal(host)
    const st = await poll(
      () =>
        rn.js<{ skin: string | undefined; sheets: number; fonts: string } | null>(
          id,
          `(() => { const r = document.documentElement; if (r.dataset.skin !== 'y1999' || document.readyState !== 'complete') return null;
            const sheets = [...document.styleSheets].filter((s) => (s.href || '').includes('/skins/y1999/')).length; return sheets ? { skin: r.dataset.skin, sheets, fonts: getComputedStyle(document.body).fontFamily } : null })()`
        ),
      `${host} styled with y1999`
    )
    expect(st.sheets, `${host} loads a y1999 stylesheet`).toBeGreaterThan(0)
    // Every image on the page decoded (thumbnails, logos).
    const broken = await rn.js<string[]>(id, `[...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src'))`)
    expect(broken, `${host} broken images`).toEqual([])
    await rn.js(id, `console.error('x17-probe ${host}')`)
  }
  // The two interstitials too.
  await rn.navigate(`http://127.0.0.1:${server.deadPort}/`, { expectUrl: (u) => u.includes(String(server.deadPort)) }).catch(() => undefined)
  await rn.navigate(`${server.httpsBase}/a`, { expectUrl: (u) => u.startsWith(server.httpsBase) }).catch(() => undefined)
  await settle(1000, 'late console errors from the interstitials')

  const msgs = await rn.main(() => (globalThis as any).__x17Console as Array<{ url: string; level: string; message: string }>)
  // The collector really sees page console output (else the checks below would pass vacuously).
  for (const host of pages) expect(msgs.some((m) => m.message === `x17-probe ${host}`), `console of ${host} collected`).toBe(true)
  const csp = msgs.filter((m) => /Content Security Policy|Refused to (load|apply|execute|connect)/i.test(m.message))
  expect(csp, 'no CSP violations under y1999').toEqual([])
  const missing = msgs.filter((m) => /Failed to load resource|ERR_FILE_NOT_FOUND|net::ERR_/i.test(m.message) && m.url.startsWith('retronet://'))
  expect(missing, 'no missing assets on internal pages/shell/overlay').toEqual([])
})
