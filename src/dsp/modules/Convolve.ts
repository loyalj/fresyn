import { DelayLine } from '../DelayLine'
import { Fft } from '../Fft'
import type { SampleData } from '../samples'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_MIX = 0
const P_PREDELAY = 1
const P_LENGTH = 2
const P_REVERSE = 3

const IN_SIGNAL = 0

const OUT_L = 0
const OUT_R = 1

/** The longest impulse it will play, in seconds. Anything longer is cut there. */
export const CONVOLVE_MAX_S = 4
/** The longest Pre-delay, in seconds. */
const MAX_PREDELAY_S = 0.25

/**
 * Two sizes of partition: small ones for the start of the impulse, so the
 * sound arrives a block late rather than a long block late, and big ones for
 * the tail, where a big transform costs far less per sample.
 */
const HEAD_BLOCK = 128
const HEAD_FFT = HEAD_BLOCK * 2
/** The head covers the first 4096 samples of the impulse: thirty-two small partitions. */
const HEAD_PARTS = 32
const HEAD_SPAN = HEAD_BLOCK * HEAD_PARTS
const TAIL_BLOCK = 2048
const TAIL_FFT = TAIL_BLOCK * 2
/**
 * A tail block's work is spread over the sixteen small blocks that follow it
 * -- one transform in, the products a slice at a time, one transform out --
 * rather than done all at once, which would be a spike every sixteenth block.
 * There is room to: the tail starts 4096 samples into the impulse, so what it
 * adds is not wanted until a whole tail block after its input arrived.
 */
const TAIL_STEPS = TAIL_BLOCK / HEAD_BLOCK
/** What the latency is: the head works a whole small block at a time. */
const LATENCY = HEAD_BLOCK - 1
/** How far ahead of the read position a finished tail block lands. */
const TAIL_LEAD = HEAD_SPAN - TAIL_BLOCK + 1 + LATENCY - (TAIL_STEPS - 1) * HEAD_BLOCK
/** Where the output is gathered: far enough ahead for a tail block landing early. */
const ACC = 8192
/** How long the impulse has to stay as it is before it is rebuilt: a knob still turning waits. */
const SETTLE = 2048

/**
 * Convolution: any sound used as the space another one plays in.
 *
 * Load a recording into it -- a clap in a stairwell, a speaker cabinet's
 * impulse, a door slamming -- and whatever reaches In comes out as though it
 * had been played there. It works by convolution, every sample of the input
 * setting off a copy of the whole impulse, which is done in the frequency
 * domain a partition at a time, so a four-second hall costs a few percent of
 * the audio thread rather than everything.
 *
 * The impulse is brought to a common loudness on the way in, so a quiet room
 * and a loud cabinet sit at the same level, and a mono impulse plays the same
 * on both sides. Length cuts it short with a fade, Reverse plays it backwards
 * -- a swell into every note -- and Pre-delay holds the wet signal back.
 *
 * Everything through it, dry included, is 127 samples late: the head of the
 * impulse is worked a block at a time.
 */
export class ConvolveModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  readonly memory = CONVOLVE_MAX_S + MAX_PREDELAY_S + LATENCY / this.ctx.sampleRate

  holdsFor() {
    return this.builtLength / this.ctx.sampleRate + this.params[P_PREDELAY] + LATENCY / this.ctx.sampleRate
  }

  private mix!: Smoothed
  private predelay = new DelayLine(MAX_PREDELAY_S * this.ctx.sampleRate + 2)
  private dry = new DelayLine(LATENCY + 2)
  /** The last TAIL_FFT samples of input, after the pre-delay. */
  private input = new Float64Array(TAIL_FFT)
  private inputAt = 0
  /** Samples taken in since the start, modulo a tail block: where in the cycle it is. */
  private count = 0
  private accL = new Float64Array(ACC)
  private accR = new Float64Array(ACC)
  /** Where the next sample to put out sits in `acc`. */
  private emitAt = 0

  private headFft = new Fft(HEAD_FFT)
  private tailFft = new Fft(TAIL_FFT)
  private headRe = new Float64Array(HEAD_FFT)
  private headIm = new Float64Array(HEAD_FFT)
  private tailRe = new Float64Array(TAIL_FFT)
  private tailIm = new Float64Array(TAIL_FFT)
  private sumRe = new Float64Array(TAIL_FFT)
  private sumIm = new Float64Array(TAIL_FFT)

  /**
   * The impulse's spectra, a partition at a time. Each is the transform of
   * left plus i times right, so one product with the input's spectrum gives
   * both sides at once: the input is real, so the left comes back in the real
   * part and the right in the imaginary.
   */
  private headH: Float32Array[] = []
  private tailH: Float32Array[] = []
  /** The input's spectra, newest at `headSlot` and `tailSlot`, going back. */
  private headX: Float32Array[] = []
  private tailX: Float32Array[] = []
  private headSlot = 0
  private tailSlot = 0
  private tailParts = 0
  /** How many partitions of each are in use. */
  private headLive = 0
  private tailLive = 0
  /** Which step of the tail's work the next small block does, or -1 for none under way. */
  private tailStep = -1

  /** What the spectra were built from, and what they are being rebuilt towards. */
  private builtFrom: SampleData | null = null
  private builtLength = 0
  private builtReverse = false
  private wantFor = 0
  private wantLength = -1
  private wantReverse = false
  private wantFrom: SampleData | null = null
  /** The next partition a rebuild is to make: -1 for the head, 0 up for the tail, or null for none. */
  private rebuilding: number | null = null
  private rebuildLength = 0
  private rebuildReverse = false
  private rebuildFrom: SampleData | null = null
  private rebuildGain = 1
  /** Where Length cuts the impulse, in samples, or 0 when it plays to its own end. */
  private cut = 0
  private rebuildCut = 0
  /** The loudness of each sample's impulse, worked out once per sample. */
  private energyOf: SampleData | null = null
  private energy = 1

  prepare() {
    this.mix = new Smoothed(this.params[P_MIX], this.ctx.sampleRate)
  }

  /** The buffers, made the first time an impulse arrives: a Convolution never given one costs nothing. */
  private allocate() {
    if (this.headH.length) return
    const sr = this.ctx.sampleRate
    this.tailParts = Math.max(0, Math.ceil((CONVOLVE_MAX_S * sr - HEAD_SPAN) / TAIL_BLOCK))
    for (let i = 0; i < HEAD_PARTS; i++) {
      this.headH.push(new Float32Array(HEAD_FFT * 2))
      this.headX.push(new Float32Array(HEAD_FFT * 2))
    }
    for (let i = 0; i < this.tailParts; i++) {
      this.tailH.push(new Float32Array(TAIL_FFT * 2))
      this.tailX.push(new Float32Array(TAIL_FFT * 2))
    }
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[IN_SIGNAL]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const sr = this.ctx.sampleRate
    this.mix.set(this.params[P_MIX])
    this.watch(to - from)
    const pre = this.params[P_PREDELAY] * sr
    const accL = this.accL
    const accR = this.accR

    for (let i = from; i < to; i++) {
      let x = input[i]
      if (x - x !== 0) x = 0
      this.dry.push(x)
      this.predelay.push(x)
      this.input[this.inputAt] = this.predelay.read(pre + 1)
      this.inputAt = (this.inputAt + 1) & (TAIL_FFT - 1)
      this.count = (this.count + 1) & (TAIL_BLOCK - 1)
      if ((this.count & (HEAD_BLOCK - 1)) === 0) this.block()

      const at = this.emitAt
      const wetL = held(accL[at])
      const wetR = held(accR[at])
      accL[at] = 0
      accR[at] = 0
      this.emitAt = (at + 1) & (ACC - 1)
      const mix = this.mix.next()
      // A line's read just after a push counts the newest sample as one back.
      const d = this.dry.read(LATENCY + 1) * (1 - mix)
      outL[i] = d + wetL * mix
      outR[i] = d + wetR * mix
    }
  }

  /**
   * Whether the impulse wants rebuilding, and if so whether it has stayed
   * the same long enough to start. Length is honoured to the small block, so
   * a knob nudged within one costs nothing.
   */
  private watch(frames: number) {
    const sample = this.sample
    const sr = this.ctx.sampleRate
    let length = 0
    if (sample && sample.frames > 0) {
      const whole = Math.ceil((sample.frames * sr) / sample.rate)
      length = Math.min(whole, Math.round(this.params[P_LENGTH] * sr), Math.floor(CONVOLVE_MAX_S * sr))
      // Cut short, it fades out; played to its own end, it is left alone.
      this.cut = length < whole ? length : 0
      length = Math.max(HEAD_BLOCK, Math.ceil(length / HEAD_BLOCK) * HEAD_BLOCK)
    }
    const reverse = Math.round(this.params[P_REVERSE]) === 1
    if (sample !== this.wantFrom || length !== this.wantLength || reverse !== this.wantReverse) {
      this.wantFrom = sample
      this.wantLength = length
      this.wantReverse = reverse
      // A new file is taken at once; a knob waits until it has stopped.
      this.wantFor = sample !== this.builtFrom ? SETTLE : 0
    } else this.wantFor += frames
    const differs = sample !== this.builtFrom || length !== this.builtLength || reverse !== this.builtReverse
    const already = this.rebuilding !== null && this.rebuildFrom === sample && this.rebuildLength === length && this.rebuildReverse === reverse
    if (differs && !already && this.wantFor >= SETTLE) this.startRebuild(sample, length, reverse)
  }

  private startRebuild(sample: SampleData | null, length: number, reverse: boolean) {
    if (!sample || length === 0) {
      // Nothing to play: stop at once, and keep the buffers for the next one.
      this.builtFrom = sample
      this.builtLength = 0
      this.builtReverse = reverse
      this.headLive = 0
      this.tailLive = 0
      this.rebuilding = null
      return
    }
    this.allocate()
    if (this.energyOf !== sample) {
      this.energyOf = sample
      this.energy = energyOf(sample, this.ctx.sampleRate)
    }
    this.rebuildFrom = sample
    this.rebuildLength = length
    this.rebuildReverse = reverse
    this.rebuildCut = this.cut
    this.rebuildGain = this.energy > 1e-12 ? 1 / Math.sqrt(this.energy) : 0
    this.rebuilding = -1
  }

  /** One small block's work: the head, a slice of the tail, and a slice of any rebuild. */
  private block() {
    if (this.rebuilding !== null) this.rebuildStep()
    if (this.headLive > 0) this.head()
    if (this.count === 0 && this.tailLive > 0) this.tailStep = 0
    if (this.tailStep >= 0) this.tail()
  }

  private head() {
    const re = this.headRe
    const im = this.headIm
    // The last two small blocks of input, the older one first: overlap-save.
    let at = (this.inputAt - HEAD_FFT) & (TAIL_FFT - 1)
    for (let k = 0; k < HEAD_FFT; k++) {
      re[k] = this.input[at]
      im[k] = 0
      at = (at + 1) & (TAIL_FFT - 1)
    }
    this.headFft.transform(re, im)
    this.headSlot = (this.headSlot + 1) % HEAD_PARTS
    const x = this.headX[this.headSlot]
    for (let k = 0; k < HEAD_FFT; k++) {
      x[2 * k] = re[k]
      x[2 * k + 1] = im[k]
    }
    re.fill(0)
    im.fill(0)
    for (let p = 0; p < this.headLive; p++) {
      const xs = this.headX[(this.headSlot - p + HEAD_PARTS) % HEAD_PARTS]
      multiplyAdd(xs, this.headH[p], re, im, HEAD_FFT)
    }
    this.headFft.transform(re, im, true)
    // The back half is the convolution of the block that just arrived, which
    // is put out starting now: it lands at the read position.
    let to = this.emitAt
    for (let k = HEAD_BLOCK; k < HEAD_FFT; k++) {
      this.accL[to] += re[k]
      this.accR[to] += im[k]
      to = (to + 1) & (ACC - 1)
    }
  }

  private tail() {
    const step = this.tailStep
    const re = this.tailRe
    const im = this.tailIm
    if (step === 0) {
      let at = this.inputAt
      for (let k = 0; k < TAIL_FFT; k++) {
        re[k] = this.input[at]
        im[k] = 0
        at = (at + 1) & (TAIL_FFT - 1)
      }
      this.tailFft.transform(re, im)
      this.tailSlot = (this.tailSlot + 1) % this.tailParts
      const x = this.tailX[this.tailSlot]
      for (let k = 0; k < TAIL_FFT; k++) {
        x[2 * k] = re[k]
        x[2 * k + 1] = im[k]
      }
      this.sumRe.fill(0)
      this.sumIm.fill(0)
    } else if (step < TAIL_STEPS - 1) {
      const per = Math.ceil(this.tailLive / (TAIL_STEPS - 2))
      const first = (step - 1) * per
      const last = Math.min(this.tailLive, first + per)
      for (let p = first; p < last; p++) {
        const xs = this.tailX[(this.tailSlot - p + this.tailParts) % this.tailParts]
        multiplyAdd(xs, this.tailH[p], this.sumRe, this.sumIm, TAIL_FFT)
      }
    } else {
      this.tailFft.transform(this.sumRe, this.sumIm, true)
      // This tail block's input ended 15 small blocks ago, and the tail
      // starts HEAD_SPAN samples into the impulse, so the first sample it
      // adds to is that far past the block's end, less the 15 blocks gone
      // since, plus the latency the read position is behind by.
      let to = (this.emitAt + TAIL_LEAD) & (ACC - 1)
      for (let k = TAIL_BLOCK; k < TAIL_FFT; k++) {
        this.accL[to] += this.sumRe[k]
        this.accR[to] += this.sumIm[k]
        to = (to + 1) & (ACC - 1)
      }
    }
    this.tailStep = step + 1 < TAIL_STEPS ? step + 1 : -1
  }

  /**
   * One piece of a rebuild: the whole head in one go, then a tail partition
   * a block. A four-second impulse is rebuilt in a quarter of a second, and
   * never in one lump. While it goes on, partitions made from the old
   * impulse and the new one play together, which is a quarter of a second of
   * a room changing shape.
   */
  private rebuildStep() {
    const part = this.rebuilding!
    const sample = this.rebuildFrom!
    const length = this.rebuildLength
    const tailWanted = Math.max(0, Math.ceil((length - HEAD_SPAN) / TAIL_BLOCK))
    if (part === -1) {
      for (let p = 0; p < HEAD_PARTS; p++) this.partition(this.headH[p], this.headFft, this.headRe, this.headIm, p * HEAD_BLOCK, HEAD_BLOCK)
      this.headLive = Math.min(HEAD_PARTS, Math.ceil(length / HEAD_BLOCK))
      this.tailLive = Math.max(this.tailLive, tailWanted)
      this.rebuilding = 0
    } else {
      if (part < tailWanted) this.partition(this.tailH[part], this.tailFft, this.tailRe, this.tailIm, HEAD_SPAN + part * TAIL_BLOCK, TAIL_BLOCK)
      else this.tailH[part].fill(0)
      this.rebuilding = part + 1
    }
    if (this.rebuilding! >= Math.max(tailWanted, this.tailLive)) {
      this.tailLive = tailWanted
      this.builtFrom = sample
      this.builtLength = length
      this.builtReverse = this.rebuildReverse
      this.rebuilding = null
    }
  }

  /** The spectrum of `span` samples of the impulse from `offset`, zero-padded to the transform's size. */
  private partition(into: Float32Array, fft: Fft, re: Float64Array, im: Float64Array, offset: number, span: number) {
    const sample = this.rebuildFrom!
    const length = this.rebuildLength
    const gain = this.rebuildGain
    re.fill(0)
    im.fill(0)
    for (let k = 0; k < span; k++) {
      const n = offset + k
      if (n >= length) break
      re[k] = impulseAt(sample, 0, n, length, this.rebuildCut, this.rebuildReverse, this.ctx.sampleRate) * gain
      im[k] = impulseAt(sample, 1, n, length, this.rebuildCut, this.rebuildReverse, this.ctx.sampleRate) * gain
    }
    fft.transform(re, im)
    for (let k = 0; k < fft.size; k++) {
      into[2 * k] = re[k]
      into[2 * k + 1] = im[k]
    }
  }
}

/**
 * Where the wet side is let go up to untouched, and the most it can reach.
 *
 * Brought to unit energy, an impulse that rings at one pitch -- a struck
 * glass, a tone, a sweep -- still lifts a sound at that pitch far past full
 * scale, by as much as the root of its length: a second of sine would put out
 * a hundred and fifty times what went in. Anything a room or a cabinet does
 * stays under the knee and is not touched; past it, the excess is rounded
 * off so it can never pass the cap.
 */
const KNEE = 2
const CAP = 4

function held(w: number) {
  const a = w < 0 ? -w : w
  if (a <= KNEE) return w
  const over = KNEE + (CAP - KNEE) * Math.tanh((a - KNEE) / (CAP - KNEE))
  return w < 0 ? -over : over
}

/** `re + i im += x * h`, bin by bin, for interleaved spectra. */
function multiplyAdd(x: Float32Array, h: Float32Array, re: Float64Array, im: Float64Array, n: number) {
  for (let k = 0; k < n; k++) {
    const xr = x[2 * k]
    const xi = x[2 * k + 1]
    const hr = h[2 * k]
    const hi = h[2 * k + 1]
    re[k] += xr * hr - xi * hi
    im[k] += xr * hi + xi * hr
  }
}

/** The fade at the end of a shortened impulse, as a share of what is kept. */
const FADE_SHARE = 0.25

/**
 * Sample `n` of the impulse at the rack's rate, on channel `c` (a mono file's
 * one channel serves both), `length` long and backwards when `reverse`. When
 * Length cuts it short, at `cut`, it fades out over the last quarter of what
 * is kept rather than stopping dead.
 */
function impulseAt(sample: SampleData, c: number, n: number, length: number, cut: number, reverse: boolean, sr: number) {
  const m = reverse ? length - 1 - n : n
  const ch = sample.channels[c] ?? sample.channels[0]
  const pos = (m * sample.rate) / sr
  const i = Math.floor(pos)
  if (i >= sample.frames) return 0
  const a = ch[i]
  const b = i + 1 < sample.frames ? ch[i + 1] : 0
  let v = a + (b - a) * (pos - i)
  if (cut > 0) {
    if (m >= cut) return 0
    const fadeFrom = cut * (1 - FADE_SHARE)
    if (m > fadeFrom) v *= 0.5 + 0.5 * Math.cos((Math.PI * (m - fadeFrom)) / (cut - fadeFrom))
  }
  return v - v === 0 ? v : 0
}

/**
 * How much energy the impulse carries over the part of it that can play,
 * averaged across its sides: what it is divided by the root of, so any
 * impulse leaves a steady noise at the level it arrived.
 */
function energyOf(sample: SampleData, sr: number) {
  const frames = Math.min(sample.frames, Math.ceil((CONVOLVE_MAX_S * sample.rate)))
  const sides = Math.min(2, sample.channels.length)
  let sum = 0
  for (let c = 0; c < sides; c++) {
    const ch = sample.channels[c]
    for (let i = 0; i < frames; i++) {
      const v = ch[i]
      if (v - v === 0) sum += v * v
    }
  }
  // Energy at the file's rate, carried to the rack's: resampled up, each
  // frame of it becomes sr / rate samples.
  return (sum / sides) * (sr / sample.rate)
}
