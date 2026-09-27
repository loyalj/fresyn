import type { Scale } from './scale'

/**
 * An arrangement: what plays, when, and on which rack.
 *
 * Deliberately as free of the browser as `src/patch` is. A game that loads a
 * song and plays it has no React, no AudioContext and no DOM, and an offline
 * bounce has none of them either -- so everything that decides what a song
 * sounds like lives here, and the only thing built on top is the drawing.
 *
 * Patterns and a playlist rather than one long timeline. A pattern is written
 * once and placed as many times as the arrangement wants it, which is what
 * makes a change to a drum part a change in one place rather than in the
 * thirty-two bars it was copied across.
 */

/**
 * Ticks in a quarter note.
 *
 * 960 because every division anybody writes has to come out whole: it halves
 * to a 128th note and thirds to a triplet, so no note in a written pattern
 * ever lands between two ticks and has to be rounded.
 */
export const PPQ = 960

export interface Song {
  /** Beats per minute. One tempo for the whole song, for now. */
  tempo: number
  tracks: Track[]
  patterns: Pattern[]
  playlist: Placement[]
  /** The transport's loop, in ticks. Absent means play to the end and stop. */
  loop?: { from: number; to: number }
  /**
   * Beats to a bar, and what a beat is: 3/4, 6/8. Absent is 4/4, which is
   * what every song written before this existed was in. Only the bars move
   * with it -- where the lines are drawn, what a pattern's length counts in,
   * where the playlist's cells fall. Ticks, and so every note, are the same
   * in any meter.
   */
  meter?: Meter
  /** The song's mixing desk. Absent is the default one: see `DEFAULT_CONSOLE`. */
  console?: Console
  /**
   * Named places in the arrangement -- Intro, Verse, Drop -- in ticks. A
   * marker runs to the next one, or to the end, and that span is a section
   * the playlist can jump to and loop.
   */
  markers?: Marker[]
  /**
   * The key the roll highlights, and snaps to when asked. Absent means none:
   * every row is as good as every other. A property of the song rather than
   * of a pattern, because a song is in a key and its patterns are in it too.
   */
  scale?: Scale
}

export interface Track {
  id: string
  name: string
  /**
   * Which patch in the bundle this track plays, by id.
   *
   * A track is a rack. That is the whole of the relationship between this
   * layer and the one underneath it: the song says when to play, and every
   * question about what it sounds like is answered by the patch.
   */
  patch: string
  /** Linear, 0..1, applied when the track is summed into the mix. */
  gain: number
  mute?: boolean
  solo?: boolean
  /**
   * A hue, 0..360, for telling tracks apart: on its row, and on its notes
   * where they are drawn behind another track's in the roll.
   */
  color?: number
  /** Its channel on the console: see `Strip`. Absent is a flat, centred strip. */
  strip?: Strip
}

/**
 * A track's channel on the song console, after its rack and before the mix.
 * Its fader is the track's `gain`, which is older than the console.
 */
export interface Strip {
  /** -1 hard left to 1 hard right. A rack is stereo, so this is a balance. */
  pan: number
  /** Three bands of tone, in dB. */
  eq: Eq3
  /** How much of it goes to each shared effect, 0..1. */
  space: number
  delay: number
}

/** A console EQ: a low shelf at 200 Hz, a bell at 1 kHz, a high shelf at 5 kHz, in dB. */
export interface Eq3 {
  low: number
  mid: number
  high: number
}

/**
 * The song's own mixing desk, after every track's strip: two shared effects
 * the tracks send to, and the master bus the whole mix leaves by.
 */
export interface Console {
  master: {
    eq: Eq3
    /** -1..1, left to right. */
    balance: number
    /** Linear, 0..2. */
    level: number
    /** A brickwall at -1 dB, so the mix can never clip. On to begin with. */
    limiter: boolean
  }
  /** The shared reverb. `level` is how loud its return comes back. */
  space: { size: number; decay: number; damping: number; level: number }
  /** The shared echo, `time` in seconds. */
  delay: { time: number; feedback: number; damping: number; level: number }
}

export const FLAT_EQ: Eq3 = { low: 0, mid: 0, high: 0 }
export const DEFAULT_STRIP: Strip = { pan: 0, eq: FLAT_EQ, space: 0, delay: 0 }
export const DEFAULT_CONSOLE: Console = {
  master: { eq: FLAT_EQ, balance: 0, level: 1, limiter: true },
  space: { size: 0.6, decay: 2.2, damping: 0.4, level: 1 },
  delay: { time: 0.375, feedback: 0.35, damping: 0.3, level: 1 },
}

export interface Pattern {
  id: string
  name: string
  /**
   * How long one placement of it occupies, in ticks. Notes running past the
   * end are cut off there, which is what makes the length mean something
   * rather than being a suggestion the notes can ignore.
   */
  length: number
  /**
   * Notes for any track, not for one.
   *
   * A pattern is a bar of the song rather than a bar of an instrument: the
   * kick, the bass and the lead that belong together are written together and
   * placed together, and a variation is a new pattern rather than three
   * clips that have to be kept lined up by hand.
   */
  notes: Note[]
  /** A hue, 0..360, for finding it on the playlist. Absent is the accent. */
  color?: number
}

export interface Note {
  track: string
  /** From the start of the pattern. */
  tick: number
  /** How long the gate is held, in ticks. */
  length: number
  /**
   * Semitones from the bottom of the track's keyboard, which is what the
   * roll counts in. A track whose patch has no keyboard ignores it: the note
   * is a trigger and the pitch means nothing.
   */
  pitch: number
  /** 0..1. */
  velocity: number
}

export interface Meter {
  /** Beats to the bar: the top of the time signature. */
  beats: number
  /** What a beat is -- a quarter note (4) or an eighth (8): the bottom. */
  unit: 4 | 8
}

export interface Marker {
  tick: number
  name: string
}

/** Ticks in one bar of this song. */
export function barTicks(song: { meter?: Meter }): number {
  const m = song.meter ?? { beats: 4, unit: 4 }
  return (m.beats * PPQ * 4) / m.unit
}

/** Ticks in one beat: a quarter note in 3/4, an eighth in 6/8. */
export function beatTicks(song: { meter?: Meter }): number {
  return (PPQ * 4) / (song.meter?.unit ?? 4)
}

export interface Placement {
  pattern: string
  /** Where in the playlist this instance of the pattern begins, in ticks. */
  tick: number
}

/** An empty song, which is what a new project opens on. */
export function emptySong(): Song {
  return { tempo: 120, tracks: [], patterns: [], playlist: [] }
}

/** The one track every rack has: the one on the bench. */
export const BENCH_TRACK = 'bench'
export const BENCH_PATTERN = 'main'

/**
 * A song for a single rack: one track playing whatever is on the bench, and
 * one bar to write in.
 *
 * A bar rather than four, because an empty roll four bars wide reads as a
 * thing you have failed to fill in. One bar is a loop you can put four notes
 * in and hear something, and the length is a dropdown away.
 */
export function benchSong(): Song {
  return {
    tempo: 120,
    tracks: [{ id: BENCH_TRACK, name: 'Rack', patch: BENCH_TRACK, gain: 1 }],
    patterns: [{ id: BENCH_PATTERN, name: 'Pattern', length: PPQ * 4, notes: [] }],
    playlist: [{ pattern: BENCH_PATTERN, tick: 0 }],
  }
}
