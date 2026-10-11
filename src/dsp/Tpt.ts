/**
 * A state-variable filter in the topology-preserving form, for a module that
 * needs a resonant band inside its own loop rather than as a module of its
 * own: cheap to retune on every sample, and stable at any cutoff below
 * Nyquist, which a biquad recomputed per sample is not.
 *
 * `process` hands back the band; the low and high parts are left on the
 * object for whoever wants them.
 */
export class Tpt {
  private s1 = 0
  private s2 = 0
  low = 0
  high = 0
  private g = 0
  private k = 1
  private h = 1

  /** Tune it: `hz` the centre, `q` above 0.5 for a peak. */
  tune(hz: number, q: number, sampleRate: number) {
    const f = hz < 1 ? 1 : hz > sampleRate * 0.45 ? sampleRate * 0.45 : hz
    this.g = Math.tan((Math.PI * f) / sampleRate)
    this.k = 1 / (q > 0.05 ? q : 0.05)
    this.h = 1 / (1 + this.g * (this.g + this.k))
  }

  process(x: number): number {
    const g = this.g
    this.high = (x - (g + this.k) * this.s1 - this.s2) * this.h
    const band = g * this.high + this.s1
    this.s1 = g * this.high + band
    const low = g * band + this.s2
    this.s2 = g * band + low
    this.low = low
    // A NaN in the state would ring for ever; cleared, it is gone next sample.
    if (this.s1 - this.s1 !== 0 || this.s2 - this.s2 !== 0) {
      this.s1 = 0
      this.s2 = 0
      this.low = 0
      this.high = 0
      return 0
    }
    return band
  }

  reset() {
    this.s1 = 0
    this.s2 = 0
  }
}
