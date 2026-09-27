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

/**
 * Rows are whole semitones, and everything below leans on that: a walk from
 * one row to the next in steps of one only ever lands on another row if it
 * started on one. A fractional pitch -- a hand-edited file, a stray bit of
 * arithmetic -- would step past every row in the scale forever and freeze the
 * tab, so every pitch is taken to its row on the way in.
 */
const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12

/** Further than any pitch the roll can show, so reaching it means something went wrong. */
const MAX_WALK = 1024

/** Whether a row is in the scale. Everything is, with no scale set. */
export function inScale(pitch: number, scale: Scale | undefined): boolean {
  const steps = scale && stepsOf(scale)
  if (!steps) return true
  return steps.includes(mod12(Math.round(pitch) - Math.round(scale.root)))
}

/** Whether a row is the key's tonic, which the roll marks. */
export function isRoot(pitch: number, scale: Scale | undefined): boolean {
  return !!scale && !!stepsOf(scale) && mod12(Math.round(pitch) - Math.round(scale.root)) === 0
}

/**
 * The nearest row in the scale. A tie between the one below and the one
 * above goes up, which is the way a hand moving a note usually means it.
 */
export function nearestInScale(pitch: number, scale: Scale | undefined): number {
  if (!hasScale(scale)) return pitch
  pitch = Math.round(pitch)
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
  steps = Math.round(steps)
  const dir = Math.sign(steps)
  // Bounded twice over: every scale has a degree in any twelve rows, so the
  // inner walk is at most twelve long, and the outer one is only as long as
  // a jump anybody could ask for.
  const count = Math.min(Math.abs(steps), MAX_WALK)
  for (let i = 0; i < count; i++) {
    let guard = 12
    do p += dir
    while (!inScale(p, scale) && --guard > 0)
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
  // `a` and `b` are whole rows by now, so `p` meets `b` exactly; the bound is
  // there so that never being true again cannot hang the roll.
  let guard = MAX_WALK * 12
  for (let p = a; p !== b && guard-- > 0; p += dir) if (inScale(p + dir, scale)) n += dir
  return n
}

/** Whether a scale is set and one this build knows. */
export function hasScale(scale: Scale | undefined): scale is Scale {
  return !!scale && !!stepsOf(scale)
}
