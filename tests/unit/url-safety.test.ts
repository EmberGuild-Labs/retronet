import { describe, expect, it } from 'vitest'
import {
  displayPartsFor,
  displayUrl,
  omniboxSegments,
  isExternalAllowlisted,
  navigationSchemeAllowed,
  securityStateFor
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
    ['garbage', false, 'insecure']
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
