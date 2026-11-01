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

/**
 * A minimal valid one-page PDF (PLAN-EXTRA X17), built in code with a correct xref table so the viewer needs no
 * repair pass. The page shows `text` in Helvetica on white.
 */
export function makePdf(text = 'RetroNet PDF fixture'): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[\\()]/g, (c) => '\\' + c)}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Built-in viewer origin (Chromium's PDF extension). Only tests name it; the app keeps it in src/main. */
export const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

/** Update-feed fixture modes served at /feed/<mode> (AC52, AC53). `live` serves whatever setFeed() chose. */
export type FeedMode = 'newer' | 'same' | 'invalid' | 'huge' | 'redirect' | 'slow' | 'http-url'

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
  /** Requests to /feed/* so far (AC53: zero until the user clicks). */
  feedHits(): number
  /** What /feed/live answers from now on. */
  setFeed(mode: FeedMode): void
  /** The https download URL the "newer" feed advertises. */
  updateDownloadUrl: string
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

interface State {
  requests: RequestRecord[]
  seen: Record<string, string>
  feedMode: FeedMode
  feedHits: number
  base: string
  httpsBase: string
}

const PDF = makePdf()
/** The app's own version (unpackaged app.getVersion()); the "same" feed advertises it. */
export const APP_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version

function feed(res: http.ServerResponse, state: State, mode: FeedMode): void {
  const json = (body: string): void => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  }
  switch (mode) {
    case 'newer':
      return json(JSON.stringify({ version: '9.9.9', url: `${state.httpsBase}/update-download`, notes: 'Fixes <b>x</b> & more' }))
    case 'same':
      return json(JSON.stringify({ version: APP_VERSION, url: `${state.httpsBase}/update-download` }))
    case 'invalid':
      return json('{ "version": "9.9.9", "url": ')
    case 'http-url':
      return json(JSON.stringify({ version: '9.9.9', url: `${state.base}/update-download` }))
    case 'huge':
      return json(JSON.stringify({ version: '9.9.9', url: `${state.httpsBase}/update-download`, notes: 'x'.repeat(70_000) }))
    case 'redirect':
      res.writeHead(302, { location: '/feed/newer' })
      res.end()
      return
    case 'slow':
      setTimeout(() => {
        if (!res.destroyed) json(JSON.stringify({ version: APP_VERSION, url: `${state.httpsBase}/update-download` }))
      }, 2500)
      return
  }
}

function router(state: State, secure: boolean): http.RequestListener {
  return (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const p = u.pathname
    state.requests.push({ path: req.url ?? '/', cookie: req.headers.cookie ?? '', secure })
    if (p.startsWith('/feed/')) {
      state.feedHits++
      const mode = p.slice('/feed/'.length)
      return feed(res, state, (mode === 'live' ? state.feedMode : mode) as FeedMode)
    }
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
      case '/doc.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(PDF.length) })
        res.end(PDF)
        return
      case '/viewsrc.html':
        // AC54: a page whose source view has a link (the source view renders it as an anchor).
        return page(res, 'Source Me', '<p>VIEWSRC-MARKER</p><a id="to-b" href="/b">to b</a><script>document.title = "script ran"</script>')
      case '/hostile-extras.html':
        // AC51/AC54: a web page that frames the PDF viewer directly and tries to reach view-source: three ways.
        return page(
          res,
          'Hostile extras',
          `<iframe id="viewer" src="${PDF_VIEWER_ORIGIN}/index.html" width="400" height="300"></iframe>` +
            `<a id="vs-link" href="view-source:${state.base}/viewsrc.html" style="display:block;width:200px;height:40px">source</a>` +
            `<script>window.__opened = String(window.open('view-source:${state.base}/viewsrc.html'))</script>`
        )
      case '/redirect-view-source': {
        res.writeHead(302, { location: `view-source:${state.base}/viewsrc.html` })
        res.end()
        return
      }
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
  const state: State = { requests: [], seen: {}, feedMode: 'newer', feedHits: 0, base: '', httpsBase: '' }
  const plain = http.createServer(router(state, false))
  const tls = https.createServer(selfSignedCert(), router(state, true))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', () => r()))
  const port = (plain.address() as AddressInfo).port
  const tport = (tls.address() as AddressInfo).port
  state.base = `http://127.0.0.1:${port}`
  state.httpsBase = `https://127.0.0.1:${tport}`
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
    feedHits: () => state.feedHits,
    setFeed: (mode) => {
      state.feedMode = mode
    },
    updateDownloadUrl: `${state.httpsBase}/update-download`,
    close: async () => {
      plain.closeAllConnections()
      tls.closeAllConnections()
      await Promise.all([new Promise((r) => plain.close(r)), new Promise((r) => tls.close(r))])
    }
  }
}
