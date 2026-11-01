// retronet://certerror/?url=..&code=.. (T22, DESIGN 5.8, AC37). Main loads this page in place of a site whose
// certificate failed. The url and code come from the page's own query string, which a forged link could also
// set, so they are only ever rendered with textContent, and the buttons pass nothing: main remembers the blocked
// navigation per tab and ignores the call when this page wasn't loaded by main itself.
import { pageApi } from '../../common/api'
import { h, icon } from '../../common/dom'
import { initSkin } from '../../common/skin-loader'
import './certerror.css'

initSkin('page')

const params = new URLSearchParams(location.search)
const rawUrl = (params.get('url') ?? '').slice(0, 2048)
const code = (params.get('code') ?? '').slice(0, 120)

function hostOf(u: string): string {
  try {
    const parsed = new URL(u)
    return parsed.host || u
  } catch {
    return u || 'this site'
  }
}
const host = hostOf(rawUrl).slice(0, 253)

/** Plain-language reason for the common Chromium certificate codes. */
function reasonFor(c: string): string {
  const k = c.toUpperCase()
  if (k.includes('DATE_INVALID')) return "The site's certificate has expired or isn't valid yet. Your computer's clock could also be wrong."
  if (k.includes('COMMON_NAME_INVALID')) return 'The certificate was issued for a different site.'
  if (k.includes('AUTHORITY_INVALID')) return "The certificate wasn't issued by an authority RetroNet trusts. It may be self-signed."
  if (k.includes('REVOKED')) return 'The certificate has been revoked by the authority that issued it.'
  if (k.includes('WEAK')) return 'The certificate uses weak security that can be broken.'
  return "RetroNet couldn't confirm that the certificate belongs to this site."
}

const api = (() => {
  try {
    return pageApi('certerror')
  } catch {
    return null
  }
})()

function sizedIcon(name: string, size: string): HTMLSpanElement {
  const el = icon(name)
  el.dataset.size = size
  return el
}

const status = h('p', { class: 'rn-note rn-certerror__status', attrs: { role: 'status' } })

async function run(kind: 'back' | 'proceed', btn: HTMLButtonElement): Promise<void> {
  if (!api) return
  btn.disabled = true
  const res = await api.certerror[kind]()
  if (!res.ok) {
    btn.disabled = false
    status.textContent =
      kind === 'proceed'
        ? 'This warning is no longer active, so there is nothing to proceed to. Go back and open the site again.'
        : 'Unable to go back from here. Close this tab or type a new address.'
  }
}

const backBtn = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'button' }, text: 'Back to safety' })
backBtn.addEventListener('click', () => void run('back', backBtn))

const proceedBtn = h('button', { class: 'rn-btn', attrs: { type: 'button' } })
proceedBtn.textContent = `Proceed to ${host} (unsafe)`
proceedBtn.addEventListener('click', () => void run('proceed', proceedBtn))

const body = h('p', {}, 'Someone could be pretending to be ', h('strong', { text: host }), ' to steal your information, such as passwords, messages or card numbers. RetroNet stopped loading the page.')

const codeLine = code ? h('p', { class: 'rn-alert__code', text: code }) : null

const urlLine = rawUrl ? h('p', { class: 'rn-alert__code rn-certerror__url', text: rawUrl, attrs: { title: rawUrl } }) : null

const details = h(
  'details',
  { class: 'rn-details' },
  h('summary', { text: 'Advanced' }),
  h('p', { text: reasonFor(code) }),
  h('p', { text: 'If you proceed, RetroNet trusts this site until you quit, and only in this profile. The address bar keeps showing a warning.' }),
  urlLine,
  h('div', { class: 'rn-alert__actions' }, proceedBtn)
)

const main = h(
  'main',
  { class: 'rn-page' },
  h(
    'section',
    { class: 'rn-alert rn-alert--danger', attrs: { 'aria-labelledby': 'rn-cert-title' } },
    h('div', { class: 'rn-alert__strip', attrs: { 'aria-hidden': 'true' }, text: 'Security warning' }),
    h(
      'div',
      { class: 'rn-alert__head' },
      sizedIcon('warning', '48'),
      h(
        'div',
        { class: 'rn-alert__text' },
        h('h1', { attrs: { id: 'rn-cert-title' }, text: "Warning: this site's certificate can't be trusted" }),
        body,
        codeLine
      )
    ),
    h('div', { class: 'rn-alert__actions' }, backBtn),
    details,
    status
  )
)

document.getElementById('app')?.replaceWith(main)
backBtn.focus()
