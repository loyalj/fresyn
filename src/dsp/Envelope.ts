type Stage = 'idle' | 'delay' | 'attack' | 'hold' | 'decay' | 'sustain' | 'release'

/**
 * DAHDSR envelope with exponential curves.
 *
 * Delay and hold default to zero, in which case this behaves exactly as a
 * plain ADSR: gateOn goes straight to attack, and attack goes straight to
 * decay. Game one-shots live and die on the decay stage, so the curve shape
 * matters more here than the stage count does -- but delay is what lets a
 * layered impact arrive in pieces, and hold is what keeps a burst open.
 */
export class Envelope {
  private stage: Stage = 'idle'
  private level = 0
  /** Seconds spent in the current timed stage. */
  private elapsed = 0
  private readonly sampleRate: number
  private readonly secondsPerSample: number

  delay = 0
  attack = 0.005
  hold = 0
  decay = 0.25
  sustain = 0.0
  release = 0.2

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.secondsPerSample = 1 / sampleRate
  }

  gateOn() {
    this.stage = this.delay > 0 ? 'delay' : 'attack'
    this.elapsed = 0
  }

  gateOff() {
    if (this.stage !== 'idle') this.stage = 'release'
  }

  get isActive() {
    return this.stage !== 'idle'
  }

  reset() {
    this.stage = 'idle'
    this.level = 0
    this.elapsed = 0
  }

  next(): number {
    switch (this.stage) {
      case 'idle':
        return 0

      case 'delay':
        this.elapsed += this.secondsPerSample
        if (this.elapsed >= this.delay) {
          this.stage = 'attack'
          this.elapsed = 0
        }
        return 0

      case 'attack': {
        // Aim past 1.0 and stop early; that overshoot is what gives the
        // attack its curve instead of a straight ramp.
        const c = this.coeff(this.attack)
        this.level = 1.2 + (this.level - 1.2) * c
        if (this.level >= 1) {
          this.level = 1
          this.elapsed = 0
          this.stage = this.hold > 0 ? 'hold' : this.afterPeak()
        }
        break
      }

      case 'hold':
        this.level = 1
        this.elapsed += this.secondsPerSample
        if (this.elapsed >= this.hold) this.stage = this.afterPeak()
        break

      case 'decay': {
        const c = this.coeff(this.decay)
        this.level = this.sustain + (this.level - this.sustain) * c
        if (this.level <= this.sustain + 1e-5) {
          this.level = this.sustain
          this.stage = this.sustain <= 1e-5 ? 'idle' : 'sustain'
        }
        break
      }

      case 'sustain':
        this.level = this.sustain
        break

      case 'release': {
        const c = this.coeff(this.release)
        this.level *= c
        if (this.level <= 1e-5) {
          this.level = 0
          this.stage = 'idle'
        }
        break
      }
    }
    return this.level
  }

  /** A full sustain has nothing to decay to. */
  private afterPeak(): Stage {
    return this.sustain >= 0.999 ? 'sustain' : 'decay'
  }

  /** Per-sample multiplier that decays to ~1/e over `seconds`. */
  private coeff(seconds: number) {
    const n = Math.max(1, seconds * this.sampleRate)
    return Math.exp(-1 / n)
  }
}
