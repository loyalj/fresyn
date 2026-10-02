import { Smoothed } from '../Smoothed'
import { panLeft, panRight } from '../util'
import { DspModule, EdgeDetector, type Playable } from './types'

const PADS = 16
/** Level and pan by pad, then the choke groups: see the def's params. */
const P_CHOKE = PADS * 2

/** The Trig jacks come first, then each pad's return as a pair. */
const IN_RET = PADS

const OUT_L = 0
const OUT_R = 1
const OUT_PAD = 2

/** How long a choked pad takes to fall silent: quick, and not a click. */
const CHOKE_MS = 4
/** Centre on either law, so a pad in the middle comes through at its own level. */
const CENTRE = panLeft(0)

/** Nothing but exact zeros from `from` to `to`. */
function silent(x: Float32Array, from: number, to: number) {
  for (let i = from; i < to; i++) if (x[i] !== 0) return false
  return true
}

/**
 * The Drum Kit's own work: every pad's rack arrives at a return, and this
 * sets its level and pan, sums the lot, puts each pad out on its own, and
 * cuts off the pads that share a choke group with one just struck.
 *
 * It does not play the pads. A note from the roll goes straight to the
 * Trigger inside the pad it is for (see `patch/kit.ts`), and the kit is told
 * which pad that was, as a note whose pitch is the pad -- which is all it
 * needs for the choke. A gate into a Trig jack is heard here as well, for
 * the same reason.
 */
export class KitModule extends DspModule implements Playable {
  /** Told which pad was struck; see the class. Not something a hand plays. */
  readonly playable: Playable = this

  private gainL: Smoothed[] = []
  private gainR: Smoothed[] = []
  /** Each pad's choke: 1 while it may sound, falling to 0 once cut off. */
  private choke: Smoothed[] = []
  private edges: EdgeDetector[] = []
  private lastLevel = new Float32Array(PADS).fill(NaN)
  private lastPan = new Float32Array(PADS).fill(NaN)

  prepare() {
    for (let p = 0; p < PADS; p++) {
      this.gainL.push(new Smoothed(0, this.ctx.sampleRate))
      this.gainR.push(new Smoothed(0, this.ctx.sampleRate))
      this.choke.push(new Smoothed(1, this.ctx.sampleRate, CHOKE_MS))
      this.edges.push(new EdgeDetector())
    }
    this.updateGains(true)
  }

  /** The pitch is the pad, counted from nought. */
  noteOn(pad: number, _velocity: number) {
    this.strike(Math.round(pad))
  }

  /** A pad let go of rings on; only another pad in its group stops it. */
  noteOff() {}

  /**
   * A pad struck: it may sound again, and every other pad in its group is
   * cut off. A pad in no group cuts off nothing, and nothing cuts it off.
   */
  private strike(pad: number) {
    if (pad < 0 || pad >= PADS || this.choke.length === 0) return
    this.choke[pad].reset(1)
    const group = Math.round(this.params[P_CHOKE + pad])
    if (group <= 0) return
    for (let q = 0; q < PADS; q++) {
      if (q !== pad && Math.round(this.params[P_CHOKE + q]) === group) this.choke[q].set(0)
    }
  }

  /**
   * Level and a balance for each pad. A pad's rack comes out in stereo, so
   * Pan tips the pair to one side rather than placing a mono source, on the
   * same constant-power law as the mixer -- centred, each side is at the
   * pad's level.
   */
  private updateGains(force: boolean) {
    for (let p = 0; p < PADS; p++) {
      const level = this.params[p * 2]
      const pan = this.params[p * 2 + 1]
      if (!force && level === this.lastLevel[p] && pan === this.lastPan[p]) continue
      this.lastLevel[p] = level
      this.lastPan[p] = pan
      const l = (level * panLeft(pan)) / CENTRE
      const r = (level * panRight(pan)) / CENTRE
      this.gainL[p].set(l)
      this.gainR[p].set(r)
      if (force) {
        this.gainL[p].reset(l)
        this.gainR[p].reset(r)
      }
    }
  }

  processBlock(from: number, to: number) {
    this.updateGains(false)
    const ins = this.inputs
    const outs = this.outputs

    // The pads worth visiting a sample at a time: any with a cable into its
    // Trig, and any whose return has something in it this block or whose
    // gains are still gliding. The rest -- an empty pad, or one asleep with
    // its return at zero -- add nothing and put out nothing, and their
    // smoothers, settled, would hand back what they did last time.
    const live = this.live
    let count = 0
    for (let p = 0; p < PADS; p++) {
      const busy =
        this.ins[p] !== 0 ||
        !this.gainL[p].settled || !this.gainR[p].settled || !this.choke[p].settled ||
        !silent(ins[IN_RET + p * 2], from, to) || !silent(ins[IN_RET + p * 2 + 1], from, to)
      if (busy) live[count++] = p
      else outs[OUT_PAD + p].fill(0, from, to)
    }

    const outL = outs[OUT_L]
    const outR = outs[OUT_R]
    for (let i = from; i < to; i++) {
      let l = 0
      let r = 0
      for (let k = 0; k < count; k++) {
        const p = live[k]
        // A cable into Trig strikes the pad as a note does, for the choke.
        if (this.edges[p].rose(ins[p][i])) this.strike(p)
        const gl = this.gainL[p].next()
        const gr = this.gainR[p].next()
        const c = this.choke[p].next()
        const inL = ins[IN_RET + p * 2][i]
        const inR = ins[IN_RET + p * 2 + 1][i]
        l += inL * gl * c
        r += inR * gr * c
        // On its own: after its level and its choke, before its pan.
        outs[OUT_PAD + p][i] = (inL + inR) * 0.5 * this.params[p * 2] * c
      }
      // Rounded off rather than clipped, as the mixer does its bus: sixteen
      // pads struck together can pass full scale, and a kit is often the last
      // thing before the speakers.
      outL[i] = Math.tanh(l)
      outR[i] = Math.tanh(r)
    }
  }

  /** The pads being visited this block, in order. */
  private live = new Int32Array(PADS)
}
