/**
 * Loudness as ITU-R BS.1770 measures it, which is what LUFS means.
 *
 * A peak says how close a sound comes to clipping; loudness says how loud it
 * sounds, and the two part company quickly -- a click and a drone can share a
 * peak and be worlds apart to the ear. Game platforms and broadcasters set
 * their targets in LUFS for that reason, and a sound set whose takes all sit
 * at one loudness is one that can be mixed without riding every fader.
 *
 * The measurement is short: weight the signal the way the ear weights it (the
 * two filters below, "K-weighting"), take its mean square over 400 ms blocks,
 * and throw away the blocks that are silence or far below the rest before
 * averaging. Everything here is allocation-free once built, so the mixer can
 * run it on the audio thread.
 */

/**
 * One second-order section, direct form I.
 *
 * There is another biquad in the rack -- `Section`, in `Biquad.ts`, which the
 * EQ and the console use -- and this one is kept apart from it on purpose.
 * The two compute the same filter but not the same numbers: direct form I
 * sums five products at once from the last two inputs and outputs, where the
 * transposed form carries two running partial sums, and floating point rounds
 * the two differently. Moving the K-weighting across would shift every
 * loudness reading by a rounding error, and a reading is not only shown: it
 * sets the gain a bounce is normalised by, so every exported file would stop
 * being bit-for-bit what it was. `Section` also clears itself on a NaN,
 * which a measurement has no use for -- a NaN going in should come out as a
 * NaN reading, not as a quietly plausible one. Twenty lines is a fair price
 * for a meter that reads what it always read.
 */
class Biquad {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/**
 * The BS.1770 weighting for one channel, at any sample rate. The standard
 * prints coefficients for 48 kHz only; these are the analogue prototypes they
 * come from, as libebur128 derives them, so 44.1 kHz measures the same.
 */
export class KWeighting {
  private readonly shelf: Biquad
  private readonly highpass: Biquad

  constructor(sampleRate: number) {
    // A high shelf of about +4 dB above 1.5 kHz: the head's own boost.
    {
      const f0 = 1681.974450955533
      const gain = 3.999843853973347
      const q = 0.7071752369554196
      const k = Math.tan((Math.PI * f0) / sampleRate)
      const vh = Math.pow(10, gain / 20)
      const vb = Math.pow(vh, 0.4996667741545416)
      const a0 = 1 + k / q + k * k
      this.shelf = new Biquad(
        (vh + (vb * k) / q + k * k) / a0,
        (2 * (k * k - vh)) / a0,
        (vh - (vb * k) / q + k * k) / a0,
        (2 * (k * k - 1)) / a0,
        (1 - k / q + k * k) / a0,
      )
    }
    // And a gentle highpass around 38 Hz: what the ear hardly hears at all.
    {
      const f0 = 38.13547087602444
      const q = 0.5003270373238773
      const k = Math.tan((Math.PI * f0) / sampleRate)
      const a0 = 1 + k / q + k * k
      this.highpass = new Biquad(1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0)
    }
  }

  process(x: number): number {
    return this.highpass.process(this.shelf.process(x))
  }
}

/** Mean square, summed over the channels, as LUFS. Silence is -Infinity. */
export function lufsOf(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity
}

/** Nothing below this counts towards a sound's loudness: it is silence. */
const ABSOLUTE_GATE = -70
/** Nor does anything this far below the rest of it: it is the tail. */
const RELATIVE_GATE = -10

/**
 * The integrated loudness of a stereo sound, in LUFS: 400 ms blocks every
 * 100 ms, gated absolutely and then relatively, as BS.1770-4 specifies.
 *
 * A sound shorter than one block -- a click, a footstep -- is measured as a
 * single block of its own length rather than being padded with silence,
 * which would make every short sound read as quieter than it is.
 */
export function integratedLoudness(left: Float32Array, right: Float32Array, sampleRate: number): number {
  const n = Math.min(left.length, right.length)
  if (n === 0) return -Infinity
  const kl = new KWeighting(sampleRate)
  const kr = new KWeighting(sampleRate)
  const sq = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const l = kl.process(left[i])
    const r = kr.process(right[i])
    sq[i] = l * l + r * r
  }

  const block = Math.round(0.4 * sampleRate)
  const hop = Math.round(0.1 * sampleRate)
  const blocks: number[] = []
  if (n < block) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += sq[i]
    blocks.push(sum / n)
  } else {
    // A running sum, so each block costs a subtraction and an addition.
    let sum = 0
    for (let i = 0; i < block; i++) sum += sq[i]
    for (let start = 0; ; start += hop) {
      blocks.push(sum / block)
      if (start + hop + block > n) break
      for (let i = start; i < start + hop; i++) sum -= sq[i]
      for (let i = start + block; i < start + block + hop; i++) sum += sq[i]
    }
  }

  const loud = blocks.filter((ms) => lufsOf(ms) > ABSOLUTE_GATE)
  if (loud.length === 0) return -Infinity
  const ungated = loud.reduce((a, b) => a + b, 0) / loud.length
  const threshold = lufsOf(ungated) + RELATIVE_GATE
  const kept = loud.filter((ms) => lufsOf(ms) > threshold)
  return lufsOf(kept.reduce((a, b) => a + b, 0) / kept.length)
}

/** The largest sample either side reaches. */
export function peakOf(left: Float32Array, right: Float32Array): number {
  let peak = 0
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i])
    if (a > peak) peak = a
  }
  for (let i = 0; i < right.length; i++) {
    const a = Math.abs(right[i])
    if (a > peak) peak = a
  }
  return peak
}

/**
 * Loudness as it happens, for a meter: the last 400 ms (momentary) and the
 * last 3 s (short-term), in LUFS. Kept as 100 ms slices, so both come from
 * the same few sums rather than from three seconds of samples.
 */
export class LiveLoudness {
  private readonly kl: KWeighting
  private readonly kr: KWeighting
  private readonly sliceLength: number
  /** Mean square of each of the last thirty slices, oldest overwritten first. */
  private readonly slices = new Float64Array(30)
  private at = 0
  private filled = 0
  private acc = 0
  private count = 0

  constructor(sampleRate: number) {
    this.kl = new KWeighting(sampleRate)
    this.kr = new KWeighting(sampleRate)
    this.sliceLength = Math.round(sampleRate / 10)
  }

  push(left: number, right: number) {
    const l = this.kl.process(left)
    const r = this.kr.process(right)
    this.acc += l * l + r * r
    if (++this.count < this.sliceLength) return
    this.slices[this.at] = this.acc / this.count
    this.at = (this.at + 1) % this.slices.length
    if (this.filled < this.slices.length) this.filled++
    this.acc = 0
    this.count = 0
  }

  /** The newest `n` slices, averaged, as LUFS. */
  private recent(n: number): number {
    const take = Math.min(n, this.filled)
    if (take === 0) return -Infinity
    let sum = 0
    for (let k = 1; k <= take; k++) sum += this.slices[(this.at - k + this.slices.length) % this.slices.length]
    return lufsOf(sum / take)
  }

  get momentary() {
    return this.recent(4)
  }

  get shortTerm() {
    return this.recent(30)
  }
}
