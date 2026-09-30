import type { EngineEvent } from '../dsp/GraphEngine'
import type { TrackEvent } from '../dsp/SongEngine'
import { defOf } from '../patch/defs'
import { kitSlots, padModuleId, padTarget } from '../patch/kit'
import type { Patch, PatchModule } from '../patch/types'
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
  /**
   * A Keyboard, a Trigger, or a Drum Kit -- whose notes each play whichever
   * of its pads is on that note, and nothing where no pad is.
   */
  kind: 'note' | 'trigger' | 'kit'
  /** For a kit: its pads, by the row a note is written on. See `KitHit`. */
  pads?: ReadonlyMap<number, readonly KitHit[]>
}

/** One pad of a kit, as a note on its row reaches it. */
export interface KitHit {
  /** Which pad, from nought: what the kit is told, for its choke groups. */
  slot: number
  /** The module inside the pad the note is played on, by its laid-in id. */
  module: string
  /** A Keyboard, which is played its bottom key; a Trigger takes no pitch. */
  pitched: boolean
  name: string
}

/**
 * The row a note on a pad is written on: the pad's MIDI note, counted the
 * way the roll counts rows on a track with no tuning to read, so the row a
 * kick is on reads C2 -- MIDI 36, where General MIDI puts a kick.
 */
export const KIT_ROW_ZERO = 12
export const kitRow = (note: number) => note - KIT_ROW_ZERO

export function noteTarget(patch: Patch): NoteTarget | null {
  // A keyboard first, wherever it sits in the rack: a patch with both is
  // pitched, and the Trigger in it is something the pitched voice is fired
  // by rather than a second instrument.
  for (const m of patch.modules) {
    if (defOf(m.type).playable) return { module: m.id, kind: 'note' }
  }
  // A Drum Kit before a Trigger: a rack built round a kit often has a
  // Trigger on Space to audition it, and the roll is for the kit.
  for (const m of patch.modules) {
    if (m.type === 'kit') return { module: m.id, kind: 'kit', pads: kitPads(m) }
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
  if (target.kind === 'kit') return kitEvents(events, target)
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

/** A Drum Kit as a target in its own right, whatever else is in its rack: for auditioning a pad. */
export function kitTarget(kit: PatchModule): NoteTarget {
  return { module: kit.id, kind: 'kit', pads: kitPads(kit) }
}

/** A kit's pads by row, from what is loaded in it. */
function kitPads(kit: PatchModule): Map<number, KitHit[]> {
  const pads = new Map<number, KitHit[]>()
  kitSlots(kit).forEach((slot, i) => {
    if (!slot) return
    const target = padTarget(slot.patch)
    if (!target) return
    const row = kitRow(slot.note)
    const hit = { slot: i, module: padModuleId(kit.id, i, target.module), pitched: target.pitched, name: slot.name }
    pads.set(row, [...(pads.get(row) ?? []), hit])
  })
  return pads
}

/**
 * A kit's notes: each to the pads on its row, by the module inside the pad,
 * and the kit told which pad was struck so it can choke the rest of its
 * group. A note on a row no pad is on plays nothing. A release for every
 * note -- a loop's seam -- lets go of every pad.
 */
function kitEvents(events: readonly SongEvent[], target: NoteTarget): EngineEvent[] {
  const out: EngineEvent[] = []
  const pads = target.pads ?? new Map<number, readonly KitHit[]>()
  for (const e of events) {
    if (e.kind === 'on') {
      for (const hit of pads.get(e.pitch ?? NaN) ?? []) {
        out.push({ frame: e.frame, kind: 'noteOn', module: target.module, pitch: hit.slot, velocity: e.velocity })
        out.push({ frame: e.frame, kind: 'noteOn', module: hit.module, pitch: 0, velocity: e.velocity })
      }
    } else {
      const hits = e.pitch === undefined ? [...pads.values()].flat() : (pads.get(e.pitch) ?? [])
      for (const hit of hits) out.push({ frame: e.frame, kind: 'noteOff', module: hit.module, pitch: 0 })
    }
  }
  return out
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
