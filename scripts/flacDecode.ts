/**
 * A FLAC reader for the checks: enough of the format to read back what
 * src/audio/flac.ts writes (fixed predictors, verbatim and constant
 * subframes, Rice coding, the four stereo modes), checking every CRC on the
 * way. It is not the proof that other decoders accept the files -- the
 * browser suite decodes them with Chrome's own for that -- but it shows every
 * sample comes back exactly, from a quick headless run.
 */
import { crc16, crc8 } from '../src/audio/flac'

export interface Decoded {
  sampleRate: number
  channels: number
  bitDepth: number
  totalSamples: number
  /** The samples as integers, a channel each. */
  pcm: Int32Array[]
}

export function decodeFlac(data: Uint8Array): Decoded {
  const r = new Reader(data)
  if (r.bits(32) !== 0x664c6143) throw new Error('no fLaC marker')
  let info: Omit<Decoded, 'pcm'> | null = null
  for (let last = 0; !last; ) {
    last = r.bits(1)
    const type = r.bits(7)
    const len = r.bits(24)
    if (type === 0) {
      r.bits(16)
      r.bits(16)
      r.bits(24)
      r.bits(24)
      const sampleRate = r.bits(20)
      const channels = r.bits(3) + 1
      const bitDepth = r.bits(5) + 1
      const totalSamples = r.bits(4) * 2 ** 32 + r.bits(32)
      for (let i = 0; i < 16; i++) r.bits(8)
      info = { sampleRate, channels, bitDepth, totalSamples }
    } else {
      for (let i = 0; i < len; i++) r.bits(8)
    }
  }
  if (!info) throw new Error('no STREAMINFO')
  const pcm = Array.from({ length: info.channels }, () => new Int32Array(info!.totalSamples))
  let at = 0
  while (at < info.totalSamples) {
    const start = r.pos / 8
    if (r.bits(14) !== 0b11111111111110) throw new Error(`lost sync at byte ${start}`)
    r.bits(2)
    const sizeCode = r.bits(4)
    r.bits(4)
    const assignment = r.bits(4)
    r.bits(3)
    r.bits(1)
    // The frame number, in extended UTF-8.
    let first = r.bits(8)
    let extra = 0
    while (first & 0x80) {
      first = (first << 1) & 0xff
      extra++
    }
    for (let i = 1; i < extra; i++) r.bits(8)
    const size = sizeCode === 0b1100 ? 4096 : sizeCode === 0b0111 ? r.bits(16) + 1 : sizeCode === 0b0110 ? r.bits(8) + 1 : NaN
    if (!Number.isFinite(size)) throw new Error(`block size code ${sizeCode}`)
    const headerEnd = r.pos / 8
    if (crc8(data.subarray(start, headerEnd)) !== r.bits(8)) throw new Error(`header CRC at byte ${start}`)

    const bps = info.bitDepth
    const depths =
      assignment === 8 ? [bps, bps + 1] : assignment === 9 ? [bps + 1, bps] : assignment === 10 ? [bps, bps + 1] : Array(info.channels).fill(bps)
    const subs = depths.map((d) => readSubframe(r, size, d))
    r.align()
    const end = r.pos / 8
    if (crc16(data.subarray(start, end)) !== r.bits(16)) throw new Error(`frame CRC at byte ${start}`)

    for (let i = 0; i < size; i++) {
      let a = subs[0][i]
      let b = subs[1]?.[i] ?? 0
      if (assignment === 8) b = a - b
      else if (assignment === 9) a = a + b
      else if (assignment === 10) {
        const mid = (a << 1) | (b & 1)
        a = (mid + b) >> 1
        b = (mid - b) >> 1
      }
      pcm[0][at + i] = a
      if (info.channels > 1) pcm[1][at + i] = b
    }
    at += size
  }
  return { ...info, pcm }
}

function readSubframe(r: Reader, n: number, bps: number): Int32Array {
  r.bits(1)
  const type = r.bits(6)
  if (r.bits(1)) throw new Error('wasted bits are not written here')
  const x = new Int32Array(n)
  if (type === 0) {
    x.fill(r.signed(bps))
    return x
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) x[i] = r.signed(bps)
    return x
  }
  if ((type & 0b111000) !== 0b001000) throw new Error(`subframe type ${type}`)
  const order = type & 7
  for (let i = 0; i < order; i++) x[i] = r.signed(bps)
  const method = r.bits(2)
  const paramBits = method === 0 ? 4 : 5
  const partitionOrder = r.bits(4)
  const parts = 1 << partitionOrder
  const len = n / parts
  let i = order
  for (let k = 0; k < parts; k++) {
    const param = r.bits(paramBits)
    const count = k === 0 ? len - order : len
    for (let j = 0; j < count; j++, i++) {
      let q = 0
      while (r.bits(1) === 0) q++
      const u = q * 2 ** param + (param ? r.bits(param) : 0)
      x[i] = u % 2 ? -(u + 1) / 2 : u / 2
    }
  }
  for (let t = order; t < n; t++) {
    switch (order) {
      case 1: x[t] += x[t - 1]; break
      case 2: x[t] += 2 * x[t - 1] - x[t - 2]; break
      case 3: x[t] += 3 * x[t - 1] - 3 * x[t - 2] + x[t - 3]; break
      case 4: x[t] += 4 * x[t - 1] - 6 * x[t - 2] + 4 * x[t - 3] - x[t - 4]; break
    }
  }
  return x
}

class Reader {
  pos = 0
  constructor(private data: Uint8Array) {}

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3]
      if (byte === undefined) throw new Error('ran off the end')
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1)
      this.pos++
    }
    return v
  }

  signed(n: number): number {
    const v = this.bits(n)
    return v >= 2 ** (n - 1) ? v - 2 ** n : v
  }

  align() {
    this.pos = (this.pos + 7) & ~7
  }
}
