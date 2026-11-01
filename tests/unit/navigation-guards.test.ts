import { describe, expect, it } from 'vitest'
import {
  decideBrowserNavigation,
  decideFrameNavigation,
  decidePageNavigation,
  decideRedirect,
  decideRetronetSubresource,
  decideWindowOpen,
  parsePopupFeatures,
  type NavDecision
} from '../../src/main/security/navigation-guards'

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
    ['not a url', {}, 'block']
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
