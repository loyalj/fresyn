import { bell, Section, shelf } from './Biquad'
import { LiveLoudness } from './Loudness'
import { DelayModule } from './modules/Delay'
import { ReverbModule } from './modules/Reverb'
import type { DspModule } from './modules/types'
import type { Console, Eq3 } from '../song/types'

/**
 * The song's mixing desk, on the audio side: every track's channel strip, two
 * shared effects the strips send to, and the master bus.
 *
 * It lives beside the tracks in `SongEngine` rather than in the UI, so that
 * everything that plays a song -- the speakers, a bounce, a stem, a game --
 * hears exactly the same mix. Nothing here allocates once it is running.
 */

/** How quickly a fader, a pan or a send glides to where it was set: about 10 ms. */
const GLIDE_S = 0.01

/** A value that glides to its target rather than stepping, so nothing zips. */
class Glide {
  value: number
  target: number
  constructor(v: number, private readonly k: number) {
    this.value = v
    this.target = v
  }
  next() {
    this.value += (this.target - this.value) * this.k
    return this.value
  }
  /** Close enough to where it is going that stepping the rest is inaudible. */
  get settled() {
    return Math.abs(this.target - this.value) < 1e-5
  }
}

const glideK = (sampleRate: number) => 1 - Math.exp(-1 / (GLIDE_S * sampleRate))

/**
 * A console EQ: a low shelf at 200 Hz, a bell at 1 kHz and a high shelf at
 * 5 kHz, with only the gains to turn -- the three knobs a channel strip has
 * room for. Flat, it is skipped entirely, so a strip nobody has touched
 * passes its track through sample for sample.
 */
export class ThreeBand {
  private low = new Section()
  private mid = new Section()
  private high = new Section()
  private gains: Glide[]
  private tuned = [NaN, NaN, NaN]

  constructor(private readonly sampleRate: number) {
    const k = glideK(sampleRate)
    this.gains = [new Glide(0, k), new Glide(0, k), new Glide(0, k)]
  }

  set(eq: Eq3) {
    this.gains[0].target = eq.low
    this.gains[1].target = eq.mid
    this.gains[2].target = eq.high
  }

  /** Flat and staying flat: nothing to do. */
  get flat() {
    return this.gains.every((g) => g.target === 0 && Math.abs(g.value) < 1e-4)
  }

  process(x: number) {
    const lo = this.gains[0].next()
    const mi = this.gains[1].next()
    const hi = this.gains[2].next()
    if (lo !== this.tuned[0] || mi !== this.tuned[1] || hi !== this.tuned[2]) {
      this.tuned[0] = lo
      this.tuned[1] = mi
      this.tuned[2] = hi
      shelf(this.low, this.sampleRate, 200, lo, false)
      bell(this.mid, this.sampleRate, 1000, mi, 0.9)
      shelf(this.high, this.sampleRate, Math.min(5000, this.sampleRate * 0.45), hi, true)
    }
    return this.high.process(this.mid.process(this.low.process(x)))
  }
}

/** The ceiling the limiter holds the mix under: -1 dBFS. */
const CEILING = Math.pow(10, -1 / 20)

/**
 * A brickwall on the master: the moment a sample would go past -1 dB the
 * whole mix is turned down by exactly enough, and it comes back up over a
 * tenth of a second. Both sides together, so the image does not lurch.
 *
 * No lookahead, which is what keeps it free of latency; a sample that would
 * clip is instead brought down on the very sample it arrives, so nothing
 * ever passes the ceiling.
 */
export class Limiter {
  private gain = 1
  private readonly recover: number
  constructor(sampleRate: number) {
    this.recover = 1 - Math.exp(-1 / (0.1 * sampleRate))
  }
  /** Working, as a gain: 1 when it is doing nothing. */
  get reduction() {
    return this.gain
  }
  process(l: number, r: number, out: { l: number; r: number }) {
    const peak = Math.max(Math.abs(l), Math.abs(r))
    const allowed = peak > CEILING ? CEILING / peak : 1
    this.gain = Math.min(allowed, this.gain + (1 - this.gain) * this.recover)
    out.l = l * this.gain
    out.r = r * this.gain
  }
}

/**
 * A rack module run on its own, outside any patch: its inputs and outputs are
 * slots in a small array of its own. How the console borrows the rack's
 * Space and Delay rather than having a second reverb and a second echo.
 */
class Hosted {
  readonly slots: Float32Array
  constructor(
    readonly mod: DspModule,
    inputs: number,
    outputs: number,
    params: number[],
    seed: number,
    id: string,
  ) {
    this.slots = new Float32Array(1 + inputs + outputs)
    mod.ins = Int32Array.from({ length: inputs }, (_, i) => 1 + i)
    mod.outs = Int32Array.from({ length: outputs }, (_, i) => 1 + inputs + i)
    mod.params = Float32Array.from(params)
    mod.seedFrom(seed, id)
    mod.prepare()
  }
}

/** Which parts of the desk a render goes through; a stem leaves some out. */
export interface Routing {
  /** Each track's EQ, pan and fader. */
  strips: boolean
  /** The sends, and the effects they feed. */
  sends: boolean
  /** The master bus: EQ, balance, level, limiter. */
  master: boolean
}

export const FULL_ROUTING: Routing = { strips: true, sends: true, master: true }

/** One track's channel. */
export class Strip {
  readonly eqL: ThreeBand
  readonly eqR: ThreeBand
  readonly gain: Glide
  readonly pan: Glide
  readonly space: Glide
  readonly delay: Glide
  /** The loudest it has been since the meter last asked. */
  peak = 0

  constructor(sampleRate: number) {
    const k = glideK(sampleRate)
    this.eqL = new ThreeBand(sampleRate)
    this.eqR = new ThreeBand(sampleRate)
    this.gain = new Glide(1, k)
    this.pan = new Glide(0, k)
    this.space = new Glide(0, k)
    this.delay = new Glide(0, k)
  }

  set(s: { gain: number; pan?: number; eq?: Eq3; space?: number; delay?: number }, first = false) {
    this.gain.target = s.gain
    this.pan.target = s.pan ?? 0
    this.space.target = s.space ?? 0
    this.delay.target = s.delay ?? 0
    const eq = s.eq ?? { low: 0, mid: 0, high: 0 }
    this.eqL.set(eq)
    this.eqR.set(eq)
    // A strip that has just appeared starts where it was set, rather than
    // fading up from unity.
    if (first) {
      for (const g of [this.gain, this.pan, this.space, this.delay]) g.value = g.target
    }
  }
}

/**
 * Where the tracks meet: the send buses, the two effect returns, and the
 * master bus. `SongEngine` adds each track in through its strip; this does
 * everything after.
 */
export class Desk {
  /** What the strips sent this block, mono, one bus per effect. */
  spaceBus = new Float32Array(128)
  delayBus = new Float32Array(128)

  private space: Hosted
  private delay: Hosted
  private spaceLevel: Glide
  private delayLevel: Glide
  private eqL: ThreeBand
  private eqR: ThreeBand
  private balance: Glide
  private level: Glide
  private limiter: Limiter
  private limiting = true
  private readonly out = { l: 0, r: 0 }
  readonly loudness: LiveLoudness
  peak = 0

  constructor(sampleRate: number, seed: number) {
    const ctx = { sampleRate }
    const d = { ...DEFAULT }
    // The rack's own Space and Delay, wet only: a return is all effect, and
    // how much of it is heard is the return's level.
    this.space = new Hosted(new ReverbModule(ctx), 1, 2, [d.space.size, d.space.decay, d.space.damping, 1], seed, 'console.space')
    this.delay = new Hosted(new DelayModule(ctx), 2, 2, [d.delay.time, 0, d.delay.feedback, d.delay.damping, 1], seed, 'console.delay')
    const k = glideK(sampleRate)
    this.spaceLevel = new Glide(d.space.level, k)
    this.delayLevel = new Glide(d.delay.level, k)
    this.eqL = new ThreeBand(sampleRate)
    this.eqR = new ThreeBand(sampleRate)
    this.balance = new Glide(0, k)
    this.level = new Glide(1, k)
    this.limiter = new Limiter(sampleRate)
    this.loudness = new LiveLoudness(sampleRate)
  }

  set(c: Console) {
    const sp = this.space.mod.params
    sp[0] = c.space.size
    sp[1] = c.space.decay
    sp[2] = c.space.damping
    const dp = this.delay.mod.params
    dp[0] = c.delay.time
    dp[2] = Math.min(0.95, c.delay.feedback)
    dp[3] = c.delay.damping
    this.spaceLevel.target = c.space.level
    this.delayLevel.target = c.delay.level
    this.eqL.set(c.master.eq)
    this.eqR.set(c.master.eq)
    this.balance.target = c.master.balance
    this.level.target = c.master.level
    this.limiting = c.master.limiter
  }

  /** Room for a block of this length on the send buses, cleared. */
  begin(n: number) {
    if (this.spaceBus.length < n) {
      this.spaceBus = new Float32Array(n)
      this.delayBus = new Float32Array(n)
    }
    this.spaceBus.fill(0, 0, n)
    this.delayBus.fill(0, 0, n)
  }

  /**
   * The returns added in, then the master bus, over a mix the strips have
   * already summed into `left` and `right`.
   *
   * The effects run whether or not anything is being sent this block, so a
   * tail rings out after the last send rather than stopping dead.
   */
  finish(left: Float32Array, right: Float32Array, n: number, routing: Routing) {
    if (routing.sends) {
      const s = this.space
      const d = this.delay
      for (let i = 0; i < n; i++) {
        s.slots[1] = this.spaceBus[i]
        s.mod.process(s.slots)
        d.slots[1] = this.delayBus[i]
        d.mod.process(d.slots)
        const sl = this.spaceLevel.next()
        const dl = this.delayLevel.next()
        // Delay's second output is its wet signal alone.
        const echo = d.slots[4] * dl
        left[i] += s.slots[2] * sl + echo
        right[i] += s.slots[3] * sl + echo
      }
    }
    if (!routing.master) return

    const eqFlat = this.eqL.flat
    for (let i = 0; i < n; i++) {
      let l = left[i]
      let r = right[i]
      if (!eqFlat) {
        l = this.eqL.process(l)
        r = this.eqR.process(r)
      }
      const b = this.balance.next()
      const g = this.level.next()
      l *= (b > 0 ? 1 - b : 1) * g
      r *= (b < 0 ? 1 + b : 1) * g
      if (this.limiting) {
        this.limiter.process(l, r, this.out)
        l = this.out.l
        r = this.out.r
      }
      left[i] = l
      right[i] = r
      const a = Math.max(Math.abs(l), Math.abs(r))
      if (a > this.peak) this.peak = a
      this.loudness.push(l, r)
    }
  }
}

/** What a desk starts as before it is told anything, so a new one sounds right at once. */
const DEFAULT = {
  space: { size: 0.6, decay: 2.2, damping: 0.4, level: 1 },
  delay: { time: 0.375, feedback: 0.35, damping: 0.3, level: 1 },
}
