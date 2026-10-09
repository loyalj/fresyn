/**
 * A radix-2 complex FFT of one fixed size, in place, on separate real and
 * imaginary arrays.
 *
 * Everything it needs -- the twiddles and the bit-reversed order -- is worked
 * out once in the constructor, so a transform on the audio thread allocates
 * nothing. The Convolution module is what it is for: one of these per
 * partition size, run a few times a block.
 */
export class Fft {
  readonly size: number
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly swap: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two: ${size}`)
    this.size = size
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((2 * Math.PI * i) / size)
    }
    const bits = Math.log2(size)
    this.swap = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.swap[i] = r
    }
  }

  /** Forward when `inverse` is false; the inverse is scaled by 1/size, so a round trip is exact. */
  transform(re: Float64Array, im: Float64Array, inverse = false) {
    const n = this.size
    const swap = this.swap
    for (let i = 0; i < n; i++) {
      const j = swap[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    const sign = inverse ? 1 : -1
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]
          const wi = sign * this.sin[k * step]
          const a = start + k
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
    if (inverse) {
      const scale = 1 / n
      for (let i = 0; i < n; i++) {
        re[i] *= scale
        im[i] *= scale
      }
    }
  }
}
