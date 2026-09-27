import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

/** How many outputs one Macro drives. */
export const MACRO_LANES = 4

const P_AMOUNT = 0
/** Each lane's five parameters, in this order, after Amount. */
const LANE_FROM = 0
const LANE_TO = 1
const LANE_CURVE = 2
const LANE_START = 3
const LANE_END = 4
const LANE_PARAMS = 5

const IN_AMOUNT = 0

/**
 * Where one lane is when the macro is at `amount`.
 *
 * The lane sits at From until the macro reaches Start, travels to To along
 * its Curve between Start and End, and stays at To from there on. A window
 * narrower than the whole knob is what staging is: a distortion lane with
 * Start at 0.50 does nothing for the first half of the turn and all of its
 * work in the second.
 *
 * Curve bends the travel, not the window. Positive is exponential -- slow to
 * leave From and quick to arrive -- which is what makes a cutoff sweep feel
 * even; negative is the mirror image, quick off the mark and easing in, which
 * suits a level. Zero is a straight line.
 *
 * Exported so the panel draws exactly the function the audio runs.
 */
export function macroLane(
  amount: number,
  from: number,
  to: number,
  curve: number,
  start: number,
  end: number,
): number {
  let t: number
  if (end - start > 1e-6) {
    t = (amount - start) / (end - start)
    if (!(t > 0)) t = 0
    else if (t > 1) t = 1
  } else {
    // A window closed to nothing is a switch: From below it, To from it on.
    t = amount >= start ? 1 : 0
  }
  if (curve > 0) t = Math.pow(t, 1 + 4 * curve)
  else if (curve < 0) t = 1 - Math.pow(1 - t, 1 - 4 * curve)
  return from + (to - from) * t
}

/**
 * One knob, four control voltages.
 *
 * Modelled on the macro controllers a hardware rack uses, where one big
 * knob is cabled to several destinations at once, each with its own range:
 * turning up "intensity" opens a filter, adds drive, speeds up an LFO and
 * brings in a second layer, together, in the proportions the patch was built
 * with. Each lane is its own From, To and Curve, so one lane can close while
 * another opens, and each has a window -- set by dragging its handles on the
 * panel -- so lanes can take turns across the knob's travel instead of all
 * moving at once.
 *
 * Amount can be played from the Amount jack as well as turned, the jack
 * adding to the knob. That is how an LFO, an envelope or a drunk walk plays
 * all four lanes at once, and how a game does: it sets the knob.
 */
export class MacroModule extends DspModule {
  private amount!: Smoothed

  prepare() {
    this.amount = new Smoothed(this.params[P_AMOUNT], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    this.amount.set(this.params[P_AMOUNT])
    // Smoothed at the knob and not at the jack: a hand or a game setting the
    // knob jumps, and a jump in a cutoff is a click. A cable is already the
    // signal someone meant to send.
    let amount = this.amount.next() + slots[this.ins[IN_AMOUNT]]
    if (!(amount > 0)) amount = 0
    else if (amount > 1) amount = 1

    const p = this.params
    for (let lane = 0; lane < MACRO_LANES; lane++) {
      const base = 1 + lane * LANE_PARAMS
      slots[this.outs[lane]] = macroLane(
        amount,
        p[base + LANE_FROM],
        p[base + LANE_TO],
        p[base + LANE_CURVE],
        p[base + LANE_START],
        p[base + LANE_END],
      )
    }
  }
}
