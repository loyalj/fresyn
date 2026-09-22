import { streamFor } from '../Rng'
import { DspModule, EdgeDetector } from './types'

const CHANNELS = 4

/**
 * Four sample and holds, each with an internal clock and an internal noise
 * source.
 *
 * Both inputs of a channel are normalled, as they are on the hardware this
 * copies. With nothing patched at all a channel is a stepped random generator
 * running at its Rate -- the classic burbling "computer thinking" source, and
 * the single most useful thing a rack this size can gain from one module.
 * Patch a signal to In and it samples that instead; patch a gate to Trig and
 * that decides when, so the channel becomes a quantiser of time for any other
 * signal.
 *
 * Each clock keeps running either way and is available on its own jack, which
 * gives the rack the steady trigger source it otherwise has no way to make.
 *
 * Four of them rather than one because a stepped source is rarely wanted
 * alone: a pitch sequence and the timbre wobble under it are two channels of
 * the same idea, and one knob was a thin use of a whole rack unit.
 */
export class SampleHoldModule extends DspModule {
  private held = new Float32Array(CHANNELS)
  /**
   * Float64, unlike everything else here: a clock phase is accumulated one
   * tiny increment per sample, and rounding each addition to float32 drifts
   * the tick instants enough to be measured.
   */
  private phase = new Float64Array(CHANNELS)
  private edges = Array.from({ length: CHANNELS }, () => new EdgeDetector())
  /** One stream per channel; see `seedFrom`. */
  private streams: (() => number)[] = new Array(CHANNELS).fill(() => 0)

  /**
   * Channels do not share a random stream, for the same reason modules do
   * not: turning channel 1's Rate must not reshuffle what channel 3 is
   * doing, and it would, because a shared stream is drawn from in whatever
   * order the channels happen to fire.
   *
   * Channel 1 keeps the module's own stream, so a patch written when this
   * module had a single channel still renders the sound it always did.
   */
  override seedFrom(seed: number, id: string) {
    super.seedFrom(seed, id)
    this.streams = [this.random]
    for (let c = 2; c <= CHANNELS; c++) this.streams.push(streamFor(seed, `${id}.ch${c}`))
  }

  process(slots: Float32Array) {
    for (let c = 0; c < CHANNELS; c++) {
      // Ports are grouped by channel, two in and two out apiece, and the
      // parameters are one Rate per channel in the same order.
      const signal = this.ins[c * 2]
      const trig = this.ins[c * 2 + 1]

      // Internal clock. Free-running rather than reset by the trig input: it
      // is an output in its own right, and a clock that stopped whenever you
      // patched something else would be a surprise.
      this.phase[c] += this.params[c] / this.ctx.sampleRate
      let ticked = false
      if (this.phase[c] >= 1) {
        this.phase[c] -= 1
        ticked = true
      }

      // An unpatched input reads slot 0, which is ground and never written,
      // so the wiring itself is what says whether to fall back to the normal.
      const fire = trig === 0 ? ticked : this.edges[c].rose(slots[trig])

      if (fire) {
        this.held[c] = signal === 0 ? this.streams[c]() * 2 - 1 : slots[signal]
      }

      slots[this.outs[c * 2]] = this.held[c]
      // Square, so it reads as a gate to anything expecting one.
      slots[this.outs[c * 2 + 1]] = this.phase[c] < 0.5 ? 1 : 0
    }
  }
}
