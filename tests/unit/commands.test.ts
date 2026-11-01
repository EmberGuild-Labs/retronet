import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  COMMAND_CATEGORIES,
  accel,
  acceleratorLabel,
  acceleratorParts,
  commandShortcutLabel,
  commandsFor,
  findDuplicateAccelerators,
  getCommand,
  isCommandId,
  normalizeAccelerator,
  parseAccelerator,
  perPlatform,
  platformKey,
  type CommandId,
  type Platform
} from '@shared/commands'

const PLATFORMS: Platform[] = ['mac', 'win']
const primary = (id: CommandId, p: Platform): string | undefined => getCommand(id)?.accelerator[p][0]

describe('command registry', () => {
  it('has unique ids, a title and a known category for every command', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of COMMANDS) {
      expect(c.title.trim().length, c.id).toBeGreaterThan(0)
      expect(COMMAND_CATEGORIES).toContain(c.category)
    }
  })

  it.each(PLATFORMS)('has no duplicate accelerators on %s', (p) => {
    expect(findDuplicateAccelerators(p)).toEqual([])
  })

  it('detects duplicates, including modifier-order variants', () => {
    const fake = [
      { ...COMMANDS[0]!, accelerator: accel('CmdOrCtrl+Shift+X') },
      { ...COMMANDS[1]!, accelerator: perPlatform('Shift+Cmd+x', 'Ctrl+Y') }
    ]
    expect(findDuplicateAccelerators('mac', fake)).toHaveLength(1)
    expect(findDuplicateAccelerators('win', fake)).toEqual([])
  })

  it.each(PLATFORMS)('every accelerator on %s parses and has no unresolved CmdOrCtrl', (p) => {
    for (const c of COMMANDS) for (const a of c.accelerator[p]) expect(() => parseAccelerator(a), `${c.id} ${a}`).not.toThrow()
  })

  it('mac never uses Ctrl as a stand-in for Cmd, and win never uses Cmd', () => {
    for (const c of COMMANDS) {
      for (const a of c.accelerator.win) expect(parseAccelerator(a).modifiers, `${c.id} ${a}`).not.toContain('Cmd')
    }
    // On mac, Ctrl only appears where the convention really is Control (Ctrl+Tab, Ctrl+Cmd+F).
    const macCtrl = COMMANDS.flatMap((c) => c.accelerator.mac.filter((a) => parseAccelerator(a).modifiers.includes('Ctrl')))
    expect(macCtrl.sort()).toEqual(['Ctrl+Cmd+F', 'Ctrl+Shift+Tab', 'Ctrl+Tab'])
  })

  // AC21 shortcuts (Cmd on mac, Ctrl on Windows)
  it.each([
    ['tab.new', 'Cmd+T', 'Ctrl+T'],
    ['tab.close', 'Cmd+W', 'Ctrl+W'],
    ['window.new', 'Cmd+N', 'Ctrl+N'],
    ['window.newIncognito', 'Cmd+Shift+N', 'Ctrl+Shift+N'],
    ['tab.reopenClosed', 'Cmd+Shift+T', 'Ctrl+Shift+T'],
    ['tab.next', 'Ctrl+Tab', 'Ctrl+Tab'],
    ['tab.previous', 'Ctrl+Shift+Tab', 'Ctrl+Shift+Tab'],
    ['tab.select1', 'Cmd+1', 'Ctrl+1'],
    ['tab.select8', 'Cmd+8', 'Ctrl+8'],
    ['tab.selectLast', 'Cmd+9', 'Ctrl+9'],
    ['omnibox.focus', 'Cmd+L', 'Ctrl+L'],
    ['nav.reload', 'Cmd+R', 'Ctrl+R'],
    ['find.open', 'Cmd+F', 'Ctrl+F'],
    ['bookmark.toggle', 'Cmd+D', 'Ctrl+D'],
    ['bookmarkBar.toggle', 'Cmd+Shift+B', 'Ctrl+Shift+B'],
    ['page.history', 'Cmd+Y', 'Ctrl+H'],
    ['page.downloads', 'Cmd+Shift+J', 'Ctrl+J'],
    ['zoom.in', 'Cmd+=', 'Ctrl+='],
    ['zoom.out', 'Cmd+-', 'Ctrl+-'],
    ['zoom.reset', 'Cmd+0', 'Ctrl+0'],
    ['devtools.toggle', 'Cmd+Alt+I', 'Ctrl+Shift+I'],
    ['view.toggleFullscreen', 'Ctrl+Cmd+F', 'F11'],
    ['palette.open', 'Cmd+Shift+P', 'Ctrl+Shift+P'],
    ['app.quit', 'Cmd+Q', 'Ctrl+Shift+Q']
  ] as const)('%s is %s on mac and %s on win', (id, mac, win) => {
    expect(primary(id, 'mac')).toBe(mac)
    expect(primary(id, 'win')).toBe(win)
  })

  it('page.viewSource: Cmd+Alt+U on mac, Ctrl+U on win, in the palette, no duplicate chord (AC54)', () => {
    const c = getCommand('page.viewSource')
    expect(c).toMatchObject({ title: 'View page source', category: 'Tools', palette: true })
    expect(c?.accelerator).toEqual({ mac: ['Cmd+Alt+U'], win: ['Ctrl+U'] })
    for (const p of PLATFORMS) {
      expect(findDuplicateAccelerators(p)).toEqual([])
      const others = COMMANDS.filter((x) => x.id !== 'page.viewSource').flatMap((x) => x.accelerator[p].map(normalizeAccelerator))
      expect(others).not.toContain(normalizeAccelerator(c!.accelerator[p][0]!))
    }
  })

  it('has the secondary AC21 chords', () => {
    expect(getCommand('tab.next')?.accelerator.mac).toContain('Cmd+Alt+Right')
    expect(getCommand('tab.previous')?.accelerator.mac).toContain('Cmd+Alt+Left')
    expect(getCommand('devtools.toggle')?.accelerator.mac).toContain('F12')
    expect(getCommand('devtools.toggle')?.accelerator.win).toContain('F12')
    expect(getCommand('zoom.in')?.accelerator.win).toContain('Ctrl+Plus')
  })

  it('has the palette-only commands, visible in the palette', () => {
    for (const id of [
      'skin.switch',
      'profile.switch',
      'profile.new',
      'bookmarkBar.toggle',
      'page.settings',
      'page.about',
      'page.shortcuts',
      'data.clear',
      'tab.toggleMute'
    ] as const) {
      expect(getCommand(id)?.palette, id).toBe(true)
    }
    expect(getCommand('skin.switch')?.arg).toBe('skin')
    expect(getCommand('profile.switch')?.arg).toBe('profile')
    // "inc" should find the incognito command by title (AC22 done-when for T20).
    expect(COMMANDS.filter((c) => c.palette && /inc/i.test(c.title)).map((c) => c.id)).toContain('window.newIncognito')
  })

  it('isCommandId rejects unknown and prototype names', () => {
    expect(isCommandId('tab.new')).toBe(true)
    expect(isCommandId('constructor')).toBe(false)
    expect(isCommandId(42)).toBe(false)
  })

  it('commandsFor flattens per platform', () => {
    const win = commandsFor('win')
    expect(win).toHaveLength(COMMANDS.length)
    expect(win.find((c) => c.id === 'page.downloads')?.accelerators).toEqual(['Ctrl+J'])
    expect(commandsFor('mac').find((c) => c.id === 'skin.switch')).toMatchObject({ accelerators: [], arg: 'skin' })
  })
})

describe('CmdOrCtrl helper and accelerator labels (AC42)', () => {
  it('resolves CmdOrCtrl per platform', () => {
    expect(accel('CmdOrCtrl+Shift+T')).toEqual({ mac: ['Cmd+Shift+T'], win: ['Ctrl+Shift+T'] })
    expect(accel('F12')).toEqual({ mac: ['F12'], win: ['F12'] })
  })

  it('maps node platforms', () => {
    expect(platformKey('darwin')).toBe('mac')
    expect(platformKey('win32')).toBe('win')
    expect(platformKey('linux')).toBe('win')
  })

  it('parses and normalizes', () => {
    expect(parseAccelerator('Shift+Command+t')).toEqual({ modifiers: ['Shift', 'Cmd'], key: 'T' })
    expect(normalizeAccelerator('Cmd+Option+Left')).toBe('Alt+Cmd+Left')
    expect(() => parseAccelerator('CmdOrCtrl+T')).toThrow()
    expect(() => parseAccelerator('Cmd+Cmd+T')).toThrow()
    expect(() => parseAccelerator('Cmd+')).toThrow()
  })

  it('formats labels with platform glyphs', () => {
    expect(acceleratorLabel('Cmd+Shift+P', 'mac')).toBe('⇧⌘P')
    expect(acceleratorLabel('Ctrl+Shift+P', 'win')).toBe('Ctrl+Shift+P')
    expect(acceleratorParts('Cmd+Alt+Right', 'mac')).toEqual(['⌥', '⌘', '→'])
    expect(acceleratorLabel('Ctrl+PageDown', 'win')).toBe('Ctrl+PgDn')
    expect(commandShortcutLabel('tab.new', 'mac')).toBe('⌘T')
    expect(commandShortcutLabel('skin.switch', 'mac')).toBe('')
  })
})
