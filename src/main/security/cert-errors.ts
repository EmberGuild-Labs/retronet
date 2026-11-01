// Certificate errors and the error interstitials (AC37, PLAN 1.7).
// A bad certificate is never accepted silently: the tab shows retronet://certerror/, and only an explicit
// "Proceed" adds (host:port, certificate fingerprint) to an in-memory allow set for that one session (S7: a
// different bad certificate for the same host is refused again). Nothing here is ever written to disk, so
// incognito and app restarts start clean.
// Known limitation: Chromium itself refuses to show any override for HSTS / preloaded hosts only in its own UI;
// here the HSTS state is not consulted, so Proceed is offered for those too (the cert is still pinned).
//
// The certerror/neterror pages call certerror.proceed/back and neterror.retry with `{}`, so main remembers which
// URL each interstitial stands for, per webContents (see `proceedCertError`, `leaveCertError`, `retryNetError`).
import * as electron from 'electron'
import type { Session, WebContents } from 'electron'

export const CERTERROR_URL = 'retronet://certerror/'
export const NETERROR_URL = 'retronet://neterror/'
/** Where "Back" goes when there is no earlier page. */
export const FALLBACK_URL = 'retronet://newtab/'
/** Interstitials remembered per webContents (older ones are dropped; reached via Back they show but do nothing). */
const MAX_REMEMBERED = 20

export type InterstitialKind = 'cert' | 'net'

export interface BlockedNavigation {
  kind: InterstitialKind
  /** The page the user was trying to reach. */
  url: string
  /** Chromium error name, e.g. `net::ERR_CERT_AUTHORITY_INVALID` or `ERR_NAME_NOT_RESOLVED`. */
  code: string
  /** cert only: the refused certificate's fingerprint (`sha256/...`), which Proceed pins. Main-side only. */
  fingerprint?: string
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

/** The allow-set key for a URL: lowercase host plus non-default port. Null for non-https URLs. */
export function certHostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.host ? u.host.toLowerCase() : null
  } catch {
    return null
  }
}

/** Accepts a bare host (`example.com`, `example.com:8443`) or a full https URL. */
function normaliseHost(hostOrUrl: string): string | null {
  if (hostOrUrl.includes('://')) return certHostOf(hostOrUrl)
  const h = hostOrUrl.trim().toLowerCase()
  return h && !/[\s/?#@]/.test(h) ? h : null
}

/** Chromium's certificate errors are net error codes -200 to -299. */
export function isCertErrorCode(errorCode: number): boolean {
  return errorCode <= -200 && errorCode > -300
}

/** The interstitial URL for a blocked navigation. The query is for display only; main never trusts it. */
export function interstitialUrlFor(entry: BlockedNavigation): string {
  const base = entry.kind === 'cert' ? CERTERROR_URL : NETERROR_URL
  return `${base}?url=${encodeURIComponent(entry.url)}&code=${encodeURIComponent(entry.code)}`
}

// ---------------------------------------------------------------------------------------------------------------
// Per-session allow set (memory only)

/** host:port -> fingerprints the user proceeded with. */
const allowed = new WeakMap<Session, Map<string, Set<string>>>()

/**
 * Trust the bad certificate with `fingerprint` from `host` for this session only, until the session goes away or
 * the app quits. Without a fingerprint nothing is trusted.
 */
export function allowCertForHost(ses: Session, hostOrUrl: string, fingerprint: string): void {
  const host = normaliseHost(hostOrUrl)
  if (!host || !fingerprint) return
  let map = allowed.get(ses)
  if (!map) allowed.set(ses, (map = new Map()))
  let fps = map.get(host)
  if (!fps) map.set(host, (fps = new Set()))
  fps.add(fingerprint)
}

/** True when this exact certificate was accepted with "Proceed" for `host` in this session. */
export function isCertAllowed(ses: Session, hostOrUrl: string, fingerprint: string | undefined): boolean {
  const host = normaliseHost(hostOrUrl)
  return host !== null && !!fingerprint && (allowed.get(ses)?.get(host)?.has(fingerprint) ?? false)
}

/** True when the user chose "Proceed" for some certificate of `host` in this session. Drives the `cert-warning` state. */
export function isCertOverridden(ses: Session, hostOrUrl: string): boolean {
  const host = normaliseHost(hostOrUrl)
  return host !== null && (allowed.get(ses)?.get(host)?.size ?? 0) > 0
}

/** Forget every override for a session (e.g. when its data is cleared). */
export function clearCertOverrides(ses: Session): void {
  allowed.delete(ses)
}

// ---------------------------------------------------------------------------------------------------------------
// Per-webContents interstitial memory

const remembered = new WeakMap<WebContents, Map<string, BlockedNavigation>>()

function rememberedFor(wc: WebContents): Map<string, BlockedNavigation> {
  let m = remembered.get(wc)
  if (!m) remembered.set(wc, (m = new Map()))
  return m
}

/** The blocked navigation the interstitial currently shown in `wc` stands for, if main put it there. */
export function getBlockedNavigation(wc: WebContents): BlockedNavigation | undefined {
  if (wc.isDestroyed()) return undefined
  return remembered.get(wc)?.get(wc.getURL())
}

/**
 * Show the cert or net error interstitial in `wc` for `entry` and remember it. T12 calls this with
 * kind 'net' from `did-fail-load` (main frame, not ERR_ABORTED, not a cert error); cert errors are handled here.
 */
export function showInterstitial(wc: WebContents, entry: BlockedNavigation): void {
  if (wc.isDestroyed()) return
  const target = interstitialUrlFor(entry)
  const m = rememberedFor(wc)
  m.delete(target)
  m.set(target, { ...entry })
  while (m.size > MAX_REMEMBERED) m.delete(m.keys().next().value as string)
  dropPreviousEntryOnCommit(wc, target, (prev) => prev === entry.url)
  void wc.loadURL(target).catch(() => undefined)
}

/**
 * Once `target` commits, remove the history entry right before it if `isStale(url)`. Used to drop Chromium's
 * own error-page entry under an interstitial (so Back doesn't re-trigger the error) and the interstitial under
 * a page reached by Proceed or Retry.
 */
function dropPreviousEntryOnCommit(wc: WebContents, target: string, isStale: (url: string) => boolean): void {
  const onNavigate = (_e: unknown, url: string): void => {
    wc.off('did-navigate', onNavigate)
    if (url !== target || wc.isDestroyed()) return
    const h = wc.navigationHistory
    const prev = h.getActiveIndex() - 1
    if (prev >= 0 && isStale(h.getEntryAtIndex(prev).url)) h.removeEntryAtIndex(prev)
  }
  wc.on('did-navigate', onNavigate)
}

function isInterstitial(url: string): boolean {
  return url.startsWith(CERTERROR_URL) || url.startsWith(NETERROR_URL)
}

/**
 * certerror.proceed: trust the host for this session and load the blocked page. Only works while `wc` shows an
 * interstitial that main itself loaded; returns false otherwise. Call with the certerror tab's own webContents.
 */
export function proceedCertError(wc: WebContents): boolean {
  const entry = getBlockedNavigation(wc)
  if (!entry || entry.kind !== 'cert' || !wc.getURL().startsWith(CERTERROR_URL)) return false
  const host = certHostOf(entry.url)
  if (!host || !entry.fingerprint) return false
  allowCertForHost(wc.session, host, entry.fingerprint)
  dropPreviousEntryOnCommit(wc, entry.url, isInterstitial)
  void wc.loadURL(entry.url).catch(() => undefined)
  return true
}

/** neterror.retry: load the failed page again. Returns false if `wc` is not showing a net error interstitial. */
export function retryNetError(wc: WebContents): boolean {
  const entry = getBlockedNavigation(wc)
  if (!entry || entry.kind !== 'net' || !wc.getURL().startsWith(NETERROR_URL)) return false
  dropPreviousEntryOnCommit(wc, entry.url, isInterstitial)
  void wc.loadURL(entry.url).catch(() => undefined)
  return true
}

/**
 * certerror.back: go to the last page before the blocked one, skipping the blocked URL and other interstitials.
 * Falls back to the new-tab page. Returns false if `wc` is not showing a cert error interstitial.
 */
export function leaveCertError(wc: WebContents): boolean {
  const entry = getBlockedNavigation(wc)
  if (!entry || !wc.getURL().startsWith(CERTERROR_URL)) return false
  const h = wc.navigationHistory
  for (let i = h.getActiveIndex() - 1; i >= 0; i--) {
    const url = h.getEntryAtIndex(i).url
    if (url !== entry.url && !isInterstitial(url)) {
      h.goToIndex(i)
      return true
    }
  }
  void wc.loadURL(FALLBACK_URL).catch(() => undefined)
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// app 'certificate-error'

/** Returns a truthy value for webContents that are browser tabs (or popups). Shell/overlay/unknown: falsy. */
export type TabLookup = (wc: WebContents) => unknown

let installed = false

/**
 * Install the one app-wide `certificate-error` handler (call once, at startup). Hosts in the session's allow
 * set are trusted; everything else is refused, and a refused main-frame load in a tab shows the interstitial.
 * Subresources with bad certificates are simply refused (the page loads without them).
 */
export function installCertErrorHandling(getTabForWc: TabLookup): void {
  if (installed) return
  installed = true
  electron.app.on('certificate-error', (event, wc, url, error, cert, callback, isMainFrame) => {
    event.preventDefault()
    const host = certHostOf(url)
    const fingerprint = typeof cert?.fingerprint === 'string' && cert.fingerprint ? cert.fingerprint : undefined
    if (host && isCertAllowed(wc.session, host, fingerprint)) {
      callback(true)
      return
    }
    callback(false)
    if (!isMainFrame || !getTabForWc(wc)) return
    // Wait for Chromium to finish failing the navigation (its error page commits first), then replace it.
    pendingCert.set(wc, { kind: 'cert', url, code: error, ...(fingerprint ? { fingerprint } : {}) })
    if (!watched.has(wc)) {
      watched.add(wc)
      wc.on('did-fail-load', (_e, errorCode, _desc, failedUrl, mainFrame) => {
        const p = pendingCert.get(wc)
        if (!mainFrame || !p || !isCertErrorCode(errorCode)) return
        pendingCert.delete(wc)
        setImmediate(() => showInterstitial(wc, { ...p, url: failedUrl || p.url }))
      })
    }
  })
}

const pendingCert = new WeakMap<WebContents, BlockedNavigation>()
const watched = new WeakSet<WebContents>()
