/**
 * The whole library, in the order its categories are listed and, within one,
 * the order the rhythms were written down in.
 */
import { euclidOf, parsePattern } from '../euclid'
import { RHYTHM_CATEGORIES, type LibraryRhythm } from '../rhythmLibrary'
import { GROOVES } from './grooves'
import { TIMELINES } from './timelines'
import { TRADITIONS } from './traditions'

const ORDER = new Map(RHYTHM_CATEGORIES.map((c, i) => [c.id, i]))

export const RHYTHM_LIBRARY: readonly LibraryRhythm[] = [...TIMELINES, ...TRADITIONS, ...GROOVES]
  .map((r, i) => ({ r, i }))
  .sort((a, b) => (ORDER.get(a.r.category) ?? 99) - (ORDER.get(b.r.category) ?? 99) || a.i - b.i)
  .map(({ r }) => r)

/**
 * "E(5,8)" for a timeline that is a Euclidean rhythm, in any rotation, and
 * null for one that is not or for a groove. Worked out from its steps, so it
 * can never say something the rhythm does not do.
 */
export function euclidLabel(r: LibraryRhythm): string | null {
  if (r.lanes.length !== 1) return null
  const e = euclidOf(parsePattern(r.lanes[0].pattern).map((s) => s.hit))
  return e ? `E(${e.hits},${e.steps})` : null
}
