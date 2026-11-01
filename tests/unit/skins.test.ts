import { describe, expect, it } from 'vitest'
import { DEFAULT_SKIN, SKINS, SKIN_IDS, getSkin, isSkinId } from '@shared/skins'

// Same pattern as scripts/check-assets.mjs (AC28).
const TRADEMARKS = /mosaic|netscape|microsoft|internet explorer|windows xp|\bluna\b|\bchrome\b|\baqua\b|navigator|explorer/i

describe('skin registry', () => {
  it('has exactly the three era skins in order', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['y1994', 'y1997', 'y2001'])
    expect([...SKIN_IDS]).toEqual(['y1994', 'y1997', 'y2001'])
    expect(SKINS.map((s) => s.year)).toEqual([1994, 1997, 2001])
  })

  it('uses the approved original names (D6)', () => {
    expect(SKINS.map((s) => s.name)).toEqual(['1994 Pioneer', '1997 Comet', '2001 Horizon'])
  })

  it('contains no trademarked words anywhere in its data', () => {
    for (const s of SKINS) expect(JSON.stringify(s), s.id).not.toMatch(TRADEMARKS)
  })

  it('every skin has a description, a preview and frame values', () => {
    for (const s of SKINS) {
      expect(s.description.length).toBeGreaterThan(10)
      expect(s.preview).toBe(`img/skin-${s.id}.svg`)
      expect(s.frame.winTitleBar.color).toMatch(/^#[0-9A-F]{6}$/)
      expect(s.frame.macTrafficLightY).toBeGreaterThan(0)
    }
  })

  it('defaults to 1997 and falls back on unknown ids', () => {
    expect(DEFAULT_SKIN).toBe('y1997')
    expect(getSkin('y2001').name).toBe('2001 Horizon')
    expect(getSkin('nope').id).toBe('y1997')
    expect(isSkinId('y1994')).toBe(true)
    expect(isSkinId('y1999')).toBe(false)
    expect(isSkinId(undefined)).toBe(false)
  })
})
