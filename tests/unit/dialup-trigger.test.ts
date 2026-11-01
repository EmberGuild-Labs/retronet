// X12: the dial-up trigger predicate (AC55) and the view-source history rule (AC54).
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class Stub {}
  return {
    app: { isPackaged: false, getPath: () => '/tmp', on: vi.fn() },
    BrowserWindow: Stub,
    WebContentsView: Stub,
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: {},
    session: {},
    shell: {},
    webContents: { getAllWebContents: () => [] }
  }
})

import { DIALUP_MIN_INTERVAL_MS, shouldPlayDialup, type DialupContext } from '../../src/main/tabs/tab'

const base: DialupContext = { settingOn: true, incognito: false, userStarted: true, url: 'https://example.org/', active: true, muted: false, nowMs: 100_000, lastSentMs: null }

describe('shouldPlayDialup', () => {
  it('plays for a user-started load in the active tab', () => expect(shouldPlayDialup(base)).toBe(true))
  it('is off when the setting is off', () => expect(shouldPlayDialup({ ...base, settingOn: false })).toBe(false))
  it('never in incognito', () => expect(shouldPlayDialup({ ...base, incognito: true })).toBe(false))
  it('not for popups', () => expect(shouldPlayDialup({ ...base, popup: true })).toBe(false))
  it('not for link clicks, reloads, restores (userStarted false)', () => expect(shouldPlayDialup({ ...base, userStarted: false })).toBe(false))
  it('plays only for http(s) targets (R31)', () => {
    for (const url of ['http://example.org/', 'https://example.org/x']) expect(shouldPlayDialup({ ...base, url })).toBe(true)
    for (const url of ['file:///tmp/a.html', 'retronet://newtab/', 'view-source:https://example.org/', 'about:blank', 'data:text/html,x', '', 'not a url'])
      expect(shouldPlayDialup({ ...base, url }), url).toBe(false)
  })
  it('not for background tabs', () => expect(shouldPlayDialup({ ...base, active: false })).toBe(false))
  it('not for muted tabs', () => expect(shouldPlayDialup({ ...base, muted: true })).toBe(false))
  it('throttles to once per 10 s per window', () => {
    expect(shouldPlayDialup({ ...base, lastSentMs: base.nowMs - 1000 })).toBe(false)
    expect(shouldPlayDialup({ ...base, lastSentMs: base.nowMs - (DIALUP_MIN_INTERVAL_MS - 1) })).toBe(false)
    expect(shouldPlayDialup({ ...base, lastSentMs: base.nowMs - DIALUP_MIN_INTERVAL_MS })).toBe(true)
  })
})
