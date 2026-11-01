// retronet://bookmarks (T22, DESIGN 5.3, AC16). Folder tree (APG tree pattern, roving tabindex) on the left, the
// selected folder's contents in a table on the right. Add / edit / move happen in an inline row form; deleting a
// bookmark is immediate with a 5 s Undo, deleting a non-empty folder asks first. Titles and URLs are rendered with
// textContent / attributes only.
import { pageApi } from '../../common/api'
import { h, icon } from '../../common/dom'
import { initSkin } from '../../common/skin-loader'
import type { BookmarkNode, BookmarkTree } from '@shared/types'
import './bookmarks.css'

initSkin('page')

type Folder = Extract<BookmarkNode, { kind: 'folder' }>
type Bookmark = Extract<BookmarkNode, { kind: 'bookmark' }>

const BAR = 'bar'
const OTHER = 'other'
const ROOT_NAMES: Record<string, string> = { [BAR]: 'Bookmarks bar', [OTHER]: 'Other bookmarks' }

const api = pageApi('bookmarks')

let tree: BookmarkTree | null = null
let selectedId = BAR
const expanded = new Set<string>([BAR, OTHER])
/** Row being edited: a node id, 'new-bookmark' or 'new-folder'. */
let editing: string | null = null
/** Folder awaiting delete confirmation. */
let confirming: string | null = null

// ---------- tree helpers ----------
function roots(): Folder[] {
  return tree ? [tree.bar, tree.other] : []
}
function folderName(f: Folder): string {
  return ROOT_NAMES[f.id] ?? (f.title || 'Untitled folder')
}
function findNode(id: string, from: Folder[] = roots()): { node: BookmarkNode; parent: Folder | null; index: number } | null {
  for (const r of from) {
    if (r.id === id) return { node: r, parent: null, index: 0 }
    const stack: Folder[] = [r]
    while (stack.length) {
      const f = stack.pop() as Folder
      for (let i = 0; i < f.children.length; i++) {
        const c = f.children[i] as BookmarkNode
        if (c.id === id) return { node: c, parent: f, index: i }
        if (c.kind === 'folder') stack.push(c)
      }
    }
  }
  return null
}
function selectedFolder(): Folder | null {
  const hit = findNode(selectedId)
  return hit && hit.node.kind === 'folder' ? hit.node : null
}
function subfolders(f: Folder): Folder[] {
  return f.children.filter((c): c is Folder => c.kind === 'folder')
}
function countItems(f: Folder): number {
  let n = 0
  for (const c of f.children) n += c.kind === 'folder' ? 1 + countItems(c) : 1
  return n
}
function isInside(folderId: string, ancestor: Folder): boolean {
  if (ancestor.id === folderId) return true
  return subfolders(ancestor).some((s) => isInside(folderId, s))
}
/** Every folder, depth-first, for the Folder select (excluding `skip` and its descendants). */
function allFolders(skip?: string): Array<{ folder: Folder; depth: number }> {
  const out: Array<{ folder: Folder; depth: number }> = []
  const walk = (f: Folder, depth: number): void => {
    if (f.id === skip) return
    out.push({ folder: f, depth })
    for (const s of subfolders(f)) walk(s, depth + 1)
  }
  for (const r of roots()) walk(r, 0)
  return out
}
function pathTo(id: string): Folder[] {
  const out: Folder[] = []
  const walk = (f: Folder): boolean => {
    out.push(f)
    if (f.id === id) return true
    for (const s of subfolders(f)) if (walk(s)) return true
    out.pop()
    return false
  }
  for (const r of roots()) if (walk(r)) break
  return out
}

// ---------- page frame ----------
const status = h('p', { class: 'rn-note rn-bm__status', attrs: { role: 'status' } })
const addBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('bookmark'), h('span', { class: 'rn-btn__label', text: 'Add bookmark' }))
const folderBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' } }, icon('folder'), h('span', { class: 'rn-btn__label', text: 'New folder' }))
const treeEl = h('ul', { class: 'rn-tree', attrs: { role: 'tree', 'aria-label': 'Bookmark folders' } })
const folderPicker = h('select', { class: 'rn-input rn-bm__picker', attrs: { 'aria-label': 'Folder' } })
const heading = h('h2', { class: 'rn-bm__heading', attrs: { id: 'rn-bm-folder' } })
const tableWrap = h('div', { class: 'rn-bm__content' })
const loading = h('p', { class: 'rn-loading', text: 'Opening bookmarks...' })

addBtn.addEventListener('click', () => startEdit('new-bookmark'))
folderBtn.addEventListener('click', () => startEdit('new-folder'))
folderPicker.addEventListener('change', () => select(folderPicker.value, false))

const main = h(
  'main',
  { class: 'rn-page rn-page--wide' },
  h('div', { class: 'rn-page__header' }, h('h1', { text: 'Bookmarks' }), h('div', { class: 'rn-page__actions' }, addBtn, folderBtn)),
  status,
  loading,
  h(
    'div',
    { class: 'rn-bookmarks' },
    h('nav', { class: 'rn-bm__nav', attrs: { 'aria-label': 'Folders' } }, treeEl, folderPicker),
    h('section', { class: 'rn-bm__main', attrs: { 'aria-labelledby': 'rn-bm-folder' } }, heading, tableWrap)
  )
)
document.getElementById('app')?.replaceWith(main)

let statusTimer = 0
function say(content: string | Node[], ms = 5000): void {
  window.clearTimeout(statusTimer)
  if (typeof content === 'string') status.textContent = content
  else status.replaceChildren(...content)
  statusTimer = window.setTimeout(() => status.replaceChildren(), ms)
}

// ---------- tree ----------
function visibleTreeItems(): HTMLElement[] {
  return [...treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((el) => !el.closest('[role="group"][hidden]'))
}

function renderTree(): void {
  const hadFocus = treeEl.contains(document.activeElement)
  const build = (f: Folder, level: number): HTMLElement => {
    const subs = subfolders(f)
    const isOpen = expanded.has(f.id)
    const twisty = h('span', { class: 'rn-tree__twisty', attrs: { 'aria-hidden': 'true' } })
    const li = h(
      'li',
      {
        attrs: {
          role: 'treeitem',
          'aria-level': level,
          'aria-selected': f.id === selectedId ? 'true' : 'false',
          'aria-expanded': subs.length ? (isOpen ? 'true' : 'false') : null,
          tabindex: f.id === selectedId ? 0 : -1
        },
        data: { id: f.id }
      },
      h('span', { class: 'rn-tree__row' }, twisty, icon('folder'), h('span', { class: 'rn-tree__label', text: folderName(f) }))
    )
    twisty.addEventListener('click', (e) => {
      e.stopPropagation()
      toggle(f.id)
    })
    li.addEventListener('click', (e) => {
      e.stopPropagation()
      select(f.id, true)
    })
    if (subs.length) {
      const group = h('ul', { attrs: { role: 'group' } }, ...subs.map((s) => build(s, level + 1)))
      group.hidden = !isOpen
      li.append(group)
    }
    return li
  }
  treeEl.replaceChildren(...roots().map((r) => build(r, 1)))
  if (hadFocus) treeEl.querySelector<HTMLElement>('[tabindex="0"]')?.focus()

  folderPicker.replaceChildren(
    ...allFolders().map(({ folder, depth }) => h('option', { attrs: { value: folder.id, selected: folder.id === selectedId }, text: `${' '.repeat(depth)}${folderName(folder)}` }))
  )
}

function toggle(id: string, open?: boolean): void {
  const want = open ?? !expanded.has(id)
  if (want) expanded.add(id)
  else expanded.delete(id)
  renderTree()
}

function select(id: string, focusTree: boolean): void {
  if (!findNode(id)) return
  selectedId = id
  editing = null
  confirming = null
  for (const f of pathTo(id).slice(0, -1)) expanded.add(f.id)
  renderTree()
  renderTable()
  if (focusTree) treeEl.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
}

treeEl.addEventListener('keydown', (e) => {
  const items = visibleTreeItems()
  const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]')
  if (!current) return
  const i = items.indexOf(current)
  const id = current.dataset.id ?? ''
  const go = (el: HTMLElement | undefined): void => {
    if (el?.dataset.id) select(el.dataset.id, true)
  }
  switch (e.key) {
    case 'ArrowDown':
      go(items[i + 1])
      break
    case 'ArrowUp':
      go(items[i - 1])
      break
    case 'Home':
      go(items[0])
      break
    case 'End':
      go(items[items.length - 1])
      break
    case 'ArrowRight':
      if (current.getAttribute('aria-expanded') === 'false') toggle(id, true)
      else if (current.getAttribute('aria-expanded') === 'true') go(current.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined)
      break
    case 'ArrowLeft':
      if (current.getAttribute('aria-expanded') === 'true') toggle(id, false)
      else go(current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined)
      break
    case 'Enter':
    case ' ':
      // Selection follows focus; Enter moves into the folder's contents.
      tableWrap.querySelector<HTMLElement>('a, button')?.focus()
      break
    default:
      return
  }
  e.preventDefault()
})

// ---------- table ----------
function favicon(b: Bookmark): HTMLElement {
  if (b.faviconDataUrl && b.faviconDataUrl.startsWith('data:image/')) {
    return h('img', { class: 'rn-bm__favicon', attrs: { src: b.faviconDataUrl, alt: '', width: 16, height: 16 } })
  }
  return icon('page')
}

function actionBtn(label: string, aria: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = h('button', { class: ['rn-btn', danger && 'rn-btn--danger'], attrs: { type: 'button', 'aria-label': aria }, text: label })
  b.addEventListener('click', onClick)
  return b
}

function nodeRow(n: BookmarkNode): HTMLTableRowElement {
  if (editing === n.id) return formRow(n)
  const tr = h('tr', { data: { id: n.id } })
  if (n.kind === 'folder') {
    const open = h('button', { class: 'rn-bm__folder-link', attrs: { type: 'button' } }, icon('folder'), h('span', { text: n.title || 'Untitled folder' }))
    open.addEventListener('click', () => select(n.id, false))
    const count = countItems(n)
    tr.append(
      h('td', { class: 'rn-bm__name' }, open),
      h('td', { class: 'rn-table__url', text: count === 1 ? '1 item' : `${count} items` })
    )
    const actions = h('td', { class: 'rn-table__actions' })
    if (confirming === n.id) {
      actions.append(
        h('span', { class: 'rn-bm__confirm', attrs: { id: `rn-confirm-${n.id}` }, text: `Delete it and its ${count === 1 ? 'item' : `${count} items`}?` }),
        actionBtn('Delete folder', `Delete folder ${n.title} and everything in it`, () => void removeNode(n), true),
        actionBtn('Cancel', 'Cancel delete', () => {
          confirming = null
          renderTable(n.id)
        })
      )
    } else {
      actions.append(
        actionBtn('Rename', `Rename folder ${n.title}`, () => startEdit(n.id)),
        actionBtn('Delete', `Delete folder ${n.title}`, () => {
          if (n.children.length === 0) void removeNode(n)
          else {
            confirming = n.id
            renderTable(n.id, 'Cancel')
          }
        })
      )
    }
    tr.append(actions)
    return tr
  }
  const link = h('a', { attrs: { href: n.url, title: n.title || n.url } }, favicon(n), h('span', { text: n.title || n.url }))
  tr.append(
    h('td', { class: 'rn-bm__name' }, link),
    h('td', { class: 'rn-table__url', text: n.url, attrs: { title: n.url } }),
    h(
      'td',
      { class: 'rn-table__actions' },
      actionBtn('Edit', `Edit ${n.title || n.url}`, () => startEdit(n.id)),
      actionBtn('Delete', `Delete ${n.title || n.url}`, () => void removeNode(n))
    )
  )
  return tr
}

/** A hostname a person could mean: dotted labels, localhost, or an IP literal. */
function validHost(host: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true
  if (host === 'localhost') return true
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/i.test(host)
}

/** Accepts "example.org" as https://example.org; returns null when it can't be a bookmark address. */
function normalizeUrl(raw: string): string | null {
  const v = raw.trim()
  // Chromium's URL parser escapes spaces in hosts ("not a url" -> https://not%20a%20url/), so check by hand.
  if (!v || /\s/.test(v)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`
  try {
    const u = new URL(withScheme)
    if (!['http:', 'https:', 'retronet:', 'file:'].includes(u.protocol)) return null
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !validHost(u.hostname)) return null
    return u.href
  } catch {
    return null
  }
}

function formRow(n: BookmarkNode | null): HTMLTableRowElement {
  const isFolder = editing === 'new-folder' || n?.kind === 'folder'
  const isNew = !n
  const uid = n?.id ?? editing ?? 'new'
  const nameInput = h('input', { class: 'rn-input', attrs: { id: `rn-f-name-${uid}`, type: 'text', autocomplete: 'off', maxlength: isFolder ? 64 : 1024, value: n?.title ?? '' } })
  const nameErr = h('p', { class: 'rn-error-text rn-bm__err', attrs: { id: `rn-f-name-err-${uid}` } })
  const fields: HTMLElement[] = [
    h('div', { class: 'rn-field' }, h('label', { attrs: { for: nameInput.id }, text: isFolder ? 'Folder name' : 'Name' }), nameInput, nameErr)
  ]
  let urlInput: HTMLInputElement | null = null
  let urlErr: HTMLElement | null = null
  if (!isFolder) {
    urlInput = h('input', {
      class: 'rn-input',
      attrs: { id: `rn-f-url-${uid}`, type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://example.org', value: n?.kind === 'bookmark' ? n.url : '' }
    })
    urlErr = h('p', { class: 'rn-error-text rn-bm__err', attrs: { id: `rn-f-url-err-${uid}` } })
    fields.push(h('div', { class: 'rn-field' }, h('label', { attrs: { for: urlInput.id }, text: 'Address' }), urlInput, urlErr))
  }
  const currentParent = n ? (findNode(n.id)?.parent?.id ?? selectedId) : selectedId
  const parentSelect = h('select', { class: 'rn-input', attrs: { id: `rn-f-parent-${uid}` } })
  for (const { folder, depth } of allFolders(n?.kind === 'folder' ? n.id : undefined)) {
    parentSelect.append(h('option', { attrs: { value: folder.id, selected: folder.id === currentParent }, text: `${' '.repeat(depth)}${folderName(folder)}` }))
  }
  fields.push(h('div', { class: 'rn-field' }, h('label', { attrs: { for: parentSelect.id }, text: 'Folder' }), parentSelect))

  const save = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'submit' }, text: isNew ? (isFolder ? 'Create folder' : 'Add bookmark') : 'Save' })
  const cancel = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Cancel' })
  const formErr = h('p', { class: 'rn-error-text rn-bm__err', attrs: { role: 'alert' } })
  const form = h('form', { class: 'rn-bm__form', attrs: { 'aria-label': isNew ? (isFolder ? 'New folder' : 'Add bookmark') : `Edit ${n?.title ?? ''}`, novalidate: true } }, ...fields, formErr, h('div', { class: 'rn-bm__form-actions' }, save, cancel))

  const setErr = (input: HTMLInputElement, el: HTMLElement, msg: string): void => {
    el.textContent = msg
    if (msg) {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-describedby', el.id)
    } else {
      input.removeAttribute('aria-invalid')
      input.removeAttribute('aria-describedby')
    }
  }
  const close = (focusId?: string): void => {
    editing = null
    renderTable(focusId ?? n?.id, n ? 'Edit' : undefined)
    if (!n) (isFolder ? folderBtn : addBtn).focus()
  }
  cancel.addEventListener('click', () => close())
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })
  urlInput?.addEventListener('blur', () => {
    if (urlInput && urlErr && urlInput.value.trim() && !normalizeUrl(urlInput.value)) setErr(urlInput, urlErr, 'Enter a full address, like https://example.org')
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    formErr.textContent = ''
    const title = nameInput.value.trim()
    let url: string | null = null
    let firstBad: HTMLInputElement | null = null
    if (isFolder && !title) {
      setErr(nameInput, nameErr, 'Give the folder a name.')
      firstBad = nameInput
    } else setErr(nameInput, nameErr, '')
    if (urlInput && urlErr) {
      url = normalizeUrl(urlInput.value)
      if (!url) {
        setErr(urlInput, urlErr, urlInput.value.trim() ? 'Enter a full address, like https://example.org' : 'Enter the address to bookmark.')
        firstBad ??= urlInput
      } else setErr(urlInput, urlErr, '')
    }
    if (firstBad) {
      firstBad.focus()
      return
    }
    save.disabled = true
    const parentId = parentSelect.value
    let ok = true
    let newId: string | undefined
    if (isNew && isFolder) {
      const r = await api.bookmarks.addFolder({ parentId, title })
      ok = r.ok
      if (r.ok) newId = r.data.id
    } else if (isNew) {
      const r = await api.bookmarks.add({ parentId, title: title || (url as string), url: url as string })
      ok = r.ok
      if (r.ok) newId = r.data.id
    } else if (n) {
      const patch = n.kind === 'folder' ? { id: n.id, title } : { id: n.id, title, url: url as string }
      const r = await api.bookmarks.update(patch)
      ok = r.ok
      if (ok && parentId !== currentParent) ok = (await api.bookmarks.move({ id: n.id, parentId })).ok
    }
    save.disabled = false
    if (!ok) {
      formErr.textContent = 'Unable to save. The folder may have been deleted; pick another one and try again.'
      await refresh()
      return
    }
    editing = null
    if (parentId !== selectedId) {
      const dest = findNode(parentId)
      say(`Saved to ${dest && dest.node.kind === 'folder' ? folderName(dest.node) : 'another folder'}.`)
    } else say(isNew ? (isFolder ? 'Folder created.' : 'Bookmark added.') : 'Saved.')
    await refresh(newId ?? n?.id, 'Edit')
    if (parentId !== selectedId) (isNew ? (isFolder ? folderBtn : addBtn) : addBtn).focus()
  })

  const td = h('td', { attrs: { colspan: 3 } }, form)
  const tr = h('tr', { class: 'rn-bm__form-row', data: { id: uid } }, td)
  queueMicrotask(() => nameInput.focus())
  return tr
}

let undoTimer = 0
async function removeNode(n: BookmarkNode): Promise<void> {
  const hit = findNode(n.id)
  const parentId = hit?.parent?.id ?? selectedId
  const index = hit?.index ?? 0
  const res = await api.bookmarks.remove({ id: n.id })
  confirming = null
  if (!res.ok) {
    say('Unable to delete. It may already be gone.')
    await refresh()
    return
  }
  // Focus the next row's first action, or the previous one, or the Add button.
  const row = tableWrap.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(n.id)}"]`)
  const sibling = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null
  const nextId = sibling?.dataset.id
  await refresh(nextId, 'Edit')
  if (!nextId) addBtn.focus()
  if (n.kind === 'bookmark') {
    const undo = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Undo' })
    undo.addEventListener('click', async () => {
      window.clearTimeout(undoTimer)
      const r = await api.bookmarks.add({ parentId, title: n.title, url: n.url, index })
      say(r.ok ? 'Bookmark restored.' : 'Unable to restore the bookmark.')
      await refresh(r.ok ? r.data.id : undefined, 'Edit')
    })
    say([document.createTextNode('Bookmark deleted. '), undo], 5000)
  } else say('Folder deleted.')
}

function startEdit(id: string): void {
  editing = id
  confirming = null
  renderTable()
}

function renderTable(focusId?: string, focusLabel?: string): void {
  const f = selectedFolder()
  if (!f) return
  heading.textContent = folderName(f)
  const rows: HTMLTableRowElement[] = []
  if (editing === 'new-bookmark' || editing === 'new-folder') rows.push(formRow(null))
  for (const c of f.children) rows.push(nodeRow(c))
  if (!f.children.length && !editing) {
    tableWrap.replaceChildren(
      h(
        'div',
        { class: 'rn-empty' },
        h('p', { class: 'rn-bm__empty-title', text: 'This folder is empty.' }),
        h('p', { text: `Add a bookmark here, or press ${api.platform === 'mac' ? '⌘D' : 'Ctrl+D'} on any page to bookmark it.` })
      )
    )
    return
  }
  const table = h(
    'table',
    { class: 'rn-table rn-bm__table' },
    h('caption', { class: 'rn-sr-only', text: `Contents of ${folderName(f)}` }),
    h('colgroup', {}, h('col', { class: 'rn-bm__col-name' }), h('col', { class: 'rn-bm__col-url' }), h('col', { class: 'rn-bm__col-actions' })),
    h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: 'Name' }), h('th', { attrs: { scope: 'col' }, text: 'Address' }), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'rn-sr-only', text: 'Actions' })))),
    h('tbody', {}, ...rows)
  )
  tableWrap.replaceChildren(table)
  if (focusId) {
    const row = table.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(focusId)}"]`)
    const btns = row ? [...row.querySelectorAll<HTMLElement>('button')] : []
    const target = btns.find((b) => b.textContent === focusLabel) ?? btns[0] ?? row?.querySelector<HTMLElement>('a')
    target?.focus()
  }
}

async function refresh(focusId?: string, focusLabel?: string): Promise<void> {
  const res = await api.bookmarks.tree()
  loading.hidden = true
  if (!res.ok) {
    const retry = h('button', { class: 'rn-btn', attrs: { type: 'button' }, text: 'Try again' })
    retry.addEventListener('click', () => void refresh())
    tableWrap.replaceChildren(h('div', { class: 'rn-empty' }, h('p', { text: "Couldn't read your bookmarks." }), retry))
    return
  }
  tree = res.data
  if (!findNode(selectedId)) selectedId = BAR
  renderTree()
  renderTable(focusId, focusLabel)
}

// Keep in step with bookmarks added elsewhere (star button, other windows) when the user comes back to this tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !editing) void refresh()
})

void refresh()
