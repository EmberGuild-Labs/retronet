import { describe, expect, it, vi } from 'vitest'

// tab.ts (committedUrlFor) pulls in Electron values at load time; the guards themselves only use types.
vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn() },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    net: {},
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

import {
  decideBrowserNavigation,
  decideFrameNavigation,
  decidePdfViewerFrame,
  decidePageNavigation,
  decideRedirect,
  decideRetronetSubresource,
  decideWindowOpen,
  parsePopupFeatures,
  PDF_VIEWER_EXTENSION_ID,
  type NavDecision
} from '../../src/main/security/navigation-guards'
import { committedUrlFor } from '../../src/main/tabs/tab'

const WEB = 'https://example.com/page'
const INTERNAL = 'retronet://newtab/'

describe('decideBrowserNavigation (omnibox, bookmarks, commands)', () => {
  const cases: [string, { typed?: boolean }, NavDecision][] = [
    ['https://example.com/', {}, 'allow'],
    ['http://127.0.0.1:8080/', {}, 'allow'],
    ['about:blank', {}, 'allow'],
    ['retronet://settings/', {}, 'allow'],
    ['retronet://history/', {}, 'allow'],
    ['retronet://shell/', {}, 'block'],
    ['retronet://overlay/', {}, 'block'],
    ['RETRONET://SHELL/', {}, 'block'],
    ['file:///etc/hosts', { typed: true }, 'allow'],
    ['file:///etc/hosts', {}, 'block'],
    ['javascript:alert(1)', { typed: true }, 'block'],
    ['data:text/html,hi', {}, 'block'],
    ['mailto:a@b.test', {}, 'external'],
    ['tel:+15551234', {}, 'external'],
    ['ftp://x.test/', {}, 'block'],
    ['zoommtg://join', {}, 'block'],
    ['not a url', {}, 'block'],
    // AC54 view-source: http(s) inner URLs only, re-checked; typed never unlocks file: inside it.
    ['view-source:https://example.com/', {}, 'allow'],
    ['view-source:http://127.0.0.1:8080/a', {}, 'allow'],
    ['VIEW-SOURCE:HTTPS://example.com/', {}, 'allow'],
    ['view-source:file:///etc/hosts', {}, 'block'],
    ['view-source:file:///etc/hosts', { typed: true }, 'block'],
    ['view-source:retronet://newtab/', {}, 'block'],
    ['view-source:retronet://shell/', {}, 'block'],
    ['view-source:view-source:https://example.com/', {}, 'block'],
    ['view-source:javascript:alert(1)', {}, 'block'],
    ['view-source:data:text/html,x', {}, 'block'],
    ['view-source:about:blank', {}, 'block'],
    ['view-source:mailto:a@b.test', {}, 'block'],
    ['view-source:', {}, 'block'],
    // SPIKE-X1: a browser-initiated loadURL of the PDF viewer would load it (broken); it must stay blocked.
    [`chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`, {}, 'block'],
    [`chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`, { typed: true }, 'block']
  ]
  it.each(cases)('%s %o -> %s', (url, opts, want) => {
    expect(decideBrowserNavigation(url, opts)).toBe(want)
  })
})

describe('decidePageNavigation (will-navigate)', () => {
  const tab = (currentUrl: string, initiatorUrl?: string | null) => ({ kind: 'tab' as const, currentUrl, initiatorUrl })
  it('allows web links from web pages', () => {
    expect(decidePageNavigation('https://other.test/', tab(WEB))).toBe('allow')
    expect(decidePageNavigation('http://other.test/', tab(WEB))).toBe('allow')
    expect(decidePageNavigation('about:blank', tab(WEB))).toBe('allow')
  })
  it('blocks a hostile link from an http page to retronet://settings', () => {
    expect(decidePageNavigation('retronet://settings/', tab('http://evil.test/'))).toBe('block')
    expect(decidePageNavigation('retronet://certerror/?url=x', tab(WEB, WEB))).toBe('block')
    expect(decidePageNavigation('retronet://newtab/', tab('about:blank'))).toBe('block')
  })
  it('allows retronet links from internal pages, but not from a web initiator inside one', () => {
    expect(decidePageNavigation('retronet://history/', tab(INTERNAL, INTERNAL))).toBe('allow')
    expect(decidePageNavigation('retronet://history/', tab(INTERNAL, null))).toBe('allow')
    expect(decidePageNavigation('retronet://history/', tab(INTERNAL, 'https://evil.test/'))).toBe('block')
    expect(decidePageNavigation('https://example.com/', tab(INTERNAL, INTERNAL))).toBe('allow')
  })
  it('never lets a page reach the shell/overlay hosts, even from an internal page', () => {
    expect(decidePageNavigation('retronet://shell/', tab(INTERNAL, INTERNAL))).toBe('block')
    expect(decidePageNavigation('retronet://overlay/', tab(INTERNAL, INTERNAL))).toBe('block')
  })
  it('blocks file:, javascript:, data:, blob: and unknown schemes from pages', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://a/b', 'foo:bar', 'ms-settings:']) {
      expect(decidePageNavigation(url, tab(WEB))).toBe('block')
      expect(decidePageNavigation(url, tab(INTERNAL))).toBe('block')
    }
  })
  it('routes mailto/tel/sms to the external prompt', () => {
    expect(decidePageNavigation('mailto:a@b.test', tab(WEB))).toBe('external')
    expect(decidePageNavigation('tel:123', tab(WEB))).toBe('external')
    expect(decidePageNavigation('sms:123', tab(WEB))).toBe('external')
  })
  it('blocks every page navigation in the shell and overlay', () => {
    for (const url of ['https://example.com/', 'retronet://newtab/', 'mailto:a@b.test']) {
      expect(decidePageNavigation(url, { kind: 'ui', currentUrl: 'retronet://shell/' })).toBe('block')
    }
  })
})

describe('decideFrameNavigation (subframes)', () => {
  it('allows ordinary iframe content', () => {
    for (const url of ['https://ads.test/x', 'http://a.test/', 'about:blank', 'about:srcdoc', 'data:text/html,x', 'blob:https://a.test/1']) {
      expect(decideFrameNavigation(url, WEB)).toBe(true)
    }
  })
  it('blocks retronet iframes in web pages, file: and external/unknown schemes', () => {
    expect(decideFrameNavigation('retronet://settings/', WEB)).toBe(false)
    expect(decideFrameNavigation('retronet://newtab/', null)).toBe(false)
    expect(decideFrameNavigation('file:///etc/hosts', WEB)).toBe(false)
    expect(decideFrameNavigation('mailto:a@b.test', WEB)).toBe(false)
    expect(decideFrameNavigation('foo://x', WEB)).toBe(false)
    expect(decideFrameNavigation('javascript:1', WEB)).toBe(false)
  })
  it('allows retronet iframes only under a retronet parent, never shell/overlay', () => {
    expect(decideFrameNavigation('retronet://newtab/', INTERNAL)).toBe(true)
    expect(decideFrameNavigation('retronet://shell/', INTERNAL)).toBe(false)
  })
})

describe('decidePdfViewerFrame (SPIKE-X1 §1)', () => {
  const ID = PDF_VIEWER_EXTENSION_ID
  const INDEX = `chrome-extension://${ID}/index.html`
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const STREAM = `chrome-extension://${ID}/${UUID}`
  const PDF = 'https://example.com/doc.pdf'
  it('allows the stream frame under the viewer index under an http(s)/file PDF frame', () => {
    expect(decidePdfViewerFrame(STREAM, INDEX, PDF)).toBe(true)
    expect(decidePdfViewerFrame(STREAM, INDEX, 'http://127.0.0.1:8080/x.pdf')).toBe(true)
    expect(decidePdfViewerFrame(STREAM, INDEX, 'file:///tmp/a.pdf')).toBe(true)
  })
  it.each([
    ['another extension id', `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${UUID}`],
    ['index.html itself', INDEX],
    ['the root', `chrome-extension://${ID}/`],
    ['another path', `chrome-extension://${ID}/foo`],
    ['main.js', `chrome-extension://${ID}/main.js`],
    ['uppercase uuid', `chrome-extension://${ID}/${UUID.toUpperCase()}`],
    ['uuid plus extra path', `chrome-extension://${ID}/${UUID}/x`],
    ['extra path before the uuid', `chrome-extension://${ID}/a/${UUID}`],
    ['uuid with a query', `${STREAM}?x=1`],
    ['uuid with an empty query', `${STREAM}?`],
    ['uuid with a hash', `${STREAM}#p`],
    ['uuid with userinfo', `chrome-extension://u:p@${ID}/${UUID}`],
    ['uuid with a port', `chrome-extension://${ID}:99/${UUID}`],
    ['uppercase id', `chrome-extension://${ID.toUpperCase()}/${UUID}`],
    ['http with the same path', `https://${ID}/${UUID}`],
    ['garbage', 'not a url']
  ])('rejects %s', (_label, url) => {
    expect(decidePdfViewerFrame(url, INDEX, PDF)).toBe(false)
  })
  it.each([
    ['the tab main frame (http)', PDF],
    ['the viewer root', `chrome-extension://${ID}/`],
    ['index.html with a query', `${INDEX}?a`],
    ['another extension index', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html'],
    ['a retronet: page', INTERNAL],
    ['a nested stream frame', STREAM],
    ['no parent', null]
  ])('rejects a parent that is %s', (_label, parent) => {
    expect(decidePdfViewerFrame(STREAM, parent, PDF)).toBe(false)
  })
  it.each([
    ['retronet:', 'retronet://newtab/'],
    ['data:', 'data:application/pdf;base64,JVBERi0='],
    ['blob: (manager decision U1: no blob PDFs)', 'blob:https://example.com/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['about:', 'about:blank'],
    ['chrome-extension:', INDEX],
    ['view-source:', 'view-source:https://example.com/doc.pdf'],
    ['null', null],
    ['undefined', undefined]
  ])('rejects a %s grandparent', (_label, grand) => {
    expect(decidePdfViewerFrame(STREAM, INDEX, grand)).toBe(false)
  })
  it('the generic frame rule still refuses every chrome-extension: URL', () => {
    for (const url of [STREAM, INDEX, `chrome-extension://${ID}/`]) expect(decideFrameNavigation(url, INDEX)).toBe(false)
  })
})

describe('view-source: in page, frame and redirect guards (AC54)', () => {
  const VS = 'view-source:https://example.com/'
  it('a page can never navigate to view-source:, not even from a source view', () => {
    for (const cur of [WEB, INTERNAL, VS]) {
      for (const url of [VS, 'view-source:http://a.test/', 'VIEW-SOURCE:https://a.test/', 'view-source:file:///etc/hosts']) {
        expect(decidePageNavigation(url, { kind: 'tab', currentUrl: cur }), `${cur} -> ${url}`).toBe('block')
      }
    }
  })
  it('iframes and redirects to view-source: are refused', () => {
    expect(decideFrameNavigation(VS, WEB)).toBe(false)
    expect(decideFrameNavigation(VS, VS)).toBe(false)
    expect(decideRedirect(VS)).toBe(false)
  })
})

describe('committedUrlFor (tab.ts, SPIKE-X1 §2)', () => {
  it('a source view commits as its view-source: address; anything else as the event URL', () => {
    expect(committedUrlFor('http://h/page.html', 'view-source:http://h/page.html')).toBe('view-source:http://h/page.html')
    expect(committedUrlFor('http://h/page.html', 'http://h/page.html')).toBe('http://h/page.html')
    // A commit that is not the source view's page (a later navigation) keeps the event URL.
    expect(committedUrlFor('http://h/other.html', 'view-source:http://h/page.html')).toBe('http://h/other.html')
    expect(committedUrlFor('https://a.test/', '')).toBe('https://a.test/')
  })
})

describe('decideRedirect', () => {
  it('allows http(s) only', () => {
    expect(decideRedirect('https://a.test/')).toBe(true)
    expect(decideRedirect('http://a.test/')).toBe(true)
    for (const url of ['retronet://settings/', 'file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b', 'about:blank', '']) {
      expect(decideRedirect(url)).toBe(false)
    }
  })
})

describe('parsePopupFeatures', () => {
  it('reads and clamps geometry', () => {
    expect(parsePopupFeatures('width=500,height=600,left=10,top=20')).toEqual({ width: 500, height: 600, left: 10, top: 20 })
    expect(parsePopupFeatures('width=1, height=999999')).toEqual({ width: 100, height: 10000 })
    expect(parsePopupFeatures('popup=yes,noopener,menubar=no')).toEqual({})
    expect(parsePopupFeatures('innerWidth=400;screenX=5')).toEqual({ width: 400, left: 5 })
    expect(parsePopupFeatures('width=abc')).toEqual({})
  })
})

describe('decideWindowOpen', () => {
  const tabCtx = (openerUrl: string) => ({ kind: 'tab' as const, openerUrl })
  const d = (url: string, disposition: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other', features = '') => ({
    url,
    disposition,
    features
  })
  it('target=_blank -> foreground tab with opener', () => {
    expect(decideWindowOpen(d('https://a.test/', 'foreground-tab'), tabCtx(WEB))).toEqual({ action: 'tab', background: false, withOpener: true })
  })
  it('middle-click -> background tab', () => {
    expect(decideWindowOpen(d('https://a.test/', 'background-tab'), tabCtx(WEB))).toEqual({ action: 'tab', background: true, withOpener: true })
  })
  it('window.open with features -> popup (D4); without features -> tab', () => {
    expect(decideWindowOpen(d('https://login.test/', 'new-window', 'width=500,height=600'), tabCtx(WEB))).toEqual({
      action: 'popup',
      features: { width: 500, height: 600 }
    })
    expect(decideWindowOpen(d('https://a.test/', 'new-window'), tabCtx(WEB))).toEqual({ action: 'tab', background: false, withOpener: true })
    expect(decideWindowOpen(d('about:blank', 'new-window', 'popup'), tabCtx(WEB))).toEqual({ action: 'popup', features: {} })
  })
  it('denies retronet: from web pages, allows it (no opener) from internal pages', () => {
    expect(decideWindowOpen(d('retronet://settings/', 'foreground-tab'), tabCtx(WEB))).toEqual({ action: 'deny' })
    expect(decideWindowOpen(d('retronet://history/', 'foreground-tab'), tabCtx(INTERNAL))).toEqual({
      action: 'tab',
      background: false,
      withOpener: false
    })
    expect(decideWindowOpen(d('retronet://shell/', 'foreground-tab'), tabCtx(INTERNAL))).toEqual({ action: 'deny' })
  })
  it('S10: web pages opened from internal pages never get an opener (no popup either)', () => {
    for (const disp of ['foreground-tab', 'new-window', 'default'] as const) {
      expect(decideWindowOpen(d('https://a.test/', disp), tabCtx(INTERNAL))).toEqual({ action: 'tab', background: false, withOpener: false })
    }
    expect(decideWindowOpen(d('https://a.test/', 'new-window', 'width=400,height=300'), tabCtx(INTERNAL))).toEqual({
      action: 'tab',
      background: false,
      withOpener: false
    })
    expect(decideWindowOpen(d('https://a.test/', 'background-tab'), tabCtx(INTERNAL))).toEqual({ action: 'tab', background: true, withOpener: false })
  })
  it('external schemes go to the prompt, everything else is denied', () => {
    expect(decideWindowOpen(d('mailto:a@b.test', 'foreground-tab'), tabCtx(WEB))).toEqual({ action: 'external' })
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x', 'foo:bar', '::bad']) {
      expect(decideWindowOpen(d(url, 'foreground-tab'), tabCtx(WEB))).toEqual({ action: 'deny' })
    }
  })
  it('AC54: view-source: is always denied; a source view opens plain tabs without an opener', () => {
    for (const opener of [WEB, INTERNAL, 'view-source:https://example.com/']) {
      for (const url of ['view-source:https://a.test/', 'view-source:file:///etc/hosts', 'view-source:retronet://newtab/']) {
        expect(decideWindowOpen(d(url, 'foreground-tab'), tabCtx(opener))).toEqual({ action: 'deny' })
      }
    }
    const src = tabCtx('view-source:https://example.com/')
    expect(decideWindowOpen(d('https://example.com/other', 'foreground-tab'), src)).toEqual({ action: 'tab', background: false, withOpener: false })
    expect(decideWindowOpen(d('https://a.test/', 'new-window', 'width=400,height=300'), src)).toEqual({
      action: 'tab',
      background: false,
      withOpener: false
    })
    expect(decideWindowOpen(d('https://a.test/', 'background-tab'), src)).toEqual({ action: 'tab', background: true, withOpener: false })
    expect(decideWindowOpen(d('retronet://settings/', 'foreground-tab'), src)).toEqual({ action: 'deny' })
  })
  it('the shell and overlay never open windows', () => {
    expect(decideWindowOpen(d('https://a.test/', 'foreground-tab'), { kind: 'ui', openerUrl: 'retronet://shell/' })).toEqual({ action: 'deny' })
  })
})

describe('decideRetronetSubresource', () => {
  it('blocks an <img src=retronet://...> embed from an http page', () => {
    expect(decideRetronetSubresource({ resourceType: 'image', initiatorOrigin: 'http://127.0.0.1:5000', frameUrl: 'http://127.0.0.1:5000/' })).toBe(false)
    expect(decideRetronetSubresource({ resourceType: 'image', frameUrl: 'https://evil.test/' })).toBe(false)
    expect(decideRetronetSubresource({ resourceType: 'script', webContentsUrl: 'https://evil.test/' })).toBe(false)
  })
  it('allows assets requested by retronet pages', () => {
    expect(decideRetronetSubresource({ resourceType: 'image', initiatorOrigin: 'retronet://newtab', frameUrl: INTERNAL })).toBe(true)
    expect(decideRetronetSubresource({ resourceType: 'stylesheet', frameUrl: INTERNAL })).toBe(true)
    expect(decideRetronetSubresource({ resourceType: 'font', webContentsUrl: 'retronet://shell/' })).toBe(true)
  })
  it('initiator origin wins over a retronet frame url', () => {
    expect(decideRetronetSubresource({ resourceType: 'image', initiatorOrigin: 'https://evil.test', frameUrl: INTERNAL })).toBe(false)
  })
  it('leaves main frames to the guards and refuses subframes and unattributed requests', () => {
    expect(decideRetronetSubresource({ resourceType: 'mainFrame', frameUrl: WEB })).toBe(true)
    expect(decideRetronetSubresource({ resourceType: 'subFrame', initiatorOrigin: 'retronet://newtab' })).toBe(false)
    expect(decideRetronetSubresource({ resourceType: 'xhr' })).toBe(false)
  })
})
