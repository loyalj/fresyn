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
  | { type: 'samples'; samples: SampleRecord[] }
  // The transport, filling a window of the song a few hundred milliseconds
  // ahead of what is being heard.
  | { type: 'schedule'; events: readonly TrackEvent[] }
  | { type: 'seek'; frame: number }
  | { type: 'unschedule' }
  | { type: 'allNotesOff' }

/**
 * Everything the processor says back: one display frame, ~30 times a second.
 *
 * Levels and scopes are left out when the watched track has nothing that
 * publishes them, which is why they are optional and the mix is not.
 */
export type FromWorklet = {
  type: 'frame'
  /** Where the transport has reached, in samples. */
  frame: number
  levels?: Record<string, Float32Array>
  scopes?: Record<string, Float32Array>
  mix: MixLevels
}
