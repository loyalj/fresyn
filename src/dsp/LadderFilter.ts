/**
 * The response taken off the ladder, as a weight on each stage output.
 *
 * A ladder is four one-pole lowpasses in series, so the signal between them
 * is already lowpassed by one, two and three poles. Summing those taps with
 * the right signs gives a highpass or a bandpass out of the same four filters
 * -- this is what the Oberheim Xpander did with a ladder, and it costs a
 * handful of multiplies rather than a second filter.
 *
 * The weights run over `[u, y1, y2, y3, y4]`, where `u` is what the ladder
 * itself sees after the resonance feedback is subtracted and `yN` is the
 * output of the Nth pole.
 */
interface Response {
  /** Weights over `[u, y1, y2, y3, y4]`. */
  readonly w: readonly [number, number, number, number, number]
  /**
   * How much of the resonance make-up gain this tap wants, 0 to 1.
   *
   * Feedback drops a ladder's *lowpass passband*, and the make-up gain below
   * exists to put that back. The highpass and bandpass taps are differences
   * between stages, so they never had that droop -- and applying the make-up
   * to them anyway multiplies a tap whose weights already run to six by a
   * gain of three at full resonance, which is how the highpass came out at
   * four times full scale before this existed.
   */
  readonly makeup: number
}

const RESPONSES: readonly Response[] = [
  // 24 dB lowpass: the last stage on its own, which is the plain ladder. It
  // is first so that an unset Mode is the filter this module has always been,
  // make-up gain included.
  { w: [0, 0, 0, 0, 1], makeup: 1 },
  // 12 dB lowpass: half way down, for a slope that lets the top through. Two
  // poles of droop rather than four, so half the correction.
  { w: [0, 0, 1, 0, 0], makeup: 0.5 },
  // 12 dB bandpass: two poles of low minus three poles of low is the band
  // between them, doubled because the subtraction halves it.
  { w: [0, 0, 2, -2, 0], makeup: 0 },
  // 24 dB highpass: the binomial weights, which is everything the four
  // lowpasses did not pass.
  { w: [1, -4, 6, -4, 1], makeup: 0 },
]

/** How many responses the Mode parameter chooses between. */
export const LADDER_RESPONSES = RESPONSES.length

/**
 * Zero-delay-feedback (TPT) Moog ladder: four one-pole lowpasses with the
 * resonance path solved instantaneously rather than through a unit delay.
 * That solve is what keeps the cutoff tracking accurate at high resonance
 * instead of drooping, and lets it self-oscillate cleanly at k = 4.
 */
export class LadderFilter {
  private z = new Float64Array(4)
  private readonly invSampleRate: number
  private readonly nyquist: number

  constructor(sampleRate: number) {
    this.invSampleRate = 1 / sampleRate
    this.nyquist = sampleRate * 0.5
  }

  reset() {
    this.z.fill(0)
  }

  /**
   * @param cutoff  Hz
   * @param res     0..1, mapped to feedback k = 0..4 (self-oscillation at 1)
   * @param drive   input gain into the saturator, 1 = clean
   * @param mode    index into `RESPONSES`; 0 is the plain 24 dB lowpass
   */
  process(x: number, cutoff: number, res: number, drive: number, mode = 0): number {
    const fc = clamp(cutoff, 20, this.nyquist * 0.49)
    const g = Math.tan(Math.PI * fc * this.invSampleRate)
    const G = g / (1 + g)
    const k = clamp(res, 0, 1) * 4

    const z = this.z
    // Each stage contributes (1 - G) * z to its output; collect them weighted
    // by how many stages of gain they still pass through.
    const s1 = (1 - G) * z[0]
    const s2 = (1 - G) * z[1]
    const s3 = (1 - G) * z[2]
    const s4 = (1 - G) * z[3]

    const G2 = G * G
    const G3 = G2 * G
    const G4 = G3 * G
    const S = G3 * s1 + G2 * s2 + G * s3 + s4

    const response = RESPONSES[mode] ?? RESPONSES[0]

    // Resonance drops the passband on a real ladder, so put some of it back
    // here, BEFORE the solve. Applying it to the resolved input instead puts
    // gain inside the feedback loop that the solve did not account for, and
    // the states diverge to infinity within a second.
    //
    // How much goes back depends on the tap: see `Response.makeup`.
    const xin = Math.tanh(x * drive) * (1 + k * 0.5 * response.makeup)

    // Solve y4 = G^4 * (xin - k * y4) + S for y4, then back out the input the
    // ladder actually sees.
    const y4solved = (G4 * xin + S) / (1 + k * G4)
    // Saturating the feedback is what bounds self-oscillation amplitude on a
    // real ladder; the linear solve alone is only marginally stable at k = 4.
    const u = xin - k * Math.tanh(y4solved)

    // Now advance the four stages with the resolved input, keeping each pole's
    // output: the taps between the stages are what the other responses are
    // made of, and they are free here because the ladder computes them anyway.
    let v = (u - z[0]) * G
    const y1 = v + z[0]
    z[0] = y1 + v

    v = (y1 - z[1]) * G
    const y2 = v + z[1]
    z[1] = y2 + v

    v = (y2 - z[2]) * G
    const y3 = v + z[2]
    z[2] = y3 + v

    v = (y3 - z[3]) * G
    const y4 = v + z[3]
    z[3] = y4 + v

    // Backstop against numerical runaway; in normal operation nothing here
    // comes close to the limit.
    for (let i = 0; i < 4; i++) {
      const zi = z[i]
      if (!(zi > -8 && zi < 8)) z[i] = zi > 0 ? 8 : zi < 0 ? -8 : 0
    }

    const w = response.w
    // Spelled out rather than looped: this is the innermost line of the
    // busiest module in the rack, and three of the five weights are zero in
    // every response but the highpass.
    return w[0] * u + w[1] * y1 + w[2] * y2 + w[3] * y3 + w[4] * y4
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
