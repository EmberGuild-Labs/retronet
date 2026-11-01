import { describe, expect, it } from 'vitest'
import { createBookmarksStore } from '../../src/main/storage/bookmarks-store'

const mk = () => createBookmarksStore(null)

describe('bookmarks store', () => {
  it('starts with a Bookmarks Bar and an Other root', () => {
    const t = mk().tree()
    expect([t.bar.id, t.other.id]).toEqual(['bar', 'other'])
    expect(t.bar.children).toEqual([])
  })

  it('adds, finds, updates and removes', () => {
    const b = mk()
    const id = b.add({ parentId: 'bar', title: 'Ex', url: 'https://example.com/' })!
    expect(b.isBookmarked('https://example.com/')).toBe(true)
    expect(b.update(id, { title: 'Example', url: 'https://example.org/' })).toBe(true)
    expect(b.isBookmarked('https://example.com/')).toBe(false)
    expect(b.findByUrl('https://example.org/')?.title).toBe('Example')
    expect(b.remove(id)).toBe(true)
    expect(b.isBookmarked('https://example.org/')).toBe(false)
    expect(b.add({ parentId: 'nope', title: 't', url: 'https://x/' })).toBeNull()
  })

  it('honours index on add and move, within the same list too', () => {
    const b = mk()
    const ids = ['a', 'b', 'c'].map((t) => b.add({ parentId: 'bar', title: t, url: `https://${t}/` })!)
    b.add({ parentId: 'bar', title: 'z', url: 'https://z/', index: 0 })
    expect(b.barItems().map((n) => n.title)).toEqual(['z', 'a', 'b', 'c'])
    b.move(ids[2]!, 'bar', 0)
    expect(b.barItems().map((n) => n.title)).toEqual(['c', 'z', 'a', 'b'])
  })

  it('handles folders: nested add, move across roots, delete subtree', () => {
    const b = mk()
    const f = b.addFolder({ parentId: 'bar', title: 'F' })!
    const g = b.addFolder({ parentId: f, title: 'G' })!
    const bm = b.add({ parentId: g, title: 'deep', url: 'https://deep/' })!
    expect(b.top(5).map((x) => x.id)).toEqual([bm])
    expect(b.move(f, 'other')).toBe(true)
    expect(b.tree().bar.children).toHaveLength(0)
    expect(b.isBookmarked('https://deep/')).toBe(true)
    expect(b.remove(f)).toBe(true)
    expect(b.isBookmarked('https://deep/')).toBe(false)
  })

  it('refuses cycles and root edits', () => {
    const b = mk()
    const f = b.addFolder({ parentId: 'bar', title: 'F' })!
    const g = b.addFolder({ parentId: f, title: 'G' })!
    expect(b.move(f, f)).toBe(false)
    expect(b.move(f, g)).toBe(false)
    expect(b.move('bar', 'other')).toBe(false)
    expect(b.remove('bar')).toBe(false)
    expect(b.update('other', { title: 'x' })).toBe(false)
    expect(b.tree().bar.children).toHaveLength(1)
  })

  it('removeByUrl, top and suggest', () => {
    const b = mk()
    b.add({ parentId: 'bar', title: 'Dup', url: 'https://dup/' })
    b.add({ parentId: 'other', title: 'Dup', url: 'https://dup/' })
    b.add({ parentId: 'bar', title: 'Gamma tools', url: 'https://www.gamma.test/' })
    expect(b.suggest('gam').map((s) => s.url)).toEqual(['https://www.gamma.test/'])
    expect(b.suggest('tools')).toHaveLength(1)
    expect(b.top(2)).toHaveLength(2)
    expect(b.removeByUrl('https://dup/')).toBe(2)
  })
})
