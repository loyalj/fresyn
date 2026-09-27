import { PPQ, type Song } from './types'

/**
 * Turning an arrangement into a list of things to do at exact samples.
 *
 * One function, called by three callers that must agree exactly: the live
 * transport, filling a window a fraction of a second ahead of the speakers;
 * an offline bounce, asking for the whole song at once and rendering it
 * faster than realtime; and a game, replaying the arrangement with no UI
 * anywhere. A song that bounced differently from the way it sounded would be
 * a bug nobody could hear until the file was already written, so none of
 * those three is allowed its own copy of this.
 */

export interface SongEvent {
  /** Samples from tick zero. */
  frame: number
  track: string
  kind: 'on' | 'off'
  /**
   * Semitones. Meaningless on a track with no keyboard. Left out of an `off`
   * to mean every note on the track -- which is what a loop's seam sends, and
   * not the same thing as a release of pitch zero.
   */
  pitch?: number
  velocity: number
}

/**
 * The same thing before it is given a sample to happen on.
 *
 * Kept separate because a transport places its windows wherever the lookahead
 * falls, and rounding a tick to a frame twice -- once against the start of the
 * window and once against the start of the song -- would move a note by a
 * sample depending on where the window happened to land. A note has to be on
 * the same sample live as it is in a bounce, so ticks travel as far as
 * possible and only the last step rounds.
 */
export interface SongEventAt {
  tick: number
  track: string
  kind: 'on' | 'off'
  pitch: number
  velocity: number
}

/** How many samples a tick lasts at this tempo. Fractional, on purpose. */
export function framesPerTick(tempo: number, sampleRate: number): number {
  return (60 / tempo) * (sampleRate / PPQ)
}

export function frameAtTick(tick: number, tempo: number, sampleRate: number): number {
  return Math.round(tick * framesPerTick(tempo, sampleRate))
}

export function tickAtFrame(frame: number, tempo: number, sampleRate: number): number {
  return frame / framesPerTick(tempo, sampleRate)
}

/** One tick past the last thing in the playlist, which is where a song ends. */
export function songEnd(song: Song): number {
  let end = 0
  for (const p of song.playlist) {
    const pattern = song.patterns.find((x) => x.id === p.pattern)
    if (!pattern) continue
    const at = p.tick + pattern.length
    if (at > end) end = at
  }
  return end
}

/**
 * Which tracks are audible. Any solo anywhere silences everything unsoloed,
 * which is what solo means on every desk; mute is only consulted when nothing
 * is soloed, so soloing a muted track still sounds it.
 */
function audible(song: Song): Set<string> {
  const soloed = song.tracks.filter((t) => t.solo)
  const live = soloed.length > 0 ? soloed : song.tracks.filter((t) => !t.mute)
  return new Set(live.map((t) => t.id))
}

/**
 * Every event falling in `[fromTick, toTick)`, soonest first.
 *
 * A half-open window so that consecutive calls tile the song exactly: an
 * event on the boundary belongs to the later window and is emitted once. A
 * transport that asked for `[0, 960]` and then `[960, 1920]` would otherwise
 * play the note on beat one of bar two twice.
 *
 * Frames are absolute, counted from tick zero, rather than relative to the
 * window -- so a caller that loops or seeks does that arithmetic once on the
 * way out instead of this function having to know about either.
 */
export function songEvents(
  song: Song,
  sampleRate: number,
  fromTick: number,
  toTick: number,
): SongEvent[] {
  const fpt = framesPerTick(song.tempo, sampleRate)
  return songEventTicks(song, fromTick, toTick).map((e) => ({
    frame: Math.round(e.tick * fpt),
    track: e.track,
    kind: e.kind,
    pitch: e.pitch,
    velocity: e.velocity,
  }))
}

/** The same window, in ticks. See `SongEventAt` for why both exist. */
export function songEventTicks(song: Song, fromTick: number, toTick: number): SongEventAt[] {
  const events: SongEventAt[] = []
  if (!(toTick > fromTick)) return events

  const live = audible(song)
  const patterns = new Map(song.patterns.map((p) => [p.id, p]))
  const tracks = new Set(song.tracks.map((t) => t.id))

  for (const placement of song.playlist) {
    const pattern = patterns.get(placement.pattern)
    if (!pattern) continue

    // The whole placement is outside the window: skip it without walking its
    // notes. A song is mostly placements that are not playing right now.
    if (placement.tick >= toTick || placement.tick + pattern.length < fromTick) continue

    for (const note of pattern.notes) {
      if (!live.has(note.track) || !tracks.has(note.track)) continue
      // A note sitting past the end of its own pattern never sounds. The
      // length is what a placement occupies; a note outside it would play
      // over whatever was placed next.
      if (note.tick < 0 || note.tick >= pattern.length) continue

      const on = placement.tick + note.tick
      // Cut at the end of the pattern, and never shorter than a single tick:
      // a note of no length still has to close the gate it opened.
      const end = Math.min(note.tick + Math.max(note.length, 1), pattern.length)
      const off = placement.tick + Math.max(end, note.tick + 1)

      if (on >= fromTick && on < toTick) {
        events.push({ tick: on, track: note.track, kind: 'on', pitch: note.pitch, velocity: note.velocity })
      }
      if (off >= fromTick && off < toTick) {
        events.push({ tick: off, track: note.track, kind: 'off', pitch: note.pitch, velocity: note.velocity })
      }
    }
  }

  // Releases before presses at the same instant. A track is one rack and one
  // gate, so a note ending exactly where the next begins has to let go before
  // the next one takes hold -- the other order closes the gate the new note
  // just opened, and the line goes silent from there.
  events.sort((a, b) => a.tick - b.tick || rank(a.kind) - rank(b.kind))
  return events
}

const rank = (kind: 'on' | 'off') => (kind === 'off' ? 0 : 1)
