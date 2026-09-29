import { normalizeSong } from './normalize'
import { PPQ, type Pattern, type Placement, type Song } from './types'

/**
 * Clips: placements as things with edges.
 *
 * A placement used to be a pattern and a bar it started on. Now it is a
 * window onto its pattern -- starting anywhere, cut short or drawn out, split
 * in two, in any lane -- and these are the sums that turn the few fields it
 * carries into where it starts and stops, and the edits that move them.
 *
 * Placements are named by their index in the playlist, not by the pattern and
 * tick they start at. Two clips of one pattern can now start together in two
 * lanes, or overlap in one, so the old name no longer picks out a single clip.
 */

/**
 * The shortest a clip can be trimmed to: a 32nd note. Short enough to cut a
 * fill down to one hit, and long enough to still be grabbed on the playlist.
 */
export const MIN_CLIP = PPQ / 8

/** The lowest lane there can be. More lanes than anybody will scroll to. */
export const MAX_LANE = 255

export function clipLength(place: Placement, pattern: Pick<Pattern, 'length'>): number {
  return place.length ?? pattern.length
}

export function clipEnd(place: Placement, pattern: Pick<Pattern, 'length'>): number {
  return place.tick + clipLength(place, pattern)
}

/**
 * Where in its pattern a clip starts playing, always inside the pattern. A
 * clip keeps its offset when the pattern is later made shorter, so it is
 * wrapped here rather than trusted.
 */
export function clipOffset(place: Placement, pattern: Pick<Pattern, 'length'>): number {
  const len = pattern.length
  if (!(len > 0)) return 0
  const o = place.offset ?? 0
  return ((o % len) + len) % len
}

export const laneOf = (place: Placement) => place.lane ?? 0

/** How many lanes have something in them, counting the empty ones between. */
export function lanesUsed(song: Song): number {
  let lanes = 0
  for (const p of song.playlist) lanes = Math.max(lanes, laneOf(p) + 1)
  return lanes
}

/** A clip with its optional fields left out wherever they say the default. */
function tidy(place: Placement): Placement {
  const out: Placement = { pattern: place.pattern, tick: place.tick }
  if (place.lane) out.lane = place.lane
  if (place.offset) out.offset = place.offset
  if (place.length !== undefined) out.length = place.length
  return out
}

const patternOf = (song: Song, place: Placement | undefined) =>
  place ? song.patterns.find((p) => p.id === place.pattern) : undefined

/** Put a pattern down as a new clip: the whole pattern, once. */
export function addClip(song: Song, pattern: string, tick: number, lane: number): Song {
  if (!song.patterns.some((p) => p.id === pattern)) return song
  const place = tidy({
    pattern,
    tick: Math.max(0, Math.round(tick)),
    lane: clampLane(lane),
  })
  return { ...song, playlist: [...song.playlist, place] }
}

export function removeClips(song: Song, indices: readonly number[]): Song {
  const gone = new Set(indices)
  const playlist = song.playlist.filter((_, i) => !gone.has(i))
  return playlist.length === song.playlist.length ? song : { ...song, playlist }
}

/**
 * Move some clips together, by so many ticks and lanes. Held back as a group
 * at the start of the song and the top lane, so a selection dragged against
 * either edge stays the shape it was rather than piling up there.
 *
 * Every clip keeps its index, so a selection still names the clips it did.
 */
export function moveClips(song: Song, indices: readonly number[], ticks: number, lanes: number): Song {
  const moving = indices.filter((i) => song.playlist[i])
  if (!moving.length) return song
  const [dt, dl] = heldBack(song, moving, ticks, lanes)
  if (dt === 0 && dl === 0) return song
  const set = new Set(moving)
  return {
    ...song,
    playlist: song.playlist.map((p, i) =>
      set.has(i) ? tidy({ ...p, tick: p.tick + dt, lane: clampLane(laneOf(p) + dl) }) : p,
    ),
  }
}

/**
 * Copies of some clips, moved by so many ticks and lanes, added to the end of
 * the playlist -- so the copies are the last `indices.length` clips there, in
 * the order they were asked for, and can be selected as such.
 */
export function duplicateClips(song: Song, indices: readonly number[], ticks: number, lanes: number): Song {
  const copying = indices.filter((i) => song.playlist[i])
  if (!copying.length) return song
  const [dt, dl] = heldBack(song, copying, ticks, lanes)
  const copies = copying.map((i) => {
    const p = song.playlist[i]
    return tidy({ ...p, tick: p.tick + dt, lane: clampLane(laneOf(p) + dl) })
  })
  return { ...song, playlist: [...song.playlist, ...copies] }
}

function heldBack(song: Song, indices: readonly number[], ticks: number, lanes: number): [number, number] {
  let first = Infinity
  let top = Infinity
  for (const i of indices) {
    first = Math.min(first, song.playlist[i].tick)
    top = Math.min(top, laneOf(song.playlist[i]))
  }
  return [Math.round(Math.max(ticks, -first)), Math.round(Math.max(lanes, -top))]
}

/**
 * Drag one edge of a clip to a tick.
 *
 * The end is only a length. The start moves the clip's edge over its notes
 * rather than moving the notes: the pattern stays where it was in the song,
 * and the offset changes by as much as the edge did. Pulled back past the
 * pattern's own start, it shows the end of the repeat before -- the pattern
 * loops for as long as the clip lasts, in both directions.
 */
export function trimClip(song: Song, index: number, edge: 'start' | 'end', at: number): Song {
  const place = song.playlist[index]
  const pattern = patternOf(song, place)
  if (!place || !pattern) return song
  const end = clipEnd(place, pattern)
  let next: Placement
  if (edge === 'end') {
    const length = Math.max(MIN_CLIP, Math.round(at) - place.tick)
    if (length === clipLength(place, pattern)) return song
    next = { ...place, length }
  } else {
    const start = Math.max(0, Math.min(Math.round(at), end - MIN_CLIP))
    if (start === place.tick) return song
    next = {
      ...place,
      tick: start,
      offset: wrap(clipOffset(place, pattern) + start - place.tick, pattern.length),
      length: end - start,
    }
  }
  return { ...song, playlist: song.playlist.map((p, i) => (i === index ? tidy(next) : p)) }
}

/**
 * Cut a clip in two at a tick. The halves play exactly what the whole did:
 * the second begins where the first stops, that far into the pattern. The
 * second half goes straight after the first in the playlist.
 */
export function splitClip(song: Song, index: number, at: number): Song {
  const place = song.playlist[index]
  const pattern = patternOf(song, place)
  if (!place || !pattern) return song
  const cut = Math.round(at)
  const end = clipEnd(place, pattern)
  if (cut <= place.tick || cut >= end) return song
  const first = tidy({ ...place, length: cut - place.tick })
  const second = tidy({
    ...place,
    tick: cut,
    offset: wrap(clipOffset(place, pattern) + cut - place.tick, pattern.length),
    length: end - cut,
  })
  const playlist = [...song.playlist]
  playlist.splice(index, 1, first, second)
  return { ...song, playlist }
}

/**
 * One lane per pattern, in the order the patterns are listed: how a song
 * from before lanes looks, since its playlist was a row per pattern. Patterns
 * that are never placed get no lane, so there are no empty rows between.
 */
export function laneByPattern(song: Song): Song {
  const placed = new Set(song.playlist.map((p) => p.pattern))
  const lane = new Map(song.patterns.filter((p) => placed.has(p.id)).map((p, i) => [p.id, i]))
  return normalizeSong({
    ...song,
    playlist: song.playlist.map((p) => tidy({ ...p, lane: lane.get(p.pattern) ?? 0 })),
  })
}

const clampLane = (lane: number) =>
  Number.isFinite(lane) ? Math.max(0, Math.min(MAX_LANE, Math.round(lane))) : 0

const wrap = (n: number, len: number) => (len > 0 ? ((n % len) + len) % len : 0)
