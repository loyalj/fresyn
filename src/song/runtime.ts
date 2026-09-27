import type { Routing } from '../dsp/Console'
import type { SampleBank } from '../dsp/samples'
import { SongEngine } from '../dsp/SongEngine'
import { compile } from '../patch/compile'
import { engineEventsByTrack, noteTarget, type NoteTarget } from './bind'
import { consoleOf, trackMix } from './edit'
import { fromStoredProject, type LoadedProject, type Rack } from './project'
import { fill, type Cursor, type Loop } from './transport'
import type { Song } from './types'

/**
 * Playing a song with no browser anywhere.
 *
 * This is the whole of what a game needs: hand it a project file and a sample
 * rate, and pull blocks of audio out of it. There is no AudioContext, no
 * worklet, no React and no DOM below this line -- the same class is what the
 * offline bounce runs, so a rendered file and a game's playback are the same
 * arithmetic.
 *
 * The live transport in `audio/Transport.ts` is deliberately *not* built on
 * this. It cannot be: its engine is on the other side of a thread boundary
 * and it can only post messages at it. What the two do share is `fill`, which
 * is where every decision about what plays when actually lives.
 */

export interface SongPlayerOptions {
  sampleRate: number
  /** Audio for any Sampler in any rack. Without it they play silent. */
  samples?: SampleBank
  seed?: number
  /** Where to come round to at the end, or null to play once and stop. */
  loop?: Loop | null
  /**
   * Only these tracks reach the mix, on top of the song's own mute and solo.
   * What a stem is: the arrangement, with one track let through.
   */
  only?: readonly string[]
  /** How far ahead events are queued, in seconds. */
  lookahead?: number
  /**
   * How much of the desk to go through. All of it by default, which is the
   * song as mixed; a stem takes less.
   */
  routing?: Routing
}

const DEFAULT_LOOKAHEAD_S = 0.25

export class SongPlayer {
  private engine: SongEngine
  private targets = new Map<string, NoteTarget>()
  private cursor: Cursor = { tick: 0, frame: 0 }
  private lookaheadFrames: number
  private loop: Loop | null
  private done = false

  constructor(
    private song: Song,
    racks: Readonly<Record<string, Rack>>,
    private readonly options: SongPlayerOptions,
  ) {
    this.loop = options.loop ?? null
    this.lookaheadFrames = (options.lookahead ?? DEFAULT_LOOKAHEAD_S) * options.sampleRate

    const tracks = []
    for (const track of song.tracks) {
      const rack = racks[track.id]
      if (!rack) continue
      const compiled = compile(rack.patch)
      const params = compiled.params.slice()
      for (const [key, value] of Object.entries(rack.values)) {
        const index = compiled.paramIndex[key]
        if (index !== undefined) params[index] = value
      }
      tracks.push({ id: track.id, patch: compiled, params })
      const target = noteTarget(rack.patch)
      if (target) this.targets.set(track.id, target)
    }

    this.engine = new SongEngine(options.sampleRate, tracks, options.seed, options.samples)
    this.engine.setMix(trackMix(song, options.only))
    this.engine.setConsole(consoleOf(song))
    if (options.routing) this.engine.setRouting(options.routing)
  }

  /** True once a song that is not looping has run past its last event. */
  get ended() {
    return this.done && this.engine.currentFrame >= this.cursor.frame
  }

  get frame() {
    return this.engine.currentFrame
  }

  /** Which tracks have something a note can actually be played on. */
  get playable(): readonly string[] {
    return [...this.targets.keys()]
  }

  /** Start again from a tick. Anything already queued is dropped. */
  seek(tick: number) {
    this.engine.seek(0)
    this.engine.allNotesOff()
    this.cursor = { tick, frame: 0 }
    this.done = false
  }

  setLoop(loop: Loop | null) {
    this.loop = loop
  }

  /**
   * Fill a buffer, queueing whatever the song says should happen in it first.
   *
   * Any block size gives the same samples, because the events are stamped in
   * frames and applied inside the graph rather than at the edges of whatever
   * buffer happens to be passing.
   */
  render(left: Float32Array, right: Float32Array) {
    const until = this.engine.currentFrame + left.length + this.lookaheadFrames
    if (this.cursor.frame < until) {
      const out = fill(this.song, this.options.sampleRate, this.cursor, until, this.loop)
      this.cursor = out.cursor
      if (out.ended) this.done = true
      this.engine.scheduleMany(engineEventsByTrack(out.events, this.targets))
    }
    this.engine.render(left, right)
  }
}

/**
 * Read a project file, for a caller that has one as text.
 *
 * The plain-JSON form only: a project with samples in it is a zip, and
 * unpacking that needs the archive reader, which is `project.ts`. A game
 * shipping its own audio does not need one.
 */
export function loadProject(json: string): LoadedProject | { error: string } {
  try {
    return fromStoredProject(JSON.parse(json))
  } catch (e) {
    return { error: `not a readable project: ${(e as Error).message}` }
  }
}
