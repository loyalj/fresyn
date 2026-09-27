/**
 * The RBJ cookbook's second-order sections, shared by the EQ module and the
 * song console's channel strips.
 */

/** One second-order section, transposed direct form II. */
export class Section {
  b0 = 1
  b1 = 0
  b2 = 0
  a1 = 0
  a2 = 0
  private z1 = 0
  private z2 = 0

  process(x: number) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
  }
}

/** A shelf with a slope of one: as steep as a shelf can be without a bump. */
export function shelf(s: Section, sr: number, f: number, db: number, high: boolean) {
  const a = Math.pow(10, db / 40)
  const w = (2 * Math.PI * f) / sr
  const cos = Math.cos(w)
  const alpha = (Math.sin(w) / 2) * Math.SQRT2
  const root = 2 * Math.sqrt(a) * alpha
  if (high) {
    s.set(
      a * (a + 1 + (a - 1) * cos + root),
      -2 * a * (a - 1 + (a + 1) * cos),
      a * (a + 1 + (a - 1) * cos - root),
      a + 1 - (a - 1) * cos + root,
      2 * (a - 1 - (a + 1) * cos),
      a + 1 - (a - 1) * cos - root,
    )
  } else {
    s.set(
      a * (a + 1 - (a - 1) * cos + root),
      2 * a * (a - 1 - (a + 1) * cos),
      a * (a + 1 - (a - 1) * cos - root),
      a + 1 + (a - 1) * cos + root,
      -2 * (a - 1 + (a + 1) * cos),
      a + 1 + (a - 1) * cos - root,
    )
  }
}

export function bell(s: Section, sr: number, f: number, db: number, q: number) {
  const a = Math.pow(10, db / 40)
  const w = (2 * Math.PI * f) / sr
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  s.set(1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a)
}
