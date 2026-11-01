// AC1: tabs: new, close, switch, reorder, pin/unpin (pinned sorted left), reopen closed (Cmd+Shift+T, 10 deep).
import { test, expect, poll } from './helpers/launch'

test('new, switch, reorder, pin and close tabs', async ({ rn, server }) => {
  let s = await rn.snap()
  expect(s.tabs).toHaveLength(1)
  expect(s.tabs[0]!.url).toBe('retronet://newtab/')
  const t1 = s.tabs[0]!.id

  const t2 = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=Two` })).tabId
  const t3 = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=Three`, background: true })).tabId
  s = await rn.waitSnap((s) => s.tabs.length === 3 && s.tabs.every((t) => !t.loading && t.title !== ''), '3 loaded tabs')
  expect(s.tabs.map((t) => t.id)).toEqual([t1, t2, t3])
  expect(s.activeTabId).toBe(t2) // t3 opened in the background
  expect(s.tabs.find((t) => t.id === t3)!.title).toBe('Three')

  await rn.shell('tabs.activate', { tabId: t3 })
  await rn.waitSnap((s) => s.activeTabId === t3, 'switch to t3')

  await rn.shell('tabs.move', { tabId: t3, index: 0 })
  s = await rn.waitSnap((s) => s.tabs[0]!.id === t3, 'reorder t3 first')
  expect(s.tabs.map((t) => t.id)).toEqual([t3, t1, t2])

  // Pinned tabs sort to the left; an unpinned tab can't move in front of them.
  await rn.shell('tabs.pin', { tabId: t2, pinned: true })
  s = await rn.waitSnap((s) => s.tabs[0]!.id === t2 && s.tabs[0]!.pinned, 'pinned t2 first')
  expect(s.tabs.map((t) => t.id)).toEqual([t2, t3, t1])
  await rn.shell('tabs.move', { tabId: t1, index: 0 })
  s = await rn.snap()
  expect(s.tabs[0]!.id).toBe(t2)
  await rn.shell('tabs.pin', { tabId: t2, pinned: false })
  s = await rn.waitSnap((s) => s.tabs.every((t) => !t.pinned), 'unpinned')

  await rn.shell('tabs.close', { tabId: t3 })
  // A close runs the page's beforeunload first, so the closed-stack record lands a moment after the strip updates.
  s = await rn.waitSnap((s) => s.tabs.length === 2 && s.canReopenClosed, 'closed t3')
  expect(s.tabs.some((t) => t.id === t3)).toBe(false)
  expect(s.canReopenClosed).toBe(true)

  const bad = await rn.shellCall('tabs.close', { tabId: 99999 })
  expect(bad).toMatchObject({ ok: false, code: 'E_NOT_FOUND' })
})

test('pinned tabs render compact and first in the tab strip', async ({ rn, server }) => {
  const t2 = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=Pin` })).tabId
  await rn.waitSnap((s) => s.tabs.length === 2 && s.tabs.every((t) => !t.loading), 'two tabs')
  await rn.shell('tabs.pin', { tabId: t2, pinned: true })
  await rn.waitSnap((s) => s.tabs[0]!.pinned, 'pinned')
  const w = await rn.win()
  const dom = await rn.js<{ firstPinned: boolean; pinnedW: number; otherW: number }>(
    w.shellId,
    `(async () => { await new Promise((r) => setTimeout(r, 300)); const tabs = [...document.querySelectorAll('.rn-tabstrip [role=tab], .rn-tabstrip .rn-tab')].filter((e) => e.classList.contains('rn-tab')); const p = tabs[0]; return { firstPinned: !!p && p.classList.contains('rn-tab--pinned'), pinnedW: p ? p.getBoundingClientRect().width : -1, otherW: tabs[1] ? tabs[1].getBoundingClientRect().width : -1 } })()`
  )
  expect(dom.firstPinned).toBe(true)
  expect(dom.pinnedW).toBeLessThan(dom.otherW)
  expect(dom.pinnedW).toBeLessThanOrEqual(48)
})

test('Cmd+Shift+T reopens closed tabs in order, 10 deep, per window', async ({ rn, server }) => {
  // Open 12 tabs, close them all (newest first), then reopen: at most 10 come back, most recent first.
  for (let i = 1; i <= 12; i++) await rn.shell('tabs.create', { url: `${server.base}/title?t=T${i}`, background: true })
  let s = await rn.waitSnap((s) => s.tabs.length === 13 && s.tabs.every((t) => !t.loading), '13 tabs loaded', { timeout: 20_000 })
  const keep = s.tabs[0]!.id
  await rn.shell('tabs.activate', { tabId: keep })
  for (const t of s.tabs.slice(1)) await rn.shell('tabs.close', { tabId: t.id })
  s = await rn.waitSnap((s) => s.tabs.length === 1 && s.canReopenClosed, 'all but one closed')
  // Wait until every closed tab's webContents is really gone (async beforeunload close), so the stack is complete.
  await poll(async () => (await rn.wcIdsByUrl(/\/title\?t=T\d+$/)).length === 0, 'closed tabs destroyed')

  // A second window has its own (empty) closed stack.
  const w2 = await rn.profiles<number>('newWindow', 'default')
  await rn.waitWindowReady(w2)
  expect((await rn.snap(w2)).canReopenClosed).toBe(false)

  const first = await rn.win()
  for (let i = 0; i < 10; i++) {
    await rn.press('T', ['meta', 'shift'], 'shell', first.id)
    await rn.waitSnap((s) => s.tabs.length === 2 + i, `reopen #${i + 1}`)
  }
  s = await rn.waitSnap((s) => s.tabs.every((t) => !t.loading), 'reopened tabs loaded', { timeout: 20_000 })
  expect(s.canReopenClosed).toBe(false)
  // T1..T12 were closed in order, so the 10-deep stack holds T3..T12; T1 and T2 fell off.
  const titles = s.tabs.map((t) => t.title).filter((t) => /^T\d+$/.test(t)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  expect(titles).toEqual(['T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12'])
  await rn.press('T', ['meta', 'shift'], 'shell', first.id)
  await new Promise((r) => setTimeout(r, 300))
  expect((await rn.snap(first.id)).tabs).toHaveLength(11)
  expect((await rn.snap(w2)).tabs).toHaveLength(1)
})
