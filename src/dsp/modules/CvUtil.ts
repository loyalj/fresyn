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

  process(slots: Float32Array) {
    this.gain1.set(this.params[P_GAIN1])
    this.offset1.set(this.params[P_OFFSET1])
    this.gain2.set(this.params[P_GAIN2])
    this.offset2.set(this.params[P_OFFSET2])

    // Smoothed, because these knobs multiply the signal directly: a raw jump
    // in a gain is a click, and at audio rate it is zipper noise.
    const a = slots[this.ins[IN_1]] * this.gain1.next() + this.offset1.next()
    const b = slots[this.ins[IN_2]] * this.gain2.next() + this.offset2.next()

    slots[this.outs[OUT_1]] = a
    slots[this.outs[OUT_2]] = b
    // Nothing else in the rack sums CV. The mixer could, but it is an 8:2
    // stereo audio mixer with pan law on every channel, which is the wrong
    // shape for adding two control voltages together.
    slots[this.outs[OUT_SUM]] = a + b
  }
}
