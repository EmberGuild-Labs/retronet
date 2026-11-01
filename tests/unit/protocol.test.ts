import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CSP,
  INTERNAL_HOSTS,
  createRetronetHandler,
  internalHostOf,
  mimeTypeFor,
  resolveInternalPath,
  responseHeaders
} from '../../src/main/protocol/retronet-protocol'

const ROOT = resolve('/srv/rn/out/renderer')
const r = (...p: string[]): string => join(ROOT, ...p)

describe('resolveInternalPath: allowed', () => {
  const cases: [string, string][] = [
    ['retronet://newtab/', r('pages', 'newtab', 'index.html')],
    ['retronet://newtab', r('pages', 'newtab', 'index.html')],
    ['retronet://settings/', r('pages', 'settings', 'index.html')],
    ['retronet://certerror/?url=https%3A%2F%2Fx.test%2F&code=-201', r('pages', 'certerror', 'index.html')],
    ['retronet://neterror/#frag', r('pages', 'neterror', 'index.html')],
    ['retronet://shell/', r('shell', 'index.html')],
    ['retronet://overlay/', r('overlay', 'index.html')],
    ['retronet://newtab/assets/pages/newtab-BFIja7sO.js', r('assets', 'pages', 'newtab-BFIja7sO.js')],
    ['retronet://shell/assets/shell-DeGfYyHi.js', r('assets', 'shell-DeGfYyHi.js')],
    ['retronet://history/skins/y1997/pages.css', r('skins', 'y1997', 'pages.css')],
    ['retronet://shell/skins/y2001/icons/back.svg', r('skins', 'y2001', 'icons', 'back.svg')],
    ['retronet://about/fonts/VT323-Regular.woff2', r('fonts', 'VT323-Regular.woff2')],
    ['retronet://newtab/img/logo.svg', r('img', 'logo.svg')],
    ['retronet://newtab/img/badge-88x31.png?v=2', r('img', 'badge-88x31.png')],
    // hidden era pages (PLAN-FINAL 1.3): served like any page
    ['retronet://firstweb/', r('pages', 'firstweb', 'index.html')],
    ['retronet://wikiwiki/img/eggs/wikiwiki-2.jpg', r('img', 'eggs', 'wikiwiki-2.jpg')]
  ]
  it.each(cases)('%s', (url, expected) => {
    expect(resolveInternalPath(url, ROOT)).toBe(expected)
  })

  it('serves every allowlisted host at /', () => {
    for (const host of INTERNAL_HOSTS) {
      const file = resolveInternalPath(`retronet://${host}/`, ROOT)
      expect(file, host).not.toBeNull()
      expect(file!.startsWith(ROOT + sep)).toBe(true)
    }
  })
})

describe('resolveInternalPath: rejected', () => {
  const cases: [string, string][] = [
    // dot segments, raw and encoded
    ['../ at root', 'retronet://newtab/../../../etc/passwd'],
    ['../ inside assets', 'retronet://newtab/assets/../../main/index.js'],
    ['../ to another page', 'retronet://newtab/assets/../pages/settings/index.html'],
    ['./ segment', 'retronet://newtab/assets/./x.js'],
    ['%2e%2e', 'retronet://newtab/assets/%2e%2e/%2e%2e/main/index.js'],
    ['%2E%2E upper', 'retronet://newtab/assets/%2E%2E/x.js'],
    ['.%2e mixed', 'retronet://newtab/assets/.%2e/x.js'],
    ['%2f encoded slash', 'retronet://newtab/assets%2f..%2f..%2fmain%2findex.js'],
    ['%2F upper', 'retronet://newtab/assets/a%2Fb.js'],
    ['%5c encoded backslash', 'retronet://newtab/assets/..%5c..%5cmain.js'],
    ['double encoding', 'retronet://newtab/assets/%252e%252e/x.js'],
    ['any percent at all', 'retronet://newtab/assets/a%41.js'],
    // backslashes
    ['backslash traversal', 'retronet://newtab/assets\\..\\..\\main\\index.js'],
    ['backslash in name', 'retronet://newtab/assets/a\\b.js'],
    // absolute paths
    ['empty segment absolute', 'retronet://newtab//etc/passwd'],
    ['absolute inside assets', 'retronet://newtab/assets//etc/passwd.js'],
    ['windows drive', 'retronet://newtab/assets/C:/Windows/win.ini'],
    ['windows drive bare', 'retronet://newtab/C:\\Windows\\win.ini'],
    ['file url', 'file:///etc/passwd'],
    ['plain absolute path', '/etc/passwd'],
    // null bytes and controls
    ['NUL byte', 'retronet://newtab/assets/x.js\u0000.png'],
    ['%00', 'retronet://newtab/assets/x.js%00.png'],
    ['newline', 'retronet://newtab/assets/x\n.js'],
    ['space', 'retronet://newtab/assets/a b.js'],
    // hosts
    ['unknown host', 'retronet://evil/'],
    ['unknown host asset', 'retronet://evil/assets/x.js'],
    ['egg lookalike host', 'retronet://firstwebx/'],
    ['egg uppercase host', 'retronet://FirstWeb/'],
    ['empty host', 'retronet:///assets/x.js'],
    ['uppercase host', 'retronet://NewTab/'],
    ['host with port', 'retronet://newtab:80/'],
    ['host with userinfo', 'retronet://a:b@newtab/'],
    ['other scheme', 'https://newtab/'],
    ['lookalike scheme', 'retronetx://newtab/'],
    // non-allowlisted dirs and files
    ['pages dir direct', 'retronet://newtab/pages/settings/index.html'],
    ['shell dir direct', 'retronet://newtab/shell/index.html'],
    ['main bundle', 'retronet://newtab/main/index.js'],
    ['preload', 'retronet://newtab/preload/internal.js'],
    ['bare index.html', 'retronet://newtab/index.html'],
    ['allowlisted dir itself', 'retronet://newtab/assets/'],
    ['allowlisted dir no slash', 'retronet://newtab/assets'],
    ['hidden file', 'retronet://newtab/assets/.env'],
    ['dotfile dir', 'retronet://newtab/skins/.git/config.json'],
    ['unknown extension', 'retronet://newtab/assets/x.exe'],
    ['no extension', 'retronet://newtab/assets/README'],
    ['source map', 'retronet://newtab/assets/x.js.map'],
    // junk
    ['empty', ''],
    ['not a url', 'not a url'],
    ['overlong', `retronet://newtab/assets/${'a'.repeat(3000)}.js`]
  ]
  it.each(cases)('%s', (_name, url) => {
    expect(resolveInternalPath(url, ROOT)).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(resolveInternalPath(undefined as unknown as string, ROOT)).toBeNull()
  })
})

describe('internalHostOf', () => {
  it('returns allowlisted hosts only', () => {
    expect(internalHostOf('retronet://settings/?x=1')).toBe('settings')
    expect(internalHostOf('retronet://evil/')).toBeNull()
    expect(internalHostOf('https://settings/')).toBeNull()
    expect(internalHostOf('::')).toBeNull()
  })
})

describe('headers and MIME', () => {
  it('CSP is strict', () => {
    expect(CSP).toContain("default-src 'none'")
    expect(CSP).toContain("script-src 'self'")
    expect(CSP).toContain("frame-ancestors 'none'")
    expect(CSP).toContain("base-uri 'none'")
    expect(CSP).toContain("form-action 'none'")
    expect(CSP).toContain("connect-src 'none'")
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/)
  })

  it('every response carries the security headers and no CORS allow header', () => {
    const h = responseHeaders('text/html; charset=utf-8')
    expect(h['Content-Security-Policy']).toBe(CSP)
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('access-control-allow-origin')
  })

  it.each([
    ['a.html', 'text/html; charset=utf-8'],
    ['a.js', 'text/javascript; charset=utf-8'],
    ['a.css', 'text/css; charset=utf-8'],
    ['a.svg', 'image/svg+xml'],
    ['a.PNG', 'image/png'],
    ['a.woff2', 'font/woff2'],
    ['a.ttf', 'font/ttf']
  ])('%s -> %s', (file, type) => {
    expect(mimeTypeFor(file)).toBe(type)
  })

  it('unknown extensions have no type', () => {
    expect(mimeTypeFor('a.exe')).toBeNull()
    expect(mimeTypeFor('a')).toBeNull()
  })
})

describe('createRetronetHandler (real files)', () => {
  let root = ''
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'rn-proto-'))
    root = join(base, 'out', 'renderer')
    mkdirSync(join(root, 'pages', 'newtab'), { recursive: true })
    mkdirSync(join(root, 'shell'), { recursive: true })
    mkdirSync(join(root, 'assets'), { recursive: true })
    mkdirSync(join(base, 'out', 'main'), { recursive: true })
    writeFileSync(join(root, 'pages', 'newtab', 'index.html'), '<!doctype html><title>nt</title>')
    writeFileSync(join(root, 'shell', 'index.html'), '<!doctype html><title>shell</title>')
    writeFileSync(join(root, 'assets', 'x.js'), 'export {}')
    writeFileSync(join(base, 'out', 'main', 'index.js'), 'SECRET')
  })
  afterAll(() => {
    rmSync(resolve(root, '..', '..'), { recursive: true, force: true })
  })

  const get = (url: string, method = 'GET'): Request => new Request(url, { method })

  it('serves a page with CSP and the right type', async () => {
    const h = createRetronetHandler({ uiOnlyHosts: 'block', root })
    const res = await h(get('retronet://newtab/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(CSP)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(await res.text()).toContain('<title>nt</title>')
  })

  it('serves a module script as text/javascript', async () => {
    const h = createRetronetHandler({ uiOnlyHosts: 'block', root })
    const res = await h(get('retronet://newtab/assets/x.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('404s missing files, traversal and unknown hosts, with headers still set', async () => {
    const h = createRetronetHandler({ uiOnlyHosts: 'serve', root })
    for (const url of [
      'retronet://newtab/assets/missing.js',
      'retronet://newtab/assets/%2e%2e/%2e%2e/main/index.js',
      'retronet://evil/',
      'retronet://downloads/' // allowlisted host, but its page is not built in this fixture
    ]) {
      const res = await h(get(url))
      expect(res.status, url).toBe(404)
      expect(res.headers.get('content-security-policy')).toBe(CSP)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).not.toContain('SECRET')
    }
  })

  it('blocks shell and overlay on non-UI sessions', async () => {
    const tab = createRetronetHandler({ uiOnlyHosts: 'block', root })
    expect((await tab(get('retronet://shell/'))).status).toBe(404)
    expect((await tab(get('retronet://shell/assets/x.js'))).status).toBe(404)
    const ui = createRetronetHandler({ uiOnlyHosts: 'serve', root })
    expect((await ui(get('retronet://shell/'))).status).toBe(200)
  })

  it('rejects methods other than GET and HEAD', async () => {
    const h = createRetronetHandler({ uiOnlyHosts: 'serve', root })
    expect((await h(get('retronet://newtab/', 'POST'))).status).toBe(405)
    const head = await h(get('retronet://newtab/', 'HEAD'))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-security-policy')).toBe(CSP)
  })
})
