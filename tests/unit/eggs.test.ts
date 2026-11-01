// B1: hidden era pages (PLAN-FINAL 1.3, AC69, AC70 main side, AC71 gate).
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ openPage: vi.fn(), win: { id: 1 } as any }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp', on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('../../src/main/commands/dispatch', () => ({ openPage: h.openPage }))
vi.mock('../../src/main/internal-api/misc', () => ({ windowOf: () => h.win }))

// @ts-expect-error no type declarations for the .mjs allowlist
import { ALLOW, EGG_SLUGS, EGG_TRADEMARK_TOKENS, blankAllowed } from '../../scripts/trademark-allow.mjs'
// @ts-expect-error no type declarations for the shared .mjs word list
import { TRADEMARK_RE } from '../../scripts/trademark-words.mjs'
import { openEgg, registerEggHandlers } from '../../src/main/internal-api/eggs'
import { router, type InvokeEventLike, type SenderRole } from '../../src/main/ipc/router'
import { buildSuggestions, eggHintEra, eggHintRow } from '../../src/main/omnibox/suggestions'
import { INTERNAL_HOSTS, createRetronetHandler, resolveInternalPath } from '../../src/main/protocol/retronet-protocol'
import {
  decideBrowserNavigation,
  decideFrameNavigation,
  decidePageNavigation,
  decideRetronetSubresource,
  decideWindowOpen
} from '../../src/main/security/navigation-guards'
import { bridgeArgument } from '../../src/main/security/web-prefs'
import { EGG_HOSTS, EGG_PAGES, eggUrl, isEggUrl } from '../../src/shared/eggs'
import { IPC_METHOD_NAMES, IPC_METHODS, callerForUrl, isCallerAllowed } from '../../src/shared/ipc-contract'
import { SEARCH_ENGINES } from '../../src/shared/search-engines'
import { SKIN_IDS } from '../../src/shared/skins'
import { PAGE_HOSTS, type Caller } from '../../src/shared/types'

const ROOT = join(__dirname, '..', '..')
const EGG_URLS = EGG_HOSTS.map((s) => `retronet://${s}/`)

describe('egg registry', () => {
  it('one egg per skin, slugs well-formed, unique and free of trademark words', () => {
    expect(Object.keys(EGG_PAGES).sort()).toEqual([...SKIN_IDS].sort())
    expect(SKIN_IDS.map((s) => EGG_PAGES[s].slug).sort()).toEqual([...EGG_HOSTS].sort())
    for (const s of SKIN_IDS) {
      const { slug, title } = EGG_PAGES[s]
      expect(slug).toMatch(/^[a-z][a-z0-9-]{1,30}$/)
      expect(TRADEMARK_RE.test(slug), slug).toBe(false)
      expect(TRADEMARK_RE.test(title), title).toBe(false)
    }
  })

  it('egg hosts are distinct from every other internal host', () => {
    for (const s of EGG_HOSTS) expect([...PAGE_HOSTS, 'shell', 'overlay']).not.toContain(s)
  })

  it('eggUrl maps an era and refuses anything else', () => {
    expect(eggUrl('y1994')).toBe('retronet://firstweb/')
    expect(eggUrl('y2001')).toBe('retronet://wikiwiki/')
    expect(eggUrl('y2099' as never)).toBeNull()
    expect(eggUrl('__proto__' as never)).toBeNull()
    expect(eggUrl('toString' as never)).toBeNull()
  })

  it('isEggUrl', () => {
    for (const u of EGG_URLS) expect(isEggUrl(u)).toBe(true)
    expect(isEggUrl('retronet://cascade/img/eggs/cascade-1.jpg?x#y')).toBe(true)
    expect(isEggUrl('retronet://about/')).toBe(false)
    expect(isEggUrl('https://firstweb/')).toBe(false)
    expect(isEggUrl('not a url')).toBe(false)
  })

  it('the trademark allowlist slugs equal EGG_HOSTS', () => {
    expect([...EGG_SLUGS].sort()).toEqual([...EGG_HOSTS].sort())
  })
})

describe('protocol serves the egg hosts like any page (AC69)', () => {
  it('each egg host is allowlisted and maps to pages/<slug>/index.html', () => {
    const root = '/srv/rn/out/renderer'
    for (const s of EGG_HOSTS) {
      expect(INTERNAL_HOSTS).toContain(s)
      expect(resolveInternalPath(`retronet://${s}/`, root)).toBe(join(root, 'pages', s, 'index.html'))
      expect(resolveInternalPath(`retronet://${s}/img/eggs/${s}-1.jpg`, root)).toBe(join(root, 'img', 'eggs', `${s}-1.jpg`))
      expect(resolveInternalPath(`retronet://${s}/skins/y1994/pages.css`, root)).toBe(join(root, 'skins', 'y1994', 'pages.css'))
      expect(resolveInternalPath(`retronet://${s}/pages/about/index.html`, root)).toBeNull()
    }
  })

  it('a placeholder page exists in the source tree for each egg', () => {
    for (const s of EGG_HOSTS) expect(statSync(join(ROOT, 'src', 'renderer', 'pages', s, 'index.html')).isFile()).toBe(true)
  })

  it('serves with the same CSP and headers as other pages', async () => {
    const handler = createRetronetHandler({ uiOnlyHosts: 'block', root: join(ROOT, 'src', 'renderer') })
    const egg = await handler(new Request('retronet://firstweb/'))
    const about = await handler(new Request('retronet://about/'))
    expect(egg.status).toBe(200)
    expect(about.status).toBe(200)
    expect(egg.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect([...egg.headers.entries()].sort()).toEqual([...about.headers.entries()].sort())
  })
})

describe('no bridge for egg pages (AC69, D-B1)', () => {
  it('not a caller: callerForUrl is null, no method allows them, the bridge spec has no entry', () => {
    for (const u of EGG_URLS) expect(callerForUrl(u)).toBeNull()
    for (const s of EGG_HOSTS) {
      for (const m of IPC_METHOD_NAMES) {
        expect(isCallerAllowed(m, s as unknown as Caller)).toBe(false)
        expect(IPC_METHODS[m].callers as readonly string[]).not.toContain(s)
      }
    }
    const spec = JSON.parse(decodeURIComponent(bridgeArgument(PAGE_HOSTS, []).slice('--rn-bridge='.length)))
    for (const s of EGG_HOSTS) expect(Object.hasOwn(spec.methods, s)).toBe(false)
  })
})

describe('web pages can never reach an egg (AC69)', () => {
  const WEB = 'https://example.com/'
  it.each(EGG_URLS)('%s', (egg) => {
    // link, location=, form: page-initiated main-frame navigation from http(s)
    expect(decidePageNavigation(egg, { kind: 'tab', currentUrl: WEB })).toBe('block')
    expect(decidePageNavigation(egg, { kind: 'tab', currentUrl: 'retronet://about/', initiatorUrl: WEB })).toBe('block')
    expect(decidePageNavigation(egg, { kind: 'tab', currentUrl: 'http://x.test/' })).toBe('block')
    // window.open
    expect(decideWindowOpen({ url: egg, disposition: 'foreground-tab', features: '' }, { kind: 'tab', openerUrl: WEB }).action).toBe('deny')
    // iframe
    expect(decideFrameNavigation(egg, WEB)).toBe(false)
    // <img>, fetch, script, css from an http origin
    for (const resourceType of ['image', 'xhr', 'script', 'stylesheet', 'font', 'other']) {
      expect(decideRetronetSubresource({ resourceType, initiatorOrigin: 'https://example.com' })).toBe(false)
      expect(decideRetronetSubresource({ resourceType, frameUrl: WEB })).toBe(false)
    }
    expect(decideRetronetSubresource({ resourceType: 'image' })).toBe(false)
    expect(decideRetronetSubresource({ resourceType: 'subFrame', initiatorOrigin: 'retronet://about' })).toBe(false)
    // The user typing the address (browser-initiated) is allowed.
    expect(decideBrowserNavigation(egg, { typed: false })).toBe('allow')
  })

  it('an egg page loads its own images and css (retronet initiator)', () => {
    expect(decideRetronetSubresource({ resourceType: 'image', initiatorOrigin: 'retronet://firstweb' })).toBe(true)
  })
})

describe('suggestions exclude egg URLs (AC69, D-B2)', () => {
  const engine = SEARCH_ENGINES[0]!
  const sources = (rows: Array<{ url: string; title: string }>) => ({ bookmarks: () => rows, history: () => rows })
  const rows = [...EGG_URLS.map((url) => ({ url, title: 'egg' })), { url: 'retronet://cascade/#x', title: 'egg' }, { url: 'https://a.test/', title: 'A' }]

  it('bookmarked or history egg URLs never show, under any skin', () => {
    for (const skin of [undefined, ...SKIN_IDS]) {
      const out = buildSuggestions('e', sources(rows), engine, { skin })
      expect(out.some((s) => isEggUrl(s.url)), String(skin)).toBe(false)
      expect(out.map((s) => s.url)).toContain('https://a.test/')
    }
  })

  it('wiki wiki under y2001 adds the one generated hint row at index 0; Enter (highlight -1) still searches', () => {
    for (const text of ['wiki wiki', '  Quick   QUICK ', 'WIKI wiki']) {
      const out = buildSuggestions(text, sources(rows), engine, { skin: 'y2001' })
      expect(out[0]).toEqual({ kind: 'url', title: 'Quick, quick!', url: 'retronet://wikiwiki/' })
      expect(out.filter((s) => isEggUrl(s.url))).toHaveLength(1)
      expect(out[out.length - 1]!.kind).toBe('search')
      expect(eggHintEra(out[0])).toBe('y2001')
    }
  })

  it('no hint row for other skins, other text or no skin', () => {
    for (const skin of ['y1994', 'y1997', 'y1999', undefined] as const) expect(eggHintRow('wiki wiki', skin)).toBeNull()
    for (const text of ['wiki', 'wikiwiki', 'wiki wiki wiki', 'quick', 'wiki quick', 'retronet://wikiwiki/']) {
      expect(eggHintRow(text, 'y2001'), text).toBeNull()
    }
  })

  it('eggHintEra only matches the generated row', () => {
    expect(eggHintEra({ kind: 'bookmark', title: 'Quick, quick!', url: 'retronet://wikiwiki/' })).toBeNull()
    expect(eggHintEra({ kind: 'url', title: 'other', url: 'retronet://wikiwiki/' })).toBeNull()
    expect(eggHintEra({ kind: 'url', title: 'Quick, quick!', url: 'retronet://firstweb/' })).toBeNull()
    expect(eggHintEra(undefined)).toBeNull()
  })
})

describe('eggs.open / eggs.openFromPage (AC70 main side)', () => {
  beforeAll(() => registerEggHandlers())
  beforeEach(() => h.openPage.mockReset())

  let nextId = 1000
  function call(method: 'eggs.open' | 'eggs.openFromPage', role: SenderRole, url: string, payload: unknown) {
    const main = { processId: 1, routingId: 7 }
    const sender = { id: nextId++, isDestroyed: () => false, once: () => {}, mainFrame: main } as any
    router.registerSender(sender, { role, windowId: 1 })
    const frame = { ...main, parent: null, detached: false, url, origin: new URL(url).origin === 'null' ? `retronet://${new URL(url).hostname}` : new URL(url).origin }
    return router.dispatch(method, { sender, senderFrame: frame } as unknown as InvokeEventLike, payload)
  }

  it('openEgg opens the era URL through openPage and rejects a bad era with E_INVALID', () => {
    openEgg(h.win, 'y1999')
    expect(h.openPage).toHaveBeenCalledWith(h.win, 'retronet://clamshell/')
    for (const bad of ['y2099', '__proto__', '', 7, null]) {
      expect(() => openEgg(h.win, bad as never)).toThrow(expect.objectContaining({ code: 'E_INVALID' }))
    }
    expect(h.openPage).toHaveBeenCalledTimes(1)
  })

  it('shell eggs.open and about eggs.openFromPage open the egg', async () => {
    expect(await call('eggs.open', 'shell', 'retronet://shell/', { era: 'y1994' })).toMatchObject({ ok: true })
    expect(h.openPage).toHaveBeenLastCalledWith(h.win, 'retronet://firstweb/')
    expect(await call('eggs.openFromPage', 'tab', 'retronet://about/', { era: 'y2001' })).toMatchObject({ ok: true })
    expect(h.openPage).toHaveBeenLastCalledWith(h.win, 'retronet://wikiwiki/')
  })

  it('bad era is E_INVALID; other pages, egg pages and web pages are refused', async () => {
    expect(await call('eggs.open', 'shell', 'retronet://shell/', { era: 'y2099' })).toMatchObject({ ok: false, code: 'E_INVALID' })
    expect(await call('eggs.openFromPage', 'tab', 'retronet://settings/', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
    expect(await call('eggs.open', 'tab', 'retronet://about/', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
    for (const u of EGG_URLS) {
      expect(await call('eggs.openFromPage', 'tab', u, { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
    }
    expect(await call('eggs.openFromPage', 'tab', 'https://example.com/', { era: 'y1994' })).toMatchObject({ ok: false, code: 'E_FORBIDDEN' })
    expect(h.openPage).not.toHaveBeenCalled()
  })
})

describe('trademark allowlist scope (AC71, D-B4)', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'out', 'dist', 'release'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else out.push(relative(ROOT, p).split(sep).join('/'))
    }
    return out
  }
  const egg = ALLOW.find((a: { why: string }) => a.why.includes('D-B4'))!

  it('the egg entry matches exactly the four egg index.html files in the repo', () => {
    const hits = walk(join(ROOT, 'src')).filter((r) => egg.file.test(r)).sort()
    expect(hits).toEqual(EGG_HOSTS.map((s) => `src/renderer/pages/${s}/index.html`).sort())
  })

  it('it matches no sibling or lookalike path', () => {
    for (const r of [
      'src/renderer/pages/firstweb/egg.css',
      'src/renderer/pages/firstweb/main.ts',
      'src/renderer/pages/firstweb/sub/index.html',
      'src/renderer/pages/about/index.html',
      'src/renderer/pages/firstwebx/index.html',
      'src/renderer/public/img/eggs/firstweb-1.jpg',
      'xsrc/renderer/pages/firstweb/index.html',
      'src/renderer/pages/firstweb/index.html.bak'
    ]) {
      expect(egg.file.test(r), r).toBe(false)
    }
  })

  it('blanks only the listed, case-sensitive tokens, only in egg index.html', () => {
    const idx = 'src/renderer/pages/firstweb/index.html'
    expect(EGG_TRADEMARK_TOKENS.length).toBeGreaterThan(0)
    for (const t of EGG_TRADEMARK_TOKENS) {
      expect(TRADEMARK_RE.test(blankAllowed(idx, `<p>${t} was here</p>`))).toBe(false)
      expect(TRADEMARK_RE.test(blankAllowed(idx, `<p>${t.toUpperCase()} was here</p>`))).toBe(true)
      expect(TRADEMARK_RE.test(blankAllowed(idx, `<p>${t.toLowerCase()} was here</p>`))).toBe(true)
      for (const other of ['src/renderer/pages/firstweb/egg.css', 'src/renderer/pages/firstweb/main.ts', 'src/renderer/pages/about/index.html', 'src/shared/eggs.ts']) {
        expect(TRADEMARK_RE.test(blankAllowed(other, `/* ${t} */`)), other).toBe(true)
      }
    }
    // Words not on the list still fail inside an egg index.html.
    for (const w of ['Netscape', 'Microsoft', 'Internet Explorer', 'Windows XP', 'Luna', 'Chrome', 'Aqua']) {
      expect(TRADEMARK_RE.test(blankAllowed(idx, `<p>${w}</p>`)), w).toBe(true)
    }
  })

  it('egg file names are free of trademark words', () => {
    const eggFiles = walk(join(ROOT, 'src')).filter((r) => EGG_HOSTS.some((s) => r.includes(`/${s}/`) || r.includes(`/eggs/${s}-`)))
    expect(eggFiles.length).toBeGreaterThanOrEqual(4)
    for (const r of eggFiles) expect(TRADEMARK_RE.test(r.split('/').pop()!), r).toBe(false)
  })
})
