import { engineEventsByTrack, type NoteTarget } from '../song/bind'
import { releasedBySwing } from '../song/schedule'
import { fill, playheadTick, type Cursor, type Loop } from '../song/transport'
import type { Song } from '../song/types'
import type { AudioEngine } from './AudioEngine'

/**
 * How far ahead of the speakers events are handed over.
 *
 * Long enough that a stalled frame from the main thread does not leave the
 * audio thread with an empty queue, and short enough that a note added to the
 * roll while the loop is running is heard on this pass rather than the next.
 * A quarter of a second is both: frames arrive about every 33ms, so seven of
 * them would have to be missed before anything dropped, and an edit lands
 * well inside the time it takes to look up from the mouse.
 */
const LOOKAHEAD_S = 0.25

export interface TransportState {
  playing: boolean
  /** Where the playhead is, in ticks. */
  tick: number
}

/**
 * Plays a song through the rack.
 *
 * Everything about *what* to play is decided in `src/song`, which is pure and
 * has its own checks. This is the part that cannot be: it owns the
 * subscription to the audio thread's clock, and turns each report into a
 * window of events handed across.
 *
 * It never uses a timer. A `setInterval` counts wall time, drifts against the
 * audio device, and is throttled to once a second in a background tab -- so a
 * loop left running while the user reads something else would fall apart. The
 * audio thread counts the samples it is actually producing, and that is the
 * only clock here.
 */
export class Transport {
  private loop: Loop | null = null
  private targets: ReadonlyMap<string, NoteTarget> = new Map()
  private cursor: Cursor = { tick: 0, frame: 0 }
  private playing = false
  /** The song ran off its end; stop once the speakers have caught up. */
  private ended = false
  /**
   * Where playback was asked to start, held until the audio thread reports a
   * frame to anchor it against.
   *
   * Play cannot seek the clock and start counting from zero: the message
   * takes a moment to land, and every frame reported in the meantime is from
   * before the seek. Waiting for a real frame and anchoring to that costs one
   * report -- about 33ms -- and is correct without having to guess which
   * reports are stale.
   */
  private pending: number | null = null
  private startFrame = 0
  private startTick = 0
  private lastFrame = 0
  private tick = 0
  private unsubscribe?: () => void
  private listeners = new Set<(state: TransportState) => void>()

  constructor(
    private readonly engine: AudioEngine,
    private song: Song,
  ) {}

  get state(): TransportState {
    return { playing: this.playing, tick: this.tick }
  }

  subscribe(fn: (state: TransportState) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    const state = this.state
    for (const fn of this.listeners) fn(state)
  }

  /**
   * The arrangement to play. Called on every edit, which is cheap: notes
   * added while the loop runs are picked up by the next window, so an edit is
   * heard within the lookahead and nothing has to be torn down.
   *
   * A tempo change is the exception. It changes what every frame already
   * queued means, so those have to go.
   */
  setSong(song: Song) {
    const tempoChanged = song.tempo !== this.song.tempo
    // A swing moved while it plays can carry the end of a note already
    // started to behind the cursor, where the next pass would never send it.
    // Let go of those at the cursor; the rest are picked up as usual.
    const released =
      this.playing && this.pending === null && !tempoChanged
        ? releasedBySwing(this.song, song, this.cursor.tick)
        : []
    this.song = song
    if (tempoChanged) this.resync()
    else if (released.length) {
      const frame = Math.round(this.cursor.frame)
      this.engine.schedule(
        engineEventsByTrack(
          released.map((e) => ({ frame, track: e.track, kind: e.kind, pitch: e.pitch, velocity: e.velocity })),
          this.targets,
        ),
      )
    }
  }

  /**
   * The playhead is worked out from where playback was anchored plus the
   * frames since, wrapped by the loop -- so the anchor has to move when the
   * loop does. Kept at the old one, a loop shortened mid-play would wrap
   * everything elapsed so far into the new length and draw the playhead in a
   * bar the audio is nowhere near. Re-anchored at the last reported frame and
   * the tick drawn for it, which is exactly where the playhead already is:
   * nothing jumps, and from here on it counts against the new loop.
   */
  setLoop(loop: Loop | null) {
    const same =
      loop === this.loop ||
      (loop !== null && this.loop !== null && loop.from === this.loop.from && loop.to === this.loop.to)
    this.loop = loop
    if (same || !this.playing || this.pending !== null) return
    this.startFrame = this.lastFrame
    this.startTick = this.tick
  }

  /** Which module in which patch each track's notes are played on. */
  setTargets(targets: ReadonlyMap<string, NoteTarget>) {
    this.targets = targets
  }

  async play(fromTick = 0) {
    if (this.playing) return
    await this.engine.start()
    this.playing = true
    this.ended = false
    this.pending = fromTick
    this.tick = fromTick
    this.unsubscribe = this.engine.onFrame((frame) => this.advance(frame))
    this.emit()
  }

  stop() {
    if (!this.playing) return
    this.playing = false
    this.pending = null
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.engine.unschedule()
    // The queue can be emptied, but a note already sounding has nothing left
    // to close it and the rack would drone.
    this.engine.allNotesOff()
    this.tick = this.startTick
    this.emit()
  }

  toggle(fromTick = 0) {
    if (this.playing) this.stop()
    else void this.play(fromTick)
  }

  /**
   * Sound one note on a track now, until `release`: a key in the roll's
   * gutter, a note as it is drawn, a note dragged to a new row.
   *
   * Through the same queue the song uses, stamped at frame zero, which every
   * engine's clock is already past -- so it is applied at the start of the
   * next block, a few milliseconds away, and it goes down exactly the path a
   * played note does: the Keyboard's pitch and velocity arrive with the gate,
   * and a drum track's Trigger fires as it would from the song.
   */
  preview(trackId: string, pitch: number, velocity: number) {
    const target = this.targets.get(trackId)
    if (!target) return
    const events = engineEventsByTrack(
      [{ frame: 0, track: trackId, kind: 'on', pitch, velocity }],
      this.targets,
    )
    // The context may still be waiting on a gesture, and this is one. Sent
    // once it is up rather than straight away, or the first key pressed in a
    // session would be posted to a node that does not exist yet.
    void this.engine.start().then(() => this.engine.schedule(events))
  }

  release(trackId: string, pitch: number) {
    if (!this.targets.has(trackId)) return
    const events = engineEventsByTrack(
      [{ frame: 0, track: trackId, kind: 'off', pitch, velocity: 0 }],
      this.targets,
    )
    // Behind the press on the same promise, so a quick click cannot release
    // before it has pressed.
    void this.engine.start().then(() => this.engine.schedule(events))
  }

  /**
   * Throw away what is queued and refill from where the playhead actually is.
   *
   * For a tempo change, which makes every queued frame wrong. The clock is
   * deliberately not moved: the speakers are in the middle of it, and seeking
   * would mean guessing which of the reports in flight were from before.
   */
  private resync() {
    if (!this.playing) return
    if (this.pending !== null) {
      this.pending = this.tick
      return
    }
    this.engine.unschedule()
    this.engine.allNotesOff()
    this.startFrame = this.lastFrame
    this.startTick = this.tick
    this.cursor = { tick: this.tick, frame: this.lastFrame }
    this.ended = false
    this.refill(this.lastFrame)
  }

  private advance(frame: number) {
    if (!this.playing) return
    this.lastFrame = frame

    if (this.pending !== null) {
      this.startFrame = frame
      this.startTick = this.pending
      this.cursor = { tick: this.pending, frame }
      this.pending = null
    }

    this.tick = playheadTick(
      frame,
      this.startFrame,
      this.startTick,
      this.song.tempo,
      this.engine.sampleRate,
      this.loop,
    )

    // Stopped only once the speakers have reached the last event, not when
    // the cursor did: the cursor is a quarter of a second ahead, and cutting
    // there would clip the final note.
    if (this.ended && frame >= this.cursor.frame) {
      this.stop()
      return
    }

    this.refill(frame)
    this.emit()
  }

  private refill(frame: number) {
    const until = frame + LOOKAHEAD_S * this.engine.sampleRate
    if (this.cursor.frame >= until) return

    const out = fill(this.song, this.engine.sampleRate, this.cursor, until, this.loop)
    this.cursor = out.cursor
    if (out.ended) this.ended = true
    this.engine.schedule(engineEventsByTrack(out.events, this.targets))
  }
}
