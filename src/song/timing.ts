import { sameMeter } from './timeline'
import { TEMPO_MAX, TEMPO_MIN, validMeter, type Meter, type MeterChange, type Song, type TempoChange } from './types'

/**
 * Editing the song's tempo and time signature as they change along it.
 *
 * Both are kept the same way -- a value at the start, and a list of changes
 * after it -- so both are edited by the same handful of functions here, told
 * which of the two they are working on. Every one hands back a song in the
 * form `cleanTimings` leaves it in, which is the only form the rest of the
 * code has to understand.
 *
 * A change is named by its tick, as a section is: two never share one.
 */

type Timing = Pick<Song, 'tempo' | 'tempos' | 'meter' | 'meters'>

interface Kind<V, C extends { tick: number }> {
  open(s: Timing): V
  list(s: Timing): readonly C[]
  value(c: C): V
  make(tick: number, value: V): C
  same(a: V, b: V): boolean
  /** The value as it may be kept, or null for one that cannot be. */
  valid(v: V): V | null
  with<S extends Timing>(s: S, open: V, list: C[]): S
}

const FOUR_FOUR: Meter = { beats: 4, unit: 4 }

export const TEMPO: Kind<number, TempoChange> = {
  open: (s) => s.tempo,
  list: (s) => s.tempos ?? [],
  value: (c) => c.bpm,
  make: (tick, bpm) => ({ tick, bpm }),
  same: (a, b) => a === b,
  valid: (v) => (Number.isFinite(v) ? Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, v)) : null),
  with(s, open, list) {
    const { tempos: _, ...rest } = s
    return (list.length ? { ...rest, tempo: open, tempos: list } : { ...rest, tempo: open }) as typeof s
  },
}

export const METER: Kind<Meter, MeterChange> = {
  open: (s) => s.meter ?? FOUR_FOUR,
  list: (s) => s.meters ?? [],
  value: (c) => c.meter,
  make: (tick, meter) => ({ tick, meter }),
  same: sameMeter,
  valid: (m) => validMeter(m.beats, m.unit),
  with(s, open, list) {
    const { meters: _, meter: __, ...rest } = s
    const out: Timing = { ...rest }
    if (!sameMeter(open, FOUR_FOUR)) out.meter = open
    if (list.length) out.meters = list
    return out as typeof s
  },
}

/** The value in force at a tick: the last change at or before it, or the opening one. */
export function valueAt<V, C extends { tick: number }>(kind: Kind<V, C>, s: Timing, tick: number): V {
  let v = kind.open(s)
  for (const c of kind.list(s)) {
    if (c.tick > tick) break
    v = kind.value(c)
  }
  return v
}

/**
 * The changes as they are kept: whole ticks, in order, each a value that can
 * be, one to a tick -- the later of two, as a MIDI file means it -- and none
 * that changes nothing. A change at or before the start is the opening value.
 * The song back as it was, the same object, when all that already held.
 */
function clean<V, C extends { tick: number }, S extends Timing>(kind: Kind<V, C>, s: S): S {
  const raw = kind.list(s)
  // The opening value is the file reader's to hold to its range, as it
  // always has been; only a change arriving on top of it replaces it here.
  let open = kind.open(s)
  const byTick = new Map<number, V>()
  const sorted = raw
    .map((c, i) => ({ c, i, tick: Number.isFinite(c.tick) ? Math.round(c.tick) : NaN }))
    .filter((x) => !Number.isNaN(x.tick))
    .sort((a, b) => a.tick - b.tick || a.i - b.i)
  for (const { c, tick } of sorted) {
    const v = kind.valid(kind.value(c))
    if (v === null) continue
    if (tick <= 0) open = v
    else byTick.set(tick, v)
  }
  const list: C[] = []
  let last = open
  for (const [tick, v] of byTick) {
    if (kind.same(v, last)) continue
    list.push(kind.make(tick, v))
    last = v
  }
  const unchanged =
    kind.same(open, kind.open(s)) &&
    list.length === raw.length &&
    list.every((c, i) => c.tick === raw[i].tick && kind.same(kind.value(c), kind.value(raw[i])))
  return unchanged ? s : kind.with(s, open, list)
}

/** Both lists in the form they are kept in. See `clean`. */
export function cleanTimings<S extends Timing>(s: S): S {
  return clean(METER, clean(TEMPO, s))
}

/** A value from a tick on: a new change there, or a new value for the one already there. At zero, the opening value. */
export function setAt<V, C extends { tick: number }, S extends Timing>(kind: Kind<V, C>, s: S, tick: number, value: V): S {
  const t = Math.round(tick)
  const v = kind.valid(value)
  if (v === null || !Number.isFinite(t)) return s
  // Already so, from there on: the song as it was, and no step of undo that
  // changes nothing.
  if (kind.same(valueAt(kind, s, Math.max(0, t)), v)) return s
  // The list as it was, the same array, so nothing watching it for a
  // change of tempo along the way sees one that is not there.
  if (t <= 0) return clean(kind, kind.with(s, v, kind.list(s) as C[]))
  const list = kind.list(s).filter((c) => c.tick !== t)
  return clean(kind, kind.with(s, kind.open(s), [...list, kind.make(t, v)]))
}

/** The change at a tick taken away. The opening value is not a change and cannot be. */
export function removeAt<V, C extends { tick: number }, S extends Timing>(kind: Kind<V, C>, s: S, tick: number): S {
  const list = kind.list(s)
  if (!(tick > 0) || !list.some((c) => c.tick === tick)) return s
  return clean(kind, kind.with(s, kind.open(s), list.filter((c) => c.tick !== tick)))
}

/**
 * Every change in `[from, to)` taken away: a ramp brought in as a hundred
 * small steps, cleared in one go. The opening value stays.
 */
export function removeBetween<V, C extends { tick: number }, S extends Timing>(kind: Kind<V, C>, s: S, from: number, to: number): S {
  const list = kind.list(s)
  const kept = list.filter((c) => c.tick < from || c.tick >= to)
  if (kept.length === list.length) return s
  return clean(kind, kind.with(s, kind.open(s), kept))
}

/**
 * The change at `from` moved to `to`, replacing any already there. Never to
 * the start or before it: that is the opening value, which is changed and
 * not moved onto.
 */
export function moveAt<V, C extends { tick: number }, S extends Timing>(kind: Kind<V, C>, s: S, from: number, to: number): S {
  const t = Math.round(to)
  const c = kind.list(s).find((x) => x.tick === from)
  if (!c || !(t > 0) || t === from) return s
  return setAt(kind, removeAt(kind, s, from), t, kind.value(c))
}

// --- the song's own time, opened up and closed ----------------------------

/**
 * Time put in at a tick: every change from there on moves later with the
 * music after it, and the new stretch carries on at whatever was in force
 * just before it.
 */
export function insertTimings<S extends Timing>(s: S, at: number, length: number): S {
  const shift = <V, C extends { tick: number }>(kind: Kind<V, C>, x: S): S =>
    kind.with(
      x,
      kind.open(x),
      kind.list(x).map((c) => (c.tick >= at ? kind.make(c.tick + length, kind.value(c)) : c)),
    )
  return cleanTimings(shift(METER, shift(TEMPO, s)))
}

/**
 * The time from `from` to `to` taken out, and what follows moved back. The
 * changes inside go with it, and whatever was in force at `to` is still in
 * force from `from`, where that music now starts.
 */
export function deleteTimings<S extends Timing>(s: S, from: number, to: number): S {
  const len = to - from
  const cut = <V, C extends { tick: number }>(kind: Kind<V, C>, x: S): S => {
    const after = valueAt(kind, x, to)
    const list = kind.list(x).flatMap((c) =>
      c.tick < from ? [c] : c.tick >= to ? [kind.make(c.tick - len, kind.value(c))] : [],
    )
    const out = kind.with(x, kind.open(x), list)
    return kind.same(valueAt(kind, out, from), after) ? out : setAt(kind, out, from, after)
  }
  return cleanTimings(cut(METER, cut(TEMPO, s)))
}

/** The tempo and meter over a stretch of the song, for pasting with its music. */
export interface TimingClip {
  tempo: number
  tempos: TempoChange[]
  meter: Meter
  meters: MeterChange[]
}

/** What is in force over `[from, to)`: the values at `from`, and the changes after it, from `from` as zero. */
export function copyTimings(s: Timing, from: number, to: number): TimingClip {
  const inside = <C extends { tick: number }>(list: readonly C[], make: (c: C, tick: number) => C) =>
    list.filter((c) => c.tick > from && c.tick < to).map((c) => make(c, c.tick - from))
  return {
    tempo: valueAt(TEMPO, s, from),
    tempos: inside(TEMPO.list(s), (c, tick) => ({ ...c, tick })),
    meter: valueAt(METER, s, from),
    meters: inside(METER.list(s), (c, tick) => ({ ...c, tick })),
  }
}

/**
 * A copied stretch's tempo and meter, into `length` ticks of room already
 * opened at `at` (see `insertTimings`). The stretch plays at what it was
 * copied at, and after it the song goes back to what was in force there
 * before.
 */
export function pasteTimings<S extends Timing>(s: S, at: number, length: number, clip: TimingClip): S {
  const end = at + length
  const put = <V, C extends { tick: number }>(kind: Kind<V, C>, x: S, open: V, inner: readonly C[]): S => {
    const resume = valueAt(kind, x, end)
    const kept = kind.list(x).filter((c) => c.tick < at || c.tick >= end)
    let out = kind.with(x, kind.open(x), kept)
    const hasEnd = kept.some((c) => c.tick === end)
    out = setAt(kind, out, at, open)
    for (const c of inner) out = setAt(kind, out, c.tick + at, kind.value(c))
    if (!hasEnd) out = setAt(kind, out, end, resume)
    return out
  }
  return cleanTimings(put(METER, put(TEMPO, s, clip.tempo, clip.tempos), clip.meter, clip.meters))
}

/** A song with the timings of another: for an edit that works them out on the side. */
export function withTimings<S extends Timing>(s: S, from: Timing): S {
  return METER.with(TEMPO.with(s, from.tempo, [...(from.tempos ?? [])]), from.meter ?? FOUR_FOUR, [...(from.meters ?? [])])
}
