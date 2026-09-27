import { Envelope } from '../Envelope'
import { PolyBlepOsc, WAVEFORMS } from '../PolyBlepOsc'
import { Smoothed } from '../Smoothed'
import { DspModule, EdgeDetector, type Metering } from './types'

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
const P_FM_MODE = 11
const P_OCTAVE = 12
const P_LEVEL = 13
const P_ENV_PITCH = 14
const P_ENV_WIDTH = 15

const IN_FM = 0
const IN_PWM = 1
const IN_SYNC = 2
const IN_GATE = 3
/** Appended, like every port added after the fact. */
const IN_PITCH = 4

const OUT_AUDIO = 0
const OUT_ENV = 1

/**
 * How far the envelope may push the width, matching the PWM jack's scaling,
 * so the knob and the cable mean the same thing.
 */
const WIDTH_SWING = 0.45

/**
 * Oscillator with an envelope of its own.
 *
 * The envelope is a full module's worth of generator sitting on the panel. It
 * has three destinations here -- level, pitch and width -- and is also on the
 * Env jack for the rest of the rack. All three amounts default to zero apart
 * from level, so an oscillator still passes a plain continuous tone, which is
 * what every patch saved before any of this existed expects.
 *
 * Pitch is the one worth knowing about: an envelope on it is a sweep, and a
 * sweep is most of what a game sound effect is. A laser is this module with
 * Env Pitch up and a short decay, with nothing patched at all.
 */
export class OscModule extends DspModule implements Metering {
  readonly hasTrigger = true
  /** Its own output level, for the bar on its panel. */
  readonly meter: Metering = this

  private osc = new PolyBlepOsc(this.ctx.sampleRate)
  private sync = new EdgeDetector()
  private env = new Envelope(this.ctx.sampleRate)
  private envOpen = false
  private pitch!: Smoothed
  private width!: Smoothed
  private fmAmount!: Smoothed
  private envAmount!: Smoothed
  private envPitch!: Smoothed
  private envWidth!: Smoothed
  private level!: Smoothed

  /** The octave switch, converted once per change rather than per sample. */
  private octaveAt = 0
  private octaveScale = 1

  private peak = 0
  private readonly report = new Float32Array(1)

  prepare() {
    // The octave is folded in here as well as in process(), or a patch would
    // load at the Pitch knob and glide an octave to where it was saved --
    // twenty milliseconds of wrong pitch, which on a percussive one-shot is
    // the entire attack.
    this.octaveAt = this.params[P_OCTAVE]
    this.octaveScale = Math.pow(2, Math.round(this.octaveAt))
    this.pitch = new Smoothed(this.params[P_PITCH] * this.octaveScale, this.ctx.sampleRate, 20)
    this.width = new Smoothed(this.params[P_WIDTH], this.ctx.sampleRate)
    this.fmAmount = new Smoothed(this.params[P_FM_AMOUNT], this.ctx.sampleRate)
    this.envAmount = new Smoothed(this.params[P_ENV_AMOUNT], this.ctx.sampleRate)
    this.envPitch = new Smoothed(this.params[P_ENV_PITCH], this.ctx.sampleRate)
    this.envWidth = new Smoothed(this.params[P_ENV_WIDTH], this.ctx.sampleRate)
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  levels(): Float32Array {
    this.report[0] = this.peak
    this.peak = 0
    return this.report
  }

  process(slots: Float32Array) {
    if (this.sync.rose(slots[this.ins[IN_SYNC]])) this.osc.syncAt(this.sync.crossing)

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

    // Folded into the pitch smoother rather than multiplied in afterwards, so
    // that changing octave while a note is sounding glides the same way the
    // Pitch knob does instead of stepping.
    if (this.params[P_OCTAVE] !== this.octaveAt) {
      this.octaveAt = this.params[P_OCTAVE]
      this.octaveScale = Math.pow(2, Math.round(this.octaveAt))
    }

    this.envAmount.set(this.params[P_ENV_AMOUNT])
    this.level.set(this.params[P_LEVEL])

    // A blend, not a multiply: at zero the oscillator is wide open, at one it
    // is entirely the envelope's to shape. Level is a plain multiply after
    // it, because that is what a level is.
    const amount = this.envAmount.next()
    const gain = (1 - amount + amount * e) * this.level.next()

    // Nothing can come out at a gain of exactly zero, so nothing is made.
    // That is Env Amt at 1 with the envelope shut -- a one-shot voice between
    // notes -- or the Level knob closed.
    //
    // What it saves is proportional to how much of a rack is oscillators
    // waiting: eight idle voices cost 508 ms of work per ten seconds of audio
    // and now cost 316, while the stock rack idles at 323 against 302 because
    // its filter and its LFO carry on regardless. The case it is really for
    // is the one where a rack is built up to eight voices and two of them are
    // playing, which is most of designing a sound.
    //
    // Exactly zero rather than nearly, because a threshold would be a gate
    // silencing something that was still audible, and because the values that
    // reach it are exact: an idle envelope returns 0, and a knob loaded at
    // 1.00 or 0.00 seeds its smoother with that value rather than gliding to
    // it. A knob turned to the end by hand arrives asymptotically and starts
    // skipping a few seconds later, which costs nothing but a few seconds of
    // work nobody hears.
    if (gain === 0) {
      // Jumped rather than glided: there is no zipper to smooth out in
      // silence, and a knob moved between notes has to be at its new value
      // when the next one starts rather than sliding into it.
      this.pitch.reset(this.params[P_PITCH] * this.octaveScale)
      this.width.reset(this.params[P_WIDTH])
      this.fmAmount.reset(this.params[P_FM_AMOUNT])
      this.envPitch.reset(this.params[P_ENV_PITCH])
      this.envWidth.reset(this.params[P_ENV_WIDTH])
      // The phase stays where it stopped, so the next note begins where this
      // one left off instead of wherever a free-running oscillator had got
      // to. Both are arbitrary; neither is heard.
      slots[this.outs[OUT_AUDIO]] = 0
      slots[this.outs[OUT_ENV]] = e
      return
    }

    this.pitch.set(this.params[P_PITCH] * this.octaveScale)
    this.width.set(this.params[P_WIDTH])
    this.fmAmount.set(this.params[P_FM_AMOUNT])
    this.envPitch.set(this.params[P_ENV_PITCH])
    this.envWidth.set(this.params[P_ENV_WIDTH])

    const pitch = this.pitch.next()
    const fm = slots[this.ins[IN_FM]] * this.fmAmount.next()
    // The envelope's own pitch amount is in octaves whatever the FM jack is
    // set to: it is a sweep rather than a modulator, and a sweep is an
    // interval. In exponential mode it is simply another term in the same
    // exponent, which is also why this costs one power and not two.
    //
    // The Pitch jack is a third term in the same exponent, whichever mode FM
    // is in, so a played note moves the whole voice -- sidebands and all -- by
    // an interval, and linear FM keeps the same index at every key.
    const swept = e * this.envPitch.next() + slots[this.ins[IN_PITCH]]
    // Exponential, so a 1.0 signal with the amount at +1 is one octave up.
    // Musical, and the right thing for a pitch that is being played or swept.
    //
    // Linear is what an audio-rate modulator wants instead. The amount now
    // reads in multiples of the Pitch knob, so the frequency moves by the
    // same number of Hz wherever the carrier is tuned, the sidebands stay put
    // relative to it, and the timbre holds still while the pitch moves --
    // which is the difference between a bell that is the same bell at every
    // pitch and one that changes character as it is played. It is also why
    // the core lets a frequency go negative: at an amount past 1 this drives
    // straight through zero, and stopping there would fold the pitch back up
    // exactly where the interesting part starts.
    const freq =
      this.params[P_FM_MODE] >= 0.5
        ? pitch * Math.pow(2, swept) * (1 + fm)
        : pitch * Math.pow(2, swept + fm)

    const pw =
      this.width.next() +
      slots[this.ins[IN_PWM]] * WIDTH_SWING +
      e * this.envWidth.next() * WIDTH_SWING
    const wave = WAVEFORMS[Math.round(this.params[P_WAVE])] ?? 'saw'

    const out = this.osc.process(freq, wave, pw) * gain
    const size = out < 0 ? -out : out
    if (size > this.peak) this.peak = size

    slots[this.outs[OUT_AUDIO]] = out
    slots[this.outs[OUT_ENV]] = e
  }
}
