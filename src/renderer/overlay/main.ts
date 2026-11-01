// Overlay renderer (retronet://overlay/, T20). One transparent WebContentsView on top of the window that shows one
// thing at a time, as main tells it with `overlay` events: the command palette, a permission prompt, the tab group
// editor, a dialog, the HTTP sign-in dialog, the omnibox suggestion list, the fullscreen notice or a themed menu. `hide` (or the
// next event) tears the current component down. The view usually covers the whole window, so a click on the transparent area around a
// component is "outside" (close/cancel); for suggestions main shrinks the view to just the list.
import type { OverlayEvent, WindowSnapshot } from '@shared/types'
import { shellApi } from '../common/api'
import { initSkin } from '../common/skin-loader'
import { mountDialog } from './dialogs'
import { mountFullscreenNotice } from './fullscreen-notice'
import { mountGroupEditor } from './group-editor'
import { mountHttpAuth } from './http-auth'
import { mountMenu } from './menu'
import { mountPalette } from './palette'
import { mountPermissionPrompt, type PromptHandle } from './permission-prompt'
import { mountSuggest, type SuggestHandle } from './suggest'
import type { Mounted, OverlayEnv } from './ui'
import './overlay.css'
import './menu.css'

initSkin('overlay')

const api = shellApi()
const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'))
app.classList.add('rn-overlay')

let snapshot: WindowSnapshot | null = null
let current: { kind: OverlayEvent['kind']; mounted: Mounted } | null = null

const env: OverlayEnv = {
  api,
  platform: api.platform,
  snapshot: () => snapshot,
  close: () => void api.overlay.close()
}

function teardown(): void {
  if (!current) return
  current.mounted.destroy?.()
  current.mounted.root.remove()
  current = null
  app.dataset.kind = ''
}

function mount(kind: OverlayEvent['kind'], mounted: Mounted): void {
  teardown()
  current = { kind, mounted }
  app.dataset.kind = kind
  app.append(mounted.root)
}

function show(ev: OverlayEvent): void {
  switch (ev.kind) {
    case 'hide':
      teardown()
      return
    case 'suggest-highlight':
      if (current?.kind === 'suggest') (current.mounted as SuggestHandle).highlight(ev.selected)
      return
    case 'suggest':
      if (current?.kind === 'suggest') (current.mounted as SuggestHandle).update(ev)
      else mount('suggest', mountSuggest(ev, env))
      return
    case 'permission':
      if (current?.kind === 'permission' && (current.mounted as PromptHandle).update(ev)) return
      mount('permission', mountPermissionPrompt(ev, env))
      return
    case 'palette':
      mount('palette', mountPalette(ev, env))
      return
    case 'group-editor':
      mount('group-editor', mountGroupEditor(ev, env))
      return
    case 'dialog':
      mount('dialog', mountDialog(ev, env))
      return
    case 'http-auth':
      if (current?.kind === 'http-auth' && current.mounted.root.dataset.authId === ev.id) return
      {
        const mounted = mountHttpAuth(ev, env)
        mounted.root.dataset.authId = ev.id
        mount('http-auth', mounted)
      }
      return
    case 'fullscreen-notice': {
      const mounted = mountFullscreenNotice(ev, env, () => current?.mounted === mounted)
      mount('fullscreen-notice', mounted)
      return
    }
    case 'menu': {
      // A new menu always replaces the old one (main keeps one menu per window). Place it once it is in the document.
      const mounted = mountMenu(ev, env)
      mount('menu', mounted)
      mounted.place()
      return
    }
  }
}

api.on('overlay', show)
api.on('state', (snap) => {
  snapshot = snap
  current?.mounted.onState?.(snap)
})

// A press on the transparent area around the component counts as "outside".
app.addEventListener('mousedown', (e) => {
  if (!current || e.button !== 0) return
  const target = e.target as Node
  if (current.mounted.root.contains(target) && !(target instanceof Element && target.classList.contains('rn-scrim'))) return
  e.preventDefault()
  current.mounted.onOutside?.()
})
