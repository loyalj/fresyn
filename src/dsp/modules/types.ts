import { streamFor } from '../Rng'

export interface ModuleContext {
  sampleRate: number
}

/**
 * One node in the patch graph. Modules are stepped a single sample at a time
 * and communicate only through the shared slot array, which is what lets a
 * feedback cable cost exactly one sample.
 *
 * `process` runs at audio rate: no allocation, no closures, no exceptions.
 */
/**
 * A module that records what reaches it so the UI can draw it. The engine
 * collects these through this interface rather than by module type, so the
 * audio thread never has to know what a scope is.
 */
export interface Capturing {
  snapshot(): Float32Array
}

/**
 * A module that publishes signal levels for its own panel. Separate from
 * `Capturing` because the two carry different things -- a waveform to draw
 * against time, and a handful of peaks since the last report -- and because
 * a module may reasonably do one without the other.
 */
export interface Metering {
  /** Peaks since the last call, in a buffer this module owns, then reset. */
  levels(): Float32Array
}

export abstract class DspModule {
  /** Module type, so a rewire can tell whether an instance is still reusable. */
  type = ''
  /**
   * This module's own random stream, seeded from the patch seed and its id.
   * Never `Math.random`: renders have to be reproducible.
   */
  random: () => number = () => 0

  /**
   * Point this module at a fresh random stream. The engine calls it when the
   * module is built and again whenever the patch seed changes.
   *
   * A module that needs several independent streams derives them here rather
   * than in `prepare`, which runs once and does not run again on a reseed.
   */
  seedFrom(seed: number, id: string) {
    this.random = streamFor(seed, id)
  }

  /**
   * Set by modules with a trigger of their own. The transport opens and closes
   * `gateOpen` on these -- one of them for a key or a panel button, all of
   * them for an offline render -- without needing to know what kind of module
   * it is. What a module makes of the gate is its own business: the Trigger
   * reshapes it by Mode, the Burst reads only the rising edge.
   */
  readonly hasTrigger: boolean = false
  /**
   * Set by the modules a performer plays directly: the Trigger, which a key
   * is bound to, and the Keyboard, whose own keys are its trigger.
   *
   * `hasTrigger` says a module has a button on its panel. This says a pair of
   * hands reaches it, and everything else in a patch hears those hands down a
   * cable. The difference is what an offline render holds open, and it
   * matters: an oscillator reads its gate as its own OR the jack's, so a
   * transport holding it could never let a clock retrigger it -- a patch that
   * blips twelve times a second would render one blip and a decay.
   *
   * Declared here rather than read from the catalogue so the audio thread
   * still never has to know what kind of module anything is.
   */
  readonly isPlayed: boolean = false
  gateOpen = false

  /**
   * Set by modules that publish their input for display. Left null by every
   * other module, which is how the engine picks the scopes out of a patch.
   */
  readonly capture: Capturing | null = null
  /**
   * Set by modules that publish levels for their panel. Collected the same
   * way as `capture`, so the engine still never names a module type.
   */
  readonly meter: Metering | null = null
  /** Slot index per input port, in the def's port order. 0 is ground. */
  ins: Int32Array = new Int32Array(0)
  /** Slot index per output port. */
  outs: Int32Array = new Int32Array(0)
  /** View onto this module's span of the flat parameter array. */
  params: Float32Array = new Float32Array(0)

  constructor(protected readonly ctx: ModuleContext) {}

  /** Called once after wiring is bound, before the first sample. */
  prepare(): void {}

  abstract process(slots: Float32Array): void
}

/** Rising-edge detector for gate and sync inputs. */
export class EdgeDetector {
  private was = false

  /** True on the sample the signal crosses the gate threshold upward. */
  rose(value: number): boolean {
    const now = value > 0.5
    const rising = now && !this.was
    this.was = now
    return rising
  }

  get isHigh() {
    return this.was
  }
}
