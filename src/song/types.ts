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
  /** Folders for the track list, in no particular order. See `Folder`. */
  folders?: Folder[]
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
   * The named parts of the arrangement -- Intro, Verse, Drop -- each a span
   * of ticks, earliest first, never overlapping. The song can have stretches
   * no section covers. A section is what the playlist loops when its name is
   * clicked, what a game jumps to, and what moves with its music when it is
   * dragged to another place in the song.
   */
  sections?: Section[]
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
  /** The folder it is filed in, by id. Absent is none. */
  folder?: string
  /**
   * Left out of the track list, the desk and the roll's background, and
   * still heard: hiding is for tidying, and muting is what silences.
   */
  hidden?: boolean
  /** Kept at the top of the track list, out of any folder and past any search. */
  pinned?: boolean
}

/**
 * A folder of tracks in the track list, and the group they make.
 *
 * It tidies -- it folds its tracks away under one row -- and it is a group:
 * its mute and solo reach every track in it, and its level scales all of
 * theirs, the way a VCA fader on a desk does. There is no bus behind it:
 * the tracks still reach the mix one by one, each through its own strip.
 */
export interface Folder {
  id: string
  name: string
  /** Linear, 0..1, multiplying each of its tracks' own levels. */
  gain: number
  color?: number
  mute?: boolean
  solo?: boolean
  /** Folded away in the track list: only its own row shows. */
  collapsed?: boolean
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
  /**
   * How far every second step is pushed late. Absent is straight.
   *
   * Applied as the pattern is played, never to the notes: they stay on the
   * grid they were written to, so editing and quantizing still mean what
   * they say, and the amount can be changed while the loop runs -- by the
   * roll, or by a game through `SongPlayer.setSwing`.
   */
  swing?: Swing
}

/**
 * Swing, as drum machines have always counted it: where the second step of
 * each pair lands, as a share of the pair. 0.5 is straight; about 0.67 is a
 * triplet feel; 0.75 is a dotted shuffle.
 */
export interface Swing {
  /** 0.5 to 0.75. */
  amount: number
  /** The step being swung, in ticks: an eighth or a sixteenth. */
  step: number
}

export const SWING_MIN = 0.5
export const SWING_MAX = 0.75
/** The steps swing can be applied to: eighths and sixteenths. */
export const SWING_STEPS: readonly number[] = [PPQ / 2, PPQ / 4]

/**
 * A swing as it is kept: the amount within range, the step one of the two
 * there are, and nothing at all for straight -- so a pattern never swung and
 * one swung and put back are the same pattern, in memory and in a file.
 * Undefined for anything that is not a swing.
 */
export function cleanSwing(amount: unknown, step: unknown): Swing | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined
  const a = Math.min(SWING_MAX, amount)
  if (!(a > SWING_MIN)) return undefined
  const s = SWING_STEPS.includes(step as number) ? (step as number) : SWING_STEPS[1]
  return { amount: Math.round(a * 1000) / 1000, step: s }
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

/** The pitches a roll has rows for, bottom and top, both included. */
export interface PitchRange {
  low: number
  high: number
}

/**
 * Every pitch the roll has a row for: 128 of them, the span of MIDI, with the
 * Keyboard's own two octaves (0 to 24) sitting where MIDI's C3 to C5 do. Four
 * octaves under the bottom key is room for any bass line, and the top is
 * past anything a lead needs, whatever the patch is tuned to.
 */
export const PITCH_RANGE: PitchRange = { low: -48, high: 79 }

export interface Meter {
  /** Beats to the bar: the top of the time signature. */
  beats: number
  /** What a beat is -- a quarter note (4) or an eighth (8): the bottom. */
  unit: 4 | 8
}

export interface Section {
  /** Where it starts, in ticks. */
  tick: number
  /** How long it lasts, in ticks. Always more than nothing. */
  length: number
  name: string
  /** A hue, 0..360, for the strip and the lanes under it. Absent is the accent. */
  color?: number
}

/** Ticks in one bar of this song. */
export function barTicks(song: { meter?: Meter }): number {
  const m = song.meter ?? { beats: 4, unit: 4 }
  return (m.beats * PPQ * 4) / m.unit
}

/**
 * The shortest a pattern can be: a beat, or a bar where a bar is shorter than
 * that -- one bar of 1/8 is half a beat, and a one-bar pattern has to be
 * allowed in any meter. Shared by the length picker and the file reader, so a
 * pattern the editor would refuse cannot arrive through a file instead.
 */
export function minPatternLength(song: { meter?: Meter }): number {
  return Math.min(PPQ, barTicks(song))
}

/**
 * The quietest a note can be. Not zero: a note at no velocity is a note that
 * cannot be heard or seen in the lane, and cannot be dragged back up either.
 */
export const MIN_VELOCITY = 0.01

/** Ticks in one beat: a quarter note in 3/4, an eighth in 6/8. */
export function beatTicks(song: { meter?: Meter }): number {
  return (PPQ * 4) / (song.meter?.unit ?? 4)
}

/**
 * One clip on the playlist: a window onto a pattern, played from `tick`.
 *
 * The pattern repeats for as long as the clip lasts, so a one-bar drum
 * pattern dragged out to eight bars is eight bars of drums. `offset` is where
 * in the pattern the clip starts playing, and it is what trimming the front
 * of a clip moves: the notes stay where they were in the song and the clip's
 * edge moves over them.
 *
 * `offset` and `length` are absent until a clip is trimmed or split. Absent
 * means "the pattern, from its start, once" -- so an untouched clip follows
 * its pattern when the pattern's length changes, the way it always has.
 */
export interface Placement {
  pattern: string
  /** Where in the playlist this clip begins, in ticks. */
  tick: number
  /**
   * The playlist lane it sits in, from 0 at the top. Absent is 0. Only
   * where it is drawn: any pattern can go in any lane, and lanes do not
   * change what is heard.
   */
  lane?: number
  /** Ticks into the pattern the clip begins playing at. Absent is 0. */
  offset?: number
  /** How long the clip lasts, in ticks. Absent is the pattern's length. */
  length?: number
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
