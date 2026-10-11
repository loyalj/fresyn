import { DspModule } from './types'

const P_FREQ = 0
const P_DAMPING = 1
const P_KICK = 2

const IN = 0
const IN_KICK = 1

const OUT = 0
const OUT_VEL = 1

/** Where the mass hits its stops: far past any CV the rack makes. */
const STOP = 10

/**
 * A weight on a spring, pulled towards whatever arrives at In.
 *
 * Where Slew glides to a new value, this overshoots it, swings back and
 * wobbles before it settles: a jelly, a cartoon boing, a needle that bounces
 * on its stop, a pitch that lands with a wobble. Freq is how fast it swings
 * and Damping how soon it stops -- near zero it rings for ages, at one it
 * arrives without overshooting at all.
 *
 * Kick flicks the weight on every rising edge at its jack, by Kick: a
 * boing from a trigger, with nothing at In at all. Vel is how fast it is
 * moving, scaled to the same size as Out.
 */
export class SpringMassModule extends DspModule {
  private x = 0
  private v = 0
  private wasHigh = false

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const input = this.inputs[IN]
    const kickIn = this.inputs[IN_KICK]
    const out = this.outputs[OUT]
    const velOut = this.outputs[OUT_VEL]
    const w = 2 * Math.PI * this.params[P_FREQ]
    const zeta = this.params[P_DAMPING]
    const kick = this.params[P_KICK]
    const dt = 1 / sr
    let x = this.x
    let v = this.v

    for (let i = from; i < to; i++) {
      const high = kickIn[i] > 0.5
      // A flick that would swing it about as far as Kick.
      if (high && !this.wasHigh) v += kick * w
      this.wasHigh = high

      // Semi-implicit Euler: velocity first, then position from the new
      // velocity. Stable for any swing slower than the sample rate by miles,
      // which is everything the Freq knob reaches.
      const a = w * w * (input[i] - x) - 2 * zeta * w * v
      v += a * dt
      x += v * dt
      if (x > STOP) {
        x = STOP
        v = 0
      } else if (x < -STOP) {
        x = -STOP
        v = 0
      }
      if (x - x !== 0 || v - v !== 0) {
        x = 0
        v = 0
      }
      out[i] = x
      const vel = v / w
      velOut[i] = vel > STOP ? STOP : vel < -STOP ? -STOP : vel
    }
    this.x = x
    this.v = v
  }
}
