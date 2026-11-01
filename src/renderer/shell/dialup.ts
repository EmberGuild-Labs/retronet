// Dial-up sound player (AC55). Turns the original score in @shared/dialup-score into a WebAudio graph:
//   voices -> per-segment gain envelope -> master GainNode (MASTER_GAIN) -> limiter -> destination.
// Main decides when to play (setting, incognito, mute, user-started load, throttle); this only plays.
// One play at a time; stop() fades out over 150 ms. Each play bumps `data-sound-plays` on `.rn-frame`.
import { DEFAULT_ATTACK, DEFAULT_RELEASE, DIALUP_SCORE, MASTER_GAIN, noiseSamples, scoreDuration, type Segment } from '@shared/dialup-score'

const FADE_S = 0.15

export interface DialupPlayer {
  play(): void
  stop(): void
}

export interface DialupOptions {
  /** Test hook: build the context (the harness stubs it so nothing is audible). */
  createContext?: () => AudioContext
  /** Test hook: multiplies the output level; 0 silences the shell. */
  outputGain?: number
}

export function createDialup(opts: DialupOptions = {}): DialupPlayer {
  let ctx: AudioContext | null = null
  let active: { nodes: AudioScheduledSourceNode[]; master: GainNode; timer: number } | null = null

  const ensure = (): AudioContext | null => {
    if (ctx) return ctx
    try {
      ctx = opts.createContext ? opts.createContext() : new AudioContext()
    } catch {
      ctx = null
    }
    return ctx
  }

  function teardown(a: NonNullable<typeof active>): void {
    window.clearTimeout(a.timer)
    for (const n of a.nodes) {
      try {
        n.disconnect()
      } catch {
        /* already gone */
      }
    }
    try {
      a.master.disconnect()
    } catch {
      /* already gone */
    }
    if (active === a) active = null
  }

  function schedule(c: AudioContext, seg: Segment, start: number, dest: AudioNode, nodes: AudioScheduledSourceNode[]): void {
    const t0 = start + seg.t0
    const t1 = t0 + seg.dur
    const attack = Math.min(seg.attack ?? DEFAULT_ATTACK, seg.dur / 2)
    const release = Math.min(seg.release ?? DEFAULT_RELEASE, seg.dur / 2)
    const env = c.createGain()
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(seg.gain, t0 + attack)
    env.gain.setValueAtTime(seg.gain, Math.max(t0 + attack, t1 - release))
    env.gain.linearRampToValueAtTime(0, t1)
    env.connect(dest)

    if (seg.type === 'noise' && seg.noise) {
      const n = Math.max(1, Math.round(seg.dur * c.sampleRate))
      const buf = c.createBuffer(1, n, c.sampleRate)
      buf.getChannelData(0).set(noiseSamples(seg.noise.seed, n))
      const src = c.createBufferSource()
      src.buffer = buf
      const f = c.createBiquadFilter()
      f.type = seg.noise.filter.type
      f.frequency.value = seg.noise.filter.freq
      f.Q.value = seg.noise.filter.q
      src.connect(f)
      f.connect(env)
      src.start(t0)
      src.stop(t1)
      nodes.push(src)
      return
    }

    const voice = (freq: number): OscillatorNode => {
      const o = c.createOscillator()
      o.type = seg.wave ?? 'sine'
      o.frequency.setValueAtTime(freq, t0)
      o.connect(env)
      o.start(t0)
      o.stop(t1)
      nodes.push(o)
      return o
    }

    if (seg.type === 'sweep') {
      const o = voice(seg.freqs[0]!)
      o.frequency.exponentialRampToValueAtTime(seg.freqs[1]!, t1)
    } else if (seg.type === 'fsk') {
      const o = voice(seg.freqs[0]!)
      const bits = seg.bits ?? '1'
      for (let i = 0; i < bits.length; i++) {
        o.frequency.setValueAtTime((bits[i] === '1' ? seg.freqs[0] : seg.freqs[1])!, t0 + (seg.dur * i) / bits.length)
      }
    } else {
      for (const f of seg.freqs) voice(f)
    }
  }

  function stop(): void {
    const a = active
    if (!a || !ctx) return
    active = null
    const now = ctx.currentTime
    try {
      a.master.gain.cancelScheduledValues(now)
      a.master.gain.setValueAtTime(a.master.gain.value, now)
      a.master.gain.linearRampToValueAtTime(0, now + FADE_S)
      for (const n of a.nodes) n.stop(now + FADE_S)
    } catch {
      /* nodes already ended */
    }
    window.setTimeout(() => teardown(a), FADE_S * 1000 + 50)
  }

  function play(): void {
    stop() // a new sound event cancels the previous one
    const c = ensure()
    if (!c) return
    if (c.state === 'suspended') void c.resume().catch(() => undefined)
    const master = c.createGain()
    master.gain.value = MASTER_GAIN * (opts.outputGain ?? 1)
    const limiter = c.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.1
    master.connect(limiter)
    limiter.connect(c.destination)

    const nodes: AudioScheduledSourceNode[] = []
    const start = c.currentTime + 0.03
    for (const seg of DIALUP_SCORE) schedule(c, seg, start, master, nodes)
    const entry = { nodes, master, timer: 0 }
    entry.timer = window.setTimeout(() => teardown(entry), (scoreDuration() + 0.2) * 1000)
    active = entry

    const frame = document.querySelector<HTMLElement>('.rn-frame')
    if (frame) frame.dataset.soundPlays = String(Number(frame.dataset.soundPlays ?? '0') + 1)
  }

  return { play, stop }
}
