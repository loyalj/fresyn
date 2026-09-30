import type { Routing } from '../dsp/Console'
import type { SampleBank } from '../dsp/samples'
import { SongEngine } from '../dsp/SongEngine'
import { compile } from '../patch/compile'
import { defOf } from '../patch/defs'
import { clampValue, type ParamSpec } from '../patch/param'
import { engineEventsByTrack, noteTarget, type NoteTarget } from './bind'
import { consoleOf, setPatternSwing, trackMix } from './edit'
import { fromStoredProject, type LoadedProject, type Rack } from './project'
import { fill, type Cursor, type Loop, type Seam } from './transport'
import { releasedBySwing, songEnd } from './schedule'
import { sectionEnd, sectionOver, sectionsOf } from './section'
import { barsOf, tempoMap } from './timeline'
import { SWING_MIN, SWING_STEPS, type Song } from './types'

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

/** A change of course waiting for its frame: go to `to`, and loop `loop` from there. */
interface Jump {
  frame: number
  to: number
  loop: Loop | null
}

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
  /** The loop the player was made with, which leaving a section goes back to. */
  private songLoop: Loop | null
  private done = false
  /**
   * Every place the song has jumped -- the start, each time round a loop,
   * each change of section -- that is still ahead of or just behind the
   * speakers. Between two of them the tick heard is a straight line of the
   * frame, which is how `heardTick` answers without the cursor, which is a
   * lookahead ahead of what anybody is hearing.
   */
  private seams: (Cursor & { before?: number })[] = [{ tick: 0, frame: 0 }]
  private jump: Jump | null = null

  constructor(
    private song: Song,
    racks: Readonly<Record<string, Rack>>,
    private readonly options: SongPlayerOptions,
  ) {
    this.loop = options.loop ?? null
    this.songLoop = this.loop
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
    this.seams = [{ tick, frame: 0 }]
    this.jump = null
    this.done = false
  }

  setLoop(loop: Loop | null) {
    this.loop = loop
    this.songLoop = loop
  }

  // --- sections ------------------------------------------------------

  /** The song's sections, earliest first: what `playSection` can be asked for. */
  get sections(): SectionInfo[] {
    return sectionsOf(this.song).map((s) => ({ name: s.name, from: s.tick, to: sectionEnd(s) }))
  }

  /** The tick being heard now: where the speakers are, not where scheduling is. */
  get tick(): number {
    return this.heardTick(this.engine.currentFrame)
  }

  /** The name of the section being heard now, or null between sections. */
  get section(): string | null {
    return sectionOver(this.song, this.tick)?.name ?? null
  }

  /**
   * Go to a section, by name, and -- unless told otherwise -- loop it until
   * something else is asked for. This is the call adaptive music is made of:
   * `playSection('Combat')` when the fight starts, `playSection('Explore',
   * { when: 'section' })` when it ends, so the combat music finishes its
   * phrase first.
   *
   * `when` is when the change happens, measured from what is being heard:
   * `'now'`, or the next `'beat'`, `'bar'` (the default) or the end of the
   * section playing now (`'section'`, which is the next bar line when no
   * section is playing). Every note sounding at that moment is let go of, and
   * the section begins on that exact sample.
   *
   * With `loop: false` the section plays once and the song carries on from
   * its end, under whatever loop the player was made with.
   *
   * Returns false, and changes nothing, for a name no section has. A later
   * call replaces one still waiting for its moment.
   */
  playSection(name: string, options: { when?: SectionTiming; loop?: boolean } = {}): boolean {
    const target = this.findSection(name)
    if (!target) return false
    const loop = (options.loop ?? true) ? { from: target.from, to: target.to } : this.songLoop
    this.turn(target.from, loop, options.when ?? 'bar')
    return true
  }

  /**
   * Stop looping the section and let the song play on past its end, under
   * the loop the player was made with. The section plays out first: nothing
   * jumps, the music simply does not go round again.
   */
  releaseSection() {
    this.jump = null
    this.loop = this.songLoop
    // The lookahead may already have gone round once more. If so, take that
    // back: the song carries on from where it would have wrapped.
    const now = this.engine.currentFrame
    const wrap = this.seams.find((s) => s.frame > now && s.before !== undefined)
    if (!wrap) return
    this.rewindTo(wrap.frame, wrap.before!)
  }

  private findSection(name: string): SectionInfo | undefined {
    const all = this.sections
    return all.find((s) => s.name === name) ?? all.find((s) => s.name.toLowerCase() === name.toLowerCase())
  }

  /** The tick heard at an engine frame, from the seams either side of it. */
  private heardTick(frame: number): number {
    let seam = this.seams[0]
    for (const s of this.seams) {
      if (s.frame <= frame) seam = s
      else break
    }
    return this.time.advance(seam.tick, frame - seam.frame)
  }

  private get time() {
    return tempoMap(this.song, this.options.sampleRate)
  }

  /**
   * Arrange to go to `to` at the next moment `when` names, and loop `loop`
   * from there. The moment is found on the timeline being heard, and never
   * past the next place that timeline jumps anyway -- the end of a loop is
   * as good a moment as any.
   */
  private turn(to: number, loop: Loop | null, when: SectionTiming) {
    const now = this.engine.currentFrame
    const heard = this.heardTick(now)
    // A hair back, so a moment heard a rounding error past a barline is
    // still on it rather than a whole bar early for the next.
    const bars = barsOf(this.song)
    const nextBar = () => bars.snapBar(heard - 1e-6, 'ceil')
    let at = heard
    if (when === 'beat') at = bars.snapIn(heard - 1e-6, bars.at(heard - 1e-6).beat, 'ceil')
    else if (when === 'bar') at = nextBar()
    else if (when === 'section') {
      const over = sectionOver(this.song, heard)
      at = over ? sectionEnd(over) : nextBar()
    }
    const next = this.seams.find((s) => s.frame > now && s.before !== undefined)
    if (next && at > next.before!) at = next.before!
    else if (this.loop && heard < this.loop.to && at > this.loop.to) at = this.loop.to
    if (!this.loop) at = Math.min(at, Math.max(heard, songEnd(this.song)))

    let seam = this.seams[0]
    for (const s of this.seams) if (s.frame <= now) seam = s
    const frame = seam.frame + this.time.span(seam.tick, at)
    // Already scheduled past it: take back everything from that moment on.
    if (frame < this.cursor.frame) this.rewindTo(frame, at)
    this.jump = { frame, to, loop }
    this.done = false
  }

  /** Drop what was queued from a frame on, and schedule again from there at `tick`. */
  private rewindTo(frame: number, tick: number) {
    this.engine.dropFrom(Math.round(frame))
    this.seams = this.seams.filter((s) => s.frame < frame)
    this.cursor = { tick, frame }
    this.done = false
  }

  /** Take the waiting jump: let go of everything, and carry on from its tick. */
  private leap(jump: Jump) {
    const frame = Math.round(jump.frame)
    this.engine.scheduleMany(
      engineEventsByTrack(
        this.song.tracks.map((t) => ({ frame, track: t.id, kind: 'off' as const, velocity: 0 })),
        this.targets,
      ),
    )
    this.cursor = { tick: jump.to, frame: jump.frame }
    this.seams.push({ tick: jump.to, frame: jump.frame })
    this.loop = jump.loop
    this.jump = null
    this.done = false
  }

  /**
   * Swing a pattern -- by id or by name -- or every pattern when none is
   * named: 0.5 is straight, about 0.67 a triplet feel, 0.75 a hard shuffle.
   * `step` is what is swung, in ticks: 480 for eighths, 240 for sixteenths
   * (the default, and what the roll offers). Returns false, and changes
   * nothing, for a pattern that is not in the song.
   *
   * It is heard from whatever has not been scheduled yet, a lookahead's
   * worth of time from now. Fine to call on any frame; a note it moves the
   * end of from under the cursor is let go of there rather than left held.
   */
  setSwing(amount: number, pattern?: string, step: number = SWING_STEPS[1]): boolean {
    const ids = pattern === undefined
      ? this.song.patterns.map((p) => p.id)
      : this.song.patterns.filter((p) => p.id === pattern || p.name === pattern).slice(0, 1).map((p) => p.id)
    if (ids.length === 0 || !Number.isFinite(amount)) return false
    let next = this.song
    for (const id of ids) next = setPatternSwing(next, id, amount, step)
    if (next === this.song) return true
    const released = releasedBySwing(this.song, next, this.cursor.tick)
    this.song = next
    if (released.length) {
      const frame = Math.round(this.cursor.frame)
      this.engine.scheduleMany(
        engineEventsByTrack(
          released.map((e) => ({ frame, track: e.track, kind: e.kind, pitch: e.pitch, velocity: e.velocity })),
          this.targets,
        ),
      )
    }
    return true
  }

  /** A pattern's swing as it stands: 0.5 when it is straight, undefined when there is no such pattern. */
  getSwing(pattern: string): number | undefined {
    const p = this.song.patterns.find((x) => x.id === pattern || x.name === pattern)
    return p ? (p.swing?.amount ?? SWING_MIN) : undefined
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
    // Up to a waiting jump, the jump, and on past it: a jump inside this
    // window is taken on its own sample, not at the end of the window.
    for (let passes = 0; this.cursor.frame < until && passes < 8; passes++) {
      const jump = this.jump
      const stop = jump && jump.frame < until ? jump.frame : until
      if (this.cursor.frame < stop) {
        const out = fill(this.song, this.options.sampleRate, this.cursor, stop, this.loop)
        this.cursor = out.cursor
        this.seams.push(...out.seams.map((s: Seam) => ({ ...s })))
        this.engine.scheduleMany(engineEventsByTrack(out.events, this.targets))
        if (out.ended) {
          if (!jump) {
            this.done = true
            break
          }
          // The song ran out before the moment came; wait for it in silence.
          this.cursor = { tick: this.cursor.tick, frame: jump.frame }
        }
      }
      if (jump && this.cursor.frame >= jump.frame - 1e-6) this.leap(jump)
      else if (this.cursor.frame >= until) break
    }
    this.engine.render(left, right)
    // Only the seam behind the speakers is still needed.
    const now = this.engine.currentFrame
    let keep = 0
    while (keep + 1 < this.seams.length && this.seams[keep + 1].frame <= now) keep++
    if (keep > 0) this.seams = this.seams.slice(keep)
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
