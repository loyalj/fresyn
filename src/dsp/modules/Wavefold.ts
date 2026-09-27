import { DcBlocker } from '../DcBlocker'
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
  /** Folding an off-centre wave leaves DC behind, as asymmetric clipping does. */
  private dc = new DcBlocker(this.ctx.sampleRate)

  process(slots: Float32Array) {
    // Symmetry is added after the gain, not before it. Folding repeats every
    // four units of its input, so an offset applied first is multiplied by
    // Fold as well -- and at a Fold of 2 the two ends of the Symmetry knob
    // land exactly one period apart and sound identical. After the gain, the
    // knob shifts the wave by the same amount wherever Fold is set.
    // The manual used to tell the reader to put a VCA in front of this module
    // and sweep its level, which is folding by proxy: it changes how far into
    // the folds the signal reaches, at the cost of the level going with it.
    // This moves the folding itself and leaves the level alone.
    const fold =
      this.params[P_FOLD] * Math.pow(2, slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT])
    const x = slots[this.ins[IN_SIGNAL]] * fold + this.params[P_SYMMETRY]
    slots[this.outs[0]] = this.dc.process(triangleFold(x))
  }
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
