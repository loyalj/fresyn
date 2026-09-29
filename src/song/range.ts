import { normalizeSong } from './normalize'
import { cutAt, sectionEnd, uniqueSectionName } from './section'
import type { Placement, Section, Song } from './types'

/**
 * Editing a stretch of the song as time: any span of ticks, across every
 * lane, whether or not a section covers it.
 *
 * What a section's move, duplicate and delete do for its own bars, these do
 * for any bars -- and one thing they cannot: open up empty bars in the middle
 * of a song. Clips crossing an edge are split there first, which changes
 * nothing that is heard, so only what is inside the range is touched.
 *
 * Sections go with the time they label. Bars put in inside a section make it
 * longer; bars taken out of one make it shorter, and a section whose bars
 * are all taken out goes with them. So does the transport's loop.
 */

export interface TickRange {
  from: number
  /** Exclusive. Always after `from`. */
  to: number
}

/** A stretch of the song held for pasting: its clips, from its own tick zero. */
export interface TimeClip {
  length: number
  clips: Placement[]
  /** Sections wholly inside it, from its tick zero. */
  sections: Section[]
}

const clean = (r: TickRange): TickRange | null => {
  const from = Math.max(0, Math.round(r.from))
  const to = Math.round(r.to)
  return to > from ? { from, to } : null
}

/** Clips starting inside the range, once it has been cut at both edges. */
const inside = (p: Placement, r: TickRange) => p.tick >= r.from && p.tick < r.to

function cutRange(song: Song, r: TickRange): Song {
  return cutAt(cutAt(song, r.from), r.to)
}

function withSections(song: Song, sections: Section[]): Song {
  const { sections: _, ...rest } = song
  return sections.length ? { ...rest, sections: [...sections].sort((a, b) => a.tick - b.tick) } : rest
}

/** A song with its sections and loop run through a map of ticks. */
function remapTime(song: Song, map: (tick: number, edge: 'start' | 'end') => number): Song {
  const sections = (song.sections ?? []).flatMap((s) => {
    const tick = map(s.tick, 'start')
    const length = map(sectionEnd(s), 'end') - tick
    return length > 0 ? [{ ...s, tick, length }] : []
  })
  let out = withSections(song, sections)
  if (song.loop) {
    const from = map(song.loop.from, 'start')
    const to = map(song.loop.to, 'end')
    const { loop: _, ...rest } = out
    out = to > from ? { ...rest, loop: { from, to } } : rest
  }
  return out
}

/**
 * Empty bars put in at a tick: everything from there on moves later by
 * `length`. A clip playing across the tick is split there, its second half
 * moving with the rest, and a section running across it is made longer.
 */
export function insertTime(song: Song, at: number, length: number): Song {
  const t = Math.max(0, Math.round(at))
  const len = Math.round(length)
  if (!(len > 0)) return song
  const cut = cutAt(song, t)
  const moved = {
    ...cut,
    playlist: cut.playlist.map((p) => (p.tick >= t ? { ...p, tick: p.tick + len } : p)),
  }
  // A start at the tick moves with what is after it; an end there stays,
  // except that a span running across the tick grows round the new bars.
  return normalizeSong(
    remapTime(moved, (tick, edge) => (tick > t || (tick === t && edge === 'start') ? tick + len : tick)),
  )
}

/**
 * The range taken out, and everything after it moved back to close the gap.
 * Its clips go; clips across its edges are cut there and keep their outside
 * parts. The bars are gone from every section that had them.
 */
export function deleteTime(song: Song, range: TickRange): Song {
  const r = clean(range)
  if (!r) return song
  const len = r.to - r.from
  const cut = cutRange(song, r)
  const kept = {
    ...cut,
    playlist: cut.playlist.filter((p) => !inside(p, r)).map((p) => (p.tick >= r.to ? { ...p, tick: p.tick - len } : p)),
  }
  return normalizeSong(remapTime(kept, (tick) => (tick <= r.from ? tick : tick >= r.to ? tick - len : r.from)))
}

/** The range's clips taken out and nothing moved: the bars stay, empty. */
export function clearTime(song: Song, range: TickRange): Song {
  const r = clean(range)
  if (!r) return song
  const cut = cutRange(song, r)
  if (!cut.playlist.some((p) => inside(p, r))) return song
  return normalizeSong({ ...cut, playlist: cut.playlist.filter((p) => !inside(p, r)) })
}

/** What is in a range, to paste somewhere else. */
export function copyTime(song: Song, range: TickRange): TimeClip | null {
  const r = clean(range)
  if (!r) return null
  const cut = cutRange(song, r)
  return {
    length: r.to - r.from,
    clips: cut.playlist.filter((p) => inside(p, r)).map((p) => ({ ...p, tick: p.tick - r.from })),
    sections: (song.sections ?? [])
      .filter((s) => s.tick >= r.from && sectionEnd(s) <= r.to)
      .map((s) => ({ ...s, tick: s.tick - r.from })),
  }
}

/**
 * What was copied, put in at a tick: the song opens up by its length there
 * and the copy goes into the gap, sections and all. A pasted section is
 * named after the one it copies, since a game finds sections by name.
 */
export function pasteTime(song: Song, at: number, clip: TimeClip): Song {
  const t = Math.max(0, Math.round(at))
  if (!(clip.length > 0)) return song
  const opened = insertTime(song, t, clip.length)
  // A section the paste lands inside was just made longer by the gap; a
  // pasted section cannot go inside another, so it stays only a label on the
  // bars when there is room for it.
  let sections = opened.sections ?? []
  for (const s of clip.sections) {
    const tick = s.tick + t
    const end = tick + s.length
    if (sections.some((x) => x.tick < end && sectionEnd(x) > tick)) continue
    const name = uniqueSectionName({ ...opened, sections }, s.name)
    sections = [...sections, { ...s, tick, name }]
  }
  return normalizeSong(
    withSections(
      { ...opened, playlist: [...opened.playlist, ...clip.clips.map((p) => ({ ...p, tick: p.tick + t }))] },
      sections,
    ),
  )
}

/** A copy of the range straight after it, with what follows moved over to make room. */
export function duplicateTime(song: Song, range: TickRange): Song {
  const r = clean(range)
  if (!r) return song
  const clip = copyTime(song, r)
  return clip ? pasteTime(song, r.to, clip) : song
}
