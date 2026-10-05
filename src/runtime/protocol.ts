import type { NoteTiming, SectionInfo, SectionTiming, SongClock, SongKey } from '../song/game'

/**
 * The wire between a game and the runtime's worklet, in both directions.
 *
 * Types only, for the reason `dsp/protocol.ts` is: the worklet is bundled on
 * its own and the page must not drag the processor in, so the one place both
 * ends agree on a message's shape is a module neither has to import code
 * from.
 */

/**
 * How a player comes round. `'song'` is the song's own loop where it has
 * one and the whole arrangement where it does not, which is what music
 * wants; `null` plays once, which is what a bank of sound effects wants.
 */
export type LoopSetup = 'song' | null | { from: number; to: number }

/** What a game is told about a project once it is loaded. */
export interface PlayerInfo {
  id: string
  /** Every track, by name. */
  tracks: string[]
  /** The tracks a note can be played on. */
  playable: string[]
  sections: SectionInfo[]
  key: SongKey | null
  /** Beats per minute at the start, as written. */
  tempo: number
  /** Every knob `param` can reach, by track name, as `module.param`. */
  params: Record<string, string[]>
}

/**
 * Where a grid-timed note takes its grid from. Left out, a player's own
 * song; named, another player's -- which is how a bank of sound effects that
 * has no music of its own lands a laser on the music's sixteenth.
 */
export interface Timed {
  when?: NoteTiming
  sync?: string
}

/** Everything a game says to the runtime. Every message but `master` names a player by `id`. */
export type ToRuntime =
  | { type: 'load'; id: string; request: number; project: string; loop?: LoopSetup; seed?: number }
  | { type: 'unload'; id: string }
  // Start from the top, or from a section, and fade up to `gain`.
  | { type: 'start'; id: string; section?: string; loop?: boolean; gain?: number; fade?: number }
  // Fade out, let go of every note, and stop rendering: a stopped player costs nothing.
  | { type: 'stop'; id: string; fade?: number }
  | { type: 'section'; id: string; name: string; when?: SectionTiming; loop?: boolean }
  | { type: 'release'; id: string }
  | { type: 'param'; id: string; track: string; knob: string; value: number }
  | { type: 'releaseParam'; id: string; track: string; knob: string }
  | ({ type: 'note'; id: string; track: string; pitch: number; velocity: number; length?: number } & Timed)
  | { type: 'noteOff'; id: string; track: string; pitch?: number }
  | ({ type: 'trigger'; id: string; track: string; velocity: number } & Timed)
  | { type: 'track'; id: string; track: string; gain?: number; pan?: number; mute?: boolean }
  | { type: 'tempo'; id: string; scale: number }
  // The player's own bus, after its master: a level, and a low-pass from 0
  // (open) to 1 (as if through a wall), each gliding over `glide` seconds.
  | { type: 'bus'; id: string; gain?: number; muffle?: number; glide?: number }
  | { type: 'master'; gain: number }

/** One player's state, as of the report it came in. */
export interface PlayerReport {
  playing: boolean
  clock: SongClock
  section: string | null
  /** Each track's peak since the last report, by name. */
  levels: Record<string, number>
  master: number
}

/** Everything the runtime says back. */
export type FromRuntime =
  | { type: 'loaded'; request: number; info: PlayerInfo }
  | { type: 'failed'; request: number; message: string }
  // About sixty times a second. `time` is the audio clock the report was
  // made at, in seconds, which is how a game puts the beat on the screen at
  // the moment it reaches the speakers rather than when the message landed.
  | { type: 'report'; time: number; players: Record<string, PlayerReport> }
