// Page zoom (AC6), with the usual browser preset steps; the level is stored per origin in the profile's zoom store (memory
// only in incognito) and re-applied by the tab on every main-frame commit (tab.ts). Chromium already shares a
// host's zoom across tabs of one session, so every window of the profile gets a fresh snapshot afterwards.
import type { WebContents } from 'electron'
import { zoomOriginOf, type Tab } from '../tabs/tab'
import { browserTabs } from '../tabs/tab-manager'
import type { WindowContext } from '../types'
import { windowManager } from '../windows/window-manager'

/** Zoom presets in percent (same steps as other browsers). */
export const ZOOM_STEPS: readonly number[] = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]

/** Electron zoom level <-> factor: factor = 1.2 ^ level. */
export function levelForPercent(percent: number): number {
  return percent === 100 ? 0 : Math.log(percent / 100) / Math.log(1.2)
}

export function percentForLevel(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100)
}

/** Next preset in a direction from the current percentage (clamped at the ends). */
export function stepZoom(currentPercent: number, direction: 'in' | 'out'): number {
  const eps = 0.5
  if (direction === 'in') return ZOOM_STEPS.find((s) => s > currentPercent + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i]! < currentPercent - eps) return ZOOM_STEPS[i]!
  return ZOOM_STEPS[0]!
}

export type ZoomAction = 'in' | 'out' | 'reset'

/** Apply a zoom step to a tab, persist it for the tab's origin and refresh every window of the profile. */
export function zoomTab(w: WindowContext, tab: Tab, action: ZoomAction): number {
  const wc = tab.wc
  if (wc.isDestroyed()) return 100
  const current = Math.round(wc.getZoomFactor() * 100)
  const percent = action === 'reset' ? 100 : stepZoom(current, action)
  const level = levelForPercent(percent)
  wc.setZoomLevel(level)
  const origin = zoomOriginOf(tab.url())
  if (origin) w.profile.stores.zoom.set(origin, level)
  for (const other of windowManager.all()) if (other.profile === w.profile) browserTabs(other).refresh()
  return percent
}

/** Zoom of the active tab (menu, shortcut, palette). */
export function zoomActive(w: WindowContext, action: ZoomAction): number | null {
  const tab = browserTabs(w).active()
  return tab ? zoomTab(w, tab, action) : null
}

/** Ctrl/Cmd + wheel and pinch on a page arrive as `zoom-changed`; Electron leaves the zooming to us. */
export function attachWheelZoom(wc: WebContents, resolve: (wc: WebContents) => { w: WindowContext; tab: Tab } | null): void {
  wc.on('zoom-changed', (_e, direction) => {
    const hit = resolve(wc)
    if (hit) zoomTab(hit.w, hit.tab, direction)
  })
}
