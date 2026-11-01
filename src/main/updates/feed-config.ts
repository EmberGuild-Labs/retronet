// Where the opt-in update check (AC52, U5) reads its feed. Ships UNSET: with no feed, `updates.status` says
// `enabled:false`, the About page renders no update UI and nothing can ever contact the network (AC53).

/** The one line to edit when a real feed exists. Must be an https URL; anything else is treated as unset. */
export const UPDATE_FEED_URL: string | null = null

/** The PLAN test gate: unpackaged AND RETRONET_E2E=1 (app-paths.testHooksEnabled). */
export interface FeedGate {
  packaged: boolean
  e2e: boolean
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

function parse(v: string): URL | null {
  if (/\s/.test(v) || v.length > 2048) return null
  try {
    return new URL(v)
  } catch {
    return null
  }
}

/** A production feed: https, a real host, no userinfo. */
export function isProductionFeedUrl(v: string): boolean {
  const u = parse(v)
  return u !== null && u.protocol === 'https:' && u.hostname !== '' && !u.username && !u.password
}

/** The test override: http(s) to 127.0.0.1 or localhost only, no userinfo. */
export function isTestFeedUrl(v: string): boolean {
  const u = parse(v)
  return (
    u !== null && (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password
  )
}

/**
 * RETRONET_TEST_UPDATE_FEED, honoured only under the test gate and only for a loopback URL; null otherwise.
 * A packaged build ignores it whatever it says.
 */
export function resolveOverride(env: NodeJS.ProcessEnv, gate: FeedGate): string | null {
  if (gate.packaged || !gate.e2e) return null
  const v = env.RETRONET_TEST_UPDATE_FEED
  return v && isTestFeedUrl(v) ? v : null
}

/** The feed the check uses: the gated test override, else the shipped constant if it is https, else null. */
export function effectiveFeedUrl(env: NodeJS.ProcessEnv, gate: FeedGate, shipped: string | null = UPDATE_FEED_URL): string | null {
  const override = resolveOverride(env, gate)
  if (override) return override
  return shipped !== null && isProductionFeedUrl(shipped) ? shipped : null
}
