import { addClip } from './clip'
import { nextPatternId } from './edit'
import { normalizeSong } from './normalize'
import { tempoMap } from './timeline'
import { PPQ, type Pattern, type Song } from './types'

/**
 * Sounds: audio files on the timeline.
 *
 * A sound is a pattern with `audio` on it (see `Pattern.audio`), so its clips
 * are clips like any other -- painted, moved, trimmed, split, drawn out to
 * loop, carried along with a section -- and only what they play differs:
 * the file, on its track's Clips module, at the file's own speed.
 */

export const isSound = (p: Pattern | undefined): boolean => !!p?.audio

/** A rate to measure seconds in: any will do, since only the ratio is used. */
const RATE = 48000

/**
 * How many ticks `seconds` of audio lasts from `tick`, at the song's tempo
 * there: what a sound's length is when it arrives. Whole ticks, rounded up,
 * so the clip never cuts the file's last moment off.
 */
export function ticksFor(song: Song, seconds: number, tick = 0): number {
  if (!(seconds > 0)) return PPQ
  const time = tempoMap(song, RATE)
  return Math.max(1, Math.ceil(time.advance(tick, seconds * RATE) - tick - 1e-6))
}

/**
 * A file brought in as a sound on a track, with a clip of it at `tick` in
 * `lane`: the whole file, once. Named for the file, without its extension.
 * Hands back the song and the new sound's id.
 */
export function addSound(
  song: Song,
  sample: { id: string; name: string },
  track: string,
  seconds: number,
  tick: number,
  lane: number,
): { song: Song; id: string } {
  if (!song.tracks.some((t) => t.id === track)) return { song, id: '' }
  const id = nextPatternId(song)
  const name = sample.name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'Sound'
  const pattern: Pattern = {
    id,
    name,
    length: ticksFor(song, seconds, tick),
    notes: [],
    audio: { sample: { id: sample.id, name: sample.name }, track },
  }
  // Through the same rules a file is read with: a sound shorter than the
  // shortest a pattern may be is held to it.
  const withSound = normalizeSong({ ...song, patterns: [...song.patterns, pattern] })
  return { song: addClip(withSound, id, tick, lane), id }
}

/** Play a sound on another track instead. Only to a track of the song. */
export function setSoundTrack(song: Song, id: string, track: string): Song {
  const p = song.patterns.find((x) => x.id === id)
  if (!p?.audio || p.audio.track === track || !song.tracks.some((t) => t.id === track)) return song
  return { ...song, patterns: song.patterns.map((x) => (x.id === id ? { ...x, audio: { ...p.audio!, track } } : x)) }
}
