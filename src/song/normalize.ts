import { MIN_VELOCITY, minPatternLength, type Folder, type Placement, type Section, type Song, type Track } from './types'

/**
 * The invariants a song holds however it arrived.
 *
 * The editor keeps these by construction -- a note is dragged a whole tick at
 * a time, the velocity lane stops at its floor, a clip is trimmed a whole tick
 * at a time -- and a file keeps them only if something checks. A
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
  const tracks: Track[] = []
  const trackIds = new Set<string>()
  for (const t of song.tracks) {
    if (!safeId(t.id) || trackIds.has(t.id)) continue
    trackIds.add(t.id)
    tracks.push(t)
  }

  // Folders with ids that can be keys, once each; a track filed in one that
  // is not there is filed in none.
  const folders: Folder[] = []
  const folderIds = new Set<string>()
  for (const f of song.folders ?? []) {
    if (!safeId(f.id) || folderIds.has(f.id)) continue
    folderIds.add(f.id)
    folders.push({ ...f, gain: Number.isFinite(f.gain) ? Math.max(0, Math.min(1, f.gain)) : 1 })
  }
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (t.folder !== undefined && !folderIds.has(t.folder)) {
      const { folder: _, ...rest } = t
      tracks[i] = rest
    }
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

  // A clip's fields in range and whole, and the defaults left out. The same
  // clip twice over -- same pattern, place, lane and window -- is one clip
  // played twice as loud, and nothing the editor makes: the first is kept.
  const lengths = new Map(patterns.map((p) => [p.id, p.length]))
  const playlist: Placement[] = []
  const placed = new Set<string>()
  for (const x of song.playlist) {
    const len = lengths.get(x.pattern)
    if (len === undefined) continue
    const tick = Math.max(0, whole(x.tick))
    const lane = Math.max(0, Math.min(255, whole(x.lane ?? 0)))
    const offset = ((whole(x.offset ?? 0) % len) + len) % len
    const length = x.length === undefined ? undefined : Math.max(1, whole(x.length))
    const key = `${x.pattern}@${tick}/${lane}/${offset}/${length ?? ''}`
    if (placed.has(key)) continue
    placed.add(key)
    const clip: Placement = { pattern: x.pattern, tick }
    if (lane) clip.lane = lane
    if (offset) clip.offset = offset
    if (length !== undefined) clip.length = length
    playlist.push(clip)
  }

  const out: Song = { ...song, tracks, patterns, playlist }
  if (folders.length) out.folders = folders
  else delete out.folders

  if (song.loop) {
    const from = Math.max(0, whole(song.loop.from))
    const to = whole(song.loop.to)
    if (to > from) out.loop = { from, to }
    else delete out.loop
  }

  // Sections in order, whole, never empty and never overlapping: one that
  // runs into the next is cut short where the next begins, and two starting
  // together are one, the first.
  if (song.sections) {
    const sorted = song.sections
      .map((s) => ({ ...s, tick: Math.max(0, whole(s.tick)), length: whole(s.length) }))
      .filter((s) => s.length > 0)
      .sort((a, b) => a.tick - b.tick)
    const sections: Section[] = []
    for (const s of sorted) {
      const prev = sections[sections.length - 1]
      if (prev && prev.tick === s.tick) continue
      if (prev && prev.tick + prev.length > s.tick) prev.length = s.tick - prev.tick
      sections.push(s)
    }
    if (sections.length) out.sections = sections
    else delete out.sections
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
