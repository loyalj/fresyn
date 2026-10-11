import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_SIZE = 0
const P_DECAY = 1
const P_SHIMMER = 2
const P_INTERVAL = 3
const P_DAMPING = 4
const P_MIX = 5

const IN = 0

const OUT_L = 0
const OUT_R = 1

/** The Interval switch's positions, in semitones. */
export const SHIMMER_INTERVALS = [-12, 5, 7, 12, 19, 24]

/** Prime-ish lengths in seconds, longer than the Space's: a bigger, softer room. */
const LENGTHS = [0.0431, 0.0517, 0.0613, 0.0719]
const LINES = LENGTHS.length
const MIN_SIZE = 0.25
const MAX_FEEDBACK = 0.9995

/** The pitch shifter's window: long enough to be smooth, short enough not to smear. */
const WINDOW_S = 0.06

/**
 * A reverb whose tail climbs: heavenly pads, magic, the moment an item is
 * picked up.
 *
 * A four-line feedback network like the Space, with a pitch shifter inside
 * the loop. Each time round, Shimmer of the tail is shifted up by Interval
 * and fed back in -- so an octave comes out of the note, then an octave
 * above that, a stack of them rising and fading into the room. Damping
 * keeps the top from turning to glass; Decay is how long the whole thing
 * takes to die away, shifted part and all.
 *
 * The shifter is two playheads sweeping through a short delay, crossfaded:
 * cheap, smooth inside a reverb, and grainy on its own -- which a tail
 * hides completely.
 */
export class ShimmerModule extends DspModule {
  readonly rests = true
  readonly memory = 20
  private lines = LENGTHS.map((s) => new DelayLine(s * this.ctx.sampleRate))
  private dampers = LENGTHS.map(() => new OnePole())
  private dc = new DcBlocker(this.ctx.sampleRate)
  /** A pitch shifter per line, so what climbs keeps climbing pass after pass. */
  private shifters = LENGTHS.map(() => new DelayLine(WINDOW_S * 2 * this.ctx.sampleRate))
  private shiftPhase = 0
  private reach = new Float64Array(LINES)
  private gains = new Float64Array(LINES)
  /**
   * The governor: the tail's energy, and the most it is allowed. Shifted
   * feedback is not quite independent of what it is fed back beside, so the
   * loop can creep past a gain of one; this holds the tail under the curve
   * Decay sets, which is what a reverb's decay means.
   */
  private energy = 0
  private allowed = 0
  private hold = 1
  private tunedSize = NaN
  private tunedDecay = NaN
  private size!: Smoothed
  private decay!: Smoothed
  private shimmer!: Smoothed
  private damping!: Smoothed
  private mix!: Smoothed

  holdsFor() {
    return Math.min(20, this.params[P_DECAY] * (1 + 2 * this.params[P_SHIMMER]))
  }

  prepare() {
    const sr = this.ctx.sampleRate
    this.size = new Smoothed(this.params[P_SIZE], sr, 50)
    this.decay = new Smoothed(this.params[P_DECAY], sr)
    this.shimmer = new Smoothed(this.params[P_SHIMMER], sr)
    this.damping = new Smoothed(this.params[P_DAMPING], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const input = this.inputs[IN]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    this.size.set(this.params[P_SIZE])
    this.decay.set(this.params[P_DECAY])
    this.shimmer.set(this.params[P_SHIMMER])
    this.damping.set(this.params[P_DAMPING])
    this.mix.set(this.params[P_MIX])
    const step = Math.round(this.params[P_INTERVAL])
    const semis = SHIMMER_INTERVALS[step < 0 ? 0 : step >= SHIMMER_INTERVALS.length ? SHIMMER_INTERVALS.length - 1 : step]
    const ratio = Math.pow(2, semis / 12)
    const window = WINDOW_S * sr
    // How far each playhead's delay moves per sample: shrinking the delay
    // plays faster, which is higher.
    const sweep = (1 - ratio) / window
    const lines = this.lines
    const dampers = this.dampers
    const reach = this.reach
    const gains = this.gains
    const shifters = this.shifters
    const energyK = 1 - Math.exp(-1 / (0.01 * sr))
    const holdK = 1 - Math.exp(-1 / (0.005 * sr))
    // Energy 60 dB down in Decay, per sample.
    const fall = Math.pow(10, -6 / (Math.max(0.05, this.params[P_DECAY]) * sr))

    for (let i = from; i < to; i++) {
      const dry = input[i]
      const size = this.size.next()
      const decay = this.decay.next()
      if (size !== this.tunedSize || decay !== this.tunedDecay) this.tune(size, decay)
      const damping = this.damping.next()

      // The shifters' playheads, shared by all four lines.
      this.shiftPhase += sweep
      this.shiftPhase -= Math.floor(this.shiftPhase)
      const pa = this.shiftPhase
      const pb = pa + 0.5 >= 1 ? pa - 0.5 : pa + 0.5
      // Sine windows rather than sine-squared: the two heads read stretches
      // of tail that have little to do with each other, and sine windows add
      // those at constant power. Squared, every pass lost a quarter of it.
      const sa = Math.sin(Math.PI * pa)
      const sb = Math.sin(Math.PI * pb)
      const da = pa * window + 1
      const db = pb * window + 1

      const into = this.dc.process(dry)
      // Each line's feedback is part as it was and part shifted, crossfaded
      // at equal power: the loop keeps the gain Decay gave it however much
      // of it is climbing, and what climbs goes round to climb again.
      const s = this.shimmer.next() * (Math.PI / 2)
      const keep = Math.cos(s)
      const lift = Math.sin(s)

      let a = dampers[0].process(lines[0].read(reach[0]), damping) * gains[0]
      let b = dampers[1].process(lines[1].read(reach[1]), damping) * gains[1]
      let c = dampers[2].process(lines[2].read(reach[2]), damping) * gains[2]
      let d = dampers[3].process(lines[3].read(reach[3]), damping) * gains[3]
      const sum = a + b + c + d
      if (sum - sum !== 0) {
        for (let k = 0; k < LINES; k++) {
          lines[k].reset()
          dampers[k].reset()
          shifters[k].reset()
        }
        a = b = c = d = 0
        this.energy = 0
        this.allowed = 0
      }
      // The governor. The allowed level follows the tail up while the input
      // is feeding it, and otherwise only ever falls, at Decay's rate.
      const e = a * a + b * b + c * c + d * d
      this.energy += (e - this.energy) * energyK
      const fed = into > 1e-5 || into < -1e-5
      this.allowed = fed && this.energy > this.allowed ? this.energy : this.allowed * fall
      const over = this.energy > this.allowed && this.energy > 1e-12 ? Math.sqrt(this.allowed / this.energy) : 1
      this.hold += (over - this.hold) * holdK
      a *= this.hold
      b *= this.hold
      c *= this.hold
      d *= this.hold
      const m0 = (a + b + c + d) * 0.5
      const m1 = (a - b + c - d) * 0.5
      const m2 = (a + b - c - d) * 0.5
      const m3 = (a - b - c + d) * 0.5
      const s0 = shifters[0]
      const s1 = shifters[1]
      const s2 = shifters[2]
      const s3 = shifters[3]
      s0.push(m0)
      s1.push(m1)
      s2.push(m2)
      s3.push(m3)
      lines[0].push(Math.tanh(into + m0 * keep + (s0.read(da) * sa + s0.read(db) * sb) * lift))
      lines[1].push(Math.tanh(into + m1 * keep + (s1.read(da) * sa + s1.read(db) * sb) * lift))
      lines[2].push(Math.tanh(into + m2 * keep + (s2.read(da) * sa + s2.read(db) * sb) * lift))
      lines[3].push(Math.tanh(into + m3 * keep + (s3.read(da) * sa + s3.read(db) * sb) * lift))

      const wetL = (a + c) * 0.5
      const wetR = (b + d) * 0.5
      const mix = this.mix.next()
      outL[i] = dry * (1 - mix) + wetL * mix
      outR[i] = dry * (1 - mix) + wetR * mix
    }
  }

  private tune(size: number, decay: number) {
    this.tunedSize = size
    this.tunedDecay = decay
    const sr = this.ctx.sampleRate
    const scale = MIN_SIZE + (1 - MIN_SIZE) * size
    for (let i = 0; i < LINES; i++) {
      const samples = LENGTHS[i] * scale * sr
      this.reach[i] = samples
      const g = decay > 0 ? Math.pow(10, (-3 * samples) / (decay * sr)) : 0
      this.gains[i] = g > MAX_FEEDBACK ? MAX_FEEDBACK : g
    }
  }
}
