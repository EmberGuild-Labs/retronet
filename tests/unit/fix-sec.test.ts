// FIX-SEC: pure helpers in tab.ts (S2 favicon policy, error texts, beforeunload prompt) and window-manager.ts
// (S4 window title, S11 popup clamp).
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn() },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

import {
  errorStatusFor,
  faviconAllowed,
  isFaviconMime,
  isPrivateHost,
  siteOf,
  unloadPromptOptions
} from '../../src/main/tabs/tab'
import { clampToWorkArea, fullscreenHostOf, INCOGNITO_WINDOW_TITLE, windowTitleFor } from '../../src/main/windows/window-manager'

describe('S2 favicon policy', () => {
  it('same-site only', () => {
    expect(faviconAllowed('https://www.example.com/a', 'https://www.example.com/favicon.ico')).toBe(true)
    expect(faviconAllowed('https://www.example.com/a', 'https://static.example.com/i.png')).toBe(true)
    expect(faviconAllowed('https://a.example.co.uk/', 'https://cdn.example.co.uk/i.png')).toBe(true)
    expect(faviconAllowed('https://a.example.co.uk/', 'https://other.co.uk/i.png')).toBe(false)
    expect(faviconAllowed('https://news.example/', 'https://tracker.test/pixel.png')).toBe(false)
    expect(faviconAllowed('https://alice.github.io/', 'https://bob.github.io/i.png')).toBe(false)
  })
  it('never private/loopback targets from a public page; local pages may use their own host', () => {
    expect(faviconAllowed('https://evil.example/', 'http://127.0.0.1/admin.png')).toBe(false)
    expect(faviconAllowed('https://evil.example/', 'http://192.168.1.1/x.png')).toBe(false)
    expect(faviconAllowed('https://evil.example/', 'http://localhost:8080/x.png')).toBe(false)
    expect(faviconAllowed('https://evil.example/', 'http://[::1]/x.png')).toBe(false)
    expect(faviconAllowed('http://127.0.0.1:5000/', 'http://127.0.0.1:5000/fav.png')).toBe(true)
    expect(faviconAllowed('http://127.0.0.1:5000/', 'http://localhost:5000/fav.png')).toBe(false)
    expect(faviconAllowed('http://192.168.1.10/', 'http://192.168.1.11/fav.png')).toBe(false)
  })
  it('scheme rules: http(s) only, no downgrade from https, no userinfo, only web pages', () => {
    expect(faviconAllowed('https://a.example/', 'http://a.example/i.png')).toBe(false)
    expect(faviconAllowed('http://a.example/', 'https://a.example/i.png')).toBe(true)
    expect(faviconAllowed('https://a.example/', 'https://u:p@a.example/i.png')).toBe(false)
    expect(faviconAllowed('https://a.example/', 'file:///etc/passwd')).toBe(false)
    expect(faviconAllowed('retronet://newtab/', 'https://a.example/i.png')).toBe(false)
    expect(faviconAllowed('nonsense', 'https://a.example/i.png')).toBe(false)
  })
  it('isPrivateHost', () => {
    for (const h of ['localhost', 'a.localhost', 'printer.local', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '127.5.5.5', '[::1]', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'intranet']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) expect(isPrivateHost(h), h).toBe(false)
  })
  it('siteOf', () => {
    expect(siteOf('a.b.example.com')).toBe('example.com')
    expect(siteOf('x.example.co.uk')).toBe('example.co.uk')
    expect(siteOf('Example.COM.')).toBe('example.com')
    expect(siteOf('1.2.3.4')).toBe('1.2.3.4')
  })
  it('strict MIME allowlist', () => {
    for (const t of ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/jpeg', 'image/webp', 'image/svg+xml']) expect(isFaviconMime(t), t).toBe(true)
    for (const t of ['text/html', 'image/', 'image/png2', 'application/octet-stream', 'image/png; x', '']) expect(isFaviconMime(t), t).toBe(false)
  })
})

describe('status error texts (DESIGN 3.4)', () => {
  it('maps the common net errors', () => {
    expect(errorStatusFor(-102)).toBe('Error: connection refused.')
    expect(errorStatusFor(-105)).toBe('Error: host not found.')
    expect(errorStatusFor(-118)).toBe('Error: connection timed out.')
    expect(errorStatusFor(-106)).toBe('Error: you are offline.')
    expect(errorStatusFor(-202)).toBe('Error: certificate problem.')
    expect(errorStatusFor(-312)).toBe('Error: port not allowed.')
    expect(errorStatusFor(-999)).toBe('Error: the page could not be loaded.')
  })
})

describe('beforeunload prompt', () => {
  it('stay is default and cancel; proceed is button 1', () => {
    for (const r of ['leave', 'close', 'reload'] as const) {
      const { options, proceedId } = unloadPromptOptions(r)
      expect(options.defaultId).toBe(0)
      expect(options.cancelId).toBe(0)
      expect(proceedId).toBe(1)
      expect(options.buttons).toHaveLength(2)
    }
    expect(unloadPromptOptions('leave').options.message).toBe('Leave site?')
    expect(unloadPromptOptions('close').options.buttons).toEqual(['Stay', 'Leave'])
    expect(unloadPromptOptions('reload').options.message).toBe('Reload site?')
    expect(unloadPromptOptions('reload').options.buttons).toEqual(['Cancel', 'Reload'])
  })
})

describe('S4 window title', () => {
  it('incognito never shows page titles', () => {
    expect(windowTitleFor(true, 'My Secret Page')).toBe(INCOGNITO_WINDOW_TITLE)
    expect(INCOGNITO_WINDOW_TITLE).toBe('RetroNet - Incognito')
    expect(windowTitleFor(false, ' Page ')).toBe('Page - RetroNet')
    expect(windowTitleFor(false, '')).toBe('RetroNet')
  })
})

describe('S11 popup clamp + fullscreen host', () => {
  const wa = { x: 0, y: 25, width: 1440, height: 875 }
  it('pulls off-screen popups into the work area and caps the size', () => {
    expect(clampToWorkArea({ x: -10000, y: -10000, width: 400, height: 300 }, wa)).toEqual({ x: 0, y: 25, width: 400, height: 300 })
    expect(clampToWorkArea({ x: 10000, y: 10000, width: 400, height: 300 }, wa)).toEqual({ x: 1040, y: 600, width: 400, height: 300 })
    expect(clampToWorkArea({ x: 5, y: 5, width: 9000, height: 9000 }, wa)).toEqual({ x: 0, y: 25, width: 1440, height: 875 })
  })
  it('keeps in-range values, uses the default size when none is given, leaves missing positions out', () => {
    expect(clampToWorkArea({ x: 100, y: 100, width: 500, height: 400 }, wa)).toEqual({ x: 100, y: 100, width: 500, height: 400 })
    expect(clampToWorkArea({ x: 5000, y: 5000 }, wa)).toEqual({ x: 800, y: 380 })
    expect(clampToWorkArea({ width: 300 }, wa)).toEqual({ width: 300 })
    expect(clampToWorkArea({ x: 10 }, wa)).toEqual({})
  })
  it('fullscreenHostOf shows the host only', () => {
    expect(fullscreenHostOf('https://video.example:8443/watch?v=1')).toBe('video.example:8443')
    expect(fullscreenHostOf('file:///Users/x/a.html')).toBe('file')
    expect(fullscreenHostOf('')).toBe('')
  })
})
