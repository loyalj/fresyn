import { DcBlocker } from '../DcBlocker'
import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_DECAY = 0
const P_TENSION = 1
const P_DRIP = 2
const P_TONE = 3
const P_MIX = 4

const IN_SIGNAL = 0

const OUT_L = 0
const OUT_R = 1

/**
 * How long a trip down a spring and back takes, slack to taut: a loose spring
 * is a long one. The second spring is longer by a ratio that shares nothing
 * with the first, so their echoes never line up.
 */
const LOOSE_S = 0.075
const TAUT_S = 0.028
const SECOND = 1.137
/** All-pass stages per spring: what smears each echo into a chirp. */
const STAGES = 24
/**
 * Each stage's delay is stretched over several samples, which multiplies how
 * far it can spread an echo -- one-sample stages smear it over a millisecond,
 * too little to hear as a chirp -- and puts the most delay at the frequency
 * where the stretched stage turns half a cycle, `sr / (2 M)`. Chosen per rate
 * so that lands here, near the top of what a tank passes: below it, the
 * higher, the later.
 */
const CHIRP_TOP_HZ = 4500
/** How far Drip bends the all-passes. Kept under one, where they are stable. */
const MAX_DRIP = 0.75
/**
 * The tank's top end, where Tone is all the way up, and how far down it goes.
 * Not much above the chirp's top: past it, a stretched all-pass mirrors itself.
 */
const TOP_HZ = 5000
const TONE_OCTAVES = 3.5
/** A trip's feedback is held under this, so Decay can only ever be a decay. */
const MAX_FEEDBACK = 0.98
/** How slowly Tension moves, since it moves where each spring is read. */
const TENSION_GLIDE_MS = 60

/** One spring: a delay with a chain of all-passes in its loop. */
class SpringLine {
  readonly line: DelayLine
  private readonly ap: Float64Array
  private readonly stretch: number
  private at = 0
  private lp = 0
  private dc: DcBlocker
  private out = 0

  constructor(maxSamples: number, sr: number) {
    this.line = new DelayLine(maxSamples)
    this.dc = new DcBlocker(sr)
    this.stretch = Math.max(1, Math.round(sr / (2 * CHIRP_TOP_HZ)))
    this.ap = new Float64Array(STAGES * this.stretch)
  }

  /**
   * One sample: what goes in, plus the last trip fed back, through the
   * dispersion and the damping, into the line.
   *
   * The all-passes are a chain with one coefficient, which delays the top
   * more than the low end: an impulse comes back as a chirp, lows first and
   * highs after, the drip a spring tank is known for. Each stage is
   * y = a (x - y[n-M]) + x[n-M], in transposed form, M samples a stage.
   */
  step(x: number, length: number, feedback: number, drip: number, damp: number) {
    let s = x + this.out * feedback
    // The tank cannot hold more than its wire will carry: a soft limit in the
    // loop keeps a long Decay fed a loud signal from running away.
    s = s / (1 + Math.abs(s) * 0.25)
    const ap = this.ap
    const at = this.at
    const m = this.stretch
    for (let k = at; k < ap.length; k += m) {
      const y = drip * s + ap[k]
      ap[k] = s - drip * y
      s = y
    }
    this.at = at + 1 < m ? at + 1 : 0
    this.lp += (s - this.lp) * damp
    this.line.push(this.dc.process(this.lp))
    this.out = this.line.read(length)
    return this.out
  }

  flush() {
    for (let k = 0; k < this.ap.length; k++) if (Math.abs(this.ap[k]) < 1e-20) this.ap[k] = 0
    if (Math.abs(this.lp) < 1e-20) this.lp = 0
  }
}

/**
 * A spring reverb: the tank in a guitar amp or a dub mixing desk, two coiled
 * springs with a transducer at each end.
 *
 * A spring does not make a room. It makes echoes that come back down the wire
 * smeared into a chirp -- the lows arriving before the highs, because waves
 * travel along a coil at a speed that depends on their pitch -- and a hit on
 * the tank is a "boing". Drip is how much each echo is smeared; Tension how
 * taut the springs are, which is how quickly the echoes come round; Decay how
 * long they last; Tone how bright the tank is.
 *
 * Two springs of different lengths, one for each side, so it is stereo.
 */
export class SpringModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private a = new SpringLine(LOOSE_S * this.ctx.sampleRate + 4, this.ctx.sampleRate)
  private b = new SpringLine(LOOSE_S * SECOND * this.ctx.sampleRate + 4, this.ctx.sampleRate)
  private tension!: Smoothed
  private drip!: Smoothed
  private mix!: Smoothed
  private dc = new DcBlocker(this.ctx.sampleRate)
  /** The trip lengths the feedback was last worked out for, and what it came to. */
  private tripFor = NaN
  private decayFor = NaN
  private fa = 0
  private fb = 0

  prepare() {
    const sr = this.ctx.sampleRate
    this.tension = new Smoothed(this.params[P_TENSION], sr, TENSION_GLIDE_MS)
    this.drip = new Smoothed(this.params[P_DRIP], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[IN_SIGNAL]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const sr = this.ctx.sampleRate
    const decay = this.params[P_DECAY]
    this.tension.set(this.params[P_TENSION])
    this.drip.set(this.params[P_DRIP])
    this.mix.set(this.params[P_MIX])
    const top = Math.min(TOP_HZ * 2 ** (-(1 - this.params[P_TONE]) * TONE_OCTAVES), sr * 0.45)
    const damp = 1 - Math.exp((-2 * Math.PI * top) / sr)

    for (let i = from; i < to; i++) {
      let x = input[i]
      if (x - x !== 0) x = 0
      // DC kept out of the tank, which would add it to itself every trip.
      const wet = this.dc.process(x)
      const tension = this.tension.next()
      const trip = (LOOSE_S + (TAUT_S - LOOSE_S) * tension) * sr
      if (trip !== this.tripFor || decay !== this.decayFor) {
        // Each spring's feedback from its own trip time, so the tail lasts as
        // long as Decay says however taut they are: -60 dB in Decay seconds.
        this.tripFor = trip
        this.decayFor = decay
        this.fa = Math.min(MAX_FEEDBACK, 10 ** ((-3 * trip) / (decay * sr)))
        this.fb = Math.min(MAX_FEEDBACK, 10 ** ((-3 * trip * SECOND) / (decay * sr)))
      }
      const drip = this.drip.next() * MAX_DRIP
      const l = this.a.step(wet, trip, this.fa, drip, damp)
      const r = this.b.step(wet, trip * SECOND, this.fb, drip, damp)
      const mix = this.mix.next()
      outL[i] = x * (1 - mix) + l * mix
      outR[i] = x * (1 - mix) + r * mix
    }
    this.a.flush()
    this.b.flush()
  }
}
