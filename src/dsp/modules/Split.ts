import { allpass, highpass, lowpass, Section } from '../Biquad'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LOW_X = 0
const P_HIGH_X = 1
const P_LOW = 2
const P_MID = 3
const P_HIGH = 4

const IN_SIGNAL = 0

const OUT_LOW = 0
const OUT_MID = 1
const OUT_HIGH = 2
const OUT_SUM = 3

/** Butterworth: two of these in a row is a Linkwitz-Riley slope, which sums back flat. */
const Q = Math.SQRT1_2

/**
 * Band Splitter: one signal into three bands -- low, mid and high -- that add
 * back up to exactly what went in.
 *
 * Each crossover is a Linkwitz-Riley pair, 24 dB an octave, the kind a
 * loudspeaker's crossover uses: each band is 6 dB down where it meets the
 * next, and the two halves sum to the original level at every frequency. The
 * low band is passed through an all-pass at the upper crossover as well, so
 * all three line up in phase there too and sum flat.
 *
 * So a band can be treated on its own -- the mids driven, the lows kept dry
 * and in mono, a reverb on the top only -- and mixed back in with nothing
 * lost. Out is the three summed at their levels, which makes it a DJ's
 * isolator on its own: turn a band down to take it out.
 */
export class SplitModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private lowA = new Section()
  private lowB = new Section()
  private restA = new Section()
  private restB = new Section()
  private midA = new Section()
  private midB = new Section()
  private highA = new Section()
  private highB = new Section()
  private lowPhase = new Section()
  private lowX!: Smoothed
  private highX!: Smoothed
  private low!: Smoothed
  private mid!: Smoothed
  private high!: Smoothed
  private tunedLow = NaN
  private tunedHigh = NaN

  prepare() {
    const sr = this.ctx.sampleRate
    this.lowX = new Smoothed(this.params[P_LOW_X], sr, 30)
    this.highX = new Smoothed(this.params[P_HIGH_X], sr, 30)
    this.low = new Smoothed(this.params[P_LOW], sr)
    this.mid = new Smoothed(this.params[P_MID], sr)
    this.high = new Smoothed(this.params[P_HIGH], sr)
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[IN_SIGNAL]
    const outLow = this.outputs[OUT_LOW]
    const outMid = this.outputs[OUT_MID]
    const outHigh = this.outputs[OUT_HIGH]
    const outSum = this.outputs[OUT_SUM]
    this.lowX.set(this.params[P_LOW_X])
    this.highX.set(this.params[P_HIGH_X])
    this.low.set(this.params[P_LOW])
    this.mid.set(this.params[P_MID])
    this.high.set(this.params[P_HIGH])

    for (let i = from; i < to; i++) {
      let x = input[i]
      if (x - x !== 0) x = 0
      const fl = this.lowX.next()
      // The upper crossover is never let below the lower one: the bands
      // would overlap, and then they would not sum flat.
      const fh = Math.max(fl, this.highX.next())
      if (fl !== this.tunedLow || fh !== this.tunedHigh) this.tune(fl, fh)

      const lowBand = this.lowPhase.process(this.lowB.process(this.lowA.process(x)))
      const rest = this.restB.process(this.restA.process(x))
      const midBand = this.midB.process(this.midA.process(rest))
      const highBand = this.highB.process(this.highA.process(rest))
      const l = lowBand * this.low.next()
      const m = midBand * this.mid.next()
      const h = highBand * this.high.next()
      outLow[i] = l
      outMid[i] = m
      outHigh[i] = h
      outSum[i] = l + m + h
    }
  }

  private tune(fl: number, fh: number) {
    const sr = this.ctx.sampleRate
    this.tunedLow = fl
    this.tunedHigh = fh
    lowpass(this.lowA, sr, fl, Q)
    this.lowB.copy(this.lowA)
    highpass(this.restA, sr, fl, Q)
    this.restB.copy(this.restA)
    lowpass(this.midA, sr, fh, Q)
    this.midB.copy(this.midA)
    highpass(this.highA, sr, fh, Q)
    this.highB.copy(this.highA)
    allpass(this.lowPhase, sr, fh, Q)
  }
}
