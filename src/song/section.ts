import { clipEnd, splitClip } from './clip'
import { normalizeSong } from './normalize'
import { songEnd } from './schedule'
import { barTicks, type Placement, type Section, type Song } from './types'

/**
 * Sections: the named parts of a song, and the arranger track they make.
 *
 * A section is a span of the song with a name -- Intro, Verse, Drop. Most of
 * what can be done to one is done to its label: rename it, colour it, move
 * an edge, cut it in two, take it away. None of those touch a note. Taking a
 * section away in particular leaves its music where it was: a label is not
 * worth losing bars of work over.
 *
 * Two things are done to its music as well, because that is the point of an
 * arranger track. Moving a section to another place in the song takes the
 * clips inside it along, and the rest of the song closes up behind it and
 * opens up in front. Duplicating one puts a second copy of its music straight
 * after it. Clips that cross a section's edge are split there first, which
 * changes nothing that is heard: a split clip plays exactly what the whole
 * one did.
 *
 * Sections are named by the tick they start on. Two never start together, so
 * the tick picks out one, and it is what the playlist and a loop already
 * hold on to.
 */

/** The sections, earliest first. */
export function sectionsOf(song: Song): Section[] {
  return [...(song.sections ?? [])].sort((a, b) => a.tick - b.tick)
}

export const sectionEnd = (s: Section) => s.tick + s.length

/** The span the section starting at a tick covers, or null for no such section. */
export function sectionAt(song: Song, tick: number): { from: number; to: number } | null {
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  return s ? { from: s.tick, to: sectionEnd(s) } : null
}

/** The section a tick falls in, or undefined in a stretch no section covers. */
export function sectionOver(song: Song, tick: number): Section | undefined {
  return (song.sections ?? []).find((s) => tick >= s.tick && tick < sectionEnd(s))
}

/**
 * A name no other section has: the one asked for, or it with a number after
 * it. A game plays a section by its name, so two called Verse would leave
 * one of them out of reach.
 */
export function uniqueSectionName(song: Song, name: string): string {
  const taken = new Set((song.sections ?? []).map((s) => s.name))
  if (!taken.has(name)) return name
  const base = name.replace(/\s+\d+$/, '')
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
}

/**
 * A new section from a tick, as long as asked -- or as long as there is room
 * for, when another begins sooner. None at all on top of one already there.
 */
export function addSection(song: Song, tick: number, length: number, name?: string): Song {
  const at = Math.max(0, Math.round(tick))
  if (sectionOver(song, at)) return song
  const next = sectionsOf(song).find((s) => s.tick > at)
  const room = Math.min(Math.round(length), next ? next.tick - at : Infinity)
  if (!(room > 0)) return song
  const label = uniqueSectionName(song, name?.trim() || `Section ${(song.sections?.length ?? 0) + 1}`)
  return withSections(song, [...(song.sections ?? []), { tick: at, length: room, name: label }])
}

export function renameSection(song: Song, tick: number, name: string): Song {
  const trimmed = name.trim()
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  if (!s || !trimmed || s.name === trimmed) return song
  const others = { ...song, sections: song.sections!.filter((x) => x !== s) }
  const label = uniqueSectionName(others, trimmed)
  return withSections(song, song.sections!.map((x) => (x === s ? { ...x, name: label } : x)))
}

/** A hue, or null for none. */
export function colorSection(song: Song, tick: number, color: number | null): Song {
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  if (!s || (s.color ?? null) === color) return song
  return withSections(
    song,
    song.sections!.map((x) => {
      if (x !== s) return x
      const { color: _, ...rest } = x
      return color === null ? rest : { ...rest, color }
    }),
  )
}

/** The label goes, and nothing else: every clip it covered stays where it is. */
export function removeSection(song: Song, tick: number): Song {
  const sections = (song.sections ?? []).filter((s) => s.tick !== tick)
  if (sections.length === (song.sections ?? []).length) return song
  return withSections(song, sections)
}

/**
 * Move one edge of a section to a tick, as far as its neighbours and a
 * minimum length allow. Only the label: the music under it does not move.
 */
export function resizeSection(song: Song, tick: number, edge: 'start' | 'end', at: number, minimum: number): Song {
  const all = sectionsOf(song)
  const i = all.findIndex((s) => s.tick === tick)
  if (i < 0) return song
  const s = all[i]
  const end = sectionEnd(s)
  const min = Math.max(1, Math.round(minimum))
  const to = Math.round(at)
  let next: Section
  if (edge === 'start') {
    const floor = i > 0 ? sectionEnd(all[i - 1]) : 0
    const start = Math.max(floor, Math.min(to, end - min))
    if (start === s.tick) return song
    next = { ...s, tick: start, length: end - start }
  } else {
    const ceiling = i < all.length - 1 ? all[i + 1].tick : Infinity
    const stop = Math.min(ceiling, Math.max(to, s.tick + min))
    if (stop === end) return song
    next = { ...s, length: stop - s.tick }
  }
  return withSections(song, all.map((x) => (x === s ? next : x)))
}

/**
 * Cut the section a tick falls in into two there. The first half keeps the
 * name; the second is named after it. Only the labels change.
 */
export function splitSection(song: Song, at: number): Song {
  const cut = Math.round(at)
  const s = sectionOver(song, cut)
  if (!s || cut <= s.tick) return song
  const second = { ...s, tick: cut, length: sectionEnd(s) - cut, name: uniqueSectionName(song, s.name) }
  return withSections(song, [...song.sections!.map((x) => (x === s ? { ...x, length: cut - x.tick } : x)), second])
}

/**
 * Move a section, and its music, to a place in the order of sections:
 * `toIndex` counts the gaps between them as they stand, so 0 is before the
 * first and the number of sections is after the last. Its own place, on
 * either side of it, is where it already is.
 *
 * Everything between it and where it lands moves over by its length to make
 * room: the song is the same length after, and in the same order apart from
 * the section that moved. Clips across the edges it leaves and lands on are
 * split there first, so nothing plays differently except for where it plays.
 */
export function moveSection(song: Song, tick: number, toIndex: number): Song {
  const all = sectionsOf(song)
  const from = all.findIndex((s) => s.tick === tick)
  if (from < 0 || toIndex === from || toIndex === from + 1) return song
  const moving = all[from]
  const s = moving.tick
  const len = moving.length
  const e = s + len

  // Lift the section's clips out, and close the song up behind them.
  let out = cutAt(cutAt(song, s), e)
  const lifted = out.playlist.filter((p) => p.tick >= s && p.tick < e)
  out = {
    ...out,
    playlist: out.playlist.filter((p) => !(p.tick >= s && p.tick < e)).map((p) => (p.tick >= e ? { ...p, tick: p.tick - len } : p)),
    sections: all.filter((x) => x !== moving).map((x) => (x.tick >= e ? { ...x, tick: x.tick - len } : x)),
  }

  // Where it lands, now that it has gone.
  const others = out.sections!
  const index = toIndex > from ? toIndex - 1 : toIndex
  const at = index < others.length ? others[index].tick : Math.max(...others.map(sectionEnd))
  if (!Number.isFinite(at)) return song

  // Open the song up there and put it back.
  out = cutAt(out, at)
  out = {
    ...out,
    playlist: [
      ...out.playlist.map((p) => (p.tick >= at ? { ...p, tick: p.tick + len } : p)),
      ...lifted.map((p) => ({ ...p, tick: p.tick - s + at })),
    ],
    sections: [...others.map((x) => (x.tick >= at ? { ...x, tick: x.tick + len } : x)), { ...moving, tick: at }],
  }
  return normalizeSong(out)
}

/**
 * A copy of a section and its music, straight after it. What comes after
 * moves over to make room; the copy is named after the original.
 */
export function duplicateSection(song: Song, tick: number): Song {
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  if (!s) return song
  const e = sectionEnd(s)
  let out = cutAt(cutAt(song, s.tick), e)
  const copies = out.playlist.filter((p) => p.tick >= s.tick && p.tick < e).map((p) => ({ ...p, tick: p.tick + s.length }))
  out = {
    ...out,
    playlist: [...out.playlist.map((p) => (p.tick >= e ? { ...p, tick: p.tick + s.length } : p)), ...copies],
    sections: [
      ...out.sections!.map((x) => (x.tick >= e ? { ...x, tick: x.tick + s.length } : x)),
      { ...s, tick: e, name: uniqueSectionName(song, s.name) },
    ],
  }
  return normalizeSong(out)
}

/**
 * The sections a file from before sections had lengths is read as: each of
 * its markers running to the next, and the last to the end of the song -- or
 * for a bar, when nothing is arranged past it.
 */
export function sectionsFromMarkers(song: Song, markers: readonly { tick: number; name: string }[]): Section[] {
  const sorted = [...markers].sort((a, b) => a.tick - b.tick)
  const end = songEnd(song)
  return sorted
    .map((m, i) => {
      const next = sorted[i + 1]
      const to = next ? next.tick : Math.max(end, m.tick + barTicks(song))
      return { tick: m.tick, length: to - m.tick, name: m.name }
    })
    .filter((s) => s.length > 0)
}

/**
 * Split every clip that runs across a tick, there. Changes nothing that is
 * heard: a split clip plays exactly what the whole one did.
 */
export function cutAt(song: Song, at: number): Song {
  let out = song
  const patterns = new Map(song.patterns.map((p) => [p.id, p]))
  // From the end, so a split -- which puts its second half straight after
  // the first -- never moves a clip still to be looked at.
  for (let i = song.playlist.length - 1; i >= 0; i--) {
    const place: Placement = song.playlist[i]
    const pattern = patterns.get(place.pattern)
    if (pattern && place.tick < at && clipEnd(place, pattern) > at) out = splitClip(out, i, at)
  }
  return out
}

function withSections(song: Song, sections: Section[]): Song {
  const { sections: _, ...rest } = song
  return sections.length ? { ...rest, sections: [...sections].sort((a, b) => a.tick - b.tick) } : rest
}

/**
 * Slide a section, and its music, to start at another tick, where no other
 * section is. Nothing else moves: where it was is left empty, and anything
 * already where it lands -- music no section covers -- stays and plays with
 * it. Refused if it would land on another section; that is `moveSection`.
 */
export function slideSection(song: Song, tick: number, to: number): Song {
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  const at = Math.max(0, Math.round(to))
  if (!s || at === s.tick || !roomFor(song, s, at)) return song
  const e = sectionEnd(s)
  const by = at - s.tick
  const out = cutAt(cutAt(song, s.tick), e)
  return normalizeSong({
    ...out,
    playlist: out.playlist.map((p) => (p.tick >= s.tick && p.tick < e ? { ...p, tick: p.tick + by } : p)),
    sections: out.sections!.map((x) => (x === s ? { ...x, tick: at } : x)),
  })
}

/** Whether a section would fit at a tick without landing on another. */
export function roomFor(song: Song, section: Section, at: number): boolean {
  const end = at + section.length
  return at >= 0 && !(song.sections ?? []).some((x) => x.tick !== section.tick && x.tick < end && sectionEnd(x) > at)
}

/**
 * Take a section out with its bars: its clips go, and everything after it
 * moves back to close the gap. The other way to remove one -- `removeSection`
 * -- takes only the label.
 */
export function deleteSectionAndMusic(song: Song, tick: number): Song {
  const s = (song.sections ?? []).find((x) => x.tick === tick)
  if (!s) return song
  const e = sectionEnd(s)
  const out = cutAt(cutAt(song, s.tick), e)
  return normalizeSong({
    ...out,
    playlist: out.playlist
      .filter((p) => !(p.tick >= s.tick && p.tick < e))
      .map((p) => (p.tick >= e ? { ...p, tick: p.tick - s.length } : p)),
    sections: out.sections!.filter((x) => x !== s).map((x) => (x.tick >= e ? { ...x, tick: x.tick - s.length } : x)),
  })
}
