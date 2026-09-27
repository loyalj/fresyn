import { hasScale, stepInScale, type Scale } from './scale'

/**
 * Chords, for the roll's chord tool: one click lays every note of one.
 *
 * Most are shapes in semitones from the root and mean the same thing in any
 * key. The two `key` entries are built from the song's scale instead -- every
 * other degree stacked up from the note clicked -- so they are always in the
 * key, and a row of them clicked up the scale is the key's own chords: in C
 * major, C, Dm, Em, F, G, Am and B diminished.
 */
export interface ChordShape {
  id: string
  name: string
  /** Semitones from the root, or scale degrees for a chord built from the key. */
  steps: number[]
  /** Counted in scale degrees, and only offered when the song has a key. */
  fromKey?: true
}

export const CHORDS: ChordShape[] = [
  { id: 'key3', name: 'Key triad', steps: [0, 2, 4], fromKey: true },
  { id: 'key7', name: 'Key 7th', steps: [0, 2, 4, 6], fromKey: true },
  { id: 'maj', name: 'Major', steps: [0, 4, 7] },
  { id: 'min', name: 'Minor', steps: [0, 3, 7] },
  { id: 'dim', name: 'Diminished', steps: [0, 3, 6] },
  { id: 'aug', name: 'Augmented', steps: [0, 4, 8] },
  { id: 'sus2', name: 'Sus2', steps: [0, 2, 7] },
  { id: 'sus4', name: 'Sus4', steps: [0, 5, 7] },
  { id: 'power', name: 'Power (5)', steps: [0, 7, 12] },
  { id: 'maj7', name: 'Major 7', steps: [0, 4, 7, 11] },
  { id: 'min7', name: 'Minor 7', steps: [0, 3, 7, 10] },
  { id: 'dom7', name: 'Dominant 7', steps: [0, 4, 7, 10] },
  { id: 'm7b5', name: 'Half-diminished', steps: [0, 3, 6, 10] },
  { id: 'dim7', name: 'Diminished 7', steps: [0, 3, 6, 9] },
  { id: 'maj6', name: 'Major 6', steps: [0, 4, 7, 9] },
  { id: 'min6', name: 'Minor 6', steps: [0, 3, 7, 9] },
  { id: 'add9', name: 'Add9', steps: [0, 4, 7, 14] },
  { id: 'dom9', name: 'Dominant 9', steps: [0, 4, 7, 10, 14] },
]

export const chordById = (id: string) => CHORDS.find((c) => c.id === id)

/**
 * The rows a chord lands on when clicked at `root`, lowest first.
 *
 * `inversion` lifts that many of the lowest notes an octave, which is what
 * keeps a progression from leaping about. Anything that would land above the
 * keyboard is folded down an octave rather than lost, so a chord clicked near
 * the top is still the whole chord, voiced lower; one that lands on a note the
 * chord already has is dropped.
 */
export function chordPitches(
  root: number,
  chord: ChordShape,
  inversion: number,
  scale: Scale | undefined,
  keys: number,
): number[] {
  const built = chord.fromKey
    ? hasScale(scale)
      ? chord.steps.map((d) => stepInScale(root, d, scale))
      : []
    : chord.steps.map((s) => root + s)
  if (built.length === 0) return [root]

  const turns = Math.max(0, Math.min(inversion, built.length - 1))
  const voiced = built.map((p, i) => (i < turns ? p + 12 : p))

  const out: number[] = []
  for (let p of voiced) {
    while (p > keys - 1) p -= 12
    if (p < 0 || out.includes(p)) continue
    out.push(p)
  }
  return out.sort((a, b) => a - b)
}
