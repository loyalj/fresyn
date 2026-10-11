import { Smoothed } from '../Smoothed'
import { Tpt } from '../Tpt'
import { DspModule } from './types'

const P_TRACK = 0
const P_SUB1 = 1
const P_SUB2 = 2
const P_DRY = 3

const IN = 0

const OUT_MIX = 0
const OUT_SUB = 1

/**
 * An octave divider: new notes one and two octaves under whatever comes in,
 * for the floor under an explosion, a kick, an engine.
 *
 * The input is lowpassed at Track and its zero crossings counted: a flip-flop
 * that changes on every rising crossing runs at half the frequency, and a
 * second one fed from the first at a quarter. The flip-flops do not make the
 * sound -- a square would buzz -- but flip the polarity of the filtered input
 * itself, the way the classic subharmonic synthesizers do: so the octaves
 * down follow the input's own level and die with it, and smoothed again at
 * Track they are round and low.
 *
 * Track wants to sit above the lowest note there is and below its first
 * overtone; too high and the divider counts the overtones and stutters.
 */
export class SubharmonicModule extends DspModule {
  readonly rests = true
  private pre = new Tpt()
  private post1 = new Tpt()
  private post2 = new Tpt()
  private last = 0
  private armed = true
  private div2 = 1
  private div4 = 1
  /** The filtered input's level, for the crossings' hysteresis. */
  private env = 0
  private tuned = NaN
  private track!: Smoothed
  private sub1!: Smoothed
  private sub2!: Smoothed
  private dry!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.track = new Smoothed(this.params[P_TRACK], sr, 20)
    this.sub1 = new Smoothed(this.params[P_SUB1], sr)
    this.sub2 = new Smoothed(this.params[P_SUB2], sr)
    this.dry = new Smoothed(this.params[P_DRY], sr)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const input = this.inputs[IN]
    const mix = this.outputs[OUT_MIX]
    const subOut = this.outputs[OUT_SUB]
    this.track.set(this.params[P_TRACK])
    this.sub1.set(this.params[P_SUB1])
    this.sub2.set(this.params[P_SUB2])
    this.dry.set(this.params[P_DRY])
    const envK = 1 - Math.exp(-1 / (0.02 * sr))

    for (let i = from; i < to; i++) {
      const x = input[i]
      const hz = this.track.next()
      // Three tangents a sample is a real cost, and the answer only moves
      // while the knob does.
      if (hz !== this.tuned) {
        this.tuned = hz
        this.pre.tune(hz, 0.7, sr)
        this.post1.tune(hz * 0.5, 0.7, sr)
        this.post2.tune(hz * 0.25, 0.7, sr)
      }
      this.pre.process(x)
      const low = this.pre.low
      const a = low < 0 ? -low : low
      this.env += (a - this.env) * envK

      // A rising crossing counts once it has been below a small fraction of
      // the level, so noise riding on a quiet stretch does not chatter.
      const hysteresis = this.env * 0.1 + 1e-5
      if (this.armed && this.last <= 0 && low > 0) {
        this.armed = false
        this.div2 = -this.div2
        if (this.div2 > 0) this.div4 = -this.div4
      }
      if (low < -hysteresis) this.armed = true
      this.last = low

      this.post1.process(low * this.div2)
      this.post2.process(low * this.div4)
      // The lowpasses take a little level off the octaves; given back.
      const sub = this.post1.low * 1.6 * this.sub1.next() + this.post2.low * 1.6 * this.sub2.next()
      subOut[i] = sub
      mix[i] = x * this.dry.next() + sub
    }
  }
}
