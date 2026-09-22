import type { Cable, Patch } from '../patch/types'
import { jackKey } from './Jack'

export interface Point {
  x: number
  y: number
}

export type JackGeometry = Record<string, Point>

/** Control points for the hanging curve between two jacks. */
export function controlsOf(a: Point, b: Point): [Point, Point] {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  // Enough slack to read as a cable, capped so long runs do not swing off the
  // bottom of the rack.
  const sag = Math.min(90, 24 + dist * 0.3)
  return [
    { x: a.x, y: a.y + sag },
    { x: b.x, y: b.y + sag },
  ]
}

export function cablePath(a: Point, b: Point) {
  const [c1, c2] = controlsOf(a, b)
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`
}

export function cubicAt(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const mt = 1 - t
  const w0 = mt * mt * mt
  const w1 = 3 * mt * mt * t
  const w2 = 3 * mt * t * t
  const w3 = t * t * t
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
  }
}

/** How close the pointer must come to a cable to grab it. */
const GRAB_RADIUS = 9
/**
 * Curve ends are skipped so that grabbing a cable near a jack is never
 * ambiguous with grabbing the jack itself.
 */
const SKIP_ENDS = 0.16
/** Roughly how far apart to place samples along the curve, in pixels. */
const SAMPLE_SPACING = 10
const MIN_SAMPLES = 16
const MAX_SAMPLES = 72

/** Perpendicular distance from a point to a line segment. */
function pointToSegment(p: Point, s0: Point, s1: Point) {
  const dx = s1.x - s0.x
  const dy = s1.y - s0.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - s0.x, p.y - s0.y)
  let t = ((p.x - s0.x) * dx + (p.y - s0.y) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p.x - (s0.x + t * dx), p.y - (s0.y + t * dy))
}

/**
 * Distance from a point to the cable's curve.
 *
 * Measured against the segments between samples rather than the samples
 * themselves. Sampling points alone leaves gaps of half the sample spacing, so
 * on a long cable -- where uniform steps in t are far apart in pixels -- the
 * pointer can sit exactly on the curve and still miss every sample.
 */
function distanceToCable(a: Point, b: Point, p: Point) {
  const [c1, c2] = controlsOf(a, b)
  const chord = Math.hypot(b.x - a.x, b.y - a.y)
  const samples = Math.min(
    MAX_SAMPLES,
    Math.max(MIN_SAMPLES, Math.round(chord / SAMPLE_SPACING)),
  )

  let best = Infinity
  let prev = cubicAt(a, c1, c2, b, SKIP_ENDS)
  for (let i = 1; i <= samples; i++) {
    const t = SKIP_ENDS + ((1 - 2 * SKIP_ENDS) * i) / samples
    const s = cubicAt(a, c1, c2, b, t)
    const d = pointToSegment(p, prev, s)
    if (d < best) best = d
    prev = s
  }
  return best
}

/**
 * The cable nearest the pointer, if one is within grabbing distance.
 *
 * Cables are hit-tested here rather than through SVG hit areas. An invisible
 * stroke wide enough to grab reliably also covers any jack the cable happens
 * to cross, and because the cable layer paints above the panels, that jack
 * becomes unusable -- a pointer down on it would unplug an unrelated cable
 * instead of starting a patch. Testing in code lets the jack always win.
 */
export function nearestCable(
  patch: Patch,
  geometry: JackGeometry,
  point: Point,
): Cable | undefined {
  let best: Cable | undefined
  let bestDist = GRAB_RADIUS

  for (const c of patch.cables) {
    const a = geometry[jackKey(c.from)]
    const b = geometry[jackKey(c.to)]
    if (!a || !b) continue
    const d = distanceToCable(a, b, point)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}
