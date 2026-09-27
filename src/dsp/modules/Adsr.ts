import { Envelope } from '../Envelope'
import { DspModule, EdgeDetector } from './types'

const P_ATTACK = 0
const P_DECAY = 1
const P_SUSTAIN = 2
const P_RELEASE = 3

const IN_GATE = 0

const OUT_LEVEL = 0
const OUT_END = 1
const OUT_INV = 2

/** How long the End pulse stays up, matching the Burst's. */
const END_SECONDS = 0.002

/**
 * The standalone envelope: a gate in, a shape out, and two ways of saying
 * more about that shape.
 *
 * **End** fires when the shape finishes, the way the Burst and the Sequencer
 * report that they are done. It is what chains two of these into one longer
 * gesture -- a fast sweep that hands over to a slow one -- and what fires
 * something at the moment a hit stops rather than when it starts.
 *
 * **Inv** is the same shape upside down: full while the envelope is shut and
 * shut while it is full. Not the negative of it, which every destination in
 * the rack can already ask for by turning its own amount knob below zero;
 * this is the one that cannot be had that way, and it is the one ducking
 * wants -- patch it to a VCA and everything else gets out of the way each
 * time this envelope fires.
 */
export class AdsrModule extends DspModule {
  private env = new Envelope(this.ctx.sampleRate)
  private gate = new EdgeDetector()
  /** Whether the shape was running last sample, for spotting the end of it. */
  private wasActive = false
  /** Samples of End pulse left to put out. */
  private ending = 0
  private readonly endPulse = Math.max(1, Math.round(END_SECONDS * this.ctx.sampleRate))

  process(slots: Float32Array) {
    // Parameters first: gateOn() branches on the stage lengths, so setting
    // them afterwards would act on the previous sample's values. This module
    // has no delay stage today, so nothing depends on it yet -- but the
    // oscillator's envelope did, and it is the same class.
    this.env.attack = this.params[P_ATTACK]
    this.env.decay = this.params[P_DECAY]
    this.env.sustain = this.params[P_SUSTAIN]
    this.env.release = this.params[P_RELEASE]

    const g = slots[this.ins[IN_GATE]]
    const rose = this.gate.rose(g)
    if (rose) this.env.gateOn()
    else if (!this.gate.isHigh && this.env.isActive) this.env.gateOff()

    const level = this.env.next()

    // The edge, not the state: an envelope that has been idle for a second is
    // not ending, it has ended. Read after next(), so the sample the envelope
    // goes quiet on is the sample End goes high.
    const active = this.env.isActive
    if (this.wasActive && !active) this.ending = this.endPulse
    this.wasActive = active
    if (this.ending > 0) this.ending--

    slots[this.outs[OUT_LEVEL]] = level
    slots[this.outs[OUT_END]] = this.ending > 0 ? 1 : 0
    slots[this.outs[OUT_INV]] = 1 - level
  }
}
