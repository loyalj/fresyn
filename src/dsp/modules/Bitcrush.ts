import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule } from './types'

const P_BITS = 0
const P_RATE = 1
const P_MIX = 2
const P_CV_AMOUNT = 3

const IN_SIGNAL = 0
const IN_CV = 1

/**
 * Two kinds of damage in one panel, because they are the two halves of what
 * digital audio throws away and they are always wanted together.
 *
 * **Bits** is how finely the level is measured. Drop it and the quiet parts
 * of a sound land on the same few values, which is heard as grit that gets
 * worse as the sound fades -- the opposite of analogue distortion, and the
 * giveaway that something is digital rather than dirty.
 *
 * **Rate** is how often it is measured at all. Drop that and everything above
 * half the new rate folds back down into the audible range as a metallic,
 * unrelated ringing. This is the sound of a sample played back on hardware
 * that could not afford to store it properly: retro weapons, damaged
 * electronics, a radio voice arriving through something broken.
 *
 * The rack could already do a rough version of the second half -- an
 * oscillator clocking the Sample & Hold's Trig samples a signal at audio rate
 * -- but the Rate knob here goes where the oscillator cannot, and nothing in
 * the rack could quantise a level at all.
 */
export class BitcrushModule extends DspModule {
  /** Where the sampler is between one reading and the next. */
  private phase = 0
  /** The reading it is holding. */
  private held = 0
  /** A crossfade, so a step in it is a step between two different signals. */
  private mix!: Smoothed

  prepare() {
    this.mix = new Smoothed(this.params[P_MIX], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    const dry = slots[this.ins[IN_SIGNAL]]

    // A falling envelope into Rate is a machine winding down: the sampler
    // slows, the steps get longer and the pitch of what it is holding drops
    // with it.
    const rate =
      expCv(this.params[P_RATE], slots[this.ins[IN_CV]], this.params[P_CV_AMOUNT])
    this.phase += rate / this.ctx.sampleRate
    if (this.phase >= 1) {
      // Not a while loop: asking for a rate above the one the rack runs at
      // means every sample is a fresh reading, which is what dropping the
      // leftover phase gives, and a loop would spin for the same answer.
      this.phase -= Math.floor(this.phase)

      // Quantise on the way in, so the level held between readings is the
      // level that was actually stored rather than a rounded copy of it.
      const levels = Math.pow(2, Math.round(this.params[P_BITS]) - 1)
      const step = Math.round(dry * levels)
      this.held = levels > 0 ? step / levels : 0
    }

    this.mix.set(this.params[P_MIX])
    const mix = this.mix.next()
    slots[this.outs[0]] = dry * (1 - mix) + this.held * mix
  }
}
