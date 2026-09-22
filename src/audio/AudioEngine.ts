import workletUrl from '../dsp/worklet.ts?worker&url'
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

/**
 * Main-thread handle on the worklet. The patch is compiled here and shipped
 * to the audio thread as a flat execution plan; React never touches the
 * AudioContext directly.
 *
 * Knob values are held by `moduleId.paramId` rather than by flat index,
 * because recompiling after a patch edit renumbers the flat array.
 */
export class AudioEngine {
  private ctx?: AudioContext
  private node?: AudioWorkletNode
  private starting?: Promise<void>
  private values: Record<string, number>
  /**
   * Which modules are being held open right now.
   *
   * A set rather than a flag because the rack is played one Trigger at a
   * time: each one has its own key and its own gate, and holding two at once
   * is the point. It is also what lets a press survive the first start -- the
   * context takes a moment to open, and the gate is recorded here whether the
   * node exists yet or not.
   */
  private open = new Set<string>()

  compiled: CompiledPatch

  /**
   * Display frames arrive ~30 times a second. They are handed out by
   * subscription rather than as React state on purpose: a component that
   * draws them straight to a canvas or to a bar's geometry causes no render,
   * where putting them into state would re-render the whole rack thirty
   * times a second.
   */
  private scopeListeners = new Set<(frames: ScopeFrames) => void>()
  private levelListeners = new Set<(levels: LevelFrames) => void>()

  constructor(patch: Patch) {
    this.compiled = compile(patch)
    this.values = initialValues(patch)
    this.warn()
  }

  private warn() {
    for (const w of this.compiled.warnings) console.warn('[fresyn patch]', w)
  }

  get isRunning() {
    return this.ctx?.state === 'running'
  }

  /** The context's rate, or the usual default before one has been opened. */
  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000
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

  /** Current knob values laid out for the compiled patch. */
  private flatParams(): number[] {
    const flat = this.compiled.params.slice()
    for (const [key, value] of Object.entries(this.values)) {
      const index = this.compiled.paramIndex[key]
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
      // Hand over the patch and current knob positions at construction so the
      // node never renders a block with stale defaults.
      processorOptions: { patch: this.compiled, params: this.flatParams() },
    })
    node.port.onmessage = (e) => {
      if (e.data?.type !== 'frame') return
      if (e.data.levels) for (const fn of this.levelListeners) fn(e.data.levels)
      if (e.data.scopes) for (const fn of this.scopeListeners) fn(e.data.scopes)
    }
    node.connect(ctx.destination)

    this.ctx = ctx
    this.node = node
    if (ctx.state === 'suspended') await ctx.resume()
    // Catch the node up on anything held while it was booting. Whatever was
    // pressed and let go in that window is no longer in the set, so a key
    // tapped during the very first start correctly makes no sound rather than
    // sticking open.
    for (const id of this.open) node.port.postMessage({ type: 'gate', open: true, module: id })
  }

  /**
   * Recompile after a patch edit and rewire the running graph.
   *
   * `values` replaces the held knob positions outright. Loading a patch must
   * pass them: merging into what is already here would let a knob from the old
   * rack survive onto a module of the same name in the new one.
   */
  setPatch(patch: Patch, values?: Record<string, number>) {
    this.compiled = compile(patch)
    this.warn()
    // Seed newly added modules with their defaults.
    this.values = { ...initialValues(patch), ...pick(values ?? this.values, patch) }
    this.node?.port.postMessage({
      type: 'patch',
      patch: this.compiled,
      params: this.flatParams(),
    })
  }

  /**
   * Push knob values, sending only what actually changed.
   *
   * Everything goes through here rather than through a per-knob call so that
   * undo, redo and patch loads land the same way a knob drag does; a drag then
   * costs one scan of a few dozen numbers per frame, which is nothing.
   */
  setValues(values: Record<string, number>) {
    for (const [key, value] of Object.entries(values)) {
      if (this.values[key] === value) continue
      this.values[key] = value
      const index = this.compiled.paramIndex[key]
      if (index === undefined) continue
      this.node?.port.postMessage({ type: 'param', index, value })
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
   * Open or close one module's gate.
   *
   * Recorded before it is posted, and safe to call before the context has
   * opened: the audio thread is caught up in `boot`.
   */
  gate(open: boolean, moduleId: string) {
    if (open) this.open.add(moduleId)
    else this.open.delete(moduleId)
    this.node?.port.postMessage({ type: 'gate', open, module: moduleId })
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
