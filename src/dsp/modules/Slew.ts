import { tauStep } from '../util'
import { DspModule } from './types'

const P_RISE = 0
const P_FALL = 1
const P_SHAPE = 2

const SHAPE_LINEAR = 0

/**
 * Slew limiter: caps how fast its output can follow its input, separately for
 * rising and falling.
 *
 * Three jobs in one module. On a pitch CV it is portamento. On a stepped
 * source such as the sample and hold it turns the steps into glides, which is
 * the difference between a burble and a melody. On a gate it is an attack and
 * release envelope with no envelope module at all -- the cheapest way to stop
 * something clicking.
 */
export class SlewModule extends DspModule {
  private value = 0

  process(slots: Float32Array) {
    const target = slots[this.ins[0]]
    const rising = target > this.value
    const time = rising ? this.params[P_RISE] : this.params[P_FALL]

    if (Math.round(this.params[P_SHAPE]) === SHAPE_LINEAR) {
      // Constant rate: the time is how long a full one-unit move takes, so
      // the ramp is straight and a square edge comes out as a triangle.
      const step = 1 / (time * this.ctx.sampleRate)
      const delta = target - this.value
      this.value += delta > step ? step : delta < -step ? -step : delta
    } else {
      // One-pole: the time is a time constant, covering 63% of what is left
      // in that long and never quite arriving. This is what a hardware slew
      // limiter does, and it is the shape portamento wants.
      this.value += (target - this.value) * tauStep(time * this.ctx.sampleRate)
    }

    slots[this.outs[0]] = this.value
  }
}
