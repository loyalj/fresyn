import { pulseSamples } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_COUNT = 0
const P_RATE = 1
const P_CURVE = 2
const P_JITTER = 3
const P_WIDTH = 4

const IN_TRIG = 0

const OUT_GATE = 0
const OUT_RAMP = 1
const OUT_END = 2

const MAX_COUNT = 16
/** How far Curve can stretch the last gap relative to the first, either way. */
const CURVE_RANGE = 6
/**
 * One trigger in, a run of triggers out.
 *
 * This is the module a rack of sound effects misses most. A footstep run, a
 * burst of gunfire, a ricochet, a rattle, a stutter and a bouncing object are
 * all the same shape -- several of one sound, spaced in a way that is not
 * even -- and building one out of an LFO means gating the LFO with an
 * envelope and counting the pulses by ear.
 *
 * Curve is what makes it sound like something physical rather than like a
 * machine. Positive spreads the gaps out as the run goes on, which is a rattle
 * coming to rest; negative packs them together, which is a bouncing object
 * speeding up as it settles. Jitter then takes the remaining regularity out,
 * and because it draws from this module's own seeded stream, a batch of eight
 * renders gives eight runs that belong together rather than eight identical
 * ones.
 *
 * The Ramp output is the other half of the idea: it steps from 0 on the first
 * pulse to 1 on the last, so one cable makes each successive hit lower, or
 * quieter, or duller than the one before it.
 */
export class BurstModule extends DspModule {
  readonly hasTrigger = true

  private jack = new EdgeDetector()
  private transport = new EdgeDetector()

  /** Pulses still to fire, including the one in progress. */
  private left = 0
  /** Which pulse of the run is in progress, for the ramp and the spacing. */
  private index = 0
  /** How many the run was started with; the spacing is relative to it. */
  private count = 1
  /** Samples until the next pulse is due. */
  private wait = 0
  /** Samples this pulse's gate has left to stay open. */
  private high = 0
  /** Samples until the run is over, including the End pulse at the end of it. */
  private ending = 0
  /** How long that pulse is, in samples. */
  private endPulse = 1
  private ramp = 0

  prepare() {
    this.endPulse = pulseSamples(this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    // Either source fires it, rather than the jack taking over from the
    // button when it is patched. Normalling the way the sample and hold
    // normals its clock would mean the button marked Trigger stopped working
    // the moment a cable went in, which is not what a button should do.
    const trig = this.ins[IN_TRIG]
    const fromJack = this.jack.rose(trig === 0 ? 0 : slots[trig])
    const fromTransport = this.transport.rose(this.gateOpen ? 1 : 0)
    if (fromJack || fromTransport) this.start()

    if (this.wait > 0) this.wait--
    if (this.high > 0) this.high--
    if (this.ending > 0) this.ending--

    if (this.left > 0 && this.wait <= 0) this.fire()

    slots[this.outs[OUT_GATE]] = this.high > 0 ? 1 : 0
    slots[this.outs[OUT_RAMP]] = this.ramp
    // High for the tail of that countdown, so the pulse lands when the run
    // has finished rather than the moment the last gate opened.
    slots[this.outs[OUT_END]] = this.ending > 0 && this.ending <= this.endPulse ? 1 : 0
  }

  private start() {
    let count = Math.round(this.params[P_COUNT])
    if (!(count >= 1)) count = 1
    else if (count > MAX_COUNT) count = MAX_COUNT

    this.count = count
    this.left = count
    this.index = 0
    this.wait = 0
    this.ramp = 0
  }

  /** Open the gate for this pulse and work out when the next one is due. */
  private fire() {
    const sr = this.ctx.sampleRate
    const rate = this.params[P_RATE]
    const base = rate > 0 ? sr / rate : sr

    // The run's progress, 0 on the first pulse and 1 on the last. A run of one
    // has no progress to make, and dividing by count - 1 would say NaN.
    const f = this.count > 1 ? this.index / (this.count - 1) : 0

    // Curve stretches the gaps geometrically across the run, so the change is
    // heard as a rate slowing or speeding rather than as a jump part way in.
    //
    // Centred on the middle of the run rather than starting there, so Rate
    // keeps meaning the same thing as Curve moves: the gaps are redistributed
    // around it, instead of the whole run growing longer every time the knob
    // goes up while the first gap never moves at all.
    const spread = Math.pow(CURVE_RANGE, this.params[P_CURVE])
    let interval = base * Math.pow(spread, this.count > 1 ? f - 0.5 : 0)

    // Symmetrical about the nominal gap, so jitter shakes the run rather than
    // slowing it down on average.
    const jitter = this.params[P_JITTER]
    if (jitter > 0) interval *= 1 + (this.random() * 2 - 1) * jitter * 0.5
    if (!(interval >= 1)) interval = 1

    this.ramp = f
    this.high = Math.max(1, Math.round(interval * this.params[P_WIDTH]))
    this.wait = Math.round(interval)
    this.index++
    this.left--

    // The run is over once this last gap has elapsed, not the moment the last
    // gate shuts: End means the whole shape is finished, which is what
    // something chained after it wants to hear.
    if (this.left === 0) this.ending = Math.round(interval) + this.endPulse
  }
}
