import { DcBlocker } from '../DcBlocker'
import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { Tpt } from '../Tpt'
import { expCv } from '../util'
import { DspModule } from './types'

const P_PITCH = 0
const P_FEEDBACK = 1
const P_FOCUS = 2
const P_DRIFT = 3
const P_AIR = 4
const P_MIX = 5
const P_CV_AMOUNT = 6

const IN = 0
const IN_PITCH = 1
const IN_FEEDBACK = 2

const OUT = 0

const MIN_HZ = 30

/**
 * Feedback on purpose: a microphone too near its speaker, a guitar leaned
 * on an amp, machinery screaming.
 *
 * A loop -- a short delay, a resonant band at Pitch, and a gain of Feedback
 * -- with a soft limiter in it, the way a real room's feedback is held by
 * the amplifier running out of headroom. Below one the loop rings and dies;
 * past one it howls on its own, from whatever comes in at In or from Air,
 * the faint hiss of a live microphone with nothing in front of it. Focus
 * narrows the band so the howl locks onto one note; wide, it wanders between
 * several and squeals. Drift moves the loop slowly, as a hand moving the mic
 * would, so the pitch slides and jumps between modes.
 *
 * Feedback has a jack: an envelope into it is a squeal that swells and is
 * pulled back.
 */
export class HowlModule extends DspModule {
  readonly rests = false
  private line = new DelayLine(this.ctx.sampleRate / MIN_HZ + 4)
  private band = new Tpt()
  private dc = new DcBlocker(this.ctx.sampleRate)
  private loop = 0
  private drift = 0
  private driftTarget = 0
  private driftWait = 0
  private pitch!: Smoothed
  private feedback!: Smoothed
  private focus!: Smoothed
  private air!: Smoothed
  private mix!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.pitch = new Smoothed(this.params[P_PITCH], sr, 20)
    this.feedback = new Smoothed(this.params[P_FEEDBACK], sr)
    this.focus = new Smoothed(this.params[P_FOCUS], sr)
    this.air = new Smoothed(this.params[P_AIR], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const input = this.inputs[IN]
    const pitchIn = this.inputs[IN_PITCH]
    const feedbackIn = this.inputs[IN_FEEDBACK]
    const out = this.outputs[OUT]
    this.pitch.set(this.params[P_PITCH])
    this.feedback.set(this.params[P_FEEDBACK])
    this.focus.set(this.params[P_FOCUS])
    this.air.set(this.params[P_AIR])
    this.mix.set(this.params[P_MIX])
    const driftAmount = this.params[P_DRIFT]
    const cvAmount = this.params[P_CV_AMOUNT]
    const maxDelay = sr / MIN_HZ

    for (let i = from; i < to; i++) {
      const dry = input[i]

      // A new place for the mic every so often, glided to.
      if (--this.driftWait <= 0) {
        this.driftTarget = (this.random() * 2 - 1) * driftAmount
        this.driftWait = Math.round(sr * (0.15 + this.random() * 0.6))
      }
      this.drift += (this.driftTarget - this.drift) * 0.0004

      const hz = expCv(this.pitch.next(), pitchIn[i], 1) * Math.pow(2, this.drift * 0.6)
      // The band sits on the note; the delay is a few cycles of it, so the
      // loop has several modes near the band to choose between.
      const q = 0.8 + this.focus.next() * 30
      this.band.tune(hz, q, sr)
      let delay = (3 * sr) / hz
      if (delay > maxDelay) delay = maxDelay
      if (delay < 2) delay = 2

      const air = (this.random() * 2 - 1) * this.air.next() * 0.003
      const gain = this.feedback.next() + feedbackIn[i] * cvAmount
      // Divided by Q, so the band passes its centre at unity however narrow
      // it is: Focus picks the note, Feedback alone decides how hard it howls.
      const back = this.band.process(this.line.read(delay)) / q
      // The amplifier running out of room is what holds it.
      let y = Math.tanh((back * gain + dry * 0.5 + air) * 1.2)
      if (y - y !== 0) {
        this.line.reset()
        this.band.reset()
        y = 0
      }
      this.line.push(this.dc.process(y))
      this.loop = y
      const mix = this.mix.next()
      out[i] = dry * (1 - mix) + this.loop * mix
    }
  }
}
