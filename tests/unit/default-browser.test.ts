import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    isDefaultProtocolClient: vi.fn((_s: string) => false),
    setAsDefaultProtocolClient: vi.fn((_s: string) => true)
  }
}))
vi.mock('electron', () => electron)

import { getStatus, requestDefault, resetFakeDefaultBrowser, resolveOverride } from '../../src/main/os-integration/default-browser'

const { app } = electron
const setPlatform = (p: string): void => { Object.defineProperty(process, 'platform', { value: p }) }
const realPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.RETRONET_E2E
  delete process.env.RETRONET_TEST_DEFAULT_BROWSER
  app.isPackaged = false
  setPlatform(realPlatform)
  resetFakeDefaultBrowser()
})

describe('resolveOverride', () => {
  const env = { RETRONET_TEST_DEFAULT_BROWSER: 'fake' }
  it('is active only unpackaged + e2e + env', () => {
    expect(resolveOverride(env, { packaged: false, e2e: true })).toBe('fake')
    expect(resolveOverride(env, { packaged: true, e2e: true })).toBeNull()
    expect(resolveOverride(env, { packaged: false, e2e: false })).toBeNull()
    expect(resolveOverride({}, { packaged: false, e2e: true })).toBeNull()
    expect(resolveOverride({ RETRONET_TEST_DEFAULT_BROWSER: 'real' }, { packaged: false, e2e: true })).toBeNull()
  })
})

describe('unpackaged', () => {
  it('reports unsupported and never touches the OS', () => {
    expect(getStatus()).toEqual({ supported: false, isDefault: false, reason: 'unpackaged' })
    expect(requestDefault()).toEqual({ requested: false, isDefault: false })
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
  it('fake env without the e2e gate is ignored', () => {
    process.env.RETRONET_TEST_DEFAULT_BROWSER = 'fake'
    expect(getStatus().reason).toBe('unpackaged')
  })
  it('fake works under the gate: not default, then default', () => {
    process.env.RETRONET_E2E = '1'
    process.env.RETRONET_TEST_DEFAULT_BROWSER = 'fake'
    expect(getStatus()).toEqual({ supported: true, isDefault: false })
    expect(requestDefault()).toEqual({ requested: true, isDefault: true })
    expect(getStatus()).toEqual({ supported: true, isDefault: true })
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
  it('fake is ignored when packaged', () => {
    process.env.RETRONET_E2E = '1'
    process.env.RETRONET_TEST_DEFAULT_BROWSER = 'fake'
    app.isPackaged = true
    setPlatform('darwin')
    expect(getStatus().supported).toBe(true)
    requestDefault()
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalled()
  })
})

describe('packaged', () => {
  beforeEach(() => { app.isPackaged = true })
  it('non-macOS is unsupported (platform)', () => {
    setPlatform('win32')
    expect(getStatus()).toEqual({ supported: false, isDefault: false, reason: 'platform' })
    expect(requestDefault().requested).toBe(false)
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
  it('macOS status needs both schemes', () => {
    setPlatform('darwin')
    app.isDefaultProtocolClient.mockImplementation((s: string) => s === 'http')
    expect(getStatus()).toEqual({ supported: true, isDefault: false })
    app.isDefaultProtocolClient.mockReturnValue(true)
    expect(getStatus().isDefault).toBe(true)
  })
  it('set calls both schemes', () => {
    setPlatform('darwin')
    app.isDefaultProtocolClient.mockReturnValue(false)
    expect(requestDefault()).toEqual({ requested: true, isDefault: false })
    expect(app.setAsDefaultProtocolClient.mock.calls.map((c) => c[0])).toEqual(['http', 'https'])
  })
  it('set failure reports requested:false', () => {
    setPlatform('darwin')
    app.setAsDefaultProtocolClient.mockReturnValueOnce(false)
    expect(requestDefault().requested).toBe(false)
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(2)
  })
})
