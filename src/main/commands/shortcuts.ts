// Keyboard shortcuts (PLAN 1.3, AC21, AC42). Every registry accelerator is matched in `before-input-event` on
// the shell, overlay and every tab webContents, so a shortcut works wherever focus is, and a page never sees
// (or can swallow) a browser shortcut: `preventDefault()` there also stops the page's keydown and the menu
// accelerator, so a command never runs twice. The mac app menu still carries the accelerators for display and
// for when no webContents has focus. Edit keys (copy, paste, undo...) are not registry commands and pass through.
import type { Event, Input, WebContents } from 'electron'
import {
  COMMANDS,
  normalizeAccelerator,
  type CommandId,
  type Modifier,
  type Platform
} from '../../shared/commands'

/** Commands that may fire on key auto-repeat (holding the key). Everything else fires once per press. */
const REPEATABLE: ReadonlySet<CommandId> = new Set<CommandId>([
  'tab.next',
  'tab.previous',
  'nav.back',
  'nav.forward',
  'find.next',
  'find.previous',
  'zoom.in',
  'zoom.out'
])

/** Normalized accelerator -> command, per platform. */
export function acceleratorIndex(platform: Platform): ReadonlyMap<string, CommandId> {
  const map = new Map<string, CommandId>()
  for (const c of COMMANDS) {
    for (const a of c.accelerator[platform]) {
      const n = normalizeAccelerator(a)
      if (!map.has(n)) map.set(n, c.id)
    }
  }
  return map
}

const INDEX: Record<Platform, ReadonlyMap<string, CommandId> | null> = { mac: null, win: null }
function indexFor(platform: Platform): ReadonlyMap<string, CommandId> {
  return (INDEX[platform] ??= acceleratorIndex(platform))
}

/** The parts of Electron's `Input` the matcher reads (so tests can pass plain objects). */
export type KeyInput = Pick<Input, 'type' | 'key' | 'code' | 'control' | 'alt' | 'shift' | 'meta'> & { isAutoRepeat?: boolean }

// Physical key code -> Electron accelerator key name, for keys whose `key` value depends on modifiers
// (Option on mac turns letters into symbols) or is not an accelerator name.
const CODE_KEYS: Readonly<Record<string, string>> = {
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Tab: 'Tab',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  Enter: 'Enter',
  Space: 'Space',
  NumpadAdd: 'Plus',
  NumpadSubtract: '-',
  NumpadEqual: '='
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  '+': 'Plus',
  ' ': 'Space'
}

/** Accelerator key names this input could mean (layout key first, then the physical key). */
function keyCandidates(input: KeyInput): string[] {
  const out: string[] = []
  const add = (k: string | undefined): void => {
    if (k && !out.includes(k)) out.push(k)
  }
  const key = input.key ?? ''
  // A printable letter/digit as typed (layout-aware). When it is one, the physical key is not consulted, so on
  // AZERTY Cmd+A (physical Q) can never mean Cmd+Q.
  const layoutAlnum = /^[a-z0-9]$/i.test(key)
  if (layoutAlnum) add(key.toUpperCase())
  else if (KEY_NAMES[key]) add(KEY_NAMES[key])
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) add(key)
  else if (key.length === 1 && !input.alt) add(key)
  const code = input.code ?? ''
  if (!layoutAlnum) {
    // Option/Alt (mac) or Shift turned the letter/digit into a symbol: use the physical key.
    let m = /^Key([A-Z])$/.exec(code)
    if (m) add(m[1])
    m = /^(?:Digit|Numpad)([0-9])$/.exec(code)
    if (m) add(m[1])
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) add(code)
  add(CODE_KEYS[code])
  if (!out.length && KEY_NAMES[key] === undefined && key.length > 1) add(key)
  return out
}

/** Registry command for a key press, or null. Ignores key-ups and repeats of non-repeatable commands. */
export function matchInput(input: KeyInput, platform: Platform): CommandId | null {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null
  const mods: Modifier[] = []
  if (input.control) mods.push('Ctrl')
  if (input.alt) mods.push('Alt')
  if (input.shift) mods.push('Shift')
  // Meta is Cmd on mac; on Windows it is the Windows key, which no registry chord uses.
  if (input.meta) mods.push('Cmd')
  const index = indexFor(platform)
  const lookup = (m: readonly Modifier[], key: string): CommandId | null => index.get([...m, key].join('+')) ?? null
  for (const key of keyCandidates(input)) {
    let id = lookup(mods, key)
    // Shift+= types '+': 'CmdOrCtrl+Plus' is spelled without Shift.
    if (!id && key === 'Plus' && input.shift) id = lookup(mods.filter((x) => x !== 'Shift'), key)
    if (!id && key === '=' && input.shift) id = lookup(mods.filter((x) => x !== 'Shift'), 'Plus')
    if (id) {
      if (input.isAutoRepeat && !REPEATABLE.has(id)) return null
      return id
    }
  }
  return null
}

export function isEscape(input: KeyInput): boolean {
  return (
    input.type === 'keyDown' &&
    (input.key === 'Escape' || input.code === 'Escape') &&
    !input.control &&
    !input.alt &&
    !input.meta &&
    !input.shift
  )
}

export interface ShortcutHandlers {
  /** A registry shortcut was pressed in `wc`. */
  run(wc: WebContents, id: CommandId): void
  /** Esc in a tab (closes the find bar). Return true if it was used (the page then does not see it). */
  escape(wc: WebContents): boolean
  /** Only shell, overlay and tab webContents of our windows get shortcuts (not devtools, not strays). */
  accepts(wc: WebContents): boolean
}

const attached = new WeakSet<WebContents>()

/** Install the shortcut handler on one webContents (idempotent). */
export function attachShortcuts(wc: WebContents, platform: Platform, h: ShortcutHandlers): void {
  if (attached.has(wc)) return
  attached.add(wc)
  wc.on('before-input-event', (event: Event, input: Input) => {
    if (!h.accepts(wc)) return
    const id = matchInput(input, platform)
    if (id) {
      event.preventDefault()
      h.run(wc, id)
      return
    }
    if (isEscape(input) && h.escape(wc)) event.preventDefault()
  })
}
