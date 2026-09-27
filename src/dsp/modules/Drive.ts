import { ADAA_EPS, clipIntegral, logCosh, saneInput } from '../Adaa'
import { DcBlocker } from '../DcBlocker'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_DRIVE = 0
const P_CURVE = 1
const P_BIAS = 2
const P_LEVEL = 3
const P_CV_AMOUNT = 4

const IN_SIGNAL = 0
const IN_CV = 1

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
 *
 * Every curve is run through antiderivative anti-aliasing (see `Adaa.ts`):
 * at 64x on a high note the harmonics the curve makes go far past Nyquist,
 * and without it they fold back down as a whistle unrelated to the note.
 */
export class DriveModule extends DspModule {
  /**
   * Asymmetry is the point of the Bias knob, and asymmetry puts a DC offset
   * on the output by definition. Left in, it would eat headroom everywhere
   * downstream and thump when a VCA opened; the harmonics that do the work
   * are unaffected by taking it out.
   */
  private dc = new DcBlocker(this.ctx.sampleRate)
  private drive!: Smoothed
  private bias!: Smoothed
  private level!: Smoothed
  /** The last input to the curve, its antiderivative there, and which curve that was. */
  private x1 = 0
  private f1 = 0
  private curve1 = -1

  prepare() {
    // Each of these moves the signal itself, not a coefficient: stepped, a
    // game turning the drive up on an engine is a click every time it does.
    const sr = this.ctx.sampleRate
    this.drive = new Smoothed(this.params[P_DRIVE], sr)
    this.bias = new Smoothed(this.params[P_BIAS], sr)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
  }

  process(slots: Float32Array) {
    this.drive.set(this.params[P_DRIVE])
    this.bias.set(this.params[P_BIAS])
    this.level.set(this.params[P_LEVEL])

    const x = slots[this.ins[IN_SIGNAL]] + this.bias.next()
    // An envelope into Drive is a transient: loud and dirty at the moment of
    // the hit and clean as it falls away, which is what a struck thing does
    // and what a fixed drive never does.
    const drive = this.drive.next() * Math.pow(2, slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT])
    const driven = saneInput(x * drive)

    const curve = Math.round(this.params[P_CURVE])
    // A different curve has a different antiderivative, so the one held for
    // the last sample has to be worked out again before the two can be
    // compared.
    if (curve !== this.curve1) {
      this.curve1 = curve
      this.f1 = integral(curve, this.x1)
    }
    const f = integral(curve, driven)
    const dx = driven - this.x1
    const y = dx > ADAA_EPS || dx < -ADAA_EPS ? (f - this.f1) / dx : shape(curve, 0.5 * (driven + this.x1))
    this.x1 = driven
    this.f1 = f

    slots[this.outs[0]] = this.dc.process(y) * this.level.next()
  }
}

/** The curve itself, for when two inputs are too close together to average between. */
function shape(curve: number, v: number) {
  switch (curve) {
    case CLIP:
      return v > 1 ? 1 : v < -1 ? -1 : v
    case FOLD:
      // One reflection: past the ceiling it turns back the way it came. The
      // wavefolder does this over and over; here it happens once, which is
      // a different sound rather than a weaker version of the same one.
      return fold1(v)
    case RECTIFY: {
      const r = v < 0 ? -v : v
      return r > 1 ? 1 : r
    }
    default:
      return Math.tanh(v)
  }
}

/** Each curve's antiderivative, from zero, which is what the averaging needs. */
function integral(curve: number, v: number) {
  const a = v < 0 ? -v : v
  switch (curve) {
    case CLIP:
      return clipIntegral(v)
    case FOLD:
      // Rising with the line to the rail, back down the reflection, then flat
      // at the far rail, so the area bends each time the curve does.
      return a <= 1 ? 0.5 * a * a : a <= 3 ? 2 * a - 0.5 * a * a - 1 : 3.5 - a
    case RECTIFY: {
      // The curve is even, so its antiderivative is odd.
      const r = a <= 1 ? 0.5 * a * a : a - 0.5
      return v < 0 ? -r : r
    }
    default:
      return logCosh(v)
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
