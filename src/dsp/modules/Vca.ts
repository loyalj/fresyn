import { railed } from '../Rail'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LEVEL = 0
const P_CV_AMOUNT = 1

const IN_SIGNAL = 0
const IN_CV = 1

export class VcaModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private level!: Smoothed
  private cvAmount!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
    this.cvAmount = new Smoothed(this.params[P_CV_AMOUNT], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.level.set(this.params[P_LEVEL])
    this.cvAmount.set(this.params[P_CV_AMOUNT])
    const signal = this.inputs[IN_SIGNAL]
    const cv = this.inputs[IN_CV]
    const out = this.outputs[0]
    // Read once when they have arrived; see the oscillator.
    const level = this.level
    const cvAmount = this.cvAmount
    const levelFixed = level.settled
    const cvFixed = cvAmount.settled
    const levelNow = level.current
    const cvNow = cvAmount.current
    for (let i = from; i < to; i++) {
      // Initial gain plus CV, as on a real VCA: with nothing patched the
      // module passes whatever the Level knob allows, and an envelope on CV
      // opens it.
      let gain = (levelFixed ? levelNow : level.next()) + cv[i] * (cvFixed ? cvNow : cvAmount.next())
      if (gain < 0) gain = 0

      // Railed for the patch with the VCA's own output on its CV jack, which
      // multiplies itself up to infinity in a few milliseconds; see
      // `Rail.ts`.
      out[i] = railed(signal[i] * gain)
    }
  }
}
