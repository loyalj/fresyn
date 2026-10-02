import type { CompiledPatch } from '../patch/compile'
import type { Console } from '../song/types'
import type { SampleRecord } from './samples'
import type { MixLevels, TrackEvent, TrackMix, TrackSetup } from './SongEngine'

/**
 * The wire between the main thread and the worklet, in both directions.
 *
 * It lives in its own module, with nothing but types in it, because both ends
 * need the same definition and neither end can import the other: the worklet
 * is bundled on its own and loaded into a scope with no DOM, and the engine
 * must not drag the processor class into the page. A message shape written
 * down once is one that cannot drift -- before this, the processor had a
 * union the engine never saw, and a renamed field would have gone silently
 * undelivered rather than failing to compile.
 */

/**
 * Initial state handed to the processor at construction. The tracks must
 * arrive this way rather than by message: a message posted before
 * `startRendering()` is never delivered to the processor, so a message-driven
 * setup renders silence offline.
 */
export interface ProcessorOptions {
  /**
   * One rack per track. A single rack is a song with one track in it, and a
   * song with none is allowed: tracks can be added by message afterwards, and
   * an empty project must still be able to open the audio device.
   */
  tracks?: TrackSetup[]
  /** Open the gate on the first sample. Used by offline renders. */
  autoGate?: boolean
  seed?: number
  /**
   * Audio the patches play, for the same reason the tracks come this way: a
   * message posted before `startRendering()` never arrives, so an offline
   * render that waited for one would render silence where the samples should
   * be.
   */
  samples?: SampleRecord[]
  /** Which track's scopes and meters to report; the rack on the bench. */
  watch?: string
  /**
   * How the tracks reach the mix, and the song's desk. Here as well as by
   * message, for the reason everything else is: set before the processor
   * existed, a message would have gone nowhere and the song would have
   * played at the wrong levels until something else changed.
   */
  mix?: Record<string, TrackMix>
  console?: Console
  /**
   * Memory the processor writes its display reports into, where the page
   * can share it: see `TelemetryLayout`. Absent where the page cannot share
   * memory, which leaves the reports going as messages.
   */
  telemetry?: SharedArrayBuffer
}

/** Everything the main thread says to the processor after it is built. */
export type ToWorklet =
  | { type: 'param'; track: string; index: number; value: number }
  | { type: 'gate'; track: string; module: string; open: boolean }
  | { type: 'track'; id: string; patch: CompiledPatch; params: number[] }
  | { type: 'removeTrack'; id: string }
  | { type: 'mix'; mix: Record<string, TrackMix> }
  | { type: 'console'; console: Console }
  | { type: 'watch'; track: string }
  // Audio the processor has not had yet. Added to what it has, never in
  // place of it: the library only ever grows, so each file is sent once --
  // and where memory can be shared, what is sent is a handle on the page's
  // own copy rather than a copy.
  | { type: 'addSamples'; samples: SampleRecord[] }
  // The transport, filling a window of the song a few hundred milliseconds
  // ahead of what is being heard.
  | { type: 'schedule'; events: readonly TrackEvent[] }
  | { type: 'seek'; frame: number }
  | { type: 'unschedule' }
  | { type: 'allNotesOff' }

/**
 * Where a report lands in the shared telemetry, in floats from the start of
 * a slot.
 *
 * The memory is two slots, written in turn, so the page reads one while the
 * processor fills the other. What goes where only changes when the rack on
 * the bench does, so it is sent once, as a message, and each report after
 * says only which slot it is in.
 */
export interface TelemetryLayout {
  /** Each meter's levels, as `Metering.levels` gives them. */
  levels: { id: string; at: number; length: number }[]
  /** Each scope's frame, and a second trace as its own entry under `id.b`. */
  scopes: { id: string; at: number; length: number }[]
  /**
   * The Mix view's levels: each track's peak in this order, then the
   * master's peak, momentary and short-term loudness.
   */
  mixAt: number
  tracks: string[]
}

/**
 * Everything the processor says back, ~30 times a second: a display frame.
 *
 * As one message, with everything in it, where memory cannot be shared.
 * Levels and scopes are left out when the watched track has nothing that
 * publishes them, which is why they are optional and the mix is not.
 *
 * Where it can, the frame is written to the shared telemetry and the message
 * is only the clock and which slot to read, with the layout sent ahead of the
 * first frame it applies to.
 */
export type FromWorklet =
  | {
      type: 'frame'
      /** Where the transport has reached, in samples. */
      frame: number
      levels?: Record<string, Float32Array>
      scopes?: Record<string, Float32Array>
      mix: MixLevels
    }
  | { type: 'layout'; layout: TelemetryLayout }
  | { type: 'tick'; frame: number; slot: number }
