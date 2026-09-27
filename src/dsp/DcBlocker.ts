/**
 * One-pole high-pass at roughly 20 Hz. Real gear is AC-coupled; without this,
 * a narrow pulse wave carries enough DC to eat headroom and to click audibly
 * when the envelope opens.
 */
export class DcBlocker {
  private x1 = 0
  private y1 = 0
  private readonly r: number

  constructor(sampleRate: number, cornerHz = 20) {
    this.r = 1 - (2 * Math.PI * cornerHz) / sampleRate
  }

  reset() {
    this.x1 = 0
    this.y1 = 0
  }

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1
    // A single NaN or infinity arriving here would otherwise live in `y1`
    // for ever, and everything after the blocker with it. `y - y` is zero for
    // any finite number and NaN for anything else.
    if (y - y !== 0) {
      this.x1 = 0
      this.y1 = 0
      return 0
    }
    this.x1 = x
    this.y1 = y
    return y
  }
}
