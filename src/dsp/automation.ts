/**
 * The arithmetic of an automation curve, shared by everything that has to
 * agree on it: the audio thread working out a knob's value as it plays, the
 * scheduler working out where a curve stands at the start of a window, and
 * the roll drawing it. Nothing here knows what a pattern or a frame is; a
 * curve runs from `from` to `to` in whatever the caller counts in.
 */

/** One stretch of a lane: from one point to the next, with how it gets there. */
export interface Curve {
  from: number
  to: number
  /** Positions 0..1 at either end. */
  v0: number
  v1: number
  shape: 'linear' | 'hold' | 'curve'
  /** -1..1; only a curve reads it. */
  tension: number
}

/**
 * How a position along a knob's travel becomes the value the module reads:
 * a straight line, an exponential one (cutoff, time), whole steps (a
 * switch), or a mixing desk's fader, in dB down to silence.
 */
export interface ValueMap {
  kind: 'lin' | 'exp' | 'step' | 'fader'
  min: number
  max: number
}

/** The fader's travel, in dB: the same as the Mix view's. */
export const FADER_MIN_DB = -60
export const FADER_MAX_DB = 6

/**
 * How far from the first value to the second, at `u` of the way along: the
 * shape between two points. A curve is a power of the way along, so tension
 * bends it without ever overshooting either end -- 1 is four times as slow to
 * start, -1 four times as quick.
 */
export function shapeAt(shape: Curve['shape'], tension: number, u: number): number {
  if (!(u > 0)) return 0
  if (u >= 1) return shape === 'hold' ? 0 : 1
  if (shape === 'hold') return 0
  if (shape === 'curve' && tension !== 0) return Math.pow(u, Math.pow(4, tension))
  return u
}

/** The position a curve stands at, at `x`. Held at its ends outside them. */
export function curveAt(c: Curve, x: number): number {
  if (c.shape === 'hold') return x >= c.to ? c.v1 : c.v0
  const span = c.to - c.from
  if (!(span > 0) || x >= c.to) return x >= c.to ? c.v1 : c.v0
  if (x <= c.from) return c.v0
  return c.v0 + (c.v1 - c.v0) * shapeAt(c.shape, c.tension, (x - c.from) / span)
}

/** A value as the position along a knob's travel that reads it: `mapValue` backwards. */
export function unmapValue(m: ValueMap, v: number): number {
  let t: number
  switch (m.kind) {
    case 'exp':
      t = m.min > 0 && m.max > 0 && v > 0 ? Math.log(v / m.min) / Math.log(m.max / m.min) : (v - m.min) / (m.max - m.min)
      break
    case 'fader':
      t = v <= 0 ? 0 : (20 * Math.log10(v) - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB)
      break
    default:
      t = (v - m.min) / (m.max - m.min)
  }
  return Number.isFinite(t) ? (t < 0 ? 0 : t > 1 ? 1 : t) : 0
}

/** A position along a knob's travel as the value it reads. */
export function mapValue(m: ValueMap, t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  switch (m.kind) {
    case 'exp':
      return m.min > 0 && m.max > 0 ? m.min * Math.pow(m.max / m.min, c) : m.min + (m.max - m.min) * c
    case 'step':
      return Math.round(m.min + (m.max - m.min) * c)
    case 'fader': {
      const db = FADER_MIN_DB + c * (FADER_MAX_DB - FADER_MIN_DB)
      return db <= FADER_MIN_DB ? 0 : Math.pow(10, db / 20)
    }
    default:
      return m.min + (m.max - m.min) * c
  }
}
