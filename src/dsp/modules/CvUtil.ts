import { railed } from '../Rail'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_GAIN1 = 0
const P_OFFSET1 = 1
const P_GAIN2 = 2
const P_OFFSET2 = 3

const IN_1 = 0
const IN_2 = 1

const OUT_1 = 0
const OUT_2 = 1
const OUT_SUM = 2

/**
 * Two attenuverters with offsets, and their sum.
 *
 * This fills the gap that made half the rack awkward to patch: nothing else
 * could invert or rescale a modulation source. The VCA is unipolar and clamps
 * at zero, so it cannot turn an LFO upside down, shrink a bipolar signal
 * around a centre other than zero, or lift one into positive territory --
 * which is most of what aiming a modulation source actually means.
 *
 * An unpatched input reads ground, so a channel with nothing plugged in puts
 * out its offset alone: a manual CV source for biasing a filter or holding a
 * VCA part-open, for free.
 *
 * There is no multiple here on purpose. Outputs already fan out to as many
 * cables as you like, so a mult would be a module that does nothing.
 */
export class CvUtilModule extends DspModule {
  private gain1!: Smoothed
  private offset1!: Smoothed
  private gain2!: Smoothed
  private offset2!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.gain1 = new Smoothed(this.params[P_GAIN1], sr)
    this.offset1 = new Smoothed(this.params[P_OFFSET1], sr)
    this.gain2 = new Smoothed(this.params[P_GAIN2], sr)
    this.offset2 = new Smoothed(this.params[P_OFFSET2], sr)
  }

  processBlock(from: number, to: number) {
    this.gain1.set(this.params[P_GAIN1])
    this.offset1.set(this.params[P_OFFSET1])
    this.gain2.set(this.params[P_GAIN2])
    this.offset2.set(this.params[P_OFFSET2])

    const in1 = this.inputs[IN_1]
    const in2 = this.inputs[IN_2]
    const out1 = this.outputs[OUT_1]
    const out2 = this.outputs[OUT_2]
    const sum = this.outputs[OUT_SUM]
    // Read once when they have arrived; see the oscillator.
    const { gain1, offset1, gain2, offset2 } = this
    const fixed =
      gain1.settled && offset1.settled && gain2.settled && offset2.settled
    const g1 = gain1.current
    const o1 = offset1.current
    const g2 = gain2.current
    const o2 = offset2.current
    for (let i = from; i < to; i++) {
      // Smoothed, because these knobs multiply the signal directly: a raw
      // jump in a gain is a click, and at audio rate it is zipper noise.
      // Railed, because a gain above one round a feedback cable doubles every
      // sample and is at infinity inside twenty milliseconds; see `Rail.ts`.
      const a = railed(in1[i] * (fixed ? g1 : gain1.next()) + (fixed ? o1 : offset1.next()))
      const b = railed(in2[i] * (fixed ? g2 : gain2.next()) + (fixed ? o2 : offset2.next()))

      out1[i] = a
      out2[i] = b
      // Nothing else in the rack sums CV. The mixer could, but it is an 8:2
      // stereo audio mixer with pan law on every channel, which is the wrong
      // shape for adding two control voltages together.
      sum[i] = a + b
    }
  }
}
