import { DspModule } from './types'

const P_COUNT = 0
const P_MODE = 1

const IN_TRIG = 0
const IN_RESET = 1

/** The four gate outputs come first, then Index. */
export const ROBIN_OUTS = 4
const OUT_INDEX = ROBIN_OUTS

const MODE_RANDOM = 1
const MODE_SHUFFLE = 2

/**
 * Hands each trigger to the next of its outputs: the game-audio trick that
 * keeps the tenth footstep from sounding like the ninth.
 *
 * Four Samplers, or four slightly different racks, on Out 1 to 4, and every
 * gate at Trig goes to one of them -- in turn (Cycle), at random but never
 * the same one twice running (Random), or in a shuffled order that uses each
 * once before any comes round again (Shuffle). The gate passes through for
 * as long as it is held, so an envelope on the far side sees the whole of
 * it. Index says which output has it, 0 to 1, for a pitch or a filter that
 * should shift a little with each one.
 */
export class RoundRobinModule extends DspModule {
  private current = -1
  private wasHigh = false
  private wasReset = false
  /** Shuffle's bag: the order still to come, and how far through it. */
  private bag = new Int8Array(ROBIN_OUTS)
  private bagAt = ROBIN_OUTS

  processBlock(from: number, to: number) {
    const trig = this.inputs[IN_TRIG]
    const reset = this.inputs[IN_RESET]
    const outs = this.outputs
    const index = outs[OUT_INDEX]
    let count = Math.round(this.params[P_COUNT])
    count = count < 2 ? 2 : count > ROBIN_OUTS ? ROBIN_OUTS : count
    const mode = Math.round(this.params[P_MODE])

    for (let i = from; i < to; i++) {
      const r = reset[i] > 0.5
      if (r && !this.wasReset) {
        this.current = -1
        this.bagAt = ROBIN_OUTS
      }
      this.wasReset = r

      const high = trig[i] > 0.5
      if (high && !this.wasHigh) this.current = this.pick(count, mode)
      this.wasHigh = high

      for (let k = 0; k < ROBIN_OUTS; k++) outs[k][i] = high && k === this.current ? 1 : 0
      index[i] = this.current < 0 ? 0 : this.current / (count - 1)
    }
  }

  private pick(count: number, mode: number): number {
    const last = this.current
    if (mode === MODE_RANDOM) {
      // Any but the last: one fewer choice, and the last one stepped over.
      if (last < 0 || last >= count) return Math.floor(this.random() * count)
      const k = Math.floor(this.random() * (count - 1))
      return k >= last ? k + 1 : k
    }
    if (mode === MODE_SHUFFLE) {
      if (this.bagAt >= count) {
        for (let k = 0; k < count; k++) this.bag[k] = k
        for (let k = count - 1; k > 0; k--) {
          const j = Math.floor(this.random() * (k + 1))
          const t = this.bag[k]
          this.bag[k] = this.bag[j]
          this.bag[j] = t
        }
        // The new bag never starts with what the old one ended on.
        if (this.bag[0] === last) {
          this.bag[0] = this.bag[count - 1]
          this.bag[count - 1] = last
        }
        this.bagAt = 0
      }
      return this.bag[this.bagAt++]
    }
    return last < 0 || last + 1 >= count ? 0 : last + 1
  }
}
