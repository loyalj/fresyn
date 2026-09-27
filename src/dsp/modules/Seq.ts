import { pulseSamples } from '../util'
import { DspModule, EdgeDetector, type Metering } from './types'

const STEPS = 8

/** Parameter bases, in the order `defs.ts` declares them. */
const P_STEP = 0
const P_LEVEL = STEPS
const P_RATE = STEPS * 2
const P_LENGTH = STEPS * 2 + 1
const P_GATE_LEN = STEPS * 2 + 2

const IN_CLOCK = 0
// Appended, because the DSP reads its ports by position and the existing
// index has to stay put.
const IN_RESET = 1

const OUT_CV = 0
const OUT_GATE = 1
const OUT_VEL = 2
const OUT_CLK = 3
const OUT_END = 4

/**
 * Eight steps of control voltage, with a level for each.
 *
 * The level is what makes it a sequencer rather than a row of knobs: a step
 * at zero is a rest, so the pattern has rhythm as well as pitch, and every
 * other setting is an accent that arrives on the Vel jack. One knob doing
 * both jobs is worth more panel than two would be.
 *
 * Its clock works the way the sample and hold's does: free-running, on its
 * own jack whether or not anything is patched to Clock, so a sequencer is
 * also the thing that keeps time for the rest of the rack. Patch a clock in
 * and that decides when it steps instead.
 *
 * Its button resets it, and so does the Reset jack: either starts the pattern
 * from step one, whether or not the other is being used. An offline render
 * resets it at time zero too, so a rendered take always begins where the
 * pattern begins.
 *
 * The jack is what lets a pattern be restarted by something other than a
 * finger -- a Trigger on a key, the End pulse of a Burst, another
 * sequencer's End so two patterns of different lengths stay in step.
 */
export class SeqModule extends DspModule implements Metering {
  readonly hasTrigger = true
  /** This module meters itself, to light the step its panel is playing. */
  readonly meter: Metering = this

  /** Steps visited since the last report; see `levels`. */
  private visited = new Float32Array(STEPS)
  private report = new Float32Array(STEPS)

  /** Float64 for the same reason the clock's is: a tick that does not drift. */
  private phase = 0
  private clock = new EdgeDetector()
  private transport = new EdgeDetector()
  private resetJack = new EdgeDetector()

  private index = 0
  /** Samples since the last step, so a gate can be a fraction of the gap. */
  private since = 0
  /** The gap the last step arrived after, which is the one to measure against. */
  private interval = 1
  private high = 0
  private ending = 0
  private endPulse = 1

  prepare() {
    this.endPulse = pulseSamples(this.ctx.sampleRate)
    this.interval = this.nominal()
    this.step(0)
  }

  /** The gap the Rate knob asks for, for a gate with nothing measured yet. */
  private nominal() {
    const rate = this.params[P_RATE]
    return rate > 0 ? this.ctx.sampleRate / rate : this.ctx.sampleRate
  }

  /**
   * Which steps have played since the last call, then cleared. Reported as a
   * set rather than as one index because the panel is redrawn about thirty
   * times a second and a fast pattern can pass several steps between two
   * frames; lighting only the last of them would drop the rest.
   */
  levels(): Float32Array {
    // Whatever step it is sitting on always reads as lit, so a sequencer that
    // is stopped still shows where it is rather than going dark.
    this.visited[this.index] = 1
    this.report.set(this.visited)
    this.visited.fill(0)
    return this.report
  }

  process(slots: Float32Array) {
    // Either source restarts the pattern, rather than the jack taking over
    // from the button once a cable goes in -- the same arrangement the Burst
    // makes, and for the same reason: a button should not stop working
    // because something was patched next to it.
    //
    // Rising only, on both. A render closes the gate part way through, and
    // that must not stop the sequence.
    const fromButton = this.transport.rose(this.gateOpen ? 1 : 0)
    const fromJack = this.resetJack.rose(slots[this.ins[IN_RESET]])
    if (fromButton || fromJack) this.restart()

    // Free-running whatever is patched, and published, so the rack has a
    // clock to share even when this module is being driven by another one.
    let rate = this.params[P_RATE]
    if (!(rate > 0)) rate = 0
    this.phase += rate / this.ctx.sampleRate
    let ticked = false
    while (this.phase >= 1) {
      this.phase -= 1
      ticked = true
    }

    // An unpatched input reads ground, which never rises, so the wiring is
    // what decides whether the internal clock drives the pattern.
    const jack = this.ins[IN_CLOCK]
    if (jack === 0 ? ticked : this.clock.rose(slots[jack])) {
      const length = this.length()
      const next = (this.index + 1) % length
      this.step(next)
      // Chaining: the pulse says the pattern came round, not that it moved.
      if (next === 0) this.ending = this.endPulse
    }

    this.since++
    if (this.high > 0) this.high--
    if (this.ending > 0) this.ending--

    const level = this.params[P_LEVEL + this.index]
    slots[this.outs[OUT_CV]] = this.params[P_STEP + this.index]
    slots[this.outs[OUT_VEL]] = level
    // A step at zero is a rest: it still moves the CV, so a held note can
    // change pitch under a rest, but it opens nothing.
    slots[this.outs[OUT_GATE]] = this.high > 0 && level > 0 ? 1 : 0
    slots[this.outs[OUT_CLK]] = this.phase < 0.5 ? 1 : 0
    slots[this.outs[OUT_END]] = this.ending > 0 ? 1 : 0
  }

  /**
   * Back to step one.
   *
   * Measured gaps mean nothing across a restart -- the time since the last
   * step is however long the rack sat idle -- so the first gate of a fresh
   * run is the one the Rate knob asks for.
   */
  private restart() {
    this.phase = 0
    this.interval = this.nominal()
    this.since = 0
    this.step(0)
  }

  /** How many steps the pattern is, as the knob currently reads. */
  private length() {
    const n = Math.round(this.params[P_LENGTH])
    if (!(n >= 1)) return 1
    return n > STEPS ? STEPS : n
  }

  /**
   * Land on a step and open its gate.
   *
   * The gate is a fraction of the gap this step arrived after, rather than of
   * one worked out from the Rate knob: an external clock is free to be
   * uneven, and a gate measured against a tempo the rack is not actually
   * running at would overlap the next step or fall well short of it.
   */
  private step(index: number) {
    this.index = index
    this.visited[index] = 1
    if (this.since > 0) this.interval = this.since
    this.since = 0
    this.high = Math.max(1, Math.round(this.interval * this.params[P_GATE_LEN]))
  }
}
