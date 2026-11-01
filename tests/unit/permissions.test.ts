import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ systemPreferences: {}, session: {} }))
vi.mock('../../src/main/ipc/router', () => ({ router: { handle: vi.fn() } }))
vi.mock('../../src/main/windows/window-manager', () => ({
  windowManager: { onWindowClosed: vi.fn(), get: vi.fn(), fromWebContents: vi.fn() }
}))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { createPermissionStore } from '../../src/main/storage/permission-store'
import {
  createPermissionController,
  PERMISSION_TIMEOUT_MS,
  permissionKey,
  promptBounds,
  promptedKinds,
  webOrigin,
  type WcLike,
  type WindowLike
} from '../../src/main/security/permissions'

type TestWin = WindowLike & { shown: any[]; setKind(k: string | null): void }
function mkWin(id = 1): TestWin {
  let kind: string | null = null
  const shown: any[] = []
  return {
    id,
    insets: { top: 80, bottom: 20 },
    tabs: { tabIdFor: () => 1 },
    showOverlay: (ev: any) => {
      kind = ev.kind
      shown.push(ev)
    },
    hideOverlay: () => void (kind = null),
    overlayKind: () => kind,
    shown,
    setKind: (k) => void (kind = k)
  } as TestWin
}
function mkWc(url = 'https://a.example/page') {
  const handlers: Record<string, (...a: any[]) => void> = {}
  const wc: WcLike & { fire(e: string, ...a: any[]): void } = {
    id: 1,
    getURL: () => url,
    isDestroyed: () => false,
    on: (e, l) => void (handlers[e] = l),
    fire: (e, ...a) => handlers[e]?.(...a)
  }
  return wc
}

let store = createPermissionStore(null)
let win = mkWin()
let osAccess = vi.fn(async (_k: 'camera' | 'microphone') => true)
const mk = () => createPermissionController({ store, windowFor: () => win, osAccess })
const ask = (c: ReturnType<typeof mk>, wc: WcLike, perm: string, details: any = { requestingUrl: wc.getURL() }) => {
  const cb = vi.fn()
  c.handleRequest(wc, perm, cb, details)
  return cb
}

beforeEach(() => {
  vi.useFakeTimers()
  store = createPermissionStore(null)
  win = mkWin()
  osAccess = vi.fn(async () => true)
})
afterEach(() => vi.useRealTimers())

describe('helpers', () => {
  it('maps kinds and origins', () => {
    expect(promptedKinds('media', ['video', 'audio'])).toEqual(['camera', 'microphone'])
    expect(promptedKinds('media', [])).toEqual([])
    expect(promptedKinds('midi')).toEqual([])
    expect(webOrigin('https://a.example/x?y')).toBe('https://a.example')
    expect(webOrigin('retronet://newtab/')).toBeNull()
    expect(webOrigin('file:///etc/passwd')).toBeNull()
    expect(webOrigin('nonsense')).toBeNull()
  })
})

describe('request handler', () => {
  it('denies unlisted types without a prompt', () => {
    const c = mk()
    for (const p of ['midi', 'hid', 'serial', 'usb', 'openExternal', 'pointerLock', 'display-capture', 'idle-detection', 'storage-access', 'weird']) {
      expect(ask(c, mkWc(), p)).toHaveBeenCalledWith(false)
    }
    expect(win.shown).toHaveLength(0)
  })

  it('allows fullscreen and clipboard-sanitized-write on web pages only', () => {
    const c = mk()
    expect(ask(c, mkWc(), 'fullscreen')).toHaveBeenCalledWith(true)
    expect(ask(c, mkWc(), 'clipboard-sanitized-write')).toHaveBeenCalledWith(true)
    const wc = mkWc('retronet://newtab/')
    expect(ask(c, wc, 'fullscreen')).toHaveBeenCalledWith(false)
  })

  it('never prompts for retronet: pages or when there is no window', () => {
    const c = mk()
    expect(ask(c, mkWc('retronet://about/'), 'geolocation')).toHaveBeenCalledWith(false)
    const none = createPermissionController({ store, windowFor: () => null, osAccess })
    expect(ask(none, mkWc(), 'geolocation')).toHaveBeenCalledWith(false)
    expect(win.shown).toHaveLength(0)
  })

  it('shows a prompt and denies on 60 s timeout', () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'geolocation')
    expect(win.shown).toHaveLength(1)
    expect(win.shown[0].request).toMatchObject({ origin: 'https://a.example', host: 'a.example', kinds: ['geolocation'], position: 1, total: 1 })
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PERMISSION_TIMEOUT_MS)
    expect(cb).toHaveBeenCalledWith(false)
    expect(win.overlayKind()).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('Allow without remember grants once and stores nothing', async () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'notifications')
    c.respond(1, win.shown[0].request.id, 'allow', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb).toHaveBeenCalledWith(true)
    expect(store.list()).toEqual([])
  })

  it('Block + remember persists and later requests are denied without a prompt', () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'geolocation')
    c.respond(1, win.shown[0].request.id, 'block', true)
    expect(cb).toHaveBeenCalledWith(false)
    expect(store.get('https://a.example', 'geolocation')).toBe('block')
    win.shown.length = 0
    expect(ask(c, mkWc(), 'geolocation')).toHaveBeenCalledWith(false)
    expect(win.shown).toHaveLength(0)
  })

  it('Allow + remember is answered silently next time and by the check handler', async () => {
    const c = mk()
    ask(c, mkWc(), 'clipboard-read')
    c.respond(1, win.shown[0].request.id, 'allow', true)
    await vi.advanceTimersByTimeAsync(0)
    win.shown.length = 0
    const cb = ask(c, mkWc(), 'clipboard-read')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb).toHaveBeenCalledWith(true)
    expect(win.shown).toHaveLength(0)
    expect(c.check(mkWc(), 'clipboard-read', 'https://a.example/', {})).toBe(true)
    expect(c.check(mkWc(), 'clipboard-read', 'https://b.example', {})).toBe(false)
  })

  it('Dismiss denies and is not remembered', () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'geolocation')
    c.respond(1, win.shown[0].request.id, 'dismiss', true)
    expect(cb).toHaveBeenCalledWith(false)
    expect(store.list()).toEqual([])
  })

  it('S6: keys decisions by (requesting origin, top-level origin) and names the top host + embedder', async () => {
    const c = mk()
    ask(c, mkWc('https://top.example/'), 'geolocation', { requestingUrl: 'https://embed.example/frame' })
    expect(win.shown[0].request).toMatchObject({ origin: 'https://embed.example', host: 'top.example', embeddedFrom: 'embed.example' })
    c.respond(1, win.shown[0].request.id, 'allow', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(permissionKey('https://embed.example', 'https://top.example')).toBe('https://embed.example on https://top.example')
    expect(store.get('https://embed.example on https://top.example', 'geolocation')).toBe('allow')
    expect(store.get('https://embed.example', 'geolocation')).toBeNull()
    expect(store.get('https://top.example', 'geolocation')).toBeNull()
    // Same frame inside another top-level page: asked again (not silently allowed).
    win.shown.length = 0
    const cb = ask(c, mkWc('https://evil.example/'), 'geolocation', { requestingUrl: 'https://embed.example/frame' })
    expect(cb).not.toHaveBeenCalled()
    expect(win.shown).toHaveLength(1)
    expect(win.shown[0].request).toMatchObject({ host: 'evil.example', embeddedFrom: 'embed.example' })
    // Check handler follows the same key (embeddingOrigin for subframes).
    expect(c.check(mkWc('https://top.example/'), 'geolocation', 'https://embed.example', { embeddingOrigin: 'https://top.example' })).toBe(true)
    expect(c.check(mkWc('https://evil.example/'), 'geolocation', 'https://embed.example', { embeddingOrigin: 'https://evil.example' })).toBe(false)
    expect(c.check(mkWc('https://embed.example/'), 'geolocation', 'https://embed.example', {})).toBe(false)
  })

  it('S6: a top-level request has no embeddedFrom and is keyed by the plain origin', () => {
    const c = mk()
    ask(c, mkWc('https://a.example/x'), 'geolocation')
    expect(win.shown[0].request.embeddedFrom).toBeUndefined()
    expect(win.shown[0].request.host).toBe('a.example')
    c.respond(1, win.shown[0].request.id, 'block', true)
    expect(store.get('https://a.example', 'geolocation')).toBe('block')
  })

  it('splits media into camera and microphone and asks the OS after Allow', async () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'media', { requestingUrl: 'https://a.example/', mediaTypes: ['video', 'audio'] })
    expect(win.shown[0].request.kinds).toEqual(['camera', 'microphone'])
    c.respond(1, win.shown[0].request.id, 'allow', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(osAccess.mock.calls.map((x) => x[0])).toEqual(['camera', 'microphone'])
    expect(cb).toHaveBeenCalledWith(true)
    expect(store.get('https://a.example', 'camera')).toBe('allow')
  })

  it('denies when the OS refuses camera access, and still remembers the user choice', async () => {
    osAccess = vi.fn(async () => false)
    const c = mk()
    const cb = ask(c, mkWc(), 'media', { requestingUrl: 'https://a.example/', mediaTypes: ['video'] })
    c.respond(1, win.shown[0].request.id, 'allow', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb).toHaveBeenCalledWith(false)
    expect(store.get('https://a.example', 'camera')).toBe('allow')
  })

  it('only prompts for the unresolved kind when the other is remembered', () => {
    store.set('https://a.example', 'camera', 'allow')
    const c = mk()
    ask(c, mkWc(), 'media', { requestingUrl: 'https://a.example/', mediaTypes: ['video', 'audio'] })
    expect(win.shown[0].request.kinds).toEqual(['microphone'])
  })

  it('a remembered block on either kind denies the whole media request', () => {
    store.set('https://a.example', 'microphone', 'block')
    const c = mk()
    expect(ask(c, mkWc(), 'media', { requestingUrl: 'https://a.example/', mediaTypes: ['video', 'audio'] })).toHaveBeenCalledWith(false)
    expect(win.shown).toHaveLength(0)
  })

  it('queues requests per window, one prompt at a time, with position/total', () => {
    const c = mk()
    const a = ask(c, mkWc(), 'geolocation')
    const b = ask(c, mkWc('https://b.example/'), 'notifications')
    // The second request is queued behind the first: the overlay re-renders with total 2.
    expect(win.shown.at(-1).request).toMatchObject({ host: 'a.example', position: 1, total: 2 })
    c.respond(1, win.shown.at(-1).request.id, 'block', false)
    expect(a).toHaveBeenCalledWith(false)
    expect(win.shown.at(-1).request).toMatchObject({ host: 'b.example', position: 1, total: 1 })
    c.respond(1, win.shown.at(-1).request.id, 'block', false)
    expect(b).toHaveBeenCalledWith(false)
    expect(win.overlayKind()).toBeNull()
  })

  it('auto-denies pending requests on main-frame navigation but not in-page or subframe navigation', () => {
    const c = mk()
    const wc = mkWc()
    const cb = ask(c, wc, 'geolocation')
    wc.fire('did-start-navigation', {}, 'https://a.example/#x', true, true)
    wc.fire('did-start-navigation', {}, 'https://z.example/', false, false)
    expect(cb).not.toHaveBeenCalled()
    wc.fire('did-start-navigation', {}, 'https://other.example/', false, true)
    expect(cb).toHaveBeenCalledWith(false)
    expect(win.overlayKind()).toBeNull()
  })

  it('auto-denies on tab close and window close', () => {
    const c = mk()
    const wc = mkWc()
    const cb = ask(c, wc, 'geolocation')
    wc.fire('destroyed')
    expect(cb).toHaveBeenCalledWith(false)
    const cb2 = ask(c, mkWc(), 'notifications')
    c.cancelWindow(1)
    expect(cb2).toHaveBeenCalledWith(false)
  })

  it('does not replace another overlay, retries until it closes', () => {
    win.setKind('palette')
    const c = mk()
    ask(c, mkWc(), 'geolocation')
    expect(win.shown).toHaveLength(0)
    win.setKind(null)
    vi.advanceTimersByTime(500)
    expect(win.shown).toHaveLength(1)
  })

  it('ignores responses from another window, unknown ids and repeats', () => {
    const c = mk()
    const cb = ask(c, mkWc(), 'geolocation')
    const id = win.shown[0].request.id
    expect(c.respond(2, id, 'allow', true)).toBe(false)
    expect(c.respond(1, 'nope', 'allow', true)).toBe(false)
    expect(cb).not.toHaveBeenCalled()
    expect(c.respond(1, id, 'block', false)).toBe(true)
    expect(c.respond(1, id, 'allow', true)).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('check handler', () => {
  it('answers only from the store', () => {
    store.set('https://a.example', 'geolocation', 'allow')
    store.set('https://a.example', 'camera', 'allow')
    const c = mk()
    const wc = mkWc()
    expect(c.check(wc, 'geolocation', 'https://a.example', {})).toBe(true)
    expect(c.check(wc, 'notifications', 'https://a.example', {})).toBe(false)
    expect(c.check(wc, 'media', 'https://a.example', { mediaType: 'video' })).toBe(true)
    expect(c.check(wc, 'media', 'https://a.example', { mediaType: 'audio' })).toBe(false)
    expect(c.check(wc, 'media', 'https://a.example', {})).toBe(true)
    expect(c.check(wc, 'fullscreen', 'https://a.example', {})).toBe(true)
    expect(c.check(wc, 'midi', 'https://a.example', {})).toBe(false)
  })

  it('denies non-web origins and retronet: top-level pages', () => {
    store.set('https://a.example', 'geolocation', 'allow')
    const c = mk()
    expect(c.check(mkWc('retronet://about/'), 'geolocation', 'https://a.example', {})).toBe(false)
    expect(c.check(null, 'geolocation', 'retronet://about', {})).toBe(false)
    expect(c.check(null, 'fullscreen', 'null', {})).toBe(false)
  })
})

describe('prompt placement (page stays usable)', () => {
  it('promptBounds covers only the box around the prompt', () => {
    expect(promptBounds({ x: 40, y: 70, width: 16, height: 0 }, 1200)).toEqual({ x: 0, y: 0, width: 424, height: 330 })
    expect(promptBounds({ x: 40, y: 70, width: 16, height: 0 }, 300).width).toBe(300)
  })
  it('anchors to the measured security icon and passes bounds; falls back when unmeasured', async () => {
    const shown: any[] = []
    const w = { ...mkWin(), showOverlay: (ev: any, opts: any) => shown.push({ ev, opts }), overlayKind: () => null, tabBounds: () => ({ x: 0, y: 90, width: 1000, height: 600 }) }
    const c = createPermissionController({ store, windowFor: () => w, osAccess, securityAnchor: async () => ({ x: 52, y: 64, width: 16, height: 0 }) })
    ask(c, mkWc(), 'geolocation')
    await vi.advanceTimersByTimeAsync(0)
    expect(shown[0].ev.anchor).toEqual({ x: 52, y: 64, width: 16, height: 0 })
    expect(shown[0].opts).toEqual({ focus: true, bounds: { x: 0, y: 0, width: 436, height: 324 } })
    const shown2: any[] = []
    const w2 = { ...w, showOverlay: (ev: any, opts: any) => shown2.push({ ev, opts }) }
    const c2 = createPermissionController({ store, windowFor: () => w2, osAccess, securityAnchor: async () => null })
    ask(c2, mkWc(), 'notifications')
    await vi.advanceTimersByTimeAsync(0)
    expect(shown2[0].ev.anchor).toMatchObject({ x: 8, y: 76 })
    expect(shown2[0].opts.bounds.height).toBe(336)
  })
})
