import { clipEnd, clipOffset } from './clip'
import { heardTracks } from './folder'
import { PPQ, SWING_MIN, type Note, type Pattern, type Placement, type Song, type Swing } from './types'

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
    const at = clipEnd(p, pattern)
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
  return heardTracks(song)
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

/**
 * Where a tick in a pattern is played, once its swing is applied.
 *
 * Not a nudge of the notes that happen to sit on an off-step but a warp of
 * time across each pair of steps: the first step is stretched and the second
 * squeezed, so the second begins `amount` of the way through the pair. Every
 * tick moves, which means a note placed off the grid, or humanized, swings by
 * its share rather than not at all; the ends of notes move with their starts,
 * so a legato line stays joined; and the first tick of every pair stays put,
 * so the beat and the bar do not move and a loop still tiles.
 *
 * A pair the pattern ends part way through is left straight. Swinging it
 * would carry its second half past the end of the pattern and over whatever
 * was placed after.
 */
export function swungTick(tick: number, pattern: Pick<Pattern, 'length' | 'swing'>): number {
  const swing = pattern.swing
  if (!swing || !(swing.amount > SWING_MIN) || !(swing.step > 0)) return tick
  const step = swing.step
  const pair = step * 2
  const start = Math.floor(tick / pair) * pair
  if (start + pair > pattern.length) return tick
  const into = tick - start
  const split = pair * swing.amount
  return into < step
    ? start + (into * split) / step
    : start + split + ((into - step) * (pair - split)) / step
}

/**
 * The written tick that plays at a given moment: `swungTick` backwards.
 *
 * For the roll, which can draw a pattern as it sounds and so has to turn a
 * click at a place in time back into the grid tick a note is written at.
 * Exact, because the warp is two straight lines per pair of steps.
 */
export function unswungTick(tick: number, pattern: Pick<Pattern, 'length' | 'swing'>): number {
  const swing = pattern.swing
  if (!swing || !(swing.amount > SWING_MIN) || !(swing.step > 0)) return tick
  const step = swing.step
  const pair = step * 2
  const start = Math.floor(tick / pair) * pair
  if (start + pair > pattern.length) return tick
  const into = tick - start
  const split = pair * swing.amount
  return into < split
    ? start + (into * step) / split
    : start + step + ((into - split) * step) / (pair - split)
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

    // The whole clip is outside the window: skip it without walking its
    // notes. A song is mostly clips that are not playing right now.
    if (placement.tick >= toTick || clipEnd(placement, pattern) < fromTick) continue

    for (const { note, on, off } of clipHits(placement, pattern, fromTick, toTick)) {
      if (!live.has(note.track) || !tracks.has(note.track)) continue
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

/**
 * Where a note lets go, from the start of its pattern: cut at the end of the
 * pattern, never shorter than a single tick -- a note of no length still has
 * to close the gate it opened -- and swung like its start.
 */
function swungEnd(note: Note, pattern: Pick<Pattern, 'length' | 'swing'>): number {
  const end = Math.min(note.tick + Math.max(note.length, 1), pattern.length)
  return Math.max(swungTick(end, pattern), swungTick(note.tick, pattern) + 1)
}

/** One note of a clip as it plays, in song ticks. */
export interface ClipHit {
  note: Note
  on: number
  off: number
}

/**
 * Where each repeat of a clip's pattern begins, in song ticks, for the
 * repeats that could have a note starting or stopping in `[from, to]`.
 *
 * A repeat starts a pattern's length after the last, lined up so that the
 * clip's first tick is `offset` into the pattern -- which puts the first
 * repeat's start before the clip's own when the clip was trimmed from the
 * front. One repeat earlier than the window is included, since a note that
 * started in it can end inside.
 */
export function clipRepeats(place: Placement, pattern: Pick<Pattern, 'length'>, from: number, to: number): number[] {
  const len = pattern.length
  if (!(len > 0)) return []
  const lo = Math.max(from, place.tick)
  const hi = Math.min(to, clipEnd(place, pattern))
  if (hi < lo) return []
  const origin = place.tick - clipOffset(place, pattern)
  const out: number[] = []
  const last = Math.floor((hi - origin) / len)
  for (let k = Math.max(0, Math.floor((lo - origin) / len) - 1); k <= last; k++) out.push(origin + k * len)
  return out
}

/**
 * Every note a clip plays that could start or stop in `[from, to]`, with
 * where it does.
 *
 * A note belongs to a clip when it is written to start inside it: one whose
 * start was trimmed away is not played from part way through, which is what
 * every sequencer does, since half a drum hit is a click. A note still
 * sounding at the clip's end is cut there, as it is at the end of its
 * pattern.
 *
 * `timing` is the pattern whose swing places the notes: the clip's own,
 * unless a caller is asking where they would play under a different swing,
 * or none.
 */
export function clipHits(
  place: Placement,
  pattern: Pattern,
  from: number,
  to: number,
  timing: Pick<Pattern, 'length' | 'swing'> = pattern,
): ClipHit[] {
  const hits: ClipHit[] = []
  const len = pattern.length
  const start = place.tick
  const end = clipEnd(place, pattern)
  for (const base of clipRepeats(place, pattern, from, to)) {
    for (const note of pattern.notes) {
      // A note sitting past the end of its own pattern never sounds. The
      // length is what a repeat occupies; a note outside it would play over
      // the next one.
      if (note.tick < 0 || note.tick >= len) continue
      const at = base + note.tick
      if (at < start || at >= end) continue
      const on = base + swungTick(note.tick, timing)
      // Swung past the clip's end: there is no room left to play it.
      if (on >= end) continue
      hits.push({ note, on, off: Math.min(base + swungEnd(note, timing), end) })
    }
  }
  return hits
}

/**
 * The notes a change of swing would leave sounding forever, released.
 *
 * The scheduler runs ahead of the speakers and remembers nothing, so when a
 * pattern's swing changes while it plays, a note whose start has already been
 * sent but whose end has not can find that end moved behind the cursor -- the
 * next pass looks only forward, never sends it, and the note drones. This
 * finds exactly those, so they can be let go of at the cursor; everything
 * else is picked up by the next pass as usual.
 *
 * Only patterns whose notes are the same array in both songs are looked at:
 * that is what a change of swing and nothing else looks like, and it is what
 * lets a note in one be matched to itself in the other.
 */
export function releasedBySwing(before: Song, after: Song, tick: number): SongEventAt[] {
  const events: SongEventAt[] = []
  const was = new Map(before.patterns.map((p) => [p.id, p]))
  for (const pattern of after.patterns) {
    const old = was.get(pattern.id)
    if (!old || old.notes !== pattern.notes || sameSwing(old.swing, pattern.swing)) continue
    for (const placement of after.playlist) {
      if (placement.pattern !== pattern.id) continue
      const end = clipEnd(placement, pattern)
      if (tick < placement.tick || tick > end) continue
      for (const base of clipRepeats(placement, pattern, tick - pattern.length, tick)) {
        for (const note of pattern.notes) {
          if (note.tick < 0 || note.tick >= pattern.length) continue
          const at = base + note.tick
          if (at < placement.tick || at >= end) continue
          const wasOn = base + swungTick(note.tick, old)
          const started = wasOn < tick && wasOn < end
          const unreleased = Math.min(base + swungEnd(note, old), end) >= tick
          // Swung past the clip's end now, it will never be sent again, and
          // neither will its release.
          const nowOn = base + swungTick(note.tick, pattern)
          const nowBehind = nowOn >= end || Math.min(base + swungEnd(note, pattern), end) < tick
          if (started && unreleased && nowBehind) {
            events.push({ tick, track: note.track, kind: 'off', pitch: note.pitch, velocity: note.velocity })
          }
        }
      }
    }
  }
  return events
}

export function sameSwing(a: Swing | undefined, b: Swing | undefined) {
  const straightA = !a || !(a.amount > SWING_MIN)
  const straightB = !b || !(b.amount > SWING_MIN)
  if (straightA || straightB) return straightA === straightB
  return a!.amount === b!.amount && a!.step === b!.step
}
