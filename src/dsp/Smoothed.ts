import { tauDecay } from './util'

/**
 * One-pole parameter smoother. Every knob goes through one of these; a raw
 * jump in a coefficient is what zipper noise sounds like.
 */
export class Smoothed {
  private value: number
  private target: number
  private coeff: number

  constructor(initial: number, sampleRate: number, timeMs = 8) {
    this.value = initial
    this.target = initial
    this.coeff = tauDecay((timeMs / 1000) * sampleRate)
  }

  set(target: number) {
    // A knob that somehow reads NaN is ignored rather than followed: a
    // smoother that has glided to NaN can never glide anywhere else.
    if (target - target === 0) this.target = target
  }

  /** Jump without gliding, for things like a patch load. */
  reset(value: number) {
    this.value = value
    this.target = value
  }

  /**
   * Where it has got to, one sample further on.
   *
   * A one-pole only ever halves the distance, so left to itself it never
   * arrives: a knob turned to zero spends several seconds creeping through
   * numbers too small to hear, and everything that redesigns a filter "while
   * the knob is moving" goes on redesigning it all that time. Once the gap is
   * a ten-millionth of the value it snaps the rest, which nobody can hear and
   * which lets the knob be still again.
   */
  next(): number {
    const diff = this.value - this.target
    // Written as a negated less-than so that a value somehow gone NaN lands
    // here too, and comes back to the target instead of staying lost.
    if (!(Math.abs(diff) >= 1e-7 * Math.max(1, Math.abs(this.target)))) {
      this.value = this.target
      return this.value
    }
    this.value = this.target + diff * this.coeff
    return this.value
  }

  /** Arrived, and not about to move again until it is set somewhere new. */
  get settled() {
    return this.value === this.target
  }

  /**
   * Where it is, without moving it. Once `settled`, every `next` hands back
   * exactly this, so a block can read it once instead of stepping it.
   */
  get current() {
    return this.value
  }
}
