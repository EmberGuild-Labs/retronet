import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class IpcFailure extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    IpcFailure,
    handlers: new Map<string, (req: any, ctx: any) => any>(),
    fromPartition: vi.fn(),
    netFetch: vi.fn(),
    globalFetch: vi.fn(),
    app: { getVersion: () => '1.2.0', isPackaged: false },
    create: vi.fn((_o: any): any => ({ id: 7 }))
  }
})

vi.mock('electron', () => ({ app: h.app, session: { fromPartition: h.fromPartition }, net: { fetch: h.netFetch } }))
vi.mock('../../src/main/ipc/router', () => ({
  IpcFailure: h.IpcFailure,
  router: { handle: (m: string, fn: any) => void h.handlers.set(m, fn) }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({ browserTabs: () => ({ create: h.create }) }))
vi.mock('../../src/main/internal-api/misc', () => ({ windowOf: () => ({ id: 1 }) }))

import { registerUpdateHandlers, resetUpdateHandlersForTests } from '../../src/main/internal-api/updates'
import { UPDATE_FEED_URL, effectiveFeedUrl, resolveOverride } from '../../src/main/updates/feed-config'
import { compareSemver, parseSemver } from '../../src/main/updates/semver'
import { CheckThrottle, FeedSchema, UPDATE_PARTITION, checkForUpdate, type FetchImpl } from '../../src/main/updates/update-check'
import { UpdateCheckResultSchema } from '../../src/shared/ipc-contract'

const FEED = 'https://updates.example.test/retronet.json'
const GOOD = { version: '1.3.0', url: 'https://example.test/RetroNet-1.3.0.dmg', notes: 'Fixes <b>things</b>' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init })
}
const fetchOf = (r: () => Response | Promise<Response>): FetchImpl & ReturnType<typeof vi.fn> => vi.fn(async () => r()) as any
const run = (fetchImpl: FetchImpl, extra: Partial<Parameters<typeof checkForUpdate>[0]> = {}) =>
  checkForUpdate({ feedUrl: FEED, currentVersion: '1.2.0', fetchImpl, throttle: new CheckThrottle(0), ...extra })

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = h.globalFetch as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
  delete process.env.RETRONET_TEST_UPDATE_FEED
  delete process.env.RETRONET_E2E
})

describe('AC53: nothing fetches at import or startup', () => {
  it('importing the modules, registering handlers and calling updates.status makes no request', async () => {
    registerUpdateHandlers()
    process.env.RETRONET_E2E = '1'
    process.env.RETRONET_TEST_UPDATE_FEED = 'http://127.0.0.1:9/feed.json'
    expect(await h.handlers.get('updates.status')!({}, {})).toEqual({ enabled: true, current: '1.2.0' })
    expect(h.fromPartition).not.toHaveBeenCalled()
    expect(h.netFetch).not.toHaveBeenCalled()
    expect(h.globalFetch).not.toHaveBeenCalled()
  })

  it('checkForUpdate has exactly one caller in src: the updates.check handler', () => {
    const root = join(__dirname, '..', '..')
    const out = execSync(`grep -rn "checkForUpdate(" src || true`, { cwd: root, encoding: 'utf8' })
    const callers = out
      .split('\n')
      .filter(Boolean)
      .filter((l) => !l.startsWith('src/main/updates/update-check.ts:'))
    expect(callers).toHaveLength(1)
    expect(callers[0]).toMatch(/^src\/main\/internal-api\/updates\.ts:/)
    const imports = execSync(`grep -rln "updates/update-check" src || true`, { cwd: root, encoding: 'utf8' }).trim().split('\n')
    expect(imports).toEqual(['src/main/internal-api/updates.ts'])
  })
})

describe('semver', () => {
  it('parses strictly', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemver('1.2.3-beta.11+sha.abc')?.prerelease).toEqual(['beta', 11])
    for (const bad of ['v1.2.3', '1.2', '01.2.3', '1.2.3-', '1.2.3-01', '1.2.3 ', '', '1.2.3-a..b', `1.2.3-${'a'.repeat(60)}`]) {
      expect(parseSemver(bad), bad).toBeNull()
    }
  })

  it('orders per semver section 11, ignoring build metadata', () => {
    const asc = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0']
    for (let i = 0; i < asc.length; i++) {
      for (let j = 0; j < asc.length; j++) expect(compareSemver(asc[i]!, asc[j]!), `${asc[i]} vs ${asc[j]}`).toBe(Math.sign(i - j))
    }
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(compareSemver('1.0.0', 'nope')).toBeNull()
  })
})

describe('feed schema', () => {
  it('accepts a good feed, with or without notes', () => {
    expect(FeedSchema.safeParse(GOOD).success).toBe(true)
    expect(FeedSchema.safeParse({ version: '2.0.0', url: GOOD.url }).success).toBe(true)
  })
  it.each([
    ['http url', { ...GOOD, url: 'http://example.test/x.dmg' }],
    ['javascript: url', { ...GOOD, url: 'javascript:alert(1)' }],
    ['data: url', { ...GOOD, url: 'data:text/html,hi' }],
    ['file: url', { ...GOOD, url: 'file:///etc/passwd' }],
    ['credentials in url', { ...GOOD, url: 'https://user:pw@example.test/x' }],
    ['url with whitespace', { ...GOOD, url: 'https://exa mple.test/x' }],
    ['url over 2048', { ...GOOD, url: `https://example.test/${'a'.repeat(2048)}` }],
    ['extra key', { ...GOOD, sha256: 'abc' }],
    ['notes over 4000', { ...GOOD, notes: 'n'.repeat(4001) }],
    ['bad version', { ...GOOD, version: 'latest' }],
    ['version over 64', { ...GOOD, version: `1.0.0-${'a'.repeat(60)}` }],
    ['missing version', { url: GOOD.url }],
    ['notes not a string', { ...GOOD, notes: ['x'] }]
  ])('rejects %s', (_name, feed) => {
    expect(FeedSchema.safeParse(feed).success).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('available: returns notes as plain text and keeps the url main-side only', async () => {
    const f = fetchOf(() => jsonResponse(GOOD))
    const out = await run(f)
    expect(out).toEqual({
      result: { state: 'available', current: '1.2.0', latest: '1.3.0', notes: 'Fixes <b>things</b>' },
      downloadUrl: GOOD.url
    })
    expect(UpdateCheckResultSchema.safeParse(out.result).success).toBe(true)
    expect(JSON.stringify(out.result)).not.toContain('https://example.test')
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe(FEED)
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', method: 'GET' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('up-to-date for an equal or older version, and a prerelease of the current one', async () => {
    for (const version of ['1.2.0', '1.1.9', '1.2.0-rc.1']) {
      const out = await run(fetchOf(() => jsonResponse({ ...GOOD, version })))
      expect(out).toEqual({ result: { state: 'up-to-date', current: '1.2.0', latest: version }, downloadUrl: null })
    }
  })

  it('invalid-feed: bad JSON, bad UTF-8, schema failures', async () => {
    const bodies: Array<() => Response> = [
      () => jsonResponse('{not json'),
      () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
      () => jsonResponse({ ...GOOD, url: 'http://example.test/x' }),
      () => jsonResponse({ ...GOOD, url: 'javascript:alert(1)' }),
      () => jsonResponse({ ...GOOD, extra: 1 }),
      () => jsonResponse({ ...GOOD, notes: 'x'.repeat(4001) }),
      () => jsonResponse([GOOD]),
      () => jsonResponse('null')
    ]
    for (const b of bodies) expect((await run(fetchOf(b))).result).toEqual({ state: 'error', current: '1.2.0', error: 'invalid-feed' })
  })

  it('too-large: a streamed body past 64 KB stops reading and is cancelled', async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++
        c.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
      cancel() {
        cancelled = true
      }
    })
    const out = await run(fetchOf(() => new Response(stream)))
    expect(out.result).toMatchObject({ state: 'error', error: 'too-large' })
    expect(pulls).toBeLessThan(10)
    expect(cancelled).toBe(true)
  })

  it('too-large: a declared Content-Length over the cap, and exactly 64 KB is fine', async () => {
    const big = fetchOf(() => new Response('{}', { headers: { 'content-length': '70000' } }))
    expect((await run(big)).result).toMatchObject({ error: 'too-large' })
    const body = JSON.stringify(GOOD)
    const padded = body + ' '.repeat(65536 - body.length)
    expect((await run(fetchOf(() => jsonResponse(padded)))).result.state).toBe('available')
    expect((await run(fetchOf(() => jsonResponse(padded + ' ')))).result).toMatchObject({ error: 'too-large' })
  })

  it('timeout: a feed that never answers fails after 10 s and the request is aborted', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const hang: FetchImpl = (_u, init) => {
      signal = init.signal ?? undefined
      return new Promise(() => {})
    }
    const p = run(hang)
    await vi.advanceTimersByTimeAsync(9_999)
    let settled = false
    void p.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await p).result).toMatchObject({ state: 'error', error: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  it('timeout also covers a body that stalls mid-stream', async () => {
    vi.useFakeTimers()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"version":'))
      }
    })
    const p = run(fetchOf(() => new Response(stream)))
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await p).result).toMatchObject({ error: 'timeout' })
  })

  it('redirect: a fetch that rejects (redirect:error) or reports a redirect is a network error', async () => {
    const rejects: FetchImpl = async () => {
      throw new TypeError('Redirect was cancelled')
    }
    expect((await run(rejects)).result).toMatchObject({ state: 'error', error: 'network' })
    const followed = fetchOf(() => {
      const r = jsonResponse(GOOD)
      Object.defineProperty(r, 'redirected', { value: true })
      return r
    })
    expect((await run(followed)).result).toMatchObject({ error: 'network' })
    expect((await run(fetchOf(() => new Response('', { status: 302, headers: { location: 'http://evil.test/' } })))).result).toMatchObject({ error: 'network' })
    expect((await run(fetchOf(() => jsonResponse(GOOD, { status: 500 })))).result).toMatchObject({ error: 'network' })
  })

  it('refuses a feed URL that is neither https nor a loopback test URL, without fetching', async () => {
    const f = fetchOf(() => jsonResponse(GOOD))
    for (const feedUrl of ['http://updates.example.test/f.json', 'file:///tmp/f.json', 'javascript:1']) {
      expect((await run(f, { feedUrl })).result).toMatchObject({ error: 'network' })
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('busy: one in flight, and a minimum interval between checks', async () => {
    let t = 0
    const throttle = new CheckThrottle(10_000, () => t)
    let release!: (r: Response) => void
    const f = vi.fn(() => new Promise<Response>((res) => (release = res)))
    const first = run(f as FetchImpl, { throttle })
    expect((await run(f as FetchImpl, { throttle })).result).toMatchObject({ state: 'error', error: 'busy' })
    expect(f).toHaveBeenCalledTimes(1)
    release(jsonResponse(GOOD))
    expect((await first).result.state).toBe('available')
    t = 9_999
    expect((await run(f as FetchImpl, { throttle })).result).toMatchObject({ error: 'busy' })
    t = 10_000
    const third = run(f as FetchImpl, { throttle })
    release(jsonResponse(GOOD))
    expect((await third).result.state).toBe('available')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('uses the in-memory rn-update-check session when no fetchImpl is given', async () => {
    const sesFetch = vi.fn(async () => jsonResponse(GOOD))
    h.fromPartition.mockReturnValueOnce({ fetch: sesFetch })
    const out = await checkForUpdate({ feedUrl: FEED, currentVersion: '1.2.0', throttle: new CheckThrottle(0) })
    expect(out.result.state).toBe('available')
    expect(UPDATE_PARTITION).toBe('rn-update-check')
    expect(h.fromPartition).toHaveBeenCalledWith('rn-update-check', { cache: false })
    expect(UPDATE_PARTITION.startsWith('persist:')).toBe(false)
    expect(h.netFetch).not.toHaveBeenCalled()
    expect(h.globalFetch).not.toHaveBeenCalled()
    h.fromPartition.mockReset()
  })
})

describe('feed config and the test override gate', () => {
  const gateOn = { packaged: false, e2e: true }

  it('ships unset', () => {
    expect(UPDATE_FEED_URL).toBeNull()
    expect(effectiveFeedUrl({}, gateOn)).toBeNull()
  })

  it('honours RETRONET_TEST_UPDATE_FEED only unpackaged with RETRONET_E2E=1', () => {
    const env = { RETRONET_TEST_UPDATE_FEED: 'http://127.0.0.1:4321/feed.json' }
    expect(resolveOverride(env, gateOn)).toBe(env.RETRONET_TEST_UPDATE_FEED)
    expect(resolveOverride(env, { packaged: true, e2e: true })).toBeNull()
    expect(resolveOverride(env, { packaged: false, e2e: false })).toBeNull()
    expect(resolveOverride(env, { packaged: true, e2e: false })).toBeNull()
    expect(effectiveFeedUrl(env, { packaged: true, e2e: true })).toBeNull()
  })

  it('allows only 127.0.0.1 or localhost for the override', () => {
    for (const ok of ['http://127.0.0.1:1/f', 'http://localhost:8080/f.json', 'https://127.0.0.1:9443/f']) {
      expect(resolveOverride({ RETRONET_TEST_UPDATE_FEED: ok }, gateOn), ok).toBe(ok)
    }
    for (const bad of ['http://example.test/f', 'https://evil.test/f', 'http://127.0.0.2/f', 'http://[::1]:1/f', 'http://localhost.evil.test/f', 'http://u:p@127.0.0.1/f', 'file:///f', 'not a url', '']) {
      expect(resolveOverride({ RETRONET_TEST_UPDATE_FEED: bad }, gateOn), bad).toBeNull()
    }
  })

  it('a shipped constant must be https', () => {
    expect(effectiveFeedUrl({}, gateOn, 'https://updates.example.test/f.json')).toBe('https://updates.example.test/f.json')
    expect(effectiveFeedUrl({}, gateOn, 'http://updates.example.test/f.json')).toBeNull()
    expect(effectiveFeedUrl({}, gateOn, 'https://u:p@updates.example.test/f.json')).toBeNull()
  })
})

describe('handlers', () => {
  beforeEach(() => {
    h.handlers.clear()
    resetUpdateHandlersForTests()
    registerUpdateHandlers()
    h.create.mockClear()
    h.fromPartition.mockReset()
  })
  const call = (m: string) => h.handlers.get(m)!({}, { info: { windowId: 1 } })

  it('AC52 null feed: status enabled:false, check E_UNAVAILABLE, openDownload E_NOT_FOUND, no request', async () => {
    expect(await call('updates.status')).toEqual({ enabled: false, current: '1.2.0' })
    await expect(call('updates.check')).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(() => call('updates.openDownload')).toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }))
    expect(h.fromPartition).not.toHaveBeenCalled()
  })

  it('the override is ignored when RETRONET_E2E is not 1', async () => {
    process.env.RETRONET_TEST_UPDATE_FEED = 'http://127.0.0.1:9/feed.json'
    expect(await call('updates.status')).toEqual({ enabled: false, current: '1.2.0' })
    await expect(call('updates.check')).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
  })

  it('openDownload needs an available result, then opens the main-held url in a new foreground tab', async () => {
    process.env.RETRONET_E2E = '1'
    process.env.RETRONET_TEST_UPDATE_FEED = 'http://127.0.0.1:9/feed.json'
    const sesFetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ...GOOD, version: '1.0.0' }))
    h.fromPartition.mockReturnValue({ fetch: sesFetch })
    expect(await call('updates.check')).toMatchObject({ state: 'up-to-date' })
    expect(() => call('updates.openDownload')).toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }))

    sesFetch.mockImplementation(async () => jsonResponse(GOOD))
    expect(await call('updates.check')).toMatchObject({ state: 'available', latest: '1.3.0' })
    expect(sesFetch).toHaveBeenCalledTimes(2)
    expect(sesFetch.mock.calls[0]![0]).toBe('http://127.0.0.1:9/feed.json')
    expect(call('updates.openDownload')).toBeNull()
    expect(h.create).toHaveBeenCalledWith({ url: GOOD.url })

    // A later failed check forgets the download; a blocked tab is E_FORBIDDEN.
    sesFetch.mockImplementation(async () => jsonResponse('{bad'))
    expect(await call('updates.check')).toMatchObject({ state: 'error', error: 'invalid-feed' })
    expect(() => call('updates.openDownload')).toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }))
    sesFetch.mockImplementation(async () => jsonResponse(GOOD))
    await call('updates.check')
    h.create.mockReturnValueOnce(null)
    expect(() => call('updates.openDownload')).toThrow(expect.objectContaining({ code: 'E_FORBIDDEN' }))
  })
})
