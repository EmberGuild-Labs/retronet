// Hand-rolled semver 2.0.0 parse/compare for the update check (no dependency). Build metadata is ignored;
// prereleases order per semver section 11 (1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0).

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

const NUM = '0|[1-9]\\d*'
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const BUILD_ID = '[0-9a-zA-Z-]+'
const SEMVER_RE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`)

/** Strict `MAJOR.MINOR.PATCH[-pre][+build]` (no `v` prefix, no leading zeros); null if invalid or over 64 chars. */
export function parseSemver(v: string): Semver | null {
  if (v.length > 64) return null
  const m = SEMVER_RE.exec(v)
  if (!m) return null
  const nums = [m[1], m[2], m[3]].map(Number)
  if (nums.some((n) => !Number.isSafeInteger(n))) return null
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { major: nums[0] as number, minor: nums[1] as number, patch: nums[2] as number, prerelease }
}

function cmp(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b)
  if (typeof a === 'number') return -1 // numeric identifiers sort before alphanumeric ones
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1, 0 or 1; null if either side is not valid semver. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return null
  const core = cmp(x.major, y.major) || cmp(x.minor, y.minor) || cmp(x.patch, y.patch)
  if (core) return core as -1 | 1
  // A version without a prerelease outranks one with.
  if (!x.prerelease.length || !y.prerelease.length) return Math.sign(y.prerelease.length - x.prerelease.length) as -1 | 0 | 1
  const n = Math.min(x.prerelease.length, y.prerelease.length)
  for (let i = 0; i < n; i++) {
    const c = cmp(x.prerelease[i] as string | number, y.prerelease[i] as string | number)
    if (c) return c as -1 | 1
  }
  return Math.sign(x.prerelease.length - y.prerelease.length) as -1 | 0 | 1
}
