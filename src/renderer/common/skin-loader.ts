// Live skin switching (PLAN 1.13, AC24, DESIGN 0.1 + 6.2). Shell, overlay and internal pages call initSkin() once;
// after that every `skin` event (and, in the shell and overlay, every `state` snapshot) restyles the document with
// no reload: a new <link> for the skin's stylesheet is loaded next to the old one, and only once it has loaded do we
// flip html[data-skin] and drop the old link, inside a one-frame "no transitions" window so nothing smears.
//
// Root attributes this module owns: data-skin, data-incognito, data-reduced-motion, data-platform, data-fullscreen,
// data-surface ("shell" | "overlay" | "page": incognito re-colours the shell and overlay frame, while page sheets keep
// their own colours on top of the incognito backdrop). The <link id="rn-skin"> may already be in the HTML; if not it
// is created here. Stylesheet URLs are relative ("skins/<id>/skin.css"), so they resolve under retronet://<host>/.
import { DEFAULT_SKIN, isSkinId, type SkinId } from '@shared/skins'

export type SkinSurface = 'shell' | 'overlay' | 'page'

export interface SkinFlags {
  incognito?: boolean
  reducedMotion?: boolean
  fullscreen?: boolean
}

export interface InitSkinOptions {
  /** Prefix for stylesheet URLs. Default '' (relative to the document, i.e. retronet://<host>/skins/...). */
  base?: string
  /** Subscribe to bridge events. Default true; with no preload bridge (tests, fixtures) nothing is subscribed. */
  subscribe?: boolean
}

const LINK_ID = 'rn-skin'

let surface: SkinSurface = 'page'
let base = ''
let generation = 0

/** Stylesheet for a skin on this surface: skin.css for shell/overlay, pages.css for internal pages. */
export function skinHref(id: SkinId, on: SkinSurface = surface, prefix = base): string {
  return `${prefix}skins/${id}/${on === 'page' ? 'pages' : 'skin'}.css`
}

export function currentSkin(): SkinId {
  const v = document.documentElement.dataset.skin
  return isSkinId(v) ? v : DEFAULT_SKIN
}

function setFlag(name: string, value: boolean | undefined): void {
  if (value === undefined) return
  document.documentElement.setAttribute(name, value ? 'true' : 'false')
}

/** Sets the incognito / reduced-motion / fullscreen root attributes. Undefined fields are left alone. */
export function applyFlags(flags: SkinFlags): void {
  setFlag('data-incognito', flags.incognito)
  setFlag('data-reduced-motion', flags.reducedMotion)
  setFlag('data-fullscreen', flags.fullscreen)
}

function skinLink(): HTMLLinkElement | null {
  const el = document.getElementById(LINK_ID)
  return el instanceof HTMLLinkElement ? el : null
}

/**
 * Switches to `id` without a reload. Resolves once the new stylesheet is active. Calling it again before the previous
 * switch finished cancels the earlier one (only the latest request wins). Unknown ids fall back to the default skin.
 */
export function applySkin(id: string): Promise<void> {
  const skin: SkinId = isSkinId(id) ? id : DEFAULT_SKIN
  const root = document.documentElement
  const href = skinHref(skin)
  const old = skinLink()
  if (old && old.getAttribute('href') === href && root.dataset.skin === skin && old.sheet) return Promise.resolve()

  const mine = ++generation
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.rnSkinPending = skin

  return new Promise<void>((resolve) => {
    const finish = (): void => {
      if (mine !== generation) {
        link.remove()
        resolve()
        return
      }
      root.setAttribute('data-skin-switching', '')
      root.dataset.skin = skin
      // Superseded pending links remove themselves when they load (their rules are scoped to their own data-skin).
      for (const el of document.querySelectorAll<HTMLLinkElement>(`link#${LINK_ID}`)) {
        if (el !== link) el.remove()
      }
      delete link.dataset.rnSkinPending
      link.id = LINK_ID
      void root.offsetHeight // commit the new styles while transitions are off
      requestAnimationFrame(() => {
        if (mine === generation) root.removeAttribute('data-skin-switching')
      })
      resolve()
    }
    link.addEventListener('load', finish, { once: true })
    // A missing sheet still flips the attribute, so the rest of the UI (and tests) see the requested skin.
    link.addEventListener('error', finish, { once: true })
    if (old) old.after(link)
    else document.head.append(link)
  })
}

// ---- bridge wiring ----

interface SkinPayload {
  skin: string
  reducedMotion: boolean
  incognito: boolean
}
interface StatePayload extends SkinPayload {
  fullscreen: boolean
}
type Ok<T> = { ok: true; data: T } | { ok: false; code: string; message: string }
/** The slice of ShellBridge / PageBridge this module touches (both bridges are structurally compatible here). */
interface SkinBridge {
  platform?: 'mac' | 'win'
  on?: (event: string, cb: (payload: unknown) => void) => () => void
  skin?: { get?: () => Promise<Ok<SkinPayload>> }
}

function applyPayload(p: SkinPayload & { fullscreen?: boolean }): void {
  applyFlags({ incognito: p.incognito, reducedMotion: p.reducedMotion, fullscreen: p.fullscreen })
  void applySkin(p.skin)
}

/**
 * Call once per document, before first paint if possible. Sets data-surface and data-platform, makes sure the skin
 * stylesheet link exists, and keeps the document in step with skin changes. Returns an unsubscribe function.
 */
export function initSkin(on: SkinSurface, options: InitSkinOptions = {}): () => void {
  surface = on
  base = options.base ?? ''
  const root = document.documentElement
  root.dataset.surface = on

  const bridge = (window as unknown as { retronet?: SkinBridge }).retronet
  if (bridge?.platform) root.dataset.platform = bridge.platform === 'mac' ? 'darwin' : 'win32'
  if (!root.dataset.incognito) root.dataset.incognito = 'false'
  if (!root.dataset.reducedMotion) root.dataset.reducedMotion = 'false'
  void applySkin(currentSkin())

  const offs: Array<() => void> = []
  if (options.subscribe !== false && bridge?.on) {
    offs.push(bridge.on('skin', (p) => applyPayload(p as SkinPayload)))
    if (on !== 'page') offs.push(bridge.on('state', (p) => applyPayload(p as StatePayload)))
    else if (bridge.skin?.get) {
      void bridge.skin.get().then((res) => {
        if (res.ok) applyPayload(res.data)
      })
    }
  }
  return () => {
    for (const off of offs) off()
  }
}
