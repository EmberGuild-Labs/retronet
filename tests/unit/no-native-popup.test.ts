// AC65: native menus are popped up in one place only (the themed-menu fallback).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '../../src')
const ALLOWED = 'main/menus/native-fallback.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('no native popup outside native-fallback.ts', () => {
  it('Menu.popup / menu.popup( appears only in the fallback', () => {
    const offenders = walk(SRC)
      .filter((f) => relative(SRC, f).split('\\').join('/') !== ALLOWED)
      .filter((f) => /Menu\.popup|\.popup\(|menu\.popup\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('the fallback itself still pops up (the scan is looking at the right thing)', () => {
    expect(readFileSync(join(SRC, ALLOWED), 'utf8')).toMatch(/\.popup\(/)
  })
})
