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
import { PPQ } from '../song/types'

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
  /**
   * The steps written out, for a lane that is not Euclidean: `X` an accented
   * hit, `x` a hit, `g` a ghost note, `.` a rest. When it is here it is the
   * rhythm, and Steps, Hits and Accent are read from it; Rotate still turns
   * it.
   */
  pattern?: string
  /** Steps to a quarter note, when this lane's grid is not the rhythm's own. */
  perBeat?: number
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

/** One step of a lane: a rest, or a hit that may be accented or a ghost. */
export interface LaneStep {
  hit: boolean
  accent: boolean
  ghost?: boolean
}

/** A written-out pattern as steps. Anything but `X`, `x` and `g` is a rest. */
export function parsePattern(pattern: string): LaneStep[] {
  return [...pattern.slice(0, MAX_STEPS)].map((c) => ({ hit: c === 'X' || c === 'x' || c === 'g', accent: c === 'X', ...(c === 'g' ? { ghost: true } : {}) }))
}

/** Steps back to the pattern they were read from. */
export const patternOf = (steps: readonly LaneStep[]) =>
  steps.map((s) => (!s.hit ? '.' : s.accent ? 'X' : s.ghost ? 'g' : 'x')).join('')

/** What a lane plays in one cycle: a hit or a rest on each step, and which hits are accented. */
export function laneSteps(lane: Pick<Lane, 'steps' | 'hits' | 'rotate' | 'accents' | 'pattern'>): LaneStep[] {
  if (lane.pattern) return rotate(parsePattern(lane.pattern), lane.rotate)
  const base = euclid(lane.hits, lane.steps)
  const hitCount = base.filter(Boolean).length
  const accents = euclid(Math.min(lane.accents, hitCount), Math.max(1, hitCount))
  let h = 0
  const marked = base.map((hit) => ({ hit, accent: hit && accents[h++] === true }))
  return rotate(marked, lane.rotate)
}

/**
 * The Euclidean rhythm a pattern is, if it is one: so many hits in so many
 * steps and the rotation that turns E(k,n) into it -- the smallest, when a
 * symmetrical rhythm has several. Null for one that is not, as son clave is
 * not. Accents and ghosts are hits like any other here.
 */
export function euclidOf(steps: readonly boolean[]): { hits: number; steps: number; rotate: number } | null {
  const n = steps.length
  if (n < 1 || n > MAX_STEPS) return null
  const k = steps.filter(Boolean).length
  if (k === 0 || k === n) return null
  const base = euclid(k, n)
  for (let r = 0; r < n; r++) {
    const turned = rotate(base, r)
    if (turned.every((h, i) => h === steps[i])) return { hits: k, steps: n, rotate: r }
  }
  return null
}

/**
 * The Euclidean rhythm nearest a pattern: as many hits in as many steps, at
 * whichever rotation shares the most of them with it, the earliest of equals.
 */
export function nearestEuclid(steps: readonly boolean[]): { hits: number; steps: number; rotate: number } {
  const n = Math.max(1, Math.min(MAX_STEPS, steps.length))
  const k = steps.slice(0, n).filter(Boolean).length
  const base = euclid(k, n)
  let best = 0
  let shared = -1
  for (let r = 0; r < n; r++) {
    const turned = rotate(base, r)
    const same = turned.filter((h, i) => h && steps[i]).length
    if (same > shared) {
      shared = same
      best = r
    }
  }
  return { hits: k, steps: n, rotate: best }
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
  /** Velocity of a ghost note; half a plain hit's when absent. */
  ghost?: number
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
    if (n === 0) return
    const stepTicks = lane.fit ? spec.bar / n : lane.perBeat ? PPQ / lane.perBeat : spec.step
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
      const velocity = s.accent ? spec.accent : s.ghost ? (spec.ghost ?? spec.velocity / 2) : spec.velocity
      out.push({ row: lane.row, tick, length: Math.min(length, spec.length - tick), velocity })
    }
  })
  return out.sort((a, b) => a.tick - b.tick || a.row - b.row)
}

function clampInt(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo
}
