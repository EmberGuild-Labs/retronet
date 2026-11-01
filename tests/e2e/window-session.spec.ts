// FIX-1: window close runs the tabs' beforeunload (Stay keeps the window), a closed tab keeps its group on
// reopen, a window opened right before quit is saved, and session restore brings back back/forward lists.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchApp, poll, mainLogErrors, type RN, settle } from './helpers/launch'

/** Replace dialog.showMessageBoxSync: answer `choice` (a button label) and record each prompt's title. */
async function stubUnloadPrompt(rn: RN, choice: string): Promise<void> {
  await rn.main(({ dialog }, c: string) => {
    const g = globalThis as any
    g.__fix1Asked ??= []
    g.__fix1Choice = c
    ;(dialog as any).showMessageBoxSync = (a: any, b: any) => {
      const o = b ?? a
      g.__fix1Asked.push(o.title)
      return Math.max(0, o.buttons.indexOf(g.__fix1Choice))
    }
  }, choice)
}

const asked = (rn: RN): Promise<string[]> => rn.main(() => [...(((globalThis as any).__fix1Asked as string[]) ?? [])])

/** The red button: BrowserWindow.close() on the window that owns the shell. */
async function closeWindow(rn: RN, windowId: number): Promise<void> {
  const w = await rn.win(windowId)
  await rn.main(({ BrowserWindow, webContents }, id: number) => {
    BrowserWindow.fromWebContents(webContents.fromId(id)!)!.close()
  }, w.shellId)
}

async function guard(rn: RN, wcId: number): Promise<void> {
  // userGesture=true gives the page the activation Chromium requires before it shows a beforeunload prompt.
  await rn.js(wcId, `window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; return '' }; true`)
}

test('closing a window asks a tab with beforeunload; Stay keeps the window, Leave closes it', async ({ rn, server }) => {
  const w2 = await rn.profiles<number>('newWindow', 'default', `${server.base}/title?t=Guarded`)
  await rn.waitWindowReady(w2)
  await rn.shell('tabs.create', { url: `${server.base}/title?t=Plain`, background: true }, w2)
  await rn.waitSnap((s) => s.tabs.length === 2 && s.tabs.every((t) => !t.loading), 'w2 two tabs', { windowId: w2 })
  await guard(rn, await rn.activeTabWcId(w2))

  // Stay: the window and the guarded tab survive; no second prompt.
  await stubUnloadPrompt(rn, 'Stay')
  await closeWindow(rn, w2)
  await poll(async () => (await asked(rn)).length === 1, 'first prompt')
  await settle(800, 'no second unload prompt should appear')
  expect(await asked(rn)).toEqual(['Leave site?'])
  const s = await rn.snap(w2)
  expect(s.tabs.map((t) => t.title)).toContain('Guarded')
  // A tab that had already closed is one Cmd+Shift+T away.
  if (s.tabs.length === 1) expect(s.canReopenClosed).toBe(true)

  // Leave (Cmd+Shift+W this time): the window goes.
  await stubUnloadPrompt(rn, 'Leave')
  await rn.press('W', ['meta', 'shift'], 'shell', w2)
  await poll(async () => !(await rn.windows()).some((w) => w.id === w2), 'w2 closed')
  expect((await asked(rn)).length).toBe(2)

  // A window whose pages don't object closes without a prompt.
  const w3 = await rn.profiles<number>('newWindow', 'default', `${server.base}/title?t=Free`)
  await rn.waitWindowReady(w3)
  await closeWindow(rn, w3)
  await poll(async () => !(await rn.windows()).some((w) => w.id === w3), 'w3 closed')
  expect((await asked(rn)).length).toBe(2)

  // Quit never waits for pages: the guarded main window must not block the fixture's quit.
  await guard(rn, await rn.activeTabWcId())
  await stubUnloadPrompt(rn, 'Stay')
})

test('a reopened tab returns to its group', async ({ rn, server }) => {
  const a = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=GA`, background: true })).tabId
  const b = (await rn.shell<{ tabId: number }>('tabs.create', { url: `${server.base}/title?t=GB`, background: true })).tabId
  await rn.waitSnap((s) => s.tabs.length === 3 && s.tabs.every((t) => !t.loading), 'loaded')
  const { groupId } = await rn.shell<{ groupId: string }>('groups.create', { tabId: a, name: 'Keep', color: 'green' })
  await rn.shell('groups.addTab', { groupId, tabId: b })
  await rn.shell('tabs.close', { tabId: b })
  await rn.waitSnap((s) => s.tabs.length === 2 && s.canReopenClosed, 'b closed')
  await rn.press('T', ['meta', 'shift'], 'shell')
  const s = await rn.waitSnap((s) => s.tabs.length === 3 && s.tabs.some((t) => t.title === 'GB'), 'b reopened')
  expect(s.tabs.find((t) => t.title === 'GB')!.groupId).toBe(groupId)

  // Close the whole group's last members, then reopen: the group comes back with its name and color.
  await rn.shell('tabs.close', { tabId: s.tabs.find((t) => t.title === 'GB')!.id })
  await rn.shell('tabs.close', { tabId: a })
  await rn.waitSnap((s) => s.tabs.length === 1 && s.groups.length === 0, 'group gone')
  await rn.press('T', ['meta', 'shift'], 'shell')
  const back = await rn.waitSnap((s) => s.tabs.some((t) => t.title === 'GA') && s.groups.length === 1, 'GA reopened')
  expect(back.groups[0]).toMatchObject({ id: groupId, name: 'Keep', color: 'green' })
  expect(back.tabs.find((t) => t.title === 'GA')!.groupId).toBe(groupId)
})

test('a window opened right before quit is saved, and restore brings back back/forward history', async ({ server }) => {
  let rn = await launchApp()
  const userData = rn.userData
  try {
    await rn.navigate(`${server.base}/title?t=HA`)
    await rn.navigate(`${server.base}/title?t=HB`)
    await rn.navigate(`${server.base}/title?t=HC`)
    await rn.shell('tabs.back', {})
    await rn.waitSnap((s) => rn.active(s).title === 'HB' && !rn.active(s).loading, 'back to HB')
    await rn.flush()
    // Opened and quit at once: no debounce, and the tab has not committed yet.
    void rn.profiles<number>('newWindow', 'default', `${server.base}/title?t=Late`).catch(() => undefined)
    await settle(30, 'let the window open start before quitting (deliberate race)')
    await rn.quit()

    const file = join(userData, 'Profiles', 'default', 'session.json')
    const disk = JSON.parse(readFileSync(file, 'utf8')) as {
      windows: Array<{ tabs: Array<{ url: string; history?: { entries: Array<{ url: string; title: string }>; index: number } }> }>
    }
    expect(disk.windows).toHaveLength(2)
    expect(disk.windows.some((w) => w.tabs.some((t) => t.url.endsWith('t=Late')))).toBe(true)
    const tab = disk.windows.flatMap((w) => w.tabs).find((t) => t.url.endsWith('t=HB'))!
    const names = (urls: string[]): string[] => urls.filter((u) => u.includes('t=')).map((u) => u.replace(/^.*t=/, ''))
    expect(names(tab.history!.entries.map((e) => e.url))).toEqual(['HA', 'HB', 'HC'])
    expect(tab.history!.entries[tab.history!.index]!.url).toBe(tab.url)
    // A refused address planted in the saved list is dropped on restore (decideBrowserNavigation).
    tab.history!.entries.unshift({ url: 'javascript:alert(1)', title: 'bad' })
    tab.history!.index += 1
    writeFileSync(file, JSON.stringify(disk))

    rn = await launchApp({ userData })
    const wins = await poll(async () => {
      const all = await rn.windows()
      return all.length === 2 && all.every((w) => w.snapshot.tabs.length > 0 && w.snapshot.tabs.every((t) => !t.loading)) ? all : null
    }, 'two restored windows', 20_000)
    expect(wins.some((w) => w.snapshot.tabs.some((t) => t.title === 'Late'))).toBe(true)
    const main = wins.find((w) => w.snapshot.tabs.some((t) => t.title === 'HB'))!
    const hb = main.snapshot.tabs.find((t) => t.title === 'HB')!
    expect(hb.canGoBack).toBe(true)
    expect(hb.canGoForward).toBe(true)
    const wcId = (await rn.wcIdsByUrl(/t=HB$/))[0]!
    const entries = await rn.main(({ webContents }, id: number) => webContents.fromId(id)!.navigationHistory.getAllEntries().map((e) => e.url), wcId)
    expect(entries.some((u) => u.startsWith('javascript:'))).toBe(false)
    expect(names(entries)).toEqual(['HA', 'HB', 'HC'])
    await rn.shell('tabs.back', { tabId: hb.id }, main.id)
    await rn.waitSnap((s) => s.tabs.some((t) => t.id === hb.id && t.title === 'HA' && !t.loading), 'back to HA', { windowId: main.id })
    expect(mainLogErrors(rn.mainLog())).toEqual([])
  } finally {
    await rn.quit().catch(() => rn.kill())
    rmSync(userData, { recursive: true, force: true })
  }
})
