import { Envelope } from '../Envelope'
import { DspModule, EdgeDetector } from './types'

const P_ATTACK = 0
const P_DECAY = 1
const P_SUSTAIN = 2
const P_RELEASE = 3

const IN_GATE = 0

export class AdsrModule extends DspModule {
  private env = new Envelope(this.ctx.sampleRate)
  private gate = new EdgeDetector()

  process(slots: Float32Array) {
    // Parameters first: gateOn() branches on the stage lengths, so setting
    // them afterwards would act on the previous sample's values. This module
    // has no delay stage today, so nothing depends on it yet -- but the
    // oscillator's envelope did, and it is the same class.
    this.env.attack = this.params[P_ATTACK]
    this.env.decay = this.params[P_DECAY]
    this.env.sustain = this.params[P_SUSTAIN]
    this.env.release = this.params[P_RELEASE]

    const g = slots[this.ins[IN_GATE]]
    const rose = this.gate.rose(g)
    if (rose) this.env.gateOn()
    else if (!this.gate.isHigh && this.env.isActive) this.env.gateOff()

    slots[this.outs[0]] = this.env.next()
  }
}
