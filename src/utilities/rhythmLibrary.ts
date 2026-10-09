/**
 * The Rhythm utility's library: timelines and grooves to start from.
 *
 * A **timeline** is one line -- a clave, a bell, a hand pattern -- that a
 * tradition hangs everything else on, and it is added as a lane. A **groove**
 * is a whole part, a lane per drum, and it is loaded in place of the lanes.
 *
 * Every lane here is written out step by step rather than as a Euclidean
 * count, because most of the world's rhythms are not Euclidean: son clave,
 * x..x..x...x.x..., is no rotation of five in sixteen. Which of them are is
 * worked out from the steps (see `euclidOf`), never written beside them.
 */

/**
 * The pads a library rhythm may use: the sixteen notes the standard kit is
 * laid out on, so anything here lands on a sound in a fresh Drum Kit.
 */
export const LIBRARY_NOTES = [36, 37, 38, 39, 42, 45, 46, 49, 51, 54, 56, 60, 63, 70, 75, 76] as const

export type RhythmCategory =
  | 'clave'
  | 'afrocuban'
  | 'brazil'
  | 'westafrica'
  | 'middleeast'
  | 'balkan'
  | 'more'
  | 'euclidean'
  | 'rock'
  | 'funk'
  | 'hiphop'
  | 'electronic'
  | 'caribbean'
  | 'jazz'
  | 'odd'

/** The categories in the order the library lists them, with what its chips say. */
export const RHYTHM_CATEGORIES: { id: RhythmCategory; name: string }[] = [
  { id: 'clave', name: 'Clave & bell' },
  { id: 'afrocuban', name: 'Afro-Cuban' },
  { id: 'brazil', name: 'Brazilian' },
  { id: 'westafrica', name: 'West African' },
  { id: 'middleeast', name: 'Middle Eastern' },
  { id: 'balkan', name: 'Balkan & Turkish' },
  { id: 'more', name: 'More traditions' },
  { id: 'euclidean', name: 'Euclidean' },
  { id: 'rock', name: 'Rock & pop' },
  { id: 'funk', name: 'Funk & soul' },
  { id: 'hiphop', name: 'Hip-hop & trap' },
  { id: 'electronic', name: 'Electronic' },
  { id: 'caribbean', name: 'Caribbean & Afro-pop' },
  { id: 'jazz', name: 'Jazz & swing' },
  { id: 'odd', name: 'Odd meters' },
]

/** One drum's line in a library rhythm. */
export interface LibraryLane {
  /** One of `LIBRARY_NOTES`: the General MIDI note of the pad it is written for. */
  note: number
  /**
   * The steps, one character each: `X` an accented hit, `x` a hit, `g` a
   * ghost note (a quiet one), `.` a rest. Its length is the lane's steps.
   */
  pattern: string
  /** Steps to a quarter note, when this lane's grid is not the rhythm's own. */
  perBeat?: number
}

export interface LibraryRhythm {
  /** Unique, kebab-case. */
  id: string
  name: string
  kind: 'timeline' | 'groove'
  category: RhythmCategory
  /** Where it is from: a country, a region, a scene. */
  origin: string
  /** The time signature it is counted in, as written: '4/4', '12/8', '7/8'. */
  meter: string
  /**
   * Steps to a quarter note: 4 is sixteenths, 2 eighths, 3 eighth-note
   * triplets (a 12/8 bar in the time of a 4/4 one), 6 sixteenth triplets.
   */
  perBeat: 2 | 3 | 4 | 6 | 8
  /** One line: what it is and where it is heard. */
  description: string
  /** A timeline has exactly one. */
  lanes: LibraryLane[]
}

/**
 * Where a library lane's note goes when the kit has no pad on it: the pads
 * nearest in sound, in order. A kit laid out the General MIDI way has every
 * note here; one laid out its own way still gets the clave on a wood block
 * and the surdo on a tom rather than nothing.
 */
const NEAREST: Readonly<Record<number, readonly number[]>> = {
  36: [35, 41, 43, 45, 47],
  37: [38, 40, 75, 76, 39],
  38: [40, 37, 39],
  39: [38, 40, 37, 54],
  42: [44, 70, 46, 54, 69],
  45: [47, 41, 43, 48, 50, 64, 63, 36],
  46: [42, 44, 55, 49],
  49: [57, 55, 52, 51, 46],
  51: [59, 53, 49, 42],
  54: [70, 69, 42, 44],
  56: [67, 68, 53, 76, 75],
  60: [61, 63, 62, 76],
  63: [62, 64, 60, 61, 45],
  70: [69, 54, 42, 73],
  75: [76, 77, 37, 56],
  76: [77, 75, 37, 56],
}

/** The pad a library lane plays on in a kit: its own note, the nearest in sound, or none. */
export function padFor(note: number, pads: readonly { note: number }[]): number | null {
  for (const n of [note, ...(NEAREST[note] ?? [])]) if (pads.some((p) => p.note === n)) return n
  return null
}

/** Everything a search looks through for a rhythm, lower case. */
export function searchText(r: LibraryRhythm, category: string, label: string | null): string {
  return [r.name, r.origin, r.meter, category, r.description, r.kind, label ?? ''].join(' ').toLowerCase()
}
