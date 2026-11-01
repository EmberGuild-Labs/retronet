import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  showMessageBox: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: (ev: string, fn: (...args: unknown[]) => void) => electronMock.appHandlers.set(ev, fn) },
  dialog: { showMessageBox: electronMock.showMessageBox },
  shell: { openExternal: electronMock.openExternal }
}))

import type { Session, WebContents } from 'electron'
import {
  allowCertForHost,
  certHostOf,
  clearCertOverrides,
  getBlockedNavigation,
  installCertErrorHandling,
  interstitialUrlFor,
  isCertAllowed,
  isCertErrorCode,
  isCertOverridden,
  leaveCertError,
  proceedCertError,
  retryNetError,
  showInterstitial
} from '../../src/main/security/cert-errors'
import { externalPromptOptions, externalTarget, requestExternal } from '../../src/main/security/external-protocols'

const fakeSession = (): Session => ({}) as Session

/** Minimal webContents: loadURL commits immediately and fires did-navigate. */
function fakeWc(ses: Session = fakeSession()) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  const entries: string[] = []
  let active = -1
  const emit = (ev: string, ...a: unknown[]) => [...(listeners.get(ev) ?? [])].forEach((f) => f({}, ...a))
  const wc = {
    session: ses,
    isDestroyed: () => false,
    getURL: () => entries[active] ?? '',
    on(ev: string, f: (...a: unknown[]) => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(f)
      return wc
    },
    off(ev: string, f: (...a: unknown[]) => void) {
      listeners.get(ev)?.delete(f)
      return wc
    },
    loadURL: vi.fn(async (url: string) => {
      entries.splice(active + 1)
      entries.push(url)
      active = entries.length - 1
      emit('did-navigate', url)
    }),
    navigationHistory: {
      getActiveIndex: () => active,
      getEntryAtIndex: (i: number) => ({ url: entries[i]! }),
      removeEntryAtIndex: (i: number) => {
        if (i === active) return false
        entries.splice(i, 1)
        if (i < active) active--
        return true
      },
      goToIndex: (i: number) => {
        active = i
      }
    },
    emit,
    entries
  }
  return wc as unknown as WebContents & { emit: typeof emit; entries: string[]; loadURL: ReturnType<typeof vi.fn> }
}

describe('pure helpers', () => {
  it('certHostOf keys by lowercase host:port, https only', () => {
    expect(certHostOf('https://Expired.BadSSL.com/x?y')).toBe('expired.badssl.com')
    expect(certHostOf('https://a.test:8443/')).toBe('a.test:8443')
    expect(certHostOf('http://a.test/')).toBeNull()
    expect(certHostOf('nope')).toBeNull()
  })
  it('isCertErrorCode covers -200..-299', () => {
    expect(isCertErrorCode(-202)).toBe(true)
    expect(isCertErrorCode(-200)).toBe(true)
    expect(isCertErrorCode(-299)).toBe(true)
    expect(isCertErrorCode(-105)).toBe(false)
    expect(isCertErrorCode(-300)).toBe(false)
    expect(isCertErrorCode(-3)).toBe(false)
  })
  it('interstitialUrlFor encodes url and code', () => {
    expect(interstitialUrlFor({ kind: 'cert', url: 'https://a.test/?q=1&r=2', code: 'net::ERR_CERT_DATE_INVALID' })).toBe(
      'retronet://certerror/?url=https%3A%2F%2Fa.test%2F%3Fq%3D1%26r%3D2&code=net%3A%3AERR_CERT_DATE_INVALID'
    )
    expect(interstitialUrlFor({ kind: 'net', url: 'http://x.test/', code: 'ERR_NAME_NOT_RESOLVED' }).startsWith('retronet://neterror/?url=')).toBe(true)
  })
})

describe('per-session allow set', () => {
  it('is per session and per host, and clearable', () => {
    const a = fakeSession()
    const b = fakeSession()
    allowCertForHost(a, 'https://self-signed.test/page', 'sha256/AAA')
    expect(isCertOverridden(a, 'self-signed.test')).toBe(true)
    expect(isCertAllowed(a, 'self-signed.test', 'sha256/AAA')).toBe(true)
    expect(isCertAllowed(a, 'self-signed.test', 'sha256/BBB')).toBe(false)
    expect(isCertAllowed(a, 'self-signed.test', undefined)).toBe(false)
    expect(isCertOverridden(a, 'https://SELF-SIGNED.test/other')).toBe(true)
    expect(isCertOverridden(a, 'self-signed.test:8443')).toBe(false)
    expect(isCertOverridden(a, 'other.test')).toBe(false)
    expect(isCertOverridden(b, 'self-signed.test')).toBe(false)
    clearCertOverrides(a)
    expect(isCertOverridden(a, 'self-signed.test')).toBe(false)
  })
  it('ignores junk hosts', () => {
    const a = fakeSession()
    allowCertForHost(a, 'http://plain.test/', 'sha256/AAA')
    allowCertForHost(a, 'a b', 'sha256/AAA')
    allowCertForHost(a, 'nofp.test', '')
    expect(isCertOverridden(a, 'plain.test')).toBe(false)
    expect(isCertOverridden(a, 'nofp.test')).toBe(false)
  })
})

describe('certificate-error handler and interstitial flow', () => {
  const tabs = new WeakSet<object>()
  installCertErrorHandling((wc) => tabs.has(wc))
  const handler = electronMock.appHandlers.get('certificate-error')!

  function fire(wc: WebContents, url: string, isMainFrame = true, fingerprint = 'sha256/GOOD') {
    const event = { preventDefault: vi.fn() }
    const callback = vi.fn()
    handler(event, wc, url, 'net::ERR_CERT_AUTHORITY_INVALID', { fingerprint }, callback, isMainFrame)
    return { event, callback }
  }

  it('refuses an untrusted cert, then shows the interstitial after the load fails; never silent', async () => {
    const wc = fakeWc()
    tabs.add(wc)
    await wc.loadURL('https://start.test/')
    const { event, callback } = fire(wc, 'https://bad.test/')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith(false)
    // Chromium commits its own error page, then did-fail-load fires.
    await wc.loadURL('https://bad.test/')
    wc.emit('did-fail-load', -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://bad.test/', true)
    await new Promise((r) => setImmediate(r))
    expect(wc.getURL()).toBe(interstitialUrlFor({ kind: 'cert', url: 'https://bad.test/', code: 'net::ERR_CERT_AUTHORITY_INVALID' }))
    // The error-page entry under the interstitial was removed, so Back goes to the start page.
    expect(wc.entries).toEqual(['https://start.test/', wc.getURL()])
    expect(getBlockedNavigation(wc)).toEqual({ kind: 'cert', url: 'https://bad.test/', code: 'net::ERR_CERT_AUTHORITY_INVALID', fingerprint: 'sha256/GOOD' })
    expect(isCertOverridden(wc.session, 'bad.test')).toBe(false)
  })

  it('proceed trusts the host for that session only, reloads, and later errors pass', async () => {
    const wc = fakeWc()
    tabs.add(wc)
    showInterstitial(wc, { kind: 'cert', url: 'https://proceed.test/a', code: 'net::ERR_CERT_DATE_INVALID', fingerprint: 'sha256/GOOD' })
    expect(proceedCertError(wc)).toBe(true)
    expect(wc.getURL()).toBe('https://proceed.test/a')
    expect(wc.entries).toEqual(['https://proceed.test/a']) // interstitial entry dropped
    expect(isCertOverridden(wc.session, 'proceed.test')).toBe(true)
    expect(fire(wc, 'https://proceed.test/b').callback).toHaveBeenCalledWith(true)
    // S7: the override is pinned to that certificate; a different bad cert for the same host is refused again.
    expect(fire(wc, 'https://proceed.test/c', true, 'sha256/EVIL').callback).toHaveBeenCalledWith(false)
    expect(fire(wc, 'https://proceed.test:8443/c').callback).toHaveBeenCalledWith(false)
    const other = fakeWc()
    tabs.add(other)
    expect(fire(other, 'https://proceed.test/b').callback).toHaveBeenCalledWith(false)
  })

  it('proceed/back/retry do nothing unless main showed that interstitial in this webContents', async () => {
    const wc = fakeWc()
    await wc.loadURL('retronet://certerror/?url=https%3A%2F%2Fforged.test%2F&code=x') // not loaded by main
    expect(proceedCertError(wc)).toBe(false)
    expect(leaveCertError(wc)).toBe(false)
    expect(retryNetError(wc)).toBe(false)
    expect(isCertOverridden(wc.session, 'forged.test')).toBe(false)
    showInterstitial(wc, { kind: 'net', url: 'http://down.test/', code: 'ERR_CONNECTION_REFUSED' })
    expect(proceedCertError(wc)).toBe(false) // a net error can't be "proceeded"
    expect(retryNetError(wc)).toBe(true)
    expect(wc.getURL()).toBe('http://down.test/')
  })

  it('proceed refuses when the refused certificate had no fingerprint (nothing to pin)', () => {
    const wc = fakeWc()
    showInterstitial(wc, { kind: 'cert', url: 'https://nofp.test/', code: 'E' })
    expect(proceedCertError(wc)).toBe(false)
    expect(isCertOverridden(wc.session, 'nofp.test')).toBe(false)
  })

  it('back skips the blocked URL; falls back to the new-tab page', async () => {
    const wc = fakeWc()
    showInterstitial(wc, { kind: 'cert', url: 'https://bad.test/', code: 'E' })
    expect(leaveCertError(wc)).toBe(true)
    expect(wc.getURL()).toBe('retronet://newtab/')
    const wc2 = fakeWc()
    await wc2.loadURL('https://home.test/')
    showInterstitial(wc2, { kind: 'cert', url: 'https://bad.test/', code: 'E' })
    expect(leaveCertError(wc2)).toBe(true)
    expect(wc2.getURL()).toBe('https://home.test/')
  })

  it('subresource cert errors and non-tab webContents are refused without an interstitial', () => {
    const wc = fakeWc()
    tabs.add(wc)
    expect(fire(wc, 'https://cdn.bad.test/x.js', false).callback).toHaveBeenCalledWith(false)
    const shell = fakeWc()
    expect(fire(shell, 'https://bad.test/').callback).toHaveBeenCalledWith(false)
    shell.emit('did-fail-load', -202, 'x', 'https://bad.test/', true)
    expect(shell.loadURL).not.toHaveBeenCalled()
  })
})

describe('external protocols', () => {
  beforeEach(() => {
    electronMock.showMessageBox.mockReset()
    electronMock.openExternal.mockReset()
  })
  const win = { isDestroyed: () => false } as never

  it('externalTarget allows only mailto/tel/sms', () => {
    expect(externalTarget('mailto:a@b.test')).toBe('mailto:a@b.test')
    expect(externalTarget('tel:+1555')).toBe('tel:+1555')
    expect(externalTarget('sms:+1555')).toBe('sms:+1555')
    for (const url of ['file:///etc/hosts', 'javascript:1', 'zoommtg://x', 'ms-settings:', 'smb://host/share', 'https://a.test/']) {
      expect(externalTarget(url)).toBeNull()
    }
    expect(externalTarget(`mailto:${'a'.repeat(3000)}@b.test`)).toBeNull()
  })

  it('prompt names the app and shows the link, Cancel is the default', () => {
    const o = externalPromptOptions('mailto:a@b.test')
    expect(o.message).toContain('email')
    expect(o.detail).toContain('mailto:a@b.test')
    expect(o.defaultId).toBe(1)
    expect(o.cancelId).toBe(1)
  })

  it('opens only after the user clicks Open', async () => {
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await requestExternal('mailto:a@b.test', win)).toBe('cancelled')
    expect(electronMock.openExternal).not.toHaveBeenCalled()
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await requestExternal('mailto:a@b.test', win)).toBe('opened')
    expect(electronMock.openExternal).toHaveBeenCalledWith('mailto:a@b.test', { activate: true })
  })

  it('blocks other schemes without prompting, and drops requests while a prompt is open', async () => {
    expect(await requestExternal('zoommtg://x', win)).toBe('blocked')
    expect(electronMock.showMessageBox).not.toHaveBeenCalled()
    let resolve!: (v: { response: number }) => void
    electronMock.showMessageBox.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const first = requestExternal('tel:1', win)
    expect(await requestExternal('tel:2', win)).toBe('busy')
    resolve({ response: 1 })
    expect(await first).toBe('cancelled')
    expect(electronMock.openExternal).not.toHaveBeenCalled()
  })
})
