import { SCALES } from '../../song/scale'
import { DspModule } from './types'

const P_ROOT = 0
const P_SCALE = 1

const IN_CV = 0

const OUT_CV = 0
const OUT_GATE = 1

/**
 * The scales, in the order the Scale switch lists them. Chromatic first --
 * every semitone -- which turns a smooth voltage into steps without choosing
 * a key, then the song's own scales, the same list the roll offers.
 */
export const QUANTIZER_SCALES: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ...SCALES.map((s) => s.steps),
]

/**
 * How much nearer another note has to be before the output leaves the one it
 * is on, in semitones. Without it a voltage sitting half way between two
 * notes -- an LFO at the top of its swing, noise through a slew -- chatters
 * between them on every sample.
 */
const HYSTERESIS = 0.1
/** How long the Gate output fires for when the note changes. */
const TRIGGER_S = 0.005

/**
 * Snaps a pitch voltage to the nearest note of a scale.
 *
 * The rack's pitch is one octave per unit, so this works in twelfths of a
 * unit, and anything it is fed -- a Sample & Hold's random steps, an LFO, an
 * envelope -- comes out as notes of the key. That is the difference between
 * a random bleep and a random melody.
 *
 * Gate fires briefly every time the note changes, so whatever is being
 * played can be struck on each new note: an envelope, a Resonator's pluck.
 */
export class QuantizerModule extends DspModule {
  private note = NaN
  private trigger = 0

  process(slots: Float32Array) {
    const steps = QUANTIZER_SCALES[Math.round(this.params[P_SCALE])] ?? QUANTIZER_SCALES[0]
    const root = Math.round(this.params[P_ROOT])
    const semis = slots[this.ins[IN_CV]] * 12

    const best = nearest(semis, root, steps)
    if (Number.isNaN(this.note) || Math.abs(semis - best) + HYSTERESIS < Math.abs(semis - this.note)) {
      if (best !== this.note) this.trigger = Math.round(TRIGGER_S * this.ctx.sampleRate)
      this.note = best
    }
    // A note the scale no longer has, after the Scale or Root knob moved,
    // gives way at once rather than waiting for the input to move.
    if (!inScale(this.note, root, steps)) {
      this.note = best
      this.trigger = Math.round(TRIGGER_S * this.ctx.sampleRate)
    }

    slots[this.outs[OUT_CV]] = this.note / 12
    slots[this.outs[OUT_GATE]] = this.trigger > 0 ? 1 : 0
    if (this.trigger > 0) this.trigger--
  }
}

const mod12 = (n: number) => ((n % 12) + 12) % 12

function inScale(note: number, root: number, steps: number[]) {
  return steps.includes(mod12(note - root))
}

/** The in-scale semitone nearest `semis`. */
function nearest(semis: number, root: number, steps: number[]) {
  const below = Math.floor(semis)
  for (let d = 0; d < 12; d++) {
    const lo = below - d
    const hi = below + 1 + d
    const loIn = inScale(lo, root, steps)
    const hiIn = inScale(hi, root, steps)
    // Searching outward a semitone at a time on each side, the first ring
    // with a note of the scale in it holds the nearest one: a note found on
    // one side at this distance beats anything on the other side further out.
    if (loIn && hiIn) return semis - lo <= hi - semis ? lo : hi
    if (loIn) return lo
    if (hiIn) return hi
  }
  return Math.round(semis)
}
