// T24 soak: scripted browse for SOAK_MINUTES (default 10) over local fixtures; RN_SOAK_PUBLIC=1 adds a few public
// sites. Asserts the app stays alive, never accumulates tabs, and main.log has zero uncaught exceptions.
import { test, expect, mainLogErrors, sleep } from '../e2e/helpers/launch'

const MINUTES = Number(process.env.SOAK_MINUTES ?? 10)
const PUBLIC = ['https://example.com/', 'https://www.wikipedia.org/', 'https://news.ycombinator.com/']

test('soak: scripted browse, no uncaught exceptions', async ({ rn, server }) => {
  test.setTimeout((MINUTES + 5) * 60_000)
  const end = Date.now() + MINUTES * 60_000
  const urls = [`${server.base}/a`, `${server.base}/b`, `${server.base}/title?t=Soak`, `${server.base}/redirect`]
  if (process.env.RN_SOAK_PUBLIC === '1') urls.push(...PUBLIC)
  let i = 0
  while (Date.now() < end) {
    const url = urls[i++ % urls.length]!
    await rn.navigate(url, { expectUrl: () => true, timeout: 20_000 }).catch(() => undefined)
    if (i % 5 === 0) {
      const t = (await rn.shell<{ tabId: number }>('tabs.create', { url: urls[i % urls.length]!, background: true })).tabId
      await sleep(500)
      await rn.shell('tabs.close', { tabId: t })
    }
    await sleep(1500)
    expect((await rn.snap()).tabs.length).toBeLessThanOrEqual(2)
  }
  expect(mainLogErrors(rn.mainLog())).toEqual([])
})
