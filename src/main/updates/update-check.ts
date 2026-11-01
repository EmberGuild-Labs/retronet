// The one network request of the opt-in update check (AC52, AC53, U5). Called ONLY from the `updates.check`
// handler, i.e. only when the user clicks "Check for updates". Never at launch, on a timer or on page load.
// The request runs in a dedicated in-memory session (no profile cookies, nothing on disk), refuses redirects,
// stops reading at 64 KB, gives up after 10 s, and accepts only a strict {version, url, notes?} feed.
import { session } from 'electron'
import { z } from 'zod'
import type { UpdateCheckResultSchema, UpdateErrorSchema } from '../../shared/ipc-contract'
import { isAllowedAddress } from '../../shared/settings'
import { isProductionFeedUrl, isTestFeedUrl } from './feed-config'
import { compareSemver, parseSemver } from './semver'

/** In-memory (no `persist:` prefix): cookies and cache never reach disk, and no profile shares it. */
export const UPDATE_PARTITION = 'rn-update-check'
export const UPDATE_TIMEOUT_MS = 10_000
export const UPDATE_MAX_BYTES = 65_536
export const UPDATE_MIN_INTERVAL_MS = 10_000

/** The subset of fetch the check uses; `net.fetch`-compatible, injected in unit tests. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export type UpdateCheckResult = z.infer<typeof UpdateCheckResultSchema>
type UpdateError = z.infer<typeof UpdateErrorSchema>

const HTTPS_ONLY = new Set(['https:'])

const DownloadUrlSchema = z
  .string()
  .max(2048)
  // https with a real host, and no userinfo (no `https://trusted.example@evil.example/` spoofing).
  .refine((v) => {
    if (!isAllowedAddress(v, HTTPS_ONLY)) return false
    const u = new URL(v)
    return !u.username && !u.password
  }, 'url must be https without credentials')

export const FeedSchema = z.strictObject({
  version: z
    .string()
    .max(64)
    .refine((v) => parseSemver(v) !== null, 'version must be semver'),
  url: DownloadUrlSchema,
  notes: z.string().max(4000).optional()
})
export type Feed = z.infer<typeof FeedSchema>

/** What the handler needs: the result for the page, plus the main-held download URL when one is available. */
export type CheckOutcome = { result: UpdateCheckResult; downloadUrl: string | null }

/** One check in flight at a time, and at least `minIntervalMs` between the starts of two checks. */
export class CheckThrottle {
  private inFlight = false
  private lastStart = -Infinity
  constructor(
    private readonly minIntervalMs = UPDATE_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}
  tryStart(): boolean {
    const t = this.now()
    if (this.inFlight || t - this.lastStart < this.minIntervalMs) return false
    this.inFlight = true
    this.lastStart = t
    return true
  }
  finish(): void {
    this.inFlight = false
  }
}

const defaultThrottle = new CheckThrottle()

export interface CheckOptions {
  feedUrl: string
  currentVersion: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
  maxBytes?: number
  throttle?: CheckThrottle
}

/** `session.fromPartition('rn-update-check').fetch`, created lazily so importing this module touches nothing. */
function sessionFetch(): FetchImpl {
  const ses = session.fromPartition(UPDATE_PARTITION, { cache: false })
  return (url, init) => ses.fetch(url, init)
}

class CheckError extends Error {
  constructor(readonly kind: Exclude<UpdateError, 'busy'>) {
    super(kind)
  }
}

/** Read at most `maxBytes` of the body; cancels the stream and fails `too-large` past the cap. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new CheckError('too-large')
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new CheckError('too-large')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new CheckError('too-large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function parseFeed(bytes: Uint8Array): Feed {
  let data: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    data = JSON.parse(text)
  } catch {
    throw new CheckError('invalid-feed')
  }
  const r = FeedSchema.safeParse(data)
  if (!r.success) throw new CheckError('invalid-feed')
  return r.data
}

async function fetchFeed(o: Required<Omit<CheckOptions, 'throttle'>>, signal: AbortSignal): Promise<Feed> {
  let res: Response
  try {
    res = await o.fetchImpl(o.feedUrl, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal
    })
  } catch {
    // A redirect (redirect:'error'), DNS, TLS or connection failure. An abort is reported by the caller.
    throw new CheckError('network')
  }
  // Belt and braces: a fetch that followed a redirect anyway, or any non-2xx answer, is not a feed.
  if (res.redirected || !res.ok) {
    void res.body?.cancel().catch(() => {})
    throw new CheckError('network')
  }
  try {
    return parseFeed(await readCapped(res, o.maxBytes))
  } catch (err) {
    throw err instanceof CheckError ? err : new CheckError('network')
  }
}

/**
 * Fetch and judge the feed once. Never throws: every failure is an `error` result. Only `updates.check` may
 * call this (AC53; there is a grep test for it).
 */
export async function checkForUpdate(opts: CheckOptions): Promise<CheckOutcome> {
  const current = opts.currentVersion
  const fail = (error: UpdateError): CheckOutcome => ({
    result: { state: 'error', current, error },
    downloadUrl: null
  })
  const throttle = opts.throttle ?? defaultThrottle
  if (!throttle.tryStart()) return fail('busy')
  try {
    if (!isProductionFeedUrl(opts.feedUrl) && !isTestFeedUrl(opts.feedUrl)) return fail('network')
    const o = {
      feedUrl: opts.feedUrl,
      currentVersion: current,
      fetchImpl: opts.fetchImpl ?? sessionFetch(),
      timeoutMs: opts.timeoutMs ?? UPDATE_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? UPDATE_MAX_BYTES
    }
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        reject(new CheckError('timeout'))
      }, o.timeoutMs)
    })
    let feed: Feed
    try {
      // The race also covers a fetch that ignores the abort signal.
      feed = await Promise.race([fetchFeed(o, ac.signal), timedOut])
    } catch (err) {
      if (ac.signal.aborted) return fail('timeout')
      return fail(err instanceof CheckError ? err.kind : 'network')
    } finally {
      clearTimeout(timer)
      timedOut.catch(() => {})
    }
    const order = compareSemver(feed.version, current)
    if (order === null) return fail('invalid-feed')
    if (order <= 0) return { result: { state: 'up-to-date', current, latest: feed.version }, downloadUrl: null }
    return { result: { state: 'available', current, latest: feed.version, notes: feed.notes ?? '' }, downloadUrl: feed.url }
  } finally {
    throttle.finish()
  }
}
