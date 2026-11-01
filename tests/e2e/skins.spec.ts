// AC24 (live skin switch from palette command and settings, no restart or tab reload, persisted per profile),
// AC25 (skins visibly differ), AC26 (throbber animates while loading, idle after), AC32 (reduced motion).
import { test, expect, launchApp, poll, SKIN_IDS, type RN } from './helpers/launch'
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
  for (const skin of ['y1994', 'y2001', 'y1997'] as const) {
    // commands.run is exactly what the palette sends.
    await rn.shell('commands.run', { id: 'skin.switch', arg: skin })
    await rn.waitSnap((s) => s.skin === skin, `snapshot skin ${skin}`)
    looks[skin] = await look(rn, skin)
    expect(looks[skin]!.link).toContain(skin)
  }
  // AC25: every pair of skins differs in toolbar buttons and tab strip; the address bar keeps a pixel font.
  for (const [a, b] of [['y1994', 'y1997'], ['y1997', 'y2001'], ['y1994', 'y2001']] as const) {
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
    rmSync(ud, { recursive: true, force: true })
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
