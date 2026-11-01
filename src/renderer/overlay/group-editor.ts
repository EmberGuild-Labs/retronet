// Tab group editor (AC9, DESIGN 3.9). Name field + 9 colour swatches (radiogroup, roving tabindex, arrow keys),
// then Ungroup / Close group (danger) / Done. Changes apply live, like the era's property sheets with "Apply":
// the chip in the strip updates as you type or pick. Anchored under the chip when main gives an anchor.
import { GROUP_COLORS, type GroupState, type OverlayEvent } from '@shared/types'
import { h, icon } from '../common/dom'
import { clampInto, nextId, place, trapFocus, type Mounted, type OverlayEnv } from './ui'

type EditorEvent = Extract<OverlayEvent, { kind: 'group-editor' }>
type Color = (typeof GROUP_COLORS)[number]

const COLOR_NAMES: Record<Color, string> = {
  grey: 'Grey',
  blue: 'Blue',
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  pink: 'Pink',
  purple: 'Purple',
  cyan: 'Cyan',
  orange: 'Orange'
}
const NAME_DEBOUNCE_MS = 150
const WIDTH = 320

export function mountGroupEditor(ev: EditorEvent, env: OverlayEnv): Mounted {
  const { api } = env
  const groupId = ev.groupId
  const initial: GroupState | undefined = env.snapshot()?.groups.find((g) => g.id === groupId)
  let color: Color = initial?.color ?? 'grey'
  let busy = false
  let seeded = initial !== undefined

  const titleId = nextId('rn-ge-title')
  const nameId = nextId('rn-ge-name')
  const colorLabelId = nextId('rn-ge-color')

  const name = h('input', {
    class: 'rn-input rn-group-editor__name',
    attrs: { id: nameId, type: 'text', maxlength: 64, autocomplete: 'off', spellcheck: 'false', placeholder: 'Unnamed group' }
  })
  name.value = initial?.name ?? ''

  let nameTimer: ReturnType<typeof setTimeout> | null = null
  let sentName = name.value
  const flushName = async (): Promise<void> => {
    if (nameTimer) clearTimeout(nameTimer)
    nameTimer = null
    const v = name.value.slice(0, 64)
    if (v === sentName) return
    sentName = v
    await api.groups.update({ groupId, name: v })
  }
  name.addEventListener('input', () => {
    if (nameTimer) clearTimeout(nameTimer)
    nameTimer = setTimeout(() => void flushName(), NAME_DEBOUNCE_MS)
  })

  const swatches = GROUP_COLORS.map((c) =>
    h('button', {
      class: 'rn-swatch',
      attrs: { type: 'button', role: 'radio', 'aria-label': COLOR_NAMES[c], title: COLOR_NAMES[c] },
      data: { color: c }
    })
  )
  const group = h(
    'div',
    { class: 'rn-swatches', attrs: { role: 'radiogroup', 'aria-labelledby': colorLabelId } },
    ...swatches
  )
  const paint = (): void => {
    swatches.forEach((s, i) => {
      const on = GROUP_COLORS[i] === color
      s.setAttribute('aria-checked', on ? 'true' : 'false')
      s.tabIndex = on ? 0 : -1
    })
  }
  const pick = (i: number, focus: boolean): void => {
    const c = GROUP_COLORS[i]!
    if (focus) swatches[i]!.focus()
    if (c === color) return
    color = c
    paint()
    void api.groups.update({ groupId, color: c })
  }
  swatches.forEach((s, i) => {
    s.addEventListener('click', () => pick(i, false))
    s.addEventListener('keydown', (e) => {
      const n = swatches.length
      let next = -1
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = n - 1
      if (next < 0) return
      e.preventDefault()
      pick(next, true)
    })
  })
  paint()

  const finish = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await action()
    } finally {
      env.close()
    }
  }
  const done = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'button' }, text: 'Done', on: { click: () => void finish(flushName) } })
  const ungroup = h('button', {
    class: 'rn-btn',
    attrs: { type: 'button' },
    text: 'Ungroup',
    on: { click: () => void finish(() => api.groups.ungroup({ groupId })) }
  })
  const closeGroup = h(
    'button',
    { class: 'rn-btn rn-btn--danger', attrs: { type: 'button' }, on: { click: () => void finish(() => api.groups.close({ groupId })) } },
    icon('trash'),
    h('span', { class: 'rn-btn__label', text: 'Close group' })
  )

  const root = h(
    'div',
    { class: 'rn-dialog rn-group-editor', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
    h('h2', { class: 'rn-dialog__title', attrs: { id: titleId }, text: 'Edit group' }),
    h(
      'div',
      { class: 'rn-dialog__body' },
      h('div', { class: 'rn-dialog__field' }, h('label', { attrs: { for: nameId }, text: 'Group name' }), name),
      h('div', { class: 'rn-dialog__field rn-dialog__field--last' }, h('span', { attrs: { id: colorLabelId }, text: 'Color' }), group)
    ),
    h('div', { class: 'rn-dialog__actions rn-group-editor__actions' }, ungroup, closeGroup, h('span', { class: 'rn-dialog__spacer' }), done)
  )
  trapFocus(root)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void finish(flushName)
    } else if (e.key === 'Enter' && e.target === name) {
      e.preventDefault()
      void finish(flushName)
    }
  })

  if (ev.anchor) {
    root.classList.add('rn-dialog--anchored')
    const { left, top } = clampInto(ev.anchor.x, ev.anchor.y + ev.anchor.height + 4, WIDTH, 230)
    place(root, left, top)
  }
  queueMicrotask(() => {
    name.focus()
    name.select()
  })

  return {
    root,
    onOutside: () => void finish(flushName),
    onState(snap) {
      const g = snap.groups.find((x) => x.id === groupId)
      // Closed or ungrouped elsewhere (menu, shortcut, last tab closed): nothing left to edit.
      if (!g) return env.close()
      if (!seeded) {
        // The editor opened before the first snapshot arrived: fill in the real name now.
        seeded = true
        name.value = sentName = g.name
      }
      if (g.color !== color) {
        color = g.color
        paint()
      }
    },
    destroy() {
      if (nameTimer) void flushName()
    }
  }
}
