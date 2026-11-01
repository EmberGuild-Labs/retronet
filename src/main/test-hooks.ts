// E2E-only, read-only view of main state on `globalThis.__rn` (PLAN T7). Installed only when the app is
// unpackaged AND RETRONET_E2E=1 (app-paths.testHooksEnabled). Exposes snapshots, never live objects, so a
// test cannot mutate main through it. Tests drive the app through real IPC and `electronApp.evaluate`.
import { webContents } from 'electron'
import { router } from './ipc/router'
import type { WebPrefsAudit } from './security/web-prefs'
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

export function installTestHooks(): void {
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
