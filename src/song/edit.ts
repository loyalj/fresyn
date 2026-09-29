import type { TrackMix } from '../dsp/SongEngine'
import { normalizeSong } from './normalize'
import { clipOffset } from './clip'
import { heardTracks, trackGain } from './folder'
import { clipHits, sameSwing, songEnd, unswungTick } from './schedule'
import {
  barTicks,
  cleanSwing,
  DEFAULT_CONSOLE,
  DEFAULT_STRIP,
  minPatternLength,
  type Console,
  type Meter,
  type Note,
  type Song,
  type Strip,
  type Track,
} from './types'

/**
 * Edits to an arrangement.
 *
 * Pure functions returning a new song, exactly as `patch/edit.ts` does for a
 * rack, and for the same reason: the app keeps its whole document in a
 * history, so an edit that changed something in place would be an edit that
 * could not be undone.
 *
 * The invariants these keep are the ones nothing else checks. A note belongs
 * to a track, a placement belongs to a pattern, and removing either has to
 * take its dependents with it -- otherwise the file grows notes for tracks
 * that no longer exist, which the reader would then drop on the way back in
 * and nobody would know why.
 */

/** The first `trackN` nobody is using. `bench` is the one every song starts with. */
export function nextTrackId(song: Song): string {
  for (let i = 2; ; i++) {
    const id = `track${i}`
    if (!song.tracks.some((t) => t.id === id)) return id
  }
}

export function nextPatternId(song: Song): string {
  for (let i = 1; ; i++) {
    const id = `p${i}`
    if (!song.patterns.some((p) => p.id === id)) return id
  }
}

export function addTrack(song: Song, id: string, name: string): Song {
  if (song.tracks.some((t) => t.id === id)) return song
  return { ...song, tracks: [...song.tracks, { id, name, patch: id, gain: 1 }] }
}

/**
 * Take a track out, and everything that was for it.
 *
 * Never the last one: a song with no tracks has nothing to put a note on, and
 * the rack on the bench is one of them. The caller gets the song back
 * unchanged, which reads at the call site as "that did nothing".
 */
export function removeTrack(song: Song, id: string): Song {
  if (song.tracks.length <= 1 || !song.tracks.some((t) => t.id === id)) return song
  return {
    ...song,
    tracks: song.tracks.filter((t) => t.id !== id),
    patterns: song.patterns.map((p) => ({ ...p, notes: p.notes.filter((n) => n.track !== id) })),
  }
}

export function updateTrack(song: Song, id: string, change: Partial<Omit<Track, 'id'>>): Song {
  const track = song.tracks.find((t) => t.id === id)
  // Nothing to change is no edit at all, and handing back the same song is
  // what keeps a click that changed nothing out of the undo history.
  if (!track || sameFields(track, change)) return song
  return {
    ...song,
    tracks: song.tracks.map((t) => (t.id === id ? { ...t, ...change } : t)),
  }
}

/**
 * Solo, as a desk does it: pressing solo on a track clears it everywhere
 * else, and pressing it again on the same track lets everything back in.
 *
 * Exclusive rather than additive because additive solo with one button is a
 * state nobody can read -- three tracks soloed looks exactly like three
 * tracks muted, and getting back needs three more presses.
 */
export function soloTrack(song: Song, id: string): Song {
  const track = song.tracks.find((t) => t.id === id)
  if (!track) return song
  const already = track.solo
  return {
    ...song,
    tracks: song.tracks.map((t) => ({ ...t, solo: !already && t.id === id ? (true as const) : undefined })),
    // A folder's solo is a solo too, and solo is exclusive.
    ...(song.folders?.some((f) => f.solo)
      ? { folders: song.folders.map((f) => (f.solo ? (({ solo: _, ...rest }) => rest)(f) : f)) }
      : {}),
  }
}

export function addPattern(song: Song, id: string, name: string, length = barTicks(song)): Song {
  if (song.patterns.some((p) => p.id === id)) return song
  return { ...song, patterns: [...song.patterns, { id, name, length, notes: [] }] }
}

export function duplicatePattern(song: Song, sourceId: string, id: string, name: string): Song {
  const source = song.patterns.find((p) => p.id === sourceId)
  if (!source || song.patterns.some((p) => p.id === id)) return song
  return {
    ...song,
    patterns: [
      ...song.patterns,
      {
        id,
        name,
        length: source.length,
        notes: source.notes.map((n) => ({ ...n })),
        // A copy is a variation to write, and it should groove like the
        // part it was copied from until it is told otherwise.
        ...(source.swing ? { swing: { ...source.swing } } : {}),
      },
    ],
  }
}

/** Rename a pattern or recolour it. A blank name is refused: it would be a row with no label. */
export function updatePattern(song: Song, id: string, change: { name?: string; color?: number | null }): Song {
  if (change.name !== undefined && !change.name.trim()) return song
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== id) return p
      const next = { ...p, ...(change.name !== undefined ? { name: change.name } : {}) }
      if (change.color === null) delete next.color
      else if (change.color !== undefined) next.color = change.color
      return next
    }),
  }
}

/**
 * Put the tracks in this order, for a drag in the list. Forgiving the same
 * way the rack's reorder is: an id that is not a track is skipped, and a
 * track the list never names keeps its place at the end.
 */
export function reorderTracks(song: Song, ids: readonly string[]): Song {
  const remaining = new Map(song.tracks.map((t) => [t.id, t]))
  const tracks: Track[] = []
  for (const id of ids) {
    const t = remaining.get(id)
    if (!t) continue
    tracks.push(t)
    remaining.delete(id)
  }
  for (const t of song.tracks) if (remaining.has(t.id)) tracks.push(t)
  if (tracks.every((t, i) => t === song.tracks[i])) return song
  return { ...song, tracks }
}

/**
 * Change the time signature, keeping everything the same number of bars.
 *
 * A two-bar pattern stays two bars, and one placed at bar five is still at
 * bar five; the notes inside keep their ticks, which is to say their places
 * on the grid. That is what changing meter means in a sequencer -- the
 * arrangement is counted in bars -- and anything else would leave every
 * clip straddling a barline.
 */
export function setMeter(song: Song, meter: Meter): Song {
  // A bar has to be a whole, positive number of beats, or every bar in the
  // song would come out as nothing.
  if (!Number.isInteger(meter.beats) || meter.beats < 1 || meter.beats > 16) return song
  const from = barTicks(song)
  const to = barTicks({ meter })
  const bars = (ticks: number) => Math.round(ticks / from)
  // A clip keeps its bar and its place in the bar -- a clip on beat two stays
  // on beat two -- as far as the new bar reaches. On a barline, as every clip
  // was before they could be anywhere, that is the bar-for-bar rule.
  const within = (ticks: number) => {
    const bar = Math.floor(ticks / from)
    return bar * to + Math.min(ticks - bar * from, to - 1)
  }
  const isDefault = meter.beats === 4 && meter.unit === 4
  const { meter: _dropped, ...rest } = song
  // Through the reader's rules on the way out: two clips in one bar of 4/4
  // can land on the same tick of a shorter one, and so can two sections, and
  // either would be a state the editor never makes.
  return normalizeSong({
    ...rest,
    ...(isDefault ? {} : { meter }),
    patterns: song.patterns.map((p) => ({ ...p, length: Math.max(1, bars(p.length)) * to })),
    playlist: song.playlist.map((x) => ({
      ...x,
      tick: within(x.tick),
      ...(x.length !== undefined ? { length: Math.max(1, within(x.length)) } : {}),
    })),
    ...(song.sections
      ? { sections: song.sections.map((s) => ({ ...s, tick: within(s.tick), length: Math.max(1, within(s.length)) })) }
      : {}),
  })
}

/** Take a pattern out, and every placement of it. Never the last one. */
export function removePattern(song: Song, id: string): Song {
  if (song.patterns.length <= 1 || !song.patterns.some((p) => p.id === id)) return song
  return {
    ...song,
    patterns: song.patterns.filter((p) => p.id !== id),
    playlist: song.playlist.filter((x) => x.pattern !== id),
  }
}

export function setPatternNotes(song: Song, id: string, notes: Note[]): Song {
  const pattern = song.patterns.find((p) => p.id === id)
  if (!pattern || sameNotes(pattern.notes, notes)) return song
  return {
    ...song,
    patterns: song.patterns.map((p) => (p.id === id ? { ...p, notes } : p)),
  }
}

/**
 * Swing a pattern, or straighten it. The amount is clamped to what swing
 * means and anything at or below straight is stored as no swing at all.
 * The same song back when nothing changes, so a slider held still, or set
 * to where it already was, adds nothing to undo.
 */
export function setPatternSwing(song: Song, id: string, amount: number, step: number): Song {
  const pattern = song.patterns.find((p) => p.id === id)
  if (!pattern) return song
  const swing = cleanSwing(amount, step)
  if (sameSwing(pattern.swing, swing)) return song
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== id) return p
      const { swing: _, ...rest } = p
      return swing ? { ...rest, swing } : rest
    }),
  }
}

export function setPatternLength(song: Song, id: string, length: number): Song {
  const next = Math.max(minPatternLength(song), Math.round(length))
  const pattern = song.patterns.find((p) => p.id === id)
  if (!pattern || !Number.isFinite(next) || pattern.length === next) return song
  return {
    ...song,
    patterns: song.patterns.map((p) => (p.id === id ? { ...p, length: next } : p)),
  }
}

/**
 * The song with only one pattern in it, placed at the start.
 *
 * What the transport plays while the roll is open: the pattern being written,
 * on its own and round and round, with the rest of the arrangement set aside.
 * Derived rather than held as a mode inside the transport, so that playing a
 * pattern and playing the song are the same code path with a different song.
 */
export function patternOnly(song: Song, patternId: string): Song {
  const pattern = song.patterns.find((p) => p.id === patternId)
  if (!pattern) return { ...song, playlist: [] }
  return { ...song, patterns: [pattern], playlist: [{ pattern: patternId, tick: 0 }] }
}

/**
 * Where a pattern's own tick zero falls in the song, at its earliest clip, or
 * null if it is not in the song. The span the roll plays and draws against
 * when it plays a pattern in the song rather than on its own.
 *
 * Tick zero rather than the clip's start, because the roll draws the pattern
 * from its beginning: a clip trimmed to start half way through has the
 * pattern's start half a pattern earlier. Where that would be before the song
 * begins, the next repeat's start is used instead.
 */
export function firstPlacement(song: Song, patternId: string): number | null {
  const pattern = song.patterns.find((p) => p.id === patternId)
  if (!pattern) return null
  let first: number | null = null
  for (const place of song.playlist) {
    if (place.pattern !== patternId) continue
    let zero = place.tick - clipOffset(place, pattern)
    if (zero < 0) zero += pattern.length
    if (first === null || zero < first) first = zero
  }
  return first
}

/**
 * Everything the rest of the song plays over one placement of a pattern,
 * as notes counted from that placement's start.
 *
 * What the roll draws behind the pattern being written, so the drums that
 * play under a melody are there to be seen as well as heard. Other patterns
 * only: this pattern's own other tracks are already in it. Each note is cut
 * where its own pattern and clip end, as the scheduler cuts it, and to the span of
 * the placement.
 *
 * `heard` is for a roll drawing swing as it sounds. Then each note is placed
 * where it plays under its own pattern's swing, and handed back in this
 * pattern's written ticks -- the tick that this pattern's swing would carry
 * to that same moment -- so the roll's one mapping from written to drawn puts
 * it exactly where it is heard, whatever either pattern's swing is.
 */
export function contextNotes(song: Song, patternId: string, at: number, heard = false): Note[] {
  const self = song.patterns.find((p) => p.id === patternId)
  if (!self) return []
  const from = at
  const to = at + self.length
  const out: Note[] = []
  for (const place of song.playlist) {
    if (place.pattern === patternId) continue
    const other = song.patterns.find((p) => p.id === place.pattern)
    if (!other) continue
    // Straight, when the notes are wanted where they are written.
    const timing = heard ? other : { length: other.length }
    for (const { note: n, on: start, off: end } of clipHits(place, other, from, to, timing)) {
      if (start >= to || end <= from) continue
      const tick = Math.max(start, from) - from
      const until = Math.min(end, to) - from
      if (heard) {
        const t = unswungTick(tick, self)
        out.push({ ...n, tick: t, length: unswungTick(until, self) - t })
      } else {
        out.push({ ...n, tick, length: until - tick })
      }
    }
  }
  return out
}

/**
 * How each track reaches the mix, with solo and mute resolved.
 *
 * One answer per track rather than two flags, because "is this track audible"
 * is a question about the whole song -- a track that is not soloed while
 * something else is, is exactly as silent as a muted one, and every caller
 * would otherwise work that out again.
 *
 * `only` narrows it further without disturbing the rest, which is what a stem
 * is: the arrangement, with one track let through.
 */
export function trackMix(song: Song, only?: readonly string[]): Record<string, TrackMix> {
  const heard = heardTracks(song)
  const mix: Record<string, TrackMix> = {}
  for (const t of song.tracks) {
    const strip = t.strip ?? DEFAULT_STRIP
    mix[t.id] = {
      // The track's fader after its folder's, as a VCA group does it.
      gain: trackGain(song, t),
      audible: heard.has(t.id) && (!only || only.includes(t.id)),
      pan: strip.pan,
      eq: strip.eq,
      space: strip.space,
      delay: strip.delay,
    }
  }
  return mix
}

/** One track's channel on the console, with the default filling in what it never set. */
export function stripOf(track: Track): Strip {
  return track.strip ?? DEFAULT_STRIP
}

/** The song's desk, with the default one standing in for a song that has none. */
export function consoleOf(song: Song): Console {
  return song.console ?? DEFAULT_CONSOLE
}

/** Change one track's channel strip, a field at a time. */
export function updateStrip(song: Song, id: string, change: Partial<Strip>): Song {
  const track = song.tracks.find((t) => t.id === id)
  if (!track || sameFields(stripOf(track), change)) return song
  return {
    ...song,
    tracks: song.tracks.map((t) => (t.id === id ? { ...t, strip: { ...stripOf(t), ...change } } : t)),
  }
}

/** Change the desk, a section at a time. */
export function updateConsole(
  song: Song,
  change: { master?: Partial<Console['master']>; space?: Partial<Console['space']>; delay?: Partial<Console['delay']> },
): Song {
  const c = consoleOf(song)
  if (
    sameFields(c.master, change.master ?? {}) &&
    sameFields(c.space, change.space ?? {}) &&
    sameFields(c.delay, change.delay ?? {})
  ) {
    return song
  }
  return {
    ...song,
    console: {
      master: { ...c.master, ...change.master },
      space: { ...c.space, ...change.space },
      delay: { ...c.delay, ...change.delay },
    },
  }
}

/** How many bars the playlist reaches, with room to add another. */
export function playlistBars(song: Song, minimum = 8): number {
  return Math.max(minimum, Math.ceil(songEnd(song) / barTicks(song)) + 1)
}

/**
 * Whether applying `change` to `current` would leave it as it was: every field
 * named is already that value. One level deep, which is as deep as the edits
 * that use it go -- an EQ is replaced whole, and a new one with the same three
 * numbers in it is still the same EQ.
 */
function sameFields<T extends object>(current: T, change: Partial<T>): boolean {
  for (const key of Object.keys(change) as (keyof T)[]) {
    const a = current[key]
    const b = change[key]
    if (a === b) continue
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      const ka = Object.keys(a)
      const kb = Object.keys(b)
      if (ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])) {
        continue
      }
    }
    return false
  }
  return true
}

/** Two note lists with the same notes in the same order. */
function sameNotes(a: readonly Note[], b: readonly Note[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (
      x.track !== y.track ||
      x.tick !== y.tick ||
      x.length !== y.length ||
      x.pitch !== y.pitch ||
      x.velocity !== y.velocity
    ) {
      return false
    }
  }
  return true
}
