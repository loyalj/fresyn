import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_RATE = 0
const P_CENTER = 1
const P_WIDTH = 2
const P_TONE = 3
const P_MOTION = 4
const P_LEVEL = 5

const IN_RATE = 0

const OUT_SIGNAL = 0
const OUT_POS = 1

/** Ten tones an octave apart, from 10 Hz: they span everything audible. */
const TONES = 10
const LOWEST_HZ = 10
/** Octaves a second per unit at the Rate jack. */
const RATE_PER_VOLT = 0.5
/** The highest a partial may sit, as a share of the sample rate. */
const TOP = 0.45
/** How often the loudness of each tone is worked out again, in samples. */
const WEIGH_EVERY = 16

const TABLE = 4096
const SINE = new Float64Array(TABLE + 1)
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE)

/**
 * The Shepard tone: a sound that climbs, or falls, for ever.
 *
 * Ten tones an octave apart all glide upward together. Each is loudest in
 * the middle of the range and fades out towards both ends, along a bell
 * centred on Center, so the top one has faded to nothing as it leaves and a
 * new one has faded in at the bottom. The ear follows the glide and never
 * hears the hand-over: the pitch rises and is somehow never higher.
 *
 * Rate is how fast, in octaves a second, and negative falls. Width is the
 * bell: narrow is a clear tone, wide a rich organ-like chord of octaves.
 * Motion steps it a semitone at a time instead of gliding -- the endless
 * staircase. Pos reads where in the octave it is, 0 to 1, so other things
 * can climb with it.
 */
export class ShepardModule extends DspModule {
  private phases = new Float64Array(TONES)
  private weights = new Float64Array(TONES)
  /** Where in the octave the glide has got to, 0 to 1. */
  private pos = 0
  private weighIn = 0
  private width!: Smoothed
  private center!: Smoothed
  private tone!: Smoothed
  private level!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.width = new Smoothed(this.params[P_WIDTH], sr)
    this.center = new Smoothed(this.params[P_CENTER], sr)
    this.tone = new Smoothed(this.params[P_TONE], sr)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
    for (let k = 0; k < TONES; k++) this.phases[k] = this.random()
  }

  processBlock(from: number, to: number) {
    const rateIn = this.inputs[IN_RATE]
    const out = this.outputs[OUT_SIGNAL]
    const posOut = this.outputs[OUT_POS]
    const sr = this.ctx.sampleRate
    const rate = this.params[P_RATE]
    const stepped = Math.round(this.params[P_MOTION]) === 1
    this.width.set(this.params[P_WIDTH])
    this.center.set(this.params[P_CENTER])
    this.tone.set(this.params[P_TONE])
    this.level.set(this.params[P_LEVEL])
    const top = sr * TOP
    const phases = this.phases
    const weights = this.weights

    for (let i = from; i < to; i++) {
      let r = rate + rateIn[i] * RATE_PER_VOLT
      if (r - r !== 0) r = 0
      this.pos += r / sr
      // Over the top of the octave, every tone has become the one above it:
      // the phases move along a place and a new tone comes in at the bottom.
      // It is silent there, which is what makes the hand-over unheard.
      if (this.pos >= 1) {
        this.pos -= Math.floor(this.pos)
        for (let k = TONES - 1; k > 0; k--) phases[k] = phases[k - 1]
        phases[0] = this.random()
        this.weighIn = 0
      } else if (this.pos < 0) {
        this.pos -= Math.floor(this.pos)
        for (let k = 0; k < TONES - 1; k++) phases[k] = phases[k + 1]
        phases[TONES - 1] = this.random()
        this.weighIn = 0
      }
      const at = stepped ? Math.floor(this.pos * 12) / 12 : this.pos
      const width = this.width.next()
      const center = this.center.next()
      const tone = this.tone.next()
      if (this.weighIn-- <= 0) {
        this.weighIn = WEIGH_EVERY - 1
        this.weigh(at, center, width)
      }

      let y = 0
      // Each tone an octave over the one below: one power, then doublings.
      let hz = LOWEST_HZ * 2 ** at
      for (let k = 0; k < TONES; k++, hz *= 2) {
        const w = weights[k]
        let ph = phases[k] + hz / sr
        ph -= Math.floor(ph)
        phases[k] = ph
        if (w < 1e-4 || hz >= top) continue
        let s = sine(ph)
        // Tone adds the second and third harmonics, for something reedier
        // than a sine; each tone carries its own, so they glide with it.
        if (tone > 0) {
          if (hz * 2 < top) s += tone * 0.5 * sine((ph * 2) % 1)
          if (hz * 3 < top) s += tone * 0.33 * sine((ph * 3) % 1)
        }
        y += w * s
      }
      out[i] = y * this.level.next()
      posOut[i] = at
    }
  }

  /**
   * Each tone's loudness: a bell on a scale of octaves, centred on Center,
   * Width octaves across where it has fallen to half. Brought back by the
   * root of the summed powers, so a wide bell is no louder than a narrow one.
   */
  private weigh(at: number, center: number, width: number) {
    const mid = Math.log2(center / LOWEST_HZ)
    const sigma = width / 2.355
    let power = 0
    for (let k = 0; k < TONES; k++) {
      const d = (k + at - mid) / sigma
      const w = Math.exp(-0.5 * d * d)
      this.weights[k] = w
      power += w * w
    }
    const norm = power > 0 ? 0.5 / Math.sqrt(power) : 0
    for (let k = 0; k < TONES; k++) this.weights[k] *= norm
  }
}

function sine(ph: number) {
  const x = ph * TABLE
  const i = x | 0
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i)
}
