// X7 (AC48): links and files from other apps: classification, the queue, routing and argv parsing.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  appListeners: new Map<string, Array<(...a: unknown[]) => void>>(),
  wmListeners: { created: [] as Array<(w: unknown) => void>, focused: [] as Array<(w: unknown) => void>, closed: [] as Array<(w: unknown) => void> },
  windows: [] as unknown[],
  logs: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    on: (ev: string, fn: (...a: unknown[]) => void) => {
      const l = h.appListeners.get(ev) ?? []
      l.push(fn)
      h.appListeners.set(ev, l)
    },
    getAppPath: () => '/opt/retronet/resources/app.asar'
  }
}))
vi.mock('../../src/main/app-paths', () => ({ backgroundTestMode: () => false }))
vi.mock('../../src/main/logger', () => ({
  logger: {
    info: (m: string) => h.logs.push(m),
    warn: (m: string) => h.logs.push(m),
    error: (m: string) => h.logs.push(m)
  }
}))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: {
    all: () => h.windows,
    createWindow: vi.fn(),
    onWindowCreated: (l: (w: unknown) => void) => h.wmListeners.created.push(l),
    onWindowFocused: (l: (w: unknown) => void) => h.wmListeners.focused.push(l),
    onWindowClosed: (l: (w: unknown) => void) => h.wmListeners.closed.push(l)
  }
}))
vi.mock('../../src/main/tabs/tab-manager', () => ({
  browserTabs: (w: { tabs: unknown }) => w.tabs,
  withTabSeed: (_seed: unknown, create: () => unknown) => ({ result: create(), firstTab: undefined })
}))

import {
  classifyExternalOpen,
  OPEN_URL_MAX,
  urlsFromArgv,
  type IsFile,
  type OpenTarget
} from '../../src/main/os-integration/open-targets'
import {
  FocusOrder,
  OPEN_QUEUE_MAX,
  OPEN_RATE_MAX,
  OPEN_RATE_WINDOW_MS,
  OpenRequestQueue,
  pickTargetWindow,
  installOpenRequestHandlers,
  markOpenTargetReady,
  hasPendingOpenRequests,
  handleSecondInstanceArgv,
  type OpenRouter
} from '../../src/main/os-integration/open-requests'
import { windowManager } from '../../src/main/windows/window-manager'

const anyFile: IsFile = () => true
const noFile: IsFile = () => false

describe('classifyExternalOpen: URLs', () => {
  it('accepts http and https as untyped', () => {
    expect(classifyExternalOpen({ kind: 'url', url: 'https://example.org/a?b=1' })).toEqual({ url: 'https://example.org/a?b=1', typed: false })
    expect(classifyExternalOpen({ kind: 'url', url: 'http://127.0.0.1:8080/' })).toEqual({ url: 'http://127.0.0.1:8080/', typed: false })
    expect(classifyExternalOpen({ kind: 'url', url: 'HTTPS://EXAMPLE.ORG' })).toEqual({ url: 'https://example.org/', typed: false })
  })

  it.each([
    'retronet://settings',
    'retronet://shell/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/hosts',
    'ftp://example.org/',
    'mailto:a@example.org',
    'chrome://gpu',
    'about:blank',
    'view-source:https://example.org/',
    'blob:https://example.org/x',
    'https://',
    'https://exa mple.org/',
    ' https://example.org/',
    'not a url',
    ''
  ])('refuses %s', (url) => {
    expect(classifyExternalOpen({ kind: 'url', url })).toBeNull()
  })

  it('refuses addresses over the length cap', () => {
    const base = 'https://example.org/'
    expect(classifyExternalOpen({ kind: 'url', url: base + 'a'.repeat(OPEN_URL_MAX - base.length) })).not.toBeNull()
    expect(classifyExternalOpen({ kind: 'url', url: base + 'a'.repeat(OPEN_URL_MAX - base.length + 1) })).toBeNull()
  })

  it('refuses non-string input', () => {
    expect(classifyExternalOpen({ kind: 'url', url: undefined as unknown as string })).toBeNull()
    expect(classifyExternalOpen({ kind: 'file', path: 42 as unknown as string })).toBeNull()
  })
})

describe('classifyExternalOpen: userinfo (R30)', () => {
  it('strips user:pass@ from external URLs', () => {
    expect(classifyExternalOpen({ kind: 'url', url: 'https://trusted.com@evil.example/p?q=1#f' })).toEqual({ url: 'https://evil.example/p?q=1#f', typed: false })
    expect(classifyExternalOpen({ kind: 'url', url: 'http://u:p@host.example/' })).toEqual({ url: 'http://host.example/', typed: false })
    expect(classifyExternalOpen({ kind: 'url', url: 'https://u@host.example:8080/x' })?.url).toBe('https://host.example:8080/x')
  })
  it('strips userinfo from argv URLs too', () => {
    const t = urlsFromArgv(['/bin/rn', 'https://a:b@host.example/'], '/', 'linux')
    expect(t.map((x) => x.url)).toEqual(['https://host.example/'])
  })
})

describe('classifyExternalOpen: files', () => {
  it.each(['/Users/a/page.html', '/Users/a/page.HTM', '/Users/a/page.xhtml', '/Users/a/page.shtml'])('accepts %s as a typed file: URL', (path) => {
    expect(classifyExternalOpen({ kind: 'file', path }, anyFile)).toEqual({ url: pathToFileURL(path).href, typed: true })
  })

  it.each(['/Users/a/doc.pdf', '/Users/a/notes.txt', '/Users/a/app.js', '/Users/a/page.html.exe', '/Users/a/html', '/Users/a/.html.svg'])(
    'refuses the extension of %s',
    (path) => {
      expect(classifyExternalOpen({ kind: 'file', path }, anyFile)).toBeNull()
    }
  )

  it('refuses relative paths, NUL bytes and missing files or directories', () => {
    expect(classifyExternalOpen({ kind: 'file', path: 'page.html' }, anyFile)).toBeNull()
    expect(classifyExternalOpen({ kind: 'file', path: '/a/page\0.html' }, anyFile)).toBeNull()
    expect(classifyExternalOpen({ kind: 'file', path: '/a/page.html' }, noFile)).toBeNull()
  })

  it('checks the disk by default (regular files only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-x7-'))
    const file = join(dir, 'a page.html')
    writeFileSync(file, '<p>hi</p>')
    mkdirSync(join(dir, 'folder.html'))
    expect(classifyExternalOpen({ kind: 'file', path: file })).toEqual({ url: pathToFileURL(file).href, typed: true })
    expect(classifyExternalOpen({ kind: 'file', path: join(dir, 'folder.html') })).toBeNull()
    expect(classifyExternalOpen({ kind: 'file', path: join(dir, 'missing.html') })).toBeNull()
  })

  it('percent-encodes odd characters so the path cannot change the URL', () => {
    const t = classifyExternalOpen({ kind: 'file', path: '/tmp/a#b?c%d.html' }, anyFile)
    expect(t?.url).toBe('file:///tmp/a%23b%3Fc%25d.html')
  })
})

describe('urlsFromArgv', () => {
  const opts = { appPath: '/opt/retronet/resources/app.asar', isFile: (p: string) => p.endsWith('.html') && !p.includes('missing') }

  it('is empty on macOS (links arrive as open-url/open-file)', () => {
    expect(urlsFromArgv(['/Applications/RetroNet', 'https://example.org/'], '/', 'darwin', opts)).toEqual([])
  })

  it('keeps http(s) URLs and existing .html files, skipping argv[0], switches, . and the app path', () => {
    const argv = [
      '/opt/retronet/retronet',
      '--allow-file-access-from-files',
      '-flag',
      '.',
      '/opt/retronet/resources/app.asar',
      'https://example.org/one',
      'retronet://settings',
      'javascript:alert(1)',
      'file:///etc/hosts',
      'docs/page.html',
      '/abs/missing.html',
      '/abs/notes.txt',
      'http://example.com/two'
    ]
    expect(urlsFromArgv(argv, '/home/u', 'linux', opts)).toEqual([
      { url: 'https://example.org/one', typed: false },
      { url: 'file:///home/u/docs/page.html', typed: true },
      { url: 'http://example.com/two', typed: false }
    ])
  })

  it('works the same on win32 (argv[0] is the exe)', () => {
    expect(urlsFromArgv(['C:\\RetroNet\\RetroNet.exe', 'https://example.org/'], 'C:\\', 'win32', opts)).toEqual([
      { url: 'https://example.org/', typed: false }
    ])
  })

  it('ignores argv[0] even when it looks like a URL, and empty or non-string entries', () => {
    expect(urlsFromArgv(['https://example.org/', '', undefined as unknown as string], '/', 'linux', opts)).toEqual([])
  })
})

interface FakeWin {
  id: number
  incognito: boolean
  popup: boolean
  tabs: OpenTarget[]
}

function fakeRouter(wins: FakeWin[], opts: { refuse?: boolean } = {}) {
  const focused: number[] = []
  const created: FakeWin[] = []
  let next = 100
  const router: OpenRouter<FakeWin> = {
    windows: () => wins,
    openTab: (w, t) => {
      if (opts.refuse) return false
      w.tabs.push(t)
      return true
    },
    openWindow: (t) => {
      const w: FakeWin = { id: next++, incognito: false, popup: false, tabs: [t] }
      created.push(w)
      wins.unshift(w)
      return w
    },
    focus: (w) => focused.push(w.id)
  }
  return { router, focused, created }
}

const target = (n: number): OpenTarget => ({ url: `https://example.org/${n}`, typed: false })

describe('pickTargetWindow', () => {
  it('skips incognito and popup windows', () => {
    const a = { id: 1, incognito: true, popup: false }
    const b = { id: 2, incognito: false, popup: true }
    const c = { id: 3, incognito: false, popup: false }
    const d = { id: 4, incognito: false, popup: false }
    expect(pickTargetWindow([a, b, c, d])).toBe(c)
    expect(pickTargetWindow([a, b])).toBeNull()
    expect(pickTargetWindow([])).toBeNull()
  })
})

describe('OpenRequestQueue', () => {
  it('queues before ready, then drains in order into the most recent normal window and focuses it', () => {
    const logs: string[] = []
    const q = new OpenRequestQueue<FakeWin>((m) => logs.push(m))
    q.push(target(1))
    q.push({ url: 'file:///tmp/a.html', typed: true })
    expect(q.size).toBe(2)
    const incog: FakeWin = { id: 1, incognito: true, popup: false, tabs: [] }
    const popup: FakeWin = { id: 2, incognito: false, popup: true, tabs: [] }
    const normal: FakeWin = { id: 3, incognito: false, popup: false, tabs: [] }
    const older: FakeWin = { id: 4, incognito: false, popup: false, tabs: [] }
    const { router, focused, created } = fakeRouter([incog, popup, normal, older])
    q.ready(router)
    expect(q.size).toBe(0)
    expect(normal.tabs).toEqual([target(1), { url: 'file:///tmp/a.html', typed: true }])
    expect(incog.tabs).toEqual([])
    expect(popup.tabs).toEqual([])
    expect(older.tabs).toEqual([])
    expect(focused).toEqual([3, 3])
    expect(created).toEqual([])
    // After ready, requests open at once.
    q.push(target(3))
    expect(normal.tabs).toHaveLength(3)
    expect(logs.join('\n')).not.toContain('example.org')
  })

  it('caps the queue at 20 and logs only counts', () => {
    const logs: string[] = []
    const q = new OpenRequestQueue<FakeWin>((m) => logs.push(m))
    for (let i = 0; i < OPEN_QUEUE_MAX + 5; i++) q.push(target(i))
    expect(OPEN_QUEUE_MAX).toBe(20)
    expect(q.size).toBe(20)
    const w: FakeWin = { id: 1, incognito: false, popup: false, tabs: [] }
    q.ready(fakeRouter([w]).router)
    expect(w.tabs.map((t) => t.url)).toEqual(Array.from({ length: 20 }, (_, i) => `https://example.org/${i}`))
    expect(logs).toContain('open request queue full (5 dropped)')
    expect(logs).toContain('opening 20 queued open request(s), 5 dropped')
    expect(logs.join('\n')).not.toMatch(/example|https?:/)
  })

  it('opens a new window when only incognito or popup windows exist, then reuses it', () => {
    const q = new OpenRequestQueue<FakeWin>()
    const incog: FakeWin = { id: 1, incognito: true, popup: false, tabs: [] }
    const { router, created, focused } = fakeRouter([incog])
    q.push(target(1))
    q.push(target(2))
    q.ready(router)
    expect(created).toHaveLength(1)
    expect(created[0]!.tabs).toEqual([target(1), target(2)])
    expect(incog.tabs).toEqual([])
    expect(focused).toEqual([100, 100])
  })

  it('opens a new window when there is none at all', () => {
    const q = new OpenRequestQueue<FakeWin>()
    const { router, created } = fakeRouter([])
    q.ready(router)
    q.push(target(7))
    expect(created.map((w) => w.tabs)).toEqual([[target(7)]])
  })

  it('does not focus when the tab is refused', () => {
    const q = new OpenRequestQueue<FakeWin>()
    const w: FakeWin = { id: 1, incognito: false, popup: false, tabs: [] }
    const { router, focused } = fakeRouter([w], { refuse: true })
    q.ready(router)
    q.push(target(1))
    expect(focused).toEqual([])
  })

  it('ready is idempotent and close() drops the queue and later requests', () => {
    const q = new OpenRequestQueue<FakeWin>()
    q.push(target(1))
    q.close()
    expect(q.size).toBe(0)
    const w: FakeWin = { id: 1, incognito: false, popup: false, tabs: [] }
    q.ready(fakeRouter([w]).router)
    q.ready(fakeRouter([w]).router)
    q.push(target(2))
    expect(w.tabs).toEqual([])
  })
})

describe('OpenRequestQueue: post-ready rate limit (R29)', () => {
  it('drops the 21st open within 10 s, logs only a count, and recovers after the window', () => {
    const logs: string[] = []
    let now = 1000
    const q = new OpenRequestQueue<FakeWin>((m) => logs.push(m), () => now)
    const w: FakeWin = { id: 1, incognito: false, popup: false, tabs: [] }
    q.ready(fakeRouter([w]).router)
    expect(OPEN_RATE_MAX).toBe(20)
    expect(OPEN_RATE_WINDOW_MS).toBe(10_000)
    for (let i = 0; i < 20; i++) q.push(target(i))
    expect(w.tabs).toHaveLength(20)
    q.push(target(20))
    q.push(target(21))
    expect(w.tabs).toHaveLength(20)
    expect(logs).toEqual(['open request rate-limited (1 dropped)', 'open request rate-limited (2 dropped)'])
    expect(logs.join('\n')).not.toContain('example.org')
    now += OPEN_RATE_WINDOW_MS
    q.push(target(22))
    expect(w.tabs).toHaveLength(21)
  })
})

describe('FocusOrder', () => {
  it('sorts most recent first, the OS-focused window leads, unknown ids last', () => {
    const o = new FocusOrder()
    o.touch(1)
    o.touch(2)
    o.touch(3)
    o.touch(1)
    const items = [{ id: 9 }, { id: 3 }, { id: 2 }, { id: 1 }]
    expect(o.sort(items).map((x) => x.id)).toEqual([1, 3, 2, 9])
    expect(o.sort(items, (x) => x.id === 2).map((x) => x.id)).toEqual([2, 1, 3, 9])
    o.remove(1)
    expect(o.sort(items).map((x) => x.id)).toEqual([3, 2, 9, 1])
  })
})

describe('Electron wiring', () => {
  interface Win {
    id: number
    incognito: boolean
    popup: boolean
    profile: { id: string }
    win: { isDestroyed: () => boolean; isFocused: () => boolean; isMinimized: () => boolean; restore: () => void; focus: () => void }
    tabs: { create: (o: { url?: string; typed?: boolean; background?: boolean }) => unknown; made: unknown[] }
  }
  const makeWin = (id: number, incognito = false, popup = false, focusedNow = false): Win => {
    const made: unknown[] = []
    return {
      id,
      incognito,
      popup,
      profile: { id: 'p1' },
      win: { isDestroyed: () => false, isFocused: () => focusedNow, isMinimized: () => false, restore: vi.fn(), focus: vi.fn() },
      tabs: { made, create: (o) => (made.push(o), { id: made.length }) }
    }
  }
  const emit = (ev: string, ...args: unknown[]) => {
    for (const fn of h.appListeners.get(ev) ?? []) fn(...args)
  }
  const ev = () => ({ preventDefault: vi.fn() })

  beforeEach(() => {
    h.logs.length = 0
  })

  it('registers open-url/open-file, queues until ready, rejects bad schemes, routes to the last normal window', () => {
    installOpenRequestHandlers()
    installOpenRequestHandlers() // idempotent
    expect(h.appListeners.get('open-url')).toHaveLength(1)
    expect(h.appListeners.get('open-file')).toHaveLength(1)

    const e1 = ev()
    emit('open-url', e1, 'https://example.org/early')
    expect(e1.preventDefault).toHaveBeenCalled()
    for (const bad of ['retronet://settings', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts']) emit('open-url', ev(), bad)
    emit('open-file', ev(), '/nope/missing.html')
    expect(hasPendingOpenRequests()).toBe(true)
    expect(h.logs.filter((l) => l.startsWith('ignored an open-url'))).toHaveLength(4)
    expect(h.logs).toContain('ignored an open-file request')
    expect(h.logs.join('\n')).not.toMatch(/example|retronet:|etc\/hosts|missing/)

    const normalOld = makeWin(1)
    const normalNew = makeWin(2)
    const incog = makeWin(3, true, false, true) // focused right now, but incognito
    h.windows = [normalOld, normalNew, incog]
    for (const w of [normalOld, normalNew, incog]) h.wmListeners.created.forEach((l) => l(w))
    h.wmListeners.focused.forEach((l) => l(normalNew))
    h.wmListeners.focused.forEach((l) => l(incog))

    markOpenTargetReady({ profiles: { lastUsed: () => ({ id: 'p1' }) } as never })
    expect(hasPendingOpenRequests()).toBe(false)
    expect(normalNew.tabs.made).toEqual([{ url: 'https://example.org/early', typed: false, user: true, background: false }])
    expect(normalNew.win.focus).toHaveBeenCalled()
    expect(normalOld.tabs.made).toEqual([])
    expect(incog.tabs.made).toEqual([])

    // After ready: focus the old one, a new link goes there.
    h.wmListeners.focused.forEach((l) => l(normalOld))
    emit('open-url', ev(), 'https://example.org/late')
    expect(normalOld.tabs.made).toEqual([{ url: 'https://example.org/late', typed: false, user: true, background: false }])

    // A closed window is forgotten; with only incognito left, a new window of the last-used profile opens.
    const fresh = makeWin(9)
    vi.mocked(windowManager.createWindow).mockImplementation(() => fresh as never)
    for (const w of [normalOld, normalNew]) h.wmListeners.closed.forEach((l) => l(w))
    h.windows = [incog]
    const dir = mkdtempSync(join(tmpdir(), 'rn-x7-'))
    const file = join(dir, 'page.htm')
    writeFileSync(file, 'x')
    emit('open-file', ev(), file)
    expect(windowManager.createWindow).toHaveBeenCalledWith({ profile: { id: 'p1' } })
    expect(fresh.tabs.made).toEqual([{ url: pathToFileURL(file).href, typed: true, user: true }])
    expect(fresh.win.focus).toHaveBeenCalled()

    // second-instance argv goes through the same path (process.platform decides; macOS yields nothing).
    const before = fresh.tabs.made.length
    h.windows = [fresh, incog]
    const n = handleSecondInstanceArgv(['/opt/retronet/retronet', 'https://example.org/argv'], '/')
    expect(n).toBe(process.platform === 'darwin' ? 0 : 1)
    expect(fresh.tabs.made.length).toBe(before + n)

    // Quitting: nothing more opens.
    emit('before-quit')
    emit('open-url', ev(), 'https://example.org/after-quit')
    expect(fresh.tabs.made.length).toBe(before + n)
  })
})
