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
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private value = 0

  processBlock(from: number, to: number) {
    const input = this.inputs[0]
    const out = this.outputs[0]
    const sr = this.ctx.sampleRate
    const rise = this.params[P_RISE]
    const fall = this.params[P_FALL]
    const linear = Math.round(this.params[P_SHAPE]) === SHAPE_LINEAR
    // Each direction's rate, worked out once a block: they are the same
    // numbers every sample until a knob moves.
    const up = linear ? 1 / (rise * sr) : tauStep(rise * sr)
    const down = linear ? 1 / (fall * sr) : tauStep(fall * sr)
    let value = this.value

    for (let i = from; i < to; i++) {
      const target = input[i]
      const k = target > value ? up : down
      if (linear) {
        // Constant rate: the time is how long a full one-unit move takes, so
        // the ramp is straight and a square edge comes out as a triangle.
        const delta = target - value
        value += delta > k ? k : delta < -k ? -k : delta
      } else {
        // One-pole: the time is a time constant, covering 63% of what is left
        // in that long and never quite arriving. This is what a hardware slew
        // limiter does, and it is the shape portamento wants.
        value += (target - value) * k
      }
      out[i] = value
    }
    this.value = value
  }
}
