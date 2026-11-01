// Filesystem locations. `applyUserDataOverride()` must run before `app` is ready.
import { isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'

/**
 * Dev and E2E only: RETRONET_USER_DATA points userData at a temp dir. Ignored in packaged builds so an
 * environment variable can never redirect a user's real profile.
 */
export function applyUserDataOverride(): string | null {
  const dir = process.env.RETRONET_USER_DATA
  if (app.isPackaged || !dir) return null
  const abs = isAbsolute(dir) ? dir : resolve(dir)
  app.setPath('userData', abs)
  // Chromium's own cache/session data follows userData; keep it inside the override too.
  app.setPath('sessionData', abs)
  return abs
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export function logsDir(): string {
  return join(userDataDir(), 'logs')
}

/** userData/Profiles/<id>/ holds the profile's JSON stores (Chromium data lives in Partitions/p-<id>). */
export function profilesDir(): string {
  return join(userDataDir(), 'Profiles')
}

export function profileDir(id: string): string {
  return join(profilesDir(), id)
}

/** userData/app-state.json (profile list, last profile, pending deletes; T11). */
export function appStateFile(): string {
  return join(userDataDir(), 'app-state.json')
}

/** out/preload/<name>.js next to out/main/index.js (works unpacked and inside the asar). */
export function preloadPath(name: 'shell' | 'internal'): string {
  return join(__dirname, '..', 'preload', `${name}.js`)
}

/** Built renderer root served by retronet:// (T5 default; exported for harnesses). */
export function rendererRoot(): string {
  return join(app.getAppPath(), 'out', 'renderer')
}

/** Dev/E2E test hooks are allowed only when unpackaged AND RETRONET_E2E=1. */
export function testHooksEnabled(): boolean {
  return !app.isPackaged && process.env.RETRONET_E2E === '1'
}

/**
 * Automated test runs (unpackaged + RETRONET_E2E=1) keep every window hidden and never activate the app,
 * so test runs don't take over the user's screen or focus. RETRONET_E2E_SHOW=1 shows windows for debugging.
 */
export function backgroundTestMode(): boolean {
  return testHooksEnabled() && process.env.RETRONET_E2E_SHOW !== '1'
}
