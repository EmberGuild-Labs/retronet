// Skin registry (AC24, AC25, AC28). Display names and descriptions are original: they evoke an era,
// never a product. scripts/check-assets.mjs greps this file for trademarked names.

export const SKIN_IDS = ['y1994', 'y1997', 'y1999', 'y2001'] as const
export type SkinId = (typeof SKIN_IDS)[number]

/** Per-skin shell behaviour switches (R25). Shell code reads these instead of comparing skin ids. */
export interface SkinTraits {
  /** Toolbar actions are icon-only buttons (no visible label). */
  iconOnlyToolbar: boolean
  /** Back and Forward are round glossy buttons, Back with a visible label. */
  roundBackForward: boolean
  /** Toolbar uses the short label variant (e.g. "Saves") where an action defines one. */
  shortToolbarLabels: boolean
  /** Omnibox shows a separate Go button. */
  goButton: boolean
  /** Omnibox shows the Bookmarks button. */
  bookmarksButton: boolean
  /** Status text comes before the lamp in the status bar. */
  statusTextFirst: boolean
}

export const SKIN_TRAITS: Readonly<Record<SkinId, Readonly<SkinTraits>>> = Object.freeze({
  y1994: { iconOnlyToolbar: false, roundBackForward: false, shortToolbarLabels: false, goButton: false, bookmarksButton: false, statusTextFirst: false },
  y1997: { iconOnlyToolbar: false, roundBackForward: false, shortToolbarLabels: true, goButton: false, bookmarksButton: true, statusTextFirst: false },
  y1999: { iconOnlyToolbar: true, roundBackForward: false, shortToolbarLabels: false, goButton: true, bookmarksButton: false, statusTextFirst: true },
  y2001: { iconOnlyToolbar: true, roundBackForward: true, shortToolbarLabels: false, goButton: true, bookmarksButton: false, statusTextFirst: true }
})

/** Root `data-*` attributes mirroring the boolean traits, for CSS (`:root[data-icon-only]`). */
export function traitAttributes(id: SkinId): Record<string, 'true' | 'false'> {
  const t = SKIN_TRAITS[id]
  const b = (v: boolean): 'true' | 'false' => (v ? 'true' : 'false')
  return {
    'data-icon-only': b(t.iconOnlyToolbar),
    'data-go-button': b(t.goButton),
    'data-bookmarks-button': b(t.bookmarksButton),
    'data-status-first': b(t.statusTextFirst)
  }
}

export const DEFAULT_SKIN: SkinId = 'y1997'

/** Window frame values main applies on skin change (DESIGN 6.5). */
export interface SkinFrame {
  /** macOS `setWindowButtonPosition({ x: 12, y })`, centered in the tab strip. */
  macTrafficLightY: number
  /** Windows `titleBarOverlay` for normal and incognito windows (v1.1). */
  winTitleBar: { color: string; symbolColor: string; height: number }
  winTitleBarIncognito: { color: string; symbolColor: string }
}

export interface SkinInfo {
  id: SkinId
  name: string
  year: number
  description: string
  /** Settings radio-card thumbnail, relative to an internal page (T6 asset). */
  preview: string
  frame: SkinFrame
}

export const SKINS: readonly SkinInfo[] = Object.freeze([
  {
    id: 'y1994',
    name: '1994 Pioneer',
    year: 1994,
    description: 'Flat cool gray, crisp two-pixel bevels and serif labels from the first graphical web.',
    preview: 'img/skin-y1994.svg',
    frame: {
      macTrafficLightY: 8,
      winTitleBar: { color: '#9599A2', symbolColor: '#111318', height: 30 },
      winTitleBarIncognito: { color: '#2F3440', symbolColor: '#E9EBEE' }
    }
  },
  {
    id: 'y1997',
    name: '1997 Comet',
    year: 1997,
    description: 'Classic silver-gray faces, big labeled toolbar buttons and a starry throbber.',
    preview: 'img/skin-y1997.svg',
    frame: {
      macTrafficLightY: 8,
      winTitleBar: { color: '#9C9C9C', symbolColor: '#000000', height: 30 },
      winTitleBarIncognito: { color: '#2B2440', symbolColor: '#FFFFFF' }
    }
  },
  {
    id: 'y1999',
    name: '1999 Gumdrop',
    year: 1999,
    description: 'Translucent candy-plastic tabs, glossy gel buttons, a brushed-metal toolbar and soft pinstripes.',
    preview: 'img/skin-y1999.svg',
    frame: {
      macTrafficLightY: 10,
      winTitleBar: { color: '#2A9BB4', symbolColor: '#0B2730', height: 34 },
      winTitleBarIncognito: { color: '#6A3CA6', symbolColor: '#FFFFFF' }
    }
  },
  {
    id: 'y2001',
    name: '2001 Horizon',
    year: 2001,
    description: 'Glossy blue title strip, soft beige toolbar and round, friendly buttons.',
    preview: 'img/skin-y2001.svg',
    frame: {
      macTrafficLightY: 11,
      winTitleBar: { color: '#2259D0', symbolColor: '#FFFFFF', height: 36 },
      winTitleBarIncognito: { color: '#3A2A6E', symbolColor: '#FFFFFF' }
    }
  }
])

export function isSkinId(id: unknown): id is SkinId {
  return typeof id === 'string' && (SKIN_IDS as readonly string[]).includes(id)
}

/** Unknown ids fall back to the default skin. */
export function getSkin(id: string): SkinInfo {
  return SKINS.find((s) => s.id === id) ?? (SKINS.find((s) => s.id === DEFAULT_SKIN) as SkinInfo)
}
