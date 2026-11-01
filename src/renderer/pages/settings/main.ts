// retronet://settings (T22, DESIGN 5.5, AC11, AC19, AC24, AC32, AC33). Every control saves on change and confirms
// with a polite "Saved" next to it for 2 s. The downloads folder is only ever chosen through the native picker
// (dialog.pickFolder saves it in main); the page never sends a path. Origins, profile names and paths are rendered
// with textContent only.
import { pageApi, type IpcResult } from '../../common/api'
import { h, icon } from '../../common/dom'
import { initSkin } from '../../common/skin-loader'
import { SKINS } from '@shared/skins'
import { SEARCH_ENGINES } from '@shared/search-engines'
import { GROUP_COLORS, type Settings, type SettingsPatch } from '@shared/types'
import './settings.css'

initSkin('page')

const api = pageApi('settings')
let settings: Settings | null = null
const isMac = api.platform === 'mac'

// ---------- small helpers ----------
let uidN = 0
const uid = (p: string): string => `rn-${p}-${++uidN}`

/** A polite "Saved" note that clears itself after 2 s. Errors stay until the next change. */
function savedNote(): { el: HTMLElement; ok(text?: string): void; fail(text: string): void } {
  const el = h('span', { class: 'rn-note rn-st__saved', attrs: { role: 'status' } })
  let t = 0
  return {
    el,
    ok(text = 'Saved') {
      window.clearTimeout(t)
      el.className = 'rn-note rn-note--saved rn-st__saved'
      el.textContent = text
      t = window.setTimeout(() => (el.textContent = ''), 2000)
    },
    fail(text) {
      window.clearTimeout(t)
      el.className = 'rn-note rn-error-text rn-st__saved'
      el.textContent = text
    }
  }
}

async function save(patch: SettingsPatch, note: ReturnType<typeof savedNote>): Promise<boolean> {
  const res = await api.settings.set(patch)
  if (res.ok) {
    settings = res.data
    note.ok()
    return true
  }
  note.fail('Unable to save this setting. Try again.')
  await loadSettings()
  return false
}

function section(id: string, title: string, ...children: Array<Node | null>): HTMLElement {
  const hid = `${id}-title`
  return h('section', { class: 'rn-panel rn-st__section', attrs: { id, 'aria-labelledby': hid } }, h('h2', { attrs: { id: hid }, text: title }), ...children)
}

function profileColor(id: string): string {
  let hash = 5381
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0
  return GROUP_COLORS[hash % GROUP_COLORS.length] ?? 'grey'
}

// ---------- Appearance ----------
const skinNote = savedNote()
const skinInputs = new Map<string, HTMLInputElement>()
const skinCards = h(
  'div',
  { class: 'rn-radio-cards' },
  ...SKINS.map((s) => {
    const input = h('input', { attrs: { type: 'radio', name: 'skin', value: s.id } })
    skinInputs.set(s.id, input)
    input.addEventListener('change', () => {
      if (input.checked) void save({ skin: s.id }, skinNote)
    })
    return h(
      'label',
      { class: 'rn-radio-card' },
      h('img', { attrs: { src: s.preview, alt: '', width: 160, height: 96 } }),
      h('span', { class: 'rn-radio-card__name' }, input, h('span', { text: s.name })),
      h('span', { class: 'rn-radio-card__desc', text: s.description })
    )
  })
)
const motionNote = savedNote()
const motionInput = h('input', { attrs: { type: 'checkbox', id: 'rn-reduced-motion', 'aria-describedby': 'rn-reduced-motion-help' } })
motionInput.addEventListener('change', () => void save({ reducedMotion: motionInput.checked }, motionNote))
const barNote = savedNote()
const barInput = h('input', { attrs: { type: 'checkbox', id: 'rn-bookmark-bar' } })
barInput.addEventListener('change', () => void save({ bookmarkBar: barInput.checked }, barNote))

const appearance = section(
  'appearance',
  'Appearance',
  h('fieldset', { class: 'rn-st__plain' }, h('legend', { class: 'rn-label', text: 'Skin' }), skinCards, skinNote.el),
  h(
    'div',
    { class: 'rn-st__row' },
    h('label', { class: 'rn-check', attrs: { for: motionInput.id } }, motionInput, h('span', {}, h('span', { text: 'Reduce motion (stop the throbber and marquees)' }), h('span', { class: 'rn-help rn-st__help', attrs: { id: 'rn-reduced-motion-help' }, text: 'Also follows your system setting.' }))),
    motionNote.el
  ),
  h(
    'div',
    { class: 'rn-st__row' },
    h('label', { class: 'rn-check', attrs: { for: barInput.id } }, barInput, h('span', { text: `Show the bookmarks bar (${isMac ? '⌘⇧B' : 'Ctrl+Shift+B'})` })),
    barNote.el
  )
)

// ---------- Search ----------
const searchNote = savedNote()
const searchSelect = h('select', { class: 'rn-input rn-st__select', attrs: { id: 'rn-search-engine' } }, ...SEARCH_ENGINES.map((e) => h('option', { attrs: { value: e.id }, text: e.name })))
searchSelect.addEventListener('change', () => void save({ searchEngine: searchSelect.value as Settings['searchEngine'] }, searchNote))
const search = section(
  'search',
  'Search',
  h('div', { class: 'rn-field' }, h('label', { attrs: { for: searchSelect.id }, text: 'Search engine used in the address bar' }), h('div', { class: 'rn-st__inline' }, searchSelect, searchNote.el))
)

// ---------- Home & startup ----------
const NEWTAB = 'retronet://newtab/'
const homeNote = savedNote()
const homeNew = h('input', { attrs: { type: 'radio', name: 'home', value: 'newtab', id: 'rn-home-newtab' } })
const homeCustom = h('input', { attrs: { type: 'radio', name: 'home', value: 'custom', id: 'rn-home-custom' } })
const homeUrl = h('input', {
  class: 'rn-input rn-st__url',
  attrs: { type: 'url', id: 'rn-home-url', inputmode: 'url', autocomplete: 'url', spellcheck: 'false', placeholder: 'https://example.org', 'aria-label': 'Custom home page address' }
})
const homeErr = h('p', { class: 'rn-error-text rn-st__err', attrs: { id: 'rn-home-url-err' } })

/** A hostname a person could mean: dotted labels, localhost, or an IP literal. */
function validHost(host: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true
  if (host === 'localhost') return true
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/i.test(host)
}

function normalizeHome(raw: string): string | null {
  const v = raw.trim()
  // Chromium's URL parser escapes spaces in hosts ("not a url" -> https://not%20a%20url/), so check by hand.
  if (!v || /\s/.test(v)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`
  try {
    const u = new URL(withScheme)
    if (!['http:', 'https:', 'retronet:'].includes(u.protocol)) return null
    if (u.protocol !== 'retronet:' && !validHost(u.hostname)) return null
    return u.href
  } catch {
    return null
  }
}
function setHomeErr(msg: string): void {
  homeErr.textContent = msg
  if (msg) {
    homeUrl.setAttribute('aria-invalid', 'true')
    homeUrl.setAttribute('aria-describedby', homeErr.id)
  } else {
    homeUrl.removeAttribute('aria-invalid')
    homeUrl.removeAttribute('aria-describedby')
  }
}
async function saveHomeUrl(): Promise<void> {
  if (!homeCustom.checked) return
  const v = normalizeHome(homeUrl.value)
  if (!v) {
    setHomeErr(homeUrl.value.trim() ? 'Enter a full address, like https://example.org' : 'Enter the address the Home button should open.')
    return
  }
  setHomeErr('')
  if (v === settings?.homePage) return
  homeUrl.value = v
  if (await save({ homePage: v }, homeNote)) homeDraftCustom = false
}
/** The user picked "Custom address" but hasn't saved a valid one yet: re-renders must not undo that choice. */
let homeDraftCustom = false
homeNew.addEventListener('change', () => {
  homeDraftCustom = false
  homeUrl.disabled = true
  setHomeErr('')
  void save({ homePage: NEWTAB }, homeNote)
})
homeCustom.addEventListener('change', () => {
  homeDraftCustom = true
  homeUrl.disabled = false
  homeUrl.focus()
  if (homeUrl.value.trim()) void saveHomeUrl()
})
homeUrl.addEventListener('blur', () => void saveHomeUrl())
homeUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void saveHomeUrl()
  }
})

const startNote = savedNote()
const startRestore = h('input', { attrs: { type: 'radio', name: 'startup', value: 'restore', id: 'rn-start-restore' } })
const startNew = h('input', { attrs: { type: 'radio', name: 'startup', value: 'newtab', id: 'rn-start-newtab' } })
for (const r of [startRestore, startNew]) r.addEventListener('change', () => r.checked && void save({ startup: r.value as Settings['startup'] }, startNote))

const homeStartup = section(
  'home',
  'Home & startup',
  h(
    'fieldset',
    { class: 'rn-fieldset' },
    h('legend', { text: 'Home page' }),
    h('label', { class: 'rn-check', attrs: { for: homeNew.id } }, homeNew, h('span', { text: 'New tab page' })),
    h('label', { class: 'rn-check', attrs: { for: homeCustom.id } }, homeCustom, h('span', { text: 'Custom address' })),
    h('div', { class: 'rn-st__indent' }, homeUrl, homeErr),
    homeNote.el
  ),
  h(
    'fieldset',
    { class: 'rn-fieldset' },
    h('legend', { text: 'On startup' }),
    h('label', { class: 'rn-check', attrs: { for: startRestore.id } }, startRestore, h('span', { text: 'Continue where you left off' })),
    h('label', { class: 'rn-check', attrs: { for: startNew.id } }, startNew, h('span', { text: 'Open the new tab page' })),
    startNote.el
  )
)

// ---------- Downloads ----------
const dlNote = savedNote()
const dlPath = h('code', { class: 'rn-st__path' })
const dlChange = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Change…' })
const dlReset = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Use default folder' })
dlChange.addEventListener('click', async () => {
  dlChange.disabled = true
  const res = await api.dialog.pickFolder()
  dlChange.disabled = false
  if (!res.ok) dlNote.fail('Unable to use that folder. Choose another one.')
  else if (res.data.path) {
    await loadSettings()
    dlNote.ok()
  }
  dlChange.focus()
})
dlReset.addEventListener('click', async () => {
  if (await save({ downloadsDir: null }, dlNote)) {
    renderDownloads()
    dlChange.focus()
  }
})
function middle(path: string, max = 64): string {
  if (path.length <= max) return path
  const tail = Math.floor(max / 2) - 1
  return `${path.slice(0, max - tail - 1)}…${path.slice(-tail)}`
}
function renderDownloads(): void {
  const dir = settings?.downloadsDir ?? null
  dlPath.textContent = dir ? middle(dir) : 'Downloads (your system’s default folder)'
  dlPath.title = dir ?? ''
  dlReset.hidden = !dir
}
const downloads = section(
  'downloads',
  'Downloads',
  h('p', { class: 'rn-label rn-st__label', attrs: { id: 'rn-dl-label' }, text: 'Save files to' }),
  h('div', { class: 'rn-st__inline rn-st__inline--wrap' }, h('span', { class: 'rn-st__pathbox', attrs: { 'aria-labelledby': 'rn-dl-label', role: 'group' } }, dlPath), dlChange, dlReset, dlNote.el)
)
dlChange.setAttribute('aria-describedby', 'rn-dl-label')

// ---------- Privacy ----------
const clearNote = savedNote()
const clearErr = h('p', { class: 'rn-error-text rn-st__err', attrs: { id: 'rn-clear-err' } })
const clearKinds = [
  { key: 'history', label: 'Browsing history', checked: true },
  { key: 'downloads', label: 'Downloads list (files stay on disk)', checked: true },
  { key: 'cookies', label: 'Cookies and site data (signs you out of most sites)', checked: false },
  { key: 'cache', label: 'Cached images and files', checked: false }
] as const
const clearInputs = new Map<string, HTMLInputElement>()
const clearChecks = clearKinds.map((k) => {
  const input = h('input', { attrs: { type: 'checkbox', id: `rn-clear-${k.key}`, checked: k.checked } })
  clearInputs.set(k.key, input)
  return h('label', { class: 'rn-check', attrs: { for: input.id } }, input, h('span', { text: k.label }))
})
const rangeSelect = h(
  'select',
  { class: 'rn-input rn-st__select', attrs: { id: 'rn-clear-range', 'aria-describedby': 'rn-clear-range-note' } },
  h('option', { attrs: { value: 'hour' }, text: 'Last hour' }),
  h('option', { attrs: { value: 'day' }, text: 'Last 24 hours' }),
  h('option', { attrs: { value: 'week' }, text: 'Last 7 days' }),
  h('option', { attrs: { value: 'all', selected: true }, text: 'All time' })
)
const clearBtn = h('button', { class: 'rn-btn rn-btn--danger', attrs: { type: 'submit' }, text: 'Clear data' })
const clearForm = h(
  'form',
  { class: 'rn-st__clear', attrs: { 'aria-labelledby': 'rn-clear-title', novalidate: true } },
  h('h3', { attrs: { id: 'rn-clear-title' }, text: 'Clear browsing data' }),
  h('fieldset', { class: 'rn-st__plain', attrs: { 'aria-describedby': 'rn-clear-err' } }, h('legend', { class: 'rn-label', text: 'What to clear' }), ...clearChecks),
  clearErr,
  h('div', { class: 'rn-field rn-st__range' }, h('label', { attrs: { for: rangeSelect.id }, text: 'Time range' }), rangeSelect),
  h('p', { class: 'rn-help', attrs: { id: 'rn-clear-range-note' }, text: 'The time range applies to history and the downloads list. Cookies, site data and cached files are always cleared for all time.' }),
  h('div', { class: 'rn-st__inline' }, clearBtn, clearNote.el)
)
clearForm.addEventListener('change', () => (clearErr.textContent = ''))
clearForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const pick = (k: string): boolean => clearInputs.get(k)?.checked ?? false
  const req = { history: pick('history'), downloads: pick('downloads'), cookies: pick('cookies'), cache: pick('cache'), range: rangeSelect.value as 'hour' | 'day' | 'week' | 'all' }
  if (!req.history && !req.downloads && !req.cookies && !req.cache) {
    clearErr.textContent = 'Choose at least one kind of data to clear.'
    clearInputs.get('history')?.focus()
    return
  }
  clearBtn.disabled = true
  clearBtn.textContent = 'Clearing...'
  const res = await api.data.clear(req)
  clearBtn.disabled = false
  clearBtn.textContent = 'Clear data'
  if (res.ok) clearNote.ok('Cleared.')
  else clearNote.fail('Unable to clear everything. Try again.')
})
const privacy = section('privacy', 'Privacy', clearForm)

// ---------- Site permissions ----------
const KIND_LABEL: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Read clipboard'
}
const permNote = savedNote()
const permBody = h('div', { class: 'rn-st__perms' })
async function loadPermissions(focusAfter?: number): Promise<void> {
  const res = await api.permissions.list()
  if (!res.ok) {
    const retry = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Try again' })
    retry.addEventListener('click', () => void loadPermissions())
    permBody.replaceChildren(h('div', { class: 'rn-empty' }, h('p', { text: "Couldn't read site permissions." }), retry))
    return
  }
  const items = [...res.data.items].sort((a, b) => a.origin.localeCompare(b.origin) || a.kind.localeCompare(b.kind))
  if (!items.length) {
    permBody.replaceChildren(h('p', { class: 'rn-empty rn-st__empty', text: 'No site has asked for permissions yet.' }))
    return
  }
  const rows = items.map((p, i) => {
    const reset = h('button', { class: 'rn-btn', attrs: { type: 'button', 'aria-label': `Reset ${KIND_LABEL[p.kind] ?? p.kind} for ${p.origin}` }, text: 'Reset' })
    reset.addEventListener('click', async () => {
      const r = await api.permissions.reset({ origin: p.origin, kind: p.kind })
      if (r.ok) permNote.ok(`Reset. ${p.origin} will ask again next time.`)
      else permNote.fail('Unable to reset. Try again.')
      await loadPermissions(i)
    })
    const allowed = p.decision === 'allow'
    return h(
      'tr',
      {},
      h('td', { class: 'rn-st__origin', text: p.origin, attrs: { title: p.origin } }),
      h('td', { text: KIND_LABEL[p.kind] ?? p.kind }),
      h('td', {}, h('span', { class: ['rn-st__decision', allowed ? 'rn-st__decision--allow' : 'rn-st__decision--block'], text: allowed ? 'Allowed' : 'Blocked' })),
      h('td', { class: 'rn-table__actions' }, reset)
    )
  })
  const table = h(
    'table',
    { class: 'rn-table' },
    h('caption', { class: 'rn-sr-only', text: 'Remembered site permissions' }),
    h('thead', {}, h('tr', {}, ...['Site', 'Permission', 'Decision'].map((t) => h('th', { attrs: { scope: 'col' }, text: t })), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'rn-sr-only', text: 'Actions' })))),
    h('tbody', {}, ...rows)
  )
  permBody.replaceChildren(table)
  if (focusAfter !== undefined) {
    const btns = table.querySelectorAll<HTMLButtonElement>('tbody .rn-btn')
    ;(btns[Math.min(focusAfter, btns.length - 1)] ?? null)?.focus()
  }
}
const permissions = section(
  'permissions',
  'Site permissions',
  h('p', { class: 'rn-help', text: 'Sites you allowed or blocked for camera, microphone, location, notifications or clipboard reading. Reset a row and the site asks again next time.' }),
  permBody,
  permNote.el
)

// ---------- Profiles ----------
const profNote = savedNote()
const profList = h('ul', { class: 'rn-st__profiles' })
let renamingId: string | null = null
let adding = false

function nameForm(opts: { label: string; value: string; submit: string; onSubmit(name: string): Promise<IpcResult<unknown>>; onCancel(): void }): HTMLFormElement {
  const id = uid('pname')
  const input = h('input', { class: 'rn-input', attrs: { id, type: 'text', maxlength: 64, autocomplete: 'off', value: opts.value } })
  const err = h('p', { class: 'rn-error-text rn-st__err', attrs: { id: `${id}-err` } })
  const ok = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: opts.submit })
  const cancel = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Cancel' })
  const form = h('form', { class: 'rn-st__nameform', attrs: { novalidate: true } }, h('div', { class: 'rn-field' }, h('label', { attrs: { for: id }, text: opts.label }), input, err), h('div', { class: 'rn-st__inline' }, ok, cancel))
  const setErr = (m: string): void => {
    err.textContent = m
    if (m) {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-describedby', err.id)
    } else input.removeAttribute('aria-invalid')
  }
  cancel.addEventListener('click', () => opts.onCancel())
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      opts.onCancel()
    }
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = input.value.trim()
    if (!name) {
      setErr('Enter a name for the profile.')
      input.focus()
      return
    }
    ok.disabled = true
    const res = await opts.onSubmit(name)
    ok.disabled = false
    if (!res.ok) {
      setErr(res.code === 'E_INVALID' ? 'Use up to 64 letters, numbers or spaces.' : 'Unable to save. Try again.')
      input.focus()
    }
  })
  queueMicrotask(() => {
    input.focus()
    input.select()
  })
  return form
}

const addProfileBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('profile'), h('span', { class: 'rn-btn__label', text: 'Add profile' }))
addProfileBtn.addEventListener('click', () => {
  adding = true
  renamingId = null
  void loadProfiles()
})
const addSlot = h('div', { class: 'rn-st__addslot' })

async function loadProfiles(focus?: { id: string; label: string } | 'add'): Promise<void> {
  const res = await api.profiles.list()
  if (!res.ok) {
    profList.replaceChildren(h('li', { class: 'rn-empty', text: "Couldn't read the profile list." }))
    return
  }
  const { profiles, currentId } = res.data
  const only = profiles.length <= 1
  profList.replaceChildren(
    ...profiles.map((p) => {
      const dot = h('span', { class: 'rn-st__dot', data: { color: profileColor(p.id) }, attrs: { 'aria-hidden': 'true' } })
      const name = h('span', { class: 'rn-st__pname', text: p.name })
      const li = h('li', { class: 'rn-st__profile', data: { id: p.id } }, dot, name)
      if (p.id === currentId) li.append(h('span', { class: 'rn-muted', text: '(this window)' }))
      if (renamingId === p.id) {
        li.classList.add('rn-st__profile--editing')
        li.append(
          nameForm({
            label: `New name for ${p.name}`,
            value: p.name,
            submit: 'Rename',
            onSubmit: async (n) => {
              const r = await api.profiles.rename({ id: p.id, name: n })
              if (r.ok) {
                renamingId = null
                profNote.ok('Renamed.')
                await loadProfiles({ id: p.id, label: 'Rename' })
              }
              return r
            },
            onCancel: () => {
              renamingId = null
              void loadProfiles({ id: p.id, label: 'Rename' })
            }
          })
        )
        return li
      }
      const rename = h('button', { class: 'rn-btn', attrs: { type: 'button', 'aria-label': `Rename ${p.name}` }, text: 'Rename' })
      rename.addEventListener('click', () => {
        renamingId = p.id
        adding = false
        void loadProfiles()
      })
      const del = h('button', { class: 'rn-btn rn-btn--danger', attrs: { type: 'button', 'aria-label': `Delete ${p.name}…` }, text: 'Delete…' })
      if (only) {
        del.disabled = true
        del.title = 'You need at least one profile.'
      }
      del.addEventListener('click', async () => {
        // Main shows the confirmation (it names the profile and says its data is erased from disk).
        const r = await api.profiles.delete({ id: p.id })
        if (!r.ok) profNote.fail(r.code === 'E_INVALID' ? 'You need at least one profile.' : 'Unable to delete this profile. Try again.')
        else if (r.data.deleted) profNote.ok(`Deleted ${p.name}.`)
        await loadProfiles(r.ok && r.data.deleted ? 'add' : { id: p.id, label: 'Delete…' })
      })
      li.append(h('span', { class: 'rn-st__pactions' }, rename, del))
      return li
    })
  )
  addSlot.replaceChildren(
    adding
      ? nameForm({
          label: 'Profile name',
          value: '',
          submit: 'Add profile',
          onSubmit: async (n) => {
            const r = await api.profiles.create({ name: n })
            if (r.ok) {
              adding = false
              profNote.ok(`Added ${r.data.name}. Open it from the profile menu.`)
              await loadProfiles('add')
            }
            return r
          },
          onCancel: () => {
            adding = false
            void loadProfiles('add')
          }
        })
      : addProfileBtn
  )
  if (focus === 'add') addProfileBtn.focus()
  else if (focus) {
    const btn = [...profList.querySelectorAll<HTMLButtonElement>(`li[data-id="${CSS.escape(focus.id)}"] button`)].find((b) => b.textContent === focus.label && !b.disabled)
    ;(btn ?? addProfileBtn).focus()
  }
}
const profilesSec = section(
  'profiles',
  'Profiles',
  h('p', { class: 'rn-help', text: 'Each profile keeps its own history, bookmarks, cookies, settings and permissions. Switch profiles from the profile button in the toolbar.' }),
  profList,
  addSlot,
  profNote.el
)

// ---------- Shortcuts ----------
const shortcuts = section('shortcuts', 'Shortcuts', h('p', {}, h('a', { attrs: { href: 'retronet://shortcuts/' }, text: 'See every keyboard shortcut' })))

// ---------- frame + nav ----------
const SECTIONS: Array<[string, string]> = [
  ['appearance', 'Appearance'],
  ['search', 'Search'],
  ['home', 'Home & startup'],
  ['downloads', 'Downloads'],
  ['privacy', 'Privacy'],
  ['permissions', 'Site permissions'],
  ['profiles', 'Profiles'],
  ['shortcuts', 'Shortcuts']
]
const navLinks = SECTIONS.map(([id, label]) => h('a', { attrs: { href: `#${id}` }, data: { section: id }, text: label }))
const nav = h('nav', { class: 'rn-settings__nav', attrs: { 'aria-label': 'Settings sections' } }, ...navLinks)
const content = h('div', { class: 'rn-settings__content', attrs: { id: 'rn-settings-content', tabindex: -1 } }, appearance, search, homeStartup, downloads, privacy, permissions, profilesSec, shortcuts)
const skip = h('a', { class: 'rn-skip rn-btn', attrs: { href: '#rn-settings-content' }, text: 'Skip to settings content' })
skip.addEventListener('click', (e) => {
  e.preventDefault()
  content.focus()
})
const main = h('main', { class: 'rn-page rn-page--wide' }, h('h1', { text: 'Settings' }), h('div', { class: 'rn-settings' }, nav, content))
const app = document.getElementById('app')
app?.replaceWith(skip, main)

function setCurrent(id: string): void {
  for (const a of navLinks) {
    if (a.dataset.section === id) a.setAttribute('aria-current', 'true')
    else a.removeAttribute('aria-current')
  }
}
for (const a of navLinks) {
  a.addEventListener('click', (e) => {
    e.preventDefault()
    const id = a.dataset.section ?? ''
    const target = document.getElementById(id)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    const head = target.querySelector<HTMLElement>('h2')
    head?.setAttribute('tabindex', '-1')
    head?.focus({ preventScroll: true })
    setCurrent(id)
    history.replaceState(null, '', `#${id}`)
  })
}
// Mark the section nearest the top of the viewport as current.
function trackSection(): void {
  let best = SECTIONS[0]?.[0] ?? ''
  for (const [id] of SECTIONS) {
    const el = document.getElementById(id)
    if (el && el.getBoundingClientRect().top <= 96) best = id
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) best = SECTIONS[SECTIONS.length - 1]?.[0] ?? best
  setCurrent(best)
}
let ticking = false
window.addEventListener(
  'scroll',
  () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      ticking = false
      trackSection()
    })
  },
  { passive: true }
)

// ---------- state ----------
function render(): void {
  if (!settings) return
  for (const [id, input] of skinInputs) input.checked = id === settings.skin
  motionInput.checked = settings.reducedMotion
  barInput.checked = settings.bookmarkBar
  searchSelect.value = settings.searchEngine
  const isNew = settings.homePage === NEWTAB && !homeDraftCustom
  homeNew.checked = isNew
  homeCustom.checked = !isNew
  homeUrl.disabled = isNew
  if (!isNew && document.activeElement !== homeUrl) homeUrl.value = settings.homePage
  startRestore.checked = settings.startup === 'restore'
  startNew.checked = settings.startup === 'newtab'
  renderDownloads()
}

async function loadSettings(): Promise<void> {
  const res = await api.settings.get()
  if (res.ok) {
    settings = res.data
    render()
  }
}

// Skin / reduced-motion changes from elsewhere (palette, another settings tab) keep the radios honest.
api.on('skin', () => void loadSettings())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  void loadSettings()
  void loadPermissions()
  if (!renamingId && !adding) void loadProfiles()
})

void (async () => {
  await loadSettings()
  await Promise.all([loadPermissions(), loadProfiles()])
  const hash = location.hash.slice(1)
  if (hash && document.getElementById(hash)) {
    document.getElementById(hash)?.scrollIntoView({ block: 'start' })
    setCurrent(hash)
  } else trackSection()
})()
