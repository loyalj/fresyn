/**
 * Scales, for the roll's highlighting and its snap.
 *
 * Pitches here are the roll's rows: semitones up from the bottom of the
 * Keyboard's range, which the roll labels as C. A root of 0 is C, 7 is G.
 */

export interface Scale {
  /** 0..11, the key's tonic, counted up from C. */
  root: number
  /** An id from `SCALES`. */
  mode: string
  /**
   * Whether notes drawn or moved in the roll land only on the scale. Off, it
   * is a guide you can play outside of; on, it is a rail.
   */
  snap?: boolean
}

export const SCALES: { id: string; name: string; steps: number[] }[] = [
  { id: 'major', name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentatonic', name: 'Pentatonic major', steps: [0, 2, 4, 7, 9] },
  { id: 'pentatonicMinor', name: 'Pentatonic minor', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
]

export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const stepsOf = (scale: Scale) => SCALES.find((s) => s.id === scale.mode)?.steps ?? null

const mod12 = (n: number) => ((n % 12) + 12) % 12

/** Whether a row is in the scale. Everything is, with no scale set. */
export function inScale(pitch: number, scale: Scale | undefined): boolean {
  const steps = scale && stepsOf(scale)
  if (!steps) return true
  return steps.includes(mod12(pitch - scale.root))
}

/** Whether a row is the key's tonic, which the roll marks. */
export function isRoot(pitch: number, scale: Scale | undefined): boolean {
  return !!scale && !!stepsOf(scale) && mod12(pitch - scale.root) === 0
}

/**
 * The nearest row in the scale. A tie between the one below and the one
 * above goes up, which is the way a hand moving a note usually means it.
 */
export function nearestInScale(pitch: number, scale: Scale | undefined): number {
  if (inScale(pitch, scale)) return pitch
  for (let d = 1; d < 12; d++) {
    if (inScale(pitch + d, scale)) return pitch + d
    if (inScale(pitch - d, scale)) return pitch - d
  }
  return pitch
}

/**
 * The row `steps` scale degrees away. A pitch off the scale is taken from
 * the nearest one on it first, so stepping from an accidental lands back on
 * the scale rather than keeping the accidental forever.
 */
export function stepInScale(pitch: number, steps: number, scale: Scale | undefined): number {
  if (!scale || !stepsOf(scale)) return pitch + steps
  let p = nearestInScale(pitch, scale)
  const dir = Math.sign(steps)
  for (let i = 0; i < Math.abs(steps); i++) {
    do p += dir
    while (!inScale(p, scale))
  }
  return p
}

/** How many scale degrees apart two rows are, each taken at its nearest. */
export function degreesBetween(from: number, to: number, scale: Scale | undefined): number {
  if (!scale || !stepsOf(scale)) return to - from
  const a = nearestInScale(from, scale)
  const b = nearestInScale(to, scale)
  let n = 0
  const dir = Math.sign(b - a)
  for (let p = a; p !== b; p += dir) if (inScale(p + dir, scale)) n += dir
  return n
}

/** Whether a scale is set and one this build knows. */
export function hasScale(scale: Scale | undefined): scale is Scale {
  return !!scale && !!stepsOf(scale)
}
