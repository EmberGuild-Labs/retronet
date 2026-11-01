// AC30 (guestbook-style history page on real data, readable and searchable), AC31 (new-tab hit counter, seeded,
// incrementing per view, per profile, off in incognito; "Best viewed in RetroNet" badge links nowhere external),
// AC32 (reduced motion stops the marquee). The DOM checks drive T21's pages through stable classes/labels.
import { test, expect, poll } from './helpers/launch'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const visitorNumber = (label: string | null): number | null => {
  const m = /visitor number ([\d,]+)/.exec(label ?? '')
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

test('new-tab hit counter increments per view and is stored per profile', async ({ rn }) => {
  const nt = await rn.activeTabWcId()
  const read = () => rn.js<string | null>(nt, `document.querySelector('.rn-odometer__well')?.getAttribute('aria-label') ?? null`)
  const first = await poll(async () => visitorNumber(await read()), 'odometer shows a number')
  expect(first).toBeGreaterThan(0)

  await rn.shell('tabs.reload', {})
  const second = await poll(async () => {
    const n = visitorNumber(await read())
    return n !== null && n !== first ? n : null
  }, 'counter after reload')
  expect(second).toBe(first + 1)
  // The odometer digits roll to the same value.
  await poll(
    async () => Number(await rn.js<string>(nt, `[...document.querySelectorAll('.rn-odometer__digit')].map((d) => d.dataset.d ?? d.textContent).join('')`)) === second,
    'odometer digits show the count'
  )

  await rn.flush(join(rn.userData, 'Profiles', 'default', 'counter.json'), (j) => JSON.stringify(j).includes(String(second)), 'counter on disk')
  const disk = readFileSync(join(rn.userData, 'Profiles', 'default', 'counter.json'), 'utf8')
  expect(disk).toContain(String(second))

  // Badge: original 88x31 art, links to an internal page only.
  const badge = await rn.js<{ alt: string; w: number; h: number; href: string } | null>(
    nt,
    `(() => { const i = document.querySelector('img.rn-badge-88'); if (!i) return null; const a = i.closest('a'); return { alt: i.alt, w: i.naturalWidth || i.width, h: i.naturalHeight || i.height, href: a ? a.getAttribute('href') : '' } })()`
  )
  expect(badge).not.toBeNull()
  expect(badge!.alt).toBe('Best viewed in RetroNet')
  expect([badge!.w, badge!.h]).toEqual([88, 31])
  expect(badge!.href === '' || badge!.href.startsWith('retronet:')).toBe(true)
  // No external links anywhere on the new-tab page.
  const ext = await rn.js<string[]>(nt, `[...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h))`)
  expect(ext).toEqual([])
})

test('incognito new-tab shows no visitor count', async ({ rn }) => {
  const wi = await rn.profiles<number>('newIncognitoWindow', 'default')
  await rn.waitWindowReady(wi)
  const nt = await rn.activeTabWcId(wi)
  const label = await poll(() => rn.js<string | null>(nt, `document.querySelector('.rn-odometer__well')?.getAttribute('aria-label') ?? null`), 'incognito odometer')
  expect(visitorNumber(label)).toBeNull()
})

test('guestbook history page renders real entries and searches them', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Guest%20One`)
  await rn.navigate(`${server.base}/title?t=Guest%20Two`)
  const h = await rn.openInternal('history')
  const q = await rn.bridge<{ entries: Array<{ id: number; title: string; url: string }> }>(h, 'history.query', {})
  const two = q.data!.entries.find((e) => e.title === 'Guest Two')!
  const entries = await poll(
    () =>
      rn.js<Array<{ visitor: string; title: string; url: string }> | null>(
        h,
        `(() => { const els = [...document.querySelectorAll('.rn-guestbook-entry')]; return els.length >= 2 ? els.map((e) => ({ visitor: e.querySelector('.rn-guestbook-entry__visitor')?.textContent ?? '', title: e.querySelector('.rn-guestbook-entry__title')?.textContent ?? '', url: e.querySelector('.rn-guestbook-entry__url')?.textContent ?? '' })) : null })()`
      ),
    'guestbook entries rendered'
  )
  const e2 = entries.find((e) => e.title === 'Guest Two')
  expect(e2).toBeTruthy()
  expect(e2!.visitor).toContain(`#${two.id}`)
  expect(e2!.url).toBe(two.url)
  expect(entries.findIndex((e) => e.title === 'Guest Two')).toBeLessThan(entries.findIndex((e) => e.title === 'Guest One'))
  const time = await rn.js<string | null>(h, `document.querySelector('.rn-guestbook-entry time')?.getAttribute('datetime') ?? null`)
  expect(time && !Number.isNaN(Date.parse(time))).toBe(true)

  // Search filters the rendered entries.
  await rn.js(h, `(() => { const i = document.getElementById('rn-gb-search'); i.value = 'one'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const filtered = await poll(
    () =>
      rn.js<string[] | null>(
        h,
        `(() => { const t = [...document.querySelectorAll('.rn-guestbook-entry')].filter((e) => !e.closest('[hidden]')).map((e) => e.querySelector('.rn-guestbook-entry__title')?.textContent ?? ''); return t.length === 1 ? t : null })()`
      ),
    'search narrows to one entry'
  )
  expect(filtered).toEqual(['Guest One'])
})

test('reduced motion stops the guestbook marquee', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Marquee`)
  const h = await rn.openInternal('history')
  const running = () => rn.js<number>(h, `(() => { const m = document.querySelector('.rn-marquee'); return m ? m.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length : -1 })()`)
  await poll(async () => (await running()) > 0, 'marquee animates by default')
  await rn.shell('tabs.create', { url: 'retronet://settings/' })
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://settings/') && !rn.active(s).loading, 'settings tab')
  const st = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(st, `typeof window.retronet === 'object'`), 'settings bridge')
  expect((await rn.bridge(st, 'settings.set', { reducedMotion: true })).ok).toBe(true)
  await poll(async () => (await running()) === 0, 'marquee still under reduced motion')
})
