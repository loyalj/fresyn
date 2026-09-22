export type Waveform = 'saw' | 'pulse' | 'tri' | 'sine'

/**
 * Band-limited oscillator. The BLEP correction is not optional: a naive
 * `phase * 2 - 1` saw aliases hard above a few hundred Hz and makes every
 * patch built on it sound cheap for reasons that are difficult to hear
 * directly.
 */
export class PolyBlepOsc {
  private phase = 0
  private readonly invSampleRate: number
  private readonly nyquist: number

  constructor(sampleRate: number) {
    this.invSampleRate = 1 / sampleRate
    this.nyquist = sampleRate * 0.5
  }

  reset() {
    this.phase = 0
  }

  /** Hard sync: restart the cycle at a fractional offset into the period. */
  syncTo(fraction: number) {
    this.phase = fraction
  }

  get cyclePhase() {
    return this.phase
  }

  process(freq: number, wave: Waveform, pulseWidth: number): number {
    // Clamped, because the wrap below subtracts one period at most. Above the
    // sample rate a phase step exceeds a whole cycle, one subtraction leaves
    // the phase past the end of it, and the remainder accumulates every
    // sample after that -- a saw walks off to 1e8 within a second. There is
    // no waveform left to represent up there anyway.
    const dt = clamp(freq, 0, this.nyquist) * this.invSampleRate
    let out: number

    switch (wave) {
      case 'sine':
        out = Math.sin(2 * Math.PI * this.phase)
        break

      case 'saw':
        out = 2 * this.phase - 1
        out -= polyBlep(this.phase, dt)
        break

      case 'pulse': {
        const pw = clamp(pulseWidth, 0.02, 0.98)
        // The falling edge sits at `pw`, so its residual is read at the phase
        // measured from there -- `phase - pw`, wrapped. Reading it at
        // `phase + pw` instead happens to agree when the pulse is square and
        // is wrong at every other width, which costs about 8 dB of alias
        // rejection and leaves the falling edge uncorrected.
        let sinceFall = this.phase - pw
        if (sinceFall < 0) sinceFall += 1

        out = this.phase < pw ? 1 : -1
        out += polyBlep(this.phase, dt)
        out -= polyBlep(sinceFall, dt)
        break
      }

      case 'tri': {
        const pw = clamp(pulseWidth, 0.02, 0.98)
        // Straight from the phase rather than by integrating the pulse: the
        // result is exactly +/-1 wide and exactly zero-mean at every width and
        // every rate. The integrator this replaced had to leak to stay bounded,
        // which erased the shape below about 20 Hz, and still accumulated the
        // pulse's own DC into an offset that grew with frequency -- 261 at
        // 2 kHz with the width at 0.9.
        out =
          this.phase < pw
            ? (2 * this.phase) / pw - 1
            : 1 - (2 * (this.phase - pw)) / (1 - pw)

        // A triangle has no step to correct, but its two corners are slope
        // discontinuities, and polyBLAMP rounds those the way polyBLEP rounds
        // a step. The slope changes by the same amount at each corner, in
        // opposite directions.
        const slope = 2 / (pw * (1 - pw))
        let sinceCorner = this.phase - pw
        if (sinceCorner < 0) sinceCorner += 1

        out += (slope / 2) * dt * polyBlamp(this.phase, dt)
        out -= (slope / 2) * dt * polyBlamp(sinceCorner, dt)
        break
      }
    }

    this.phase += dt
    if (this.phase >= 1) this.phase -= 1
    return out
  }
}

/** Step-discontinuity residual, scaled for a jump of 2. */
function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/**
 * Slope-discontinuity residual: the integral of `polyBlep`, so a corner of
 * slope change `s` is corrected by `(s / 2) * dt * polyBlamp(...)`.
 */
function polyBlamp(t: number, dt: number): number {
  if (dt <= 0) return 0
  if (t < dt) {
    const x = t / dt - 1
    return (-x * x * x) / 3
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt + 1
    return (x * x * x) / 3
  }
  return 0
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
