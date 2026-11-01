import { describe, expect, it } from 'vitest'
import {
  DIALUP_SCORE,
  MASTER_GAIN,
  MAX_SCORE_SECONDS,
  MAX_SIMULTANEOUS_GAIN,
  MAX_VOICE_GAIN,
  maxSimultaneousGain,
  noiseSamples,
  renderScore,
  scoreDuration
} from '../../src/shared/dialup-score'

describe('dialup score', () => {
  it('has a sane total duration', () => {
    const d = scoreDuration()
    expect(d).toBeGreaterThan(2)
    expect(d).toBeLessThanOrEqual(2.8)
    expect(d).toBeLessThanOrEqual(MAX_SCORE_SECONDS)
  })

  it('keeps every segment inside the bounds and well-formed', () => {
    const d = scoreDuration()
    for (const s of DIALUP_SCORE) {
      expect(s.t0).toBeGreaterThanOrEqual(0)
      expect(s.dur).toBeGreaterThan(0)
      expect(s.t0 + s.dur).toBeLessThanOrEqual(d + 1e-9)
      expect(s.gain).toBeGreaterThan(0)
      expect(s.gain).toBeLessThanOrEqual(MAX_VOICE_GAIN)
      const a = s.attack ?? 0.008
      const r = s.release ?? 0.012
      expect(a).toBeGreaterThan(0)
      expect(r).toBeGreaterThan(0)
      expect(a + r).toBeLessThanOrEqual(s.dur)
      const need = { tone: 1, dual: 2, sweep: 2, fsk: 2, noise: 0 }[s.type]
      expect(s.freqs.length).toBe(need)
      for (const f of s.freqs) {
        expect(f).toBeGreaterThanOrEqual(20)
        expect(f).toBeLessThanOrEqual(4000)
      }
      if (s.type === 'noise') {
        expect(s.noise).toBeDefined()
        expect(Number.isInteger(s.noise!.seed)).toBe(true)
        expect(s.noise!.filter.freq).toBeGreaterThan(0)
        expect(s.noise!.filter.q).toBeGreaterThan(0)
      }
      if (s.type === 'fsk') expect(s.bits).toMatch(/^[01]+$/)
    }
  })

  it('caps simultaneous gain', () => {
    expect(maxSimultaneousGain()).toBeLessThanOrEqual(MAX_SIMULTANEOUS_GAIN)
    expect(maxSimultaneousGain()).toBeGreaterThan(0)
    expect(MASTER_GAIN).toBe(0.35)
  })

  it('is JSON-serialisable and stable', () => {
    expect(JSON.parse(JSON.stringify(DIALUP_SCORE))).toEqual(DIALUP_SCORE)
  })

  it('noise is deterministic, bounded and seed-dependent', () => {
    const a = noiseSamples(42, 512)
    const b = noiseSamples(42, 512)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(noiseSamples(43, 512))).not.toEqual(Array.from(a))
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(noiseSamples(1, 0).length).toBe(0)
  })

  it('renders deterministically, quietly and without clicks', () => {
    const r1 = renderScore(DIALUP_SCORE, 8000)
    const r2 = renderScore(DIALUP_SCORE, 8000)
    expect(Array.from(r1.slice(0, 4000))).toEqual(Array.from(r2.slice(0, 4000)))
    let peak = 0
    let maxStep = 0
    for (let i = 0; i < r1.length; i++) {
      expect(Number.isFinite(r1[i]!)).toBe(true)
      peak = Math.max(peak, Math.abs(r1[i]!))
      if (i) maxStep = Math.max(maxStep, Math.abs(r1[i]! - r1[i - 1]!))
    }
    expect(peak).toBeGreaterThan(0.01)
    expect(peak).toBeLessThanOrEqual(MAX_SIMULTANEOUS_GAIN * MASTER_GAIN * 1.5)
    expect(peak).toBeLessThan(0.3)
    // No hard discontinuities (a 2.1 kHz tone at full gain steps ~0.26*0.35 per sample at 8 kHz).
    expect(maxStep).toBeLessThan(0.2)
    expect(Math.abs(r1[0]!)).toBeLessThan(0.01)
    expect(Math.abs(r1[r1.length - 1]!)).toBeLessThan(0.01)
  })
})
