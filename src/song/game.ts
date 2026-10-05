/**
 * The words a game and a playing song share: when a change happens, where
 * the music is, what key it is in.
 *
 * Types and nothing else, with no imports, so the runtime's client can hand a
 * game their definitions without handing it the engine. `runtime.ts` is
 * where they are used.
 */

/**
 * When a change of section happens: straight away, or on the next beat, bar
 * line, or end of the section playing now. Music that changes on the beat
 * sounds written; music that changes mid-note sounds like a bug.
 */
export type SectionTiming = 'now' | 'beat' | 'bar' | 'section'

export interface SectionInfo {
  name: string
  /** Where it starts and stops, in ticks. */
  from: number
  to: number
}

/**
 * When a note the game plays is heard: straight away, or on the next line of
 * the song's grid. A laser that fires on the sixteenth is part of the music;
 * one that fires whenever the button went down is a sound effect over it.
 */
export type NoteTiming = 'now' | '32nd' | '16th' | '8th' | 'beat' | 'bar'

/** Where the song is, as a game would want to draw it: what bar, what beat, how far into it. */
export interface SongClock {
  tick: number
  /** From nought. */
  bar: number
  /** The beat within the bar, from nought. */
  beat: number
  /** How far through that beat, 0 up to 1. */
  phase: number
  beatsPerBar: number
  /** The tempo heard now, after any change of tempo the game has made. */
  bpm: number
}

/** The song's key, as the roll set it: a tonic counted up from C, and its scale's steps. */
export interface SongKey {
  root: number
  mode: string
  steps: number[]
}
