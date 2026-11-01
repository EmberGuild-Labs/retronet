import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanStaleTmp, realFs, writeFileAtomic, writeFileAtomicSync, type AtomicFs } from '../../src/main/storage/atomic-json'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-atomic-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const eexist = (): Error => Object.assign(new Error('exists'), { code: 'EEXIST' })

describe('atomic-json temp files', () => {
  it('names the temp <file>.<pid>.<12 hex>.tmp and creates it with mode 0600', async () => {
    const file = join(dir, 'a.json')
    const seen: string[] = []
    const spy: AtomicFs = {
      ...realFs,
      writeSynced: async (f, d) => {
        seen.push(f)
        await realFs.writeSynced(f, d)
        if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
      }
    }
    await writeFileAtomic(file, '{}', spy)
    expect(seen[0]!.slice(file.length)).toMatch(new RegExp(`^\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`))
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('retries with a new name on EEXIST (async), up to 3 retries, and does not remove the foreign entry', async () => {
    const file = join(dir, 'a.json')
    const names: string[] = []
    const rm: string[] = []
    const flaky: AtomicFs = {
      ...realFs,
      writeSynced: async (f, d) => {
        names.push(f)
        if (names.length <= 3) throw eexist()
        await realFs.writeSynced(f, d)
      },
      rm: async (f) => {
        rm.push(f)
      }
    }
    await writeFileAtomic(file, '{"ok":1}', flaky)
    expect(new Set(names).size).toBe(4)
    expect(rm).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).ok).toBe(1)
  })

  it('gives up with EEXIST after 3 retries (async and sync)', async () => {
    const file = join(dir, 'a.json')
    let n = 0
    const always: AtomicFs = {
      ...realFs,
      writeSynced: async () => {
        n++
        throw eexist()
      },
      writeSyncedSync: () => {
        n++
        throw eexist()
      }
    }
    await expect(writeFileAtomic(file, '{}', always)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(n).toBe(4)
    n = 0
    expect(() => writeFileAtomicSync(file, '{}', always)).toThrow('exists')
    expect(n).toBe(4)
    expect(existsSync(file)).toBe(false)
  })

  it('sync variant retries on EEXIST too', () => {
    const file = join(dir, 'a.json')
    let n = 0
    const flaky: AtomicFs = {
      ...realFs,
      writeSyncedSync: (f, d) => {
        if (++n === 1) throw eexist()
        realFs.writeSyncedSync(f, d)
      }
    }
    writeFileAtomicSync(file, '{"s":1}', flaky)
    expect(n).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8')).s).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('a symlink at the first temp name is not followed; target untouched', async () => {
    const file = join(dir, 'a.json')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'precious')
    const first: string[] = []
    const planted: AtomicFs = {
      ...realFs,
      writeSynced: async (f, d) => {
        if (first.length === 0) {
          first.push(f)
          symlinkSync(victim, f) // attacker pre-places a link at the name we picked
        }
        await realFs.writeSynced(f, d)
      }
    }
    await writeFileAtomic(file, '{"n":1}', planted)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(lstatSync(first[0]!).isSymbolicLink()).toBe(true) // left alone
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(1)
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('a dangling symlink at the temp path is not created through either', () => {
    const target = join(dir, 'not-there.txt')
    const tmp = join(dir, 'x.tmp')
    symlinkSync(target, tmp)
    expect(() => realFs.writeSyncedSync(tmp, 'data')).toThrow(/EEXIST/)
    expect(existsSync(target)).toBe(false)
  })

  it('cleanStaleTmp sweeps this file\'s *.tmp leftovers (old and new naming) only', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '{}')
    writeFileSync(`${file}.12.3.tmp`, 'x')
    writeFileSync(`${file}.12.abcdef012345.tmp`, 'x')
    writeFileSync(join(dir, 'b.json.12.abcdef012345.tmp'), 'x')
    cleanStaleTmp(file)
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json.12.abcdef012345.tmp'])
  })
})
