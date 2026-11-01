// retronet://about (T21, DESIGN 5.7, AC29). Logo, version, engine versions (named nominatively), licences, the
// unsigned-build note and the privacy promise. Version numbers come from app.info; nothing is hard-coded.
import { initSkin } from '../../common/skin-loader'
import { h } from '../../common/dom'
import { pageApi } from '../../common/api'
import type { AppInfo } from '@shared/types'
import './page.css'

initSkin('page')

const api = pageApi('about')
const app = document.getElementById('app') as HTMLElement

setFavicon()

const version = h('p', { class: 'rn-about__version', text: 'Version …' })
const engine = h('p', { class: 'rn-about__engine rn-muted', text: '' })

const unsigned = h(
  'details',
  { class: 'rn-details' },
  h('summary', { text: 'About the unsigned build' }),
  h('p', {
    text:
      'RetroNet is not signed with an Apple Developer ID, so macOS Gatekeeper blocks the first launch. To open it, ' +
      'Control-click (or right-click) RetroNet in Applications, choose Open, then confirm. You only need to do this once.'
  }),
  h('p', {}, 'Prefer the Terminal? Run ', h('code', { text: 'xattr -dr com.apple.quarantine /Applications/RetroNet.app' }), '.'),
  h('p', { text: 'Updates are not automatic: there is no unsigned update channel. Download new versions by hand.' })
)

app.classList.add('rn-about')
app.replaceChildren(
  h(
    'div',
    { class: 'rn-about__hero' },
    h('img', { class: 'rn-about__mark', attrs: { src: 'img/logo.svg', alt: '', width: 128, height: 128 } }),
    h(
      'div',
      { class: 'rn-about__id' },
      h('h1', {}, h('img', { class: 'rn-about__wordmark', attrs: { src: 'img/wordmark.svg', alt: 'About RetroNet', width: 156, height: 32 } })),
      version,
      engine
    )
  ),
  h(
    'section',
    { class: 'rn-panel', attrs: { 'aria-labelledby': 'rn-about-privacy' } },
    h('h2', { attrs: { id: 'rn-about-privacy' }, text: 'Privacy' }),
    h('p', { text: 'No telemetry. RetroNet never contacts any server on its own: every request comes from a page you open.' }),
    h('p', { text: 'The hit counter on the new tab page is fake and stays on this computer.' })
  ),
  h(
    'section',
    { class: 'rn-panel', attrs: { 'aria-labelledby': 'rn-about-credits' } },
    h('h2', { attrs: { id: 'rn-about-credits' }, text: 'Credits and licenses' }),
    h('p', { text: 'All artwork, icons and the logo are original to RetroNet.' }),
    h('p', {
      text:
        'Fonts: VT323, Pixelify Sans, Silkscreen, Noto Sans, Tinos and Arimo, all under the SIL Open Font License 1.1. ' +
        'The license texts ship with the app.'
    }),
    h('p', { text: 'Built on Electron and the Chromium engine, both open source.' }),
    h(
      'p',
      { class: 'rn-about__badge' },
      h('img', { class: 'rn-badge-88', attrs: { src: 'img/badge-88x31.svg', alt: 'Best viewed in RetroNet', width: 88, height: 31 } })
    )
  ),
  h('section', { class: 'rn-panel', attrs: { 'aria-label': 'Unsigned build' } }, unsigned),
  h(
    'p',
    { class: 'rn-about__links' },
    h('a', { attrs: { href: 'retronet://shortcuts/' }, text: 'Keyboard shortcuts' }),
    h('span', { attrs: { 'aria-hidden': 'true' }, text: ' · ' }),
    h('a', { attrs: { href: 'retronet://settings/' }, text: 'Settings' }),
    h('span', { attrs: { 'aria-hidden': 'true' }, text: ' · ' }),
    h('a', { attrs: { href: 'retronet://newtab/' }, text: 'New tab page' })
  )
)

void api.app.info().then((r) => {
  if (!r.ok) {
    version.textContent = 'Version unknown'
    return
  }
  render(r.data)
})

function render(info: AppInfo): void {
  version.textContent = `Version ${info.version}${info.packaged ? '' : ' (development build)'}`
  const os = info.platform === 'mac' ? 'macOS' : 'Windows'
  engine.textContent = `Engine: Electron ${info.electron}, Chromium ${info.chromium} · ${os} ${info.arch}`
}

function setFavicon(): void {
  if (document.querySelector('link[rel="icon"]')) return
  document.head.append(h('link', { attrs: { rel: 'icon', href: 'img/logo-16.svg', type: 'image/svg+xml' } }))
}
