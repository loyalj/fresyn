import workletUrl from '../dsp/worklet.ts?worker&url'
import type { FromWorklet, ProcessorOptions, TelemetryLayout, ToWorklet } from '../dsp/protocol'
import type { SampleRecord } from '../dsp/samples'
import type { MixLevels, TrackEvent, TrackMix } from '../dsp/SongEngine'
import type { Console } from '../song/types'
import { compile, type CompiledPatch } from '../patch/compile'
import { initialValues } from '../patch/edit'
import { flattenKits } from '../patch/kit'
import type { Patch } from '../patch/types'
import { canShare } from './shared'

/**
 * Room for the reports in shared memory: two halves of a quarter of a
 * megabyte, which holds some dozens of scopes -- far more than a rack has --
 * with the rest of a report in a corner of it.
 */
const TELEMETRY_BYTES = 512 * 1024

/** One half of the shared telemetry, read through views made for its layout. */
interface TelemetrySlot {
  levels: LevelFrames | undefined
  scopes: ScopeFrames | undefined
  mix: MixLevels
  update(): void
}

/** One frame of captured samples per scope module, keyed by module id. */
export type ScopeFrames = Record<string, Float32Array>

/**
 * Peaks since the last frame per metering module, keyed by module id. A
 * mixer reports one per channel with its stereo bus last.
 */
export type LevelFrames = Record<string, Float32Array>

/** How a track reaches the mix. Solo and mute are resolved before they get here. */
export type { MixLevels, TrackMix }

/**
 * Where the audio device is, for the UI to show.
 *
 * - `idle`: nothing has asked for sound yet. The context is only opened by a
 *   gesture, so this is how every session begins.
 * - `starting`: the context and the worklet are being built.
 * - `running`: sound is coming out, or would be if anything were playing.
 * - `suspended`: built, but the browser has paused it -- a context opened
 *   without a gesture, an iOS interruption, a device being unplugged. The
 *   next `start()` asks for it back, and must come from a gesture to get it.
 * - `failed`: building it threw, or the processor died mid-render. Nothing
 *   is left open; the next `start()` builds everything again from scratch.
 */
export type EngineState = 'idle' | 'starting' | 'running' | 'suspended' | 'failed'

export interface EngineStatus {
  state: EngineState
  /** Why, for `failed`; a sentence fit to show as it is. */
  error?: string
}

/**
 * How long `start()` waits for a suspended context to come back before it
 * gives up waiting and returns anyway.
 *
 * `resume()` is not guaranteed to settle. Called without a gesture it stays
 * pending until one arrives, which may be never, and everything awaiting
 * `start()` -- a preview, the transport -- would hang with it. A resume that
 * is going to succeed does so in a few milliseconds, so a short bound costs
 * nothing, and the context still comes up later on its own if it can: the
 * status reports it when it does.
 */
const RESUME_GRACE_MS = 250

/**
 * How long a device switch is waited on while the context is being built.
 * Like a resume, it is not promised to settle, and a build that hung on it
 * would leave the rack silent with nothing said.
 */
const SINK_GRACE_MS = 1000

/**
 * How much buffering to ask the device for. A named mode is the browser's own
 * scale; a number is a buffer in milliseconds, which the browser rounds to
 * whatever the hardware can do.
 */
export type LatencyMode = 'low' | 'balanced' | 'safe'

/**
 * How the audio device is opened. Kept by this browser, not by the project:
 * two people opening the same file have different sound cards.
 */
export interface AudioSettings {
  /** An output's `deviceId`. Absent or empty is the system's default. */
  device?: string
  /** Absent is `low`, which is what the rack has always opened with. */
  latency?: LatencyMode | number
  /** Absent is whatever the device runs at. */
  sampleRate?: number
}

/** What the device actually gave, as opposed to what was asked for. */
export interface AudioMeasure {
  /** The context's own buffering, in seconds. */
  base: number
  /** From the context to the speaker, in seconds; 0 where the browser cannot tell. */
  output: number
  sampleRate: number
}

/** `setSinkId` on a context, which the DOM typings do not have yet. */
interface Sinkable {
  setSinkId(id: string): Promise<void>
  readonly sinkId: string | object
}

/** Whether this browser can send a context to a chosen output (Chrome, Edge). */
export const canChooseOutput =
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

function latencyHint(latency: AudioSettings['latency']): AudioContextLatencyCategory | number {
  if (typeof latency === 'number') return latency / 1000
  if (latency === 'balanced') return 'balanced'
  if (latency === 'safe') return 'playback'
  return 'interactive'
}

interface TrackState {
  compiled: CompiledPatch
  /** The compiled patch as text, to tell an edit the audio would not hear from one it would. */
  shape?: string
  /** Knob positions by `moduleId.paramId`, not by flat index; a recompile renumbers. */
  values: Record<string, number>
}

export interface RackInput {
  id: string
  patch: Patch
  values?: Record<string, number>
}

/**
 * Main-thread handle on the worklet. Patches are compiled here and shipped to
 * the audio thread as flat execution plans; React never touches the
 * AudioContext directly.
 *
 * Everything is addressed by track. A single rack on the bench is a song of
 * one track, which is what keeps this from having two of every method.
 */
export class AudioEngine {
  private ctx?: AudioContext
  private node?: AudioWorkletNode
  /**
   * The build in progress or the one that finished, so every caller shares
   * it. Cleared whenever what it built is torn down -- a failed build, a dead
   * processor -- so that the next `start()` builds again instead of handing
   * back the same broken result forever.
   */
  private starting?: Promise<boolean>
  private tracks = new Map<string, TrackState>()
  /**
   * Which gates are being held right now, as modules by track.
   *
   * Nested rather than joined into one `track/module` string, which would
   * come apart wrongly the day an id had a slash in it.
   *
   * A set rather than a flag because the rack is played one Trigger at a
   * time: each one has its own key and its own gate, and holding two at once
   * is the point. It is also what lets a press survive the first start -- the
   * context takes a moment to open, and the gate is recorded here whether the
   * node exists yet or not.
   */
  private open = new Map<string, Set<string>>()

  private statusNow: EngineStatus = { state: 'idle' }
  private statusListeners = new Set<(status: EngineStatus) => void>()

  /**
   * Display frames arrive ~30 times a second. They are handed out by
   * subscription rather than as React state on purpose: a component that
   * draws them straight to a canvas or to a bar's geometry causes no render,
   * where putting them into state would re-render the whole rack thirty
   * times a second.
   */
  private scopeListeners = new Set<(frames: ScopeFrames) => void>()
  private levelListeners = new Set<(levels: LevelFrames) => void>()
  private mixListeners = new Set<(levels: MixLevels) => void>()
  /**
   * The last mix and desk asked for, kept so that the processor is built with
   * them. Posted to a processor that did not exist yet, they would be lost.
   */
  private mix: Record<string, TrackMix> = {}
  private desk: Console | null = null
  private frameListeners = new Set<(frame: number) => void>()

  /** The track whose panels are on screen, and so the only one worth metering. */
  private watched = ''

  /** How the next context is opened. See `configure`. */
  private settings: AudioSettings

  constructor(racks: readonly RackInput[], settings: AudioSettings = {}) {
    for (const r of racks) this.setTrackPatch(r.id, r.patch, r.values)
    this.watched = racks[0]?.id ?? ''
    this.settings = settings
  }

  /**
   * Whether `configure(next)` would close the context and open another. The
   * sample clock starts again at 0 when it does, so a transport has to be
   * stopped first.
   */
  wouldRebuild(next: AudioSettings): boolean {
    if (!this.ctx) return false
    return (
      latencyHint(next.latency) !== latencyHint(this.settings.latency) ||
      next.sampleRate !== this.settings.sampleRate
    )
  }

  /**
   * Change how the device is opened.
   *
   * The output moves without a break where the browser allows it. Latency and
   * sample rate are fixed when a context is built, so changing either closes
   * this one and builds another from what is held here -- the racks, knobs,
   * samples, mix and held gates all come across, as they do after a failure.
   * Before anything has been played this only records the change.
   *
   * Resolves with a sentence to show if the output could not be moved, or
   * `null`. Never rejects, like `start()`.
   */
  async configure(next: AudioSettings): Promise<string | null> {
    const rebuild = this.wouldRebuild(next)
    const moved = (next.device ?? '') !== (this.settings.device ?? '')
    this.settings = next
    const ctx = this.ctx
    if (!ctx) return null
    if (rebuild) {
      this.release()
      // The device choice is made again inside the build.
      return (await this.start()) ? this.sinkProblem : null
    }
    if (moved) return this.route(ctx)
    return null
  }

  /** Set by the last attempt to move the output, when it failed. */
  private sinkProblem: string | null = null

  /**
   * Send the context to the chosen output. A device that is gone, or that the
   * page may not use, leaves the context on the default and says so rather
   * than failing the whole engine.
   */
  private async route(ctx: AudioContext): Promise<string | null> {
    this.sinkProblem = null
    if (!canChooseOutput) return null
    const sink = ctx as AudioContext & Sinkable
    const want = this.settings.device ?? ''
    if ((typeof sink.sinkId === 'string' ? sink.sinkId : '') === want) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        sink.setSinkId(want),
        new Promise<void>((_, fail) => {
          timer = setTimeout(() => fail(new Error('the device did not answer')), SINK_GRACE_MS)
        }),
      ])
    } catch (err) {
      this.sinkProblem = `Could not play through that output (${
        err instanceof Error && err.message ? err.message : 'unavailable'
      }), so the default is being used.`
      if (want !== '') sink.setSinkId('').catch(() => {})
    } finally {
      clearTimeout(timer)
    }
    return this.sinkProblem
  }

  /**
   * What the device is actually doing, or `null` before it is open. Read
   * fresh each time: the output figure moves as the browser learns more
   * about the device.
   */
  measure(): AudioMeasure | null {
    const ctx = this.ctx
    if (!ctx || !this.node) return null
    return {
      base: ctx.baseLatency ?? 0,
      output: ctx.outputLatency ?? 0,
      sampleRate: ctx.sampleRate,
    }
  }

  private warn(id: string, compiled: CompiledPatch) {
    for (const w of compiled.warnings) console.warn(`[fresyn patch ${id}]`, w)
  }

  /**
   * True only while sound can actually come out: the context is running and
   * the processor in it is alive. The context's own state is not enough on
   * its own -- a processor that threw leaves its context happily `running`
   * and completely silent.
   */
  get isRunning() {
    return this.statusNow.state === 'running'
  }

  /**
   * The current status. The object is replaced, never mutated, when anything
   * changes, so it can be compared by identity (`useSyncExternalStore` wants
   * exactly that).
   */
  get status(): EngineStatus {
    return this.statusNow
  }

  /** Subscribe to status changes. Returns the unsubscribe. */
  onStatus(fn: (status: EngineStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => {
      this.statusListeners.delete(fn)
    }
  }

  private setStatus(state: EngineState, error?: string) {
    const now = this.statusNow
    if (now.state === state && now.error === error) return
    this.statusNow = error === undefined ? { state } : { state, error }
    for (const fn of this.statusListeners) fn(this.statusNow)
  }

  /**
   * Read the context's state into the status, once the build is done. While
   * it is still being built this says nothing: a fresh context passes through
   * `suspended` on its way up, and reporting that would flash a warning at
   * every first press.
   */
  private syncStatus() {
    const ctx = this.ctx
    if (!ctx || !this.node) return
    // Anything but `running` -- `suspended`, or Safari's `interrupted` for a
    // phone call or another app taking the audio session -- is the same thing
    // to the user: built, and silent until asked back.
    this.setStatus(ctx.state === 'running' ? 'running' : 'suspended')
  }

  /** Every message to the processor goes through here, so all of them are typed. */
  private post(msg: ToWorklet) {
    this.node?.port.postMessage(msg)
  }

  /** The context's rate, or the usual default before one has been opened. */
  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000
  }

  compiledFor(trackId: string) {
    return this.tracks.get(trackId)?.compiled
  }

  /** Subscribe to scope frames. Returns the unsubscribe. */
  onScopeFrame(fn: (frames: ScopeFrames) => void): () => void {
    this.scopeListeners.add(fn)
    return () => {
      this.scopeListeners.delete(fn)
    }
  }

  /** Subscribe to meter levels. Returns the unsubscribe. */
  onLevels(fn: (levels: LevelFrames) => void): () => void {
    this.levelListeners.add(fn)
    return () => {
      this.levelListeners.delete(fn)
    }
  }

  /**
   * Subscribe to the audio thread's own clock, in samples.
   *
   * The transport runs off this rather than off a timer. A timer counts wall
   * time, which drifts against the audio device and stops being delivered at
   * all in a background tab; the only clock that agrees with what is coming
   * out of the speakers is the one counting the samples going into them.
   */
  onFrame(fn: (frame: number) => void): () => void {
    this.frameListeners.add(fn)
    return () => {
      this.frameListeners.delete(fn)
    }
  }

  /** Hand the audio thread a window of events to play at exact samples. */
  schedule(events: readonly TrackEvent[]) {
    if (events.length === 0) return
    this.post({ type: 'schedule', events })
  }

  /** Move the transport clock, dropping anything queued against the old one. */
  seek(frame: number) {
    this.post({ type: 'seek', frame })
  }

  /** Drop what is queued without moving the clock. */
  unschedule() {
    this.post({ type: 'unschedule' })
  }

  /** Release every note being held, which is what stopping needs. */
  allNotesOff() {
    this.post({ type: 'allNotesOff' })
  }

  setMix(mix: Record<string, TrackMix>) {
    this.mix = mix
    this.post({ type: 'mix', mix })
  }

  /** The song's desk: the shared effects and the master bus. */
  setConsole(console: Console) {
    this.desk = console
    this.post({ type: 'console', console })
  }

  /** Subscribe to the Mix view's levels: every track after its strip, and the master. */
  onMixLevels(fn: (levels: MixLevels) => void): () => void {
    this.mixListeners.add(fn)
    return () => {
      this.mixListeners.delete(fn)
    }
  }

  /** Which track's scopes and meters to report: the rack on the bench. */
  watch(trackId: string) {
    if (this.watched === trackId) return
    this.watched = trackId
    this.post({ type: 'watch', track: trackId })
  }

  /**
   * Audio the patches play, kept here so a node built later still gets it.
   *
   * Held rather than fetched because the engine may boot long after a file
   * was dropped -- the rack does not start until something is played.
   */
  private samples: SampleRecord[] = []
  /** Which of them the running node already has. */
  private sent = new Set<string>()

  /**
   * Hand every rack a new set of samples without rebuilding any of them.
   *
   * A file landing on a panel has to reach a playing rack; rewiring instead
   * would be audible, and the module that wants the audio is usually the one
   * being listened to.
   *
   * Only what the node has not had yet goes over. The whole library used to,
   * on every file dropped and every change of track -- cloned, and
   * deserialized on the audio thread between two blocks, which for a few
   * minutes of audio is a dropout. Where memory is shared what goes is not a
   * copy at all (see `SampleLibrary`), but sending each file once is right
   * either way.
   */
  setSamples(samples: SampleRecord[]) {
    this.samples = samples
    const fresh = samples.filter((s) => !this.sent.has(s.id))
    if (fresh.length === 0 || !this.node) return
    for (const s of fresh) this.sent.add(s.id)
    this.post({ type: 'addSamples', samples: fresh })
  }

  /** Current knob values for one track, laid out for its compiled patch. */
  private flatParams(id: string): number[] {
    const track = this.tracks.get(id)
    if (!track) return []
    const flat = track.compiled.params.slice()
    for (const [key, value] of Object.entries(track.values)) {
      const index = track.compiled.paramIndex[key]
      if (index !== undefined) flat[index] = value
    }
    return flat
  }

  /**
   * Open the audio device, or bring it back. Safe to call on every
   * interaction, and meant to be: each call is a gesture the browser may
   * need before it lets the context run.
   *
   * Resolves `true` once the graph exists, whether or not the context has
   * actually started running -- see `RESUME_GRACE_MS` for why that is not
   * waited on indefinitely -- and `false` if it could not be built, with the
   * reason in `status`. It never rejects: almost every caller fires it and
   * forgets, and a failure is the status's to report, not an unhandled
   * rejection's.
   */
  /**
   * Fetch the worklet's code ahead of the first press, once the page is idle.
   *
   * The context still waits for a gesture, as it has to; what need not wait
   * is the download. The file is content-hashed and cached for good, so the
   * `addModule` a press makes finds it already here instead of starting a
   * round trip -- on a slow connection most of the time before the first
   * note sounds. Fire and forget: a failure here is the press's to report.
   */
  prefetch() {
    if (this.starting || typeof fetch === 'undefined') return
    void fetch(workletUrl).catch(() => {})
  }

  /**
   * The audio context, started if it is not yet: for something that plays
   * through the same device as the rack but not through the rack -- a
   * utility's click, a test tone. Null when it could not be started.
   */
  async context(): Promise<AudioContext | null> {
    await this.start()
    return this.ctx ?? null
  }

  async start(): Promise<boolean> {
    let attempt = this.starting
    if (!attempt) {
      attempt = this.boot()
      this.starting = attempt
    }
    const built = await attempt
    if (!built) {
      // Forget the failure so the next call tries again, but only if nothing
      // has started a newer attempt in the meantime.
      if (this.starting === attempt) this.starting = undefined
      return false
    }
    await this.resume()
    return this.node !== undefined
  }

  /**
   * Ask a suspended context to run, waiting a moment for it but no longer.
   *
   * Asked on every `start()` rather than only the first: a context can be
   * suspended long after it was built, by the browser rather than by us, and
   * the user's next click is the first chance to get it back.
   */
  private async resume() {
    const ctx = this.ctx
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      // A rejection here is a browser refusing, which the status already
      // shows as `suspended`; there is nothing more to say about it.
      ctx.resume().catch(() => {}),
      new Promise<void>((done) => {
        timer = setTimeout(done, RESUME_GRACE_MS)
      }),
    ])
    clearTimeout(timer)
    if (this.ctx === ctx) this.syncStatus()
  }

  /**
   * Build the context, the worklet and the node, and hand the node
   * everything held here.
   *
   * Also the rebuild after a failure: everything the processor needs --
   * racks, knob positions, samples, mix, desk, watched track, held gates --
   * is kept on this side, so a fresh node built from it is the same rack.
   * What is not kept is the transport's queue and clock; those belong to
   * the transport, which should stop when it sees `failed`.
   */
  private async boot(): Promise<boolean> {
    this.setStatus('starting')
    let ctx: AudioContext | undefined
    try {
      const { sampleRate } = this.settings
      const opened = new AudioContext({
        latencyHint: latencyHint(this.settings.latency),
        ...(sampleRate ? { sampleRate } : {}),
      })
      ctx = opened
      this.ctx = opened
      opened.onstatechange = () => this.onContextState(opened)
      // Moved here rather than passed to the constructor: a device id that
      // has gone stale since it was saved would make the constructor throw,
      // and one unplugged headset would leave the whole rack silent.
      await this.route(opened)
      if (this.ctx !== opened) return false
      await opened.audioWorklet.addModule(workletUrl)
      // Torn down while the module loaded; whatever did that has already
      // said why.
      if (this.ctx !== opened) return false

      const options: ProcessorOptions = {
        tracks: [...this.tracks].map(([id, t]) => ({
          id,
          patch: t.compiled,
          params: this.flatParams(id),
        })),
        samples: this.samples,
        watch: this.watched,
        mix: this.mix,
        ...(this.desk ? { console: this.desk } : {}),
        ...(canShare ? { telemetry: new SharedArrayBuffer(TELEMETRY_BYTES) } : {}),
      }
      this.sent = new Set(this.samples.map((s) => s.id))
      this.telemetry = options.telemetry ?? null
      this.slots = []
      const node = new AudioWorkletNode(opened, 'fresyn-voice', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        // Hand over the racks and their knob positions at construction so the
        // node never renders a block with stale defaults.
        // Samples travel at construction for the same reason: a message posted
        // before the node starts is never delivered, and a rack that booted
        // without its audio would be silent until something else happened to
        // send it.
        processorOptions: options,
      })
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.receive(e.data)
      // An exception in the processor -- in its constructor or in any block
      // it renders -- stops it for good, and says so only here. Without this
      // the context would carry on `running` with nothing in it, and the rack
      // would simply go quiet with every light still green.
      node.onprocessorerror = () => {
        if (this.node !== node) return
        this.teardown('The audio engine stopped after an internal error.')
      }
      node.connect(opened.destination)
      this.node = node

      // Catch the node up on anything held while it was booting. Whatever was
      // pressed and let go in that window is no longer in the set, so a key
      // tapped during the very first start correctly makes no sound rather than
      // sticking open.
      for (const [track, modules] of this.open) {
        for (const module of modules) this.post({ type: 'gate', open: true, track, module })
      }
      // Only a context already running is reported here. One still suspended
      // is left as `starting` for `start()` to resume and then report, so a
      // context that was only on its way up does not flash as paused.
      if (opened.state === 'running') this.syncStatus()
      return true
    } catch (err) {
      // Close what was opened, so a failed start leaks no context -- browsers
      // allow only a handful -- and the next start begins from nothing. A
      // context that is no longer ours was torn down by whatever replaced
      // it, and the status already says why.
      if (!ctx) this.setStatus('failed', describe(err))
      else if (this.ctx === ctx) this.teardown(describe(err))
      else ctx.close().catch(() => {})
      return false
    }
  }

  private receive(msg: FromWorklet) {
    if (msg.type === 'layout') {
      this.lay(msg.layout)
      return
    }
    if (msg.type === 'tick') {
      const read = this.slots[msg.slot]
      if (!read) return
      read.update()
      this.deliver(msg.frame, read.levels, read.mix, read.scopes)
      return
    }
    this.deliver(msg.frame, msg.levels, msg.mix, msg.scopes)
  }

  private deliver(
    frame: number,
    levels: LevelFrames | undefined,
    mix: MixLevels,
    scopes: ScopeFrames | undefined,
  ) {
    if (levels) for (const fn of this.levelListeners) fn(levels)
    for (const fn of this.mixListeners) fn(mix)
    if (scopes) for (const fn of this.scopeListeners) fn(scopes)
    // Last, so a transport filling its next window does it after the panels
    // have had this frame rather than between two of them.
    for (const fn of this.frameListeners) fn(frame)
  }

  // --- shared telemetry ---------------------------------------------------
  //
  // Where memory can be shared, the processor writes its reports into
  // `telemetry` and says only which half: see `TelemetryLayout`. Each half is
  // read through views made once per layout, so a report is read without a
  // copy and without allocating anything.

  private telemetry: SharedArrayBuffer | null = null
  private slots: TelemetrySlot[] = []

  /** Views onto both halves for a new layout. */
  private lay(layout: TelemetryLayout) {
    const buffer = this.telemetry
    if (!buffer) return
    const slotFloats = Math.floor(buffer.byteLength / 4 / 2)
    this.slots = [0, 1].map((slot) => {
      const base = slot * slotFloats
      const view = (at: number, length: number) => new Float32Array(buffer, (base + at) * 4, length)
      const levels: LevelFrames = {}
      for (const e of layout.levels) levels[e.id] = view(e.at, e.length)
      const scopes: ScopeFrames = {}
      for (const e of layout.scopes) scopes[e.id] = view(e.at, e.length)
      const floats = view(layout.mixAt, layout.tracks.length + 3)
      const mix: MixLevels = { tracks: {}, master: 0, momentary: -99, shortTerm: -99 }
      const n = layout.tracks.length
      return {
        levels: layout.levels.length ? levels : undefined,
        scopes: layout.scopes.length ? scopes : undefined,
        mix,
        update() {
          // The one object, refilled: every listener reads it on the spot.
          for (let k = 0; k < n; k++) mix.tracks[layout.tracks[k]] = floats[k]
          mix.master = floats[n]
          mix.momentary = floats[n + 1]
          mix.shortTerm = floats[n + 2]
        },
      }
    })
  }

  /**
   * The context changed state under us: the browser suspended it, iOS
   * interrupted it, the output device went away, or it came back.
   */
  private onContextState(ctx: AudioContext) {
    if (this.ctx !== ctx) return
    if (ctx.state === 'closed') {
      this.teardown('The audio device was closed.')
      return
    }
    this.syncStatus()
  }

  /**
   * Drop the node and the context and forget the build, so that the next
   * `start()` makes new ones. The status says why.
   *
   * Handlers are cut before anything is closed: the close would otherwise
   * report back through `onstatechange` as a second, confusing failure.
   */
  private teardown(error: string) {
    this.release()
    this.setStatus('failed', error)
  }

  /** Drop the node and the context and forget the build, saying nothing. */
  private release() {
    const ctx = this.ctx
    const node = this.node
    this.ctx = undefined
    this.node = undefined
    this.starting = undefined
    if (node) {
      node.port.onmessage = null
      node.onprocessorerror = null
      node.disconnect()
    }
    if (ctx) {
      ctx.onstatechange = null
      if (ctx.state !== 'closed') ctx.close().catch(() => {})
    }
  }

  /**
   * Recompile one track after a patch edit and rewire its running graph.
   *
   * `values` replaces that track's held knob positions outright. Loading a
   * patch must pass them: merging into what is already here would let a knob
   * from the old rack survive onto a module of the same name in the new one.
   */
  setTrackPatch(id: string, patch: Patch, values?: Record<string, number>) {
    const compiled = compile(patch)
    this.warn(id, compiled)
    const was = this.tracks.get(id)
    const held = was?.values
    // Seed newly added modules with their defaults.
    const nextValues = { ...initialValues(patch), ...pick(values ?? held ?? {}, patch) }
    // An edit the audio cannot hear -- a note on the rack, a cable's colour --
    // compiles to exactly what is already running. Rebuilding the track for
    // it would cost the audio thread a rebuild for nothing, so only the knobs
    // go over, and only those that moved.
    const shape = JSON.stringify(compiled)
    if (was && was.shape === shape) {
      this.setValues(id, nextValues)
      return
    }
    this.tracks.set(id, { compiled, shape, values: nextValues })
    this.post({
      type: 'track',
      id,
      patch: compiled,
      params: this.flatParams(id),
    })
  }

  removeTrack(id: string) {
    this.tracks.delete(id)
    this.open.delete(id)
    this.post({ type: 'removeTrack', id })
  }

  /**
   * Push knob values for one track, sending only what actually changed.
   *
   * Everything goes through here rather than through a per-knob call so that
   * undo, redo and patch loads land the same way a knob drag does; a drag then
   * costs one scan of a few dozen numbers per frame, which is nothing.
   */
  setValues(trackId: string, values: Record<string, number>) {
    const track = this.tracks.get(trackId)
    if (!track) return
    for (const [key, value] of Object.entries(values)) {
      if (track.values[key] === value) continue
      track.values[key] = value
      const index = track.compiled.paramIndex[key]
      if (index === undefined) continue
      this.post({ type: 'param', track: trackId, index, value })
    }
  }

  /**
   * One knob, straight from the hand.
   *
   * The same message `setValues` would send a render later, sent now: a knob
   * that waited for the edit to render and commit reached the speakers a
   * frame or two behind the pointer. `setValues` then finds the value already
   * here and sends nothing, so the two never disagree.
   */
  setValue(trackId: string, key: string, value: number) {
    const track = this.tracks.get(trackId)
    if (!track || track.values[key] === value) return
    track.values[key] = value
    const index = track.compiled.paramIndex[key]
    if (index !== undefined) this.post({ type: 'param', track: trackId, index, value })
  }

  /**
   * Play a rendered take through the same context as the rack, so auditioning
   * needs no second audio device and no round trip through a file.
   */
  async preview(
    left: Float32Array<ArrayBuffer>,
    right: Float32Array<ArrayBuffer>,
    sampleRate: number,
    onEnded?: () => void,
  ): Promise<() => void> {
    // Bounded, like every start: a preview asked for without a gesture comes
    // back with the context still suspended, and plays once it resumes
    // rather than leaving the caller waiting on a promise that never ends.
    await this.start()
    const ctx = this.ctx
    if (!ctx || left.length === 0) return () => {}

    const buffer = ctx.createBuffer(2, left.length, sampleRate)
    buffer.copyToChannel(left, 0)
    buffer.copyToChannel(right, 1)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => onEnded?.()
    source.start()

    return () => {
      // Already-stopped sources throw; the caller does not care.
      try {
        source.stop()
      } catch {
        /* ignored */
      }
    }
  }

  /**
   * Open or close one module's gate on one track.
   *
   * Recorded before it is posted, and safe to call before the context has
   * opened: the audio thread is caught up in `boot`.
   */
  gate(open: boolean, trackId: string, moduleId: string) {
    let held = this.open.get(trackId)
    if (open) {
      if (!held) this.open.set(trackId, (held = new Set()))
      held.add(moduleId)
    } else if (held) {
      held.delete(moduleId)
      if (held.size === 0) this.open.delete(trackId)
    }
    this.post({ type: 'gate', open, track: trackId, module: moduleId })
  }
}

/** The subset of held values whose module is still in the patch. */
function pick(values: Record<string, number>, patch: Patch) {
  // A Drum Kit's pads are modules too, by their laid-in ids.
  const live = new Set(flattenKits(patch).modules.map((m) => m.id))
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (live.has(key.slice(0, key.lastIndexOf('.')))) out[key] = value
  }
  return out
}

/** An error of any shape, as one sentence for the status. */
function describe(err: unknown): string {
  if (err instanceof Error && err.message) return `Audio could not start: ${err.message}`
  return 'Audio could not start.'
}
