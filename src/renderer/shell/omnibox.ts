// Location row and omnibox (DESIGN 3.2, 2.1-2.3; SPEC AC2, AC3, AC6, AC37).
// [Bookmarks menu button (1997)] label [security slot | input (pixel font) | star] [Go (2001)]
//
// Behaviour: select-all on focus (also on the first click), Enter navigates via tabs.navigate({input}) (main
// classifies URL vs search), Cmd/Alt+Enter opens in a new tab, Esc closes suggestions first and then reverts
// and leaves the field. Suggestions are drawn by the OVERLAY view anchored to the omnibox (the tab view would
// cover a dropdown drawn here); focus stays in this input, so keyboard handling lives here and the selected row
// is mirrored into a role=status region (aria-activedescendant can't point into another webContents).
//
// Display (D11, Q6): while the field is not focused, a web URL is drawn by an aria-hidden twin layer with the host
// in --rn-field-fg and scheme/port/path dimmed; the input underneath keeps the full text as its value (what screen
// readers read and what editing shows). Userinfo ("user:pass@", "google.com@") is stripped from both.
import { h, icon } from '../common/dom'
import type { ShellBridge } from '../common/api'
import type { Platform, Rect, SecurityState, SkinId, Suggestion, TabState, WindowSnapshot } from '@shared/types'
import { BOOKMARK_BAR_ID } from '@shared/types'
import { SKIN_TRAITS } from '@shared/skins'
import { OMNIBOX_INPUT_MAX } from '@shared/omnibox'
import { displayUrl as visibleUrl, omniboxSegments } from '@shared/url-safety'
import { call, withShortcut } from './toolbar'

const LABELS: Record<SkinId, string> = { y1994: 'URL:', y1997: 'Location:', y1999: 'Web address', y2001: 'Address' }

const SECURITY: Record<SecurityState, { icon: string; text: string; label: string }> = {
  secure: { icon: 'lock', text: '', label: 'Secure connection' },
  insecure: { icon: 'not-secure', text: 'Not secure', label: 'Not secure: this connection is not encrypted' },
  'cert-warning': { icon: 'warning', text: 'Not secure', label: 'Not secure: certificate problem' },
  internal: { icon: 'page', text: 'RetroNet', label: 'RetroNet page' },
  file: { icon: 'page', text: 'File', label: 'Local file' }
}

/** Pages whose address is noise in the field: the new-tab page shows the placeholder instead. */
function displayUrl(url: string): string {
  return /^retronet:\/\/newtab\/?$/i.test(url) ? '' : visibleUrl(url)
}

export interface OmniboxDeps {
  api: ShellBridge
  platform: Platform
}

export interface Omnibox {
  readonly el: HTMLElement
  readonly input: HTMLInputElement
  render(skin: SkinId): void
  update(snap: WindowSnapshot, active: TabState | undefined): void
  focus(): void
  /** Main says the overlay picked a suggestion (ui omnibox-picked). */
  picked(): void
}

let uid = 0

export function createOmnibox(deps: OmniboxDeps): Omnibox {
  const { api, platform } = deps
  const id = `rn-omnibox-${++uid}`

  const label = h('label', { class: 'rn-omnibox__label', attrs: { for: id }, text: LABELS.y1997 })
  const secIcon = icon('page')
  const secText = h('span', { class: 'rn-omnibox__security-text' })
  const security = h('button', { class: 'rn-omnibox__security', attrs: { type: 'button', tabindex: '-1' } }, secIcon, secText)
  const input = h('input', {
    class: 'rn-omnibox__input',
    attrs: {
      id,
      type: 'text',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-haspopup': 'listbox',
      placeholder: 'Search or enter address',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      inputmode: 'url',
      enterkeyhint: 'go'
    }
  })
  const starIcon = icon('bookmark')
  const star = h(
    'button',
    {
      class: 'rn-btn rn-btn--icon rn-omnibox__star',
      attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Bookmark this page', title: withShortcut('Bookmark this page', 'bookmark.toggle', platform) }
    },
    starIcon
  )
  // Emphasised twin of the input's text (D11). Decorative: the input's value is the accessible text.
  const dimBefore = h('span', { class: 'rn-omnibox__dim' })
  const host = h('span', { class: 'rn-omnibox__host' })
  const dimAfter = h('span', { class: 'rn-omnibox__dim' })
  const display = h('div', { class: 'rn-omnibox__display', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'rn-omnibox__display-line' }, dimBefore, host, dimAfter))
  const textBox = h('div', { class: 'rn-omnibox__text' }, input, display)
  /** Inline error (Q7), e.g. an address over the length limit. Announced once via role=alert. */
  const error = h('span', { class: 'rn-omnibox__error', attrs: { id: `${id}-error`, role: 'alert', hidden: true } })
  const field = h('div', { class: 'rn-omnibox', data: { security: 'internal' } }, security, textBox, error, star)
  const bookmarksBtn = h(
    'button',
    { class: 'rn-btn rn-locationbar__bookmarks', attrs: { type: 'button', 'aria-haspopup': 'menu' } },
    icon('bookmark'),
    h('span', { class: 'rn-btn__label', text: 'Bookmarks' }),
    icon('chevron-down')
  )
  const go = h('button', { class: 'rn-btn rn-btn--go', attrs: { type: 'button', title: 'Go to the address or search' } }, icon('go'), h('span', { class: 'rn-btn__label', text: 'Go' }))
  /** Reads the highlighted suggestion (DESIGN 3.2). Kept rendered and empty so updates announce reliably. */
  const live = h('div', { class: 'rn-sr-only', attrs: { role: 'status', 'aria-live': 'polite' } })
  const el = h('div', { class: 'rn-locationbar' }, bookmarksBtn, label, field, go, live)

  let active: TabState | undefined
  let popup = false
  let editing = false
  let items: Suggestion[] = []
  let selected = -1
  let open = false
  let suggestSeq = 0
  let selectOnMouseUp = false
  let blurTimer: ReturnType<typeof setTimeout> | null = null

  // ---- display ----

  function setEditing(on: boolean): void {
    editing = on
    field.classList.toggle('rn-omnibox--editing', on)
  }

  function showCurrent(): void {
    setValue(active ? displayUrl(active.url) : '')
  }

  /** Sets the field text and its emphasised twin (only web URLs get the host highlight). */
  function setValue(text: string): void {
    if (input.value !== text) input.value = text
    const seg = text ? omniboxSegments(text) : null
    field.classList.toggle('rn-omnibox--emphasis', !!seg && seg.text === text)
    if (seg && seg.text === text) {
      dimBefore.textContent = seg.before
      host.textContent = seg.host
      dimAfter.textContent = seg.after
    } else {
      dimBefore.textContent = host.textContent = dimAfter.textContent = ''
    }
  }

  function showError(message: string | null): void {
    if (!message) {
      if (error.hidden) return
      error.hidden = true
      error.textContent = ''
      error.removeAttribute('title')
      input.removeAttribute('aria-invalid')
      input.removeAttribute('aria-describedby')
      field.classList.remove('rn-omnibox--invalid')
      return
    }
    error.textContent = message
    error.title = message
    error.hidden = false
    input.setAttribute('aria-invalid', 'true')
    input.setAttribute('aria-describedby', error.id)
    field.classList.add('rn-omnibox--invalid')
  }

  function applySecurity(state: SecurityState): void {
    const s = SECURITY[state]
    if (field.dataset.security !== state) field.dataset.security = state
    if (secIcon.dataset.icon !== s.icon) secIcon.dataset.icon = s.icon
    secText.textContent = s.text
    security.setAttribute('aria-label', s.label)
    security.title = s.label
  }

  // ---- suggestions ----

  function anchor(): Rect {
    const r = field.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.bottom), width: Math.round(r.width), height: 0 }
  }

  function setOpen(on: boolean): void {
    open = on
    input.setAttribute('aria-expanded', on ? 'true' : 'false')
    if (!on) {
      items = []
      selected = -1
      live.textContent = ''
    }
  }

  function dismiss(): void {
    suggestSeq++
    if (open) void call(api.omnibox.dismiss(), 'omnibox.dismiss')
    setOpen(false)
  }

  async function suggest(text: string): Promise<void> {
    const seq = ++suggestSeq
    if (!text.trim()) {
      if (open) void call(api.omnibox.dismiss(), 'omnibox.dismiss')
      setOpen(false)
      return
    }
    const res = await call(api.omnibox.suggest({ text: text.slice(0, 2048), anchor: anchor() }), 'omnibox.suggest')
    if (seq !== suggestSeq || !editing) return // a newer keystroke (or Esc/blur) superseded this one
    items = res?.items ?? []
    selected = -1
    setOpen(items.length > 0)
  }

  function highlight(index: number): void {
    selected = index
    void call(api.omnibox.highlight({ index }), 'omnibox.highlight')
    const item = items[index]
    live.textContent = item ? `${item.title || item.url}, ${item.kind === 'search' ? 'search' : item.url}, ${index + 1} of ${items.length}` : ''
  }

  // ---- navigation ----

  async function navigate(text: string, newTab: boolean): Promise<void> {
    const value = text.trim()
    if (!value) return
    if (value.length > OMNIBOX_INPUT_MAX) {
      // Never navigate to a silently cut-off address: say why nothing happened and keep the text to fix.
      dismiss()
      showError(`Address too long (${OMNIBOX_INPUT_MAX.toLocaleString('en-US')} characters max)`)
      return
    }
    showError(null)
    dismiss()
    setEditing(false)
    input.blur()
    const res = await call(
      api.tabs.navigate({ input: value, tabId: newTab ? undefined : active?.id, disposition: newTab ? 'new-tab' : 'current' }),
      'tabs.navigate'
    )
    if (res?.blocked) {
      // Blocked scheme (javascript:, data:, retronet://shell...): keep the text so the user sees what happened.
      setValue(value)
      return
    }
    showCurrent()
  }

  function submit(newTab: boolean): void {
    const item = selected >= 0 ? items[selected] : undefined
    void navigate(item ? item.url : input.value, newTab)
  }

  function revert(): void {
    setEditing(false)
    showError(null)
    showCurrent()
  }

  // ---- events ----

  input.addEventListener('focus', () => {
    if (blurTimer) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    input.select()
    selectOnMouseUp = true
  })
  // A click that focuses the field would otherwise collapse the selection on mouseup.
  input.addEventListener('mouseup', (ev) => {
    if (selectOnMouseUp && input.selectionStart === input.selectionEnd) {
      ev.preventDefault()
      input.select()
    }
    selectOnMouseUp = false
  })
  input.addEventListener('mousedown', () => {
    if (document.activeElement !== input) selectOnMouseUp = true
  })
  input.addEventListener('input', () => {
    selectOnMouseUp = false
    setEditing(true)
    showError(null)
    field.classList.remove('rn-omnibox--emphasis') // the twin layer shows the old URL; typed text stays plain
    void suggest(input.value)
  })
  input.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return
    switch (ev.key) {
      case 'Enter': {
        ev.preventDefault()
        submit(platform === 'mac' ? ev.metaKey : ev.altKey)
        return
      }
      case 'Escape': {
        ev.preventDefault()
        if (open) {
          dismiss()
          return
        }
        revert()
        input.blur()
        return
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!open || items.length === 0) return
        ev.preventDefault()
        const step = ev.key === 'ArrowDown' ? 1 : -1
        // -1 = back to what the user typed; wraps through it like the era's list boxes did not, modern ones do.
        let next = selected + step
        if (next >= items.length) next = -1
        if (next < -1) next = items.length - 1
        highlight(next)
        return
      }
      case 'Tab':
        dismiss()
        return
    }
  })
  input.addEventListener('blur', () => {
    // Clicking a suggestion row focuses the overlay webContents first; give its pick a moment to land
    // before the list is dismissed (main then sends ui omnibox-picked).
    blurTimer = setTimeout(() => {
      blurTimer = null
      dismiss()
      if (!input.value.trim() || !editing) revert()
    }, 250)
  })
  window.addEventListener('blur', () => {
    if (open) dismiss()
  })

  star.addEventListener('click', async () => {
    const was = star.getAttribute('aria-pressed') === 'true'
    setStar(!was) // optimistic; the next snapshot confirms
    const res = await call(api.bookmarks.toggleCurrent(), 'bookmarks.toggleCurrent')
    setStar(res ? res.bookmarked : was)
  })
  go.addEventListener('click', () => submit(false))
  bookmarksBtn.addEventListener('click', (e) => {
    const r = bookmarksBtn.getBoundingClientRect()
    const hadFocus = bookmarksBtn === document.activeElement
    bookmarksBtn.setAttribute('aria-expanded', 'true')
    void call(
      api.bookmarks.barFolderMenu({
        folderId: BOOKMARK_BAR_ID,
        x: Math.round(r.left),
        y: Math.round(r.bottom),
        anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
        ...(e.detail === 0 ? { keyboard: true } : {})
      }),
      'bookmarks.barFolderMenu'
    ).finally(() => {
      bookmarksBtn.removeAttribute('aria-expanded')
      if (hadFocus && bookmarksBtn.isConnected && document.activeElement !== bookmarksBtn) bookmarksBtn.focus({ preventScroll: true })
    })
  })

  function setStar(on: boolean): void {
    star.setAttribute('aria-pressed', on ? 'true' : 'false')
    starIcon.dataset.icon = on ? 'bookmark-filled' : 'bookmark'
    const text = on ? 'Remove bookmark' : 'Bookmark this page'
    star.setAttribute('aria-label', text)
    star.title = withShortcut(text, 'bookmark.toggle', platform)
  }

  // ---- public ----

  function render(skin: SkinId): void {
    label.textContent = LABELS[skin]
    bookmarksBtn.hidden = !SKIN_TRAITS[skin].bookmarksButton || popup
    go.hidden = !SKIN_TRAITS[skin].goButton || popup
  }

  function update(snap: WindowSnapshot, tab: TabState | undefined): void {
    const tabChanged = tab?.id !== active?.id
    const prev = active
    active = tab
    if (popup !== snap.popup) {
      popup = snap.popup
      input.readOnly = popup
      star.hidden = popup
      render((document.documentElement.dataset.skin as SkinId | undefined) ?? 'y1997')
    }
    if (tabChanged && editing) {
      dismiss()
      setEditing(false)
    }
    if (tabChanged) showError(null)
    // Q12: a navigation (committed URL change, or a new load starting from back/forward, a link, a bookmark or the
    // bridge) makes an over-long draft stale. A user who is merely typing keeps their draft; one whose draft was
    // rejected (error showing) does not: drop the error and the draft and show where the tab actually is.
    const urlChanged = !tabChanged && !!tab && !!prev && tab.url !== prev.url
    const loadStarted = !tabChanged && !!tab && !!prev && tab.loading && !prev.loading
    if ((urlChanged || loadStarted) && !error.hidden) {
      dismiss()
      showError(null)
      setEditing(false)
      if (document.activeElement === input) input.blur()
      setValue(tab ? displayUrl(tab.url) : '')
    }
    if (!editing) {
      const next = tab ? displayUrl(tab.url) : ''
      if (input.value !== next) setValue(next)
    }
    applySecurity(tab?.security ?? 'internal')
    setStar(!!tab?.bookmarked)
    star.disabled = !tab
  }

  return {
    el,
    input,
    render,
    update,
    focus() {
      input.focus()
      input.select()
    },
    picked() {
      setOpen(false)
      setEditing(false)
      input.blur()
      showCurrent()
    }
  }
}
