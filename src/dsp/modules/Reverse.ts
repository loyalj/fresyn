import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LENGTH = 0
const P_SWELL = 1
const P_FEEDBACK = 2
const P_MIX = 3

const IN = 0

const OUT_MIXED = 0
const OUT_WET = 1

/** The Length knob's range; the buffer is built for twice the longest. */
const MAX_LENGTH = 2

/**
 * Sound played backwards, a slice at a time: a rewind, a reversed cymbal, a
 * spell drawing breath before it is cast.
 *
 * Every Length it takes the slice just heard and plays it back to front, so
 * each slice's tail arrives first and its attack last -- the "suck in" of a
 * reversed note. Two playheads half a slice apart, each faded in and out,
 * keep the seams from clicking. Swell leans each slice's fade towards its
 * end, so the backwards sound rises out of nothing into the hit, and
 * Feedback sends the reversed sound round again: reversed echoes of reversed
 * echoes.
 *
 * The wet is a slice behind by its nature -- nothing can play a sound
 * backwards before it has finished -- so it trails the dry by up to two
 * Lengths.
 */
export class ReverseModule extends DspModule {
  readonly rests = true
  readonly memory = MAX_LENGTH * 2

  holdsFor() {
    const length = this.params[P_LENGTH]
    return Math.min(MAX_LENGTH * 2, length * 2 * (1 + 4 * this.params[P_FEEDBACK]))
  }

  private buf = new Float32Array(Math.ceil(MAX_LENGTH * 2 * this.ctx.sampleRate) + 4)
  private write = 0
  /** Where each playhead is through its slice, 0..1. */
  private headA = 0
  private headB = 0.5
  /** Each playhead's slice length, fixed for the slice so a knob turn cannot tear it. */
  private lenA = 0
  private lenB = 0
  private last = 0
  private swell!: Smoothed
  private feedback!: Smoothed
  private mix!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.swell = new Smoothed(this.params[P_SWELL], sr)
    this.feedback = new Smoothed(this.params[P_FEEDBACK], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
    this.lenA = this.lenB = this.lengthNow()
  }

  private lengthNow() {
    const l = this.params[P_LENGTH] * this.ctx.sampleRate
    return l < 64 ? 64 : l > MAX_LENGTH * this.ctx.sampleRate ? MAX_LENGTH * this.ctx.sampleRate : l
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[IN]
    const mixed = this.outputs[OUT_MIXED]
    const wetOut = this.outputs[OUT_WET]
    this.swell.set(this.params[P_SWELL])
    this.feedback.set(this.params[P_FEEDBACK])
    this.mix.set(this.params[P_MIX])
    const buf = this.buf
    const size = buf.length

    for (let i = from; i < to; i++) {
      const dry = input[i]
      // Fed back through a soft limit, so a long feedback thickens rather
      // than climbs.
      const fed = Math.tanh(dry + this.last * this.feedback.next())
      buf[this.write] = fed - fed === 0 ? fed : 0

      const swell = this.swell.next()
      const wet = this.head(this.headA, this.lenA, swell) + this.head(this.headB, this.lenB, swell)

      this.headA += 1 / this.lenA
      if (this.headA >= 1) {
        this.headA -= 1
        this.lenA = this.lengthNow()
      }
      this.headB += 1 / this.lenB
      if (this.headB >= 1) {
        this.headB -= 1
        this.lenB = this.lengthNow()
      }
      if (++this.write >= size) this.write = 0

      this.last = wet
      const mix = this.mix.next()
      wetOut[i] = wet
      mixed[i] = dry * (1 - mix) + wet * mix
    }
  }

  /**
   * One playhead's sample. At the start of its slice it reads what was just
   * written and walks back through it while the writing walks forward, so
   * the distance between them grows at twice the speed of time: that is
   * playing backwards.
   */
  private head(phase: number, length: number, swell: number) {
    const delay = 2 * phase * length + 1
    const whole = Math.floor(delay)
    const frac = delay - whole
    const size = this.buf.length
    let a = this.write - whole
    if (a < 0) a += size
    let b = a - 1
    if (b < 0) b += size
    const x = this.buf[a] + (this.buf[b] - this.buf[a]) * frac
    // A sine-squared window, so the two heads half a slice apart always sum
    // to one; leaned towards the end of the slice by Swell.
    const s = Math.sin(Math.PI * phase)
    const lean = swell > 0 ? Math.pow(phase, swell * 3) * (1 + swell * 3) : 1
    return x * s * s * lean
  }
}
