import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule } from './types'

const P_PITCH = 0
const P_PRESSURE = 1
const P_SPEED = 2
const P_POSITION = 3
const P_ROUGH = 4
const P_LEVEL = 5

const IN_GATE = 0
const IN_SPEED = 1
const IN_PITCH = 2

const OUT = 0

/** The lowest the Pitch knob or its CV can take it; the lines are built to hold it. */
const MIN_HZ = 15

/** How quickly the bow comes up to speed and lets go: a hand, not a switch. */
const BOW_MS = 25

/**
 * Something dragged across something else that grips and lets go: a bow on
 * a string, a hinge, a wet finger round a glass, a tyre on tarmac.
 *
 * A bowed-string waveguide after Smith and the STK: a string as two delay
 * lines either side of the bow, and a friction curve at the bow that sticks
 * while the string moves with it and slips once the difference is too
 * great. Sticking and slipping in turn is what makes the tone -- there is no
 * oscillator anywhere -- so the sound only exists while the bow is moving.
 *
 * Pitch is the string's length. High and steady is a cello or a glass;
 * low, with Pressure up and Speed creeping, it stops being a note and
 * becomes the irregular groan of a door, and Rough shakes the bow so the
 * grip catches unevenly. A rising gate at Gate starts the bow, as a held
 * note; nothing patched there and it bows for ever.
 */
export class FrictionModule extends DspModule {
  private neck = new DelayLine(this.ctx.sampleRate / MIN_HZ)
  private bridge = new DelayLine(this.ctx.sampleRate / MIN_HZ)
  /** The string's losses at the bridge: the high end coming off each time round. */
  private loss = new OnePole()
  private dc = new DcBlocker(this.ctx.sampleRate)
  private neckOut = 0
  private bridgeOut = 0
  private bow = 0
  /** A slow random wander for Rough, so the grip catches unevenly rather than hissing. */
  private wander = 0
  private pitch!: Smoothed
  private pressure!: Smoothed
  private position!: Smoothed
  private level!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.pitch = new Smoothed(this.params[P_PITCH], sr, 20)
    this.pressure = new Smoothed(this.params[P_PRESSURE], sr)
    this.position = new Smoothed(this.params[P_POSITION], sr, 20)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const gate = this.inputs[IN_GATE]
    const speedIn = this.inputs[IN_SPEED]
    const pitchIn = this.inputs[IN_PITCH]
    const out = this.outputs[OUT]
    this.pitch.set(this.params[P_PITCH])
    this.pressure.set(this.params[P_PRESSURE])
    this.position.set(this.params[P_POSITION])
    this.level.set(this.params[P_LEVEL])
    const speedKnob = this.params[P_SPEED]
    const rough = this.params[P_ROUGH]
    const gated = this.ins[IN_GATE] !== 0
    const bowK = 1 - Math.exp(-1000 / (BOW_MS * sr))
    const maxPeriod = sr / MIN_HZ - 1

    for (let i = from; i < to; i++) {
      const on = !gated || gate[i] > 0.5
      let speed = speedKnob + speedIn[i]
      speed = speed < 0 ? 0 : speed > 1.5 ? 1.5 : speed
      this.bow += ((on ? speed : 0) - this.bow) * bowK

      // Rough: a wander a few tens of hertz wide, scaled to the bow, so a
      // still bow stays silent however rough the surface.
      this.wander += ((this.random() * 2 - 1) - this.wander) * 0.02
      const bowVelocity = this.bow * 0.25 * (1 + rough * 2.5 * this.wander)

      const hz = expCv(this.pitch.next(), pitchIn[i], 1)
      // Less the loop's own delay -- the loss filter and the reads, about
      // four tenths of a sample -- so the string sounds the note it is set to.
      let period = sr / (hz > MIN_HZ ? hz : MIN_HZ) - 0.4
      if (period > maxPeriod) period = maxPeriod
      if (period < 2) period = 2
      const beta = 0.03 + this.position.next() * 0.45
      const pressure = this.pressure.next()

      const nutReflection = -this.neckOut
      const bridgeReflection = -this.loss.process(this.bridgeOut, 0.25)
      const stringVelocity = nutReflection + bridgeReflection
      const delta = bowVelocity - stringVelocity
      // The friction curve: near one while the bow and string move together
      // (sticking, the bow drags the string along) and falling off fast once
      // they part (slipping). Pressure makes it steeper, so the grip holds
      // harder and lets go more violently.
      const slope = 5 - 4 * pressure
      let grip = Math.abs(delta * slope) + 0.75
      grip = Math.pow(grip, -4)
      if (grip > 1) grip = 1
      const added = this.bow > 1e-5 ? delta * grip : 0

      this.neck.push(bridgeReflection + added)
      this.bridge.push(nutReflection + added)
      this.neckOut = this.neck.read(period * (1 - beta))
      this.bridgeOut = this.bridge.read(period * beta)

      // A NaN would live in the lines for ever; emptied, the string is quiet.
      if (this.neckOut - this.neckOut !== 0 || this.bridgeOut - this.bridgeOut !== 0) {
        this.neck.reset()
        this.bridge.reset()
        this.loss.reset()
        this.neckOut = this.bridgeOut = 0
      }
      out[i] = Math.tanh(this.dc.process(this.bridgeOut) * 5) * this.level.next()
    }
  }
}
