import type { Routing } from '../dsp/Console'
import type { SampleBank } from '../dsp/samples'
import { DESK, SongEngine, type TrackEvent, type TrackMix } from '../dsp/SongEngine'
import { compile } from '../patch/compile'
import { defOf } from '../patch/defs'
import { clampValue, type ParamSpec } from '../patch/param'
import { automationBindings, stripTarget, type AutomationBinding } from './automation'
import { engineEventsByTrack, noteTarget, windowEvents, type NoteTarget } from './bind'
import { consoleOf, setPatternSwing, trackMix } from './edit'
import { fromStoredProject, type LoadedProject, type Rack } from './project'
import { fill, type Cursor, type Loop, type Seam } from './transport'
import { releasedBySwing, songEnd, type SongEvent } from './schedule'
import type { NoteTiming, SectionInfo, SectionTiming, SongClock, SongKey } from './game'
import { SCALES } from './scale'
import { sectionEnd, sectionOver, sectionsOf } from './section'
import { barsOf, tempoAt, tempoMap } from './timeline'
import { PPQ, SWING_MIN, SWING_STEPS, type Song, type TempoChange } from './types'

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
  /**
   * Leave out every track that is not heard -- muted, soloed past, or not in
   * `only` -- rather than running it silently.
   *
   * For a render whose mix never changes, which is a bounce and nothing
   * else. Live, a muted track keeps running so that unmuting it comes back
   * in phase (see `SongEngine.render`); a bounce never unmutes anything, so
   * that is arithmetic spent on audio nobody hears. It is what keeps stems
   * from costing the square of the track count: without it every stem ran
   * every rack. The output is the same to the sample, because racks never
   * reach each other and an unheard track adds nothing to the mix or to a
   * send. A track left out cannot be brought back, so a game must not set it.
   */
  onlyHeard?: boolean
}

const DEFAULT_LOOKAHEAD_S = 0.25

export type { NoteTiming, SectionInfo, SectionTiming, SongClock, SongKey } from './game'

export interface NoteOptions {
  /**
   * The frame to play it on, on this player's clock -- what `frameOf` hands
   * back. Left out, it is the next block. A frame already rendered is the
   * next block too: a note cannot be played in the past.
   */
  at?: number
  /**
   * How long to hold it, in seconds. Left out, a pitched note is held until
   * `noteOff`, which is what a held sound -- a hum, a charge -- wants. A
   * trigger is let go of on its own.
   */
  length?: number
}

/** How long a trigger's gate stays open when nothing says otherwise: long enough for any Trigger to see. */
const TRIGGER_SECONDS = 0.02

/** A change of course waiting for its frame: go to `to`, and loop `loop` from there. */
interface Jump {
  frame: number
  /** The tick it happens at, on the timeline being heard, for when the tempo moves under it. */
  at: number
  to: number
  loop: Loop | null
}

/** What the game has done to a track's channel, on top of what the song says. */
interface TrackOverride {
  gain: number
  pan?: number
  mute: boolean
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
  /** Where each automation lane's knob is, in its track's engine or on the desk. */
  private bindings: Map<string, AutomationBinding>
  /**
   * Nothing is queued for the automation: the next fill says where every
   * automated knob stands, not only what changes. True to begin with and
   * after anything that drops what was queued.
   */
  private fresh = true
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
  /**
   * Notes the game has played that are still ahead of the speakers. A
   * change of course drops everything queued past its moment, which would
   * take a game's note-off with it and leave a sound held for good, so these
   * are handed back to the engine after every rewind.
   */
  private played: TrackEvent[] = []
  /** The song's own mix, and what the game has done to it. */
  private songMix: Record<string, TrackMix>
  private overrides = new Map<string, TrackOverride>()
  /** The song's tempos as written, which `setTempoScale` multiplies. */
  private readonly baseTempo: number
  private readonly baseTempos: TempoChange[] | undefined
  private scale = 1

  constructor(
    private song: Song,
    racks: Readonly<Record<string, Rack>>,
    private readonly options: SongPlayerOptions,
  ) {
    this.loop = options.loop ?? null
    this.songLoop = this.loop
    this.lookaheadFrames = (options.lookahead ?? DEFAULT_LOOKAHEAD_S) * options.sampleRate

    const mix = trackMix(song, options.only)
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
      // Its knobs and note target are still built below, so events for it
      // are made as ever; with no rack in the engine they land nowhere.
      if (!options.onlyHeard || mix[track.id]?.audible) tracks.push({ id: track.id, patch: compiled, params })

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

    this.songMix = mix
    this.bindings = automationBindings(song, racks)
    this.baseTempo = song.tempo
    this.baseTempos = song.tempos
    this.engine = new SongEngine(options.sampleRate, tracks, options.seed, options.samples)
    this.engine.setMix(mix)
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
   * A knob the song automates is the game's from then on: the automation
   * stands aside until `releaseParam` hands it back.
   *
   * Returns false, and changes nothing, for a track or knob that is not in
   * the song -- a renamed module is a quiet failure otherwise.
   */
  setParam(track: string, knob: string, value: number): boolean {
    const id = this.trackId(track)
    const reachable = id !== undefined ? this.knobs.get(id)?.get(knob) : undefined
    if (id === undefined || !reachable || !Number.isFinite(value)) return false
    reachable.value = clampValue(reachable.spec, value)
    this.engine.setParam(id, reachable.index, reachable.value)
    this.engine.hold(id, knob, true)
    return true
  }

  /**
   * Hand a knob the game has set back to the song's automation, which picks
   * it up wherever its curve has got to. A knob nothing automates stays
   * where the game left it. False for one that is not in the song.
   */
  releaseParam(track: string, knob: string): boolean {
    const id = this.trackId(track)
    if (id === undefined || !this.knobs.get(id)?.has(knob)) return false
    this.engine.hold(id, knob, false)
    return true
  }

  /** Where a knob stands now, or undefined for one that is not in the song. */
  getParam(track: string, knob: string): number | undefined {
    const id = this.trackId(track)
    return id !== undefined ? this.knobs.get(id)?.get(knob)?.value : undefined
  }

  /** Every knob `setParam` can reach on a track, as `module.param`. */
  paramsOf(track: string): string[] {
    const id = this.trackId(track)
    return id !== undefined ? [...(this.knobs.get(id)?.keys() ?? [])] : []
  }

  /** A track's id, from its id or its name; undefined for one the song does not have. */
  private trackId(track: string): string | undefined {
    return this.knobs.has(track) ? track : this.trackByName.get(track)
  }

  /** Every track, by name, in the song's order. */
  get trackNames(): string[] {
    return this.song.tracks.map((t) => t.name)
  }

  /** Start again from a tick. Anything already queued is dropped. */
  seek(tick: number) {
    this.engine.seek(0)
    this.engine.allNotesOff()
    this.fresh = true
    this.cursor = { tick, frame: 0 }
    this.seams = [{ tick, frame: 0 }]
    this.jump = null
    this.played = []
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
    this.jump = { frame, at, to, loop }
    this.done = false
  }

  /** Drop what was queued from a frame on, and schedule again from there at `tick`. */
  private rewindTo(frame: number, tick: number) {
    const from = Math.round(frame)
    this.engine.dropFrom(from)
    this.engine.scheduleMany(this.played.filter((e) => e.frame >= from))
    this.seams = this.seams.filter((s) => s.frame < frame)
    this.cursor = { tick, frame }
    this.done = false
    this.fresh = true
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
    // Wherever the section's automation has its knobs, from its first sample.
    this.fresh = true
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

  // --- playing from the game -------------------------------------------

  /**
   * The frame, on this player's clock, of the next line of the song's grid:
   * what to hand `noteOn` as `at` for a note that should land on the music.
   * Measured from what is being heard, like `playSection`, and on the song's
   * own tempo -- a player with nothing placed in it still keeps time. `'now'`
   * is the next block.
   */
  frameOf(when: NoteTiming): number {
    const now = this.engine.currentFrame
    if (when === 'now') return now
    const from = this.heardTick(now) - 1e-6
    const bars = barsOf(this.song)
    let at: number
    if (when === 'bar') at = bars.snapBar(from, 'ceil')
    else {
      const step = when === 'beat' ? bars.at(from).beat : when === '8th' ? PPQ / 2 : when === '16th' ? PPQ / 4 : PPQ / 8
      at = bars.snapIn(from, step, 'ceil')
    }
    let seam = this.seams[0]
    for (const s of this.seams) if (s.frame <= now) seam = s
    return Math.max(now, Math.round(seam.frame + this.time.span(seam.tick, at)))
  }

  /**
   * Play a note on a track from the game: a brick, a laser, a hum held for
   * as long as something lasts. `pitch` is in semitones up from the track's
   * bottom key, as the roll counts, and a track with no Keyboard ignores it.
   * `velocity` is 0..1.
   *
   * Returns false, and plays nothing, for a track with nothing in it a note
   * can be played on.
   */
  noteOn(track: string, pitch: number, velocity = 1, options: NoteOptions = {}): boolean {
    const id = this.trackId(track)
    const target = id !== undefined ? this.targets.get(id) : undefined
    if (id === undefined || !target || !Number.isFinite(pitch)) return false
    const frame = this.playFrame(options.at)
    const v = Number.isFinite(velocity) ? Math.min(1, Math.max(0, velocity)) : 1
    const events: SongEvent[] = [{ frame, track: id, kind: 'on', pitch, velocity: v }]
    const length = options.length ?? (target.kind === 'note' ? undefined : TRIGGER_SECONDS)
    if (length !== undefined && Number.isFinite(length)) {
      const off = frame + Math.max(1, Math.round(length * this.options.sampleRate))
      events.push({ frame: off, track: id, kind: 'off', pitch, velocity: 0 })
    }
    this.play(events)
    return true
  }

  /** Fire a track that is a hit: a Trigger, or a pitched track at its bottom key. */
  trigger(track: string, velocity = 1, options: NoteOptions = {}): boolean {
    return this.noteOn(track, 0, velocity, { at: options.at, length: options.length ?? TRIGGER_SECONDS })
  }

  /** Let go of a note the game is holding, or of every note on the track when no pitch is given. */
  noteOff(track: string, pitch?: number, options: Pick<NoteOptions, 'at'> = {}): boolean {
    const id = this.trackId(track)
    if (id === undefined || !this.targets.has(id)) return false
    const off: SongEvent = { frame: this.playFrame(options.at), track: id, kind: 'off', velocity: 0 }
    if (pitch !== undefined && Number.isFinite(pitch)) off.pitch = pitch
    this.play([off])
    return true
  }

  private playFrame(at: number | undefined): number {
    const now = this.engine.currentFrame
    return at !== undefined && Number.isFinite(at) ? Math.max(now, Math.round(at)) : now
  }

  private play(events: SongEvent[]) {
    const out = engineEventsByTrack(events, this.targets)
    this.engine.scheduleMany(out)
    for (const e of out) this.played.push(e)
  }

  /**
   * A track's level from the game, multiplied into its fader: how a layer
   * comes in as a level is cleared. It glides there in about 10 ms, so a
   * fade is this called once a frame. Returns false for a track not in the
   * song.
   */
  setTrackGain(track: string, gain: number): boolean {
    return this.override(track, (o) => {
      if (Number.isFinite(gain)) o.gain = Math.min(4, Math.max(0, gain))
    })
  }

  /**
   * A track's pan from the game, -1 left to 1 right, in place of its strip's
   * own -- and of any automation of it: the game's pan wins.
   */
  setTrackPan(track: string, pan: number): boolean {
    const id = this.trackId(track)
    if (id !== undefined && Number.isFinite(pan)) this.engine.hold(DESK, stripTarget(id, 'pan'), true)
    return this.override(track, (o) => {
      if (Number.isFinite(pan)) o.pan = Math.min(1, Math.max(-1, pan))
    })
  }

  /** Take a track out of the mix, or put it back. It keeps running, so it comes back in time. */
  setTrackMute(track: string, mute: boolean): boolean {
    return this.override(track, (o) => {
      o.mute = mute
    })
  }

  private override(track: string, change: (o: TrackOverride) => void): boolean {
    const id = this.trackId(track)
    if (id === undefined) return false
    const o = this.overrides.get(id) ?? { gain: 1, mute: false }
    change(o)
    this.overrides.set(id, o)
    const mix: Record<string, TrackMix> = {}
    for (const [tid, m] of Object.entries(this.songMix)) {
      const over = this.overrides.get(tid)
      mix[tid] = over
        ? { ...m, gain: m.gain * over.gain, scale: (m.scale ?? 1) * over.gain, audible: m.audible && !over.mute, pan: over.pan ?? m.pan }
        : m
    }
    this.engine.setMix(mix)
    return true
  }

  /**
   * Play the song faster or slower than it was written: 1 is as written,
   * 0.75 a quarter slower. Every tempo in the song moves together, from the
   * next block on; notes keep their places in the bar, and a section change
   * that is waiting still lands on its bar line.
   */
  setTempoScale(scale: number) {
    if (!Number.isFinite(scale)) return
    scale = Math.min(4, Math.max(0.25, scale))
    if (scale === this.scale) return
    const now = this.engine.currentFrame
    const heard = this.heardTick(now)
    this.scale = scale
    this.song = {
      ...this.song,
      tempo: this.baseTempo * scale,
      tempos: this.baseTempos?.map((t) => ({ ...t, bpm: t.bpm * scale })),
    }
    // Everything queued past now was timed at the old tempo.
    this.rewindTo(now, heard)
    this.seams.push({ tick: heard, frame: now })
    if (this.jump) this.jump.frame = now + this.time.span(heard, this.jump.at)
  }

  get tempoScale(): number {
    return this.scale
  }

  /** Where the song is being heard: the bar, the beat, how far into the beat, and the tempo. */
  get clock(): SongClock {
    const tick = this.tick
    const bar = barsOf(this.song).at(tick)
    const beats = (tick - bar.tick) / bar.beat
    return {
      tick,
      bar: bar.index,
      beat: Math.floor(beats),
      phase: beats - Math.floor(beats),
      beatsPerBar: Math.max(1, Math.round(bar.length / bar.beat)),
      bpm: tempoAt(this.song, tick),
    }
  }

  /** The key set in the roll, or null for a song with none. What a game tunes its sounds to. */
  get key(): SongKey | null {
    const scale = this.song.scale
    const steps = scale && SCALES.find((s) => s.id === scale.mode)?.steps
    return scale && steps ? { root: scale.root, mode: scale.mode, steps: [...steps] } : null
  }

  /**
   * Each track's peak since the last call, by name, and the master's: for a
   * game to make the picture move with the music -- a kick that pumps the
   * light, a bass that shakes the floor.
   */
  levels(): { tracks: Record<string, number>; master: number } {
    const read = this.engine.mixLevels()
    const tracks: Record<string, number> = {}
    for (const t of this.song.tracks) tracks[t.name] = read.tracks[t.id] ?? 0
    return { tracks, master: read.master }
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
        const out = fill(this.song, this.options.sampleRate, this.cursor, stop, this.loop, this.fresh)
        this.fresh = false
        this.cursor = out.cursor
        this.seams.push(...out.seams.map((s: Seam) => ({ ...s })))
        this.engine.scheduleMany(windowEvents(out, this.targets, this.bindings))
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
    if (this.played.length) this.played = this.played.filter((e) => e.frame >= now)
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
