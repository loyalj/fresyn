import { DcBlocker } from '../DcBlocker'
import { DelayLine, OnePole } from '../DelayLine'
import { Smoothed } from '../Smoothed'
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
 * How long Size takes to get where it was turned. Much slower than a knob's
 * usual eight milliseconds, because Size moves all four read positions at
 * once: stepped, every line jumps to a different part of its history on the
 * same sample, which is a crunch, and even an eight-millisecond glide is heard
 * as a chirp. Fifty is a room changing shape rather than being swapped.
 */
const SIZE_GLIDE_MS = 50

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
  /** Each line's read distance and loop gain, for the size and decay below. */
  private reach = new Float64Array(LINES)
  private gains = new Float64Array(LINES)
  private tunedSize = NaN
  private tunedDecay = NaN

  private size!: Smoothed
  private decay!: Smoothed
  private damping!: Smoothed
  private mix!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.size = new Smoothed(clamp01(this.params[P_SIZE]), sr, SIZE_GLIDE_MS)
    this.decay = new Smoothed(this.params[P_DECAY], sr)
    this.damping = new Smoothed(this.params[P_DAMPING], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
  }

  process(slots: Float32Array) {
    const dry = slots[this.ins[IN_SIGNAL]]
    const input = this.dc.process(dry)

    this.size.set(clamp01(this.params[P_SIZE]))
    this.decay.set(this.params[P_DECAY])
    this.damping.set(this.params[P_DAMPING])
    this.mix.set(this.params[P_MIX])

    const size = this.size.next()
    // 60 dB in the time the knob asks for, per line, from its own length.
    const decay = this.decay.next()
    // Four powers a sample is a real cost at 48k, and the answer only changes
    // while one of these two knobs is moving -- so it is worked out then.
    if (size !== this.tunedSize || decay !== this.tunedDecay) this.tune(size, decay)
    const damping = this.damping.next()

    for (let i = 0; i < LINES; i++) {
      const read = this.lines[i].read(this.reach[i])
      this.taps[i] = this.dampers[i].process(read, damping) * this.gains[i]
    }

    let a = this.taps[0]
    let b = this.taps[1]
    let c = this.taps[2]
    let d = this.taps[3]
    // tanh(NaN) is NaN, so the saturation below bounds the loop but cannot
    // clean it: a NaN inside would go round the network for good, and the
    // tail -- the song's whole Space return, when this is the console's --
    // would never come back. Emptied, the room is quiet for a moment and then
    // fine.
    const sum = a + b + c + d
    if (sum - sum !== 0) {
      for (let i = 0; i < LINES; i++) {
        this.lines[i].reset()
        this.dampers[i].reset()
      }
      a = b = c = d = 0
    }

    // A 4x4 Hadamard, scaled to keep the mix lossless: every line reaches
    // every other with the same weight, and the sign pattern is what stops
    // the four of them collapsing into one loud in-phase line.
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

    const mix = this.mix.next()
    slots[this.outs[OUT_L]] = dry * (1 - mix) + wetL * mix
    slots[this.outs[OUT_R]] = dry * (1 - mix) + wetR * mix
  }

  /** Each line's distance and gain, for a size of 0..1 and a decay in seconds. */
  private tune(size: number, decay: number) {
    this.tunedSize = size
    this.tunedDecay = decay
    const sr = this.ctx.sampleRate
    const scale = MIN_SIZE + (1 - MIN_SIZE) * size
    for (let i = 0; i < LINES; i++) {
      const samples = LENGTHS[i] * scale * sr
      this.reach[i] = samples
      this.gains[i] = feedbackFor(samples, decay, sr)
    }
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
