import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { realFs, writeFileAtomic, type AtomicFs } from '../../src/main/storage/atomic-json'
import { createJsonStore, flushAllStores, flushAllStoresSync } from '../../src/main/storage/json-store'

const schema = z.object({ n: z.number(), items: z.array(z.string()) })
type Data = z.infer<typeof schema>
const defaults = (): Data => ({ n: 0, items: [] })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-store-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('atomic write', () => {
  it('keeps the old file when the process dies after writing the tmp file (before rename)', async () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '{"n":1,"items":[]}')
    const dying: AtomicFs = { ...realFs, rename: async () => { throw new Error('killed') } }
    await expect(writeFileAtomic(file, '{"n":2,"items":[]}', dying)).rejects.toThrow('killed')
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(1)
    expect(readdirSync(dir)).toEqual(['a.json']) // tmp cleaned up
  })

  it('keeps the old file when the write is cut off halfway', async () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '{"n":1,"items":[]}')
    const dying: AtomicFs = {
      ...realFs,
      writeSynced: async (f, data) => {
        writeFileSync(f, data.slice(0, 5)) // partial tmp content
        throw new Error('killed')
      }
    }
    await expect(writeFileAtomic(file, '{"n":2,"items":[]}', dying)).rejects.toThrow('killed')
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(1)
  })

  it('a hard kill (tmp left behind, no cleanup) leaves old data loadable and the stale tmp is swept', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '{"n":1,"items":[]}')
    writeFileSync(`${file}.999.1.tmp`, '{"n":2,"it')
    const s = createJsonStore({ file, schema, defaults })
    expect(s.get().n).toBe(1)
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('creates missing parent directories', async () => {
    const file = join(dir, 'deep', 'er', 'a.json')
    await writeFileAtomic(file, '{}')
    expect(existsSync(file)).toBe(true)
  })
})

describe('corrupt-file recovery', () => {
  it('backs up unparsable JSON and returns defaults', () => {
    const file = join(dir, 's.json')
    writeFileSync(file, '{"n": 3, "items": [')
    const onError = vi.fn()
    const s = createJsonStore({ file, schema, defaults, onError })
    expect(s.get()).toEqual(defaults())
    const names = readdirSync(dir)
    const backup = names.find((n) => n.startsWith('s.json.corrupt-'))!
    expect(backup).toBeTruthy()
    expect(readFileSync(join(dir, backup), 'utf8')).toBe('{"n": 3, "items": [')
    expect(names).not.toContain('s.json')
    expect(onError).toHaveBeenCalledWith(expect.anything(), 'corrupt')
  })

  it('treats schema-invalid JSON as corrupt', () => {
    const file = join(dir, 's.json')
    writeFileSync(file, '{"n":"nope"}')
    const s = createJsonStore({ file, schema, defaults })
    expect(s.get()).toEqual(defaults())
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true)
  })

  it('missing file gives defaults without creating anything', () => {
    const s = createJsonStore({ file: join(dir, 'x.json'), schema, defaults })
    expect(s.get()).toEqual(defaults())
    expect(readdirSync(dir)).toEqual([])
  })

  it('runs migrate before validation', () => {
    const file = join(dir, 's.json')
    writeFileSync(file, '{"count":7,"items":["a"]}')
    const s = createJsonStore({
      file, schema, defaults,
      migrate: (raw) => { const r = raw as { count: number; items: string[] }; return { n: r.count, items: r.items } }
    })
    expect(s.get()).toEqual({ n: 7, items: ['a'] })
  })
})

describe('debounce and flush', () => {
  it('coalesces many updates into a single write', async () => {
    vi.useFakeTimers()
    const file = join(dir, 'd.json')
    const writes = vi.fn()
    const fs: AtomicFs = { ...realFs, rename: async (a, b) => { writes(); await realFs.rename(a, b) } }
    const s = createJsonStore({ file, schema, defaults, debounceMs: 100, fs })
    for (let i = 1; i <= 50; i++) s.update((d) => { d.n = i; d.items.push(String(i)) })
    expect(s.dirty).toBe(true)
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(99)
    expect(writes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    await s.flush()
    expect(writes).toHaveBeenCalledTimes(1)
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    expect(disk.n).toBe(50)
    expect(disk.items).toHaveLength(50)
    expect(s.dirty).toBe(false)
  })

  it('flush() writes immediately and cancels the timer', async () => {
    const file = join(dir, 'f.json')
    const s = createJsonStore({ file, schema, defaults, debounceMs: 60_000 })
    s.set({ n: 5, items: [] })
    await s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(5)
  })

  it('an update during an in-flight write is not lost', async () => {
    const file = join(dir, 'g.json')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let first = true
    const fs: AtomicFs = { ...realFs, rename: async (a, b) => { if (first) { first = false; await gate } await realFs.rename(a, b) } }
    const s = createJsonStore({ file, schema, defaults, debounceMs: 0, fs })
    s.update((d) => { d.n = 1 })
    const p = s.flush()
    await new Promise((r) => setTimeout(r, 10))
    s.update((d) => { d.n = 2 })
    release()
    await p
    await s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(2)
  })

  it('flushAllStores and flushAllStoresSync cover every live store (quit path)', async () => {
    const a = createJsonStore({ file: join(dir, 'a.json'), schema, defaults, debounceMs: 60_000 })
    const b = createJsonStore({ file: join(dir, 'b.json'), schema, defaults, debounceMs: 60_000 })
    a.update((d) => { d.n = 1 })
    b.update((d) => { d.n = 2 })
    await flushAllStores()
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).n).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).n).toBe(2)
    a.update((d) => { d.n = 3 })
    flushAllStoresSync()
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).n).toBe(3)
    await a.close(); await b.close()
  })

  it('a failed write keeps data dirty, reports it, and a later flush retries', async () => {
    const file = join(dir, 'e.json')
    let fail = true
    const fs: AtomicFs = { ...realFs, rename: async (a, b) => { if (fail) throw new Error('disk full'); await realFs.rename(a, b) } }
    const onError = vi.fn()
    const s = createJsonStore({ file, schema, defaults, debounceMs: 0, fs, onError })
    s.update((d) => { d.n = 9 })
    await s.flush()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'write')
    expect(s.dirty).toBe(true)
    fail = false
    await s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(9)
  })
})

describe('memory mode (file: null)', () => {
  it('works in memory and writes zero files', async () => {
    const before = readdirSync(dir)
    const spyFs: AtomicFs = new Proxy(realFs, { get: (t, k) => { throw new Error(`fs touched: ${String(k)}`) } })
    const s = createJsonStore({ file: null, schema, defaults, debounceMs: 0, fs: spyFs })
    expect(s.memory).toBe(true)
    s.update((d) => { d.items.push('secret') })
    s.set({ n: 4, items: ['x'] })
    await s.flush()
    s.flushSync()
    await flushAllStores()
    flushAllStoresSync()
    expect(s.get()).toEqual({ n: 4, items: ['x'] })
    expect(s.dirty).toBe(false)
    expect(readdirSync(dir)).toEqual(before)
  })

  it('does not share default objects between stores', () => {
    const d = { n: 0, items: [] as string[] }
    const a = createJsonStore({ file: null, schema, defaults: d })
    const b = createJsonStore({ file: null, schema, defaults: d })
    a.update((x) => { x.items.push('a') })
    expect(b.get().items).toEqual([])
    expect(d.items).toEqual([])
  })
})
