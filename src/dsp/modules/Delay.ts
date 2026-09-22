import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_TIME = 0
const P_CV_AMOUNT = 1
const P_FEEDBACK = 2
const P_DAMPING = 3
const P_MIX = 4

const IN_SIGNAL = 0
const IN_CV = 1

const OUT_MIXED = 0
const OUT_WET = 1

/** Matches the Time knob's range; the line is built to hold the longest. */
const MIN_TIME = 0.002
const MAX_TIME = 2

/**
 * Time is smoothed fast enough to be played. A delay whose distance glides
 * is a tape machine changing speed, and the pitch bend that comes with it is
 * the point of the CV jack -- so this is shorter than the eight milliseconds
 * a knob normally gets, which would flatten anything above a slow wobble.
 */
const TIME_GLIDE_MS = 3

/**
 * A delay line with the repeats fed back into it.
 *
 * The rack has been entirely dry until now, which is the single biggest thing
 * missing from it: a sound with no space around it reads as a sample rather
 * than as something that happened somewhere.
 *
 * Time CV is what makes this more than an echo. The read distance glides
 * rather than jumping, so moving it moves the pitch of everything already in
 * the line -- an envelope into Time is a laser, an LFO is a chorus or a
 * flanger, and a slow sweep is a tape machine being leaned on.
 *
 * The feedback path saturates and loses high end each time round, so a long
 * feedback settles into something duller and never into something louder.
 */
export class DelayModule extends DspModule {
  private line = new DelayLine(MAX_TIME * this.ctx.sampleRate)
  private damper = new OnePole()
  private time!: Smoothed

  prepare() {
    this.time = new Smoothed(
      this.params[P_TIME] * this.ctx.sampleRate,
      this.ctx.sampleRate,
      TIME_GLIDE_MS,
    )
  }

  process(slots: Float32Array) {
    const dry = slots[this.ins[IN_SIGNAL]]

    // In octaves, as every CV amount in the rack is, so a unit of CV halves
    // or doubles the distance rather than moving it by some number of
    // milliseconds that means nothing at the other end of the knob.
    const cv = slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT]
    let seconds = this.params[P_TIME] * Math.pow(2, cv)
    if (!(seconds >= MIN_TIME)) seconds = MIN_TIME
    else if (seconds > MAX_TIME) seconds = MAX_TIME

    this.time.set(seconds * this.ctx.sampleRate)
    const read = this.line.read(this.time.next())

    // Damped on the way out rather than only inside the loop, so the knob
    // still does something with the feedback all the way down.
    const wet = this.damper.process(read, this.params[P_DAMPING])

    // Saturating what goes in bounds the loop whatever the feedback is set
    // to: nothing in the line can exceed full scale, so a runaway is not
    // something the knob can ask for.
    this.line.push(Math.tanh(dry + wet * this.params[P_FEEDBACK]))

    const mix = this.params[P_MIX]
    slots[this.outs[OUT_MIXED]] = dry * (1 - mix) + wet * mix
    // The repeats on their own, for sending them somewhere the dry signal
    // does not go.
    slots[this.outs[OUT_WET]] = wet
  }
}
