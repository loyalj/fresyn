import { Envelope } from '../Envelope'
import { PolyBlepOsc, type Waveform } from '../PolyBlepOsc'
import { Smoothed } from '../Smoothed'
import { DspModule, EdgeDetector } from './types'

const WAVES: Waveform[] = ['saw', 'pulse', 'tri', 'sine']

const P_PITCH = 0
const P_WAVE = 1
const P_WIDTH = 2
const P_FM_AMOUNT = 3
const P_ENV_AMOUNT = 4
const P_DELAY = 5
const P_ATTACK = 6
const P_HOLD = 7
const P_DECAY = 8
const P_SUSTAIN = 9
const P_RELEASE = 10

const IN_FM = 0
const IN_PWM = 1
const IN_SYNC = 2
const IN_GATE = 3

const OUT_AUDIO = 0
const OUT_ENV = 1

/**
 * Oscillator with an envelope of its own.
 *
 * The envelope is a full module's worth of generator sitting on the panel: it
 * shapes this oscillator's level by `Env Amt`, and is also available on the
 * Env jack to drive anything else in the rack. `Env Amt` defaults to zero so
 * that an oscillator still passes a plain continuous tone, which is what every
 * patch saved before this existed expects.
 */
export class OscModule extends DspModule {
  readonly hasTrigger = true

  private osc = new PolyBlepOsc(this.ctx.sampleRate)
  private sync = new EdgeDetector()
  private env = new Envelope(this.ctx.sampleRate)
  private envOpen = false
  private pitch!: Smoothed
  private width!: Smoothed
  private fmAmount!: Smoothed
  private envAmount!: Smoothed

  prepare() {
    this.pitch = new Smoothed(this.params[P_PITCH], this.ctx.sampleRate, 20)
    this.width = new Smoothed(this.params[P_WIDTH], this.ctx.sampleRate)
    this.fmAmount = new Smoothed(this.params[P_FM_AMOUNT], this.ctx.sampleRate)
    this.envAmount = new Smoothed(this.params[P_ENV_AMOUNT], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    if (this.sync.rose(slots[this.ins[IN_SYNC]])) this.osc.reset()

    // Parameters first: gateOn() branches on the delay time, so setting the
    // stage lengths afterwards would skip the delay on the very sample the
    // envelope is triggered.
    this.env.delay = this.params[P_DELAY]
    this.env.attack = this.params[P_ATTACK]
    this.env.hold = this.params[P_HOLD]
    this.env.decay = this.params[P_DECAY]
    this.env.sustain = this.params[P_SUSTAIN]
    this.env.release = this.params[P_RELEASE]

    // Either the panel trigger or a cable into the Gate jack will fire it;
    // whichever arrives first opens the envelope and the last to leave closes
    // it, so the two can be used together without fighting.
    const open = this.gateOpen || slots[this.ins[IN_GATE]] > 0.5
    if (open !== this.envOpen) {
      this.envOpen = open
      if (open) this.env.gateOn()
      else this.env.gateOff()
    }

    const e = this.env.next()

    this.pitch.set(this.params[P_PITCH])
    this.width.set(this.params[P_WIDTH])
    this.fmAmount.set(this.params[P_FM_AMOUNT])
    this.envAmount.set(this.params[P_ENV_AMOUNT])

    // Exponential FM, so a 1.0 signal with the amount at +1 is one octave up.
    // Linear FM would make the pitch collapse through zero on a bipolar input.
    const fm = slots[this.ins[IN_FM]] * this.fmAmount.next()
    const freq = this.pitch.next() * Math.pow(2, fm)

    const pw = this.width.next() + slots[this.ins[IN_PWM]] * 0.45
    const wave = WAVES[Math.round(this.params[P_WAVE])] ?? 'saw'

    // A blend, not a multiply: at zero the oscillator is wide open, at one it
    // is entirely the envelope's to shape.
    const amount = this.envAmount.next()
    const gain = 1 - amount + amount * e

    slots[this.outs[OUT_AUDIO]] = this.osc.process(freq, wave, pw) * gain
    slots[this.outs[OUT_ENV]] = e
  }
}
