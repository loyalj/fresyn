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
    this.coeff = Math.exp(-1 / ((timeMs / 1000) * sampleRate))
  }

  set(target: number) {
    this.target = target
  }

  /** Jump without gliding, for things like a patch load. */
  reset(value: number) {
    this.value = value
    this.target = value
  }

  next(): number {
    this.value = this.target + (this.value - this.target) * this.coeff
    return this.value
  }
}
