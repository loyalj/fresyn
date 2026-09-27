import { MIN_VELOCITY, minPatternLength, type Marker, type Placement, type Song } from './types'

/**
 * The invariants a song holds however it arrived.
 *
 * The editor keeps these by construction -- a note is dragged a whole tick at
 * a time, the velocity lane stops at its floor, a cell on the playlist is
 * either filled or not -- and a file keeps them only if something checks. A
 * hand-edited file, one from an older build or one from somebody else's tool
 * can say anything, and the arithmetic downstream assumes it cannot: the
 * scale walks step a row at a time and never meet a fractional pitch, two
 * copies of a placement play every note twice as loud, and a note at no
 * velocity is one nobody can see to fix. So the reader and every edit that
 * rebuilds the song wholesale go through this, and a song that has been
 * through it is one the editor could have made.
 *
 * Ids get the same treatment for a different reason. Track ids become keys of
 * plain objects -- the racks, keyed by track -- and `__proto__` as a key is
 * not a key but the object's prototype. Ids like that are dropped along with
 * whatever hangs off them: nothing the app makes is called that, so a file
 * that says so was not written by it.
 */
export function normalizeSong(song: Song): Song {
  const tracks = []
  const trackIds = new Set<string>()
  for (const t of song.tracks) {
    if (!safeId(t.id) || trackIds.has(t.id)) continue
    trackIds.add(t.id)
    tracks.push(t)
  }

  const shortest = minPatternLength(song)
  const patterns = []
  const patternIds = new Set<string>()
  for (const p of song.patterns) {
    if (!safeId(p.id) || patternIds.has(p.id)) continue
    patternIds.add(p.id)
    patterns.push({
      ...p,
      length: Math.max(shortest, whole(p.length)),
      notes: p.notes
        .filter((n) => trackIds.has(n.track))
        .map((n) => ({
          ...n,
          tick: Math.max(0, whole(n.tick)),
          length: Math.max(0, whole(n.length)),
          pitch: whole(n.pitch),
          velocity: n.velocity < MIN_VELOCITY ? MIN_VELOCITY : n.velocity > 1 ? 1 : n.velocity,
        })),
    })
  }

  // Two copies of one pattern starting together play as one, only louder,
  // which is why moving a placement onto another merges them. The same rule
  // for a file: the first is kept.
  const playlist: Placement[] = []
  const placed = new Set<string>()
  for (const x of song.playlist) {
    if (!patternIds.has(x.pattern)) continue
    const tick = Math.max(0, whole(x.tick))
    const key = `${x.pattern}@${tick}`
    if (placed.has(key)) continue
    placed.add(key)
    playlist.push({ ...x, tick })
  }

  const out: Song = { ...song, tracks, patterns, playlist }

  if (song.loop) {
    const from = Math.max(0, whole(song.loop.from))
    const to = whole(song.loop.to)
    if (to > from) out.loop = { from, to }
    else delete out.loop
  }

  // Two markers on one tick would be a section with nothing in it, which the
  // editor refuses to make. The first one's name wins.
  if (song.markers) {
    const markers: Marker[] = []
    for (const m of song.markers) {
      const tick = whole(m.tick)
      if (tick < 0 || markers.some((x) => x.tick === tick)) continue
      markers.push({ ...m, tick })
    }
    if (markers.length) out.markers = markers.sort((a, b) => a.tick - b.tick)
    else delete out.markers
  }

  return out
}

/**
 * An id that can be used as a key anywhere without meaning something else.
 * Non-empty, and none of the names a plain object already answers to.
 */
export function safeId(id: string): boolean {
  return !!id && !UNSAFE_IDS.has(id)
}

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

/** Ticks and rows are whole numbers; anything else is rounded to one. */
const whole = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0)
