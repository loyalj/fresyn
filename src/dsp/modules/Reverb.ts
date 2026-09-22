import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { DspModule } from './types'

const P_SIZE = 0
const P_DECAY = 1
const P_DAMPING = 2
const P_MIX = 3

const IN_SIGNAL = 0

const OUT_L = 0
const OUT_R = 1

/**
 * Four delay lengths in seconds, at the largest the Size knob goes.
 *
 * Mutually prime-ish rather than round: lengths that share a factor put their
 * echoes on top of each other, and a handful of loud repeats at the same
 * instant is a flutter rather than a room.
 */
const LENGTHS = [0.0297, 0.0371, 0.0411, 0.0437]
const LINES = LENGTHS.length

/** How far Size shrinks the room. */
const MIN_SIZE = 0.06

/** Kept off 1 so a long decay is still a decay in arithmetic as well as intent. */
const MAX_FEEDBACK = 0.9995

/**
 * A feedback delay network: four delay lines that feed each other back
 * through a matrix, which is the cheapest thing that sounds like a room
 * rather than like four echoes.
 *
 * The matrix is what does the work. Each line's output is mixed into every
 * line's input, so a single echo becomes four, then sixteen, and the repeats
 * smear into a tail instead of staying countable. Feeding each line only back
 * into itself would give four independent echoes, which is what a bank of
 * delays sounds like and is not a room at all.
 *
 * Decay is set in seconds rather than as a feedback amount, and each line's
 * gain is worked out from its own length, so the tail lasts as long as the
 * knob says whatever Size is doing.
 */
export class ReverbModule extends DspModule {
  private lines = LENGTHS.map((s) => new DelayLine(s * this.ctx.sampleRate))
  private dampers = LENGTHS.map(() => new OnePole())
  /**
   * On the way in, because a feedback network integrates: any DC offset that
   * gets inside the loop is added to itself several thousand times a second
   * and walks the whole tail off scale.
   */
  private dc = new DcBlocker(this.ctx.sampleRate)
  /** This sample's reads, so the matrix can mix them before any are replaced. */
  private taps = new Float64Array(LINES)

  process(slots: Float32Array) {
    const dry = slots[this.ins[IN_SIGNAL]]
    const input = this.dc.process(dry)

    const size = MIN_SIZE + (1 - MIN_SIZE) * clamp01(this.params[P_SIZE])
    const damping = this.params[P_DAMPING]
    // 60 dB in the time the knob asks for, per line, from its own length.
    const decay = this.params[P_DECAY]

    for (let i = 0; i < LINES; i++) {
      const samples = LENGTHS[i] * size * this.ctx.sampleRate
      const read = this.lines[i].read(samples)
      const gain = feedbackFor(samples, decay, this.ctx.sampleRate)
      this.taps[i] = this.dampers[i].process(read, damping) * gain
    }

    // A 4x4 Hadamard, scaled to keep the mix lossless: every line reaches
    // every other with the same weight, and the sign pattern is what stops
    // the four of them collapsing into one loud in-phase line.
    const a = this.taps[0]
    const b = this.taps[1]
    const c = this.taps[2]
    const d = this.taps[3]
    const m0 = (a + b + c + d) * 0.5
    const m1 = (a - b + c - d) * 0.5
    const m2 = (a + b - c - d) * 0.5
    const m3 = (a - b - c + d) * 0.5

    // Saturating each line bounds the network however long the decay is, the
    // same way the delay bounds its own loop.
    this.lines[0].push(Math.tanh(input + m0))
    this.lines[1].push(Math.tanh(input + m1))
    this.lines[2].push(Math.tanh(input + m2))
    this.lines[3].push(Math.tanh(input + m3))

    // Two different pairs, so the sides are decorrelated and the tail has
    // width. Taking the same sum twice would be a mono reverb in two jacks.
    const wetL = (a + c) * 0.5
    const wetR = (b + d) * 0.5

    const mix = this.params[P_MIX]
    slots[this.outs[OUT_L]] = dry * (1 - mix) + wetL * mix
    slots[this.outs[OUT_R]] = dry * (1 - mix) + wetR * mix
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * The per-round gain that leaves a line 60 dB down after `seconds`.
 *
 * Worked out from the line's own length so that lines of different lengths
 * die together: a short line goes round far more often in the same time, and
 * one shared gain would leave it silent while the long one was still ringing.
 */
function feedbackFor(samples: number, seconds: number, sampleRate: number) {
  if (!(seconds > 0)) return 0
  const g = Math.pow(10, (-3 * samples) / (seconds * sampleRate))
  return g > MAX_FEEDBACK ? MAX_FEEDBACK : g
}
