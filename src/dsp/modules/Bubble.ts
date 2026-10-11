import { Smoothed } from '../Smoothed'
import { expCv } from '../util'
import { DspModule } from './types'

const P_RATE = 0
const P_SIZE = 1
const P_SPREAD = 2
const P_RISE = 3
const P_LEVEL = 4
const P_CV_AMOUNT = 5

const IN_TRIG = 0
const IN_RATE = 1

const OUT = 0

/** As many bubbles as can sound at once; a new one past this takes the quietest. */
const POOL = 24

/** A bubble this quiet has popped. */
const GONE = 1e-4

/**
 * Bubbles in water, after Minnaert and van den Doel: each one a sine whose
 * pitch is set by its size, which dies away fast and glides upward as it
 * rises towards the surface.
 *
 * A bubble's radius sets its note -- 3.26 m/s over the radius, so a three
 * millimetre bubble rings near 1.1 kHz and a big one is a low glug. Its
 * damping comes from the same size, so small bubbles are short ticks and big
 * ones ring. The upward chirp is what makes it water rather than a sine
 * blip: a bubble's pitch climbs as it nears the surface, by Rise.
 *
 * Bubbles arrive at random, Rate a second on average, or one on each rising
 * edge at Trig -- so Dust's trigger makes rain on a pond, and a Clock makes
 * a steady drip.
 */
export class BubbleModule extends DspModule {
  private phase = new Float64Array(POOL)
  private freq = new Float64Array(POOL)
  private climb = new Float64Array(POOL)
  private amp = new Float64Array(POOL)
  private fade = new Float64Array(POOL)
  /**
   * How far to the next random bubble, counted in bubbles: drawn from an
   * exponential, and worn down by Rate each sample -- so turning Rate up
   * brings the next one sooner at once, rather than after a wait drawn at
   * the old rate.
   */
  private wait = 0
  private wasHigh = false
  private level!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
    this.wait = this.nextWait()
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const trig = this.inputs[IN_TRIG]
    const rateIn = this.inputs[IN_RATE]
    const out = this.outputs[OUT]
    this.level.set(this.params[P_LEVEL])
    const baseRate = this.params[P_RATE]
    const cvAmount = this.params[P_CV_AMOUNT]
    const ratePatched = this.ins[IN_RATE] !== 0
    const phase = this.phase
    const freq = this.freq
    const climb = this.climb
    const amp = this.amp
    const fade = this.fade
    const twoPi = 2 * Math.PI

    for (let i = from; i < to; i++) {
      const high = trig[i] > 0.5
      if (high && !this.wasHigh) this.spawn()
      this.wasHigh = high

      const rate = ratePatched ? expCv(baseRate, rateIn[i], cvAmount) : baseRate
      this.wait -= rate / sr
      if (this.wait <= 0) {
        this.spawn()
        this.wait = this.nextWait()
      }

      let sum = 0
      for (let b = 0; b < POOL; b++) {
        const a = amp[b]
        if (a < GONE) continue
        sum += Math.sin(twoPi * phase[b]) * a
        phase[b] += freq[b] / sr
        if (phase[b] >= 1) phase[b] -= 1
        freq[b] += climb[b]
        amp[b] = a * fade[b]
      }
      // Soft rather than clipped: a downpour piles bubbles on top of each
      // other, and that should thicken, not crack.
      out[i] = Math.tanh(sum) * this.level.next()
    }
  }

  /** The gap to the next bubble, in bubbles, at random: what makes the stream Poisson. */
  private nextWait() {
    return -Math.log(1 - this.random() * 0.999999)
  }

  private spawn() {
    const sr = this.ctx.sampleRate
    // The quietest slot: an empty one if there is one, else the bubble
    // nearest to popping, which nobody will miss.
    let slot = 0
    for (let b = 1; b < POOL; b++) if (this.amp[b] < this.amp[slot]) slot = b
    // Sizes spread on a log scale either side of Size: a few big, a few
    // small, most near the middle.
    const spread = this.params[P_SPREAD]
    const wobble = (this.random() + this.random() + this.random() - 1.5) * 2
    const radius = Math.max(0.1, this.params[P_SIZE] * Math.exp(wobble * spread * 1.2)) / 1000
    const f0 = Math.min(3.26 / radius, sr * 0.4)
    // van den Doel's damping, per second, from the note alone.
    const damping = 0.13 * f0 + 0.0072 * Math.pow(f0, 1.5)
    const rise = this.params[P_RISE]
    this.phase[slot] = 0
    this.freq[slot] = f0
    // The glide: f0 (1 + xi d t), so a bubble that rings longer climbs further.
    this.climb[slot] = (f0 * rise * 0.6 * damping) / sr
    this.fade[slot] = Math.exp(-damping / sr)
    // Big bubbles are louder; each a little different.
    this.amp[slot] = (0.35 + 0.35 * this.random()) * Math.min(1.5, Math.sqrt(radius * 1000 / 3))
  }
}
