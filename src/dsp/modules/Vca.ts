import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LEVEL = 0
const P_CV_AMOUNT = 1

const IN_SIGNAL = 0
const IN_CV = 1

export class VcaModule extends DspModule {
  private level!: Smoothed
  private cvAmount!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
    this.cvAmount = new Smoothed(this.params[P_CV_AMOUNT], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    this.level.set(this.params[P_LEVEL])
    this.cvAmount.set(this.params[P_CV_AMOUNT])

    // Initial gain plus CV, as on a real VCA: with nothing patched the module
    // passes whatever the Level knob allows, and an envelope on CV opens it.
    let gain = this.level.next() + slots[this.ins[IN_CV]] * this.cvAmount.next()
    if (gain < 0) gain = 0

    slots[this.outs[0]] = slots[this.ins[IN_SIGNAL]] * gain
  }
}
