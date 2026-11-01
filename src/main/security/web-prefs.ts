// The single factory for every webPreferences object (PLAN 1.9, AC34), plus the audit used on every
// webContents. Nothing else in the codebase may build webPreferences.
import type { Session, WebContents, WebPreferences } from 'electron'
import { EVENT_PREFIX, INVOKE_PREFIX, methodsFor, PAGE_EVENT_NAMES, SHELL_EVENT_NAMES } from '../../shared/ipc-contract'
import { PAGE_HOSTS, UI_HOSTS, type Caller } from '../../shared/types'
import { preloadPath } from '../app-paths'

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
  enableWebSQL: false
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

/** Shell (BrowserWindow) and overlay webContents: default session, shell preload. */
export function uiWebPreferences(): WebPreferences {
  return { ...HARDENED, preload: preloadPath('shell'), additionalArguments: [UI_BRIDGE] }
}

/**
 * Tab webContents: profile or incognito session, internal preload (exposes nothing on web pages).
 * Pass exactly one of `session` or `partition`. Never the default session.
 */
export function tabWebPreferences(target: { session: Session } | { partition: string }): WebPreferences {
  const where = 'session' in target ? { session: target.session } : { partition: target.partition }
  return { ...HARDENED, ...where, preload: preloadPath('internal'), additionalArguments: [PAGE_BRIDGE] }
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

/**
 * Checks a webContents' effective preferences against the hardened set (AC34). Devtools frontends (type
 * 'remote', no webPreferences) are Electron-internal and skipped. Every other webContents must match
 * exactly, and its preload (if any) must be one of ours.
 */
export function auditWebPreferences(wc: WebContents): WebPrefsAudit {
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
  return { id: wc.id, type, ok: problems.length === 0, problems }
}
