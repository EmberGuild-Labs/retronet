// Command registry (AC21-AC23, AC42). The single source for the app menu, the shortcut handler,
// the command palette and retronet://shortcuts. Accelerators use Electron accelerator syntax with
// resolved modifiers (Cmd, Ctrl, Alt, Shift); `accel('CmdOrCtrl+T')` is the one CmdOrCtrl abstraction.

export type Platform = 'mac' | 'win'

/** Main maps `process.platform` with this; Linux follows the Ctrl layout. */
export function platformKey(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : 'win'
}

/** Accelerators per platform. The first entry is the primary one (shown in menus and labels). */
export interface Accelerators {
  mac: readonly string[]
  win: readonly string[]
}

const NO_KEYS: Accelerators = Object.freeze({ mac: [], win: [] })

/** Same chord on both platforms; `CmdOrCtrl` becomes Cmd on mac and Ctrl elsewhere. */
export function accel(...specs: string[]): Accelerators {
  return {
    mac: specs.map((s) => s.replace(/\bCmdOrCtrl\b/g, 'Cmd')),
    win: specs.map((s) => s.replace(/\bCmdOrCtrl\b/g, 'Ctrl'))
  }
}

/** Different chords per platform (null or [] = none on that platform). */
export function perPlatform(mac: string | readonly string[] | null, win: string | readonly string[] | null): Accelerators {
  const list = (v: string | readonly string[] | null): readonly string[] => (v === null ? [] : typeof v === 'string' ? [v] : v)
  return { mac: list(mac), win: list(win) }
}

/** Merge several accelerator sets (e.g. a shared chord plus platform extras). */
export function combine(...sets: Accelerators[]): Accelerators {
  return { mac: sets.flatMap((s) => s.mac), win: sets.flatMap((s) => s.win) }
}

export const COMMAND_CATEGORIES = [
  'Tabs',
  'Windows',
  'Navigation',
  'Find',
  'View',
  'Bookmarks',
  'Tools',
  'Appearance',
  'Profiles',
  'App'
] as const
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number]

/** Commands that need an argument; the palette expands them into one row per skin or profile. */
export type CommandArgKind = 'skin' | 'profile'

interface CommandInput {
  id: string
  title: string
  category: CommandCategory
  accelerator: Accelerators
  /** Shown in the command palette (AC22). Tab-number jumps are not: open tabs are listed instead. */
  palette: boolean
  arg?: CommandArgKind
}

function selectTab<N extends 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>(n: N) {
  return {
    id: `tab.select${n}` as `tab.select${N}`,
    title: `Go to tab ${n}`,
    category: 'Tabs',
    accelerator: accel(`CmdOrCtrl+${n}`),
    palette: false
  } as const
}

const DEFS = [
  // Tabs
  { id: 'tab.new', title: 'New tab', category: 'Tabs', accelerator: accel('CmdOrCtrl+T'), palette: true },
  { id: 'tab.close', title: 'Close tab', category: 'Tabs', accelerator: accel('CmdOrCtrl+W'), palette: true },
  { id: 'tab.reopenClosed', title: 'Reopen closed tab', category: 'Tabs', accelerator: accel('CmdOrCtrl+Shift+T'), palette: true },
  {
    id: 'tab.next',
    title: 'Next tab',
    category: 'Tabs',
    accelerator: combine(accel('Ctrl+Tab'), perPlatform('Cmd+Alt+Right', 'Ctrl+PageDown')),
    palette: true
  },
  {
    id: 'tab.previous',
    title: 'Previous tab',
    category: 'Tabs',
    accelerator: combine(accel('Ctrl+Shift+Tab'), perPlatform('Cmd+Alt+Left', 'Ctrl+PageUp')),
    palette: true
  },
  selectTab(1),
  selectTab(2),
  selectTab(3),
  selectTab(4),
  selectTab(5),
  selectTab(6),
  selectTab(7),
  selectTab(8),
  { id: 'tab.selectLast', title: 'Go to last tab', category: 'Tabs', accelerator: accel('CmdOrCtrl+9'), palette: false },
  { id: 'tab.togglePin', title: 'Pin or unpin tab', category: 'Tabs', accelerator: NO_KEYS, palette: true },
  { id: 'tab.toggleMute', title: 'Mute or unmute tab', category: 'Tabs', accelerator: NO_KEYS, palette: true },
  { id: 'tab.addToNewGroup', title: 'Add tab to new group', category: 'Tabs', accelerator: NO_KEYS, palette: true },
  // Windows
  { id: 'window.new', title: 'New window', category: 'Windows', accelerator: accel('CmdOrCtrl+N'), palette: true },
  {
    id: 'window.newIncognito',
    title: 'New incognito window',
    category: 'Windows',
    accelerator: accel('CmdOrCtrl+Shift+N'),
    palette: true
  },
  { id: 'window.close', title: 'Close window', category: 'Windows', accelerator: accel('CmdOrCtrl+Shift+W'), palette: true },
  // Navigation
  { id: 'nav.back', title: 'Back', category: 'Navigation', accelerator: perPlatform('Cmd+[', 'Alt+Left'), palette: true },
  { id: 'nav.forward', title: 'Forward', category: 'Navigation', accelerator: perPlatform('Cmd+]', 'Alt+Right'), palette: true },
  {
    id: 'nav.reload',
    title: 'Reload page',
    category: 'Navigation',
    accelerator: combine(accel('CmdOrCtrl+R'), perPlatform(null, 'F5')),
    palette: true
  },
  {
    id: 'nav.hardReload',
    title: 'Reload page, ignoring cache',
    category: 'Navigation',
    accelerator: combine(accel('CmdOrCtrl+Shift+R'), perPlatform(null, 'Ctrl+F5')),
    palette: true
  },
  { id: 'nav.stop', title: 'Stop loading', category: 'Navigation', accelerator: perPlatform('Cmd+.', null), palette: true },
  { id: 'nav.home', title: 'Home page', category: 'Navigation', accelerator: perPlatform('Cmd+Shift+H', 'Alt+Home'), palette: true },
  {
    id: 'omnibox.focus',
    title: 'Focus address bar',
    category: 'Navigation',
    accelerator: combine(accel('CmdOrCtrl+L'), perPlatform(null, 'Alt+D')),
    palette: true
  },
  // Find
  { id: 'find.open', title: 'Find in page', category: 'Find', accelerator: accel('CmdOrCtrl+F'), palette: true },
  { id: 'find.next', title: 'Find next', category: 'Find', accelerator: accel('CmdOrCtrl+G'), palette: true },
  { id: 'find.previous', title: 'Find previous', category: 'Find', accelerator: accel('CmdOrCtrl+Shift+G'), palette: true },
  // View
  { id: 'zoom.in', title: 'Zoom in', category: 'View', accelerator: accel('CmdOrCtrl+=', 'CmdOrCtrl+Plus'), palette: true },
  { id: 'zoom.out', title: 'Zoom out', category: 'View', accelerator: accel('CmdOrCtrl+-'), palette: true },
  { id: 'zoom.reset', title: 'Actual size', category: 'View', accelerator: accel('CmdOrCtrl+0'), palette: true },
  {
    id: 'view.toggleFullscreen',
    title: 'Toggle full screen',
    category: 'View',
    accelerator: perPlatform('Ctrl+Cmd+F', 'F11'),
    palette: true
  },
  {
    id: 'bookmarkBar.toggle',
    title: 'Show or hide bookmark bar',
    category: 'View',
    accelerator: accel('CmdOrCtrl+Shift+B'),
    palette: true
  },
  // Bookmarks and pages
  { id: 'bookmark.toggle', title: 'Bookmark this page', category: 'Bookmarks', accelerator: accel('CmdOrCtrl+D'), palette: true },
  {
    id: 'page.bookmarks',
    title: 'Open bookmark manager',
    category: 'Bookmarks',
    accelerator: perPlatform('Cmd+Alt+B', 'Ctrl+Shift+O'),
    palette: true
  },
  // Q4: the native print dialog for the active tab (webContents.print()).
  { id: 'file.print', title: 'Print...', category: 'Tools', accelerator: accel('CmdOrCtrl+P'), palette: true },
  { id: 'page.history', title: 'Open history', category: 'Tools', accelerator: perPlatform('Cmd+Y', 'Ctrl+H'), palette: true },
  {
    id: 'page.downloads',
    title: 'Open downloads',
    category: 'Tools',
    accelerator: perPlatform('Cmd+Shift+J', 'Ctrl+J'),
    palette: true
  },
  {
    id: 'devtools.toggle',
    title: 'Developer tools',
    category: 'Tools',
    accelerator: combine(perPlatform('Cmd+Alt+I', 'Ctrl+Shift+I'), accel('F12')),
    palette: true
  },
  {
    id: 'data.clear',
    title: 'Clear browsing data',
    category: 'Tools',
    accelerator: perPlatform('Cmd+Shift+Backspace', 'Ctrl+Shift+Delete'),
    palette: true
  },
  { id: 'palette.open', title: 'Command palette', category: 'Tools', accelerator: accel('CmdOrCtrl+Shift+P'), palette: false },
  // Appearance and profiles (palette-first)
  { id: 'skin.switch', title: 'Switch skin', category: 'Appearance', accelerator: NO_KEYS, palette: true, arg: 'skin' },
  { id: 'profile.switch', title: 'Switch profile', category: 'Profiles', accelerator: NO_KEYS, palette: true, arg: 'profile' },
  { id: 'profile.new', title: 'New profile', category: 'Profiles', accelerator: NO_KEYS, palette: true },
  // App
  { id: 'page.settings', title: 'Settings', category: 'App', accelerator: perPlatform('Cmd+,', null), palette: true },
  { id: 'page.shortcuts', title: 'Keyboard shortcuts', category: 'App', accelerator: NO_KEYS, palette: true },
  { id: 'page.about', title: 'About RetroNet', category: 'App', accelerator: NO_KEYS, palette: true },
  { id: 'app.quit', title: 'Quit RetroNet', category: 'App', accelerator: perPlatform('Cmd+Q', 'Ctrl+Shift+Q'), palette: true }
] as const satisfies readonly CommandInput[]

export type CommandId = (typeof DEFS)[number]['id']

export interface CommandDef {
  id: CommandId
  title: string
  category: CommandCategory
  accelerator: Accelerators
  palette: boolean
  arg?: CommandArgKind
}

export const COMMANDS: readonly CommandDef[] = Object.freeze(DEFS as readonly CommandDef[])
export const COMMAND_IDS: readonly CommandId[] = Object.freeze(COMMANDS.map((c) => c.id))

const BY_ID: ReadonlyMap<string, CommandDef> = new Map(COMMANDS.map((c) => [c.id, c]))

export function isCommandId(id: unknown): id is CommandId {
  return typeof id === 'string' && BY_ID.has(id)
}

export function getCommand(id: string): CommandDef | undefined {
  return BY_ID.get(id)
}

/** Flattened view for one platform (commands.list, shortcuts page). */
export interface CommandInfo {
  id: CommandId
  title: string
  category: CommandCategory
  accelerators: string[]
  palette: boolean
  arg?: CommandArgKind
}

export function commandsFor(platform: Platform): CommandInfo[] {
  return COMMANDS.map((c) => {
    const info: CommandInfo = {
      id: c.id,
      title: c.title,
      category: c.category,
      accelerators: [...c.accelerator[platform]],
      palette: c.palette
    }
    if (c.arg) info.arg = c.arg
    return info
  })
}

// ---- Accelerator parsing and labels ----

export type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Cmd'
const MODIFIER_ORDER: readonly Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Cmd']
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  cmd: 'Cmd',
  command: 'Cmd',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}

export interface ParsedAccelerator {
  modifiers: Modifier[]
  /** Electron key name; single letters are upper-cased. */
  key: string
}

/** Parses a resolved accelerator ('Cmd+Shift+T'). Throws on CmdOrCtrl, unknown modifiers or no key. */
export function parseAccelerator(accelerator: string): ParsedAccelerator {
  // '+' is a separator, so the Plus key is spelled 'Plus' (Electron convention).
  const parts = accelerator.split('+')
  const rawKey = parts.pop()
  if (!rawKey) throw new Error(`Accelerator has no key: ${accelerator}`)
  const mods = new Set<Modifier>()
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()]
    if (!m) throw new Error(`Unknown modifier "${p}" in ${accelerator}`)
    if (mods.has(m)) throw new Error(`Repeated modifier "${p}" in ${accelerator}`)
    mods.add(m)
  }
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey
  return { modifiers: MODIFIER_ORDER.filter((m) => mods.has(m)), key }
}

/** Canonical form for comparisons: modifiers in a fixed order. */
export function normalizeAccelerator(accelerator: string): string {
  const { modifiers, key } = parseAccelerator(accelerator)
  return [...modifiers, key].join('+')
}

const MAC_GLYPHS: Readonly<Record<Modifier, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
const MAC_KEYS: Readonly<Record<string, string>> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  Escape: 'Esc',
  Enter: '↩',
  Plus: '+'
}
const WIN_KEYS: Readonly<Record<string, string>> = { PageUp: 'PgUp', PageDown: 'PgDn', Plus: '+', Escape: 'Esc' }

/** Key-cap chips for `.rn-kbd`: mac ['⌘', '⇧', 'T'], win ['Ctrl', 'Shift', 'T']. */
export function acceleratorParts(accelerator: string, platform: Platform): string[] {
  const { modifiers, key } = parseAccelerator(accelerator)
  if (platform === 'mac') return [...modifiers.map((m) => MAC_GLYPHS[m]), MAC_KEYS[key] ?? key]
  return [...modifiers, WIN_KEYS[key] ?? key]
}

/** One-line label: mac '⌘⇧T', win 'Ctrl+Shift+T'. */
export function acceleratorLabel(accelerator: string, platform: Platform): string {
  return acceleratorParts(accelerator, platform).join(platform === 'mac' ? '' : '+')
}

/** Primary accelerator label for a command, or '' when it has none on this platform. */
export function commandShortcutLabel(id: CommandId, platform: Platform): string {
  const first = getCommand(id)?.accelerator[platform][0]
  return first ? acceleratorLabel(first, platform) : ''
}

/** Accelerators bound to more than one command (or twice to one) on a platform. Empty = OK. */
export function findDuplicateAccelerators(platform: Platform, commands: readonly CommandDef[] = COMMANDS): string[] {
  const seen = new Map<string, string>()
  const dupes: string[] = []
  for (const c of commands) {
    for (const a of c.accelerator[platform]) {
      const n = normalizeAccelerator(a)
      const prev = seen.get(n)
      if (prev) dupes.push(`${n} (${prev}, ${c.id})`)
      else seen.set(n, c.id)
    }
  }
  return dupes
}
