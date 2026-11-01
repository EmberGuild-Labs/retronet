import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripUrlCredentials } from '../../src/main/storage/url-credentials'
import {
  displayPartsFor,
  displayUrl,
  omniboxSegments,
  isExternalAllowlisted,
  isWebViewSource,
  navigationSchemeAllowed,
  securityStateFor,
  viewSourceInner
} from '@shared/url-safety'

describe('navigationSchemeAllowed', () => {
  const web = 'https://example.com/'
  const cases: [string, Parameters<typeof navigationSchemeAllowed>[1], boolean][] = [
    ['https://example.com', {}, true],
    ['http://example.com', {}, true],
    ['about:blank', {}, true],
    ['about:config', {}, false],
    ['javascript:alert(1)', {}, false],
    ['javascript:alert(1)', { browserInitiated: true, typed: true }, false],
    ['data:text/html,x', { browserInitiated: true }, false],
    ['blob:https://example.com/x', {}, false],
    ['mailto:a@b.com', {}, false],
    ['chrome://settings', { browserInitiated: true }, false],
    ['not a url', {}, false],
    ['retronet://settings', { currentUrl: web }, false],
    ['retronet://settings', { currentUrl: 'retronet://newtab/' }, true],
    ['retronet://settings', { browserInitiated: true }, true],
    ['retronet://settings', {}, false],
    ['file:///tmp/a.html', {}, false],
    ['file:///tmp/a.html', { browserInitiated: true }, false],
    ['file:///tmp/a.html', { currentUrl: web, typed: true }, false],
    ['file:///tmp/a.html', { browserInitiated: true, typed: true }, true]
  ]
  it.each(cases)('%s %j -> %s', (url, ctx, expected) => {
    expect(navigationSchemeAllowed(url, ctx)).toBe(expected)
  })
})

describe('isExternalAllowlisted', () => {
  it.each([
    ['mailto:a@b.com', true],
    ['MAILTO:a@b.com', true],
    ['tel:+15551234', true],
    ['sms:+15551234', true],
    ['https://example.com', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['ssh://host', false],
    ['smb://host/share', false],
    ['garbage', false]
  ])('%s -> %s', (url, expected) => {
    expect(isExternalAllowlisted(url)).toBe(expected)
  })
})

describe('securityStateFor', () => {
  it.each([
    ['https://example.com', false, 'secure'],
    ['https://example.com', true, 'cert-warning'],
    ['http://example.com', false, 'insecure'],
    ['http://example.com', true, 'insecure'],
    ['retronet://settings', false, 'internal'],
    ['about:blank', false, 'internal'],
    ['file:///tmp/a', false, 'file'],
    ['garbage', false, 'insecure'],
    ['view-source:https://example.com/', false, 'secure'],
    ['view-source:https://example.com/', true, 'cert-warning'],
    ['view-source:http://example.com/', false, 'insecure'],
    ['VIEW-SOURCE:HTTPS://example.com/', false, 'secure'],
    ['view-source:retronet://settings/', false, 'insecure'],
    ['view-source:file:///etc/hosts', false, 'insecure'],
    ['view-source:view-source:https://example.com/', false, 'insecure']
  ])('%s override=%s -> %s', (url, override, expected) => {
    expect(securityStateFor(url, override)).toBe(expected)
  })
})

describe('displayPartsFor', () => {
  it('splits a normal https url', () => {
    expect(displayPartsFor('https://www.example.com:8443/a?b=1#c')).toEqual({
      scheme: 'https',
      host: 'www.example.com',
      hostPort: 'www.example.com:8443',
      rest: '/a?b=1#c',
      isIdn: false,
      hasCredentials: false,
      emphasizeHost: true
    })
  })
  it('drops a bare root path', () => {
    expect(displayPartsFor('https://example.com/')?.rest).toBe('')
  })
  it('shows IDN hosts as punycode and flags them', () => {
    const p = displayPartsFor('https://аррӏе.com/')
    expect(p?.host).toBe('xn--80ak6aa92e.com')
    expect(p?.isIdn).toBe(true)
  })
  it('flags credentials and keeps the real host', () => {
    const p = displayPartsFor('https://google.com@evil.example/')
    expect(p?.host).toBe('evil.example')
    expect(p?.hasCredentials).toBe(true)
  })
  it('does not emphasise the host of internal urls', () => {
    expect(displayPartsFor('retronet://settings/')?.emphasizeHost).toBe(false)
  })
  it('returns null for garbage', () => {
    expect(displayPartsFor('not a url')).toBeNull()
  })
})

describe('displayUrl / omniboxSegments (D11, Q6)', () => {
  it('leaves ordinary URLs byte-for-byte unchanged', () => {
    expect(displayUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(displayUrl('retronet://settings/')).toBe('retronet://settings/')
    expect(displayUrl('not a url')).toBe('not a url')
  })
  it('strips a username so a fake host prefix cannot pose as the real host', () => {
    expect(displayUrl('http://www.google.com@127.0.0.1:49322/')).toBe('http://127.0.0.1:49322/')
  })
  it('never shows a password', () => {
    const shown = displayUrl('http://qa:pw@127.0.0.1:8080/auth?x=1')
    expect(shown).toBe('http://127.0.0.1:8080/auth?x=1')
    expect(shown).not.toContain('pw')
  })
  it('strips a password-only userinfo too', () => {
    expect(displayUrl('https://:secret@example.com/')).toBe('https://example.com/')
  })
  it('splits a web URL into dim scheme, emphasised host, dim rest', () => {
    expect(omniboxSegments('https://www.example.com:8443/a?b=1#c')).toEqual({
      text: 'https://www.example.com:8443/a?b=1#c',
      before: 'https://',
      host: 'www.example.com',
      after: ':8443/a?b=1#c'
    })
  })
  it('emphasises the REAL host of a userinfo URL', () => {
    const s = omniboxSegments('http://www.google.com@evil.example/login')
    expect(s?.host).toBe('evil.example')
    expect(s?.text).toBe('http://evil.example/login')
    expect(`${s?.before}${s?.host}${s?.after}`).toBe(s?.text)
  })
  it('keeps IDN hosts in punycode', () => {
    expect(omniboxSegments('https://xn--pple-43d.com/')?.host).toBe('xn--pple-43d.com')
  })
  it('handles IPv6 hosts', () => {
    const s = omniboxSegments('http://[::1]:8080/x')
    expect(s?.host).toBe('[::1]')
    expect(s?.after).toBe(':8080/x')
  })
  it('does not emphasise internal or file URLs', () => {
    expect(omniboxSegments('retronet://settings/')).toBeNull()
    expect(omniboxSegments('file:///Users/me/a.html')).toBeNull()
    expect(omniboxSegments('about:blank')).toBeNull()
    expect(omniboxSegments('hello world')).toBeNull()
  })
})

describe('view-source: (AC54)', () => {
  it('viewSourceInner returns the text after the scheme, any case', () => {
    expect(viewSourceInner('view-source:https://a.test/x?y#z')).toBe('https://a.test/x?y#z')
    expect(viewSourceInner('VIEW-SOURCE:http://a.test/')).toBe('http://a.test/')
    expect(viewSourceInner('view-source:view-source:http://a.test/')).toBe('view-source:http://a.test/')
    expect(viewSourceInner('https://a.test/')).toBeNull()
    expect(viewSourceInner('garbage')).toBeNull()
  })
  it('isWebViewSource: only an http(s) inner URL', () => {
    expect(isWebViewSource('view-source:https://a.test/')).toBe(true)
    expect(isWebViewSource('view-source:HTTP://a.test/')).toBe(true)
    for (const u of [
      'view-source:file:///etc/hosts',
      'view-source:retronet://newtab/',
      'view-source:view-source:https://a.test/',
      'view-source:javascript:alert(1)',
      'view-source:data:text/html,x',
      'view-source:about:blank',
      'view-source:blob:https://a.test/1',
      'view-source:chrome-extension://x/y',
      'view-source: https://a.test/',
      'view-source:',
      'https://a.test/'
    ]) {
      expect(isWebViewSource(u), u).toBe(false)
    }
  })
  it('navigationSchemeAllowed: browser-initiated only, http(s) inner only', () => {
    const vs = 'view-source:https://example.com/'
    expect(navigationSchemeAllowed(vs, { browserInitiated: true })).toBe(true)
    expect(navigationSchemeAllowed('VIEW-SOURCE:http://example.com/', { browserInitiated: true })).toBe(true)
    expect(navigationSchemeAllowed(vs, {})).toBe(false)
    expect(navigationSchemeAllowed(vs, { currentUrl: 'https://example.com/' })).toBe(false)
    expect(navigationSchemeAllowed(vs, { currentUrl: vs })).toBe(false)
    expect(navigationSchemeAllowed(vs, { currentUrl: 'retronet://newtab/' })).toBe(false)
    expect(navigationSchemeAllowed('view-source:file:///etc/hosts', { browserInitiated: true, typed: true })).toBe(false)
    expect(navigationSchemeAllowed('view-source:retronet://settings/', { browserInitiated: true })).toBe(false)
    expect(navigationSchemeAllowed('view-source:view-source:https://example.com/', { browserInitiated: true })).toBe(false)
    expect(navigationSchemeAllowed('view-source:javascript:alert(1)', { browserInitiated: true })).toBe(false)
  })
})

describe('view-source userinfo (AC73, E1/R34)', () => {
  it.each([
    ['view-source:http://u:p@h.test/', 'view-source:http://h.test/'],
    ['view-source:https://u@h.test/x?y#z', 'view-source:https://h.test/x?y#z'],
    ['view-source:https://h.test/x', 'view-source:https://h.test/x'],
    ['view-source:file:///etc/hosts', 'view-source:file:///etc/hosts'],
    ['view-source:view-source:http://u:p@h.test/', 'view-source:view-source:http://h.test/']
  ])('displayUrl and stripUrlCredentials: %s', (input, out) => {
    expect(displayUrl(input)).toBe(out)
    expect(stripUrlCredentials(input)).toBe(out)
  })
  it('isWebViewSource: file: and nested view-source: are false', () => {
    expect(isWebViewSource('view-source:http://u:p@h.test/')).toBe(true)
    expect(isWebViewSource('view-source:file:///x')).toBe(false)
    expect(isWebViewSource('view-source:view-source:')).toBe(false)
  })
  it('no other view-source regex in src/', () => {
    const hits: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && /\/[^/\n]*view-source[^/\n]*\/[a-z]*[.,)]/i.test(readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    walk(join(__dirname, '../../src'))
    expect(hits).toEqual([])
  })
})
