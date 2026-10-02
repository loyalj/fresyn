import { PolyBlepOsc, WAVEFORMS } from '../PolyBlepOsc'
import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_RATE = 0
const P_SHAPE = 1
const P_WIDTH = 2
const P_DEPTH = 3
const P_CV_AMOUNT = 4

const IN_SYNC = 0
const IN_PWM = 1
const IN_CV = 2

const OUT_BIPOLAR = 0
const OUT_UNIPOLAR = 1

/**
 * Shares the oscillator core, so it stays band-limited and can be pushed into
 * audio rate for FM without turning to aliasing mush.
 *
 * Width and its PWM input work exactly as the oscillator's do, and matter
 * more here than they look. A pulse narrowed to a sliver is a repeating
 * trigger rather than a square, which is the only way this rack can make a
 * short periodic gate; and because the core places the triangle's peak at
 * the width, Width also tilts the triangle from a down-ramp through a
 * symmetrical peak to an up-ramp.
 */
export class LfoModule extends DspModule {
  private osc = new PolyBlepOsc(this.ctx.sampleRate)
  private sync = new EdgeDetector()
  private width!: Smoothed
  private depth!: Smoothed

  prepare() {
    this.width = new Smoothed(this.params[P_WIDTH], this.ctx.sampleRate)
    this.depth = new Smoothed(this.params[P_DEPTH], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.width.set(this.params[P_WIDTH])
    this.depth.set(this.params[P_DEPTH])
    const sync = this.inputs[IN_SYNC]
    const pwm = this.inputs[IN_PWM]
    const cv = this.inputs[IN_CV]
    const outBi = this.outputs[OUT_BIPOLAR]
    const outUni = this.outputs[OUT_UNIPOLAR]
    const base = this.params[P_RATE]
    const amount = this.params[P_CV_AMOUNT]
    const wave = WAVEFORMS[Math.round(this.params[P_SHAPE])] ?? 'sine'
    const osc = this.osc

    for (let i = from; i < to; i++) {
      if (this.sync.rose(sync[i])) osc.syncAt(this.sync.crossing)

      // The same scaling the oscillator uses, so one modulation source sweeps
      // both by the same amount. The core clamps the result to a usable
      // width.
      const pw = this.width.next() + pwm[i] * 0.45

      // Exponential, like every other rate in the rack: a fixed amount moves
      // it by the same number of doublings wherever the knob is set, so a
      // falling envelope slows a wobble down by an interval rather than by a
      // number of hertz that means something different at each end of the
      // knob.
      //
      // Not smoothed, because the rate is not smoothed either: an
      // oscillator's phase is continuous through a rate change, so there is
      // nothing to zipper -- only the step it would take to get there, which
      // is the point.
      const rate = expCv(base, cv[i], amount)
      const v = osc.process(rate, wave, pw) * this.depth.next()

      outBi[i] = v
      // Unipolar tap, for anything that should not go negative: filter
      // cutoff, VCA gain, pulse width.
      outUni[i] = v * 0.5 + 0.5
    }
  }
}
