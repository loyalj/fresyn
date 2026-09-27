import { framesPerTick, songEnd, songEventTicks, type SongEvent } from './schedule'
import type { Song } from './types'

/**
 * Filling a window of the song ahead of the speakers.
 *
 * The audio thread is handed events stamped with the sample they happen on,
 * so something has to decide which events to hand over and when. That is all
 * this is: a cursor walked forward through the arrangement, a few hundred
 * milliseconds at a time, converting ticks into engine frames as it goes.
 *
 * Pure, and separate from the thing that talks to the engine, because the
 * arithmetic is where the bugs are -- a window that drops the note on its far
 * edge, or plays the one on its near edge twice, or drifts a sample every
 * time round a loop -- and none of that needs an AudioContext to catch.
 */

export interface Cursor {
  /** Where in the song the next fill starts, in ticks. */
  tick: number
  /**
   * The engine frame that tick lands on. Deliberately fractional: rounding
   * the cursor rather than each event would accumulate up to half a sample
   * per window, which over a few minutes is an audible drift.
   */
  frame: number
}

export interface Loop {
  from: number
  to: number
}

export interface Fill {
  /** Ready to schedule, in engine time, oldest first. */
  events: SongEvent[]
  cursor: Cursor
  /** The song ran off its end and is not looping. */
  ended: boolean
}

/**
 * How many times round a loop one fill may go before giving up.
 *
 * A loop shorter than the lookahead is legitimate -- a one-beat pattern at a
 * fast tempo -- so the fill has to be able to go round several times. This is
 * only here so that a loop of a single tick cannot hang the audio thread.
 */
const MAX_PASSES = 512

export function fill(
  song: Song,
  sampleRate: number,
  cursor: Cursor,
  untilFrame: number,
  loop: Loop | null,
): Fill {
  const events: SongEvent[] = []
  const fpt = framesPerTick(song.tempo, sampleRate)
  if (!(fpt > 0)) return { events, cursor, ended: true }
  // A loop with no length would be an infinite number of passes over nothing.
  if (loop && !(loop.to > loop.from)) return { events, cursor, ended: false }

  const end = loop ? loop.to : songEnd(song)
  let { tick, frame } = cursor
  let ended = false
  let passes = 0

  while (frame < untilFrame && passes++ < MAX_PASSES) {
    if (tick >= end) {
      if (!loop) {
        ended = true
        break
      }
      // Everything let go at the seam. A note still sounding when the pattern
      // comes round has nothing left to close it -- its own note-off is at a
      // tick the cursor has just jumped away from -- and the rack would drone
      // through the rest of the session. Closing a gate that is already shut
      // costs nothing, so this is done for every track rather than by working
      // out which ones are actually holding something.
      for (const t of song.tracks) {
        events.push({ frame: Math.round(frame), track: t.id, kind: 'off', pitch: 0, velocity: 0 })
      }
      tick = loop.from
      continue
    }

    // Exactly as far as the lookahead reaches, unless the end of the loop
    // arrives first. Fractional ticks are fine here: nothing is rounded until
    // an event is given its frame.
    const reach = (untilFrame - frame) / fpt
    const windowEnd = Math.min(tick + reach, end)

    for (const e of songEventTicks(song, tick, windowEnd)) {
      // Measured from the cursor rather than from the start of the song, so
      // that a loop's tenth pass is stamped where it is actually playing.
      events.push({
        frame: Math.round(frame + (e.tick - tick) * fpt),
        track: e.track,
        kind: e.kind,
        pitch: e.pitch,
        velocity: e.velocity,
      })
    }

    frame += (windowEnd - tick) * fpt
    tick = windowEnd
  }

  return { events, cursor: { tick, frame }, ended }
}

/**
 * Where the playhead is, for an engine frame that has just been reported.
 *
 * Worked out from the tempo rather than tracked alongside the cursor, because
 * the cursor is several hundred milliseconds ahead of what anybody is hearing
 * and drawing the playhead there would put it visibly in front of the sound.
 */
export function playheadTick(
  frame: number,
  startFrame: number,
  startTick: number,
  tempo: number,
  sampleRate: number,
  loop: Loop | null,
): number {
  const fpt = framesPerTick(tempo, sampleRate)
  if (!(fpt > 0)) return startTick
  const elapsed = (frame - startFrame) / fpt
  if (!loop || !(loop.to > loop.from)) return startTick + elapsed

  const length = loop.to - loop.from
  const into = startTick - loop.from + elapsed
  // A true modulo: the playhead can be asked about a frame slightly before
  // the one playback started on, and a negative remainder would draw it past
  // the end of the loop rather than just inside it.
  return loop.from + (((into % length) + length) % length)
}
