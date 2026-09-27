import { integratedLoudness, peakOf } from '../dsp/Loudness'

/**
 * What a render is brought to before it is written out: nothing, a peak just
 * under full scale, or a loudness target in LUFS.
 *
 * -14 is where streaming services and most game platforms sit, -16 is a
 * common target for mobile and for sounds that sit under dialogue, and -23 is
 * broadcast. Peak normalising is the old way, and still the right one for a
 * sound that has to be as hot as it can be without clipping.
 */
export type Normalize = 'off' | 'peak' | '-14' | '-16' | '-23'

export const NORMALIZE_OPTIONS: { id: Normalize; label: string }[] = [
  { id: 'off', label: 'As rendered' },
  { id: 'peak', label: 'Peak −1 dB' },
  { id: '-14', label: '−14 LUFS' },
  { id: '-16', label: '−16 LUFS' },
  { id: '-23', label: '−23 LUFS' },
]

/** No take is made louder than this, whatever its loudness asked for. */
const CEILING = Math.pow(10, -1 / 20)

export interface Normalized {
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  /** The gain applied, as a multiplier. 1 when nothing was done. */
  gain: number
  /** Loudness afterwards, in LUFS. */
  lufs: number
  peak: number
  /**
   * The loudness target would have pushed the peak past -1 dB, so the take
   * was brought up only as far as that. A quiet, spiky sound -- a click with
   * a long quiet tail -- cannot reach -14 LUFS without clipping.
   */
  limited: boolean
}

/**
 * One take brought to a target. A plain gain, never compression: a sound
 * designer's dynamics are the sound, and the job here is only to make a set
 * of takes sit at one level.
 */
export function normalize(
  left: Float32Array<ArrayBuffer>,
  right: Float32Array<ArrayBuffer>,
  sampleRate: number,
  mode: Normalize,
): Normalized {
  const peak = peakOf(left, right)
  const lufs = integratedLoudness(left, right, sampleRate)
  if (mode === 'off' || peak === 0 || !Number.isFinite(lufs)) {
    return { left, right, gain: 1, lufs, peak, limited: false }
  }

  let gain = mode === 'peak' ? CEILING / peak : Math.pow(10, (Number(mode) - lufs) / 20)
  let limited = false
  if (peak * gain > CEILING) {
    gain = CEILING / peak
    limited = mode !== 'peak'
  }

  const l = new Float32Array(left.length)
  const r = new Float32Array(right.length)
  for (let i = 0; i < left.length; i++) l[i] = left[i] * gain
  for (let i = 0; i < right.length; i++) r[i] = right[i] * gain
  return {
    left: l,
    right: r,
    gain,
    lufs: lufs + 20 * Math.log10(gain),
    peak: peak * gain,
    limited,
  }
}
