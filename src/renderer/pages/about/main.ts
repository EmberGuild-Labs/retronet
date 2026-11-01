// retronet://about (T21, DESIGN 5.7, AC29). Logo, version, engine versions (named nominatively), licences, the
// unsigned-build note and the privacy promise. Version numbers come from app.info; nothing is hard-coded.
import { initSkin } from '../../common/skin-loader'
import { h, icon } from '../../common/dom'
import { pageApi } from '../../common/api'
import type { AppInfo } from '@shared/types'
import { SKIN_IDS, isSkinId } from '@shared/skins'
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
  h('p', { text: 'Updates are never automatic. When an update check is available, it runs only when you press its button.' })
)

const updatesSlot = h('div', { class: 'rn-update-slot' })

/** A dismissible `.rn-banner` (X13) rendered into `region`; Dismiss clears it and returns focus to `focusBack`. */
function showBanner(
  region: HTMLElement,
  focusBack: () => HTMLElement,
  kind: 'info' | 'ok' | 'warn' | 'error',
  lines: Array<string | Node>,
  extra?: Node[]
): void {
  const ic = icon(kind === 'warn' || kind === 'error' ? 'warning' : 'info')
  ic.classList.add('rn-banner__icon')
  const body = h('div', { class: 'rn-banner__body' }, ...lines.map((l) => (typeof l === 'string' ? h('p', { text: l }) : l)), ...(extra ?? []))
  const close = h('button', { class: 'rn-btn rn-banner__close', attrs: { type: 'button', 'aria-label': 'Dismiss' } }, icon('close'))
  close.addEventListener('click', () => {
    region.replaceChildren()
    focusBack().focus()
  })
  region.replaceChildren(h('div', { class: ['rn-banner', kind !== 'info' && `rn-banner--${kind}`] }, ic, body, close))
}

// ---------- Hidden-page hints (D-B3, DESIGN-EGGS 5) ----------
// All four are rendered; page.css shows only the current skin's, so live skin switches need no JS (E-6). The page
// names only an era; main maps it to the page. No slug appears here (D-B6).
const HINTS: Record<(typeof SKIN_IDS)[number], string> = {
  y1994: 'This machine is a server. DO NOT POWER IT DOWN!!',
  y1997: 'Seen a comet lately?',
  y1999: 'Flavors this season: Blueberry, Tangerine… and one more.',
  y2001: 'In Hawaiian, wiki wiki means quick.'
}
const hintStatus = h('div', { class: 'rn-egg-hints__status', attrs: { role: 'status' } })
const hints = h(
  'p',
  { class: 'rn-egg-hints' },
  ...SKIN_IDS.map((era) => {
    const b = h('button', { class: 'rn-egg-hint', attrs: { type: 'button', 'aria-describedby': 'rn-egg-hint-desc' }, data: { era }, text: HINTS[era] })
    b.addEventListener('click', async () => {
      hintStatus.replaceChildren()
      const e = b.dataset.era
      const res = isSkinId(e) ? await api.eggs.openFromPage({ era: e }) : undefined
      // Success needs no message: the hidden page opens in a tab and takes focus.
      if (!res?.ok) showBanner(hintStatus, () => b, 'error', ["Error: couldn't open that page."])
    })
    return b
  }),
  h('span', { class: 'rn-sr-only', attrs: { id: 'rn-egg-hint-desc' }, text: 'Opens a hidden page.' })
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
    ),
    hints,
    hintStatus
  ),
  updatesSlot,
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

// ---------- Updates (AC52, AC53): only in the DOM when updates.status.enabled ----------
type Check = Awaited<ReturnType<typeof api.updates.check>>
void api.updates.status().then((r) => {
  if (!r.ok || !r.data.enabled) return
  const current = r.data.current
  const btn = h('button', { class: 'rn-btn', attrs: { type: 'button', id: 'rn-update-btn' } }, h('span', { class: 'rn-btn__label', text: 'Check for updates' }))
  const region = h('div', { class: 'rn-update__banner', attrs: { role: 'status', id: 'rn-update-status' } })
  const section = h(
    'section',
    { class: 'rn-panel rn-update', attrs: { 'aria-labelledby': 'rn-update-title' } },
    h('h2', { attrs: { id: 'rn-update-title' }, text: 'Updates' }),
    h('p', { text: `You have RetroNet ${current}.` }),
    h('p', { class: 'rn-help', attrs: { id: 'rn-update-help' }, text: 'RetroNet checks only when you press this button. Nothing is checked automatically.' }),
    h('div', { class: 'rn-update__row' }, btn),
    region
  )
  btn.setAttribute('aria-describedby', 'rn-update-help')
  updatesSlot.replaceWith(section)

  const label = (text: string, busy = false): void => {
    btn.replaceChildren(...(busy ? [icon('loading')] : []), h('span', { class: 'rn-btn__label', text }))
  }
  const banner = (kind: 'info' | 'ok' | 'warn' | 'error', lines: Array<string | Node>, extra?: Node[]): void =>
    showBanner(region, () => btn, kind, lines, extra)
  const ERRORS: Record<string, string> = {
    network: "Error: couldn't reach the update server. Check your connection, then try again.",
    timeout: 'Error: the update server took too long to answer.',
    'invalid-feed': "Error: the update information couldn't be read.",
    'too-large': 'Error: the update information was too large to read.'
  }
  const show = (res: Check): void => {
    if (!res.ok) {
      label('Try again')
      banner('error', ["Error: couldn't check for updates."])
      return
    }
    const d = res.data
    if (d.state === 'up-to-date') {
      label('Check again')
      banner('ok', [`You're up to date. ${d.latest} is the newest version.`])
    } else if (d.state === 'available') {
      label('Check again')
      const notes = h('div', { class: 'rn-update__notes', attrs: { tabindex: 0, role: 'region', 'aria-label': 'Release notes' } })
      notes.textContent = d.notes
      const dl = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'button' } }, h('span', { class: 'rn-btn__label', text: `Download ${d.latest}` }), icon('external'))
      // R24: a failed open replaces the offer with an error in the same status region; focus moves to Check again.
      dl.addEventListener('click', async () => {
        const res = await api.updates.openDownload()
        if (res.ok) return
        banner('error', ["Error: couldn't open the download page. Check for updates again, then try again."])
        btn.focus()
      })
      banner(
        'info',
        [h('p', {}, h('strong', { text: `RetroNet ${d.latest} is available.` }), ` You have ${d.current}.`)],
        [
          ...(d.notes ? [h('p', { class: 'rn-update__notes-label', text: "What's new" }), notes] : []),
          h('div', { class: 'rn-update__row' }, dl, h('span', { class: 'rn-help', text: 'Opens the download page in a new tab.' }))
        ]
      )
    } else if (d.error === 'busy') {
      label('Check again')
      banner('warn', ['Please wait a few seconds before checking again.'])
    } else {
      label('Try again')
      banner('error', [ERRORS[d.error] ?? "Error: couldn't check for updates."])
    }
  }
  btn.addEventListener('click', async () => {
    region.replaceChildren()
    btn.disabled = true
    section.setAttribute('aria-busy', 'true')
    label('Checking…', true)
    const res = await api.updates.check()
    section.removeAttribute('aria-busy')
    btn.disabled = false
    show(res)
    btn.focus()
  })
})
