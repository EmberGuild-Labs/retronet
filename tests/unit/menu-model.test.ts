// PLAN-FINAL 1.2 / F1: the themed-menu spec schema caps and the pure helpers.
import { describe, expect, it } from 'vitest'
import {
  MENU_DEPTH_MAX,
  MENU_LABEL_MAX,
  MENU_LEVEL_MAX,
  MENU_NODES_MAX,
  MenuItemIdSchema,
  MenuSpecSchema,
  countNodes,
  findItem,
  menuDepth,
  trimSeparators,
  truncateLabel,
  type MenuItemSpec,
  type MenuSpec
} from '@shared/menu-model'
import { BOOKMARK_IMPORT_MAX, BOOKMARK_IMPORT_MAX_BYTES, IMPORT_ERRORS } from '@shared/bookmarks-import'

const item = (id: string, extra: Partial<Extract<MenuItemSpec, { kind: 'item' }>> = {}): MenuItemSpec => ({
  kind: 'item',
  id,
  label: id,
  enabled: true,
  ...extra
})
const sep: MenuItemSpec = { kind: 'separator' }

const spec = (items: MenuItemSpec[], over: Partial<MenuSpec> = {}): MenuSpec => ({
  menuId: '0b7e7c1e-3f5a-4c2b-9d1e-2a6f4b8c9d01',
  kind: 'bookmarks',
  label: 'Bookmarks',
  anchor: { x: 0, y: 30, width: 80, height: 22 },
  placement: 'below',
  focusFirst: true,
  platform: 'win',
  items,
  ...over
})
const parses = (m: unknown): boolean => MenuSpecSchema.safeParse(m).success

/** A chain `levels` deep: each level has one submenu parent, the last level one leaf. */
function chain(levels: number): MenuItemSpec[] {
  let items: MenuItemSpec[] = [item('leaf')]
  for (let i = levels - 1; i > 0; i--) items = [item(`f${i}`, { submenu: items })]
  return items
}

describe('MenuSpecSchema caps', () => {
  it('accepts a full spec with checks, radios, titles, accelerators and submenus', () => {
    const m = spec([
      item('new', { accel: 'CmdOrCtrl+T' }),
      sep,
      item('color', { submenu: [item('c.red', { check: 'radio', checked: true }), item('c.blue', { check: 'radio', checked: false })] }),
      item('mute', { check: 'check', checked: false, enabled: false, title: 'Mute site' })
    ])
    expect(parses(m)).toBe(true)
  })

  it(`allows ${MENU_LEVEL_MAX} items per level, rejects ${MENU_LEVEL_MAX + 1}`, () => {
    const level = (n: number) => Array.from({ length: n }, (_, i) => item(`i${i}`))
    expect(parses(spec(level(MENU_LEVEL_MAX)))).toBe(true)
    expect(parses(spec(level(MENU_LEVEL_MAX + 1)))).toBe(false)
    expect(parses(spec([item('f', { submenu: level(MENU_LEVEL_MAX + 1) })]))).toBe(false)
  })

  it(`allows depth ${MENU_DEPTH_MAX}, rejects depth ${MENU_DEPTH_MAX + 1}`, () => {
    expect(menuDepth(chain(MENU_DEPTH_MAX))).toBe(MENU_DEPTH_MAX)
    expect(parses(spec(chain(MENU_DEPTH_MAX)))).toBe(true)
    expect(parses(spec(chain(MENU_DEPTH_MAX + 1)))).toBe(false)
  })

  it(`allows ${MENU_NODES_MAX} nodes in total, rejects ${MENU_NODES_MAX + 1}`, () => {
    // 20 folders of 249 children = 20 + 4980 = 5000 nodes; one more leaf goes over.
    const tree = (extra: number) => [
      ...Array.from({ length: 20 }, (_, f) => item(`f${f}`, { submenu: Array.from({ length: 249 }, (_, i) => item(`f${f}.${i}`)) })),
      ...Array.from({ length: extra }, (_, i) => item(`x${i}`))
    ]
    expect(countNodes(tree(0))).toBe(MENU_NODES_MAX)
    expect(parses(spec(tree(0)))).toBe(true)
    expect(parses(spec(tree(1)))).toBe(false)
  })

  it.each(['', 'has space', 'a/b', 'x'.repeat(81), 'é', 'a\nb'])('rejects item id %j', (id) => {
    expect(MenuItemIdSchema.safeParse(id).success).toBe(false)
    expect(parses(spec([item(id)]))).toBe(false)
  })

  it.each(['a', 'bm:f1.3', 'edit.copy', 'spell-0', 'A_b:9', 'x'.repeat(80)])('accepts item id %j', (id) => {
    expect(MenuItemIdSchema.safeParse(id).success).toBe(true)
  })

  it('rejects long labels and titles, bad enums, a non-uuid menuId and extra keys', () => {
    expect(parses(spec([item('a', { label: 'x'.repeat(MENU_LABEL_MAX + 1) })]))).toBe(false)
    expect(parses(spec([item('a', { title: 'x'.repeat(2049) })]))).toBe(false)
    expect(parses(spec([item('a', { title: 'x'.repeat(2048) })]))).toBe(true)
    expect(parses(spec([item('a', { accel: 'x'.repeat(65) })]))).toBe(false)
    expect(parses(spec([], { menuId: 'menu-1' }))).toBe(false)
    expect(parses(spec([], { kind: 'window' as never }))).toBe(false)
    expect(parses(spec([], { placement: 'above' as never }))).toBe(false)
    expect(parses(spec([], { platform: 'linux' as never }))).toBe(false)
    expect(parses(spec([], { anchor: { x: 0, y: 0, width: -1, height: 0 } }))).toBe(false)
    expect(parses({ ...spec([]), run: 'file.print' })).toBe(false)
    expect(parses(spec([{ ...item('a'), action: 'x' } as never]))).toBe(false)
    expect(parses(spec([{ kind: 'separator', id: 's' } as never]))).toBe(false)
    expect(parses(spec([item('a', { check: 'toggle' as never })]))).toBe(false)
  })
})

describe('menu helpers', () => {
  it('countNodes counts separators and nested items', () => {
    expect(countNodes([])).toBe(0)
    expect(countNodes([item('a'), sep, item('f', { submenu: [item('b'), sep, item('c')] })])).toBe(6)
  })

  it('menuDepth', () => {
    expect(menuDepth([])).toBe(0)
    expect(menuDepth([item('a'), sep])).toBe(1)
    expect(menuDepth([item('f', { submenu: [] })])).toBe(1)
    expect(menuDepth(chain(3))).toBe(3)
  })

  it('trimSeparators drops leading, trailing and repeated separators at every level', () => {
    const out = trimSeparators([sep, sep, item('a'), sep, sep, item('f', { submenu: [sep, item('b'), sep, sep, item('c'), sep] }), sep])
    expect(out).toEqual([item('a'), sep, item('f', { submenu: [item('b'), sep, item('c')] })])
    expect(trimSeparators([sep, sep])).toEqual([])
    expect(trimSeparators([])).toEqual([])
  })

  it('trimSeparators does not mutate its input', () => {
    const sub = [sep, item('b')]
    const input = [item('f', { submenu: sub })]
    trimSeparators(input)
    expect(sub).toHaveLength(2)
  })

  it('findItem searches depth-first, including submenu parents, and skips separators', () => {
    const items = [item('a'), sep, item('f', { submenu: [item('b'), item('g', { submenu: [item('c')] })] })]
    expect(findItem(items, 'a')?.id).toBe('a')
    expect(findItem(items, 'f')?.submenu).toBeDefined()
    expect(findItem(items, 'c')?.id).toBe('c')
    expect(findItem(items, 'zzz')).toBeNull()
    expect(findItem([], 'a')).toBeNull()
  })

  it('truncateLabel flattens whitespace and cuts with an ellipsis that fits the schema', () => {
    expect(truncateLabel('  Hello\n\tworld  ')).toBe('Hello world')
    expect(truncateLabel('abcdef', 4)).toBe('abc…')
    expect(truncateLabel('abcd', 4)).toBe('abcd')
    const long = truncateLabel('x'.repeat(500))
    expect(long).toHaveLength(MENU_LABEL_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(parses(spec([item('a', { label: long })]))).toBe(true)
  })

  it('truncateLabel never splits a surrogate pair', () => {
    const out = truncateLabel('ab😀cd', 4) // a b \uD83D \uDE00 c d: a cut at 3 would split the emoji
    expect(out).toBe('ab…')
    expect(out.length).toBeLessThanOrEqual(4)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
  })
})

describe('bookmarks-import constants (R26)', () => {
  it('match the current limits and are distinct', () => {
    expect(BOOKMARK_IMPORT_MAX).toBe(20_000)
    expect(BOOKMARK_IMPORT_MAX_BYTES).toBe(10 * 1024 * 1024)
    const msgs = Object.values(IMPORT_ERRORS)
    expect(new Set(msgs).size).toBe(msgs.length)
  })
})
