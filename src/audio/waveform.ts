/**
 * Peak envelope for drawing a take.
 *
 * One peak per column rather than a decimated sample: dropping samples hides
 * short transients, which for a one-shot is usually the only interesting part
 * of the whole file.
 */
export function peakEnvelope(
  left: Float32Array,
  right: Float32Array,
  columns: number,
): Float32Array {
  const out = new Float32Array(columns)
  if (left.length === 0) return out

  const per = left.length / columns
  for (let c = 0; c < columns; c++) {
    const start = Math.floor(c * per)
    const end = Math.min(left.length, Math.max(start + 1, Math.floor((c + 1) * per)))
    let peak = 0
    for (let i = start; i < end; i++) {
      const a = Math.max(Math.abs(left[i]), Math.abs(right[i]))
      if (a > peak) peak = a
    }
    out[c] = peak
  }
  return out
}

export function dbOf(amplitude: number): number {
  return amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude)
}
