import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { COMMANDS, normalizeAccelerator, type CommandId, type Platform } from '../../src/shared/commands'
import { SKINS } from '../../src/shared/skins'
import { buildMenuTemplate, ROLE_ACCELERATORS, templateAccelerators, type MenuModel } from '../../src/main/commands/menu'
import { acceleratorIndex, isEscape, matchInput, type KeyInput } from '../../src/main/commands/shortcuts'

const model = (over: Partial<MenuModel> = {}): MenuModel => ({
  platform: 'mac',
  appName: 'RetroNet',
  skin: 'y1997',
  profiles: [
    { id: 'default', name: 'Default' },
    { id: 'work', name: 'Work' }
  ],
  currentProfileId: 'default',
  bookmarkBar: true,
  devUi: false,
  ...over
})

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as MenuItemConstructorOptions[]) : [])])
}

function build(over: Partial<MenuModel> = {}) {
  const runs: Array<[CommandId, string | undefined]> = []
  const template = buildMenuTemplate(model(over), { run: (id, arg) => runs.push([id, arg]), inspectUi: () => {} })
  return { template, runs, items: flatten(template) }
}

describe('app menu template (mac)', () => {
  const { template, items, runs } = build()

  it('has the standard top-level menus', () => {
    expect(template.map((m) => m.label ?? m.role)).toEqual([
      'RetroNet',
      'File',
      'Edit',
      'View',
      'History',
      'Bookmarks',
      'Profiles',
      'Tab',
      'Window',
      'help'
    ])
  })

  it('carries every registry accelerator exactly once, on an item that runs that command', () => {
    const accels = templateAccelerators(template)
    for (const c of COMMANDS) {
      for (const a of c.accelerator.mac) {
        const owners = accels.filter((x) => normalizeAccelerator(x.accelerator) === normalizeAccelerator(a))
        expect(owners, `${c.id} ${a}`).toHaveLength(1)
        expect(owners[0]!.owner.split('#')[0]).toBe(c.id)
      }
    }
  })

  it('has no duplicate accelerators (registry and role items together)', () => {
    const seen = new Map<string, string>()
    for (const { owner, accelerator } of templateAccelerators(template)) {
      const n = normalizeAccelerator(accelerator)
      expect(seen.get(n), `${n} used by ${seen.get(n)} and ${owner}`).toBeUndefined()
      seen.set(n, owner)
    }
    expect(seen.size).toBeGreaterThan(50)
  })

  it('primary accelerator is on the visible item; extras are hidden but working', () => {
    for (const c of COMMANDS) {
      const [primary, ...rest] = c.accelerator.mac
      const visible = items.find((i) => i.id === c.id)
      if (!c.arg) expect(visible, c.id).toBeDefined()
      if (primary) expect(visible!.accelerator).toBe(primary)
      rest.forEach((a, i) => {
        const hidden = items.find((x) => x.id === `${c.id}#${i + 2}`)
        expect(hidden?.accelerator).toBe(a)
        expect(hidden?.visible).toBe(false)
        expect(hidden?.acceleratorWorksWhenHidden).toBe(true)
      })
    }
  })

  it('lists every command (arg commands expand into skin / profile radio items)', () => {
    const ids = new Set(items.map((i) => i.id).filter(Boolean))
    for (const c of COMMANDS) {
      if (c.arg) continue
      expect(ids.has(c.id), c.id).toBe(true)
    }
    for (const s of SKINS) expect(ids.has(`skin.switch:${s.id}`)).toBe(true)
    expect(items.find((i) => i.id === 'skin.switch:y1997')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'profile.switch:default')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'profile.switch:work')?.checked).toBe(false)
  })

  it('menu item ids are unique', () => {
    const ids = items.map((i) => i.id).filter((x): x is string => !!x)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('clicks run the command (with arg for skins and profiles)', () => {
    const click = (id: string) => (items.find((i) => i.id === id)!.click as () => void)()
    click('tab.new')
    click('zoom.in#2')
    click('skin.switch:y2001')
    click('profile.switch:work')
    expect(runs).toEqual([
      ['tab.new', undefined],
      ['zoom.in', undefined],
      ['skin.switch', 'y2001'],
      ['profile.switch', 'work']
    ])
  })

  it('Edit uses the standard roles so copy and paste work everywhere', () => {
    const edit = template.find((m) => m.label === 'Edit')!.submenu as MenuItemConstructorOptions[]
    const roles = edit.map((i) => i.role).filter(Boolean)
    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']))
    for (const r of Object.keys(ROLE_ACCELERATORS)) expect(items.some((i) => i.role === r)).toBe(true)
  })

  it('does not use the close role (Cmd+W must close a tab, not the window)', () => {
    expect(items.some((i) => i.role === 'close' || i.role === 'quit')).toBe(false)
  })

  it('dev-only inspect items appear only when devUi', () => {
    expect(items.some((i) => i.id === 'dev.inspectShell')).toBe(false)
    expect(build({ devUi: true }).items.some((i) => i.id === 'dev.inspectShell')).toBe(true)
  })

  it('bookmark bar item reflects the setting', () => {
    expect(items.find((i) => i.id === 'bookmarkBar.toggle')?.checked).toBe(true)
    expect(build({ bookmarkBar: false }).items.find((i) => i.id === 'bookmarkBar.toggle')?.checked).toBe(false)
  })
})

const key = (k: Partial<KeyInput>): KeyInput => ({
  type: 'keyDown',
  key: '',
  code: '',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...k
})
const letter = (ch: string, mods: Partial<KeyInput> = {}): KeyInput =>
  key({ key: mods.shift ? ch.toUpperCase() : ch.toLowerCase(), code: `Key${ch.toUpperCase()}`, ...mods })

describe('shortcut matcher', () => {
  it('every registry accelerator maps back to its command on both platforms', () => {
    for (const p of ['mac', 'win'] as Platform[]) {
      const idx = acceleratorIndex(p)
      for (const c of COMMANDS) for (const a of c.accelerator[p]) expect(idx.get(normalizeAccelerator(a)), `${p} ${a}`).toBe(c.id)
    }
  })

  it('mac chords (AC21)', () => {
    const m = (i: KeyInput) => matchInput(i, 'mac')
    expect(m(letter('t', { meta: true }))).toBe('tab.new')
    expect(m(letter('w', { meta: true }))).toBe('tab.close')
    expect(m(letter('n', { meta: true }))).toBe('window.new')
    expect(m(letter('n', { meta: true, shift: true }))).toBe('window.newIncognito')
    expect(m(letter('t', { meta: true, shift: true }))).toBe('tab.reopenClosed')
    expect(m(letter('l', { meta: true }))).toBe('omnibox.focus')
    expect(m(letter('r', { meta: true }))).toBe('nav.reload')
    expect(m(letter('f', { meta: true }))).toBe('find.open')
    expect(m(letter('g', { meta: true }))).toBe('find.next')
    expect(m(letter('g', { meta: true, shift: true }))).toBe('find.previous')
    expect(m(letter('d', { meta: true }))).toBe('bookmark.toggle')
    expect(m(letter('y', { meta: true }))).toBe('page.history')
    expect(m(letter('j', { meta: true, shift: true }))).toBe('page.downloads')
    expect(m(letter('p', { meta: true, shift: true }))).toBe('palette.open')
    expect(m(letter('q', { meta: true }))).toBe('app.quit')
    // Option turns letters into symbols on mac: the physical key decides.
    expect(m(key({ key: 'ˆ', code: 'KeyI', meta: true, alt: true }))).toBe('devtools.toggle')
    expect(m(key({ key: 'F12', code: 'F12' }))).toBe('devtools.toggle')
    expect(m(key({ key: 'ArrowRight', code: 'ArrowRight', meta: true, alt: true }))).toBe('tab.next')
    expect(m(key({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true }))).toBe('tab.previous')
    expect(m(key({ key: 'Tab', code: 'Tab', control: true }))).toBe('tab.next')
    expect(m(key({ key: 'Tab', code: 'Tab', control: true, shift: true }))).toBe('tab.previous')
    expect(m(key({ key: 'f', code: 'KeyF', meta: true, control: true }))).toBe('view.toggleFullscreen')
  })

  it('digits, zoom keys and shifted symbols', () => {
    const m = (i: KeyInput) => matchInput(i, 'mac')
    for (let n = 1; n <= 8; n++) expect(m(key({ key: String(n), code: `Digit${n}`, meta: true }))).toBe(`tab.select${n}`)
    expect(m(key({ key: '9', code: 'Digit9', meta: true }))).toBe('tab.selectLast')
    expect(m(key({ key: '=', code: 'Equal', meta: true }))).toBe('zoom.in')
    expect(m(key({ key: '+', code: 'Equal', meta: true, shift: true }))).toBe('zoom.in')
    expect(m(key({ key: '+', code: 'NumpadAdd', meta: true }))).toBe('zoom.in')
    expect(m(key({ key: '-', code: 'Minus', meta: true }))).toBe('zoom.out')
    expect(m(key({ key: '0', code: 'Digit0', meta: true }))).toBe('zoom.reset')
    expect(m(key({ key: '[', code: 'BracketLeft', meta: true }))).toBe('nav.back')
    expect(m(key({ key: ']', code: 'BracketRight', meta: true }))).toBe('nav.forward')
  })

  it('windows chords use Ctrl', () => {
    const m = (i: KeyInput) => matchInput(i, 'win')
    expect(m(letter('t', { control: true }))).toBe('tab.new')
    expect(m(letter('t', { meta: true }))).toBeNull()
    expect(m(letter('j', { control: true }))).toBe('page.downloads')
    expect(m(letter('i', { control: true, shift: true }))).toBe('devtools.toggle')
    expect(m(key({ key: 'F5', code: 'F5' }))).toBe('nav.reload')
    expect(m(key({ key: 'PageDown', code: 'PageDown', control: true }))).toBe('tab.next')
    expect(m(key({ key: 'ArrowLeft', code: 'ArrowLeft', alt: true }))).toBe('nav.back')
  })

  it('plain typing, edit keys and key-ups never match', () => {
    const m = (i: KeyInput) => matchInput(i, 'mac')
    expect(m(letter('t'))).toBeNull()
    expect(m(letter('c', { meta: true }))).toBeNull()
    expect(m(letter('v', { meta: true }))).toBeNull()
    expect(m(letter('a', { meta: true }))).toBeNull()
    expect(m(letter('z', { meta: true }))).toBeNull()
    expect(m({ ...letter('t', { meta: true }), type: 'keyUp' })).toBeNull()
  })

  it('layout-aware: AZERTY Cmd+A (physical Q) is select-all, not quit', () => {
    expect(matchInput(key({ key: 'a', code: 'KeyQ', meta: true }), 'mac')).toBeNull()
    expect(matchInput(key({ key: 'q', code: 'KeyA', meta: true }), 'mac')).toBe('app.quit')
  })

  it('auto-repeat only for repeatable commands', () => {
    expect(matchInput({ ...letter('w', { meta: true }), isAutoRepeat: true }, 'mac')).toBeNull()
    expect(matchInput({ ...key({ key: '=', code: 'Equal', meta: true }), isAutoRepeat: true }, 'mac')).toBe('zoom.in')
  })

  it('isEscape', () => {
    expect(isEscape(key({ key: 'Escape', code: 'Escape' }))).toBe(true)
    expect(isEscape(key({ key: 'Escape', code: 'Escape', shift: true }))).toBe(false)
    expect(isEscape({ ...key({ key: 'Escape', code: 'Escape' }), type: 'keyUp' })).toBe(false)
  })
})

describe('view source (AC54)', () => {
  const find = (items: MenuItemConstructorOptions[]) => items.find((i) => i.id === 'page.viewSource')

  it('maps only http(s) URLs to view-source:', async () => {
    const { viewSourceUrlFor } = await import('../../src/main/commands/menu')
    expect(viewSourceUrlFor('https://example.com/a?b=1')).toBe('view-source:https://example.com/a?b=1')
    expect(viewSourceUrlFor('http://example.com/')).toBe('view-source:http://example.com/')
    for (const u of ['retronet://settings/', 'file:///etc/hosts', 'about:blank', 'view-source:https://a.com/', 'javascript:1', '', 'https://']) {
      expect(viewSourceUrlFor(u)).toBeNull()
    }
  })

  it('strips inner userinfo (AC73, E1/R34)', async () => {
    const { viewSourceUrlFor } = await import('../../src/main/commands/menu')
    expect(viewSourceUrlFor('http://u:p@h.test/')).toBe('view-source:http://h.test/')
    expect(viewSourceUrlFor('https://u@h.test/x?y#z')).toBe('view-source:https://h.test/x?y#z')
    expect(viewSourceUrlFor('view-source:http://u:p@h.test/')).toBeNull()
    expect(viewSourceUrlFor('view-source:view-source:')).toBeNull()
    expect(viewSourceUrlFor('file:///x')).toBeNull()
  })

  it('is in View > Developer, enabled only for http(s) active tabs', () => {
    expect(find(build({ activeUrl: 'https://example.com/' }).items)?.enabled).toBe(true)
    expect(find(build({ activeUrl: 'retronet://history/' }).items)?.enabled).toBe(false)
    expect(find(build({ activeUrl: 'file:///x.html' }).items)?.enabled).toBe(false)
    expect(find(build().items)?.enabled).toBeUndefined()
  })

  it('click runs the command; the chord matches on both platforms', () => {
    const b = build({ activeUrl: 'https://example.com/' })
    find(b.items)?.click?.({} as never, undefined, {} as never)
    expect(b.runs).toEqual([['page.viewSource', undefined]])
    expect(acceleratorIndex('win').get(normalizeAccelerator('Ctrl+U'))).toBe('page.viewSource')
    expect(acceleratorIndex('mac').get(normalizeAccelerator('Cmd+Alt+U'))).toBe('page.viewSource')
  })
})
