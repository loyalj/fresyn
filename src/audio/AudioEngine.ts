import workletUrl from '../dsp/worklet.ts?worker&url'
import type { SampleRecord } from '../dsp/samples'
import type { MixLevels, TrackEvent, TrackMix } from '../dsp/SongEngine'
import type { Console } from '../song/types'
import { compile, type CompiledPatch } from '../patch/compile'
import { initialValues } from '../patch/edit'
import type { Patch } from '../patch/types'

/** One frame of captured samples per scope module, keyed by module id. */
export type ScopeFrames = Record<string, Float32Array>

/**
 * Peaks since the last frame per metering module, keyed by module id. A
 * mixer reports one per channel with its stereo bus last.
 */
export type LevelFrames = Record<string, Float32Array>

/** How a track reaches the mix. Solo and mute are resolved before they get here. */
export type { MixLevels, TrackMix }

interface TrackState {
  compiled: CompiledPatch
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
  private starting?: Promise<void>
  private tracks = new Map<string, TrackState>()
  /**
   * Which gates are being held right now, as `track/module`.
   *
   * A set rather than a flag because the rack is played one Trigger at a
   * time: each one has its own key and its own gate, and holding two at once
   * is the point. It is also what lets a press survive the first start -- the
   * context takes a moment to open, and the gate is recorded here whether the
   * node exists yet or not.
   */
  private open = new Set<string>()

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

  constructor(racks: readonly RackInput[]) {
    for (const r of racks) this.setTrackPatch(r.id, r.patch, r.values)
    this.watched = racks[0]?.id ?? ''
  }

  private warn(id: string, compiled: CompiledPatch) {
    for (const w of compiled.warnings) console.warn(`[fresyn patch ${id}]`, w)
  }

  get isRunning() {
    return this.ctx?.state === 'running'
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
    this.node?.port.postMessage({ type: 'schedule', events })
  }

  /** Move the transport clock, dropping anything queued against the old one. */
  seek(frame: number) {
    this.node?.port.postMessage({ type: 'seek', frame })
  }

  /** Drop what is queued without moving the clock. */
  unschedule() {
    this.node?.port.postMessage({ type: 'unschedule' })
  }

  /** Release every note being held, which is what stopping needs. */
  allNotesOff() {
    this.node?.port.postMessage({ type: 'allNotesOff' })
  }

  setMix(mix: Record<string, TrackMix>) {
    this.mix = mix
    this.node?.port.postMessage({ type: 'mix', mix })
  }

  /** The song's desk: the shared effects and the master bus. */
  setConsole(console: Console) {
    this.desk = console
    this.node?.port.postMessage({ type: 'console', console })
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
    this.node?.port.postMessage({ type: 'watch', track: trackId })
  }

  /**
   * Audio the patches play, kept here so a node built later still gets it.
   *
   * Held rather than fetched because the engine may boot long after a file
   * was dropped -- the rack does not start until something is played.
   */
  private samples: SampleRecord[] = []

  /**
   * Hand every rack a new set of samples without rebuilding any of them.
   *
   * A file landing on a panel has to reach a playing rack; rewiring instead
   * would be audible, and the module that wants the audio is usually the one
   * being listened to.
   */
  setSamples(samples: SampleRecord[]) {
    this.samples = samples
    this.node?.port.postMessage({ type: 'samples', samples })
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

  /** Safe to call on every interaction; only the first one does work. */
  async start(): Promise<void> {
    if (!this.starting) this.starting = this.boot()
    return this.starting
  }

  private async boot() {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(workletUrl)

    const node = new AudioWorkletNode(ctx, 'fresyn-voice', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // Hand over the racks and their knob positions at construction so the
      // node never renders a block with stale defaults.
      // Samples travel at construction for the same reason: a message posted
      // before the node starts is never delivered, and a rack that booted
      // without its audio would be silent until something else happened to
      // send it.
      processorOptions: {
        tracks: [...this.tracks].map(([id, t]) => ({
          id,
          patch: t.compiled,
          params: this.flatParams(id),
        })),
        samples: this.samples,
        watch: this.watched,
        mix: this.mix,
        ...(this.desk ? { console: this.desk } : {}),
      },
    })
    node.port.onmessage = (e) => {
      if (e.data?.type !== 'frame') return
      if (e.data.levels) for (const fn of this.levelListeners) fn(e.data.levels)
      if (e.data.mix) for (const fn of this.mixListeners) fn(e.data.mix)
      if (e.data.scopes) for (const fn of this.scopeListeners) fn(e.data.scopes)
      // Last, so a transport filling its next window does it after the panels
      // have had this frame rather than between two of them.
      if (typeof e.data.frame === 'number') {
        for (const fn of this.frameListeners) fn(e.data.frame)
      }
    }
    node.connect(ctx.destination)

    this.ctx = ctx
    this.node = node
    if (ctx.state === 'suspended') await ctx.resume()
    // Catch the node up on anything held while it was booting. Whatever was
    // pressed and let go in that window is no longer in the set, so a key
    // tapped during the very first start correctly makes no sound rather than
    // sticking open.
    for (const held of this.open) {
      const [track, module] = held.split('/')
      node.port.postMessage({ type: 'gate', open: true, track, module })
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
    const held = this.tracks.get(id)?.values
    this.tracks.set(id, {
      compiled,
      // Seed newly added modules with their defaults.
      values: { ...initialValues(patch), ...pick(values ?? held ?? {}, patch) },
    })
    this.node?.port.postMessage({
      type: 'track',
      id,
      patch: compiled,
      params: this.flatParams(id),
    })
  }

  removeTrack(id: string) {
    this.tracks.delete(id)
    for (const held of [...this.open]) {
      if (held.startsWith(`${id}/`)) this.open.delete(held)
    }
    this.node?.port.postMessage({ type: 'removeTrack', id })
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
      this.node?.port.postMessage({ type: 'param', track: trackId, index, value })
    }
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
    const key = `${trackId}/${moduleId}`
    if (open) this.open.add(key)
    else this.open.delete(key)
    this.node?.port.postMessage({ type: 'gate', open, track: trackId, module: moduleId })
  }
}

/** The subset of held values whose module is still in the patch. */
function pick(values: Record<string, number>, patch: Patch) {
  const live = new Set(patch.modules.map((m) => m.id))
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (live.has(key.slice(0, key.lastIndexOf('.')))) out[key] = value
  }
  return out
}
