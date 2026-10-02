import { bell, Section, shelf } from './Biquad'
import { LiveLoudness } from './Loudness'
import { DelayModule } from './modules/Delay'
import { ReverbModule } from './modules/Reverb'
import { BLOCK, type DspModule } from './modules/types'
import { tauStep } from './util'
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
    const d = this.target - this.value
    // Snapped once the gap is too small to matter, as `Smoothed` does: a
    // one-pole left to itself never arrives, and the EQ below redesigns its
    // curve for as long as its gains are still creeping.
    if (!(Math.abs(d) >= 1e-7 * Math.max(1, Math.abs(this.target)))) {
      this.value = this.target
      return this.value
    }
    this.value += d * this.k
    return this.value
  }
  /** Close enough to where it is going that stepping the rest is inaudible. */
  get settled() {
    return Math.abs(this.target - this.value) < 1e-5
  }
}

const glideK = (sampleRate: number) => tauStep(GLIDE_S * sampleRate)

/**
 * A console EQ: a low shelf at 200 Hz, a bell at 1 kHz and a high shelf at
 * 5 kHz, with only the gains to turn -- the three knobs a channel strip has
 * room for. Flat, it is skipped entirely, so a strip nobody has touched
 * passes its track through sample for sample.
 *
 * Stereo, with one set of gains: the two sides always have the same curve, so
 * it is designed once and copied across rather than worked out twice.
 */
export class ThreeBand {
  private low = new Section()
  private mid = new Section()
  private high = new Section()
  private lowR = new Section()
  private midR = new Section()
  private highR = new Section()
  private g0: Glide
  private g1: Glide
  private g2: Glide
  private tuned0 = NaN
  private tuned1 = NaN
  private tuned2 = NaN
  /** The last sample through, one per side; read straight after `process`. */
  l = 0
  r = 0

  constructor(private readonly sampleRate: number) {
    const k = glideK(sampleRate)
    this.g0 = new Glide(0, k)
    this.g1 = new Glide(0, k)
    this.g2 = new Glide(0, k)
  }

  set(eq: Eq3) {
    this.g0.target = eq.low
    this.g1.target = eq.mid
    this.g2.target = eq.high
  }

  /** Flat and staying flat: nothing to do. Spelled out so asking costs nothing. */
  get flat() {
    return (
      this.g0.target === 0 && this.g1.target === 0 && this.g2.target === 0 &&
      Math.abs(this.g0.value) < 1e-4 && Math.abs(this.g1.value) < 1e-4 && Math.abs(this.g2.value) < 1e-4
    )
  }

  process(l: number, r: number) {
    const lo = this.g0.next()
    const mi = this.g1.next()
    const hi = this.g2.next()
    // Only while a gain is moving; at rest the glides hand back exactly what
    // they did last time, and the sections already hold that curve.
    if (lo !== this.tuned0 || mi !== this.tuned1 || hi !== this.tuned2) {
      this.tuned0 = lo
      this.tuned1 = mi
      this.tuned2 = hi
      shelf(this.low, this.sampleRate, 200, lo, false)
      bell(this.mid, this.sampleRate, 1000, mi, 0.9)
      shelf(this.high, this.sampleRate, Math.min(5000, this.sampleRate * 0.45), hi, true)
      this.lowR.copy(this.low)
      this.midR.copy(this.mid)
      this.highR.copy(this.high)
    }
    this.l = this.high.process(this.mid.process(this.low.process(l)))
    this.r = this.highR.process(this.midR.process(this.lowR.process(r)))
  }
}

/** The ceiling the limiter holds the mix under: -1 dBFS. */
const CEILING = Math.pow(10, -1 / 20)

/** How far ahead the limiter looks: long enough to turn down gently, short enough not to matter. */
const LOOKAHEAD_S = 0.0015

/** How long it takes to come back up once a peak has gone by. */
const RELEASE_S = 0.08

/**
 * A lookahead limiter on the master: nothing past -1 dB gets out, and nothing
 * is clipped to get there.
 *
 * The mix is delayed by a millisecond and a half, and the limiter reads the
 * undelayed signal. So it sees a peak coming before the peak reaches the
 * output, and has that long to bring the gain down -- a smooth ramp rather
 * than a step on the loud sample itself. A step in gain is a corner in the
 * waveform, and turning the gain down on one sample and back up over the next
 * hundred milliseconds is, to the ear, just a clipper with a slow release:
 * the splat on every drum hit into a hot master.
 *
 * How the ramp is built. The gain each incoming sample would need is held at
 * its lowest for the lookahead window -- so the gain is already down wherever
 * that peak will be -- and then averaged over the same window, which turns
 * the held steps into straight ramps that arrive, exactly on the peak's
 * sample, at no more than it needs. The release is a one-pole on top that can
 * only ever go slower than the ramp, never faster, so it can make the gain
 * lower but not let a peak through.
 *
 * Both sides together, so the image does not lurch. The latency is the same
 * whether it is working or not, and whether it is switched on or off, so
 * pressing the button never moves the music in time.
 */
export class Limiter {
  /** Samples of delay between what arrives and what leaves. */
  readonly latency: number
  private readonly window: number
  private readonly delayL: Float64Array
  private readonly delayR: Float64Array
  private delayAt = 0

  /**
   * The lowest gain of the last `window` samples, kept as a queue in which
   * each entry is lower than the one after it -- the usual sliding-minimum
   * trick, so finding the minimum never means reading the whole window.
   */
  private readonly minGain: Float64Array
  private readonly minAt: Float64Array
  private minHead = 0
  private minCount = 0
  private clock = 0

  /** The held minimum over the last `window` samples, and their sum, for the average. */
  private readonly box: Float64Array
  private boxAt = 0
  private boxSum: number

  private gain = 1
  private readonly release: number

  constructor(sampleRate: number) {
    this.latency = Math.max(1, Math.round(LOOKAHEAD_S * sampleRate))
    // One longer than the delay, so that the held minimum still covers a
    // peak on the very sample that peak leaves the delay.
    this.window = this.latency + 1
    this.delayL = new Float64Array(this.latency)
    this.delayR = new Float64Array(this.latency)
    this.minGain = new Float64Array(this.window)
    this.minAt = new Float64Array(this.window)
    this.box = new Float64Array(this.window).fill(1)
    this.boxSum = this.window
    this.release = tauStep(RELEASE_S * sampleRate)
  }

  /** Working, as a gain: 1 when it is doing nothing. */
  get reduction() {
    return this.gain
  }

  /**
   * One stereo sample in, the one from `latency` samples ago out, turned
   * down as far as it needs to be. Switched off, `active` false, it still
   * delays by the same amount and lets its gain drift back to unity.
   */
  process(l: number, r: number, out: { l: number; r: number }, active = true) {
    // Nothing that is not a number gets into the delay, where it would sit
    // for a millisecond and a half and then make the gain NaN for good.
    if (l - l !== 0) l = 0
    if (r - r !== 0) r = 0

    const al = l < 0 ? -l : l
    const ar = r < 0 ? -r : r
    const peak = al > ar ? al : ar
    const need = active && peak > CEILING ? CEILING / peak : 1

    // Into the sliding minimum. Whatever has fallen out of the window goes
    // from the front -- one sample a time, so at most one entry -- and
    // anything queued that is no lower than this can never be the minimum
    // again, so it goes from the back. Expiring first is what keeps the
    // queue inside its `window` slots.
    const w = this.window
    const now = this.clock++
    if (this.minCount > 0 && this.minAt[this.minHead] <= now - w) {
      this.minHead = this.minHead + 1 === w ? 0 : this.minHead + 1
      this.minCount--
    }
    while (this.minCount > 0) {
      const last = (this.minHead + this.minCount - 1) % w
      if (this.minGain[last] < need) break
      this.minCount--
    }
    const slot = (this.minHead + this.minCount) % w
    this.minGain[slot] = need
    this.minAt[slot] = now
    this.minCount++
    const held = this.minGain[this.minHead]

    // Averaged over the same window. The running sum is rebuilt from scratch
    // once a lap, so rounding cannot creep in over an hour of music.
    this.boxSum += held - this.box[this.boxAt]
    this.box[this.boxAt] = held
    if (++this.boxAt === w) {
      this.boxAt = 0
      let sum = 0
      for (let i = 0; i < w; i++) sum += this.box[i]
      this.boxSum = sum
    }
    let target = this.boxSum / w
    if (target > 1) target = 1

    // Down as fast as the ramp asks, back up at the release.
    this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release

    const i = this.delayAt
    let ol = this.delayL[i] * this.gain
    let or = this.delayR[i] * this.gain
    this.delayL[i] = l
    this.delayR[i] = r
    if (++this.delayAt === this.latency) this.delayAt = 0

    // The ramp arrives at exactly the gain it needs, so rounding in the last
    // bit can leave a peak a hair over. Held to the ceiling, which touches
    // nothing but that hair.
    if (active) {
      if (ol > CEILING) ol = CEILING
      else if (ol < -CEILING) ol = -CEILING
      if (or > CEILING) or = CEILING
      else if (or < -CEILING) or = -CEILING
    }
    out.l = ol
    out.r = or
  }
}

/** Below this a return is silence: -120 dB, far under anything a speaker makes of it. */
const QUIET = 1e-6

/**
 * How long a return must have been fed nothing and said nothing before it
 * stops running: long enough that the tail really has gone, not a gap
 * between two notes of a sparse send.
 */
const QUIET_FOR_S = 0.25

/**
 * A rack module run on its own, outside any patch, with blocks of its own for
 * its jacks. How the console borrows the rack's Space and Delay rather than
 * having a second reverb and a second echo.
 *
 * It rests when there is nothing for it to do. A return fed nothing whose
 * tail has died away is a reverb working out silence at 48,000 samples a
 * second, on every song that leaves a send turned down -- so once it has been
 * quiet for a moment it is skipped, and put out silence, until something is
 * sent to it again. What it held when it stopped is under -120 dB, and it
 * carries on from there.
 */
class Hosted {
  readonly inputs: Float32Array[]
  readonly outputs: Float32Array[]
  /** Samples it has been fed nothing and said nothing for. */
  private quiet = 0
  private readonly quietFor: number

  constructor(
    readonly mod: DspModule,
    inputs: number,
    outputs: number,
    params: number[],
    seed: number,
    id: string,
    sampleRate: number,
  ) {
    this.inputs = Array.from({ length: inputs }, () => new Float32Array(BLOCK))
    this.outputs = Array.from({ length: outputs }, () => new Float32Array(BLOCK))
    mod.ins = Int32Array.from({ length: inputs }, (_, i) => 1 + i)
    mod.outs = Int32Array.from({ length: outputs }, (_, i) => 1 + inputs + i)
    mod.inputs = this.inputs
    mod.outputs = this.outputs
    mod.params = Float32Array.from(params)
    mod.seedFrom(seed, id)
    mod.prepare()
    // Longer for the Delay: silent between two echoes is not empty.
    this.quietFor = Math.round((QUIET_FOR_S + mod.memory) * sampleRate)
  }

  /**
   * The first `n` samples of the block, from `bus` at `offset` into its
   * first jack. Its outputs hold the answer; silence while it rests.
   */
  run(bus: Float32Array, offset: number, n: number) {
    const input = this.inputs[0]
    let fed = false
    for (let i = 0; i < n; i++) {
      const x = bus[offset + i]
      input[i] = x
      if (x !== 0) fed = true
    }
    if (!fed && this.quiet >= this.quietFor) {
      for (const out of this.outputs) out.fill(0, 0, n)
      return
    }
    this.mod.processBlock(0, n)
    let loud = fed
    if (!loud) {
      for (const out of this.outputs) {
        for (let i = 0; i < n; i++) {
          const y = out[i]
          if (y > QUIET || y < -QUIET) {
            loud = true
            break
          }
        }
        if (loud) break
      }
    }
    this.quiet = loud ? 0 : this.quiet + n
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
  readonly eq: ThreeBand
  readonly gain: Glide
  readonly pan: Glide
  readonly space: Glide
  readonly delay: Glide
  /** The loudest it has been since the meter last asked. */
  peak = 0

  constructor(sampleRate: number) {
    const k = glideK(sampleRate)
    this.eq = new ThreeBand(sampleRate)
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
    this.eq.set(s.eq ?? { low: 0, mid: 0, high: 0 })
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
  private eq: ThreeBand
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
    this.space = new Hosted(new ReverbModule(ctx), 1, 2, [d.space.size, d.space.decay, d.space.damping, 1], seed, 'console.space', sampleRate)
    this.delay = new Hosted(new DelayModule(ctx), 2, 2, [d.delay.time, 0, d.delay.feedback, d.delay.damping, 1], seed, 'console.delay', sampleRate)
    const k = glideK(sampleRate)
    this.spaceLevel = new Glide(d.space.level, k)
    this.delayLevel = new Glide(d.delay.level, k)
    this.eq = new ThreeBand(sampleRate)
    this.balance = new Glide(0, k)
    this.level = new Glide(1, k)
    this.limiter = new Limiter(sampleRate)
    this.loudness = new LiveLoudness(sampleRate)
  }

  /**
   * How many samples late the desk puts the mix out: the limiter's
   * lookahead. There whether the limiter is switched on or not, so that the
   * button never shifts the music, and there for a render that leaves the
   * master bus out too, so that stems line up with the mix they came from.
   */
  get latency() {
    return this.limiter.latency
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
    this.eq.set(c.master.eq)
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
      const spaceL = s.outputs[0]
      const spaceR = s.outputs[1]
      // Delay's second output is its wet signal alone.
      const echoes = d.outputs[1]
      for (let at = 0; at < n; at += BLOCK) {
        const m = n - at < BLOCK ? n - at : BLOCK
        s.run(this.spaceBus, at, m)
        d.run(this.delayBus, at, m)
        for (let i = 0; i < m; i++) {
          const sl = this.spaceLevel.next()
          const dl = this.delayLevel.next()
          const echo = echoes[i] * dl
          left[at + i] += spaceL[i] * sl + echo
          right[at + i] += spaceR[i] * sl + echo
        }
      }
    }
    if (!routing.master) {
      // No master bus, but still its delay. A stem is meant to be laid
      // against the full bounce and line up with it, and the full bounce is
      // the limiter's lookahead late; a stem that was not would sit a
      // millisecond and a half early, which is a comb filter the moment the
      // two are played together. Switched off, the limiter is exactly that
      // delay and nothing else: its gain never leaves one.
      for (let i = 0; i < n; i++) {
        this.limiter.process(left[i], right[i], this.out, false)
        left[i] = this.out.l
        right[i] = this.out.r
      }
      return
    }

    const eqFlat = this.eq.flat
    const limiting = this.limiting
    for (let i = 0; i < n; i++) {
      let l = left[i]
      let r = right[i]
      if (!eqFlat) {
        this.eq.process(l, r)
        l = this.eq.l
        r = this.eq.r
      }
      const b = this.balance.next()
      const g = this.level.next()
      l *= (b > 0 ? 1 - b : 1) * g
      r *= (b < 0 ? 1 + b : 1) * g
      this.limiter.process(l, r, this.out, limiting)
      l = this.out.l
      r = this.out.r
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
