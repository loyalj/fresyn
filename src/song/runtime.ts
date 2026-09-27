import type { Routing } from '../dsp/Console'
import type { SampleBank } from '../dsp/samples'
import { SongEngine } from '../dsp/SongEngine'
import { compile } from '../patch/compile'
import { defOf } from '../patch/defs'
import { clampValue, type ParamSpec } from '../patch/param'
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

/** One knob a game can turn: where it lives in its track's engine, and its range. */
interface Reachable {
  index: number
  spec: ParamSpec
  value: number
}

export class SongPlayer {
  private engine: SongEngine
  private targets = new Map<string, NoteTarget>()
  /** Every knob in every track, by track id and then by `module.param`. */
  private knobs = new Map<string, Map<string, Reachable>>()
  /** A track's name, for a game that would rather not know its id. */
  private trackByName = new Map<string, string>()
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

      const knobs = new Map<string, Reachable>()
      for (const m of rack.patch.modules) {
        for (const spec of defOf(m.type).params) {
          const key = `${m.id}.${spec.id}`
          const index = compiled.paramIndex[key]
          if (index !== undefined) knobs.set(key, { index, spec, value: params[index] })
        }
      }
      this.knobs.set(track.id, knobs)
      if (!this.trackByName.has(track.name)) this.trackByName.set(track.name, track.id)
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

  /**
   * How many samples late the output is: the master limiter looking ahead.
   * A game playing live can ignore it; anything writing a file that has to
   * tile drops this many samples off the front.
   */
  get latency() {
    return this.engine.latency
  }

  /** Which tracks have something a note can actually be played on. */
  get playable(): readonly string[] {
    return [...this.targets.keys()]
  }

  /**
   * Turn a knob in one of the song's racks while it plays.
   *
   * This is how a game reaches into the music: a Macro's Amount for how
   * tense the scene is, a filter opening as the player gets closer, a track's
   * drive coming up with the speed. `track` is the track's id or its name;
   * `knob` is the module's id, as its ear prints it, and the knob's --
   * `mac1.amount`, `lpf1.cutoff`. `paramsOf` lists every one a track has.
   *
   * The value is in the knob's own units and clamped to its range, and a
   * switch is rounded to a position, so nothing a game sends can put a module
   * somewhere its panel could not. It takes effect from the next block
   * rendered, and a module's own smoothing glides it there, so calling this
   * once a frame is fine and does not click.
   *
   * Returns false, and changes nothing, for a track or knob that is not in
   * the song -- a renamed module is a quiet failure otherwise.
   */
  setParam(track: string, knob: string, value: number): boolean {
    const id = this.knobs.has(track) ? track : this.trackByName.get(track)
    const reachable = id !== undefined ? this.knobs.get(id)?.get(knob) : undefined
    if (id === undefined || !reachable || !Number.isFinite(value)) return false
    reachable.value = clampValue(reachable.spec, value)
    this.engine.setParam(id, reachable.index, reachable.value)
    return true
  }

  /** Where a knob stands now, or undefined for one that is not in the song. */
  getParam(track: string, knob: string): number | undefined {
    const id = this.knobs.has(track) ? track : this.trackByName.get(track)
    return id !== undefined ? this.knobs.get(id)?.get(knob)?.value : undefined
  }

  /** Every knob `setParam` can reach on a track, as `module.param`. */
  paramsOf(track: string): string[] {
    const id = this.knobs.has(track) ? track : this.trackByName.get(track)
    return id !== undefined ? [...(this.knobs.get(id)?.keys() ?? [])] : []
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
