import { expCv, pulseSamples } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_RATE = 0
const P_STEP = 1
const P_SMOOTH = 2
const P_PULL = 3
const P_RATE_AMOUNT = 4

const IN_CLOCK = 0
const IN_RATE = 1

const OUT_BI = 0
const OUT_UNI = 1
const OUT_TRIG = 2

/**
 * A drunk walk: a value that wanders.
 *
 * The rack could already step (Sample & Hold) and glide (Slew), but nothing
 * in it wandered. A walk is different from both: each step starts from where
 * the last one ended, so the value drifts about with a memory of where it has
 * been, instead of jumping anywhere the way a fresh random value does.
 * That memory is what makes it sound alive -- a creak, a sway, a flame, an
 * engine that never idles quite evenly.
 *
 * Step is how far a single stride can go, as a fraction of the whole range.
 * At 1.00 it can land anywhere and the walk becomes smooth random; small
 * steps are a slow drift. The walls at plus and minus one reflect rather than
 * clamp, so the walk does not stick to an edge once it finds one.
 *
 * Pull draws it back towards the middle on every step. At zero it roams the
 * whole range given time; turned up it hovers around the centre and only
 * occasionally wanders out, which is what most "not quite steady" wants.
 *
 * Smooth is how much of each step is spent gliding to the new value: zero
 * jumps like a sample and hold, one glides the whole way on a cosine so the
 * slope is zero at every arrival. With a Clock patched the step length is
 * measured from the clock itself, so the glide still fits between beats.
 */
export class DrunkModule extends DspModule {
  private clock = new EdgeDetector()
  private phase = 1
  /** Where the walk is: the value the current glide is heading to. */
  private to = 0
  private from = 0
  /** Samples since the last step, and how long the one before it took. */
  private since = 0
  private period = 1
  private trigLeft = 0
  private trigGap = false
  private trigLength = 1

  prepare() {
    const sr = this.ctx.sampleRate
    this.trigLength = pulseSamples(sr)
    this.period = sr / Math.max(1e-3, this.params[P_RATE])
  }

  process(slots: Float32Array) {
    const sr = this.ctx.sampleRate

    let step = false
    // A patched Clock takes over completely. An unpatched input reads the
    // ground slot, which is how a module can tell nothing is there.
    if (this.ins[IN_CLOCK] !== 0) {
      if (this.clock.rose(slots[this.ins[IN_CLOCK]])) {
        step = true
        this.period = Math.max(1, this.since)
      }
    } else {
      const rate = expCv(this.params[P_RATE], slots[this.ins[IN_RATE]], this.params[P_RATE_AMOUNT])
      this.phase += rate / sr
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase)
        step = true
        this.period = rate > 0 ? sr / rate : this.period
      }
    }

    // One draw a step, whatever Step and Pull are set to, so turning either
    // reshapes the walk a seed gives rather than swapping it for another.
    if (step) {
      const current = this.glide()
      let next = this.to * (1 - this.params[P_PULL]) + (this.random() * 2 - 1) * this.params[P_STEP]
      // Reflect off the walls, then clamp for the case where a stride is
      // longer than the room is wide.
      if (next > 1) next = 2 - next
      else if (next < -1) next = -2 - next
      if (next > 1) next = 1
      else if (next < -1) next = -1
      this.from = current
      this.to = next
      this.since = 0
      // A step landing while the last trigger is still high goes low for
      // this one sample first, or nothing downstream would see a new edge.
      this.trigGap = this.trigLeft > 0
      this.trigLeft = this.trigLength
    }

    const y = this.glide()
    slots[this.outs[OUT_BI]] = y
    slots[this.outs[OUT_UNI]] = 0.5 + 0.5 * y
    slots[this.outs[OUT_TRIG]] = this.trigGap ? 0 : this.trigLeft > 0 ? 1 : 0
    this.trigGap = false
    if (this.trigLeft > 0) this.trigLeft--
    this.since++
  }

  /** Where the glide from the last step has got to. */
  private glide() {
    const length = this.period * this.params[P_SMOOTH]
    if (length < 1 || this.since >= length) return this.to
    const u = this.since / length
    return this.from + (this.to - this.from) * (0.5 - 0.5 * Math.cos(Math.PI * u))
  }
}
