// The single factory for every webPreferences object (PLAN 1.9, AC34), plus the audit used on every
// webContents. Nothing else in the codebase may build webPreferences.
import type { Session, WebContents, WebPreferences } from 'electron'
import { EVENT_PREFIX, INVOKE_PREFIX, methodsFor, PAGE_EVENT_NAMES, SHELL_EVENT_NAMES } from '../../shared/ipc-contract'
import { PAGE_HOSTS, UI_HOSTS, type Caller } from '../../shared/types'
import { backgroundTestMode, preloadPath } from '../app-paths'

/** Flags shared by every webContents we create. */
const HARDENED = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  spellcheck: false,
  safeDialogs: true,
  navigateOnDragDrop: false,
  disableDialogs: false,
  enableWebSQL: false,
  plugins: false
} as const satisfies WebPreferences

/**
 * The preloads are sandboxed and can't import the contract, so main hands them the static method lists
 * (from `methodsFor`) as a process argument. Only names are passed; the router still validates everything.
 */
export function bridgeArgument(callers: readonly Caller[], events: readonly string[]): string {
  const spec = {
    v: 1,
    invokePrefix: INVOKE_PREFIX,
    eventPrefix: EVENT_PREFIX,
    methods: Object.fromEntries(callers.map((c) => [c, methodsFor(c)])),
    events
  }
  return '--rn-bridge=' + encodeURIComponent(JSON.stringify(spec))
}

const UI_BRIDGE = bridgeArgument(UI_HOSTS, SHELL_EVENT_NAMES)
const PAGE_BRIDGE = bridgeArgument(PAGE_HOSTS, PAGE_EVENT_NAMES)

/** Hidden test windows must keep timers/rAF running at full speed (see backgroundTestMode). */
function testRendering(): WebPreferences {
  return backgroundTestMode() ? { backgroundThrottling: false } : {}
}

/** Shell (BrowserWindow) and overlay webContents: default session, shell preload. */
export function uiWebPreferences(): WebPreferences {
  return { ...HARDENED, ...testRendering(), preload: preloadPath('shell'), additionalArguments: [UI_BRIDGE] }
}

/**
 * Tab webContents: profile or incognito session, internal preload (exposes nothing on web pages).
 * Pass exactly one of `session` or `partition`. Never the default session.
 * `plugins: true` on tabs only, for the built-in PDF viewer (AC51, SPIKE-X1): it runs as frames inside the tab
 * (no guest webContents) and its one subframe step is allowed by decidePdfViewerFrame. UI keeps plugins off.
 */
export function tabWebPreferences(target: { session: Session } | { partition: string }): WebPreferences {
  const where = 'session' in target ? { session: target.session } : { partition: target.partition }
  return {
    ...HARDENED,
    ...testRendering(),
    ...where,
    plugins: true,
    preload: preloadPath('internal'),
    additionalArguments: [PAGE_BRIDGE]
  }
}

/**
 * Forces our preferences over anything Chromium or a page asked for (window.open features,
 * `overrideBrowserWindowOptions`). Use when another API hands us a webPreferences object to fill.
 */
export function enforceTabPreferences(prefs: WebPreferences, target: { session: Session } | { partition: string }): WebPreferences {
  return Object.assign(prefs, tabWebPreferences(target))
}

export interface WebPrefsAudit {
  id: number
  type: string
  ok: boolean
  problems: string[]
  /** Set when the webContents is Electron-internal and not audited (devtools frontend). */
  skipped?: 'devtools'
}

/** Electron has this natively on every WebContents but leaves it out of the typings. */
type WithPrefs = WebContents & { getLastWebPreferences?: () => WebPreferences | null }

const REQUIRED: ReadonlyArray<[keyof WebPreferences, unknown]> = [
  ['sandbox', true],
  ['contextIsolation', true],
  ['nodeIntegration', false],
  ['nodeIntegrationInSubFrames', false],
  ['nodeIntegrationInWorker', false],
  ['webSecurity', true],
  ['allowRunningInsecureContent', false],
  ['webviewTag', false],
  ['experimentalFeatures', false]
]

/** Answers "did the window manager or tab code register this webContents with the router?" (`router.senderInfo`). */
export type IsRegistered = (wc: WebContents) => boolean

/**
 * Checks a webContents' effective preferences against the hardened set (AC34). Devtools frontends (type
 * 'remote', no webPreferences) are Electron-internal and skipped. Every other webContents must match
 * exactly, and its preload (if any) must be one of ours. The PDF viewer adds no webContents, so it has no
 * exception. `plugins` (on for tabs only, AC51) cannot be audited here: on Electron 45.2.1
 * getLastWebPreferences() reports neither `plugins` nor `preload`, so the split is enforced by the factories
 * above (HARDENED has plugins:false; only tabWebPreferences turns it on).
 *
 * With `isRegistered` (E2, AC75), a non-devtools webContents the router doesn't know also fails: every one we
 * create is registered right after construction, so an unknown one was built outside the factories. Only pass
 * it once registration had its chance (see scheduleWebContentsAudit), never inside `web-contents-created`.
 */
export function auditWebPreferences(wc: WebContents, isRegistered?: IsRegistered): WebPrefsAudit {
  const type = wc.getType()
  const getter = (wc as WithPrefs).getLastWebPreferences
  const prefs = typeof getter === 'function' ? getter.call(wc) : null
  if (!prefs && type === 'remote') return { id: wc.id, type, ok: true, problems: [], skipped: 'devtools' }
  const problems: string[] = []
  if (!prefs) {
    problems.push('no webPreferences')
  } else {
    for (const [key, want] of REQUIRED) {
      if (prefs[key] !== want) problems.push(`${key}=${String(prefs[key])} (want ${String(want)})`)
    }
    const preload = prefs.preload
    if (preload && preload !== preloadPath('shell') && preload !== preloadPath('internal')) {
      problems.push(`unexpected preload ${preload}`)
    }
  }
  if (isRegistered && !isRegistered(wc)) problems.push('not router-registered')
  return { id: wc.id, type, ok: problems.length === 0, problems }
}

/** How long an unregistered webContents gets before it fails (an adopted window.open guest registers a bit later). */
export const AUDIT_REGISTER_GRACE_MS = 1000
const AUDIT_RETRY_MS = 50

/**
 * Runs auditWebPreferences with the registration check from `web-contents-created`. The event fires inside the
 * BrowserWindow/WebContentsView constructor, before the caller can register it, so the first check runs a tick
 * later (setImmediate). A still-unregistered webContents is rechecked until AUDIT_REGISTER_GRACE_MS has passed,
 * then reported as failed. A webContents destroyed before the check is not reported. `onResult` runs once.
 */
export function scheduleWebContentsAudit(
  wc: WebContents,
  isRegistered: IsRegistered,
  onResult: (audit: WebPrefsAudit) => void,
  timers: { now: () => number; later: (fn: () => void, ms: number) => void } = defaultTimers
): void {
  const start = timers.now()
  const check = (): void => {
    if (wc.isDestroyed()) return
    const audit = auditWebPreferences(wc, isRegistered)
    const waiting = !audit.ok && audit.problems.length === 1 && audit.problems[0] === 'not router-registered'
    if (waiting && timers.now() - start < AUDIT_REGISTER_GRACE_MS) {
      timers.later(check, AUDIT_RETRY_MS)
      return
    }
    onResult(audit)
  }
  timers.later(check, 0)
}

const defaultTimers = {
  now: () => Date.now(),
  later: (fn: () => void, ms: number): void => {
    if (ms === 0) setImmediate(fn)
    else setTimeout(fn, ms)
  }
}

export interface SessionPreloadAudit {
  /** `ses.storagePath` (null for in-memory sessions such as incognito), to tell sessions apart in reports. */
  storagePath: string | null
  ok: boolean
  /** The preload scripts found on the session; we never register any (preloads go in webPreferences only). */
  preloads: string[]
}

/**
 * E2 (AC75): fails every session that has session-level preload scripts. Ours live in webPreferences, which the
 * factories control; a session preload would run in every frame of every webContents on that session.
 */
export function auditSessionPreloads(sessions: readonly Session[]): SessionPreloadAudit[] {
  return sessions.map((ses) => {
    const preloads = ses.getPreloadScripts().map((p) => p.filePath)
    return { storagePath: ses.storagePath ?? null, ok: preloads.length === 0, preloads }
  })
}
