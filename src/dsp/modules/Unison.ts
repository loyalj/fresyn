import { PolyBlepOsc, WAVEFORMS } from '../PolyBlepOsc'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_PITCH = 0
const P_WAVE = 1
const P_VOICES = 2
const P_DETUNE = 3
const P_WIDTH = 4
const P_FM_AMOUNT = 5
const P_LEVEL = 6

const IN_PITCH = 0
const IN_FM = 1
const IN_SPREAD = 2

const OUT_L = 0
const OUT_R = 1
const OUT_MONO = 2

const MAX_VOICES = 7
/** Detune at full: the outermost copies a quarter-tone either side of the note. */
const MAX_SPREAD_SEMITONES = 0.5

/**
 * Unison oscillator: one note played by up to seven oscillators at once,
 * spread a little apart in pitch and across the stereo field -- the
 * supersaw, the hoover, the wall of a trance pad, in one module.
 *
 * The copies are spaced evenly either side of the note and the middle one
 * sits on it, so the stack is in tune however wide it is: what Detune widens
 * is the beating between them, not where they are centred. Width spreads them
 * from the middle out to the sides, the outermost furthest. Each starts at
 * its own point in its cycle, as free-running hardware oscillators do, or
 * they would add up to one loud click and a comb.
 *
 * L and R are the stereo stack; Out is the same summed to mono.
 */
export class UnisonModule extends DspModule {
  private oscs: PolyBlepOsc[] = []
  private pitch!: Smoothed
  private detune!: Smoothed
  private width!: Smoothed
  private level!: Smoothed
  /**
   * Each copy's pitch ratio and its two pan gains, worked out for the detune,
   * width and number of copies they were last worked out for. Those move
   * only when a knob or the Spread jack does; worked out every sample, a
   * power, a sine and a cosine a copy cost most of what the module did.
   */
  private ratios = new Float64Array(MAX_VOICES)
  private gainL = new Float64Array(MAX_VOICES)
  private gainR = new Float64Array(MAX_VOICES)
  private ratiosFor = NaN
  private gainsFor = NaN
  private countFor = 0
  /** The exponent last raised, and 2 to it, as the Oscillator keeps them. */
  private powFor = NaN
  private powIs = 1

  prepare() {
    const sr = this.ctx.sampleRate
    this.oscs = []
    for (let i = 0; i < MAX_VOICES; i++) {
      const osc = new PolyBlepOsc(sr)
      osc.setPhase(this.random())
      this.oscs.push(osc)
    }
    this.pitch = new Smoothed(this.params[P_PITCH], sr, 20)
    this.detune = new Smoothed(this.params[P_DETUNE], sr)
    this.width = new Smoothed(this.params[P_WIDTH], sr)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
  }

  processBlock(from: number, to: number) {
    const pitchIn = this.inputs[IN_PITCH]
    const fmIn = this.inputs[IN_FM]
    const spreadIn = this.inputs[IN_SPREAD]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const outMono = this.outputs[OUT_MONO]
    const wave = WAVEFORMS[Math.round(this.params[P_WAVE])] ?? 'saw'
    let n = Math.round(this.params[P_VOICES])
    if (!(n >= 1)) n = 1
    else if (n > MAX_VOICES) n = MAX_VOICES
    const fmAmount = this.params[P_FM_AMOUNT]
    this.pitch.set(this.params[P_PITCH])
    this.detune.set(this.params[P_DETUNE])
    this.width.set(this.params[P_WIDTH])
    this.level.set(this.params[P_LEVEL])
    // Uncorrelated copies add up by their power, so the stack is brought
    // back by the square root of how many there are.
    const norm = 1 / Math.sqrt(n)
    const oscs = this.oscs

    const ratios = this.ratios
    const gainL = this.gainL
    const gainR = this.gainR
    if (n !== this.countFor) {
      this.countFor = n
      this.ratiosFor = NaN
      this.gainsFor = NaN
    }

    for (let i = from; i < to; i++) {
      const exponent = pitchIn[i] + fmIn[i] * fmAmount
      if (exponent !== this.powFor) {
        this.powFor = exponent
        this.powIs = 2 ** exponent
      }
      const base = this.pitch.next() * this.powIs
      let detune = this.detune.next() + spreadIn[i]
      if (!(detune > 0)) detune = 0
      else if (detune > 1) detune = 1
      if (detune !== this.ratiosFor) {
        this.ratiosFor = detune
        for (let v = 0; v < n; v++) ratios[v] = 2 ** ((place(v, n) * detune * MAX_SPREAD_SEMITONES) / 12)
      }
      const width = this.width.next()
      if (width !== this.gainsFor) {
        this.gainsFor = width
        // Equal-power panning, from the middle out.
        for (let v = 0; v < n; v++) {
          const angle = ((place(v, n) * width + 1) * Math.PI) / 4
          gainL[v] = Math.cos(angle)
          gainR[v] = Math.sin(angle)
        }
      }
      const level = this.level.next() * norm
      let l = 0
      let r = 0
      for (let v = 0; v < n; v++) {
        const y = oscs[v].process(base * ratios[v], wave, 0.5)
        l += y * gainL[v]
        r += y * gainR[v]
      }
      l *= level
      r *= level
      outL[i] = l
      outR[i] = r
      outMono[i] = (l + r) * Math.SQRT1_2
    }
  }
}

/** Where copy `v` of `n` sits, from -1 to +1 across the stack; the middle one on the note. */
function place(v: number, n: number) {
  return n === 1 ? 0 : (2 * v) / (n - 1) - 1
}
