/**
 * A circular buffer read at a fractional distance back, which is the one
 * piece of machinery a delay, a reverb and a resonator all need.
 *
 * The read is linearly interpolated rather than rounded to the nearest
 * sample. Rounding is audible the moment the distance moves: the read jumps a
 * whole sample at a time, which is a click on every step, and it is exactly
 * the sweep across fractional distances that makes a modulated delay bend
 * pitch the way tape does.
 */
export class DelayLine {
  private readonly buf: Float32Array
  private write = 0

  /** @param maxSamples the longest distance this line will ever be read at */
  constructor(maxSamples: number) {
    // Two spare samples so the interpolator's second tap is always inside the
    // buffer, however the distance is clamped.
    this.buf = new Float32Array(Math.max(4, Math.ceil(maxSamples) + 2))
  }

  get length() {
    return this.buf.length
  }

  reset() {
    this.buf.fill(0)
    this.write = 0
  }

  /**
   * The value written `delay` samples ago. Clamped into the buffer rather
   * than wrapped: a distance longer than the line would otherwise read the
   * future, which is this sample's own output and a loop with no delay in it.
   */
  read(delay: number): number {
    let d = delay
    if (!(d >= 1)) d = 1
    else if (d > this.buf.length - 2) d = this.buf.length - 2

    const whole = Math.floor(d)
    const frac = d - whole

    let i = this.write - whole
    if (i < 0) i += this.buf.length
    let j = i - 1
    if (j < 0) j += this.buf.length

    return this.buf[i] + (this.buf[j] - this.buf[i]) * frac
  }

  push(x: number) {
    this.buf[this.write] = x
    this.write++
    if (this.write >= this.buf.length) this.write = 0
  }
}

/**
 * One-pole lowpass, for the damping in a feedback loop.
 *
 * Separate from the ladder because this is not a filter anybody hears as a
 * filter: it is the high end coming off a little more each time round, which
 * is what makes a repeat sound further away than the one before it.
 */
export class OnePole {
  private z = 0

  reset() {
    this.z = 0
  }

  /** @param damping 0 for none, 1 for as dark as the loop will go */
  process(x: number, damping: number): number {
    let d = damping
    if (!(d >= 0)) d = 0
    else if (d > 0.98) d = 0.98
    this.z = x * (1 - d) + this.z * d
    return this.z
  }
}
