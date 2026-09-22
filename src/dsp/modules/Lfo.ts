import { PolyBlepOsc, type Waveform } from '../PolyBlepOsc'
import { Smoothed } from '../Smoothed'
import { DspModule, EdgeDetector } from './types'

const WAVES: Waveform[] = ['saw', 'pulse', 'tri', 'sine']

const P_RATE = 0
const P_SHAPE = 1
const P_WIDTH = 2
const P_DEPTH = 3

const IN_SYNC = 0
const IN_PWM = 1

const OUT_BIPOLAR = 0
const OUT_UNIPOLAR = 1

/**
 * Shares the oscillator core, so it stays band-limited and can be pushed into
 * audio rate for FM without turning to aliasing mush.
 *
 * Width and its PWM input work exactly as the oscillator's do, and matter
 * more here than they look. A pulse narrowed to a sliver is a repeating
 * trigger rather than a square, which is the only way this rack can make a
 * short periodic gate; and because the core builds its triangle by
 * integrating that pulse, Width also tilts the triangle from a down-ramp
 * through a symmetrical peak to an up-ramp.
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

  process(slots: Float32Array) {
    if (this.sync.rose(slots[this.ins[IN_SYNC]])) this.osc.reset()

    this.width.set(this.params[P_WIDTH])
    this.depth.set(this.params[P_DEPTH])
    // The same scaling the oscillator uses, so one modulation source sweeps
    // both by the same amount. The core clamps the result to a usable width.
    const pw = this.width.next() + slots[this.ins[IN_PWM]] * 0.45

    const wave = WAVES[Math.round(this.params[P_SHAPE])] ?? 'sine'
    const v = this.osc.process(this.params[P_RATE], wave, pw) * this.depth.next()

    slots[this.outs[OUT_BIPOLAR]] = v
    // Unipolar tap, for anything that should not go negative: filter cutoff,
    // VCA gain, pulse width.
    slots[this.outs[OUT_UNIPOLAR]] = v * 0.5 + 0.5
  }
}
