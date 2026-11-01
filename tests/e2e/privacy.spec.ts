// AC40: no telemetry or phone-home. Launch with a Chromium net log, sit idle on the new-tab page for 10 s,
// quit, and check that every URL the network stack saw is retronet:/data:/blob: (no http(s), no DNS lookups).
import { test, expect, launchApp, tempDir, settle } from './helpers/launch'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('idle launch makes no network requests of its own', async () => {
  test.setTimeout(90_000)
  const dir = tempDir('rn-e2e-netlog-')
  const log = join(dir, 'net.json')
  const rn = await launchApp({ switches: [`--log-net-log=${log}`, '--net-log-capture-mode=Default'] })
  try {
    expect((await rn.snap()).tabs[0]!.url).toBe('retronet://newtab/')
    await settle(10_000, 'idle launch must make no network requests')
  } finally {
    await rn.quit().catch(() => rn.kill())
  }
  expect(existsSync(log)).toBe(true)
  const text = readFileSync(log, 'utf8')
  const urls = new Set<string>()
  const hosts = new Set<string>()
  for (const m of text.matchAll(/"url":"([^"]+)"/g)) urls.add(m[1]!)
  for (const m of text.matchAll(/"host":"([^"]+)"/g)) hosts.add(m[1]!)
  const external = [...urls].filter((u) => !/^(retronet|data|blob|about|chrome-error|devtools):/.test(u))
  test.info().annotations.push({ type: 'net-log urls', description: [...urls].slice(0, 30).join(' ') || '(none)' })
  // Sanity: the log is a real, complete net log (retronet: loads go through protocol.handle, not the network
  // stack, so an idle app legitimately logs no URL at all).
  const parsed = JSON.parse(text) as { constants?: unknown; events?: unknown[] }
  expect(parsed.constants, 'net log constants').toBeTruthy()
  expect(Array.isArray(parsed.events) && parsed.events.length > 0, 'net log has events').toBe(true)
  expect(external, 'URLs requested while idle').toEqual([])
  expect([...hosts].filter((h) => !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)), 'hosts resolved/connected while idle').toEqual([])
  rmSync(dir, { recursive: true, force: true })
  rmSync(rn.userData, { recursive: true, force: true })
})
