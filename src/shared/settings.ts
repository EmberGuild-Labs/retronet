// Per-profile settings (AC19, AC24, AC32). One zod schema gives the on-disk validator, the defaults
// and the `settings.set` patch validator.
import { z } from 'zod'
import { DEFAULT_SEARCH_ENGINE_ID, SEARCH_ENGINE_IDS, type SearchEngineId } from './search-engines'
import { DEFAULT_SKIN, SKIN_IDS, type SkinId } from './skins'

export const STARTUP_MODES = ['restore', 'newtab'] as const
export type StartupMode = (typeof STARTUP_MODES)[number]

export const NEWTAB_URL = 'retronet://newtab/'

export interface Settings {
  skin: SkinId
  searchEngine: SearchEngineId
  /** http(s) or retronet: address the Home button opens. */
  homePage: string
  startup: StartupMode
  /** null = the OS Downloads folder (`app.getPath('downloads')`). */
  downloadsDir: string | null
  reducedMotion: boolean
  bookmarkBar: boolean
  /** AC55: play the original dial-up sound on user-started loads. Off by default. */
  dialupSound: boolean
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  skin: DEFAULT_SKIN,
  searchEngine: DEFAULT_SEARCH_ENGINE_ID,
  homePage: NEWTAB_URL,
  startup: 'restore',
  downloadsDir: null,
  reducedMotion: false,
  bookmarkBar: true,
  dialupSound: false
})

const HOME_SCHEMES = new Set(['http:', 'https:', 'retronet:'])

/** DNS name (labels of letters, digits, `-`, `_`; IDNs arrive punycoded from URL), IPv4, or a bracketed IPv6. */
const HOSTNAME_RE = /^(?=.{1,253}\.?$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/
const IPV6_RE = /^\[[0-9a-f:.]+\]$/

/**
 * An absolute URL whose scheme is in `schemes`. The raw text may contain no whitespace at all (Chromium would
 * quietly escape `https://not a url` into a host with %20s), and http(s) URLs need a real hostname.
 */
export function isAllowedAddress(v: string, schemes: ReadonlySet<string>): boolean {
  if (/\s/.test(v)) return false
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return false
  }
  if (!schemes.has(u.protocol)) return false
  if (u.protocol === 'http:' || u.protocol === 'https:') return HOSTNAME_RE.test(u.hostname) || IPV6_RE.test(u.hostname)
  return true
}

export const HomePageSchema = z
  .string()
  .max(2048)
  .refine((v) => isAllowedAddress(v, HOME_SCHEMES), 'Home page must be an http, https or retronet address')

const fields = {
  skin: z.enum(SKIN_IDS),
  searchEngine: z.enum(SEARCH_ENGINE_IDS),
  homePage: HomePageSchema,
  startup: z.enum(STARTUP_MODES),
  downloadsDir: z.string().min(1).max(4096).nullable(),
  reducedMotion: z.boolean(),
  bookmarkBar: z.boolean(),
  dialupSound: z.boolean()
}

/**
 * On-disk schema: missing keys take their default; unknown keys are stripped so an older build can read
 * a newer file. A key with a wrong type fails the parse (the store then resets, see json-store).
 */
export const SettingsSchema = z.object({
  skin: fields.skin.default(DEFAULT_SETTINGS.skin),
  searchEngine: fields.searchEngine.default(DEFAULT_SETTINGS.searchEngine),
  // A stored home page that no longer passes (e.g. saved by an older, looser build) falls back to the default
  // instead of failing the whole file.
  homePage: fields.homePage.default(DEFAULT_SETTINGS.homePage).catch(DEFAULT_SETTINGS.homePage),
  startup: fields.startup.default(DEFAULT_SETTINGS.startup),
  downloadsDir: fields.downloadsDir.default(DEFAULT_SETTINGS.downloadsDir),
  reducedMotion: fields.reducedMotion.default(DEFAULT_SETTINGS.reducedMotion),
  bookmarkBar: fields.bookmarkBar.default(DEFAULT_SETTINGS.bookmarkBar),
  dialupSound: fields.dialupSound.default(DEFAULT_SETTINGS.dialupSound)
})

/** A complete settings object with no extra keys (IPC responses). */
export const SettingsStrictSchema = z.strictObject(fields)

/** `settings.set` payload: any subset of keys, nothing else (IPC is strict). */
export const SettingsPatchSchema = z.strictObject(fields).partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS }
}
