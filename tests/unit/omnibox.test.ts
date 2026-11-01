import { describe, expect, it } from 'vitest'
import { classifyInput, buildSearchUrl, dropPayload, OMNIBOX_INPUT_MAX, type SearchEngine } from '@shared/omnibox'

const DDG = 'https://duckduckgo.com/?q='
const google: SearchEngine = { id: 'google', template: 'https://www.google.com/search?q=%s' }

const urlCases: [string, string][] = [
  ['example.com', 'https://example.com/'],
  ['  example.com  ', 'https://example.com/'],
  ['www.example.com/path?x=1#h', 'https://www.example.com/path?x=1#h'],
  ['sub.domain.co.uk', 'https://sub.domain.co.uk/'],
  ['https://example.com', 'https://example.com/'],
  ['HTTP://Example.COM/A', 'http://example.com/A'],
  ['localhost', 'http://localhost/'],
  ['localhost:3000', 'http://localhost:3000/'],
  ['localhost:3000/api/x?y=1', 'http://localhost:3000/api/x?y=1'],
  ['app.localhost', 'http://app.localhost/'],
  ['127.0.0.1', 'http://127.0.0.1/'],
  ['192.168.1.1:8080/admin', 'http://192.168.1.1:8080/admin'],
  ['[::1]', 'http://[::1]/'],
  ['[::1]:8080', 'http://[::1]:8080/'],
  ['::1', 'http://[::1]/'],
  ['[2001:db8::1]/x', 'http://[2001:db8::1]/x'],
  ['intranet:8080', 'http://intranet:8080/'],
  ['example.com:8443/x', 'https://example.com:8443/x'],
  ['retronet://settings', 'retronet://settings'],
  ['retronet://history/', 'retronet://history/'],
  ['about:blank', 'about:blank'],
  ['file:///Users/me/a.html', 'file:///Users/me/a.html'],
  ['bücher.de', 'https://xn--bcher-kva.de/'],
  ['https://аррӏе.com', 'https://xn--80ak6aa92e.com/'],
  ['xn--bcher-kva.de', 'https://xn--bcher-kva.de/']
]

describe('classifyInput: urls', () => {
  it.each(urlCases)('%s -> %s', (input, expected) => {
    const r = classifyInput(input)
    expect(r.kind).toBe('url')
    expect(r.url).toBe(expected)
  })
})

describe('classifyInput: search', () => {
  const cases: [string, string][] = [
    ['intranet', 'intranet'],
    ['hello', 'hello'],
    ['hello world', 'hello world'],
    ['what is 2+2?', 'what is 2+2?'],
    ['example.com is down', 'example.com is down'],
    ['https://example.com/a b', 'https://example.com/a b'],
    ['e.g.', 'e.g.'],
    ['user@example.com', 'user@example.com'],
    ['3.14', '3.14'],
    ['999.1.1.1', '999.1.1.1'],
    ['note: buy milk', 'note: buy milk'],
    ['foo.', 'foo.'],
    ['.com', '.com']
  ]
  it.each(cases)('%s goes to the default engine', (input, q) => {
    const r = classifyInput(input)
    expect(r.kind).toBe('search')
    expect(r.url).toBe(DDG + encodeURIComponent(q))
  })

  it('uses the chosen engine and encodes the query', () => {
    expect(classifyInput('a&b=c d', google).url).toBe('https://www.google.com/search?q=a%26b%3Dc%20d')
  })
  it('falls back to DuckDuckGo for a template without a placeholder', () => {
    expect(buildSearchUrl('x', { id: 'bad', template: 'https://evil.example/' })).toBe(DDG + 'x')
  })
  it('supports {searchTerms} and {q}', () => {
    expect(buildSearchUrl('a b', { id: 'a', template: 'https://s.test/?q={q}' })).toBe('https://s.test/?q=a%20b')
    expect(buildSearchUrl('a', { id: 'a', template: 'https://s.test/?q={searchTerms}' })).toBe('https://s.test/?q=a')
  })
  it('defaults to DuckDuckGo when no engine is passed', () => {
    expect(classifyInput('cats').url.startsWith('https://duckduckgo.com/')).toBe(true)
  })
})

describe('classifyInput: blocked', () => {
  const cases: [string, string][] = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['javascript:alert(1)', 'dangerous-scheme'],
    ['JaVaScRiPt:alert(1)', 'dangerous-scheme'],
    ['javascript: alert(1)', 'dangerous-scheme'],
    ['data:text/html,<script>alert(1)</script>', 'dangerous-scheme'],
    ['vbscript:x', 'dangerous-scheme'],
    ['blob:https://example.com/uuid', 'dangerous-scheme'],
    ['view-source:file:///etc/hosts', 'dangerous-scheme'],
    ['view-source:retronet://settings/', 'dangerous-scheme'],
    ['view-source:view-source:https://example.com/', 'dangerous-scheme'],
    ['view-source:javascript:alert(1)', 'dangerous-scheme'],
    ['view-source:data:text/html,x', 'dangerous-scheme'],
    ['view-source:about:blank', 'dangerous-scheme'],
    ['view-source:example.com', 'dangerous-scheme'],
    ['view-source:https://', 'dangerous-scheme'],
    ['view-source:https://exa mple.com/', 'dangerous-scheme'],
    ['view-source: https://example.com/', 'dangerous-scheme'],
    ['view-source:', 'dangerous-scheme'],
    ['chrome://settings', 'dangerous-scheme'],
    ['chrome://version', 'dangerous-scheme'],
    ['about:config', 'dangerous-scheme'],
    ['mailto:a@b.com', 'dangerous-scheme'],
    ['ftp://example.com', 'dangerous-scheme'],
    ['foo://bar', 'unsupported-scheme'],
    ['http://', 'invalid']
  ]
  it.each(cases)('%j is blocked (%s)', (input, reason) => {
    const r = classifyInput(input)
    expect(r.kind).toBe('blocked')
    expect(r.url).toBe('')
    if (r.kind === 'blocked') expect(r.reason).toBe(reason)
  })
})

describe('classifyInput: file and idn flags', () => {
  it('marks typed file: URLs', () => {
    const r = classifyInput('file:///tmp/x.html')
    expect(r).toEqual({ kind: 'url', url: 'file:///tmp/x.html', typedFile: true })
  })
  it('does not flag non-file urls', () => {
    expect(classifyInput('example.com')).not.toHaveProperty('typedFile')
  })
  it('never yields a non-punycode unicode host', () => {
    const r = classifyInput('https://раураl.com')
    expect(r.kind).toBe('url')
    expect(new URL(r.url).hostname).toMatch(/^xn--/)
  })
})

describe('dropPayload (Q9: links dropped on the tab strip are untyped)', () => {
  it('opens the first URL of a uri-list, skipping comments', () => {
    expect(dropPayload('# comment\r\nhttps://example.com/a\r\nhttps://other.example/', '')).toEqual({ kind: 'url', url: 'https://example.com/a' })
  })
  it('accepts a bare host from plain text', () => {
    expect(dropPayload('', 'example.com')).toEqual({ kind: 'url', url: 'https://example.com/' })
  })
  it('turns plain words into a search (engine applied by main)', () => {
    expect(dropPayload('', 'retro browsers')).toEqual({ kind: 'search', text: 'retro browsers' })
  })
  it('refuses file:, retronet:, javascript: and data: drops', () => {
    expect(dropPayload('file:///etc/passwd', '')).toBeNull()
    expect(dropPayload('', 'file:///etc/passwd')).toBeNull()
    expect(dropPayload('', 'retronet://settings/')).toBeNull()
    expect(dropPayload('', 'javascript:alert(1)')).toBeNull()
    expect(dropPayload('data:text/html,hi', '')).toBeNull()
  })
  it('refuses a uri-list entry that is not a URL, and empty or over-long text', () => {
    expect(dropPayload('not a url at all', '')).toBeNull()
    expect(dropPayload('', '   ')).toBeNull()
    expect(dropPayload('', 'https://example.com/' + 'a'.repeat(OMNIBOX_INPUT_MAX))).toBeNull()
  })
})

describe('classifyInput: typed view-source (AC54)', () => {
  it.each([
    ['view-source:https://example.com', 'view-source:https://example.com/'],
    ['view-source:http://127.0.0.1:8080/a?b=1#c', 'view-source:http://127.0.0.1:8080/a?b=1#c'],
    ['VIEW-SOURCE:HTTPS://Example.COM/x', 'view-source:https://example.com/x'],
    ['  view-source:https://example.com/  ', 'view-source:https://example.com/']
  ])('%j -> %s', (input, url) => {
    expect(classifyInput(input)).toEqual({ kind: 'url', url })
  })
  it('a dropped view-source: link is refused (not http(s))', () => {
    expect(dropPayload('view-source:https://example.com/', '')).toBeNull()
  })
})

describe('classifyInput: view-source userinfo (AC73)', () => {
  it.each([
    ['view-source:http://u:p@h.test/', 'view-source:http://h.test/'],
    ['view-source:https://u@h.test/x?y#z', 'view-source:https://h.test/x?y#z']
  ])('%j -> %s', (input, url) => {
    expect(classifyInput(input)).toEqual({ kind: 'url', url })
  })
  it('file: and nested view-source: stay blocked', () => {
    expect(classifyInput('view-source:file:///etc/hosts').kind).toBe('blocked')
    expect(classifyInput('view-source:view-source:').kind).toBe('blocked')
  })
})
