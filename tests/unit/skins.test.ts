import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SKIN, SKINS, SKIN_TRAITS, traitAttributes, SKIN_IDS, getSkin, isSkinId } from '@shared/skins'
// @ts-expect-error no type declarations for the shared .mjs word list
import { TRADEMARK_RE } from '../../scripts/trademark-words.mjs'

describe('skin registry', () => {
  it('has exactly the four era skins in order', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['y1994', 'y1997', 'y1999', 'y2001'])
    expect([...SKIN_IDS]).toEqual(['y1994', 'y1997', 'y1999', 'y2001'])
    expect(SKINS.map((s) => s.year)).toEqual([1994, 1997, 1999, 2001])
  })

  it('uses the approved original names (D6)', () => {
    expect(SKINS.map((s) => s.name)).toEqual(['1994 Pioneer', '1997 Comet', '1999 Gumdrop', '2001 Horizon'])
  })

  it('contains no trademarked words anywhere in its data', () => {
    for (const s of SKINS) expect(JSON.stringify(s), s.id).not.toMatch(TRADEMARK_RE)
  })

  it('every skin has a description, a preview and frame values', () => {
    for (const s of SKINS) {
      expect(s.description.length).toBeGreaterThan(10)
      expect(s.preview).toBe(`img/skin-${s.id}.svg`)
      expect(s.frame.winTitleBar.color).toMatch(/^#[0-9A-F]{6}$/)
      expect(s.frame.macTrafficLightY).toBeGreaterThan(0)
    }
  })

  it('1999 Gumdrop frame values match the design', () => {
    const s = getSkin('y1999')
    expect(s.frame.macTrafficLightY).toBe(10)
    expect(s.frame.winTitleBar).toEqual({ color: '#2A9BB4', symbolColor: '#0B2730', height: 34 })
    expect(s.frame.winTitleBarIncognito).toEqual({ color: '#6A3CA6', symbolColor: '#FFFFFF' })
  })

  it('defaults to 1997 and falls back on unknown ids', () => {
    expect(DEFAULT_SKIN).toBe('y1997')
    expect(getSkin('y2001').name).toBe('2001 Horizon')
    expect(getSkin('nope').id).toBe('y1997')
    expect(isSkinId('y1994')).toBe(true)
    expect(isSkinId('y1999')).toBe(true)
    expect(isSkinId('y1998')).toBe(false)
    expect(isSkinId(undefined)).toBe(false)
  })
})

describe('SKIN_TRAITS (R25)', () => {
  it('has a complete boolean record for every skin', () => {
    const keys = Object.keys(SKIN_TRAITS.y1997).sort()
    for (const id of SKIN_IDS) {
      expect(Object.keys(SKIN_TRAITS[id]).sort(), id).toEqual(keys)
      for (const v of Object.values(SKIN_TRAITS[id])) expect(typeof v).toBe('boolean')
    }
  })

  it('reproduces the original per-skin behaviour', () => {
    for (const id of SKIN_IDS) {
      const t = SKIN_TRAITS[id]
      expect(t.iconOnlyToolbar, id).toBe(id === 'y2001' || id === 'y1999')
      expect(t.goButton, id).toBe(id === 'y2001' || id === 'y1999')
      expect(t.statusTextFirst, id).toBe(id === 'y2001' || id === 'y1999')
      expect(t.roundBackForward, id).toBe(id === 'y2001')
      expect(t.shortToolbarLabels, id).toBe(id === 'y1997')
      expect(t.bookmarksButton, id).toBe(id === 'y1997')
    }
  })

  it('mirrors traits as root data attributes', () => {
    expect(traitAttributes('y1999')).toEqual({ 'data-icon-only': 'true', 'data-go-button': 'true', 'data-bookmarks-button': 'false', 'data-status-first': 'true' })
  })

  it('no shell source compares a skin id directly', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n)
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(p) ? [p] : []
      })
    for (const f of walk('src/renderer/shell')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/skin [!=]== 'y/)
  })
})
