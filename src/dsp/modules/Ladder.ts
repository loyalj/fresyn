import { LadderFilter } from '../LadderFilter'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

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
  private filter = new LadderFilter(this.ctx.sampleRate)
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

  process(slots: Float32Array) {
    this.cutoff.set(this.params[P_CUTOFF])
    this.resonance.set(this.params[P_RESONANCE])
    this.drive.set(this.params[P_DRIVE])
    this.cvAmount.set(this.params[P_CV_AMOUNT])

    // Exponential CV, so a fixed amount shifts the cutoff by the same number
    // of octaves wherever the knob happens to sit.
    const cv = slots[this.ins[IN_CV]] * this.cvAmount.next()
    const cutoff = this.cutoff.next() * Math.pow(2, cv)

    slots[this.outs[0]] = this.filter.process(
      slots[this.ins[IN_SIGNAL]],
      cutoff,
      this.resonance.next(),
      this.drive.next(),
      Math.round(this.params[P_MODE]),
    )
  }
}
