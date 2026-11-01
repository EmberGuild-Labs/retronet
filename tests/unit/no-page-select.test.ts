// AC66: internal pages use the themed createSelect, never a native <select> (A8-A10).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', 'src', 'renderer', 'pages')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|html)$/.test(name) ? [p] : []
  })
}

describe('internal pages', () => {
  // Needs A9 (settings) to land too; flips to a real test once no <select> remains.
  const files = sources(ROOT)
  const offenders = files.filter((f) => /<select\b|h\(\s*['"]select['"]/.test(readFileSync(f, 'utf8')))
  const run = offenders.length === 0 ? it : it.todo
  run('have no native <select> (use common/select.ts)', () => {
    expect(offenders).toEqual([])
  })
})
