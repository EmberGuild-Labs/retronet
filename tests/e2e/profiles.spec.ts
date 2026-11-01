// AC11 (profiles: create, rename, delete, switch; isolated session partitions), AC12 (own windows, two open at
// once, last-used restored, delete removes data from disk).
import { test, expect, launchApp, poll, mainLogErrors } from './helpers/launch'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('a cookie set in profile A is absent in profile B; both windows open at once', async ({ rn, server }) => {
  const B = await rn.profiles<{ id: string; name: string }>('create', 'Work')
  expect(B.name).toBe('Work')

  await rn.navigate(`${server.base}/set?v=A`)
  const wB = await rn.profiles<number>('newWindow', B.id, `${server.base}/echo?tag=B1`)
  await poll(() => 'B1' in server.seen, 'B echo')
  expect(server.seen.B1).toBe('')
  const wins = await rn.windows()
  expect(wins.map((w) => w.profileId).sort()).toEqual(['default', B.id].sort())
  expect((await rn.snap(wB)).profileName).toBe('Work')

  // Another window of A shares A's cookie; localStorage is per profile too.
  const wA2 = await rn.profiles<number>('newWindow', 'default', `${server.base}/echo?tag=A2`)
  await poll(() => 'A2' in server.seen, 'A2 echo')
  expect(server.seen.A2).toBe('who=A')
  await rn.waitWindowReady(wA2)
  await rn.waitWindowReady(wB)
  expect(await rn.tabJs(`localStorage.getItem('ls')`, wA2)).toBe('A')
  expect(await rn.tabJs(`localStorage.getItem('ls')`, wB)).toBeNull()

  // B's history and bookmarks don't see A's.
  const hB = await rn.openInternal('history', wB)
  const hist = await rn.bridge<{ entries: Array<{ url: string }> }>(hB, 'history.query', {})
  expect(hist.ok).toBe(true)
  expect(hist.data!.entries.some((e) => e.url.includes('/set?v=A'))).toBe(false)

  await rn.profiles('rename', B.id, 'Work 2')
  await rn.waitSnap((s) => s.profileName === 'Work 2', 'rename reaches the window', { windowId: wB })
  const list = await rn.profiles<Array<{ id: string; name: string }>>('list')
  expect(list.find((p) => p.id === B.id)!.name).toBe('Work 2')
})

test('profiles from the settings page bridge: list, create, rename', async ({ rn }) => {
  const settings = await rn.openInternal('settings')
  const created = await rn.bridge<{ id: string; name: string }>(settings, 'profiles.create', { name: 'Kids' })
  expect(created).toMatchObject({ ok: true, data: { name: 'Kids' } })
  expect(await rn.bridge(settings, 'profiles.create', { name: '   ' })).toMatchObject({ ok: false, code: 'E_INVALID' })
  expect((await rn.bridge(settings, 'profiles.rename', { id: created.data!.id, name: 'Kids 2' })).ok).toBe(true)
  const l = await rn.bridge<{ profiles: Array<{ id: string; name: string }>; currentId: string }>(settings, 'profiles.list', {})
  expect(l.data!.currentId).toBe('default')
  expect(l.data!.profiles).toHaveLength(2)
  expect(l.data!.profiles.some((p) => p.name === 'Kids 2')).toBe(true)
})

test('delete removes profile data from disk; last-used profile is restored on launch', async ({ server }) => {
  let rn = await launchApp()
  const ud = rn.userData
  try {
    const C = await rn.profiles<{ id: string }>('create', 'Temp')
    const wC = await rn.profiles<number>('newWindow', C.id, `${server.base}/set?v=C`)
    await rn.waitWindowReady(wC)
    await rn.main(async ({ session }, id: string) => session.fromPartition(`persist:p-${id}`).cookies.flushStore(), C.id)
    await poll(() => existsSync(join(ud, 'Profiles', C.id)) && existsSync(join(ud, 'Partitions', `p-${C.id}`)), 'profile + partition dirs on disk')
    expect(existsSync(join(ud, 'Profiles', C.id))).toBe(true)
    expect(existsSync(join(ud, 'Partitions', `p-${C.id}`))).toBe(true)
    expect(await rn.profiles('delete', C.id)).toBe(true)
    await poll(async () => !(await rn.windows()).some((w) => w.profileId === C.id), 'C windows closed')
    expect(existsSync(join(ud, 'Profiles', C.id))).toBe(false)

    // Last-used: switch to a second profile, quit, relaunch -> that profile's window opens.
    const D = await rn.profiles<{ id: string }>('create', 'Daily')
    await rn.profiles('switchTo', D.id)
    await poll(async () => (await rn.profiles<{ lastProfileId: string }>('state')).lastProfileId === D.id, 'D last used')
    // Flush the debounced session save before quitting (see LOG T23 note on quitting sooner).
    await rn.flush(join(ud, 'Profiles', D.id, 'session.json'), (j) => Array.isArray(j.windows) && j.windows.length > 0, 'D session saved')
    await rn.quit()

    rn = await launchApp({ userData: ud })
    const st = await rn.profiles<{ pendingDeletes: string[]; profiles: Array<{ id: string }> }>('state')
    expect(st.pendingDeletes).toEqual([])
    expect(st.profiles.some((p) => p.id === C.id)).toBe(false)
    // Chromium's partition dir for C is gone after relaunch (deleted while not in use).
    await poll(() => !existsSync(join(ud, 'Partitions', `p-${C.id}`)), 'partition dir removed')
    const wins = await rn.windows()
    expect(wins.some((w) => w.profileId === D.id && !w.incognito)).toBe(true)
    expect(mainLogErrors(rn.mainLog())).toEqual([])
  } finally {
    await rn.quit().catch(() => rn.kill())
    rmSync(ud, { recursive: true, force: true })
  }
})
