// Q6: URLs are never persisted with userinfo (`http://user:pass@host/`). History, session.json, the downloads
// list and the suggestions built from them all store the address without it, like other browsers. Only http(s) and
// ftp-style URLs can carry userinfo; anything else (or unparsable) is returned as is.

/** The URL without `user:pass@`. Cheap for the common case (no '@' at all). */
export function stripUrlCredentials(url: string): string {
  if (!url.includes('@')) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!u.username && !u.password) return url
  u.username = ''
  u.password = ''
  return u.href
}
