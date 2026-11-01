import { displayUrl } from '../../shared/url-safety'

// Q6: URLs are never persisted with userinfo (`http://user:pass@host/`). History, session.json, the downloads
// list and the suggestions built from them all store the address without it, like other browsers. Only http(s) and
// ftp-style URLs can carry userinfo; anything else (or unparsable) is returned as is.

/** The URL without `user:pass@`, also inside `view-source:` (AC73). Cheap for the common case (no '@' at all). */
export function stripUrlCredentials(url: string): string {
  return url.includes('@') ? displayUrl(url) : url
}

/**
 * A page without its own <title> is titled with its address, so `user:pass@` can hide in titles too.
 * Remove the userinfo of `url` from `title` wherever it appears.
 */
export function stripTitleCredentials(title: string, url: string): string {
  if (!title.includes('@')) return title
  let userinfo = ''
  try {
    const u = new URL(url.startsWith('view-source:') ? url.slice('view-source:'.length) : url)
    if (u.username || u.password) userinfo = `${u.username}${u.password ? `:${u.password}` : ''}@`
  } catch {
    return title
  }
  if (!userinfo) return title
  let out = title.split(userinfo).join('')
  try {
    out = out.split(decodeURIComponent(userinfo)).join('')
  } catch {
    /* keep */
  }
  return out
}
