import { barTicks, beatTicks, PPQ, type Meter, type MeterChange, type Song, type TempoChange } from './types'

/**
 * Time, read off a song: which sample a tick is heard on, and which bar and
 * beat it falls in.
 *
 * Both questions used to be one multiplication, because a song had one tempo
 * and one time signature. Now either can change part way through, and every
 * place that asked -- the scheduler, the playhead, a bounce's length, a
 * game's "on the next bar", the playlist's barlines -- asks here instead, so
 * that none of them can come to a different answer from the rest.
 *
 * Pure, like the rest of this layer, and cached against the arrays it is
 * built from: the transport asks thirty times a second, and a song whose
 * tempo has not changed hands back the same map it did last time.
 */

// --- tempo ------------------------------------------------------------

/**
 * Ticks and samples, either way round.
 *
 * Frames are counted from tick zero and never rounded here: rounding is the
 * last thing done to an event, once, so a note lands on the same sample live
 * as in a bounce whichever window it happened to be scheduled in.
 */
export interface TempoMap {
  /** The frame a tick is heard on. Before zero, the opening tempo carries on backwards. */
  frameAt(tick: number): number
  /** The tick heard on a frame. */
  tickAt(frame: number): number
  /**
   * Frames from one tick to another -- negative when `to` is earlier.
   * Inside one tempo it is exactly `(to - from) * framesPerTick`, the sum
   * this was before tempo could change, so a song that never changes tempo
   * comes out on the same samples to the last bit.
   */
  span(from: number, to: number): number
  /** The tick reached `frames` after `tick`. The same exactness as `span`. */
  advance(tick: number, frames: number): number
  /** How many frames a tick lasts, at a tick. */
  rateAt(tick: number): number
}

interface TempoSegment {
  tick: number
  /** The frame the segment starts on. */
  frame: number
  /** Frames per tick through it. */
  fpt: number
}

/** How many samples a tick lasts at a tempo. Fractional, on purpose. */
export function framesPerTick(tempo: number, sampleRate: number): number {
  return (60 / tempo) * (sampleRate / PPQ)
}

type TempoSource = Pick<Song, 'tempo' | 'tempos'>

/** The key `tempoMap` caches under for a song with no changes. */
const NO_TEMPOS: TempoChange[] = []
const tempoCache = new WeakMap<readonly TempoChange[], Map<string, TempoMap>>()

export function tempoMap(song: TempoSource, sampleRate: number): TempoMap {
  const changes = song.tempos ?? NO_TEMPOS
  let byRate = tempoCache.get(changes)
  if (!byRate) tempoCache.set(changes, (byRate = new Map()))
  const key = `${song.tempo}@${sampleRate}`
  let map = byRate.get(key)
  if (!map) {
    map = buildTempoMap(song.tempo, changes, sampleRate)
    // A handful of keys per array at most -- an edit to the opening tempo
    // makes a new one -- but a long drag of the tempo field steps through
    // hundreds, and none of those is ever asked for again.
    if (byRate.size > 16) byRate.clear()
    byRate.set(key, map)
  }
  return map
}

function buildTempoMap(tempo: number, changes: readonly TempoChange[], sampleRate: number): TempoMap {
  const segs: TempoSegment[] = [{ tick: 0, frame: 0, fpt: framesPerTick(tempo, sampleRate) }]
  for (const c of changes) {
    const last = segs[segs.length - 1]
    if (!(c.tick > last.tick)) continue
    segs.push({ tick: c.tick, frame: last.frame + (c.tick - last.tick) * last.fpt, fpt: framesPerTick(c.bpm, sampleRate) })
  }

  const byTick = (tick: number) => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].tick <= tick) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const byFrame = (frame: number) => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].frame <= frame) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const frameAt = (tick: number) => {
    const s = segs[byTick(tick)]
    return s.frame + (tick - s.tick) * s.fpt
  }
  const tickAt = (frame: number) => {
    const s = segs[byFrame(frame)]
    return s.tick + (frame - s.frame) / s.fpt
  }

  if (segs.length === 1) {
    // The song every song was before this: one straight line, and the same
    // arithmetic it always used.
    const fpt = segs[0].fpt
    return {
      frameAt: (tick) => tick * fpt,
      tickAt: (frame) => frame / fpt,
      span: (from, to) => (to - from) * fpt,
      advance: (tick, frames) => tick + frames / fpt,
      rateAt: () => fpt,
    }
  }

  return {
    frameAt,
    tickAt,
    span(from, to) {
      const i = byTick(from)
      return i === byTick(to) ? (to - from) * segs[i].fpt : frameAt(to) - frameAt(from)
    },
    advance(tick, frames) {
      const i = byTick(tick)
      const target = frameAt(tick) + frames
      return byFrame(target) === i ? tick + frames / segs[i].fpt : tickAt(target)
    },
    rateAt: (tick) => segs[byTick(tick)].fpt,
  }
}

/** The tempo heard at a tick. */
export function tempoAt(song: TempoSource, tick: number): number {
  let bpm = song.tempo
  for (const c of song.tempos ?? []) {
    if (c.tick > tick) break
    bpm = c.bpm
  }
  return bpm
}

/** Seconds from the start of the song to a tick. */
export function secondsAt(song: TempoSource, tick: number): number {
  return tempoMap(song, 1).frameAt(tick)
}

// --- bars -------------------------------------------------------------

/** One bar of the song. */
export interface Bar {
  /** From 0 at the start of the song. What is shown is one more. */
  index: number
  tick: number
  /** Ticks, cut short where a change of meter comes before it is full. */
  length: number
  meter: Meter
  /** Ticks in one of its beats. */
  beat: number
}

/**
 * The song's bars, however its meter changes. Before tick zero the first
 * meter carries on backwards, so nothing asking about a moment before the
 * start is given nonsense.
 */
export interface Bars {
  /** The bar a tick falls in. */
  at(tick: number): Bar
  /** A bar by its index. */
  bar(index: number): Bar
  /** Every bar that has any of `[from, to)` in it, in order. */
  between(from: number, to: number): Bar[]
  /** The meter at a tick. */
  meterAt(tick: number): Meter
  /** A tick onto a barline: the one before it, the one after, or the nearer. */
  snapBar(tick: number, how?: Snap): number
  /**
   * A tick onto a step counted from the start of the bar it is in -- a beat,
   * or part of one -- and never past that bar's end, so a step that does not
   * divide a short bar still lands on the barline after it.
   */
  snapIn(tick: number, step: number, how?: Snap): number
  /** Where each meter starts, earliest first; the first is always at zero. */
  readonly segments: readonly MeterSegment[]
}

export type Snap = 'round' | 'floor' | 'ceil'

export interface MeterSegment {
  tick: number
  meter: Meter
  /** The index of its first bar. */
  first: number
  /** Where the next begins, or Infinity. */
  end: number
}

type MeterSource = { meter?: Meter; meters?: readonly MeterChange[] }

const FOUR_FOUR: Meter = { beats: 4, unit: 4 }
const NO_METERS: MeterChange[] = []
const barsCache = new WeakMap<readonly MeterChange[], Map<string, Bars>>()

export function barsOf(song: MeterSource): Bars {
  const changes = song.meters ?? NO_METERS
  let byMeter = barsCache.get(changes)
  if (!byMeter) barsCache.set(changes, (byMeter = new Map()))
  const m = song.meter ?? FOUR_FOUR
  const key = `${m.beats}/${m.unit}`
  let bars = byMeter.get(key)
  if (!bars) byMeter.set(key, (bars = buildBars(m, changes)))
  return bars
}

function buildBars(opening: Meter, changes: readonly MeterChange[]): Bars {
  const segs: (MeterSegment & { len: number; beat: number })[] = []
  const push = (tick: number, meter: Meter) => {
    const prev = segs[segs.length - 1]
    let first = 0
    if (prev) {
      prev.end = tick
      first = prev.first + Math.ceil((tick - prev.tick) / prev.len)
    }
    segs.push({ tick, meter, first, end: Infinity, len: barTicks({ meter }), beat: beatTicks({ meter }) })
  }
  push(0, opening)
  for (const c of changes) if (c.tick > segs[segs.length - 1].tick) push(c.tick, c.meter)

  const segAtTick = (tick: number) => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].tick <= tick) lo = mid
      else hi = mid - 1
    }
    return segs[lo]
  }
  const segAtIndex = (index: number) => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].first <= index) lo = mid
      else hi = mid - 1
    }
    return segs[lo]
  }
  const make = (s: (typeof segs)[number], k: number): Bar => {
    const tick = s.tick + k * s.len
    return { index: s.first + k, tick, length: Math.min(s.len, s.end - tick), meter: s.meter, beat: s.beat }
  }
  const at = (tick: number) => {
    const s = segAtTick(tick)
    return make(s, Math.floor((tick - s.tick) / s.len))
  }
  const bar = (index: number) => {
    const s = segAtIndex(index)
    return make(s, index - s.first)
  }
  const pick = (tick: number, lo: number, hi: number, how: Snap) =>
    how === 'floor' ? lo : how === 'ceil' ? (tick > lo ? hi : lo) : tick - lo < hi - tick ? lo : hi

  return {
    at,
    bar,
    between(from, to) {
      const out: Bar[] = []
      if (!(to > from)) return out
      // However the bars are cut, no playlist is a million bars long.
      for (let b = at(from); b.tick < to && out.length < 1e6; b = bar(b.index + 1)) out.push(b)
      return out
    },
    meterAt: (tick) => segAtTick(tick).meter,
    snapBar(tick, how = 'round') {
      const b = at(tick)
      return pick(tick, b.tick, b.tick + b.length, how)
    },
    snapIn(tick, step, how = 'round') {
      const b = at(tick)
      const end = b.tick + b.length
      if (!(step > 0)) return tick
      const into = tick - b.tick
      const lo = b.tick + Math.floor(into / step) * step
      const hi = Math.min(lo + step, end)
      return Math.min(pick(tick, lo, hi, how), end)
    },
    segments: segs.map(({ tick, meter, first, end }) => ({ tick, meter, first, end })),
  }
}

/** The meter heard at a tick. */
export function meterAt(song: MeterSource, tick: number): Meter {
  return barsOf(song).meterAt(tick)
}

/**
 * The bars a pattern is written in: the song's, from where the pattern first
 * sits, with that tick as the pattern's own zero -- so a pattern placed in
 * the 7/8 bridge is ruled in 7/8 in the roll, and one placed across a change
 * shows the change where it falls. A pattern not in the song yet is ruled in
 * the song's opening meter.
 *
 * Whatever the song's barlines, the pattern's first bar starts on its first
 * tick: that is where the roll's bar 1 is.
 */
export function patternBars(song: MeterSource, placedAt: number | null): Bars {
  if (placedAt === null || placedAt <= 0) return barsOf(song)
  const song0 = barsOf(song)
  const meters = (song.meters ?? []).filter((c) => c.tick > placedAt).map((c) => ({ tick: c.tick - placedAt, meter: c.meter }))
  return barsOf({ meter: song0.meterAt(placedAt), meters })
}

/** How many whole or part bars `ticks` from the start reach into. */
export function barsIn(bars: Bars, ticks: number): number {
  return ticks > 0 ? bars.at(ticks - 1).index + 1 : 0
}

export const sameMeter = (a: Meter, b: Meter) => a.beats === b.beats && a.unit === b.unit
