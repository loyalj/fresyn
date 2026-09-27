import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_MODE = 0
const P_RATE = 1
const P_DEPTH = 2
const P_CENTER = 3
const P_FEEDBACK = 4
const P_MIX = 5

const IN_SIGNAL = 0
const IN_CV = 1

const OUT_L = 0
const OUT_R = 1

const MODE_CHORUS = 0
const MODE_FLANGER = 1

/** First-order all-pass stages in the phaser: three notches. */
const STAGES = 6
/** The longest any mode reads its line, with the sweep at full depth. */
const MAX_DELAY_S = 0.05

/**
 * Chorus, flanger and phaser: one module, because they are one idea.
 *
 * Each is a copy of the sound, moved slightly in time by an LFO, mixed back
 * with the original. Where the copy lines up with the original the two add,
 * and where it is half a cycle out they cancel, so the mix is a comb of peaks
 * and notches that sweeps as the LFO moves. What separates the three is only
 * how far the copy is moved, and how:
 *
 *   - chorus: a long delay, 5 to 30 ms, swept a little. The notches are too
 *     close together to hear as a comb; what is heard is a second player,
 *     slightly out of tune, which is what thickens a pad.
 *   - flanger: a short one, a tenth of a millisecond to eight, swept a long
 *     way. The comb is wide enough to hear as a pitch, and sweeping it is the
 *     jet. Feedback sharpens the teeth; negative feedback moves them to the
 *     odd harmonics, which is hollower.
 *   - phaser: no delay line at all, but a chain of all-pass filters, which
 *     shift phase without changing level. Six of them make three notches,
 *     spaced unevenly the way no delay can -- the watery swirl.
 *
 * Center is where the effect sits before the LFO moves it, in each mode's own
 * terms: the delay for the two lines, the notch frequency for the phaser. The
 * CV jack adds to it directly, so an envelope can sweep a flanger by hand.
 *
 * Stereo out, the right side's LFO a quarter cycle behind the left's, so the
 * sweep moves across the field. Mono in, because what a chorus is for is
 * making one sound wider.
 */
export class ChorusModule extends DspModule {
  private lineL = new DelayLine(this.ctx.sampleRate * MAX_DELAY_S)
  private lineR = new DelayLine(this.ctx.sampleRate * MAX_DELAY_S)
  private wetL = 0
  private wetR = 0
  private phase = 0
  private mode = -1
  /** All-pass state per stage, per side. */
  private apL = new Float64Array(STAGES)
  private apR = new Float64Array(STAGES)
  private depth!: Smoothed
  private center!: Smoothed
  private feedback!: Smoothed
  private mix!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.depth = new Smoothed(this.params[P_DEPTH], sr)
    this.center = new Smoothed(this.params[P_CENTER], sr, 20)
    this.feedback = new Smoothed(this.params[P_FEEDBACK], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
  }

  process(slots: Float32Array) {
    const sr = this.ctx.sampleRate
    this.depth.set(this.params[P_DEPTH])
    this.center.set(this.params[P_CENTER])
    this.feedback.set(this.params[P_FEEDBACK])
    this.mix.set(this.params[P_MIX])

    const mode = Math.round(this.params[P_MODE])
    if (mode !== this.mode) {
      // What each mode leaves in its state means nothing to the next, and
      // hearing a flanger's loop come out of a phaser's all-passes is a bang.
      this.mode = mode
      this.lineL.reset()
      this.lineR.reset()
      this.apL.fill(0)
      this.apR.fill(0)
      this.wetL = 0
      this.wetR = 0
    }

    let x = slots[this.ins[IN_SIGNAL]]
    // Kept out of the lines and the all-passes, where it would outlive the
    // sample it arrived on; the check below catches anything made inside.
    if (x - x !== 0) x = 0
    const depth = this.depth.next()
    let center = this.center.next() + slots[this.ins[IN_CV]]
    if (!(center >= 0)) center = 0
    else if (center > 1) center = 1
    const fb = this.feedback.next()
    const mix = this.mix.next()

    this.phase += this.params[P_RATE] / sr
    if (this.phase >= 1) this.phase -= Math.floor(this.phase)
    const lfoL = Math.sin(2 * Math.PI * this.phase)
    const lfoR = Math.cos(2 * Math.PI * this.phase)

    let wetL: number
    let wetR: number
    if (mode === MODE_CHORUS || mode === MODE_FLANGER) {
      let base: number
      let dL: number
      let dR: number
      if (mode === MODE_CHORUS) {
        // Up to forty percent either side of the base: at 30 ms that is a
        // detune you hear as a second voice, not as vibrato.
        base = (0.005 + 0.025 * center) * sr
        dL = base * (1 + 0.4 * depth * lfoL)
        dR = base * (1 + 0.4 * depth * lfoR)
      } else {
        // Exponential, because a flanger's sweep is heard as pitch: an
        // octave of delay either way is an octave of comb.
        base = 0.0001 * Math.pow(2, center * 6.3) * sr
        dL = base * Math.pow(2, 1.5 * depth * lfoL)
        dR = base * Math.pow(2, 1.5 * depth * lfoR)
      }
      wetL = this.lineL.read(dL)
      wetR = this.lineR.read(dR)
      // Saturated where it comes back round and nowhere else, so the dry
      // path stays clean and the loop still cannot run away.
      this.lineL.push(x + fb * Math.tanh(wetL))
      this.lineR.push(x + fb * Math.tanh(wetR))
    } else {
      // Notches from 80 Hz to 5 kHz, and two octaves of sweep either way.
      const f = 80 * Math.pow(2, center * 6)
      wetL = this.allpass(this.apL, x + fb * Math.tanh(this.wetL), f * Math.pow(2, 2 * depth * lfoL), sr)
      wetR = this.allpass(this.apR, x + fb * Math.tanh(this.wetR), f * Math.pow(2, 2 * depth * lfoR), sr)
    }
    // tanh(NaN) is NaN, so the saturation in the loop is no protection from
    // one bad sample: it would go round the line or the all-passes for ever.
    // Anything but a number clears every mode's state, which is the same
    // reset a mode change does, and the next sample is clean.
    const s = wetL + wetR
    if (s - s !== 0) {
      this.lineL.reset()
      this.lineR.reset()
      this.apL.fill(0)
      this.apR.fill(0)
      wetL = 0
      wetR = 0
    }
    this.wetL = wetL
    this.wetR = wetR

    // Half and half is the deepest the notches go, which is why it is the
    // default rather than full wet.
    slots[this.outs[OUT_L]] = x * (1 - mix) + wetL * mix
    slots[this.outs[OUT_R]] = x * (1 - mix) + wetR * mix
  }

  private allpass(state: Float64Array, x: number, hz: number, sr: number) {
    let f = hz
    if (f > sr * 0.45) f = sr * 0.45
    const t = Math.tan((Math.PI * f) / sr)
    const a = (t - 1) / (t + 1)
    let v = x
    for (let i = 0; i < STAGES; i++) {
      const y = a * v + state[i]
      state[i] = v - a * y
      v = y
    }
    return v
  }
}
