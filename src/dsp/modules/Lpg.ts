import { tauStep } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_OFFSET = 0
const P_CV_AMOUNT = 1
const P_DECAY = 2
const P_MODE = 3
const P_RES = 4

const IN_SIGNAL = 0
const IN_CV = 1
const IN_STRIKE = 2

const MODE_LP = 1
const MODE_VCA = 2

/** How fast the light comes on: a vactrol opens in a few milliseconds. */
const ATTACK_S = 0.002
/** How long a strike holds the light on before letting it fade. */
const STRIKE_S = 0.003
/** Fully shut, the filter sits here; fully open, a thousand times higher. */
const FLOOR_HZ = 20
const RANGE = 1000

/**
 * Low-pass gate: a filter and a VCA opened together by one control, through
 * a vactrol -- a lamp shining on a light-dependent resistor, as in Buchla's
 * gates.
 *
 * Opening it makes the sound louder and brighter at once, the way a struck
 * or plucked thing is brightest when it is loudest. The vactrol is what
 * makes it sound alive: it opens in a couple of milliseconds but closes
 * slowly, and slower still the further shut it gets, so a strike rings out
 * in a soft, natural decay. Strike pings it open from a trigger alone --
 * the "bongo" -- with Decay setting how long the ring lasts.
 *
 * Mode chooses what it opens: both together, the filter only, or the level
 * only.
 */
export class LpgModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private strike = new EdgeDetector()
  private strikeLeft = 0
  /** How open the vactrol is, 0 to 1. */
  private light = 0
  private ic1 = 0
  private ic2 = 0

  processBlock(from: number, to: number) {
    const input = this.inputs[IN_SIGNAL]
    const cv = this.inputs[IN_CV]
    const strike = this.inputs[IN_STRIKE]
    const out = this.outputs[0]
    const sr = this.ctx.sampleRate
    const offset = this.params[P_OFFSET]
    const amount = this.params[P_CV_AMOUNT]
    const decay = this.params[P_DECAY]
    const mode = Math.round(this.params[P_MODE])
    // Damping: 2 is no resonance, and it is never let reach 0.
    const k = 2 - 2 * this.params[P_RES]
    const up = tauStep(ATTACK_S * sr)
    const strikeFor = Math.max(1, Math.round(STRIKE_S * sr))
    const filter = mode !== MODE_VCA
    const vca = mode !== MODE_LP
    let light = this.light
    let ic1 = this.ic1
    let ic2 = this.ic2

    for (let i = from; i < to; i++) {
      if (this.strike.rose(strike[i])) this.strikeLeft = strikeFor
      let target = offset + cv[i] * amount
      if (this.strikeLeft > 0) {
        this.strikeLeft--
        target = 1
      }
      if (!(target > 0)) target = 0
      else if (target > 1) target = 1

      if (target > light) light += (target - light) * up
      else {
        // Slower the darker it gets, as a vactrol's cell is.
        const tau = decay * (1 + 2 * (1 - light)) * sr
        light += (target - light) / tau
      }

      let x = input[i]
      if (x - x !== 0) x = 0
      let y = x
      if (filter) {
        // A two-pole low-pass in the trapezoidal form: stable at any cutoff,
        // so it can be swept per sample. The prewarp is left out -- this
        // cutoff is the lamp's, not a note's -- and only held below Nyquist.
        let fc = FLOOR_HZ * RANGE ** light
        if (fc > sr * 0.45) fc = sr * 0.45
        const g = (Math.PI * fc) / sr
        const a1 = 1 / (1 + g * (g + k))
        const a2 = g * a1
        const a3 = g * a2
        const v3 = x - ic2
        const v1 = a1 * ic1 + a2 * v3
        const v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        y = v2
      }
      if (vca) y *= light
      out[i] = y
    }
    this.light = light < 1e-9 ? 0 : light
    this.ic1 = Math.abs(ic1) < 1e-20 ? 0 : ic1
    this.ic2 = Math.abs(ic2) < 1e-20 ? 0 : ic2
  }
}
