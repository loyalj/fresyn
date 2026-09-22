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
  private dc = new DcBlocker(this.ctx.sampleRate)
  private length!: Smoothed

  prepare() {
    this.length = new Smoothed(
      this.ctx.sampleRate / clampPitch(this.params[P_PITCH]),
      this.ctx.sampleRate,
    )
  }

  process(slots: Float32Array) {
    const input = slots[this.ins[IN_SIGNAL]]

    const cv = slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT]
    const pitch = clampPitch(this.params[P_PITCH] * Math.pow(2, cv))

    this.length.set(this.ctx.sampleRate / pitch)
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
}

function clampPitch(pitch: number) {
  if (!(pitch >= MIN_PITCH)) return MIN_PITCH
  return pitch > MAX_PITCH ? MAX_PITCH : pitch
}
