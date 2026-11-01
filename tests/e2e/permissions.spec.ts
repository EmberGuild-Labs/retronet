// AC33: camera/mic/geolocation/notifications/clipboard-read show an in-app prompt (allow/block/dismiss, optional
// remember), are reviewable/resettable per site in settings; every other permission type is denied.
import { test, expect, poll, type RN, settle } from './helpers/launch'

interface PermEvent {
  kind: string
  request?: { id: string; origin: string; host: string; kinds: string[] }
}

async function recordOverlay(rn: RN): Promise<number> {
  const w = await rn.win()
  await rn.js(w.overlayId, `(() => { window.__ov = []; window.retronet.on('overlay', (p) => window.__ov.push(p)); return true })()`)
  return w.overlayId
}

async function nextPrompt(rn: RN, overlayId: number, seen: Set<string>): Promise<NonNullable<PermEvent['request']>> {
  return poll(async () => {
    const evs = await rn.js<PermEvent[]>(overlayId, 'window.__ov')
    const p = evs.filter((e) => e.kind === 'permission' && e.request && !seen.has(e.request.id)).pop()
    if (!p) return null
    seen.add(p.request!.id)
    return p.request!
  }, 'permission prompt event')
}

test('geolocation: prompt, block + remember, listed and reset in settings', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Perm`)
  const ov = await recordOverlay(rn)
  const seen = new Set<string>()
  const ask = `(() => { window.__geo = 'pending'; navigator.geolocation.getCurrentPosition(() => { window.__geo = 'ok' }, (e) => { window.__geo = 'err:' + e.code }); return true })()`
  await rn.tabJs(ask)
  const req = await nextPrompt(rn, ov, seen)
  expect(req.origin).toBe(server.base)
  expect(req.kinds).toContain('geolocation')
  expect((await rn.win()).overlayKind).toBe('permission')

  // Nobody but the overlay can answer: not the shell (no such bridge method), not a forged call from the page.
  expect(await rn.shellCall('permissions.respond', { requestId: req.id, decision: 'allow', remember: true })).toMatchObject({ ok: false })
  const w = await rn.win()
  for (const sender of [await rn.activeTabWcId(), w.shellId]) {
    expect(await rn.forge(sender, 'permissions.respond', { requestId: req.id, decision: 'allow', remember: true })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
  }
  expect((await rn.bridge(ov, 'permissions.respond', { requestId: req.id, decision: 'block', remember: true })).ok).toBe(true)
  expect(await poll(async () => {
    const v = await rn.tabJs<string>('window.__geo')
    return v !== 'pending' ? v : null
  }, 'geolocation answered')).toBe('err:1')
  await poll(async () => (await rn.win()).overlayKind !== 'permission', 'prompt hidden')

  // Remembered: the next request is denied without a prompt.
  const before = (await rn.js<PermEvent[]>(ov, 'window.__ov')).filter((e) => e.kind === 'permission').length
  await rn.tabJs(ask)
  expect(await poll(async () => {
    const v = await rn.tabJs<string>('window.__geo')
    return v !== 'pending' ? v : null
  }, 'remembered block')).toBe('err:1')
  await settle(300, 'no extra permission prompt should appear')
  expect((await rn.js<PermEvent[]>(ov, 'window.__ov')).filter((e) => e.kind === 'permission').length).toBe(before)

  // Review + reset in settings (second tab, so the page above stays).
  await rn.shell('tabs.create', { url: 'retronet://settings/' })
  await rn.waitSnap((s) => rn.active(s).url.startsWith('retronet://settings/') && !rn.active(s).loading, 'settings tab')
  const st = await rn.activeTabWcId()
  await poll(() => rn.js<boolean>(st, `typeof window.retronet === 'object'`), 'settings bridge')
  const list = await rn.bridge<{ items: Array<{ origin: string; kind: string; decision: string }> }>(st, 'permissions.list', {})
  expect(list.data!.items).toEqual([expect.objectContaining({ origin: server.base, kind: 'geolocation', decision: 'block' })])
  expect((await rn.bridge(st, 'permissions.reset', { origin: server.base })).ok).toBe(true)
  expect((await rn.bridge<{ items: unknown[] }>(st, 'permissions.list', {})).data!.items).toEqual([])
})

test('notifications: allow once grants; dismiss leaves it unset; other permission types are denied silently', async ({ rn, server }) => {
  await rn.navigate(`${server.base}/title?t=Notify`)
  const ov = await recordOverlay(rn)
  const seen = new Set<string>()
  const ask = `(() => { window.__n = 'pending'; Notification.requestPermission().then((r) => { window.__n = r }); return true })()`
  const answer = () => poll(async () => {
    const v = await rn.tabJs<string>('window.__n')
    return v !== 'pending' ? v : null
  }, 'notification answered')

  await rn.tabJs(ask)
  let req = await nextPrompt(rn, ov, seen)
  expect(req.kinds).toContain('notifications')
  await rn.bridge(ov, 'permissions.respond', { requestId: req.id, decision: 'dismiss', remember: false })
  expect(await answer()).not.toBe('granted')

  await rn.tabJs(ask)
  req = await nextPrompt(rn, ov, seen)
  await rn.bridge(ov, 'permissions.respond', { requestId: req.id, decision: 'allow', remember: false })
  expect(await answer()).toBe('granted')

  // MIDI (sysex) is not on the prompt list: denied with no prompt.
  const count = (await rn.js<PermEvent[]>(ov, 'window.__ov')).filter((e) => e.kind === 'permission').length
  const midi = await rn.tabJs<string>(`navigator.requestMIDIAccess({ sysex: true }).then(() => 'granted', (e) => 'denied:' + e.name)`)
  expect(midi.startsWith('denied')).toBe(true)
  expect((await rn.js<PermEvent[]>(ov, 'window.__ov')).filter((e) => e.kind === 'permission').length).toBe(count)
})

test('internal pages never get or prompt for permissions', async ({ rn }) => {
  const nt = await rn.activeTabWcId()
  const ov = await recordOverlay(rn)
  const r = await rn.js<string>(nt, `Notification.requestPermission()`)
  expect(r).not.toBe('granted')
  await settle(300, 'no extra permission prompt should appear')
  expect((await rn.js<PermEvent[]>(ov, 'window.__ov')).filter((e) => e.kind === 'permission')).toEqual([])
})
