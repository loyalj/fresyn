import { DcBlocker } from '../DcBlocker'
import { DspModule } from './types'

const P_DRIVE = 0
const P_CURVE = 1
const P_BIAS = 2
const P_LEVEL = 3

const IN_SIGNAL = 0

/** Curve positions, in the order the def lists them; tanh is position 0. */
const CLIP = 1
const FOLD = 2
const RECTIFY = 3

/**
 * Overdrive: push a signal into something that cannot pass all of it, and
 * what comes out has harmonics that were never in what went in.
 *
 * The four curves are four ways of running out of room. **tanh** is a valve
 * easing into its limit, and is the one that still sounds like the original.
 * **clip** stops dead at the ceiling, which is a transistor and is harsher.
 * **fold** turns back on itself instead of stopping, so the loudest part of a
 * wave becomes the quietest -- glassy and electronic rather than dirty.
 * **rectify** flips the bottom half up, doubling the frequency and hollowing
 * the tone out.
 *
 * Bias is the knob worth knowing. It slides the signal off centre before it
 * is shaped, so one half of the wave clips harder than the other. Symmetrical
 * clipping makes odd harmonics and sounds like a clean distortion; asymmetric
 * clipping adds the even ones, which is the growl of a worn engine, a large
 * animal, or a speaker being asked for more than it has.
 */
export class DriveModule extends DspModule {
  /**
   * Asymmetry is the point of the Bias knob, and asymmetry puts a DC offset
   * on the output by definition. Left in, it would eat headroom everywhere
   * downstream and thump when a VCA opened; the harmonics that do the work
   * are unaffected by taking it out.
   */
  private dc = new DcBlocker(this.ctx.sampleRate)

  process(slots: Float32Array) {
    const x = slots[this.ins[IN_SIGNAL]] + this.params[P_BIAS]
    const driven = x * this.params[P_DRIVE]

    let y: number
    switch (Math.round(this.params[P_CURVE])) {
      case CLIP:
        y = driven > 1 ? 1 : driven < -1 ? -1 : driven
        break
      case FOLD:
        // One reflection: past the ceiling it turns back the way it came. The
        // wavefolder does this over and over; here it happens once, which is
        // a different sound rather than a weaker version of the same one.
        y = fold1(driven)
        break
      case RECTIFY:
        y = driven < 0 ? -driven : driven
        if (y > 1) y = 1
        break
      default:
        y = Math.tanh(driven)
        break
    }

    slots[this.outs[0]] = this.dc.process(y) * this.params[P_LEVEL]
  }
}

/** Reflect about the rails once, then hold, so the result is always bounded. */
function fold1(v: number) {
  if (v > 1) {
    const folded = 2 - v
    return folded < -1 ? -1 : folded
  }
  if (v < -1) {
    const folded = -2 - v
    return folded > 1 ? 1 : folded
  }
  return v
}
