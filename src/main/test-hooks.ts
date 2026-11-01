// E2E-only, read-only view of main state on `globalThis.__rn` (PLAN T7). Installed only when the app is
// unpackaged AND RETRONET_E2E=1 (app-paths.testHooksEnabled). Exposes snapshots, never live objects, so a
// test cannot mutate main through it. Tests drive the app through real IPC and `electronApp.evaluate`.
import { session as electronSession, webContents, type Session } from 'electron'
import { testHooksEnabled } from './app-paths'
import { currentMenu, dismissMenu, nativeFallbackCount, pickMenu } from './menus/menu-host'
import { router } from './ipc/router'
import { setNativeDialogsForTests } from './native-dialogs'
import { auditSessionPreloads, type WebPrefsAudit } from './security/web-prefs'
import { flushAllStores } from './storage/json-store'
import { saveNow } from './tabs/session-restore'
import { windowManager } from './windows/window-manager'

/** Named timing marks in ms since process start (e.g. `shellReady`, AC44). Always recorded; cheap. */
export const timings: Record<string, number> = {}

export function markTiming(name: string): number {
  const ms = Math.round(process.uptime() * 1000)
  if (!(name in timings)) timings[name] = ms
  return timings[name] as number
}

const audits: Array<WebPrefsAudit & { url: string }> = []

/** Called from `web-contents-created` (always; the list is only exposed with hooks on). */
export function recordAudit(a: WebPrefsAudit, url: string): void {
  if (audits.length < 1000) audits.push({ ...a, url })
}

let quitFlushes = 0
export function recordQuitFlush(): void {
  quitFlushes++
}

/**
 * Native open/save dialogs under test (AC49, AC50): a real one would appear on the user's screen, so with hooks on
 * every request is answered from a queue the test fills through `globalThis.__rnDialogs`. Empty queue = cancel.
 */
function installDialogTestHooks(): void {
  const answers: Array<{ kind: 'open' | 'save'; path: string | null }> = []
  const calls: Array<{ kind: 'open' | 'save'; title: string | null; answered: string | null }> = []
  const answer = (kind: 'open' | 'save', title: string | undefined): string | null => {
    const i = answers.findIndex((a) => a.kind === kind)
    const path = i >= 0 ? (answers.splice(i, 1)[0]?.path ?? null) : null
    calls.push({ kind, title: title ?? null, answered: path })
    return path
  }
  setNativeDialogsForTests({
    open: async (_win, opts) => answer('open', opts.title),
    save: async (_win, opts) => answer('save', opts.title)
  })
  const api = {
    /** Queue the answer for the next dialog of that kind: a path, or null for "Cancel". */
    queue: (kind: 'open' | 'save', path: string | null) => {
      answers.push({ kind, path })
    },
    calls: () => calls.map((c) => ({ ...c }))
  }
  Object.defineProperty(globalThis, '__rnDialogs', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false })
}

/** Every distinct session in use: the default one, each window's profile/incognito session, and any webContents'. */
function allSessions(): Session[] {
  const set = new Set<Session>([electronSession.defaultSession])
  for (const w of windowManager.all()) set.add(w.profile.session)
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) set.add(wc.session)
  return [...set]
}

/** Installs `__rn` and `__rnDialogs`. Refuses (no-op) unless testHooksEnabled(), whatever the caller checked. */
export function installTestHooks(): void {
  if (!testHooksEnabled()) return
  installDialogTestHooks()
  const api = {
    windows: () =>
      windowManager.all().map((w) => ({
        id: w.id,
        profileId: w.profile.id,
        incognito: w.incognito,
        popup: w.popup,
        shellId: w.shell.id,
        shellUrl: w.shell.getURL(),
        overlayId: w.overlay.webContents.id,
        overlayUrl: w.overlay.webContents.getURL(),
        overlayKind: w.overlayKind(),
        insets: { ...w.insets },
        tabBounds: w.tabBounds(),
        snapshot: structuredClone(w.snapshot())
      })),
    webContents: () => webContents.getAllWebContents().map((wc) => ({ id: wc.id, type: wc.getType(), url: wc.getURL() })),
    audits: () => audits.map((a) => ({ ...a, problems: [...a.problems] })),
    /** The menu window `windowId` shows now (a copy) or null, plus how many menus fell back to native (A2). */
    menu: (windowId: number) => ({ spec: structuredClone(currentMenu(windowId)), fallbackCount: nativeFallbackCount() }),
    currentMenu: (windowId: number) => structuredClone(currentMenu(windowId)),
    nativeFallbackCount: () => nativeFallbackCount(),
    /** Goes through the real `menu.pick` validation (menuId, enabled leaf, isValid). Returns whether it was scheduled. */
    pickMenu: (windowId: number, req: Parameters<typeof pickMenu>[1]) => pickMenu(windowId, structuredClone(req)),
    dismissMenu: (windowId: number, menuId: string) => dismissMenu(windowId, menuId),
    /** AC75: `auditSessionPreloads` over the default, every profile and every incognito session in use. */
    auditSessions: () => auditSessionPreloads(allSessions()).map((a) => ({ ...a, preloads: [...a.preloads] })),
    rejections: () => router.recentRejections().map((r) => ({ ...r })),
    timings: () => ({ ...timings }),
    quitFlushes: () => quitFlushes,
    /** Save the session now and write every store; resolves true once everything is on disk (R8). */
    flush: async (): Promise<boolean> => {
      saveNow()
      await flushAllStores()
      return true
    }
  }
  Object.defineProperty(globalThis, '__rn', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false })
}
