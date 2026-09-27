import { bell, Section, shelf } from '../Biquad'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LOW_GAIN = 0
const P_LOW_FREQ = 1
const P_MID_GAIN = 2
const P_MID_FREQ = 3
const P_HIGH_GAIN = 4
const P_HIGH_FREQ = 5

const IN_SIGNAL = 0

/** The mid band's width: about an octave and a half, broad enough to be musical. */
const MID_Q = 0.9
/** Kept under Nyquist whatever the knob says, at any sample rate. */
const MAX_FRACTION = 0.45

/**
 * Three bands of tone: a low shelf, a bell in the middle, and a high shelf,
 * each with a gain and a frequency.
 *
 * The everyday corrections a Ladder is the wrong tool for. Taking the weight
 * out of one layer of an impact is a low shelf pulled down, not a highpass
 * that takes the thump with it; a sound that is too harsh wants a couple of
 * decibels out around 3 kHz, not a lowpass that dulls everything above.
 *
 * The shapes are the RBJ cookbook's, which every EQ you have used is built
 * from. Coefficients are only worked out while a knob is moving.
 */
export class EqModule extends DspModule {
  private low = new Section()
  private mid = new Section()
  private high = new Section()
  private smooth!: Smoothed[]
  private last = new Float64Array(6).fill(NaN)
  /**
   * How many times the curve has been redesigned. Nothing reads it in the
   * app; it is here so a check can see the EQ goes quiet once its knobs have.
   */
  tunings = 0

  prepare() {
    this.smooth = Array.from({ length: 6 }, (_, i) => new Smoothed(this.params[i], this.ctx.sampleRate))
    for (let i = 0; i < 6; i++) this.last[i] = this.smooth[i].next()
    this.tune()
  }

  /** Every knob where it was turned to, so the curve has stopped changing. */
  get settled() {
    for (let i = 0; i < 6; i++) if (!this.smooth[i].settled) return false
    return true
  }

  process(slots: Float32Array) {
    let changed = false
    for (let i = 0; i < 6; i++) {
      const s = this.smooth[i]
      s.set(this.params[i])
      // A smoother at rest returns the value it returned last time, which is
      // already what the sections were designed for.
      if (s.settled) continue
      const v = s.next()
      if (v !== this.last[i]) {
        this.last[i] = v
        changed = true
      }
    }
    if (changed) this.tune()

    const x = slots[this.ins[IN_SIGNAL]]
    slots[this.outs[0]] = this.high.process(this.mid.process(this.low.process(x)))
  }

  private tune() {
    this.tunings++
    const sr = this.ctx.sampleRate
    const clampF = (f: number) => Math.min(f, sr * MAX_FRACTION)
    shelf(this.low, sr, clampF(this.last[P_LOW_FREQ]), this.last[P_LOW_GAIN], false)
    bell(this.mid, sr, clampF(this.last[P_MID_FREQ]), this.last[P_MID_GAIN], MID_Q)
    shelf(this.high, sr, clampF(this.last[P_HIGH_FREQ]), this.last[P_HIGH_GAIN], true)
  }
}
