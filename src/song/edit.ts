import type { TrackMix } from '../dsp/SongEngine'
import {
  barTicks,
  DEFAULT_CONSOLE,
  DEFAULT_STRIP,
  PPQ,
  type Console,
  type Marker,
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
  const already = song.tracks.find((t) => t.id === id)?.solo
  return {
    ...song,
    tracks: song.tracks.map((t) => ({ ...t, solo: !already && t.id === id ? (true as const) : undefined })),
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
    patterns: [...song.patterns, { id, name, length: source.length, notes: source.notes.map((n) => ({ ...n })) }],
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
 * Slide one placement of a pattern to start somewhere else. Landing exactly
 * on another placement of the same pattern merges the two, since two copies
 * of one pattern starting together play as one, only louder.
 */
export function movePlacement(song: Song, pattern: string, from: number, to: number): Song {
  const at = song.playlist.findIndex((x) => x.pattern === pattern && x.tick === from)
  const target = Math.max(0, to)
  if (at < 0 || target === from) return song
  const others = song.playlist.filter((_, i) => i !== at)
  if (others.some((x) => x.pattern === pattern && x.tick === target)) return { ...song, playlist: others }
  return { ...song, playlist: [...others, { pattern, tick: target }] }
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
  return { ...song, tracks }
}

/**
 * Change the time signature, keeping everything the same number of bars.
 *
 * A two-bar pattern stays two bars, and one placed at bar five is still at
 * bar five; the notes inside keep their ticks, which is to say their places
 * on the grid. That is what changing meter means in a sequencer -- the
 * arrangement is counted in bars -- and anything else would leave every
 * placement straddling a barline.
 */
export function setMeter(song: Song, meter: Meter): Song {
  // A bar has to be a whole, positive number of beats, or every bar in the
  // song would come out as nothing.
  if (!Number.isInteger(meter.beats) || meter.beats < 1 || meter.beats > 16) return song
  const from = barTicks(song)
  const to = barTicks({ meter })
  const bars = (ticks: number) => Math.round(ticks / from)
  const isDefault = meter.beats === 4 && meter.unit === 4
  const { meter: _dropped, ...rest } = song
  return {
    ...rest,
    ...(isDefault ? {} : { meter }),
    patterns: song.patterns.map((p) => ({ ...p, length: Math.max(1, bars(p.length)) * to })),
    playlist: song.playlist.map((x) => ({ ...x, tick: bars(x.tick) * to })),
    ...(song.markers ? { markers: song.markers.map((m) => ({ ...m, tick: bars(m.tick) * to })) } : {}),
  }
}

/** The markers, earliest first. */
export function markersOf(song: Song): Marker[] {
  return [...(song.markers ?? [])].sort((a, b) => a.tick - b.tick)
}

/**
 * Put a marker at a tick, named after the sections already there. One already
 * at that tick is left alone: two markers in one place would be a section
 * with nothing in it.
 */
export function addMarker(song: Song, tick: number, name?: string): Song {
  const markers = song.markers ?? []
  if (markers.some((m) => m.tick === tick)) return song
  const label = name ?? `Section ${markers.length + 1}`
  return { ...song, markers: [...markers, { tick, name: label }].sort((a, b) => a.tick - b.tick) }
}

export function renameMarker(song: Song, tick: number, name: string): Song {
  if (!name.trim()) return song
  return { ...song, markers: (song.markers ?? []).map((m) => (m.tick === tick ? { ...m, name } : m)) }
}

export function removeMarker(song: Song, tick: number): Song {
  const markers = (song.markers ?? []).filter((m) => m.tick !== tick)
  if (markers.length === (song.markers ?? []).length) return song
  const { markers: _dropped, ...rest } = song
  return markers.length ? { ...rest, markers } : rest
}

/**
 * The span a marker's section covers: from it to the next marker, or to the
 * end of the arrangement. Null for a tick with no marker, or a section with
 * nothing to play.
 */
export function sectionAt(song: Song, tick: number): { from: number; to: number } | null {
  const markers = markersOf(song)
  const at = markers.findIndex((m) => m.tick === tick)
  if (at < 0) return null
  const next = markers[at + 1]
  let end = 0
  for (const place of song.playlist) {
    const p = song.patterns.find((x) => x.id === place.pattern)
    if (p) end = Math.max(end, place.tick + p.length)
  }
  const to = next ? next.tick : end
  return to > tick ? { from: tick, to } : null
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
  return {
    ...song,
    patterns: song.patterns.map((p) => (p.id === id ? { ...p, notes } : p)),
  }
}

export function setPatternLength(song: Song, id: string, length: number): Song {
  return {
    ...song,
    patterns: song.patterns.map((p) => (p.id === id ? { ...p, length: Math.max(PPQ, length) } : p)),
  }
}

/**
 * Put a pattern on the playlist at a bar, or take it off again.
 *
 * One call for both directions because that is what a click on a cell in the
 * grid is: the cell either has that pattern in it or it does not.
 */
export function togglePlacement(song: Song, pattern: string, tick: number): Song {
  const at = song.playlist.findIndex((x) => x.pattern === pattern && x.tick === tick)
  if (at >= 0) {
    return { ...song, playlist: song.playlist.filter((_, i) => i !== at) }
  }
  if (!song.patterns.some((p) => p.id === pattern)) return song
  return { ...song, playlist: [...song.playlist, { pattern, tick }] }
}

/**
 * Where the placement of this pattern covering a tick begins, if one does.
 *
 * A pattern longer than a bar fills several cells of the playlist, and every
 * one of them has to be able to take the whole placement away -- a block only
 * its first cell could remove would be one you could paint over and then not
 * reach.
 */
export function placementAt(song: Song, pattern: string, tick: number): number | null {
  const p = song.patterns.find((x) => x.id === pattern)
  if (!p) return null
  for (const place of song.playlist) {
    if (place.pattern !== pattern) continue
    if (tick >= place.tick && tick < place.tick + p.length) return place.tick
  }
  return null
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
 * Where a pattern first appears in the arrangement, or null if it is not in
 * it. The placement the roll writes against when it plays a pattern in the
 * song rather than on its own.
 */
export function firstPlacement(song: Song, patternId: string): number | null {
  let first: number | null = null
  for (const place of song.playlist) {
    if (place.pattern === patternId && (first === null || place.tick < first)) first = place.tick
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
 * where its own pattern ends, as the scheduler cuts it, and to the span of
 * the placement.
 */
export function contextNotes(song: Song, patternId: string, at: number): Note[] {
  const self = song.patterns.find((p) => p.id === patternId)
  if (!self) return []
  const from = at
  const to = at + self.length
  const out: Note[] = []
  for (const place of song.playlist) {
    if (place.pattern === patternId) continue
    const other = song.patterns.find((p) => p.id === place.pattern)
    if (!other) continue
    if (place.tick >= to || place.tick + other.length <= from) continue
    for (const n of other.notes) {
      if (n.tick >= other.length) continue
      const start = place.tick + n.tick
      const end = place.tick + Math.min(n.tick + n.length, other.length)
      if (start >= to || end <= from) continue
      const tick = Math.max(start, from)
      out.push({ ...n, tick: tick - from, length: Math.min(end, to) - tick })
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
  const soloed = song.tracks.some((t) => t.solo)
  const mix: Record<string, TrackMix> = {}
  for (const t of song.tracks) {
    const heard = soloed ? !!t.solo : !t.mute
    const strip = t.strip ?? DEFAULT_STRIP
    mix[t.id] = {
      gain: t.gain,
      audible: heard && (!only || only.includes(t.id)),
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
  return {
    ...song,
    console: {
      master: { ...c.master, ...change.master },
      space: { ...c.space, ...change.space },
      delay: { ...c.delay, ...change.delay },
    },
  }
}

/** How many bars of four the playlist reaches, with room to add another. */
export function playlistBars(song: Song, minimum = 8): number {
  let end = 0
  for (const place of song.playlist) {
    const pattern = song.patterns.find((p) => p.id === place.pattern)
    if (!pattern) continue
    end = Math.max(end, place.tick + pattern.length)
  }
  return Math.max(minimum, Math.ceil(end / barTicks(song)) + 1)
}
