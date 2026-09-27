import { Envelope } from '../Envelope'
import { Smoothed } from '../Smoothed'
import { DspModule, type Metering } from './types'

const P_PITCH = 0
const P_TONE = 1
const P_BREATH = 2
const P_JITTER = 3
const P_GROWL = 4
const P_VIB_RATE = 5
const P_VIB_DEPTH = 6
const P_MODE = 7
const P_ATTACK = 8
const P_RELEASE = 9
const P_LEVEL = 10

const IN_GATE = 0
const IN_PITCH = 1
const IN_BREATH = 2

const OUT_AUDIO = 0
const OUT_ENV = 1

const MIN_FREQ = 20

/**
 * How long the vocal folds stay open, as a fraction of each cycle, at either
 * end of Tone. A soft voice barely closes; a pressed one snaps shut early and
 * stays shut, and the shorter the open phase the brighter the buzz.
 */
const OQ_SOFT = 0.85
const OQ_PRESSED = 0.35

/** The spectral tilt at either end of Tone: a one-pole lowpass corner. */
const TILT_SOFT = 900
const TILT_PRESSED = 9000

/**
 * The widest the pitch wanders from one cycle to the next at Jitter 1, and the
 * most the loudness does. A healthy voice sits around a tenth of both; the top
 * of the knob is a very old man or a very large animal.
 */
const MAX_JITTER = 0.04
const MAX_SHIMMER = 0.35

/** At Growl 1: how far alternate cycles differ in length, and in loudness. */
const GROWL_PERIOD = 0.22
const GROWL_AMP = 0.75

/** Vib Depth 1 is this many semitones either side. */
const VIB_SEMITONES = 1

/** Where breath noise is highpassed: aspiration has no rumble in it. */
const BREATH_CORNER = 600
/** How much breath is left while the folds are shut. */
const BREATH_CLOSED = 0.35
/** Noise against a buzz of the same peak reads far louder; this evens them. */
const BREATH_GAIN = 0.6

/**
 * A pulse the shape of the air let through by the vocal folds, not a waveform
 * from a synthesiser -- which is most of why a voice through a formant filter
 * sounds like somebody rather than something.
 *
 * The flow model is the one from Klatt's KLGLOTT88: a cubic that swells open
 * and snaps shut, then silence until the next cycle. What comes out is its
 * derivative, as the mouth radiates it: a gentle rise and a sharp negative
 * spike at the instant of closure, and that spike is the excitation -- every
 * harmonic of the voice is struck by it once a cycle. It is the one step in
 * the wave, so it is the one place the band limiting has to go.
 *
 * Everything else on the panel is what makes a buzz sound alive. Jitter and
 * shimmer are the tiny cycle-to-cycle irregularities every real voice has and
 * no oscillator does; Growl makes alternate cycles differ, which puts a
 * subharmonic an octave down -- a vocal fry, a growl, a zombie. Breath is the
 * aspiration noise, pulsed by the folds opening and closing, and at the top of
 * its range it replaces the buzz entirely: a whisper.
 *
 * There is no vowel here. That is the Formant module's job, and the split is
 * the one a real voice makes: the folds make the buzz and the mouth shapes it.
 * Patched into anything else -- a Ladder, a Resonator, a Drive -- this is
 * still a buzz with a pulse in it, which is its own useful sound.
 */
export class VoiceModule extends DspModule implements Metering {
  readonly hasTrigger = true
  readonly meter: Metering = this

  private env = new Envelope(this.ctx.sampleRate)
  private envOpen = false
  private pitch!: Smoothed
  private tone!: Smoothed
  private breath!: Smoothed
  private level!: Smoothed

  /** Position in the current cycle, 0..1. */
  private phase = 0
  /** This cycle's length and loudness, drawn when it starts. */
  private periodScale = 1
  private cycleAmp = 1
  /** Alternates every cycle, for Growl. */
  private odd = false
  private vibPhase = 0
  private tilt = 0
  private noiseLow = 0

  private peak = 0
  private readonly report = new Float32Array(1)

  prepare() {
    this.pitch = new Smoothed(this.params[P_PITCH], this.ctx.sampleRate, 20)
    this.tone = new Smoothed(this.params[P_TONE], this.ctx.sampleRate)
    this.breath = new Smoothed(this.params[P_BREATH], this.ctx.sampleRate)
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
    this.env.delay = 0
    this.env.hold = 0
    this.env.decay = 0.002
    this.env.sustain = 1
  }

  levels(): Float32Array {
    this.report[0] = this.peak
    this.peak = 0
    return this.report
  }

  process(slots: Float32Array) {
    const sr = this.ctx.sampleRate

    this.env.attack = this.params[P_ATTACK]
    this.env.release = this.params[P_RELEASE]
    const open = this.gateOpen || slots[this.ins[IN_GATE]] > 0.5
    if (open !== this.envOpen) {
      this.envOpen = open
      if (open) this.env.gateOn()
      else this.env.gateOff()
    }
    const e = this.env.next()
    slots[this.outs[OUT_ENV]] = e

    this.level.set(this.params[P_LEVEL])
    // Drone sounds whether or not anything is holding it open, as the
    // oscillator does with Env Amt at zero: a module that is silent until it
    // is patched is a poor thing to find in a menu.
    const gain = (this.params[P_MODE] >= 0.5 ? e : 1) * this.level.next()

    this.pitch.set(this.params[P_PITCH])
    this.tone.set(this.params[P_TONE])
    let breathTarget = this.params[P_BREATH] + slots[this.ins[IN_BREATH]]
    breathTarget = breathTarget < 0 ? 0 : breathTarget > 1 ? 1 : breathTarget
    this.breath.set(breathTarget)

    if (gain === 0) {
      // Jumped for the same reason the oscillator jumps them: a knob moved
      // between notes has to be where it was put when the next one starts.
      this.pitch.reset(this.params[P_PITCH])
      this.tone.reset(this.params[P_TONE])
      this.breath.reset(breathTarget)
      slots[this.outs[OUT_AUDIO]] = 0
      return
    }

    const tone = this.tone.next()
    const breath = this.breath.next()

    this.vibPhase += this.params[P_VIB_RATE] / sr
    if (this.vibPhase >= 1) this.vibPhase -= 1
    const vib = (Math.sin(2 * Math.PI * this.vibPhase) * this.params[P_VIB_DEPTH] * VIB_SEMITONES) / 12

    let freq = this.pitch.next() * Math.pow(2, slots[this.ins[IN_PITCH]] + vib) * this.periodScale
    // The folds cannot be driven past a few samples a cycle and still have an
    // open and a closed phase to tell apart.
    const top = sr * 0.2
    if (!(freq >= MIN_FREQ)) freq = MIN_FREQ
    else if (freq > top) freq = top
    const dt = freq / sr

    const oq = OQ_SOFT + (OQ_PRESSED - OQ_SOFT) * tone

    this.phase += dt
    if (this.phase >= 1) {
      this.phase -= 1
      this.newCycle()
    }
    const p = this.phase

    // The flow derivative, 2t - 3t^2 across the open phase: zero on average,
    // so it carries no offset, rising to a third and then falling to -1 at the
    // instant of closure, where it steps straight back to zero.
    let pulse = 0
    if (p < oq) {
      const t = p / oq
      pulse = 2 * t - 3 * t * t
    }
    // PolyBLEP on the closure, the one step in the wave: an upward step of 1
    // gets half a residual either side of where it fell.
    const before = (p - oq) / dt
    if (before > -1 && before < 0) pulse += 0.5 * (before * before + 2 * before + 1)
    else if (before >= 0 && before < 1) pulse += 0.5 * (2 * before - before * before - 1)

    // A softer voice is a duller one as well as a smoother one.
    const corner = TILT_SOFT * Math.pow(TILT_PRESSED / TILT_SOFT, tone)
    const a = Math.exp((-2 * Math.PI * corner) / sr)
    this.tilt = pulse + (this.tilt - pulse) * a
    // No level correction for the tilt: the lowpass takes the spike's peak
    // but the spike carries little of the power, and across the whole of
    // Tone the loudness moves by about a quarter, which reads as the voice
    // pushing harder rather than as a volume knob.
    const voiced = this.tilt * this.cycleAmp

    const white = this.random() * 2 - 1
    const b = Math.exp((-2 * Math.PI * BREATH_CORNER) / sr)
    this.noiseLow = white + (this.noiseLow - white) * b
    const aspiration = (white - this.noiseLow) * (p < oq ? 1 : BREATH_CLOSED)

    const out = (voiced * (1 - breath) + aspiration * breath * BREATH_GAIN) * gain
    const size = out < 0 ? -out : out
    if (size > this.peak) this.peak = size
    slots[this.outs[OUT_AUDIO]] = out
  }

  /**
   * Draws the next cycle's length and loudness. Once a cycle rather than once
   * a sample: jitter is the period itself wandering, and wobbling the pitch
   * inside a cycle would be a vibrato too fast to hear as one.
   */
  private newCycle() {
    const jitter = this.params[P_JITTER]
    const growl = this.params[P_GROWL]
    this.odd = !this.odd

    let scale = 1 + (this.random() * 2 - 1) * jitter * MAX_JITTER
    let amp = 1 - this.random() * jitter * MAX_SHIMMER
    if (growl > 0) {
      // Long-loud, short-quiet, in turn: the pair repeats at half the pitch,
      // which is the subharmonic a growl is heard as. Longer and shorter by
      // the same amount, so a pair is exactly two periods and the growl sits
      // an octave under the note rather than somewhere near it.
      scale *= this.odd ? 1 + growl * GROWL_PERIOD : 1 - growl * GROWL_PERIOD
      if (!this.odd) amp *= 1 - growl * GROWL_AMP
    }
    // Stored as a frequency multiplier, so a longer cycle is a smaller one.
    this.periodScale = 1 / scale
    this.cycleAmp = amp
  }
}
