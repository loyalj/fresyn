import { Envelope } from '../Envelope'
import { pulseSamples } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_ATTACK = 0
const P_DECAY = 1
const P_SUSTAIN = 2
const P_RELEASE = 3

const IN_GATE = 0

const OUT_LEVEL = 0
const OUT_END = 1
const OUT_INV = 2

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
  private readonly endPulse = pulseSamples(this.ctx.sampleRate)

  processBlock(from: number, to: number) {
    // Parameters first: gateOn() branches on the stage lengths, so setting
    // them afterwards would act on the previous sample's values. This module
    // has no delay stage today, so nothing depends on it yet -- but the
    // oscillator's envelope did, and it is the same class.
    const env = this.env
    env.attack = this.params[P_ATTACK]
    env.decay = this.params[P_DECAY]
    env.sustain = this.params[P_SUSTAIN]
    env.release = this.params[P_RELEASE]

    const gate = this.inputs[IN_GATE]
    const outLevel = this.outputs[OUT_LEVEL]
    const outEnd = this.outputs[OUT_END]
    const outInv = this.outputs[OUT_INV]
    for (let i = from; i < to; i++) {
      const rose = this.gate.rose(gate[i])
      if (rose) env.gateOn()
      else if (!this.gate.isHigh && env.isActive) env.gateOff()

      const level = env.next()

      // The edge, not the state: an envelope that has been idle for a second
      // is not ending, it has ended. Read after next(), so the sample the
      // envelope goes quiet on is the sample End goes high.
      const active = env.isActive
      if (this.wasActive && !active) this.ending = this.endPulse
      this.wasActive = active
      if (this.ending > 0) this.ending--

      outLevel[i] = level
      outEnd[i] = this.ending > 0 ? 1 : 0
      outInv[i] = 1 - level
    }
  }
}
