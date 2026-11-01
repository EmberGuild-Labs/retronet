// AC9 (tab groups: create, name, 8+ colors, add/remove, collapse/expand, ungroup, close), AC10 (groups persist
// across restart) and AC20 (session restore of tabs, pins and groups per non-incognito window).
import { test, expect, launchApp, poll, GROUP_COLORS, mainLogErrors } from './helpers/launch'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

test('create, name, color, add/remove, collapse, ungroup and close a group', async ({ rn, server }) => {
  const mk = async (t: string) => (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=${t}`, background: true })).tabId
  const a = await mk('A')
  const b = await mk('B')
  const c = await mk('C')
  await rn.waitSnap((s) => s.tabs.length === 4 && s.tabs.every((t) => !t.loading), 'tabs loaded')

  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: a, name: 'Work', color: 'red' })
  await rn.shell('groups.addTab', { groupId, tabId: b })
  let s = await rn.snap()
  expect(s.groups).toEqual([{ id: groupId, name: 'Work', color: 'red', collapsed: false }])
  expect(s.tabs.filter((t) => t.groupId === groupId).map((t) => t.id).sort()).toEqual([a, b].sort())

  // At least 8 colors are accepted.
  expect(GROUP_COLORS.length).toBeGreaterThanOrEqual(8)
  for (const color of GROUP_COLORS) {
    await rn.shell('groups.update', { groupId, color })
    s = await rn.snap()
    expect(s.groups[0]!.color).toBe(color)
  }
  await rn.shell('groups.update', { groupId, name: 'Renamed', color: 'blue' })
  expect((await rn.snap()).groups[0]).toMatchObject({ name: 'Renamed', color: 'blue' })

  // The chip shows in the tab strip with its name.
  const w = await rn.win()
  await poll(() => rn.js<boolean>(w.shellId, `[...document.querySelectorAll('.rn-group-chip')].some((c) => c.textContent.includes('Renamed'))`), 'group chip rendered')

  // Collapse hides members (DOM) and is reflected in state; expand shows them again.
  await rn.shell('tabs.activate', { tabId: c })
  await rn.shell('groups.update', { groupId, collapsed: true })
  s = await rn.snap()
  expect(s.groups[0]!.collapsed).toBe(true)
  await poll(
    () => rn.js<boolean>(w.shellId, `(() => { const m = [...document.querySelectorAll('.rn-tab[data-group-color]')]; return m.length === 2 && m.every((e) => e.hidden || e.closest('[hidden]')) })()`),
    'collapsed members hidden'
  )
  await rn.shell('groups.update', { groupId, collapsed: false })
  await poll(
    () => rn.js<boolean>(w.shellId, `(() => { const m = [...document.querySelectorAll('.rn-tab[data-group-color]')]; return m.length === 2 && m.every((e) => !e.hidden) })()`),
    'expanded members visible'
  )

  // Remove a tab, then ungroup: tabs stay, the group goes.
  await rn.shell('groups.removeTab', { tabId: b })
  s = await rn.snap()
  expect(s.tabs.find((t) => t.id === b)!.groupId).toBeNull()
  await rn.shell('groups.ungroup', { groupId })
  s = await rn.snap()
  expect(s.groups).toEqual([])
  expect(s.tabs).toHaveLength(4)

  // Close group closes its member tabs.
  const g2 = (await rn.shell<{ groupId: string }>('groups.create', { tabId: b, name: 'Gone' })).groupId
  await rn.shell('groups.addTab', { groupId: g2, tabId: c })
  await rn.shell('groups.close', { groupId: g2 })
  s = await rn.waitSnap((s) => s.tabs.length === 2, 'group closed')
  expect(s.groups).toEqual([])
  expect(s.tabs.some((t) => t.id === b || t.id === c)).toBe(false)

  // Pinned tabs can't join a group.
  await rn.shell('tabs.pin', { tabId: a, pinned: true })
  expect(await rn.shellCall('groups.create', { tabId: a })).toMatchObject({ ok: false, code: 'E_INVALID' })
})

test('tabs, pins and groups are restored after a restart; incognito is not', async ({ server }) => {
  let rn = await launchApp()
  const userData = rn.userData
  try {
    const first = (await rn.snap()).tabs[0]!.id
    await rn.navigate(`${server.base}/title?t=Pinned`)
    await rn.shell('tabs.pin', { tabId: first, pinned: true })
    const mk = async (t: string) => (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=${t}`, background: true })).tabId
    const g1 = await mk('G1')
    const g2 = await mk('G2')
    const plain = await mk('Plain')
    await rn.waitSnap((s) => s.tabs.length === 4 && s.tabs.every((t) => !t.loading), 'tabs loaded')
    const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: g1, name: 'Work', color: 'purple' })
    await rn.shell('groups.addTab', { groupId, tabId: g2 })
    await rn.shell('tabs.activate', { tabId: plain })
    await rn.shell('groups.update', { groupId, collapsed: true })

    // A second regular window and an incognito window.
    const w2 = await rn.profiles<number>('newWindow', 'default', `${server.base}/title?t=Second`)
    await rn.waitWindowReady(w2)
    const wi = await rn.profiles<number>('newIncognitoWindow', 'default', `${server.base}/title?t=SecretIncog`)
    await rn.waitWindowReady(wi)
    await rn.flush(join(userData, 'Profiles', 'default', 'session.json'), (j) => JSON.stringify(j).includes('Second'), 'session saved with second window')
    await rn.quit()

    rn = await launchApp({ userData })
    const wins = await poll(async () => {
      const all = await rn.windows()
      return all.length === 2 && all.every((w) => w.snapshot.tabs.length > 0 && w.snapshot.tabs.every((t) => !t.loading)) ? all : null
    }, 'two restored windows', 20_000)
    expect(wins.every((w) => !w.incognito)).toBe(true)
    const main = wins.find((w) => w.snapshot.tabs.some((t) => t.title === 'Pinned'))!
    const second = wins.find((w) => w !== main)!
    expect(main.snapshot.tabs.map((t) => [t.title, t.pinned])).toEqual([
      ['Pinned', true],
      ['G1', false],
      ['G2', false],
      ['Plain', false]
    ])
    expect(main.snapshot.groups).toHaveLength(1)
    const g = main.snapshot.groups[0]!
    expect(g).toMatchObject({ name: 'Work', color: 'purple', collapsed: true })
    expect(main.snapshot.tabs.filter((t) => t.groupId === g.id).map((t) => t.title)).toEqual(['G1', 'G2'])
    expect(rn.active(main.snapshot).title).toBe('Plain')
    expect(second.snapshot.tabs.map((t) => t.title)).toEqual(['Second'])
    const urls = (await rn.main(() => (globalThis as any).__rn.webContents() as Array<{ url: string }>)).map((x) => x.url)
    expect(urls.some((u) => u.includes('SecretIncog'))).toBe(false)
    expect(mainLogErrors(rn.mainLog())).toEqual([])
  } finally {
    await rn.quit().catch(() => rn.kill())
    rmSync(userData, { recursive: true, force: true })
  }
})
