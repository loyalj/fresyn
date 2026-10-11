import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { Tpt } from '../Tpt'
import { expCv } from '../util'
import { DspModule } from './types'

const P_RPM = 0
const P_CYLINDERS = 1
const P_LOAD = 2
const P_MISFIRE = 3
const P_EXHAUST = 4
const P_ROUGH = 5
const P_LEVEL = 6
const P_CV_AMOUNT = 7

const IN_RPM = 0
const IN_LOAD = 1

const OUT = 0

/** The most cylinders the knob reaches; each has its own character, drawn once. */
const MAX_CYLINDERS = 12

/** The lowest the Exhaust knob goes; the pipe is built to be that long. */
const MIN_PIPE_HZ = 30

/**
 * A combustion engine: cars, generators, boats, mechs, a chainsaw.
 *
 * A four-stroke fires each cylinder once every two turns, so RPM and
 * Cylinders together set how many bangs a second there are -- 900 rpm on
 * four cylinders is thirty, a burble; 6000 on eight is four hundred, a
 * scream. Each bang is a short pulse of pressure into an exhaust pipe, which
 * rings at Exhaust, and out through a muffler that opens up with Load.
 *
 * Load is the throttle: the bangs get harder, brighter and noisier as it
 * opens, and an engine on the overrun at no load is a soft, dull patter.
 * No two cylinders are quite alike -- each is drawn a little stronger or
 * weaker once -- which is the lope of an idling V8; Rough shakes the timing
 * and the strength of every bang on top of that, and Misfire skips bangs
 * at random, the cough of a cold start or a failing plug.
 *
 * RPM's jack is a volt an octave, so a game's own speed or an envelope
 * revving it is one cable -- or turn the knob from a game with `setParam`.
 */
export class EngineModule extends DspModule {
  private pipe = new DelayLine(this.ctx.sampleRate / MIN_PIPE_HZ + 4)
  private pipeDamp = new OnePole()
  private muffler = new Tpt()
  private clatter = new Tpt()
  private dc = new DcBlocker(this.ctx.sampleRate)
  /** Where in the firing cycle it is: one per bang. */
  private phase = 0
  /** Which cylinder fires next. */
  private next = 0
  /** Each cylinder's own strength, drawn once. */
  private character = new Float64Array(MAX_CYLINDERS)
  /** The bang now sounding: its pressure, and how fast it falls away. */
  private bang = 0
  private noisy = 0
  /** How long until the next bang, jittered by Rough, as a fraction of the even spacing. */
  private spacing = 1
  private rpm!: Smoothed
  private load!: Smoothed
  private exhaust!: Smoothed
  private level!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.rpm = new Smoothed(this.params[P_RPM], sr, 30)
    this.load = new Smoothed(this.params[P_LOAD], sr, 30)
    this.exhaust = new Smoothed(this.params[P_EXHAUST], sr, 30)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
  }

  seedFrom(seed: number, id: string) {
    super.seedFrom(seed, id)
    // Drawn here, so a reseed gives a different engine and a render the same one.
    for (let c = 0; c < MAX_CYLINDERS; c++) this.character[c] = 0.75 + 0.5 * this.random()
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const rpmIn = this.inputs[IN_RPM]
    const loadIn = this.inputs[IN_LOAD]
    const out = this.outputs[OUT]
    this.rpm.set(this.params[P_RPM])
    this.load.set(this.params[P_LOAD])
    this.exhaust.set(this.params[P_EXHAUST])
    this.level.set(this.params[P_LEVEL])
    let cylinders = Math.round(this.params[P_CYLINDERS])
    cylinders = cylinders < 1 ? 1 : cylinders > MAX_CYLINDERS ? MAX_CYLINDERS : cylinders
    const misfire = this.params[P_MISFIRE]
    const rough = this.params[P_ROUGH]
    const cvAmount = this.params[P_CV_AMOUNT]
    const maxPipe = sr / MIN_PIPE_HZ

    for (let i = from; i < to; i++) {
      const rpm = expCv(this.rpm.next(), rpmIn[i], cvAmount)
      let load = this.load.next() + loadIn[i]
      load = load < 0 ? 0 : load > 1 ? 1 : load
      // Bangs a second: every cylinder once in two turns.
      const rate = ((rpm > 0 ? rpm : 0) / 60) * (cylinders / 2)

      this.phase += rate / sr
      if (this.phase >= this.spacing) {
        this.phase -= this.spacing
        this.fire(cylinders, load, misfire, rough)
      }

      // The bang: a quick rise of pressure falling away, harder and with
      // more of a crack of noise in it as the throttle opens. Short at any
      // speed, so a fast engine is a buzz of separate bangs rather than a
      // smear.
      const pulse = this.bang + this.noisy * (this.random() * 2 - 1)
      const fall = Math.exp(-1 / (sr * (0.0012 + 0.0025 * (1 - load))))
      this.bang *= fall
      this.noisy *= fall

      // The pipe: a comb at Exhaust, losing its top each time round.
      const hz = this.exhaust.next()
      let delay = sr / hz
      if (delay > maxPipe) delay = maxPipe
      if (delay < 2) delay = 2
      const back = this.pipeDamp.process(this.pipe.read(delay), 0.4)
      let air = pulse + back * 0.55
      if (air - air !== 0) {
        this.pipe.reset()
        this.pipeDamp.reset()
        air = 0
      }
      this.pipe.push(air)

      // The muffler opens up with the throttle; the valvetrain ticks on top,
      // faster and louder with the revs.
      this.muffler.tune(350 + 3500 * load * load + rpm * 0.15, 0.7, sr)
      this.muffler.process(air)
      this.clatter.tune(2500 + rpm * 0.4, 3, sr)
      const tick = this.clatter.process(this.random() * 2 - 1) * Math.min(1, rpm / 8000) * 0.04

      out[i] = Math.tanh(this.dc.process(this.muffler.low * 1.6 + tick) * 1.5) * this.level.next()
    }
  }

  private fire(cylinders: number, load: number, misfire: number, rough: number) {
    const c = this.next
    this.next = (this.next + 1) % cylinders
    // The gap to the bang after this one: even, shaken by Rough.
    this.spacing = 1 + (this.random() * 2 - 1) * rough * 0.35
    if (this.random() < misfire) return
    const strength = this.character[c] * (1 + (this.random() * 2 - 1) * rough * 0.5) * (0.35 + 0.65 * load)
    this.bang += strength
    this.noisy += strength * (0.15 + 0.6 * load)
  }
}
