import { expCv, pulseSamples, tauDecay } from '../util'
import { DspModule } from './types'

const P_DENSITY = 0
const P_SPREAD = 1
const P_DECAY = 2
const P_TONE = 3
const P_CV_AMOUNT = 4

const IN_DENSITY = 0

const OUT_AUDIO = 0
const OUT_TRIG = 1

/**
 * Impulses at random moments, rather than noise at every sample.
 *
 * The Noise module is a continuous hiss; a great deal of the world is not.
 * Rain on a roof, a fire, a Geiger counter, sparks, the crackle on a record
 * -- each is separate events at a density, and what they sound like is
 * mostly how far apart they land. Density is that, as an average rate: the
 * gaps between impulses are random, so twenty a second never sounds like a
 * clock.
 *
 * Each impulse starts a short decay rather than lasting one sample. A single
 * sample is the thinnest click there is and very quiet for how loud it
 * measures; Decay is what turns it into a tick, a pop or a patter. Tone
 * chooses what decays: `click` is the impulse itself, so its colour is its
 * length, and `noise` is a burst of hiss, which is sizzle and crackle.
 *
 * A new impulse replaces the one still decaying rather than adding to it, so
 * the level stays bounded however thick the dust gets -- at the top of
 * Density the impulses overlap into something close to noise, which is the
 * right place for the knob to end up.
 */
export class DustModule extends DspModule {
  /** The current impulse's amplitude, signed, decaying towards zero. */
  private env = 0
  private trigLeft = 0
  /** One low sample before a trigger that lands while the last is high. */
  private trigGap = false
  private trigLength = 1

  prepare() {
    // How long Trig stays high after each impulse: the rack's usual pulse.
    this.trigLength = pulseSamples(this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const densityCv = this.inputs[IN_DENSITY]
    const outAudio = this.outputs[OUT_AUDIO]
    const outTrig = this.outputs[OUT_TRIG]
    const base = this.params[P_DENSITY]
    const amount = this.params[P_CV_AMOUNT]
    const spread = this.params[P_SPREAD]
    const noisy = Math.round(this.params[P_TONE]) === 1
    // Worked out once a block rather than once a sample: it is the same
    // number every time until the knob moves.
    const decay = this.params[P_DECAY]
    const fall = decay > 0 ? tauDecay(decay * sr) : 0

    for (let i = from; i < to; i++) {
      // Exponential CV, like every rate in the rack: a fixed amount moves the
      // density by the same number of doublings wherever the knob sits.
      const density = expCv(base, densityCv[i], amount)
      const chance = density / sr

      // Four draws every sample whether or not one fires, so the stream stays
      // in step: a Density change moves where the impulses land without
      // reshuffling which amplitude each of them gets, and switching Tone
      // changes the sound without moving the impulses at all.
      const roll = this.random()
      const size = this.random()
      const sign = this.random()
      const hiss = this.random() * 2 - 1

      if (roll < chance) {
        this.env = (1 - spread * size) * (sign < 0.5 ? -1 : 1)
        if (this.trigLeft > 0) this.trigGap = true
        this.trigLeft = this.trigLength
      }

      outAudio[i] = noisy ? this.env * hiss : this.env

      // After the sample goes out, so an impulse's first sample is its full
      // height and Spread at zero really is every one at full scale.
      this.env *= fall

      if (this.trigGap) {
        outTrig[i] = 0
        this.trigGap = false
      } else {
        outTrig[i] = this.trigLeft > 0 ? 1 : 0
      }
      if (this.trigLeft > 0) this.trigLeft--
    }
  }
}
