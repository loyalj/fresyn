import type { EngineEvent } from '../dsp/GraphEngine'
import type { TrackEvent } from '../dsp/SongEngine'
import { defOf } from '../patch/defs'
import type { Patch } from '../patch/types'
import type { SongEvent } from './schedule'

/**
 * Which module in a patch a track's notes are played on, and how.
 *
 * A rack is not an instrument until something in it accepts a note, and the
 * two ways it can are different enough to be worth naming. A patch with a
 * Keyboard in it is pitched: notes carry a pitch and a velocity and it plays
 * a line. A patch without one -- a coin, a laser, a footstep -- is a drum:
 * the Trigger is the way in, the pitch means nothing, and a row in the roll
 * is a rhythm.
 *
 * Both are found through the catalogue, so a module added later that takes
 * notes needs no change here.
 */
export interface NoteTarget {
  module: string
  kind: 'note' | 'trigger'
}

export function noteTarget(patch: Patch): NoteTarget | null {
  // A keyboard first, wherever it sits in the rack: a patch with both is
  // pitched, and the Trigger in it is something the pitched voice is fired
  // by rather than a second instrument.
  for (const m of patch.modules) {
    if (defOf(m.type).playable) return { module: m.id, kind: 'note' }
  }
  // `keyed` and not `trigger`, because half the rack has a trigger button --
  // the sequencer, the burst, the envelope -- and firing one of those from
  // the roll would play something in the middle of the patch rather than
  // playing the patch. `keyed` is the module a pair of hands reaches.
  for (const m of patch.modules) {
    if (defOf(m.type).keyed) return { module: m.id, kind: 'trigger' }
  }
  return null
}

/**
 * Translate a track's events into things the engine can do.
 *
 * The one place the song layer and the rack layer meet. Everything above this
 * counts in ticks and tracks; everything below it counts in samples and
 * module ids.
 *
 * Notes either way, including on a drum track. A plain gate would do
 * everything a Trigger needs except the one thing that matters: two hits
 * landing on the same sixteenth would close and reopen it between samples and
 * the second would never be heard. A note is what carries the retrigger, so
 * both kinds of track go down the same path and only the UI above cares which
 * is which. What `kind` decides is whether the roll draws a keyboard of
 * pitches or a single lane of hits -- a patch with no Keyboard has no pitch to
 * offer, and the Trigger keeps its velocity and throws the pitch away.
 */
export function engineEvents(events: readonly SongEvent[], target: NoteTarget): EngineEvent[] {
  return events.map((e) =>
    e.kind === 'on'
      ? {
          frame: e.frame,
          kind: 'noteOn' as const,
          module: target.module,
          pitch: e.pitch ?? 0,
          velocity: e.velocity,
        }
      : // The pitch rides along so a chord knows which of its notes let go.
        // None at all is every note, and is passed on as none rather than as
        // zero: the engine reads a missing pitch as "release every voice".
        e.pitch === undefined
        ? { frame: e.frame, kind: 'noteOff' as const, module: target.module }
        : { frame: e.frame, kind: 'noteOff' as const, module: target.module, pitch: e.pitch },
  )
}

/**
 * The same translation for a song with several tracks in it.
 *
 * Order is preserved across tracks, which is what keeps a release sorted
 * before the press that follows it: the engine applies events in the order it
 * was given them when two land on one sample.
 */
export function engineEventsByTrack(
  events: readonly SongEvent[],
  targets: ReadonlyMap<string, NoteTarget>,
): TrackEvent[] {
  const out: TrackEvent[] = []
  for (const e of events) {
    // A track whose patch has nothing to play is silently skipped. That is an
    // ordinary state, not an error: a rack being built has no way in yet.
    const target = targets.get(e.track)
    if (!target) continue
    for (const ev of engineEvents([e], target)) out.push({ ...ev, track: e.track })
  }
  return out
}
