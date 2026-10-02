import type { ComponentType } from 'react'
import type { Song } from '../song/types'

/**
 * The utilities: tools that live beside the rack and the song rather than in
 * them -- calculators, meters, listeners, sketchpads. Most answer questions
 * about the project, and about sound from elsewhere; the few that write into
 * it do so only from a button that says so, as one step of undo.
 *
 * Each is listed here and fetched the first time it is opened, so a utility
 * nobody opens costs the page nothing. The Utilities menu is built from this
 * list, and so is every floating panel they open in (see `UtilityPanel`).
 */

/**
 * A track as a utility sees it: what it plays, and how a real note -- a MIDI
 * note number -- becomes one of its rows.
 */
export interface UtilityTrack {
  id: string
  name: string
  /** How its notes are played (see `NoteTarget`), or null for a rack with no way in yet. */
  kind: 'note' | 'trigger' | 'kit' | null
  /** The MIDI note its bottom row sounds: a row is a MIDI note less this. See `rowZero`. */
  zero: number
  /** For a kit, its loaded pads by row, lowest first, each with the MIDI note it is on. */
  pads: { row: number; note: number; name: string }[]
}

/** What every utility is handed: the song as it stands, and the rate the rack runs at. */
export interface UtilityProps {
  song: Song
  sampleRate: number
  /**
   * An edit to the song, a step of undo like any other. For the few things a
   * utility writes back -- a tempo tapped out, a progression written into a
   * pattern -- and never without being asked: changing the song is always a
   * button of its own. `label` names the step in the History list.
   */
  editSong: (fn: (song: Song) => Song, key?: string, label?: string) => void
  /** Every track, in the song's order. */
  tracks: readonly UtilityTrack[]
  /** The track on the bench: the one the roll is showing and the keys play. */
  bench: string
  /** The pattern open in the roll. */
  patternId: string
  /**
   * Sound one row of a track through its rack now, until `release`: the
   * same path a key in the roll's gutter takes.
   */
  preview: (track: string, row: number, velocity: number) => void
  release: (track: string, row: number) => void
  /** Where the playhead is now, in ticks. */
  playhead: () => number
  /**
   * The app's audio device, opened if it is not yet -- so call it from a
   * click, which a browser wants before it lets sound start. Null if it
   * could not be opened. For a utility that makes a sound of its own, outside
   * the rack and the mix: a metronome, a test tone.
   */
  audio: () => Promise<AudioContext | null>
}

export interface Utility {
  id: UtilityId
  /** What the menu and the panel's title call it. */
  name: string
  /** One line, for the menu item's tooltip. */
  description: string
  load: () => Promise<ComponentType<UtilityProps>>
}

export type UtilityId = 'timing' | 'metronome' | 'pitch' | 'scales' | 'progression' | 'rhythm'

export const UTILITIES: readonly Utility[] = [
  {
    id: 'timing',
    name: 'Timing',
    description: 'How many bars a length of time holds, how long each note is, and a tempo tapped out',
    load: () => import('../ui/utilities/TimingUtility').then((m) => m.TimingUtility),
  },
  {
    id: 'metronome',
    name: 'Metronome',
    description: 'A click at a tempo and time signature, with accents and subdivisions',
    load: () => import('../ui/utilities/MetronomeUtility').then((m) => m.MetronomeUtility),
  },
  {
    id: 'pitch',
    name: 'Notes & frequencies',
    description: 'A note to its frequency and back, with its harmonics and transpositions',
    load: () => import('../ui/utilities/PitchUtility').then((m) => m.PitchUtility),
  },
  {
    id: 'scales',
    name: 'Scales & chords',
    description: "A key's notes on a keyboard and the circle of fifths, and the chords that belong to it",
    load: () => import('../ui/utilities/ScalesUtility').then((m) => m.ScalesUtility),
  },
  {
    id: 'progression',
    name: 'Progressions',
    description: 'A chord progression, voiced and played in a rhythm, written into the pattern',
    load: () => import('../ui/utilities/ProgressionUtility').then((m) => m.ProgressionUtility),
  },
  {
    id: 'rhythm',
    name: 'Rhythm',
    description: 'Euclidean rhythms, a lane per drum, written into a Drum Kit pattern',
    load: () => import('../ui/utilities/RhythmUtility').then((m) => m.RhythmUtility),
  },
]

export function utilityById(id: string): Utility | undefined {
  return UTILITIES.find((u) => u.id === id)
}
