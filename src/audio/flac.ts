/**
 * FLAC, written here rather than pulled in: lossless, half the size of a WAV
 * or better, and read by every DAW, every browser and most game engines.
 *
 * The encoder is the plain end of what the format allows, and the output is
 * still an ordinary FLAC any decoder reads. Each block of 4096 frames tries
 * the five fixed predictors on every channel and keeps the best, with a
 * single value for silence. It tries
 * left/right, left/side, side/right and mid/side stereo and keeps the
 * smallest. Residuals are Rice coded in partitions whose parameters are
 * picked by counting the bits. LPC is left out: it would save another few
 * percent, at many times the code and the time.
 */

export type FlacDepth = 16 | 24

const BLOCK = 4096

export function encodeFlac(channels: Float32Array[], sampleRate: number, bitDepth: FlacDepth = 16): Uint8Array<ArrayBuffer> {
  const nch = channels.length
  if (nch < 1 || nch > 2) throw new Error('FLAC here is mono or stereo')
  if (!(sampleRate > 0 && sampleRate < 1 << 20)) throw new Error(`no FLAC at ${sampleRate} Hz`)
  const frames = channels[0].length
  const full = bitDepth === 16 ? 32767 : 8388607
  // Quantized once, the way the WAV writer does it: clamped, not wrapped.
  const pcm = channels.map((c) => {
    const out = new Int32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = Math.round(Math.max(-1, Math.min(1, c[i])) * full)
    return out
  })

  const w = new BitWriter(frames * nch * (bitDepth / 8) + 1024)
  w.bytes([0x66, 0x4c, 0x61, 0x43]) // fLaC

  // STREAMINFO, the only block, so it is the last.
  w.bits(1, 1)
  w.bits(0, 7)
  w.bits(34, 24)
  // A stream shorter than one block is one short block, and says so.
  const blockSize = frames < BLOCK ? Math.max(16, frames) : BLOCK
  w.bits(blockSize, 16) // min block size
  w.bits(blockSize, 16) // max block size
  w.bits(0, 24) // min frame size: unknown
  w.bits(0, 24) // max frame size: unknown
  w.bits(sampleRate, 20)
  w.bits(nch - 1, 3)
  w.bits(bitDepth - 1, 5)
  // 36 bits of total samples, in two pieces to stay inside 32-bit arithmetic.
  w.bits(Math.floor(frames / 2 ** 32) & 0xf, 4)
  w.bits(frames >>> 0, 32)
  for (let i = 0; i < 16; i++) w.bits(0, 8) // MD5: not computed, which the format allows

  for (let start = 0, n = 0; start < frames; start += BLOCK, n++) {
    const size = Math.min(BLOCK, frames - start)
    writeFrame(w, pcm.map((c) => c.subarray(start, start + size)), n, bitDepth)
  }
  return w.finish()
}

/** Channel assignments, as the frame header numbers them. */
const INDEPENDENT = 0
const LEFT_SIDE = 8
const SIDE_RIGHT = 9
const MID_SIDE = 10

function writeFrame(w: BitWriter, chans: Int32Array[], index: number, bps: number) {
  const size = chans[0].length
  let assignment = chans.length - 1
  let subs: Int32Array[] = chans
  let depths = chans.map(() => bps)
  let plans = chans.map((c) => plan(c, bps))

  if (chans.length === 2) {
    const [l, r] = chans
    const side = new Int32Array(size)
    const mid = new Int32Array(size)
    for (let i = 0; i < size; i++) {
      side[i] = l[i] - r[i]
      mid[i] = (l[i] + r[i]) >> 1
    }
    const ps = plan(side, bps + 1)
    const pm = plan(mid, bps)
    const [pl, pr] = plans
    const options = [
      { a: INDEPENDENT + 1, s: [l, r], d: [bps, bps], p: [pl, pr] },
      { a: LEFT_SIDE, s: [l, side], d: [bps, bps + 1], p: [pl, ps] },
      { a: SIDE_RIGHT, s: [side, r], d: [bps + 1, bps], p: [ps, pr] },
      { a: MID_SIDE, s: [mid, side], d: [bps, bps + 1], p: [pm, ps] },
    ]
    let best = options[0]
    for (const o of options) if (o.p[0].bits + o.p[1].bits < best.p[0].bits + best.p[1].bits) best = o
    assignment = best.a
    subs = best.s
    depths = best.d
    plans = best.p
  }

  const frameStart = w.byteLength()
  // Header.
  w.bits(0b11111111111110, 14)
  w.bits(0, 1) // reserved
  w.bits(0, 1) // fixed block size
  const sizeCode = size === BLOCK ? 0b1100 : 0b0111
  w.bits(sizeCode, 4)
  w.bits(0, 4) // sample rate: from STREAMINFO
  w.bits(assignment, 4)
  w.bits(bps === 16 ? 0b100 : 0b110, 3)
  w.bits(0, 1) // reserved
  for (const b of utf8(index)) w.bits(b, 8)
  if (sizeCode === 0b0111) w.bits(size - 1, 16)
  w.bits(crc8(w.slice(frameStart)), 8)

  subs.forEach((c, i) => writeSubframe(w, c, depths[i], plans[i]))

  w.align()
  const crc = crc16(w.slice(frameStart))
  w.bits(crc, 16)
}

interface Plan {
  /** 0..4, -1 for verbatim, or -2 for one value throughout. */
  order: number
  residual: Int32Array
  partitionOrder: number
  params: number[]
  /** Everything the subframe costs, in bits. */
  bits: number
}

/** The cheapest way to code one channel of one block. */
function plan(x: Int32Array, bps: number): Plan {
  const n = x.length
  // Silence, or a held value: one sample says it all.
  let flat = true
  for (let i = 1; i < n && flat; i++) flat = x[i] === x[0]
  if (flat) return { order: -2, residual: x, partitionOrder: 0, params: [], bits: 8 + bps }
  // Verbatim is the fallback, and what a block too short for a predictor gets.
  let best: Plan = { order: -1, residual: x, partitionOrder: 0, params: [], bits: 8 + n * bps }
  for (let order = 0; order <= 4 && order < n; order++) {
    const r = fixedResidual(x, order)
    const coded = riceCost(r, order, n)
    if (!coded) continue
    const bits = 8 + order * bps + coded.bits
    if (bits < best.bits) best = { order, residual: r, partitionOrder: coded.order, params: coded.params, bits }
  }
  return best
}

/** What is left after each of FLAC's fixed polynomial predictors. From `order` on; before it is unused. */
function fixedResidual(x: Int32Array, order: number): Int32Array {
  const n = x.length
  const r = new Int32Array(n)
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: r[i] = x[i]; break
      case 1: r[i] = x[i] - x[i - 1]; break
      case 2: r[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break
      case 3: r[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break
      default: r[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]
    }
  }
  return r
}

/** The largest Rice parameter the 5-bit method can carry (31 is its escape). */
const MAX_PARAM = 30
/** The finest partitioning tried. */
const MAX_PARTITION_ORDER = 8

/**
 * The cheapest partitioning of a residual and the Rice parameter for each
 * partition, in bits -- or null if it cannot be Rice coded (a residual past
 * 31 bits, which only a broken predictor makes).
 */
function riceCost(r: Int32Array, order: number, n: number): { order: number; params: number[]; bits: number } | null {
  const u = new Float64Array(n)
  for (let i = order; i < n; i++) {
    const v = r[i]
    u[i] = v >= 0 ? 2 * v : -2 * v - 1
  }
  let best: { order: number; params: number[]; bits: number } | null = null
  for (let p = 0; p <= MAX_PARTITION_ORDER; p++) {
    const parts = 1 << p
    if (n % parts !== 0) break
    const len = n / parts
    if (len <= order) break
    let bits = 2 + 4 // method, partition order
    const params: number[] = []
    for (let k = 0; k < parts; k++) {
      const from = k === 0 ? order : k * len
      const to = (k + 1) * len
      let sum = 0
      for (let i = from; i < to; i++) sum += u[i]
      const count = to - from
      // Start near the best parameter and walk to the cheapest.
      const mean = count ? sum / count : 0
      let param = mean > 1 ? Math.min(MAX_PARAM, Math.floor(Math.log2(mean))) : 0
      let cost = partCost(u, from, to, param)
      for (const step of [-1, 1]) {
        for (let q = param + step; q >= 0 && q <= MAX_PARAM; q += step) {
          const c = partCost(u, from, to, q)
          if (c >= cost) break
          cost = c
          param = q
        }
      }
      if (!Number.isFinite(cost)) return best
      params.push(param)
      bits += 5 + cost
    }
    if (!best || bits < best.bits) best = { order: p, params, bits }
  }
  return best
}

/** Bits for one partition at one parameter: the unary quotients, their stops, and the low bits. */
function partCost(u: Float64Array, from: number, to: number, k: number): number {
  let bits = (to - from) * (k + 1)
  const div = 2 ** k
  for (let i = from; i < to; i++) bits += Math.floor(u[i] / div)
  return bits
}

function writeSubframe(w: BitWriter, x: Int32Array, bps: number, p: Plan) {
  w.bits(0, 1)
  if (p.order === -2) {
    w.bits(0b000000, 6)
    w.bits(0, 1)
    w.signed(x[0], bps)
    return
  }
  if (p.order < 0) {
    w.bits(0b000001, 6)
    w.bits(0, 1)
    for (let i = 0; i < x.length; i++) w.signed(x[i], bps)
    return
  }
  w.bits(0b001000 | p.order, 6)
  w.bits(0, 1) // no wasted bits
  for (let i = 0; i < p.order; i++) w.signed(x[i], bps)
  w.bits(0b01, 2) // Rice, 5-bit parameters
  w.bits(p.partitionOrder, 4)
  const parts = 1 << p.partitionOrder
  const len = x.length / parts
  for (let k = 0; k < parts; k++) {
    const param = p.params[k]
    w.bits(param, 5)
    const from = k === 0 ? p.order : k * len
    const to = (k + 1) * len
    for (let i = from; i < to; i++) w.rice(p.residual[i], param)
  }
}

/** A frame number, in the format's extended UTF-8. */
function utf8(n: number): number[] {
  if (n < 0x80) return [n]
  const out: number[] = []
  let bytes = 2
  while (n >= 2 ** (5 * bytes + 1)) bytes++
  for (let i = bytes - 1; i > 0; i--) {
    out.unshift(0x80 | (n & 0x3f))
    n = Math.floor(n / 64)
  }
  out.unshift(((0xff00 >> bytes) & 0xff) | n)
  return out
}

const CRC8 = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
    t[i] = c
  }
  return t
})()
const CRC16 = (() => {
  const t = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 8
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff
    t[i] = c
  }
  return t
})()

export function crc8(data: Uint8Array): number {
  let c = 0
  for (let i = 0; i < data.length; i++) c = CRC8[c ^ data[i]]
  return c
}

export function crc16(data: Uint8Array): number {
  let c = 0
  for (let i = 0; i < data.length; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ data[i]]) & 0xffff
  return c
}

/** Bits, most significant first, into a buffer that grows. */
class BitWriter {
  private buf: Uint8Array<ArrayBuffer>
  private pos = 0
  private acc = 0
  private n = 0

  constructor(guess: number) {
    this.buf = new Uint8Array(Math.max(1024, guess))
  }

  private push(byte: number) {
    if (this.pos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.pos++] = byte
  }

  /** Up to 32 bits of an unsigned value. */
  bits(value: number, count: number) {
    if (count > 24) {
      this.bits(Math.floor(value / 2 ** 16) & 0xffff, count - 16)
      this.bits(value & 0xffff, 16)
      return
    }
    this.acc = (this.acc * 2 ** count + (value & (2 ** count - 1))) % 2 ** 32
    this.n += count
    while (this.n >= 8) {
      this.n -= 8
      this.push(Math.floor(this.acc / 2 ** this.n) & 0xff)
    }
    this.acc %= 2 ** this.n
  }

  signed(value: number, count: number) {
    this.bits(value < 0 ? value + 2 ** count : value, count)
  }

  /** One residual, zig-zagged, as a unary quotient then `k` low bits. */
  rice(value: number, k: number) {
    const u = value >= 0 ? 2 * value : -2 * value - 1
    let q = Math.floor(u / 2 ** k)
    while (q >= 24) {
      this.bits(0, 24)
      q -= 24
    }
    this.bits(1, q + 1)
    if (k) this.bits(u % 2 ** k, k)
  }

  bytes(list: number[]) {
    for (const b of list) this.bits(b, 8)
  }

  align() {
    if (this.n) this.bits(0, 8 - this.n)
  }

  byteLength() {
    return this.pos
  }

  /** Whole bytes written since `from`. Only meaningful when aligned. */
  slice(from: number): Uint8Array {
    return this.buf.subarray(from, this.pos)
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.align()
    return this.buf.slice(0, this.pos)
  }
}
