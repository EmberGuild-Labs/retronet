/**
 * Original dial-up style sound score (pure data, no Electron/DOM imports).
 *
 * A short handshake-STYLE sequence composed from generic telephony elements:
 * a dial tone, DTMF digit pairs (public standard frequencies), an answer
 * tone, a warbling negotiation (alternating FSK, chirps, band-passed noise
 * bursts) and a settling hiss. Nothing here is sampled, traced or timed from
 * any recording; the timings and note choices are ours.
 *
 * The shell player (src/renderer/shell/dialup.ts) turns this into a WebAudio
 * graph: OscillatorNode / noise AudioBuffer from `noiseSamples` / BiquadFilter,
 * each through a per-segment gain envelope, then a master GainNode set to
 * MASTER_GAIN and a limiter. `renderScore` is a reference renderer used by
 * tests; the player does not need it.
 */

export type SegmentType = 'tone' | 'dual' | 'sweep' | 'noise' | 'fsk'

export interface NoiseFilter {
  type: 'bandpass' | 'highpass' | 'lowpass'
  /** Centre / corner frequency in Hz. */
  freq: number
  q: number
}

export interface Segment {
  /** Start, seconds from score start. */
  t0: number
  /** Duration, seconds. */
  dur: number
  type: SegmentType
  /**
   * tone:  [f]            one sine at f Hz
   * dual:  [f1, f2]       two simultaneous sines (DTMF-style pair)
   * sweep: [from, to]     exponential glide from -> to over dur
   * fsk:   [mark, space]  alternates per symbol (see `bits`)
   * noise: []             unused (see `noise`)
   */
  freqs: readonly number[]
  /** Peak gain PER VOICE (a `dual` has two voices), before MASTER_GAIN. */
  gain: number
  /** Linear fade in, seconds. Default DEFAULT_ATTACK. */
  attack?: number
  /** Linear fade out, seconds. Default DEFAULT_RELEASE. */
  release?: number
  /** Oscillator shape for tone/dual/sweep/fsk. Default 'sine'. */
  wave?: 'sine' | 'triangle'
  /** fsk only: symbol string of '1' (mark) / '0' (space), spread evenly over dur. */
  bits?: string
  /** noise only. */
  noise?: { seed: number; filter: NoiseFilter }
}

export const MASTER_GAIN = 0.35
export const MAX_SCORE_SECONDS = 3.0
export const MAX_VOICE_GAIN = 0.3
export const MAX_SIMULTANEOUS_GAIN = 0.5
export const DEFAULT_ATTACK = 0.008
export const DEFAULT_RELEASE = 0.012

// DTMF row/column frequencies (public telephony standard).
const ROW = [697, 770, 852, 941] as const
const COL = [1209, 1336, 1477] as const
const DIGITS: ReadonlyArray<readonly [number, number]> = [
  [ROW[0], COL[1]],
  [ROW[2], COL[0]],
  [ROW[1], COL[2]],
  [ROW[3], COL[1]],
  [ROW[0], COL[2]],
  [ROW[2], COL[1]],
  [ROW[1], COL[0]]
]

function build(): Segment[] {
  const s: Segment[] = []

  // 1. Dial tone: 350 + 440 Hz pair.
  s.push({ t0: 0, dur: 0.3, type: 'dual', freqs: [350, 440], gain: 0.1, attack: 0.02, release: 0.02 })

  // 2. Seven digit pairs, 60 ms on / 35 ms off.
  let t = 0.34
  for (const [lo, hi] of DIGITS) {
    s.push({ t0: round(t), dur: 0.06, type: 'dual', freqs: [lo, hi], gain: 0.1, attack: 0.005, release: 0.008 })
    t += 0.095
  }
  // t is now ~1.005; short silence, then the answer tone.

  // 3. Answer tone: 2100 Hz, split in two halves with a short gap (a coarse stand-in for phase flips).
  s.push({ t0: 1.1, dur: 0.2, type: 'tone', freqs: [2100], gain: 0.18, attack: 0.015, release: 0.01 })
  s.push({ t0: 1.32, dur: 0.18, type: 'tone', freqs: [2100], gain: 0.18, attack: 0.01, release: 0.03 })

  // 4. Negotiation: alternating FSK, chirps and filtered noise bursts.
  s.push({ t0: 1.52, dur: 0.24, type: 'fsk', freqs: [1270, 1070], gain: 0.12, bits: '10110010', wave: 'triangle' })
  s.push({ t0: 1.54, dur: 0.1, type: 'noise', freqs: [], gain: 0.1, attack: 0.01, release: 0.03, noise: { seed: 1101, filter: { type: 'bandpass', freq: 1800, q: 3 } } })
  s.push({ t0: 1.78, dur: 0.12, type: 'sweep', freqs: [900, 2400], gain: 0.14, attack: 0.01, release: 0.02 })
  s.push({ t0: 1.92, dur: 0.22, type: 'fsk', freqs: [2225, 2025], gain: 0.12, bits: '0111010011', wave: 'triangle' })
  s.push({ t0: 1.95, dur: 0.12, type: 'noise', freqs: [], gain: 0.12, attack: 0.01, release: 0.04, noise: { seed: 2202, filter: { type: 'bandpass', freq: 2600, q: 2 } } })
  s.push({ t0: 2.16, dur: 0.1, type: 'sweep', freqs: [2200, 700], gain: 0.14, attack: 0.01, release: 0.02 })
  s.push({ t0: 2.28, dur: 0.2, type: 'fsk', freqs: [1200, 2200], gain: 0.1, bits: '11010001', wave: 'triangle' })
  s.push({ t0: 2.3, dur: 0.14, type: 'noise', freqs: [], gain: 0.1, attack: 0.01, release: 0.05, noise: { seed: 3303, filter: { type: 'bandpass', freq: 1500, q: 1.5 } } })

  // 5. Settling hiss, fading out.
  s.push({ t0: 2.5, dur: 0.28, type: 'noise', freqs: [], gain: 0.14, attack: 0.03, release: 0.2, noise: { seed: 4404, filter: { type: 'highpass', freq: 2500, q: 0.7 } } })
  return s
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

export const DIALUP_SCORE: readonly Segment[] = Object.freeze(build().map((x) => Object.freeze(x)))

/** End time of the last segment, seconds. */
export function scoreDuration(score: readonly Segment[] = DIALUP_SCORE): number {
  let end = 0
  for (const s of score) end = Math.max(end, s.t0 + s.dur)
  return end
}

function voices(s: Segment): number {
  return s.type === 'dual' ? 2 : 1
}

/** Largest sum of peak voice gains active at the same instant (pre-master). */
export function maxSimultaneousGain(score: readonly Segment[] = DIALUP_SCORE): number {
  let max = 0
  for (const a of score) {
    // The sum only changes at segment starts, so checking each start is enough.
    let sum = 0
    for (const b of score) {
      if (b.t0 <= a.t0 && a.t0 < b.t0 + b.dur) sum += b.gain * voices(b)
    }
    max = Math.max(max, sum)
  }
  return max
}

/** Deterministic noise in [-1, 1] (mulberry32). Same seed and n give identical output. */
export function noiseSamples(seed: number, n: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(n)))
  let a = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

function envelope(s: Segment, tl: number): number {
  const a = s.attack ?? DEFAULT_ATTACK
  const r = s.release ?? DEFAULT_RELEASE
  let e = 1
  if (a > 0 && tl < a) e = tl / a
  const left = s.dur - tl
  if (r > 0 && left < r) e = Math.min(e, left / r)
  return Math.max(0, e)
}

function biquad(type: NoiseFilter['type'], freq: number, q: number, fs: number) {
  const w = (2 * Math.PI * freq) / fs
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  let b0: number, b1: number, b2: number
  if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2
  }
  const a0 = 1 + alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

/**
 * Reference renderer: mixes the score to mono samples (MASTER_GAIN applied).
 * Meant for tests and tooling; the shell player uses WebAudio nodes instead.
 */
export function renderScore(score: readonly Segment[] = DIALUP_SCORE, sampleRate = 8000): Float32Array {
  const out = new Float32Array(Math.ceil(scoreDuration(score) * sampleRate) + 1)
  for (const s of score) {
    const start = Math.round(s.t0 * sampleRate)
    const n = Math.round(s.dur * sampleRate)
    let noise: Float32Array | null = null
    let f: ReturnType<typeof biquad> | null = null
    if (s.type === 'noise' && s.noise) {
      noise = noiseSamples(s.noise.seed, n)
      f = biquad(s.noise.filter.type, s.noise.filter.freq, s.noise.filter.q, sampleRate)
    }
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    const phase = [0, 0]
    for (let i = 0; i < n && start + i < out.length; i++) {
      const tl = i / sampleRate
      const env = envelope(s, tl) * s.gain
      let v = 0
      if (noise && f) {
        const x = noise[i]!
        const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
        x2 = x1; x1 = x; y2 = y1; y1 = y
        v = y
      } else {
        let freqs: number[]
        if (s.type === 'sweep') {
          const from = s.freqs[0]!
          const to = s.freqs[1]!
          freqs = [from * Math.pow(to / from, tl / s.dur)]
        } else if (s.type === 'fsk') {
          const bits = s.bits ?? '1'
          const bit = bits.charAt(Math.min(bits.length - 1, Math.floor((tl / s.dur) * bits.length)))
          freqs = [(bit === '1' ? s.freqs[0] : s.freqs[1])!]
        } else {
          freqs = [...s.freqs]
        }
        freqs.forEach((fr, k) => {
          phase[k]! += (2 * Math.PI * fr) / sampleRate
          const p = phase[k]!
          v += s.wave === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(p)) : Math.sin(p)
        })
      }
      out[start + i]! += v * env * MASTER_GAIN
    }
  }
  return out
}
