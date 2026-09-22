import type { CompiledPatch } from '../patch/compile'
import { MODULE_FACTORIES, type DspModule } from './modules'
import type { Capturing, Metering } from './modules/types'
import { DEFAULT_SEED } from './Rng'

/**
 * Executes a compiled patch on the audio thread.
 *
 * The whole graph advances one sample at a time rather than one block at a
 * time. That costs some per-sample call overhead, and buys the two things a
 * modular rack cannot do without: audio-rate modulation of any input, and
 * feedback cables that cost a single sample instead of a whole block.
 */
export class GraphEngine {
  private slots: Float32Array
  private paramValues: Float32Array
  private modules: DspModule[] = []
  /** Modules with a trigger of their own, in patch order. */
  private triggerable: DspModule[] = []
  /** The subset of those a performer plays, which is what a render holds. */
  private played: DspModule[] = []
  /**
   * Modules that record their input for the UI, with the id to report them
   * under. Collected by interface so the engine never names a module type.
   */
  captures: { id: string; mod: Capturing }[] = []
  /** Modules that publish levels for their own panel, with their ids. */
  meters: { id: string; mod: Metering }[] = []
  private byId = new Map<string, DspModule>()
  /** Bus slots summed into the speaker pair, split for a tight inner loop. */
  private monL = new Int32Array(0)
  private monR = new Int32Array(0)
  private monSlotL = 0
  private monSlotR = 0
  private renderSlotL = 0
  private renderSlotR = 0
  /**
   * Which pair leaves the graph. The speakers hear the main mixes; an offline
   * render hears the recorder's input instead, which is how a render can be
   * a single channel while the room still hears the whole rack.
   */
  private tap: 'speakers' | 'recorder' = 'speakers'
  private outL = 0
  private outR = 0
  private seed: number
  private readonly ctx: { sampleRate: number }

  /**
   * `initialParams` must be applied before the modules are prepared, not
   * after. A module reads its parameters once at prepare() to seed its
   * smoothers, so setting them afterwards makes every knob glide from the
   * patch default to its loaded value -- an audible swoop on every patch load.
   */
  constructor(
    compiled: CompiledPatch,
    sampleRate: number,
    initialParams?: ArrayLike<number>,
    seed: number = DEFAULT_SEED,
  ) {
    this.seed = seed
    this.ctx = { sampleRate }
    this.slots = new Float32Array(compiled.slotCount)
    this.paramValues = new Float32Array(compiled.params)
    this.apply(compiled, initialParams)
  }

  /**
   * Swap in a recompiled patch, keeping the DSP state of every module that
   * survived. Rebuilding from scratch on each edit would reset filter states,
   * restart LFOs and cut off envelopes, so patching a cable while a sound is
   * playing would click and drop out -- the rack has to keep running through
   * an edit the way hardware does.
   */
  rebuild(compiled: CompiledPatch, params?: ArrayLike<number>) {
    this.apply(compiled, params)
  }

  private apply(compiled: CompiledPatch, params?: ArrayLike<number>) {
    const surviving = this.byId

    if (this.slots.length !== compiled.slotCount) {
      this.slots = new Float32Array(compiled.slotCount)
    }

    this.paramValues = new Float32Array(compiled.params)
    if (params) {
      const n = Math.min(params.length, this.paramValues.length)
      for (let i = 0; i < n; i++) this.paramValues[i] = params[i]
    }

    this.monL = Int32Array.from(compiled.monitors, (m) => m.l)
    this.monR = Int32Array.from(compiled.monitors, (m) => m.r)
    this.monSlotL = compiled.monitorSlotL
    this.monSlotR = compiled.monitorSlotR
    this.renderSlotL = compiled.renderSlotL
    this.renderSlotR = compiled.renderSlotR
    this.setTap(this.tap)
    this.modules = []
    this.triggerable = []
    this.played = []
    this.captures = []
    this.meters = []
    const next = new Map<string, DspModule>()

    for (const m of compiled.modules) {
      const factory = MODULE_FACTORIES[m.type]
      if (!factory) continue // the compiler already warned; stay silent at audio rate

      // Reuse the running instance when the slot still holds the same kind of
      // module, so its internal state carries across the edit.
      const existing = surviving.get(m.id)
      const reused = existing && existing.type === m.type
      const mod = reused ? existing : factory(this.ctx)
      mod.type = m.type

      mod.ins = Int32Array.from(m.ins)
      mod.outs = Int32Array.from(m.outs)
      // A view, not a copy: parameter writes land here without any per-sample
      // message traffic.
      mod.params = this.paramValues.subarray(m.paramBase, m.paramBase + m.paramCount)
      // Only a fresh module is prepared; preparing a reused one would reseed
      // its smoothers and undo the point of keeping it. The same goes for its
      // random stream: restarting it on every cable drag would make the noise
      // audibly jump.
      if (!reused) {
        mod.seedFrom(this.seed, m.id)
        mod.prepare()
      }

      this.modules.push(mod)
      next.set(m.id, mod)
      if (mod.hasTrigger) this.triggerable.push(mod)
      if (mod.isPlayed) this.played.push(mod)
      if (mod.capture) this.captures.push({ id: m.id, mod: mod.capture })
      if (mod.meter) this.meters.push({ id: m.id, mod: mod.meter })
    }

    // Nothing to carry: a module that survived the edit is the same object and
    // still holds its own gate, and a module that has just arrived starts
    // closed. That is the whole of it now that each Trigger is played on its
    // own key -- a new unit inheriting somebody else's held gate is exactly
    // what should not happen.

    this.byId = next
  }

  /**
   * Listen at the speakers or at the recorder. Survives a rebuild, so an
   * offline render set to `recorder` stays there across a re-patch.
   */
  setTap(which: 'speakers' | 'recorder') {
    this.tap = which
    this.outL = which === 'recorder' ? this.renderSlotL : this.monSlotL
    this.outR = which === 'recorder' ? this.renderSlotR : this.monSlotR
  }

  /**
   * Restart every module's random stream from a new seed. Used per variation
   * in a render batch; a live rack leaves its streams running.
   */
  setSeed(seed: number) {
    this.seed = seed
    for (const [id, mod] of this.byId) mod.seedFrom(seed, id)
  }

  setParam(index: number, value: number) {
    if (index >= 0 && index < this.paramValues.length) this.paramValues[index] = value
  }

  /**
   * Every module with a trigger at once, whether or not a key could reach it.
   *
   * Not what a render wants -- see `setPlayed` -- because holding an
   * oscillator's own gate open stops anything else being able to fire it. It
   * is here for rigs that drive a single module directly and need its trigger
   * held without patching one in.
   */
  setGate(open: boolean) {
    for (const mod of this.triggerable) mod.gateOpen = open
  }

  /**
   * Hold down everything a pair of hands would, which is what a render is.
   *
   * Only the Trigger and the Keyboard. Everything else in a patch is fired
   * down a cable from one of them, and pinning those open instead would make
   * a rendered take sound nothing like the rack does: an oscillator reads its
   * own gate as open OR the jack, so a transport that held it could never let
   * a clock retrigger it.
   */
  setPlayed(open: boolean) {
    for (const mod of this.played) mod.gateOpen = open
  }

  /** One module, by its key or its panel button. */
  setModuleGate(id: string, open: boolean) {
    const mod = this.byId.get(id)
    if (mod?.hasTrigger) mod.gateOpen = open
  }

  render(left: Float32Array, right: Float32Array) {
    const slots = this.slots
    const modules = this.modules
    const count = modules.length
    const monL = this.monL
    const monR = this.monR
    const buses = monL.length

    for (let i = 0; i < left.length; i++) {
      // Slots deliberately keep their values between samples: that residue is
      // exactly the one-sample delay a feedback cable reads.
      for (let m = 0; m < count; m++) modules[m].process(slots)

      // Every main mix lands in the speaker pair. Summed here rather than by
      // a module, because which buses are main mixes is a property of the
      // wiring and not of anything in the rack.
      let l = 0
      let r = 0
      for (let b = 0; b < buses; b++) {
        l += slots[monL[b]]
        r += slots[monR[b]]
      }
      slots[this.monSlotL] = l
      slots[this.monSlotR] = r

      left[i] = slots[this.outL]
      right[i] = slots[this.outR]
    }
  }
}
