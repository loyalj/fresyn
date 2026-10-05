import type { NoteTiming, SectionTiming } from '../song/game'
import type { FromRuntime, LoopSetup, PlayerInfo, PlayerReport, ToRuntime } from './protocol'

/**
 * The game's side of the runtime: one AudioWorklet playing any number of
 * Fresyn projects, and a handle on each.
 *
 * ```js
 * const rt = await FresynRuntime.create(new AudioContext(), processorUrl)
 * const music = await rt.load('music', await (await fetch('world1.fproject.json')).text())
 * const sfx = await rt.load('sfx', await (await fetch('sfx.fproject.json')).text(), { loop: null })
 * sfx.start()
 * music.start({ section: 'Loop' })
 * sfx.noteOn('Laser', 7, 0.9, { length: 0.1, when: '16th', sync: 'music' })
 * ```
 *
 * Nothing here plays a sound itself: every call is a message to the worklet,
 * where the projects run. What comes back is a report about sixty times a
 * second -- each player's bar, beat and levels -- which `clock` carries
 * forward to the moment the sound reaches the speakers.
 */

export interface LoadOptions {
  /** `'song'` (the default) loops the song; `null` plays once, for a bank of sound effects. */
  loop?: LoopSetup
  seed?: number
}

/** Where a player's music is reaching the speakers, worked out from the last report. */
export interface HeardClock {
  /** Beats since the player started, counting across bars. */
  beats: number
  bar: number
  /** The beat within the bar, from nought. */
  beat: number
  /** How far through that beat, 0 up to 1. */
  phase: number
  beatsPerBar: number
  bpm: number
  section: string | null
}

export class FresynRuntime {
  readonly node: AudioWorkletNode
  private players = new Map<string, RuntimePlayer>()
  private waiting = new Map<number, { resolve: (info: PlayerInfo) => void; reject: (e: Error) => void }>()
  private nextRequest = 1
  /** The latest report, and the audio time it describes. */
  private latest: { time: number; players: Record<string, PlayerReport> } = { time: 0, players: {} }

  private constructor(
    readonly context: BaseAudioContext,
    destination: AudioNode,
  ) {
    this.node = new AudioWorkletNode(context, 'fresyn-runtime', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    this.node.connect(destination)
    this.node.port.onmessage = (e: MessageEvent<FromRuntime>) => this.receive(e.data)
  }

  /**
   * Add the worklet to a context and start it. `processorUrl` is the built
   * `fresyn-processor.js`, wherever the game serves it from.
   */
  static async create(context: BaseAudioContext, processorUrl: string, destination: AudioNode = context.destination) {
    await context.audioWorklet.addModule(processorUrl)
    return new FresynRuntime(context, destination)
  }

  /**
   * Load a project -- the text of a `.fproject.json` -- as a player called
   * `id`. It arrives stopped; `start` it. Loading an id again replaces it.
   */
  load(id: string, project: string, options: LoadOptions = {}): Promise<RuntimePlayer> {
    const request = this.nextRequest++
    const done = new Promise<PlayerInfo>((resolve, reject) => this.waiting.set(request, { resolve, reject }))
    this.send({ type: 'load', id, request, project, loop: options.loop, seed: options.seed })
    return done.then((info) => {
      const player = new RuntimePlayer(this, info)
      this.players.set(id, player)
      return player
    })
  }

  unload(id: string) {
    this.players.delete(id)
    this.send({ type: 'unload', id })
  }

  player(id: string): RuntimePlayer | undefined {
    return this.players.get(id)
  }

  /** Everything the runtime plays, together. */
  setMasterGain(gain: number) {
    this.send({ type: 'master', gain })
  }

  /** @internal */
  send(msg: ToRuntime) {
    this.node.port.postMessage(msg)
  }

  /** @internal The last report about one player, and the audio time it was made at. */
  reportOf(id: string): { time: number; report: PlayerReport | undefined } {
    return { time: this.latest.time, report: this.latest.players[id] }
  }

  /**
   * The audio clock as it reaches the speakers: the context's time, less
   * what the device holds back. What a beat on screen has to line up with.
   */
  get heardTime(): number {
    const ctx = this.context as AudioContext
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0)
  }

  /** The audio clock where the engine is rendering: the context's own time. */
  get renderingTime(): number {
    return this.context.currentTime
  }

  private receive(msg: FromRuntime) {
    if (msg.type === 'report') {
      this.latest = msg
      return
    }
    const waiting = this.waiting.get(msg.request)
    if (!waiting) return
    this.waiting.delete(msg.request)
    if (msg.type === 'loaded') waiting.resolve(msg.info)
    else waiting.reject(new Error(msg.message))
  }
}

export interface NoteOptions {
  /** Seconds to hold it. Left out, a pitched note is held until `noteOff`; a hit lets go on its own. */
  length?: number
  /** Land on the next line of a grid rather than straight away. */
  when?: NoteTiming
  /** Whose grid: another player's id. Left out, this player's own song. */
  sync?: string
}

/** One project, playing in the runtime. Every method is a message; none waits. */
export class RuntimePlayer {
  constructor(
    private readonly rt: FresynRuntime,
    readonly info: PlayerInfo,
  ) {}

  get id() {
    return this.info.id
  }

  /** Play from the top, or from a section (looping unless `loop: false`), fading up over `fade` seconds. */
  start(options: { section?: string; loop?: boolean; gain?: number; fade?: number } = {}) {
    this.rt.send({ type: 'start', id: this.id, ...options })
  }

  /** Fade out over `fade` seconds and stop. A stopped player costs nothing. */
  stop(fade = 0) {
    this.rt.send({ type: 'stop', id: this.id, fade })
  }

  /** Go to a section on the next bar (or `when`), looping it unless `loop: false`. */
  playSection(name: string, options: { when?: SectionTiming; loop?: boolean } = {}) {
    this.rt.send({ type: 'section', id: this.id, name, ...options })
  }

  releaseSection() {
    this.rt.send({ type: 'release', id: this.id })
  }

  /**
   * Turn a knob: `track` by name, `knob` as `module.param`, in the knob's own
   * units. One the song automates is the game's until `releaseParam`.
   */
  setParam(track: string, knob: string, value: number) {
    this.rt.send({ type: 'param', id: this.id, track, knob, value })
  }

  /** Hand a knob back to the song's automation. */
  releaseParam(track: string, knob: string) {
    this.rt.send({ type: 'releaseParam', id: this.id, track, knob })
  }

  /** Play a note, in semitones up from the track's bottom key. */
  noteOn(track: string, pitch: number, velocity = 1, options: NoteOptions = {}) {
    this.rt.send({ type: 'note', id: this.id, track, pitch, velocity, ...options })
  }

  noteOff(track: string, pitch?: number) {
    this.rt.send({ type: 'noteOff', id: this.id, track, pitch })
  }

  /** Fire a hit. */
  trigger(track: string, velocity = 1, options: Omit<NoteOptions, 'length'> = {}) {
    this.rt.send({ type: 'trigger', id: this.id, track, velocity, ...options })
  }

  setTrackGain(track: string, gain: number) {
    this.rt.send({ type: 'track', id: this.id, track, gain })
  }

  setTrackPan(track: string, pan: number) {
    this.rt.send({ type: 'track', id: this.id, track, pan })
  }

  setTrackMute(track: string, mute: boolean) {
    this.rt.send({ type: 'track', id: this.id, track, mute })
  }

  /** 1 is as written; 0.75 a quarter slower. */
  setTempoScale(scale: number) {
    this.rt.send({ type: 'tempo', id: this.id, scale })
  }

  /** This player's own level and muffle (0 open, 1 as if through a wall), gliding over `glide` seconds. */
  setBus(bus: { gain?: number; muffle?: number; glide?: number }) {
    this.rt.send({ type: 'bus', id: this.id, ...bus })
  }

  /** The last report, as it came. */
  get report(): PlayerReport | undefined {
    return this.rt.reportOf(this.id).report
  }

  get playing(): boolean {
    return this.report?.playing ?? false
  }

  /**
   * Where the music is reaching the speakers now: the last report's
   * position, carried forward by the time since it was made. Good for
   * drawing, and for judging whether something happened on the beat.
   *
   * `'rendering'` is where the engine is instead, ahead of the speakers by
   * the device's latency: the clock to act on when something should be heard
   * on a beat -- a note played the moment this clock crosses the beat reaches
   * the speakers on it.
   */
  clock(at: 'heard' | 'rendering' = 'heard'): HeardClock | null {
    const { time, report } = this.rt.reportOf(this.id)
    if (!report) return null
    const c = report.clock
    const now = at === 'heard' ? this.rt.heardTime : this.rt.renderingTime
    const elapsed = report.playing ? now - time : 0
    const beats = c.bar * c.beatsPerBar + c.beat + c.phase + (elapsed * c.bpm) / 60
    const whole = Math.floor(beats)
    return {
      beats,
      bar: Math.floor(whole / c.beatsPerBar),
      beat: ((whole % c.beatsPerBar) + c.beatsPerBar) % c.beatsPerBar,
      phase: beats - whole,
      beatsPerBar: c.beatsPerBar,
      bpm: c.bpm,
      section: report.section,
    }
  }

  /** Each track's peak over the last report, by name. */
  level(track: string): number {
    return this.report?.levels[track] ?? 0
  }
}
