import { songEnd, songEventTicks, type SongEvent } from './schedule'
import { tempoMap, type TempoMap } from './timeline'
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

/** A place the song jumped: at `frame`, from `before` back to `tick`. */
export interface Seam extends Cursor {
  before: number
}

export interface Fill {
  /** Ready to schedule, in engine time, oldest first. */
  events: SongEvent[]
  cursor: Cursor
  /**
   * Every time round the loop, in order: where the song went back to the
   * start of it. A caller that has to say which tick is being heard at a
   * given frame needs these; the arithmetic between them is a straight line.
   */
  seams: Seam[]
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
  const seams: Seam[] = []
  const time = tempoMap(song, sampleRate)
  if (!(time.rateAt(cursor.tick) > 0)) return { events, cursor, seams, ended: true }
  // A loop with no length would be an infinite number of passes over nothing.
  if (loop && !(loop.to > loop.from)) return { events, cursor, seams, ended: false }

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
      //
      // With no pitch, which the engine reads as every voice rather than a
      // voice on pitch zero: a chord pad holding three notes across the seam
      // has three voices to let go of, and naming any one pitch would leave
      // the other two sounding on every pass until the polyphony ran out.
      for (const t of song.tracks) {
        events.push({ frame: Math.round(frame), track: t.id, kind: 'off', velocity: 0 })
      }
      seams.push({ frame, tick: loop.from, before: tick })
      tick = loop.from
      continue
    }

    // Exactly as far as the lookahead reaches, unless the end of the loop
    // arrives first. Fractional ticks are fine here: nothing is rounded until
    // an event is given its frame. Through the tempo map, so a window
    // reaching across a change of tempo reaches the right tick.
    const windowEnd = Math.min(time.advance(tick, untilFrame - frame), end)

    // The window is half-open, so a note-off landing exactly on the end would
    // belong to the next window -- and there is no next window: the song
    // stops or wraps first. That is the last note of every song, which would
    // otherwise hang until the stop, or through the whole tail of a bounce.
    // So a window reaching the end also takes the releases sitting on it.
    // Only releases: a press on `end` belongs past the loop or the song, and
    // one at the start of the loop is picked up by the window after the wrap.
    const edge =
      windowEnd === end
        ? songEventTicks(song, end, end + 1).filter((e) => e.kind === 'off' && e.tick === end)
        : []

    const inWindow = songEventTicks(song, tick, windowEnd)
    if (edge.length) inWindow.push(...edge)

    for (const e of inWindow) {
      // Measured from the cursor rather than from the start of the song, so
      // that a loop's tenth pass is stamped where it is actually playing.
      events.push({
        frame: Math.round(frame + time.span(tick, e.tick)),
        track: e.track,
        kind: e.kind,
        pitch: e.pitch,
        velocity: e.velocity,
      })
    }

    frame += time.span(tick, windowEnd)
    tick = windowEnd
  }

  return { events, cursor: { tick, frame }, seams, ended }
}

/**
 * Where the playhead is, for an engine frame that has just been reported.
 *
 * Worked out from the tempo rather than tracked alongside the cursor, because
 * the cursor is several hundred milliseconds ahead of what anybody is hearing
 * and drawing the playhead there would put it visibly in front of the sound.
 *
 * Counted in frames and turned into a tick only at the end, since with the
 * tempo changing a pass round the loop is a number of frames, not a number of
 * ticks that can be divided out.
 */
export function playheadTick(
  frame: number,
  startFrame: number,
  startTick: number,
  time: TempoMap,
  loop: Loop | null,
): number {
  if (!(time.rateAt(startTick) > 0)) return startTick
  const elapsed = frame - startFrame
  if (!loop || !(loop.to > loop.from)) return time.advance(startTick, elapsed)

  // Only wrapped once it is actually past the end of the loop, which is what
  // `fill` does with the audio. A start before the loop plays straight up to
  // it first, and drawing that folded into the loop would put the playhead a
  // bar or two away from what is sounding. A start at or past the end is
  // wrapped straight to the top, again as `fill` does.
  const pass = time.span(loop.from, loop.to)
  const start = startTick >= loop.to ? loop.from : startTick
  if (start < loop.from) {
    const lead = time.span(start, loop.to)
    if (elapsed < lead) return time.advance(start, elapsed)
    return time.advance(loop.from, mod(elapsed - lead, pass))
  }
  // A true modulo: the playhead can be asked about a frame slightly before
  // the one playback started on, and a negative remainder would draw it past
  // the end of the loop rather than just inside it.
  const into = time.span(loop.from, start) + elapsed
  return into >= 0 && into < pass ? time.advance(start, elapsed) : time.advance(loop.from, mod(into, pass))
}

const mod = (n: number, m: number) => ((n % m) + m) % m
