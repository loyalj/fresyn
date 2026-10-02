import { PolyBlepOsc } from '../PolyBlepOsc'
import { railed } from '../Rail'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_FREQ = 0
const P_MIX = 1

const IN_SIGNAL = 0
const IN_CARRIER = 1

const OUT_MIXED = 0
const OUT_CARRIER = 1

/**
 * Two signals multiplied together, which sounds like neither of them.
 *
 * Ring modulation replaces every frequency in the input with two new ones --
 * the sum and the difference against the carrier -- and those land wherever
 * the arithmetic puts them rather than in any harmonic series. That is why it
 * is the one effect in the rack that reliably makes something sound like it
 * was never alive: the Dalek, the alien, the possessed telephone, the bell
 * that is not quite a bell.
 *
 * The carrier is a sine of its own, which is the classic arrangement and the
 * one that gives the cleanest pair of sidebands. It keeps running whether or
 * not anything is patched to the Carrier jack, and is published on its own
 * output, the way the sample and hold's clocks are -- so it is also just a
 * spare sine when you want one.
 *
 * Patch something into Carrier and that takes over. An LFO makes it a tremolo
 * rather than a ring modulator, because a carrier below hearing moves the
 * sidebands too little to separate from the original.
 */
export class RingModModule extends DspModule {
  private osc = new PolyBlepOsc(this.ctx.sampleRate)
  /** A crossfade between the dry signal and the product, so smoothed like any gain. */
  private mix!: Smoothed

  prepare() {
    this.mix = new Smoothed(this.params[P_MIX], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    const signal = this.inputs[IN_SIGNAL]
    const carrierIn = this.inputs[IN_CARRIER]
    const outMixed = this.outputs[OUT_MIXED]
    const outCarrier = this.outputs[OUT_CARRIER]
    const freq = this.params[P_FREQ]
    // An unpatched input reads ground, which is silence, and multiplying by
    // silence is silence -- so the wiring itself has to decide which carrier
    // is in use.
    const patched = this.ins[IN_CARRIER] !== 0
    this.mix.set(this.params[P_MIX])

    for (let i = from; i < to; i++) {
      const dry = signal[i]
      // Free-running whatever is patched, so the Freq knob always does
      // something and the jack always has a sine on it.
      const internal = this.osc.process(freq, 'sine', 0.5)
      const carrier = patched ? carrierIn[i] : internal
      const mix = this.mix.next()
      // Railed for the output fed back into the carrier, which squares itself
      // every sample and overflows almost at once; see `Rail.ts`.
      outMixed[i] = railed(dry * (1 - mix) + dry * carrier * mix)
      outCarrier[i] = internal
    }
  }
}
