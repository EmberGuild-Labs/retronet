// retronet://neterror/?url=..&code=.. (T22, DESIGN 5.9). A friendly era dialog for pages that failed to load.
// url/code come from the query string and are rendered with textContent only; Retry passes nothing (main knows
// which navigation failed for this tab and ignores the call if main didn't load this page).
import { pageApi } from '../../common/api'
import { h, icon } from '../../common/dom'
import { initSkin } from '../../common/skin-loader'
import './neterror.css'

initSkin('page')

const params = new URLSearchParams(location.search)
const rawUrl = (params.get('url') ?? '').slice(0, 2048)
const code = (params.get('code') ?? '').slice(0, 120)

function hostOf(u: string): string {
  try {
    return new URL(u).host || u
  } catch {
    return u || 'the site'
  }
}
const host = hostOf(rawUrl).slice(0, 253)

interface Copy {
  /** Heading; `host` slot is filled in as its own text node. */
  title: [string, boolean, string]
  body: string
  icon: 'warning' | 'info'
}

function copyFor(c: string): Copy {
  const k = c.toUpperCase()
  if (!navigator.onLine || k.includes('INTERNET_DISCONNECTED') || k.includes('NETWORK_CHANGED'))
    return { title: ["You're offline", false, ''], body: 'Check your network connection, then try again.', icon: 'info' }
  if (k.includes('NAME_NOT_RESOLVED') || k.includes('NAME_RESOLUTION_FAILED'))
    return { title: ["RetroNet can't find ", true, ''], body: "Check the address for typos. If it's right, your connection or DNS may be down.", icon: 'warning' }
  if (k.includes('CONNECTION_REFUSED'))
    return { title: ['', true, ' refused the connection'], body: 'The site may be down or not accepting visitors right now.', icon: 'warning' }
  if (k.includes('UNSAFE_PORT')) {
    let port = ''
    try {
      port = new URL(rawUrl).port
    } catch {
      /* keep generic */
    }
    return {
      title: ["RetroNet won't connect to this port", false, ''],
      body: `${port ? `Port ${port} is` : 'This port is'} reserved for other kinds of services, so browsers block it. Check the address.`,
      icon: 'warning'
    }
  }
  if (k.includes('ADDRESS_UNREACHABLE'))
    return { title: ["RetroNet can't reach ", true, ''], body: 'The address may be on a network you are not connected to.', icon: 'warning' }
  if (k.includes('TIMED_OUT'))
    return { title: ['', true, ' took too long to answer'], body: 'The server might be busy. Try again in a moment.', icon: 'warning' }
  return { title: ["This page couldn't load", false, ''], body: `Something went wrong talking to ${host}.`, icon: 'warning' }
}

const copy = copyFor(code)
const api = (() => {
  try {
    return pageApi('neterror')
  } catch {
    return null
  }
})()

const titleEl = h('h1', { attrs: { id: 'rn-net-title' } })
titleEl.append(copy.title[0])
if (copy.title[1]) titleEl.append(host)
titleEl.append(copy.title[2])
document.title = titleEl.textContent || 'Page not loaded'

const status = h('p', { class: 'rn-note rn-neterror__status', attrs: { role: 'status' } })
const retry = h('button', { class: 'rn-btn rn-btn--primary', attrs: { type: 'button' }, text: 'Try again' })
retry.addEventListener('click', async () => {
  if (!api) return
  retry.disabled = true
  status.textContent = `Contacting ${host}...`
  const res = await api.neterror.retry()
  if (!res.ok) {
    retry.disabled = false
    status.textContent = 'Unable to retry from this page. Type the address again in the address bar.'
  }
})

const big = icon(copy.icon)
big.dataset.size = '48'

const main = h(
  'main',
  { class: 'rn-page' },
  h(
    'section',
    { class: 'rn-alert', attrs: { 'aria-labelledby': 'rn-net-title' } },
    h('div', { class: 'rn-alert__strip', attrs: { 'aria-hidden': 'true' }, text: 'RetroNet' }),
    h('div', { class: 'rn-alert__head' }, big, h('div', { class: 'rn-alert__text' }, titleEl, h('p', { text: copy.body }))),
    h('div', { class: 'rn-alert__actions' }, retry),
    h(
      'details',
      { class: 'rn-details' },
      h('summary', { text: 'Details' }),
      rawUrl ? h('p', { class: 'rn-alert__code rn-neterror__url', text: rawUrl }) : null,
      h('p', { class: 'rn-alert__code', text: code || 'Unknown error' })
    ),
    status
  )
)

document.getElementById('app')?.replaceWith(main)
retry.focus()
