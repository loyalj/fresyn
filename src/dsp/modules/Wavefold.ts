import { ADAA_EPS, saneInput } from '../Adaa'
import { DcBlocker } from '../DcBlocker'
import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule } from './types'

const P_FOLD = 0
const P_SYMMETRY = 1
const P_CV_AMOUNT = 2

const IN_SIGNAL = 0
const IN_CV = 1

/**
 * A wavefolder: past the rails the signal turns back on itself, again and
 * again, so a sine that went in comes out with a dozen creases in it.
 *
 * This is the other half of the distortion family from the Drive module, and
 * it does the opposite thing. Overdrive takes the peaks *off* a wave, so the
 * result is a flattened version of what you had. Folding replaces the peaks
 * with new ones, so the result has more going on the harder you push -- turn
 * Fold up and the harmonics keep arriving instead of settling into a buzz.
 * It is how a single sine becomes a bell, a bright metallic drone, or the
 * kind of tone no filter sweep can get to.
 *
 * Symmetry slides the wave off centre within the fold pattern. Because
 * folding repeats, that does not simply distort one half harder the way Bias
 * does on the Drive: it lands the wave on different creases, so the harmonics
 * rearrange rather than intensify. Sweeping it is the sound the module is
 * for.
 */
export class WavefoldModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  /** Folding an off-centre wave leaves DC behind, as asymmetric clipping does. */
  private dc = new DcBlocker(this.ctx.sampleRate)
  private fold!: Smoothed
  private symmetry!: Smoothed
  /** The last input to the fold and its antiderivative there, for the averaging. */
  private x1 = 0
  private f1 = 0

  prepare() {
    // Both of these move where on the folds the wave lands, and a step in
    // that is a step in the output.
    this.fold = new Smoothed(this.params[P_FOLD], this.ctx.sampleRate)
    this.symmetry = new Smoothed(this.params[P_SYMMETRY], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.fold.set(this.params[P_FOLD])
    this.symmetry.set(this.params[P_SYMMETRY])
    const cv = this.inputs[IN_CV]
    const signal = this.inputs[IN_SIGNAL]
    const out = this.outputs[0]
    const amount = this.params[P_CV_AMOUNT]
    for (let i = from; i < to; i++) {
      // Symmetry is added after the gain, not before it. Folding repeats
      // every four units of its input, so an offset applied first is
      // multiplied by Fold as well -- and at a Fold of 2 the two ends of the
      // Symmetry knob land exactly one period apart and sound identical.
      // After the gain, the knob shifts the wave by the same amount wherever
      // Fold is set.
      // The manual used to tell the reader to put a VCA in front of this
      // module and sweep its level, which is folding by proxy: it changes how
      // far into the folds the signal reaches, at the cost of the level going
      // with it. This moves the folding itself and leaves the level alone.
      const fold = expCv(this.fold.next(), cv[i], amount)
      const x = saneInput(signal[i] * fold + this.symmetry.next())

      // Averaged over the step from the last input rather than taken at this
      // one (see `Adaa.ts`). A folder is the worst aliaser in the rack: every
      // crease is a corner, and at Fold 16 a high note has dozens of them a
      // cycle, most of whose harmonics have nowhere to go but back down.
      const f = foldIntegral(x)
      const dx = x - this.x1
      const y = dx > ADAA_EPS || dx < -ADAA_EPS ? (f - this.f1) / dx : triangleFold(0.5 * (x + this.x1))
      this.x1 = x
      this.f1 = f
      out[i] = this.dc.process(y)
    }
  }
}

/**
 * The antiderivative of `triangleFold`, from zero.
 *
 * The fold spends as long below zero as above it in each period, so its
 * integral comes back to where it started every four units: it can be taken
 * on the wrapped input, and stays small however far past the rails the input
 * goes -- which keeps the subtraction in the averaging accurate at any Fold.
 */
function foldIntegral(v: number) {
  const w = v - 4 * Math.round(v * 0.25)
  const a = w < 0 ? -w : w
  return a <= 1 ? 0.5 * a * a : 2 * a - 0.5 * a * a - 1
}

/**
 * Fold into the rails as many times as it takes.
 *
 * Done by wrapping into one period of a triangle rather than by looping and
 * reflecting: a loop would run once per fold, so a signal driven a hundred
 * times over the rails would cost a hundred iterations on the audio thread
 * for a result this arrives at in four operations.
 */
function triangleFold(v: number) {
  if (!Number.isFinite(v)) return 0
  // Into one 4-wide period, which is a full up-and-back of the triangle.
  const wrapped = v - 4 * Math.round(v * 0.25)
  if (wrapped > 1) return 2 - wrapped
  if (wrapped < -1) return -2 - wrapped
  return wrapped
}
