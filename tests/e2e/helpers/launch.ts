// E2E launcher + driver for the real built app (out/main/index.js via `electron .`). PLAN T23 / §6.
// - Every launch gets a temp RETRONET_USER_DATA and RETRONET_DOWNLOADS_DIR, with RETRONET_E2E=1 so main
//   installs its read-only test hooks (globalThis.__rn, __rnProfiles, __rnDownloads).
// - Playwright lists tab WebContentsViews as windows too, so nothing here relies on firstWindow(). Instead,
//   code runs in a specific webContents by id from main (`executeJavaScript`, main world, where the
//   contextBridge API `window.retronet` lives). Shell calls therefore go through the real preload bridge.
// - Keys are sent with webContents.sendInputEvent, which goes through before-input-event like a real key.
import { _electron, test as base, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WindowSnapshot, TabState } from '../../../src/shared/types'
import { startServer, type FixtureServer } from './server'

export const ROOT = resolve(__dirname, '..', '..', '..')

export interface WinInfo {
  id: number
  profileId: string
  incognito: boolean
  popup: boolean
  shellId: number
  shellUrl: string
  overlayId: number
  overlayUrl: string
  overlayKind: string | null
  insets: { top: number; bottom: number }
  snapshot: WindowSnapshot
}

export interface IpcRes<T = unknown> {
  ok: boolean
  data?: T
  code?: string
  message?: string
}

export interface LaunchOptions {
  userData?: string
  downloadsDir?: string
  /** Extra Chromium/Electron switches, placed before the app path. */
  switches?: string[]
  env?: Record<string, string>
  /** Wait for a window whose active tab finished loading (default true). */
  waitReady?: boolean
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Deliberate wait for a NEGATIVE assertion ("nothing happened"). Name what must stay absent. */
export const settle = (ms: number, _why: string): Promise<void> => sleep(ms)

/** Generic wait-until-truthy; alias of poll with an options bag. */
export const until = <T>(fn: () => Promise<T> | T, what: string, opts: { timeout?: number; every?: number } = {}) =>
  poll(fn, what, opts.timeout, opts.every)

/** Read + parse a JSON file; null while missing or half-written. */
export function readJson<T = any>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export const SKIN_IDS = ['y1994', 'y1997', 'y2001'] as const
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const

/** Poll `fn` until it returns a truthy value; throws with `what` (and the last value) on timeout. */
export async function poll<T>(fn: () => Promise<T> | T, what: string, timeout = 10_000, every = 50): Promise<NonNullable<T>> {
  const t0 = Date.now()
  let last: T | undefined
  let lastErr: unknown
  for (;;) {
    try {
      last = await fn()
      if (last) return last as NonNullable<T>
    } catch (e) {
      lastErr = e
    }
    if (Date.now() - t0 > timeout) {
      const extra = lastErr ? ` (last error: ${String(lastErr)})` : ` (last value: ${JSON.stringify(last)?.slice(0, 600)})`
      throw new Error(`timed out waiting for ${what}${extra}`)
    }
    await sleep(every)
  }
}

export class RN {
  closed = false
  constructor(
    readonly app: ElectronApplication,
    readonly userData: string,
    readonly downloadsDir: string
  ) {
    app.on('close', () => {
      this.closed = true
    })
  }

  /** Main-process evaluate (first arg is the electron module). */
  main<R, A = undefined>(fn: (electron: typeof import('electron'), arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.app.evaluate(fn as never, arg as never) as Promise<R>
  }

  /**
   * Waits until pending store writes have reached disk. Uses the main-side `__rn.flush()` test hook
   * (session saveNow + flushAllStores) when present; either way, if `file`/`pred` are given it polls the
   * file on disk until `pred(parsedJson)` holds, so it also works while the hook is absent.
   */
  async flush(file?: string, pred: (json: any) => unknown = () => true, what = 'flushed file'): Promise<void> {
    await this.main(async () => {
      const f = (globalThis as any).__rn?.flush
      if (typeof f === 'function') await f()
    }).catch(() => undefined)
    if (file) await poll(() => {
      const j = readJson(file)
      return j !== null && pred(j) ? true : null
    }, what, 15_000)
  }

  windows(): Promise<WinInfo[]> {
    return this.main(() => (globalThis as any).__rn.windows() as WinInfo[])
  }

  async win(windowId?: number): Promise<WinInfo> {
    const all = await this.windows()
    const w = windowId === undefined ? all[0] : all.find((x) => x.id === windowId)
    if (!w) throw new Error(`no window ${windowId ?? '(first)'}; have ${all.map((x) => x.id).join(',')}`)
    return w
  }

  async snap(windowId?: number): Promise<WindowSnapshot> {
    return (await this.win(windowId)).snapshot
  }

  /** Waits until pred(snapshot) holds for the window; returns that snapshot. */
  waitSnap(pred: (s: WindowSnapshot) => unknown, what: string, opts: { windowId?: number; timeout?: number } = {}): Promise<WindowSnapshot> {
    return poll(async () => {
      const s = await this.snap(opts.windowId)
      return pred(s) ? s : null
    }, what, opts.timeout)
  }

  active(s: WindowSnapshot): TabState {
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    if (!t) throw new Error('no active tab')
    return t
  }

  /** Run code in a webContents (main world; userGesture=true so popups/permission prompts are allowed). */
  js<T = unknown>(wcId: number, code: string): Promise<T> {
    return this.main(({ webContents }, a: { wcId: number; code: string }) => {
      const wc = webContents.fromId(a.wcId)
      if (!wc || wc.isDestroyed()) throw new Error(`webContents ${a.wcId} gone`)
      return wc.executeJavaScript(a.code, true)
    }, { wcId, code }) as Promise<T>
  }

  /** Call a bridge method (`ns.fn`) inside a webContents through its own `window.retronet`. */
  bridge<T = unknown>(wcId: number, method: string, req?: unknown): Promise<IpcRes<T>> {
    const [ns, fn] = method.split('.')
    const arg = req === undefined ? '' : JSON.stringify(req)
    return this.js<IpcRes<T>>(
      wcId,
      `(async () => { const r = window.retronet; if (!r || !r[${JSON.stringify(ns)}] || !r[${JSON.stringify(ns)}][${JSON.stringify(fn)}]) return { ok: false, code: 'NO_BRIDGE_METHOD' }; return await r[${JSON.stringify(ns)}][${JSON.stringify(fn)}](${arg}) })()`
    )
  }

  /**
   * Forged IPC: invoke main's registered handler for `rn:invoke:<method>` directly with `sender` = that
   * webContents (what a compromised renderer could send, bypassing its preload). The router must still
   * validate sender + payload.
   */
  forge<T = unknown>(senderWcId: number, method: string, payload: unknown): Promise<IpcRes<T>> {
    // A string payload is taken as raw JSON text.
    // Sent as JSON and parsed in main, so keys like "__proto__" arrive as own properties (as from a renderer).
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return this.main(async ({ ipcMain, webContents }, a: { id: number; method: string; json: string }) => {
      const wc = webContents.fromId(a.id)
      if (!wc) throw new Error('no webContents')
      const h = (ipcMain as any)._invokeHandlers.get('rn:invoke:' + a.method)
      if (!h) return { ok: false, code: 'NO_HANDLER' }
      return await h({ sender: wc, senderFrame: wc.mainFrame, processId: wc.getProcessId(), frameId: wc.mainFrame.routingId }, a.json === undefined ? undefined : JSON.parse(a.json))
    }, { id: senderWcId, method, json }) as Promise<IpcRes<T>>
  }

  async shellCall<T = unknown>(method: string, req?: unknown, windowId?: number): Promise<IpcRes<T>> {
    const w = await this.win(windowId)
    return this.bridge<T>(w.shellId, method, req)
  }

  /** Shell call that must succeed; returns data. */
  async shell<T = unknown>(method: string, req?: unknown, windowId?: number): Promise<T> {
    const r = await this.shellCall<T>(method, req, windowId)
    if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
    return r.data as T
  }

  /** webContents id of the active tab view attached to the window. */
  async activeTabWcId(windowId?: number): Promise<number> {
    const w = await this.win(windowId)
    return poll(
      () =>
        this.main(({ BrowserWindow, webContents }, a: { shellId: number; overlayId: number }) => {
          const shell = webContents.fromId(a.shellId)
          const bw = shell && BrowserWindow.fromWebContents(shell)
          if (!bw) return null
          const views = bw.contentView.children as Array<{ webContents?: { id: number } }>
          const v = views.find((x) => x.webContents && x.webContents.id !== a.overlayId)
          return v?.webContents?.id ?? null
        }, { shellId: w.shellId, overlayId: w.overlayId }),
      'active tab view'
    )
  }

  /** Run code in the window's active tab. */
  async tabJs<T = unknown>(code: string, windowId?: number): Promise<T> {
    return this.js<T>(await this.activeTabWcId(windowId), code)
  }

  /** Bridge call from the page in the window's active tab (an internal page). */
  async pageCall<T = unknown>(method: string, req?: unknown, windowId?: number): Promise<IpcRes<T>> {
    return this.bridge<T>(await this.activeTabWcId(windowId), method, req)
  }

  async page<T = unknown>(method: string, req?: unknown, windowId?: number): Promise<T> {
    const r = await this.pageCall<T>(method, req, windowId)
    if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
    return r.data as T
  }

  /** Every webContents id whose URL matches. */
  wcIdsByUrl(match: string | RegExp): Promise<number[]> {
    const src = typeof match === 'string' ? { s: match } : { re: match.source, flags: match.flags }
    return this.main(({ webContents }, a: { s?: string; re?: string; flags?: string }) => {
      const test = (u: string) => (a.s !== undefined ? u === a.s : new RegExp(a.re!, a.flags).test(u))
      return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && test(wc.getURL())).map((wc) => wc.id)
    }, src)
  }

  /** Navigate the active tab (omnibox semantics) and wait for the load to finish at `expectUrl`. */
  async navigate(input: string, opts: { windowId?: number; expectUrl?: string | ((u: string) => boolean); timeout?: number } = {}): Promise<WindowSnapshot> {
    const r = await this.shell<{ blocked: boolean }>('tabs.navigate', { input }, opts.windowId)
    if (r.blocked) throw new Error(`navigation to ${input} was blocked`)
    const want = opts.expectUrl ?? input
    const ok = typeof want === 'string' ? (u: string) => u === want : want
    return this.waitSnap((s) => {
      const t = s.tabs.find((x) => x.id === s.activeTabId)
      return t && ok(t.url) && !t.loading
    }, `active tab at ${String(want)}`, { windowId: opts.windowId, timeout: opts.timeout })
  }

  /** Navigate the active tab to retronet://<host>/ and wait until its bridge is up. */
  async openInternal(host: string, windowId?: number): Promise<number> {
    await this.navigate(`retronet://${host}/`, { windowId, expectUrl: (u) => u.startsWith(`retronet://${host}/`) })
    const id = await this.activeTabWcId(windowId)
    await poll(() => this.js<boolean>(id, `location.hostname === ${JSON.stringify(host)} && typeof window.retronet === 'object'`), `${host} bridge`)
    return id
  }

  /** Key chord into a webContents: target 'tab' (active tab), 'shell', 'overlay', or a wc id. */
  async press(keyCode: string, modifiers: string[] = [], target: 'tab' | 'shell' | 'overlay' | number = 'tab', windowId?: number): Promise<void> {
    let wcId: number
    if (typeof target === 'number') wcId = target
    else if (target === 'tab') wcId = await this.activeTabWcId(windowId)
    else {
      const w = await this.win(windowId)
      wcId = target === 'shell' ? w.shellId : w.overlayId
    }
    await this.main(({ webContents }, a: { wcId: number; keyCode: string; modifiers: string[] }) => {
      const wc = webContents.fromId(a.wcId)
      if (!wc) throw new Error('no webContents')
      const mods = a.modifiers as Array<'shift' | 'control' | 'alt' | 'meta'>
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers: mods })
      if (a.keyCode.length === 1 && mods.length === 0) wc.sendInputEvent({ type: 'char', keyCode: a.keyCode, modifiers: mods })
      wc.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers: mods })
    }, { wcId, keyCode, modifiers })
  }

  /** Start collecting shell events of the given names in the window's shell (`window.__rnEv`). */
  async recordShellEvents(names: string[], windowId?: number): Promise<void> {
    const w = await this.win(windowId)
    await this.js(w.shellId, `(() => { window.__rnEv = []; for (const n of ${JSON.stringify(names)}) window.retronet.on(n, (p) => window.__rnEv.push({ e: n, p })); return true })()`)
  }

  async shellEvents<T = any>(name: string, windowId?: number): Promise<T[]> {
    const w = await this.win(windowId)
    return this.js<T[]>(w.shellId, `(window.__rnEv || []).filter((x) => x.e === ${JSON.stringify(name)}).map((x) => x.p)`)
  }

  async clearShellEvents(windowId?: number): Promise<void> {
    const w = await this.win(windowId)
    await this.js(w.shellId, `(window.__rnEv = [], true)`)
  }

  profiles<R = unknown>(fn: string, ...args: unknown[]): Promise<R> {
    return this.main(async (_e, a: { fn: string; args: unknown[] }) => await (globalThis as any).__rnProfiles[a.fn](...a.args), { fn, args }) as Promise<R>
  }

  /** Waits until a window with that id exists, its shell bridge is up and its active tab is loaded. */
  async waitWindowReady(windowId?: number, timeout = 15_000): Promise<WinInfo> {
    return poll(async () => {
      const all = await this.windows()
      const w = windowId === undefined ? all[0] : all.find((x) => x.id === windowId)
      if (!w || w.shellUrl !== 'retronet://shell/') return null
      const t = w.snapshot.tabs.find((x) => x.id === w.snapshot.activeTabId)
      if (!t || t.loading) return null
      const bridge = await this.js<boolean>(w.shellId, `typeof window.retronet === 'object' && document.readyState === 'complete'`)
      return bridge ? w : null
    }, `window ${windowId ?? '(first)'} ready`, timeout)
  }

  mainLog(): string {
    const f = join(this.userData, 'logs', 'main.log')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  /** Graceful quit (before-quit flushes every store), then wait for the process to exit. */
  async quit(): Promise<void> {
    if (this.closed) return
    const proc = this.app.process()
    const exited = new Promise<void>((r) => {
      if (proc.exitCode !== null) r()
      else proc.once('exit', () => r())
    })
    await this.main(({ app }) => {
      setTimeout(() => app.quit(), 20)
    }).catch(() => {})
    await Promise.race([exited, sleep(15_000)])
    await this.app.close().catch(() => {})
    this.closed = true
  }

  async kill(): Promise<void> {
    if (this.closed) return
    await Promise.race([this.app.close().catch(() => {}), sleep(10_000)])
    try {
      this.app.process().kill('SIGKILL')
    } catch {
      /* already gone */
    }
    this.closed = true
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function launchApp(opts: LaunchOptions = {}): Promise<RN> {
  const userData = opts.userData ?? tempDir('rn-e2e-ud-')
  const downloadsDir = opts.downloadsDir ?? tempDir('rn-e2e-dl-')
  const app = await _electron.launch({
    args: [...(opts.switches ?? []), ROOT],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      RETRONET_E2E: '1',
      RETRONET_USER_DATA: userData,
      RETRONET_DOWNLOADS_DIR: downloadsDir,
      ...(opts.env ?? {})
    },
    timeout: 30_000
  })
  const rn = new RN(app, userData, downloadsDir)
  await poll(() => app.evaluate(() => !!(globalThis as any).__rn && !!(globalThis as any).__rnProfiles), 'test hooks')
  if (opts.waitReady !== false) await rn.waitWindowReady()
  return rn
}

/** Log lines that indicate a real main-process problem. */
export function mainLogErrors(log: string): string[] {
  return log.split('\n').filter((l) => /uncaughtException|unhandledRejection|audit failed/.test(l))
}

interface Fixtures {
  rn: RN
  server: FixtureServer
}

/**
 * `rn`: a fresh app per test (own temp profile); quit gracefully afterwards, and its main.log must hold no
 * uncaught exceptions. `server`: local HTTP/HTTPS fixture server per test.
 */
export const test = base.extend<Fixtures>({
  server: async ({}, use) => {
    const s = await startServer()
    await use(s)
    await s.close()
  },
  rn: async ({}, use, testInfo) => {
    const rn = await launchApp()
    await use(rn)
    await rn.quit().catch(() => rn.kill())
    const errs = mainLogErrors(rn.mainLog())
    if (testInfo.status === testInfo.expectedStatus) {
      expect(errs, 'main.log has no uncaught exceptions').toEqual([])
    }
    rmSync(rn.userData, { recursive: true, force: true })
    rmSync(rn.downloadsDir, { recursive: true, force: true })
  }
})

export { expect }
