import { LadderFilter } from '../LadderFilter'
import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { BLOCK, DspModule } from './types'

const P_CUTOFF = 0
const P_RESONANCE = 1
const P_DRIVE = 2
const P_CV_AMOUNT = 3
// Appended, so a patch saved before Mode existed keeps its other four knobs
// where they are and lands on response 0, which is the filter it always was.
const P_MODE = 4

const IN_SIGNAL = 0
const IN_CV = 1

/**
 * Four poles of Moog ladder, with a Mode that chooses where on the ladder the
 * output is taken from.
 *
 * Mode is not smoothed. It selects between weightings rather than moving
 * along them, so a change is a step however it is done -- the same as the
 * oscillator's Wave or the Drive's Curve, and for the same reason.
 */
export class LadderModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private filter = new LadderFilter(this.ctx.sampleRate)
  /** Each sample's settings for this block, for the filter to run over. */
  private cutoffs = new Float64Array(BLOCK)
  private resonances = new Float64Array(BLOCK)
  private drives = new Float64Array(BLOCK)
  private cutoff!: Smoothed
  private resonance!: Smoothed
  private drive!: Smoothed
  private cvAmount!: Smoothed

  prepare() {
    this.cutoff = new Smoothed(this.params[P_CUTOFF], this.ctx.sampleRate)
    this.resonance = new Smoothed(this.params[P_RESONANCE], this.ctx.sampleRate)
    this.drive = new Smoothed(this.params[P_DRIVE], this.ctx.sampleRate)
    this.cvAmount = new Smoothed(this.params[P_CV_AMOUNT], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.cutoff.set(this.params[P_CUTOFF])
    this.resonance.set(this.params[P_RESONANCE])
    this.drive.set(this.params[P_DRIVE])
    this.cvAmount.set(this.params[P_CV_AMOUNT])
    const mode = Math.round(this.params[P_MODE])
    const signal = this.inputs[IN_SIGNAL]
    const cv = this.inputs[IN_CV]
    const out = this.outputs[0]
    const filter = this.filter

    // Every sample's cutoff, resonance and drive first, then the filter over
    // the lot; see `LadderFilter.run`. Read once when they have arrived; see
    // the oscillator.
    const { cutoff: cutoffS, cvAmount, resonance, drive, cutoffs, resonances, drives } = this
    if (cutoffS.settled && cvAmount.settled && resonance.settled && drive.settled) {
      const base = cutoffS.current
      const amount = cvAmount.current
      resonances.fill(resonance.current, from, to)
      drives.fill(drive.current, from, to)
      for (let i = from; i < to; i++) {
        // Exponential CV, so a fixed amount shifts the cutoff by the same
        // number of octaves wherever the knob happens to sit.
        const octaves = cv[i] * amount
        cutoffs[i] = octaves === 0 ? base : base * Math.pow(2, octaves)
      }
    } else {
      for (let i = from; i < to; i++) {
        cutoffs[i] = expCv(cutoffS.next(), cv[i], cvAmount.next())
        resonances[i] = resonance.next()
        drives[i] = drive.next()
      }
    }
    filter.run(signal, out, cutoffs, resonances, drives, mode, from, to)
  }
}
