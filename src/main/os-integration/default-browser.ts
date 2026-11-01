// Default-browser status/request (AC46, AC47). Never registers Electron itself: unpackaged builds report
// supported:false. The E2E fake (RETRONET_TEST_DEFAULT_BROWSER=fake) works only unpackaged AND RETRONET_E2E=1.
import { app } from 'electron'

export interface DefaultBrowserStatus {
  supported: boolean
  isDefault: boolean
  reason?: 'unpackaged' | 'platform'
}

const SCHEMES = ['http', 'https'] as const

/** Pure: which override (if any) is active. A packaged build ignores every override. */
export function resolveOverride(
  env: Record<string, string | undefined>,
  ctx: { packaged: boolean; e2e: boolean }
): 'fake' | null {
  if (ctx.packaged || !ctx.e2e) return null
  return env.RETRONET_TEST_DEFAULT_BROWSER === 'fake' ? 'fake' : null
}

let fakeIsDefault = false

/** Test helper: reset the in-memory fake. */
export function resetFakeDefaultBrowser(): void {
  fakeIsDefault = false
}

function override(): 'fake' | null {
  return resolveOverride(process.env, { packaged: app.isPackaged, e2e: process.env.RETRONET_E2E === '1' })
}

export function getStatus(): DefaultBrowserStatus {
  if (override() === 'fake') return { supported: true, isDefault: fakeIsDefault }
  if (!app.isPackaged) return { supported: false, isDefault: false, reason: 'unpackaged' }
  if (process.platform !== 'darwin') return { supported: false, isDefault: false, reason: 'platform' }
  return { supported: true, isDefault: SCHEMES.every((s) => app.isDefaultProtocolClient(s)) }
}

/** macOS confirms asynchronously, so `isDefault` may still be false right after; the page re-reads. */
export function requestDefault(): { requested: boolean; isDefault: boolean } {
  if (override() === 'fake') {
    fakeIsDefault = true
    return { requested: true, isDefault: true }
  }
  const st = getStatus()
  if (!st.supported) return { requested: false, isDefault: st.isDefault }
  let ok = true
  for (const s of SCHEMES) ok = app.setAsDefaultProtocolClient(s) && ok
  return { requested: ok, isDefault: SCHEMES.every((s) => app.isDefaultProtocolClient(s)) }
}
