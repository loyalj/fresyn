import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_CUTOFF = 0
const P_RESONANCE = 1
const P_CV_AMOUNT = 2
const P_MODE = 3

const IN_SIGNAL = 0
const IN_CV = 1

const MODE_LP = 0
const MODE_BP = 1
const MODE_HP = 2
const MODE_NOTCH = 3
const MODE_PEAK = 4
const MODE_COMB_POS = 5
const MODE_COMB_NEG = 6

/** The comb's lowest pitch, which sets how long its line has to be. */
const COMB_LOW_HZ = 20
/** The most the comb feeds back: ringing, but it always dies away. */
const COMB_MAX_FEEDBACK = 0.985

/**
 * Resonance to Q: 0.5 (no peak at all) to 10, on an exponential curve. Ten is
 * a lowpass twenty decibels up at its corner, which squeals; any higher and a
 * clean filter with nothing to saturate it is simply dangerous to turn.
 */
export function svfQ(res: number) {
  return 0.5 * Math.pow(20, res)
}

/** How far `peak` lifts its band at full Res: about fourteen decibels. */
const PEAK_GAIN = 4

/**
 * The second filter: a clean state-variable, and a comb.
 *
 * The Ladder is smooth, saturating, and lowpass at heart -- its highpass and
 * bandpass are taps on a lowpass. This is the other character: a
 * state-variable filter (Andrew Simper's trapezoidal one, which stays stable
 * however fast the cutoff is swept) that is exactly as clean as its maths,
 * with the two responses the Ladder has no way to make. `notch` takes a band
 * out and leaves the rest, the phasey hollow of a sweep; `peak` is the
 * opposite, a bump with everything else still there, which Res makes both
 * taller and narrower -- at zero it is the dry signal.
 *
 * The bandpass is normalised to unity at its centre, so turning Res up
 * narrows it rather than making it louder. The lowpass and highpass are not:
 * their peak at the corner is the resonance, and that is what a squelch is.
 *
 * The two comb modes are a different filter behind the same knobs. Cutoff is
 * the comb's pitch -- one delay of a period, fed back -- so it rings at that
 * note and its harmonics, and with CV Amt at 1.00 it plays in tune from a
 * keyboard. Res is how much is fed back: none is the dry signal, and near the
 * top it rings like a struck tube. `comb+` rings on every harmonic; `comb−`
 * feeds back upside down, which leaves only the odd ones and drops the pitch
 * an octave -- hollower, closer to a clarinet or a pipe.
 */
export class SvfModule extends DspModule {
  private ic1 = 0
  private ic2 = 0
  private comb = new DelayLine(this.ctx.sampleRate / COMB_LOW_HZ + 4)
  private mode = -1
  private cutoff!: Smoothed
  private resonance!: Smoothed
  private cvAmount!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.cutoff = new Smoothed(this.params[P_CUTOFF], sr)
    this.resonance = new Smoothed(this.params[P_RESONANCE], sr)
    this.cvAmount = new Smoothed(this.params[P_CV_AMOUNT], sr)
  }

  process(slots: Float32Array) {
    const sr = this.ctx.sampleRate
    this.cutoff.set(this.params[P_CUTOFF])
    this.resonance.set(this.params[P_RESONANCE])
    this.cvAmount.set(this.params[P_CV_AMOUNT])

    const mode = Math.round(this.params[P_MODE])
    if (mode !== this.mode) {
      // A comb's line and a filter's integrators hold different things, and
      // releasing either into the other is a click at best.
      this.mode = mode
      this.ic1 = 0
      this.ic2 = 0
      this.comb.reset()
    }

    const x = slots[this.ins[IN_SIGNAL]]
    // Exponential CV, so a fixed amount moves the corner the same number of
    // octaves wherever the knob sits -- and 1.00 tracks a keyboard exactly.
    let cutoff = this.cutoff.next() * Math.pow(2, slots[this.ins[IN_CV]] * this.cvAmount.next())
    const res = this.resonance.next()

    if (mode >= MODE_COMB_POS) {
      if (!(cutoff >= COMB_LOW_HZ)) cutoff = COMB_LOW_HZ
      else if (cutoff > sr * 0.45) cutoff = sr * 0.45
      const fb = (mode === MODE_COMB_NEG ? -1 : 1) * COMB_MAX_FEEDBACK * res
      // Saturated on the way round, as the Delay's loop is, so a comb fed
      // something loud at full feedback flattens rather than climbing.
      let y = x + fb * Math.tanh(this.comb.read(sr / cutoff))
      // tanh(NaN) is NaN, so saturation is no protection here: one bad sample
      // pushed into the line would come round and be pushed again for ever.
      if (y - y !== 0) {
        this.comb.reset()
        y = 0
      }
      this.comb.push(y)
      slots[this.outs[0]] = y * (1 - 0.5 * Math.abs(fb))
      return
    }

    if (!(cutoff >= 10)) cutoff = 10
    else if (cutoff > sr * 0.49) cutoff = sr * 0.49
    const g = Math.tan((Math.PI * cutoff) / sr)
    const k = 1 / svfQ(res)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2

    const v3 = x - this.ic2
    const v1 = a1 * this.ic1 + a2 * v3
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    // The ladder's backstop, for the same reason: a NaN in either integrator
    // is fed back into both on every sample after, and the filter would be
    // silent until the patch was rebuilt. Cleared, it is back on the next one.
    const s = this.ic1 + this.ic2
    if (s - s !== 0) {
      this.ic1 = 0
      this.ic2 = 0
      slots[this.outs[0]] = 0
      return
    }

    let out: number
    switch (mode) {
      case MODE_BP: out = k * v1; break
      case MODE_HP: out = x - k * v1 - v2; break
      case MODE_NOTCH: out = x - k * v1; break
      case MODE_PEAK: out = x + PEAK_GAIN * res * k * v1; break
      case MODE_LP:
      default: out = v2
    }
    slots[this.outs[0]] = out
  }
}

/**
 * The linear gain at a frequency, for drawing. The filter's own
 * coefficients, through the same bilinear warp it runs on, so the picture
 * bends near the top of the range exactly as the sound does. The comb is
 * drawn without its saturation, which only acts on something loud.
 */
export function svfResponse(hz: number, cutoff: number, res: number, mode: number, sampleRate: number) {
  if (mode >= MODE_COMB_POS) {
    const fc = Math.min(Math.max(cutoff, COMB_LOW_HZ), sampleRate * 0.45)
    const fb = (mode === MODE_COMB_NEG ? -1 : 1) * COMB_MAX_FEEDBACK * res
    const w = (2 * Math.PI * hz) / fc
    const mag = 1 / Math.sqrt(Math.max(1e-12, 1 - 2 * fb * Math.cos(w) + fb * fb))
    return mag * (1 - 0.5 * Math.abs(fb))
  }
  const fc = Math.min(Math.max(cutoff, 10), sampleRate * 0.49)
  const f = Math.min(hz, sampleRate * 0.4999)
  const omega = Math.tan((Math.PI * f) / sampleRate) / Math.tan((Math.PI * fc) / sampleRate)
  const k = 1 / svfQ(res)
  // s = jΩ: the denominator is (1 − Ω²) + jkΩ.
  const re = 1 - omega * omega
  const im = k * omega
  const den = Math.sqrt(re * re + im * im)
  switch (mode) {
    case MODE_BP: return (k * omega) / den
    case MODE_HP: return (omega * omega) / den
    case MODE_NOTCH: return Math.abs(1 - omega * omega) / den
    case MODE_PEAK: {
      // One plus the normalised bandpass, jkΩ / den, which takes the phase
      // into account: the bump is added to the dry signal, not to its level.
      const bpRe = (k * omega * im) / (den * den)
      const bpIm = (k * omega * re) / (den * den)
      const lift = PEAK_GAIN * res
      return Math.hypot(1 + lift * bpRe, lift * bpIm)
    }
    case MODE_LP:
    default: return 1 / den
  }
}
