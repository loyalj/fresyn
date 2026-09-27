import { normalizeSong } from './normalize'
import { SCALES } from './scale'
import {
  DEFAULT_CONSOLE,
  DEFAULT_STRIP,
  PPQ,
  type Console,
  type Eq3,
  type Marker,
  type Note,
  type Pattern,
  type Placement,
  type Song,
  type Strip,
  type Track,
} from './types'

/**
 * Reading a song back defensively.
 *
 * The same rule the patch reader follows, and for the same reason: these
 * files get hand-edited and they outlive the build they were written by, so
 * anything unrecognised is dropped rather than allowed to throw at load. A
 * song that arrives half-legible opens missing a track; it does not take the
 * app down.
 */
export function parseSong(input: unknown): Song | null {
  if (typeof input !== 'object' || input === null) return null
  const data = input as Record<string, unknown>

  const tracks: Track[] = []
  for (const raw of asArray(data.tracks)) {
    const t = raw as Record<string, unknown>
    const id = str(t.id)
    if (!id || tracks.some((x) => x.id === id)) continue
    tracks.push({
      id,
      name: str(t.name) || id,
      patch: str(t.patch),
      gain: num(t.gain, 1, 0, 2),
      ...(t.mute === true ? { mute: true as const } : {}),
      ...(t.solo === true ? { solo: true as const } : {}),
      ...hue(t.color),
      ...stripFrom(t.strip),
    })
  }

  const known = new Set(tracks.map((t) => t.id))
  const patterns: Pattern[] = []
  for (const raw of asArray(data.patterns)) {
    const p = raw as Record<string, unknown>
    const id = str(p.id)
    if (!id || patterns.some((x) => x.id === id)) continue

    const notes: Note[] = []
    for (const rawNote of asArray(p.notes)) {
      const n = rawNote as Record<string, unknown>
      // A note for a track that is not in the file would never sound and
      // would keep being written back out. Dropped on the way in.
      if (!known.has(str(n.track))) continue
      notes.push({
        track: str(n.track),
        tick: num(n.tick, 0, 0, Number.MAX_SAFE_INTEGER),
        length: num(n.length, PPQ, 0, Number.MAX_SAFE_INTEGER),
        pitch: num(n.pitch, 0, -128, 128),
        velocity: num(n.velocity, 1, 0, 1),
      })
    }

    patterns.push({
      id,
      name: str(p.name) || id,
      length: num(p.length, PPQ * 4, 1, Number.MAX_SAFE_INTEGER),
      notes,
      ...hue(p.color),
    })
  }

  const ids = new Set(patterns.map((p) => p.id))
  const playlist: Placement[] = []
  for (const raw of asArray(data.playlist)) {
    const item = raw as Record<string, unknown>
    if (!ids.has(str(item.pattern))) continue
    playlist.push({ pattern: str(item.pattern), tick: num(item.tick, 0, 0, Number.MAX_SAFE_INTEGER) })
  }

  const song: Song = {
    tempo: num(data.tempo, 120, 20, 300),
    tracks,
    patterns,
    playlist,
  }

  const loop = data.loop
  if (typeof loop === 'object' && loop !== null) {
    const l = loop as Record<string, unknown>
    const from = num(l.from, 0, 0, Number.MAX_SAFE_INTEGER)
    const to = num(l.to, 0, 0, Number.MAX_SAFE_INTEGER)
    if (to > from) song.loop = { from, to }
  }

  // A meter is only ever a whole number of quarters or eighths, and never so
  // long a bar that the playlist could not show one.
  const meter = data.meter
  if (typeof meter === 'object' && meter !== null) {
    const m = meter as Record<string, unknown>
    const beats = Math.round(num(m.beats, 4, 1, 16))
    const unit = m.unit === 8 ? 8 : 4
    if (!(beats === 4 && unit === 4)) song.meter = { beats, unit }
  }

  const markers: Marker[] = []
  for (const raw of asArray(data.markers)) {
    const m = raw as Record<string, unknown>
    const tick = num(m.tick, -1, -1, Number.MAX_SAFE_INTEGER)
    if (tick < 0 || markers.some((x) => x.tick === tick)) continue
    markers.push({ tick, name: str(m.name) || 'Section' })
  }
  if (markers.length) song.markers = markers.sort((a, b) => a.tick - b.tick)

  const desk = consoleFrom(data.console)
  if (desk) song.console = desk

  // A scale this build does not know is dropped rather than kept: the roll
  // could neither draw it nor snap to it.
  const scale = data.scale
  if (typeof scale === 'object' && scale !== null) {
    const s = scale as Record<string, unknown>
    const mode = str(s.mode)
    if (SCALES.some((x) => x.id === mode)) {
      song.scale = {
        root: Math.round(num(s.root, 0, 0, 11)),
        mode,
        ...(s.snap === true ? { snap: true } : {}),
      }
    }
  }

  // Everything above is about reading what is there; this is about what a
  // song is allowed to be, and is the same rule an edit is held to. Last, so
  // that the check for an empty song sees what survived it.
  const normal = normalizeSong(song)
  if (normal.tracks.length === 0 || normal.patterns.length === 0) return null
  return normal
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

/** A console EQ, each band kept to what the knobs can reach. */
function eqFrom(v: unknown, fallback: Eq3): Eq3 {
  const e = obj(v)
  return {
    low: num(e.low, fallback.low, -24, 12),
    mid: num(e.mid, fallback.mid, -24, 12),
    high: num(e.high, fallback.high, -24, 12),
  }
}

/** A track's channel strip, or nothing at all for one never touched. */
function stripFrom(v: unknown): { strip?: Strip } {
  if (typeof v !== 'object' || v === null) return {}
  const s = obj(v)
  return {
    strip: {
      pan: num(s.pan, DEFAULT_STRIP.pan, -1, 1),
      eq: eqFrom(s.eq, DEFAULT_STRIP.eq),
      space: num(s.space, 0, 0, 1),
      delay: num(s.delay, 0, 0, 1),
    },
  }
}

/** The song's desk, every field clamped to its knob's range. */
function consoleFrom(v: unknown): Console | null {
  if (typeof v !== 'object' || v === null) return null
  const c = obj(v)
  const d = DEFAULT_CONSOLE
  const m = obj(c.master)
  const sp = obj(c.space)
  const dl = obj(c.delay)
  return {
    master: {
      eq: eqFrom(m.eq, d.master.eq),
      balance: num(m.balance, d.master.balance, -1, 1),
      level: num(m.level, d.master.level, 0, 2),
      limiter: typeof m.limiter === 'boolean' ? m.limiter : d.master.limiter,
    },
    space: {
      size: num(sp.size, d.space.size, 0, 1),
      decay: num(sp.decay, d.space.decay, 0.05, 20),
      damping: num(sp.damping, d.space.damping, 0, 1),
      level: num(sp.level, d.space.level, 0, 2),
    },
    delay: {
      time: num(dl.time, d.delay.time, 0.002, 2),
      feedback: num(dl.feedback, d.delay.feedback, 0, 0.95),
      damping: num(dl.damping, d.delay.damping, 0, 1),
      level: num(dl.level, d.delay.level, 0, 2),
    },
  }
}

/** A colour, as the field to spread in: nothing at all when there is none. */
const hue = (v: unknown): { color?: number } =>
  typeof v === 'number' && Number.isFinite(v) ? { color: ((Math.round(v) % 360) + 360) % 360 } : {}

function num(v: unknown, fallback: number, lo: number, hi: number) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return v < lo ? lo : v > hi ? hi : v
}

const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null) : []
