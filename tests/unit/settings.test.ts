import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  SettingsStrictSchema,
  defaultSettings
} from '@shared/settings'
import { SEARCH_ENGINES, getSearchEngine, searchUrlFor } from '@shared/search-engines'

describe('settings defaults (PLAN 1.4)', () => {
  it('match the plan', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      skin: 'y1997',
      searchEngine: 'duckduckgo',
      homePage: 'retronet://newtab/',
      startup: 'restore',
      downloadsDir: null,
      reducedMotion: false,
      bookmarkBar: true,
      dialupSound: false
    })
  })

  it('an empty or partial file fills in defaults', () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS)
    expect(SettingsSchema.parse({ skin: 'y2001' })).toEqual({ ...DEFAULT_SETTINGS, skin: 'y2001' })
  })

  it('on-disk schema strips unknown keys but rejects wrong types', () => {
    expect(SettingsSchema.parse({ futureKey: 1 })).toEqual(DEFAULT_SETTINGS)
    expect(SettingsSchema.safeParse({ bookmarkBar: 'yes' }).success).toBe(false)
  })

  it('dialupSound is off by default and settings files from before the extra round still parse (AC55)', () => {
    const old = { skin: 'y2001', searchEngine: 'google', homePage: 'https://example.org/', startup: 'newtab', downloadsDir: null, reducedMotion: true, bookmarkBar: false }
    expect(SettingsSchema.parse(old)).toEqual({ ...old, dialupSound: false })
    expect(SettingsSchema.parse({ dialupSound: true }).dialupSound).toBe(true)
    expect(SettingsSchema.safeParse({ dialupSound: 'yes' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ dialupSound: true }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ dialupSound: 1 }).success).toBe(false)
  })

  it('defaults are frozen and defaultSettings() returns a copy', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
    const s = defaultSettings()
    s.skin = 'y1994'
    expect(DEFAULT_SETTINGS.skin).toBe('y1997')
  })

  it('strict schema needs every key and no extras', () => {
    expect(SettingsStrictSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
    expect(SettingsStrictSchema.safeParse({ ...DEFAULT_SETTINGS, x: 1 }).success).toBe(false)
    const { skin: _s, ...missing } = DEFAULT_SETTINGS
    expect(SettingsStrictSchema.safeParse(missing).success).toBe(false)
  })

  it.each([
    [{}, true],
    [{ startup: 'newtab' }, true],
    [{ downloadsDir: '/Users/me/Desktop' }, true],
    [{ downloadsDir: null }, true],
    [{ homePage: 'https://example.org/' }, true],
    [{ homePage: 'retronet://bookmarks/' }, true],
    [{ homePage: 'file:///etc/passwd' }, false],
    [{ homePage: 'javascript:alert(1)' }, false],
    [{ homePage: 'example.org' }, false],
    [{ downloadsDir: '' }, false],
    [{ startup: 'blank' }, false],
    [{ searchEngine: 'altavista' }, false],
    [{ skin: 'y1997', extra: true }, false]
  ])('patch %j valid=%s', (patch, valid) => {
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(valid)
  })
})

describe('search engines', () => {
  it('lists the five engines with DuckDuckGo first', () => {
    expect(SEARCH_ENGINES.map((e) => e.id)).toEqual(['duckduckgo', 'google', 'bing', 'brave', 'ecosia'])
    for (const e of SEARCH_ENGINES) expect(e.template).toMatch(/^https:\/\/[^/]+\/.*\{searchTerms\}/)
  })

  it('builds encoded search URLs and falls back to the default', () => {
    expect(searchUrlFor('google', 'a b&c')).toBe('https://www.google.com/search?q=a%20b%26c')
    expect(getSearchEngine('nope').id).toBe('duckduckgo')
  })
})
