/**
 * The arithmetic behind the Rhythm utility: Euclidean rhythms.
 *
 * A Euclidean rhythm spreads k hits over n steps as evenly as they will go.
 * It is a short rule with a long reach: three in eight is the tresillo under
 * half the world's dance music, five in eight the cinquillo, five in sixteen
 * the bossa nova -- and two lanes of different lengths drift against each
 * other into a polyrhythm nobody would program by hand.
 */
import { mulberry32 } from '../dsp/Rng'

/** The most steps a lane can have. */
export const MAX_STEPS = 32

/**
 * k hits in n steps, as evenly as they go, by Bjorklund's algorithm: the
 * rhythm starting on a hit, in the form the literature writes it -- three in
 * eight is x..x..x. -- so a rotation means what it means everywhere else.
 */
export function euclid(hits: number, steps: number): boolean[] {
  const n = clampInt(steps, 1, MAX_STEPS)
  const k = clampInt(hits, 0, n)
  if (k === 0) return Array(n).fill(false)
  // Pair off the hits with the rests, then the remainders with what was
  // paired, until one or none is left over: the groups are the rhythm.
  let a: boolean[][] = Array.from({ length: k }, () => [true])
  let b: boolean[][] = Array.from({ length: n - k }, () => [false])
  while (b.length > 1) {
    const pairs = Math.min(a.length, b.length)
    const joined = a.slice(0, pairs).map((g, i) => [...g, ...b[i]])
    const rest = a.length > pairs ? a.slice(pairs) : b.slice(pairs)
    a = joined
    b = rest
  }
  return [...a, ...b].flat()
}

/** A rhythm turned later by `by` steps, round the end: x..x..x. by one is .x..x..x */
export function rotate<T>(pattern: readonly T[], by: number): T[] {
  const n = pattern.length
  if (n === 0) return []
  const r = ((Math.round(by) % n) + n) % n
  return pattern.map((_, i) => pattern[(i - r + n) % n])
}

/** A rhythm as it is written down: x for a hit, a dot for a rest. */
export const notation = (pattern: readonly boolean[]) => pattern.map((h) => (h ? 'x' : '.')).join('')

/** One drum's part: which pad, and the rhythm it plays. */
export interface Lane {
  /** The roll's row for the pad: see `kitRow`. */
  row: number
  steps: number
  hits: number
  rotate: number
  /** How many of the hits are accented, spread evenly among them the same way the hits are. */
  accents: number
  /** 0..1: how likely an unaccented hit is to be written. Accented hits always are. */
  probability: number
  /**
   * The lane's steps spread evenly over a bar rather than one to a grid
   * step: five steps in a bar of 4/4 is five against four.
   */
  fit?: boolean
  /** Left out of what is written, and kept for later. */
  mute?: boolean
}

/** What a lane plays in one cycle: a hit or a rest on each step, and which hits are accented. */
export function laneSteps(lane: Pick<Lane, 'steps' | 'hits' | 'rotate' | 'accents'>): { hit: boolean; accent: boolean }[] {
  const base = euclid(lane.hits, lane.steps)
  const hitCount = base.filter(Boolean).length
  const accents = euclid(Math.min(lane.accents, hitCount), Math.max(1, hitCount))
  let h = 0
  const marked = base.map((hit) => ({ hit, accent: hit && accents[h++] === true }))
  return rotate(marked, lane.rotate)
}

/** One hit of a written rhythm, on a row, in ticks from the start of the pattern. */
export interface RhythmHit {
  row: number
  tick: number
  length: number
  velocity: number
}

export interface RhythmSpec {
  lanes: readonly Lane[]
  /** A grid step, in ticks: a sixteenth is `PPQ / 4`. */
  step: number
  /** A bar, in ticks, for the lanes fitted to one. */
  bar: number
  /** How long to fill, in ticks: the pattern's length. Every lane goes round again until it is full. */
  length: number
  /** Velocity of a plain hit and an accented one, 0..1. */
  velocity: number
  accent: number
  /** Which roll of the dice decides the hits left to chance. The same seed is the same rhythm. */
  seed: number
}

/**
 * Every lane written out over the length, cycle after cycle. A hit is half
 * a step long -- a drum's note is a trigger, and half a step keeps one
 * visible in the roll without running into the next.
 *
 * Each lane rolls its own dice, so changing one lane's chance leaves the
 * others' hits where they were.
 */
export function rhythmNotes(spec: RhythmSpec): RhythmHit[] {
  const out: RhythmHit[] = []
  spec.lanes.forEach((lane, index) => {
    if (lane.mute) return
    const cycle = laneSteps(lane)
    const n = cycle.length
    const stepTicks = lane.fit ? spec.bar / n : spec.step
    if (!(stepTicks > 0)) return
    const rng = mulberry32((Math.imul(spec.seed >>> 0, 2654435761) ^ (index + 1) * 40503) >>> 0)
    const chance = Math.min(1, Math.max(0, lane.probability))
    const length = Math.max(1, Math.round(stepTicks / 2))
    for (let i = 0; ; i++) {
      const tick = Math.round(i * stepTicks)
      if (tick >= spec.length) break
      const s = cycle[i % n]
      // Drawn for every hit, kept or not, so the dice land the same on the
      // hits after a change of chance.
      const roll = s.hit ? rng() : 1
      if (!s.hit || (!s.accent && roll >= chance)) continue
      out.push({ row: lane.row, tick, length: Math.min(length, spec.length - tick), velocity: s.accent ? spec.accent : spec.velocity })
    }
  })
  return out.sort((a, b) => a.tick - b.tick || a.row - b.row)
}

function clampInt(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo
}

/**
 * Grooves to start from. Lanes name the General MIDI note the pad is
 * usually on, and land on whichever pad of the kit is on it -- or, in a kit
 * laid out some other way, on the pad nearest in the list.
 */
export interface RhythmPreset {
  id: string
  name: string
  description: string
  /** Grid step as a share of a quarter note: 4 is sixteenths. */
  perBeat: number
  lanes: (Omit<Lane, 'row' | 'probability' | 'accents'> & { note: number; probability?: number; accents?: number })[]
}

export const RHYTHM_PRESETS: readonly RhythmPreset[] = [
  {
    id: 'four',
    name: 'Four on the floor',
    description: 'Kick on every beat, clap on two and four, hats between',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 4, hits: 1, rotate: 0 },
      { note: 39, steps: 8, hits: 1, rotate: 4 },
      { note: 42, steps: 4, hits: 1, rotate: 2 },
    ],
  },
  {
    id: 'tresillo',
    name: 'Tresillo',
    description: 'Three in eight: the 3-3-2 under reggaeton, dancehall and half of pop',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 8, hits: 3, rotate: 0 },
      { note: 38, steps: 16, hits: 2, rotate: 4 },
      { note: 42, steps: 16, hits: 16, rotate: 0, accents: 4, probability: 0.75 },
    ],
  },
  {
    id: 'cinquillo',
    name: 'Cinquillo',
    description: 'Five in eight, the Cuban cell, over a steady kick',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 4, hits: 1, rotate: 0 },
      { note: 37, steps: 8, hits: 5, rotate: 0 },
      { note: 42, steps: 8, hits: 4, rotate: 1 },
    ],
  },
  {
    id: 'bossa',
    name: 'Bossa nova',
    description: 'Five in sixteen on the rim, the kick in dotted pairs',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 8, hits: 3, rotate: 0 },
      { note: 37, steps: 16, hits: 5, rotate: 0 },
      { note: 70, steps: 16, hits: 16, rotate: 0, accents: 4 },
    ],
  },
  {
    id: 'three-four',
    name: 'Three against four',
    description: 'Four kicks and three cowbells in the same bar',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 4, hits: 4, rotate: 0, fit: true },
      { note: 56, steps: 3, hits: 3, rotate: 0, fit: true },
      { note: 42, steps: 16, hits: 8, rotate: 1, probability: 0.85 },
    ],
  },
  {
    id: 'polymeter',
    name: 'Drifting',
    description: 'Lanes of five, seven and sixteen steps going in and out of phase',
    perBeat: 4,
    lanes: [
      { note: 36, steps: 16, hits: 4, rotate: 0 },
      { note: 63, steps: 5, hits: 2, rotate: 0 },
      { note: 75, steps: 7, hits: 3, rotate: 0 },
      { note: 42, steps: 16, hits: 11, rotate: 0, accents: 3, probability: 0.7 },
    ],
  },
]
