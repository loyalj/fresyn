import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_PITCH = 0
const P_CV_AMOUNT = 1
const P_DECAY = 2
const P_DAMPING = 3

const IN_SIGNAL = 0
const IN_CV = 1

/** Matches the Pitch knob; the line is built to hold the lowest note. */
const MIN_PITCH = 20
const MAX_PITCH = 4000

/** Kept off 1 so the longest decay is still a decay. */
const MAX_FEEDBACK = 0.9995

/**
 * The DC blocker's corner, far below anything the loop is tuned to.
 *
 * It sits inside the loop, and a highpass leads: at a 20 Hz corner it pulled
 * the fundamental forty cents sharp at 130 Hz and nearly eighty at 65,
 * while the overtones above it stayed put -- a string whose partials no
 * longer lined up. At 1 Hz it still takes out DC, which is all it is for, and
 * what little lead is left is corrected for in `loopFor`.
 */
const DC_CORNER = 1

/**
 * A delay line tuned to a pitch, fed back into itself: whatever goes in comes
 * out ringing at that note.
 *
 * This is Karplus-Strong with the exciter left off the panel, which is the
 * version worth having in a rack -- the exciter is whatever you patch in, and
 * the rack is full of things to patch. A burst of noise gives a plucked
 * string; a click gives a struck pipe; a short envelope on the Burst
 * generator gives a ricochet, because a ricochet is a pitched ping repeated;
 * and a continuous tone gives the hollow, tuned colour of a resonant body,
 * which is a sci-fi door or a metal gantry.
 *
 * Decay is in seconds rather than as a feedback amount, worked out from the
 * length the pitch asks for, so a note at the top of the range rings for as
 * long as one at the bottom instead of dying the moment it is played.
 */
export class ResonatorModule extends DspModule {
  private line = new DelayLine(this.ctx.sampleRate / MIN_PITCH)
  private damper = new OnePole()
  /**
   * Inside the loop. A one-pole lowpass passes DC at full gain, so without
   * this the damping that makes the tail decay does nothing at all to any
   * offset riding under it, and a feedback of nearly one walks it off scale.
   */
  private dc = new DcBlocker(this.ctx.sampleRate, DC_CORNER)
  private length!: Smoothed
  /** The pitch and damping the correction was last worked out for. */
  private tunedPitch = 0
  private tunedDamping = -1
  private correction = 0

  prepare() {
    const pitch = clampPitch(this.params[P_PITCH])
    this.length = new Smoothed(this.loopFor(pitch, this.params[P_DAMPING]), this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    const input = slots[this.ins[IN_SIGNAL]]

    const cv = slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT]
    const pitch = clampPitch(this.params[P_PITCH] * Math.pow(2, cv))

    this.length.set(this.loopFor(pitch, this.params[P_DAMPING]))
    const samples = this.length.next()

    const read = this.line.read(samples)

    const decay = this.params[P_DECAY]
    let gain = decay > 0 ? Math.pow(10, (-3 * samples) / (decay * this.ctx.sampleRate)) : 0
    if (gain > MAX_FEEDBACK) gain = MAX_FEEDBACK

    const damped = this.dc.process(this.damper.process(read, this.params[P_DAMPING]))
    this.line.push(Math.tanh(input + damped * gain))

    // What the line is ringing with, rather than the input plus it: the rack
    // has a mixer for blending, and a resonator that always passed its own
    // input could not be used as a filter.
    slots[this.outs[0]] = read
  }

  /**
   * How long the line has to be for the whole loop to ring at `pitch`.
   *
   * The loop is not only the line: the damper lags, and the lag is a longer
   * loop and a flatter note -- nearly fifty cents at 1 kHz with Damp at 0.6,
   * which is a string that cannot be played in tune. The DC blocker leads,
   * by a little. Both are worked out at the pitch asked for and taken off the
   * line, so the fundamental lands where it was asked to. Worked out only
   * when the pitch or the damping moves, which on a played note is once.
   */
  private loopFor(pitch: number, damping: number): number {
    if (pitch !== this.tunedPitch || damping !== this.tunedDamping) {
      const w = (2 * Math.PI * pitch) / this.ctx.sampleRate
      const r = 1 - (2 * Math.PI * DC_CORNER) / this.ctx.sampleRate
      this.correction = onePoleDelay(w, damping) + dcBlockerDelay(w, r)
      this.tunedPitch = pitch
      this.tunedDamping = damping
    }
    return this.ctx.sampleRate / pitch - this.correction
  }
}

/**
 * Samples of phase delay a filter adds at `w` radians per sample, from the
 * angle of its response there: positive lags, negative leads.
 */
function onePoleDelay(w: number, damping: number) {
  const d = damping < 0 ? 0 : damping > 0.98 ? 0.98 : damping
  return Math.atan2(d * Math.sin(w), 1 - d * Math.cos(w)) / w
}

function dcBlockerDelay(w: number, r: number) {
  // (1 - z^-1) / (1 - r z^-1): the zero at DC leads by a quarter turn less
  // half a sample, and the pole takes most of that back.
  const lead = Math.PI / 2 - w / 2 - Math.atan2(r * Math.sin(w), 1 - r * Math.cos(w))
  return -lead / w
}

function clampPitch(pitch: number) {
  if (!(pitch >= MIN_PITCH)) return MIN_PITCH
  return pitch > MAX_PITCH ? MAX_PITCH : pitch
}
