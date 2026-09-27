import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule } from './types'

const P_VOWEL = 0
const P_SIZE = 1
const P_RES = 2
const P_VOWEL_AMOUNT = 3
const P_SIZE_AMOUNT = 4

const IN_SIGNAL = 0
const IN_VOWEL = 1
const IN_SIZE = 2

const BANDS = 5

/**
 * Five formants for each of five vowels, from an adult male voice: centre in
 * hertz, bandwidth in hertz, and level in dB. These are the tables Csound's
 * FOF examples have used for decades; they are averages, and averages are
 * what make a vowel read as that vowel rather than as a particular person.
 *
 * In the order the tongue travels through them -- oo, oh, ah, eh, ee, back and
 * rounded round to front and spread -- rather than alphabetically. A knob or
 * an LFO sweeping between neighbours then passes through vowels a mouth can
 * actually make on the way, which is the difference between "wow" and a
 * filter wobbling. Alphabetical order puts ee next to oh, and the half-way
 * point between those is not a sound anybody makes.
 */
const VOWELS: { f: number[]; bw: number[]; db: number[] }[] = [
  // u
  { f: [350, 600, 2700, 2900, 3300], bw: [40, 60, 100, 120, 120], db: [0, -20, -17, -14, -26] },
  // o
  { f: [400, 800, 2600, 2800, 3000], bw: [40, 80, 100, 120, 120], db: [0, -10, -12, -12, -26] },
  // a
  { f: [650, 1080, 2650, 2900, 3250], bw: [80, 90, 120, 130, 140], db: [0, -6, -7, -8, -22] },
  // e
  { f: [400, 1700, 2600, 3200, 3580], bw: [70, 80, 100, 120, 120], db: [0, -14, -12, -14, -20] },
  // i
  { f: [290, 1870, 2800, 3250, 3540], bw: [40, 90, 100, 120, 120], db: [0, -15, -18, -20, -30] },
]

const LAST = VOWELS.length - 1

/** Interpolated in logs, so a morph moves by musical intervals. */
const LOG_F = VOWELS.map((v) => v.f.map(Math.log))
const LOG_BW = VOWELS.map((v) => v.bw.map(Math.log))
const AMP = VOWELS.map((v) => v.db.map((d) => Math.pow(10, d / 20)))

/**
 * Brings a buzz back towards the level it went in at. Each band passes only
 * the harmonics near its centre, so five of them together keep a small part
 * of a bright source's energy. Measured on ah at speaking pitches: a Voice
 * comes out a little under what went in, and a saw -- far brighter -- about
 * the same, with its peaks reaching twice full scale where a harmonic lands
 * right on a formant.
 */
const MAKEUP = 4.5

/** Kept under Nyquist whatever Size and its jack ask for. */
const MAX_FRACTION = 0.45

/**
 * The resonances of a throat and mouth, as a bank of five bandpass filters: a
 * buzz in, a vowel out.
 *
 * Vowel morphs continuously through u, o, a, e and i. Size scales every
 * formant together the way a bigger or smaller head would, independently of
 * the pitch of whatever is going in -- which is the knob that turns one voice
 * into a child, a man, an ogre and a mountain. Res narrows or widens every
 * band at once: narrow is a choir singing through its nose, wide is a mouth
 * half open.
 *
 * The filters are Simper's trapezoidal state variable, because the centres
 * move every sample whenever a cable is on either jack and that filter stays
 * well behaved under modulation where a biquad with recomputed coefficients
 * does not. Coefficients are only worked out when something has moved.
 *
 * A formant filter is at its best on a source full of harmonics -- the Voice,
 * a saw, a pulse, noise for a whisper. A sine has one harmonic, and one
 * harmonic has no vowel in it.
 */
export class FormantModule extends DspModule {
  private vowel!: Smoothed
  private size!: Smoothed

  private readonly a1 = new Float64Array(BANDS)
  private readonly a2 = new Float64Array(BANDS)
  private readonly a3 = new Float64Array(BANDS)
  /** Bandpass gain, folded together with the band's level. */
  private readonly gain = new Float64Array(BANDS)
  private readonly ic1 = new Float64Array(BANDS)
  private readonly ic2 = new Float64Array(BANDS)

  private lastVowel = NaN
  private lastScale = NaN
  private lastRes = NaN

  prepare() {
    this.vowel = new Smoothed(this.params[P_VOWEL], this.ctx.sampleRate, 20)
    this.size = new Smoothed(this.params[P_SIZE], this.ctx.sampleRate, 20)
  }

  process(slots: Float32Array) {
    this.vowel.set(this.params[P_VOWEL])
    this.size.set(this.params[P_SIZE])

    let vowel = this.vowel.next() + slots[this.ins[IN_VOWEL]] * this.params[P_VOWEL_AMOUNT]
    if (!(vowel > 0)) vowel = 0
    else if (vowel > LAST) vowel = LAST
    // A bigger head is lower formants: Size 2 halves them. The jack is in
    // octaves of size, so a positive voltage makes the thing bigger too.
    const scale = 1 / expCv(this.size.next(), slots[this.ins[IN_SIZE]], this.params[P_SIZE_AMOUNT])
    const res = this.params[P_RES]

    if (vowel !== this.lastVowel || scale !== this.lastScale || res !== this.lastRes) {
      this.tune(vowel, scale, res)
    }

    const x = slots[this.ins[IN_SIGNAL]]
    let out = 0
    for (let i = 0; i < BANDS; i++) {
      const v3 = x - this.ic2[i]
      const v1 = this.a1[i] * this.ic1[i] + this.a2[i] * v3
      const v2 = this.ic2[i] + this.a2[i] * this.ic1[i] + this.a3[i] * v3
      this.ic1[i] = 2 * v1 - this.ic1[i]
      this.ic2[i] = 2 * v2 - this.ic2[i]
      out += v1 * this.gain[i]
    }
    // Every band's state feeds the output, so a NaN in any of them shows up
    // here -- and, left, would stay in that band for good. Clearing the lot
    // is simpler than finding which, and the next sample is clean.
    if (out - out !== 0) {
      this.ic1.fill(0)
      this.ic2.fill(0)
      out = 0
    }
    slots[this.outs[0]] = out
  }

  private tune(vowel: number, scale: number, res: number) {
    this.lastVowel = vowel
    this.lastScale = scale
    this.lastRes = res

    const sr = this.ctx.sampleRate
    const lo = Math.floor(vowel)
    const hi = lo < LAST ? lo + 1 : LAST
    const t = vowel - lo
    // Res 0.5 is the table as written; each end doubles or halves every band.
    const widen = Math.pow(2, 1 - 2 * res)
    const ceiling = sr * MAX_FRACTION

    for (let i = 0; i < BANDS; i++) {
      let f = Math.exp(LOG_F[lo][i] + (LOG_F[hi][i] - LOG_F[lo][i]) * t) * scale
      // Scaled with the centre, so a bigger head keeps the same Q: a formant
      // an octave lower is an octave narrower, as it would be.
      const bw = Math.exp(LOG_BW[lo][i] + (LOG_BW[hi][i] - LOG_BW[lo][i]) * t) * scale * widen
      const amp = AMP[lo][i] + (AMP[hi][i] - AMP[lo][i]) * t
      if (f > ceiling) f = ceiling

      const g = Math.tan((Math.PI * f) / sr)
      // k is 1/Q. Held under 2, where the two poles would stop being a
      // resonance and the band would stop being a band.
      let k = bw / f
      if (k > 1.9) k = 1.9
      const a1 = 1 / (1 + g * (g + k))
      this.a1[i] = a1
      this.a2[i] = g * a1
      this.a3[i] = g * g * a1
      // k times the bandpass state is unity gain at the centre.
      this.gain[i] = k * amp * MAKEUP
    }
  }
}
