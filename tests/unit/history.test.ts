import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHistoryStore, groupByDay, HISTORY_MAX_AGE_MS, HISTORY_MAX_ENTRIES } from '../../src/main/storage/history-store'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'rn-hist-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const NOW = Date.UTC(2026, 5, 15, 12)
const H = 3600e3

describe('history store', () => {
  it('records visits with monotonic ids that are never reused', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    const a = h.recordVisit('https://a.test/', 'A')
    const b = h.recordVisit('https://b.test/', 'B')
    expect(b.id).toBe(a.id + 1)
    h.delete(b.id)
    expect(h.recordVisit('https://c.test/', 'C').id).toBe(b.id + 1)
  })

  it('queries newest first, searches title and url, and pages', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    for (let i = 0; i < 10; i++) h.recordVisit(`https://site${i}.test/`, i % 2 ? 'Odd page' : 'Even page', NOW - (10 - i))
    const p1 = h.query({ limit: 4 })
    expect(p1.entries.map((e) => e.url)[0]).toBe('https://site9.test/')
    expect(p1).toMatchObject({ total: 10, hasMore: true })
    expect(h.query({ offset: 8, limit: 4 })).toMatchObject({ hasMore: false })
    expect(h.query({ offset: 8, limit: 4 }).entries).toHaveLength(2)
    expect(h.query({ text: 'ODD' }).total).toBe(5)
    expect(h.query({ text: 'site3' }).entries).toHaveLength(1)
  })

  it('updates the title of the latest entry for a url', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    h.recordVisit('https://a.test/', 'old')
    h.recordVisit('https://a.test/', 'old')
    expect(h.updateTitle('https://a.test/', 'new')).toBe(true)
    expect(h.query().entries.map((e) => e.title)).toEqual(['new', 'old'])
    expect(h.updateTitle('https://zzz/', 'x')).toBe(false)
  })

  it('deletes one, a range, and clears by time range', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    h.recordVisit('https://old.test/', 'old', NOW - 3 * 24 * H)
    h.recordVisit('https://day.test/', 'day', NOW - 5 * H)
    const e = h.recordVisit('https://hour.test/', 'hour', NOW - 10 * 60e3)
    expect(h.clear('hour')).toBe(1)
    expect(h.query({ text: 'hour' }).total).toBe(0)
    h.recordVisit('https://x.test/', 'x', NOW - H / 2)
    expect(h.deleteRange(NOW - 6 * H, NOW)).toBe(2)
    expect(h.count()).toBe(1)
    expect(h.delete(e.id)).toBe(false)
    expect(h.clear('all')).toBe(1)
    expect(h.count()).toBe(0)
  })

  it('suggests unique urls by host prefix or title, most recent first', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    h.recordVisit('https://www.example.com/a', 'Alpha', NOW - 3)
    h.recordVisit('https://example.com/a', 'Alpha 2', NOW - 2)
    h.recordVisit('https://example.com/a', 'Alpha 2', NOW - 1)
    h.recordVisit('https://other.test/', 'About examples', NOW)
    const s = h.suggest('exam')
    expect(s.map((x) => x.url)).toEqual(['https://other.test/', 'https://example.com/a', 'https://www.example.com/a'])
    expect(h.suggest('')).toEqual([])
  })

  it('enforces the 90 day and 30k caps', () => {
    const h = createHistoryStore(null, { now: () => NOW })
    h.recordVisit('https://ancient.test/', 'x', NOW - HISTORY_MAX_AGE_MS - 1000)
    h.recordVisit('https://fresh.test/', 'x', NOW)
    expect(h.count()).toBe(1)
    const big = createHistoryStore(null, { now: () => NOW })
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 5; i++) big.recordVisit('https://a.test/' + i, 't', NOW)
    expect(big.count()).toBe(HISTORY_MAX_ENTRIES)
    expect(big.query({ limit: 1 }).entries[0]!.id).toBe(HISTORY_MAX_ENTRIES + 5)
  })

  it('prunes aged entries on load and keeps the counter ahead', async () => {
    const file = join(dir, 'history.json')
    const h = createHistoryStore(file, { now: () => NOW, debounceMs: 0 })
    h.recordVisit('https://ancient.test/', 'x', NOW - HISTORY_MAX_AGE_MS - 5000)
    h.recordVisit('https://fresh.test/', 'x', NOW)
    await h.store.flush()
    const h2 = createHistoryStore(file, { now: () => NOW })
    expect(h2.count()).toBe(1)
    expect(h2.recordVisit('https://n.test/', 'n').id).toBe(3)
  })

  it('groups by local day, preserving order', () => {
    const d1 = new Date(2026, 5, 15, 10).getTime()
    const d2 = new Date(2026, 5, 14, 23).getTime()
    const h = createHistoryStore(null, { now: () => d1 })
    h.recordVisit('https://a/', 'a', d2)
    h.recordVisit('https://b/', 'b', d1 - 1000)
    h.recordVisit('https://c/', 'c', d1)
    const g = groupByDay(h.query().entries)
    expect(g.map((x) => [x.day, x.entries.length])).toEqual([['2026-06-15', 2], ['2026-06-14', 1]])
  })

  it('memory mode writes nothing', async () => {
    const h = createHistoryStore(null, { debounceMs: 0 })
    h.recordVisit('https://a.test/', 'a')
    await h.store.flush()
    expect(readdirSync(dir)).toEqual([])
    expect(h.store.memory).toBe(true)
  })
})
