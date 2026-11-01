import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDownloadsStore, DOWNLOADS_MAX } from '../../src/main/storage/downloads-store'
import type { DownloadItem } from '../../src/shared/types'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'rn-dl-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const NOW = 1_800_000_000_000
const item = (id: string, o: Partial<DownloadItem> = {}): DownloadItem => ({
  id, url: 'https://x/' + id, filename: id, path: '/tmp/' + id, state: 'completed', receivedBytes: 1, totalBytes: 1,
  bytesPerSecond: 0, startedAt: NOW, endedAt: NOW, error: null, ...o
})

describe('downloads store', () => {
  it('upserts, lists newest first, removes', () => {
    const d = createDownloadsStore(null, { now: () => NOW })
    d.upsert(item('a', { startedAt: 1 }))
    d.upsert(item('b', { startedAt: 2 }))
    d.upsert(item('a', { startedAt: 1, filename: 'renamed' }))
    expect(d.list().map((i) => i.id)).toEqual(['b', 'a'])
    expect(d.get('a')?.filename).toBe('renamed')
    expect(d.remove('b')).toBe(true)
    expect(d.remove('b')).toBe(false)
  })

  it('clearFinished keeps active downloads; clearRange applies the time window', () => {
    const d = createDownloadsStore(null, { now: () => NOW })
    d.upsert(item('run', { state: 'progressing', endedAt: null }))
    d.upsert(item('old', { startedAt: NOW - 30 * 3600e3 }))
    d.upsert(item('new', { startedAt: NOW - 1000 }))
    expect(d.clearRange('day')).toBe(1)
    expect(d.list().map((i) => i.id).sort()).toEqual(['old', 'run'])
    expect(d.clearFinished()).toBe(1)
    expect(d.list().map((i) => i.id)).toEqual(['run'])
  })

  it('marks downloads that were active at quit as interrupted on load', async () => {
    const file = join(dir, 'downloads.json')
    const d = createDownloadsStore(file, { debounceMs: 0 })
    d.upsert(item('run', { state: 'progressing', endedAt: null, bytesPerSecond: 50 }))
    await d.store.flush()
    const d2 = createDownloadsStore(file, { now: () => NOW })
    expect(d2.get('run')).toMatchObject({ state: 'interrupted', bytesPerSecond: 0, endedAt: NOW })
  })

  it('caps the list', () => {
    const d = createDownloadsStore(null)
    for (let i = 0; i < DOWNLOADS_MAX + 10; i++) d.upsert(item('i' + i, { startedAt: i }))
    expect(d.list()).toHaveLength(DOWNLOADS_MAX)
    expect(d.get('i0')).toBeNull()
  })

  it('memory mode writes nothing', async () => {
    const d = createDownloadsStore(null, { debounceMs: 0 })
    d.upsert(item('a'))
    await d.store.flush()
    expect(readdirSync(dir)).toEqual([])
  })
})
