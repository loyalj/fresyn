import { quantizeNotes, type QuantizeOptions } from './noteEdit'
import type { Loop } from './transport'
import { PPQ, type Note } from './types'

/**
 * Notes played in while the song runs, written into the pattern being edited.
 *
 * Pure, like the rest of this layer: the roll hands in where the playhead was
 * heard when a key went down and when it came up, and this says what note
 * that was. The awkward parts are all arithmetic -- a note held across the
 * loop's seam, a pattern heard in the song rather than on its own, a note
 * that runs off the end -- and are pinned down in check:song.
 */

/**
 * The shortest note a take writes. A tap quicker than one report of the
 * playhead would otherwise come out zero ticks long, which cannot be seen
 * or heard; a sixty-fourth is short enough to be a hit and long enough to
 * be grabbed.
 */
export const MIN_RECORDED = PPQ / 16

/** A key that went down while recording, waiting for its release. */
export interface HeldNote {
  /** Where the playhead was heard when it went down, in song ticks. */
  start: number
  pitch: number
  velocity: number
}

/** How to quantize what is played in, or nothing to leave it as played. */
export interface InputQuantize extends QuantizeOptions {
  grid: number
}

/**
 * Ticks from one playhead reading to a later one. A loop between them means
 * the second can read earlier than the first: that is a note held over the
 * seam, and it lasted to the end and on from the top.
 */
export function spanTicks(from: number, to: number, loop: Loop | null): number {
  let d = to - from
  if (d < 0 && loop && loop.to > loop.from) d += loop.to - loop.from
  return Math.max(0, d)
}

/**
 * A song tick as a tick in the pattern, whose own tick zero is at `zero` in
 * the song and which repeats every `length`. Null outside the stretch
 * `[zero, zero + span)` the pattern is being played over -- a take heard over
 * the song does not write the bars either side of the pattern into it.
 */
export function patternTick(songTick: number, zero: number, length: number, span = length): number | null {
  if (!(length > 0)) return null
  const into = songTick - zero
  if (into < 0 || into >= span) return null
  return Math.floor(((into % length) + length) % length)
}

/**
 * The note a released key makes, or null when it went down somewhere the
 * pattern is not playing. Cut at the end of the pattern rather than wrapped
 * round to the front: a held note is one note.
 */
export function recordedNote(
  track: string,
  held: HeldNote,
  end: number,
  zero: number,
  length: number,
  loop: Loop | null,
  quantize?: InputQuantize,
): Note | null {
  const tick = patternTick(held.start, zero, length)
  if (tick === null) return null
  const played = Math.max(MIN_RECORDED, Math.round(spanTicks(held.start, end, loop)))
  let note: Note = {
    track,
    tick,
    length: Math.max(1, Math.min(played, length - tick)),
    pitch: held.pitch,
    velocity: held.velocity,
  }
  if (quantize && quantize.grid > 0) note = quantizeNotes([note], [0], quantize.grid, length, quantize).notes[0]
  return note
}

/**
 * Notes with a recorded one added. A note already on the same row at the
 * same tick is replaced rather than doubled, so a second pass round the
 * loop playing the same part again does not stack two notes on every hit.
 */
export function addRecorded(notes: readonly Note[], note: Note): Note[] {
  const out = notes.filter((n) => !(n.track === note.track && n.tick === note.tick && n.pitch === note.pitch))
  out.push(note)
  return out
}
