import { DspModule, EdgeDetector } from './types'

const P_RATIO = 0
const P_WIDTH = 1

const IN_CLOCK = 0
const IN_RESET = 1

/**
 * The fixed outputs in the def's jack order: a positive number divides the
 * incoming clock, a negative one multiplies it. The last jack, Out, takes its
 * ratio from the Ratio knob instead.
 */
const FIXED = [2, 3, 4, 8, -2, -4]

/** The Ratio knob's steps, in the order its labels are: ×4 down to ÷32. */
export const CLKDIV_RATIOS = [-4, -3, -2, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 32]

/**
 * Ticks counted before the count wraps: a common multiple of every divisor,
 * so each division is at the same point of its own cycle when it does.
 */
const CYCLE = 3360

/** Until a second tick arrives, the gap between ticks is taken to be this. */
const FIRST_GUESS_S = 0.25

/**
 * Clock divider and multiplier: one clock in, the same clock slower and
 * faster out, all in step with it.
 *
 * The Clock module divides its own tempo; this does the same to anything --
 * a Sequencer's gate, a Dust's triggers, a song's beat -- and multiplies it
 * too. A division fires on every nth tick. A multiplication can only be
 * worked out from the gap between ticks, so it measures that gap and fires
 * evenly inside it; it needs two ticks before it knows the tempo, and stops
 * one gap after the clock does.
 *
 * Every output is a pulse train at its own rate sharing one Width, as the
 * Clock's are: narrow it and they are all triggers.
 */
export class ClockDivModule extends DspModule {
  private clock = new EdgeDetector()
  private reset = new EdgeDetector()
  /** Ticks since the last reset. */
  private tick = -1
  /** Samples since the last tick, and the gap between the last two. */
  private since = 0
  private period = 0

  prepare() {
    this.period = FIRST_GUESS_S * this.ctx.sampleRate
    this.since = this.period
  }

  processBlock(from: number, to: number) {
    const clock = this.inputs[IN_CLOCK]
    const reset = this.inputs[IN_RESET]
    const outs = this.outputs
    const width = this.params[P_WIDTH]
    const ratio = CLKDIV_RATIOS[Math.round(this.params[P_RATIO])] ?? 1
    const last = outs.length - 1

    for (let s = from; s < to; s++) {
      // Reset first: the next tick is the first again, and every division
      // fires on it together.
      if (this.reset.rose(reset[s])) this.tick = -1
      if (this.clock.rose(clock[s])) {
        // Measured only between two real ticks; the first after a long gap
        // keeps the tempo it had rather than slowing everything to a crawl.
        if (this.tick >= 0 && this.since < this.period * 4) this.period = this.since
        this.since = 0
        this.tick = (this.tick + 1) % CYCLE
      }
      const running = this.tick >= 0
      const since = this.since
      const period = this.period

      for (let o = 0; o <= last; o++) {
        const n = o === last ? ratio : FIXED[o]
        let on = false
        if (running) {
          if (n >= 1) {
            // Where this output is in its own, longer period: whole ticks
            // since it last fired, plus the part of the current one.
            const phase = ((this.tick % n) * period + since) / (n * period)
            on = phase < width
          } else {
            // Inside the gap, divided evenly; nothing past it.
            const m = -n
            if (since < period) {
              const sub = (since * m) / period
              on = sub - Math.floor(sub) < width
            }
          }
        }
        outs[o][s] = on ? 1 : 0
      }
      this.since++
    }
  }
}
