import { DspModule, EdgeDetector } from './types'

const P_RATE = 0
const P_CV_AMOUNT = 1
const P_WIDTH = 2

const IN_RESET = 0
const IN_CV = 1

/** Output divisors, in the order the def declares the jacks. */
const DIVISORS = [1, 2, 3, 4, 8]

/**
 * Ticks counted before the count wraps. The lowest common multiple of the
 * divisors, so every output is at the same point in its own cycle when it
 * happens and the wrap is silent.
 */
const CYCLE = 24

/** A clock faster than this is an oscillator, and a worse one than the osc. */
const MAX_RATE = 4000

/**
 * The rack's timekeeper: one rate, and the same pulse train divided down
 * alongside it.
 *
 * Divisions rather than multiplications because dividing is what a patch
 * actually needs -- a sequencer on the beat, a burst every fourth beat and a
 * slow sweep underneath all want to stay related to each other, and relating
 * them by hand means three rate knobs that drift apart the moment one moves.
 *
 * Every output is a pulse train at its own divided rate, sharing one Width,
 * so narrowing Width turns all five into triggers together rather than
 * turning the divisions into something structurally different from the
 * undivided one.
 */
export class ClockModule extends DspModule {
  /**
   * Float64, as the sample and hold's is: a phase accumulated one small
   * increment per sample drifts measurably if each addition is rounded to
   * float32, and a clock exists to not drift.
   */
  private phase = 0
  /** Ticks since the last reset, so a divisor knows where in its cycle it is. */
  private tick = 0
  private reset = new EdgeDetector()

  process(slots: Float32Array) {
    // Edge-triggered rather than level-held. A reset is a trigger, and a
    // clock that stayed stopped for as long as something held its Reset jack
    // high could not be reset from a gate at all.
    if (this.reset.rose(slots[this.ins[IN_RESET]])) {
      this.phase = 0
      this.tick = 0
    }

    // In octaves, like every other CV amount in the rack, so an envelope into
    // Rate CV doubles and halves the tempo rather than moving it by hertz.
    const cv = slots[this.ins[IN_CV]] * this.params[P_CV_AMOUNT]
    let rate = this.params[P_RATE] * Math.pow(2, cv)
    if (!(rate > 0)) rate = 0
    else if (rate > MAX_RATE) rate = MAX_RATE

    this.phase += rate / this.ctx.sampleRate
    while (this.phase >= 1) {
      this.phase -= 1
      this.tick++
      if (this.tick >= CYCLE) this.tick -= CYCLE
    }

    const width = this.params[P_WIDTH]
    for (let i = 0; i < DIVISORS.length; i++) {
      const n = DIVISORS[i]
      // Where this output is within its own, longer period: whole ticks since
      // it last fired, plus the fraction of the tick in progress. Comparing
      // that against Width is what makes the division a pulse train at the
      // divided rate rather than a gate held open for several ticks.
      const divided = ((this.tick % n) + this.phase) / n
      slots[this.outs[i]] = divided < width ? 1 : 0
    }
  }
}
