// Local HTTP + HTTPS fixture server for the E2E suite (PLAN T23). Binds 127.0.0.1 on random ports, so the
// suite never needs the internet. The HTTPS side uses a throwaway self-signed certificate generated with
// openssl into a temp dir at first use (never committed), which Chromium rejects: that drives the cert
// interstitial test. Both servers share one router; `seen` records what each request carried (cookies).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const FIXTURES = resolve(__dirname, '..', '..', 'fixtures')

// 1x1 transparent PNG (favicon).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)

export interface RequestRecord {
  path: string
  cookie: string
  secure: boolean
}

export interface FixtureServer {
  /** http://127.0.0.1:<port> */
  base: string
  /** 127.0.0.1:<port> (status strings use it) */
  host: string
  /** https://127.0.0.1:<port> (self-signed) */
  httpsBase: string
  /** Every request in arrival order. */
  requests: RequestRecord[]
  /** Cookie header received for `/echo?tag=<tag>`. */
  seen: Record<string, string>
  /** A port nothing listens on (connection refused). */
  deadPort: number
  close(): Promise<void>
}

let certCache: { key: Buffer; cert: Buffer } | null = null

function selfSignedCert(): { key: Buffer; cert: Buffer } {
  if (certCache) return certCache
  const dir = mkdtempSync(join(tmpdir(), 'rn-e2e-cert-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' }
  )
  certCache = { key: readFileSync(key), cert: readFileSync(cert) }
  return certCache
}

function page(res: http.ServerResponse, title: string, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/fav.png"></head><body>${body}</body></html>`)
}

function router(state: { requests: RequestRecord[]; seen: Record<string, string> }, secure: boolean): http.RequestListener {
  return (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const p = u.pathname
    state.requests.push({ path: req.url ?? '/', cookie: req.headers.cookie ?? '', secure })
    if (p === '/fav.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }
    // Fixture files: /fixtures/<name>.html
    if (p.startsWith('/fixtures/')) {
      const name = p.slice('/fixtures/'.length)
      const file = join(FIXTURES, name)
      if (!/^[a-z0-9-]+\.html$/.test(name) || !existsSync(file)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(file))
      return
    }
    switch (p) {
      case '/a':
        return page(res, 'Page A', '<p>apple apple</p><a id="to-b" href="/b" style="display:block;width:200px;height:40px">to b</a>')
      case '/b':
        return page(res, 'Page B', '<p>banana</p>')
      case '/slow':
        // Headers arrive late: holds "Waiting for reply..." long enough to observe loading.
        setTimeout(() => page(res, 'Slow'), Number(u.searchParams.get('ms') ?? 3000))
        return
      case '/set': {
        const v = u.searchParams.get('v') ?? ''
        return page(res, `set ${v}`, `<script>try{localStorage.setItem('ls', ${JSON.stringify(v)})}catch(e){}</script>set`, {
          'set-cookie': `who=${encodeURIComponent(v)}; Max-Age=86400; Path=/`
        })
      }
      case '/echo': {
        const tag = u.searchParams.get('tag') ?? ''
        state.seen[tag] = req.headers.cookie ?? ''
        return page(res, `echo ${tag}`, 'echo')
      }
      case '/title':
        return page(res, u.searchParams.get('t') ?? 'Untitled', '<p>titled</p>')
      case '/basic-auth': {
        // HTTP Basic: user "alice" / password "wonder". Answers 401 + realm until the right credentials arrive.
        const want = 'Basic ' + Buffer.from('alice:wonder').toString('base64')
        if (req.headers.authorization === want) return page(res, 'Authed', '<p>welcome alice</p>')
        res.writeHead(401, { 'www-authenticate': 'Basic realm="RetroNet Test"', 'content-type': 'text/html' })
        res.end('<title>Denied</title><p>denied</p>')
        return
      }
      case '/redirect': {
        res.writeHead(302, { location: u.searchParams.get('to') ?? '/' })
        res.end()
        return
      }
      case '/download': {
        const name = u.searchParams.get('name') ?? 'hello.txt'
        const body = Buffer.alloc(Number(u.searchParams.get('size') ?? 64), 'x')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': String(body.length)
        })
        res.end(body)
        return
      }
      case '/download-slow': {
        const total = 2_000_000
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${u.searchParams.get('name') ?? 'slow.bin'}"`,
          'content-length': String(total)
        })
        let sent = 0
        const t = setInterval(() => {
          if (sent >= total) {
            clearInterval(t)
            res.end()
            return
          }
          res.write(Buffer.alloc(40_000, 'y'))
          sent += 40_000
        }, 50)
        res.on('close', () => clearInterval(t))
        return
      }
      default:
        return page(res, `Other ${p}`, `<p>${p}</p>`)
    }
  }
}

export async function startServer(): Promise<FixtureServer> {
  const state = { requests: [] as RequestRecord[], seen: {} as Record<string, string> }
  const plain = http.createServer(router(state, false))
  const tls = https.createServer(selfSignedCert(), router(state, true))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', () => r()))
  const port = (plain.address() as AddressInfo).port
  const tport = (tls.address() as AddressInfo).port
  const deadPort = await new Promise<number>((r) => {
    const x = http.createServer()
    x.listen(0, '127.0.0.1', () => {
      const dp = (x.address() as AddressInfo).port
      x.close(() => r(dp))
    })
  })
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    httpsBase: `https://127.0.0.1:${tport}`,
    requests: state.requests,
    seen: state.seen,
    deadPort,
    close: async () => {
      plain.closeAllConnections()
      tls.closeAllConnections()
      await Promise.all([new Promise((r) => plain.close(r)), new Promise((r) => tls.close(r))])
    }
  }
}
