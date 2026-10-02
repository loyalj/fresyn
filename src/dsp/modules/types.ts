import { streamFor } from '../Rng'
import type { SampleData } from '../samples'

export interface ModuleContext {
  sampleRate: number
}

/**
 * How many samples the engine works on at a time: the Web Audio render
 * quantum, so the live rack does one block per callback.
 */
export const BLOCK = 128

/** What a module's ports are before an engine has bound them. */
const UNBOUND: Float32Array[] = []

/**
 * A module that records what reaches it so the UI can draw it. The engine
 * collects these through this interface rather than by module type, so the
 * audio thread never has to know what a scope is.
 */
export interface Capturing {
  snapshot(): Float32Array
  /**
   * A second trace, for a module that taps two signals, or null when there
   * is nothing on it. Optional and separate rather than folded into the
   * frame above, so that everything which reads a capture -- the drawing, the
   * offline checks -- goes on seeing exactly the buffer it always saw, and
   * only what wants a second channel has to know there is one.
   */
  snapshotB?(): Float32Array | null
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

/**
 * A module a sequencer, a piano roll or a game plays notes on.
 *
 * Separate from `hasTrigger`, which is a gate and nothing more. A note
 * carries a pitch and a velocity with it, and those have to arrive at the
 * same instant the gate opens -- writing the pitch as a parameter and then
 * opening the gate is two messages with a block boundary between them, which
 * is audible as a blip at the old pitch.
 *
 * Collected by interface, like `Capturing` and `Metering`, so the engine
 * still never has to know what a keyboard is.
 */
export interface Playable {
  /**
   * Pitch is in semitones from the bottom of the module's own range, which is
   * what a piano roll counts in. Velocity is 0..1.
   */
  noteOn(pitch: number, velocity: number): void
  /**
   * Closes the gate and nothing else. The pitch stays where the note left it
   * on purpose: a release tail is still sounding, and snapping the pitch back
   * part way through one is a chirp at the end of every note.
   *
   * The pitch says which note is letting go. A single line ignores it -- there
   * is only one note to release -- but a chord needs it to know which of its
   * voices to close.
   */
  noteOff(pitch?: number): void
  /**
   * Present on a module that can be one voice of several, and set by the
   * engine while it is. A voice plays only the notes it is handed.
   */
  voiced?: boolean
}

/**
 * One node in the patch graph.
 *
 * Modules communicate only through their ports, and a port is a block of
 * samples: `inputs[k]` and `outputs[k]` are views the engine binds onto its
 * own buffers, one per jack, and `processBlock(from, to)` works through the
 * samples from `from` up to `to` of every one of them in a single call. A
 * cable is two modules bound to the same block, so nothing is ever copied
 * along one.
 *
 * Every output must be written on every sample of the range: whatever is
 * downstream reads that sample of the block, and a sample skipped is last
 * block's value, not the last one written.
 *
 * `processBlock` runs at audio rate: no allocation, no closures, no
 * exceptions. Parameters, gates and the sample are fixed for the length of a
 * call -- the engine stops at anything that changes them -- so reading them
 * once at the top is the same as reading them on every sample.
 */
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
   * Set by a module that only ever works on what reaches its jacks -- a
   * filter, a reverb, a mixer -- and that nothing but its jacks can wake: no
   * gate, no note, no clock of its own that anything downstream is waiting
   * on. Fed silence for long enough and gone quiet itself, such a module is
   * working out silence, and the engine lets it rest: skipped, putting out
   * silence, until something arrives at a jack again. See `GraphEngine`.
   *
   * Not for anything whose state has to keep moving while it is quiet, like
   * a compressor still letting go of the last peak.
   */
  readonly rests: boolean = false
  /**
   * The longest it can go on to say something after a stretch of silence,
   * in seconds: a delay's line, a granulator's buffer. Silent between two
   * echoes is not empty, so a module that holds sound for later rests only
   * once it has been quiet for longer than it can hold anything.
   */
  readonly memory: number = 0
  /** The engine's: this module is resting. */
  resting = false
  /** The engine's: how many samples it has been fed nothing and said nothing. */
  quietRun = 0

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
  /**
   * Set by modules a note can be played on. Collected the same way again,
   * and the single entry point every note source in the project shares -- the
   * piano roll, a MIDI keyboard, and a game asking for a sound at a pitch.
   */
  readonly playable: Playable | null = null
  /** Slot index per input port, in the def's port order. 0 is ground. */
  ins: Int32Array = new Int32Array(0)
  /** Slot index per output port. */
  outs: Int32Array = new Int32Array(0)
  /** View onto this module's span of the flat parameter array. */
  params: Float32Array = new Float32Array(0)
  /** This block of each input port, in the def's port order. Bound by the engine. */
  inputs: Float32Array[] = UNBOUND
  /** This block of each output port. */
  outputs: Float32Array[] = UNBOUND
  /**
   * The audio this module plays, or null when it has none or its file is
   * missing. Resolved by the engine when the rack is built and again whenever
   * a sample arrives, so the audio thread holds a pointer rather than looking
   * anything up per sample.
   */
  sample: SampleData | null = null
  /** Which sample it is asking for, copied from the patch. */
  sampleId = ''

  constructor(protected readonly ctx: ModuleContext) {}

  /** Called once after wiring is bound, before the first sample. */
  prepare(): void {}

  /** Samples `from` up to (not including) `to` of this block. */
  abstract processBlock(from: number, to: number): void

  /**
   * One sample, through a slot array of the caller's -- for a module run on
   * its own, outside any engine, the way the checks drive one. `ins` and
   * `outs` index `slots` exactly as they index an engine's.
   */
  process(slots: Float32Array) {
    let io = this.single
    if (!io || io.inputs.length !== this.ins.length || io.outputs.length !== this.outs.length) {
      io = {
        inputs: Array.from(this.ins, () => new Float32Array(1)),
        outputs: Array.from(this.outs, () => new Float32Array(1)),
      }
      this.single = io
    }
    this.inputs = io.inputs
    this.outputs = io.outputs
    for (let k = 0; k < this.ins.length; k++) io.inputs[k][0] = slots[this.ins[k]]
    this.processBlock(0, 1)
    for (let k = 0; k < this.outs.length; k++) slots[this.outs[k]] = io.outputs[k][0]
  }
  private single: { inputs: Float32Array[]; outputs: Float32Array[] } | null = null
}

/**
 * Forces a gap when a note arrives on a gate that is still open.
 *
 * Two notes back to back are the ordinary case in a sequenced line: the first
 * one's release and the second one's press fall on the same sample, and
 * applying both leaves the gate exactly where it started. Nothing downstream
 * ever sees it fall, so a run of repeated eighth notes comes out as one held
 * drone -- and the same goes for a note that overlaps the one before it,
 * which a single mono rack has no other way to answer.
 *
 * One sample, and only one: 20 microseconds at 48k, far below anything
 * audible, and exactly enough for every edge detector downstream.
 */
export class Retrigger {
  private wasOpen = false
  private pending = false

  /** A new note has arrived. Call before the sample it lands on. */
  notify() {
    if (this.wasOpen) this.pending = true
  }

  /** The gate as it should actually be put out. Call once per sample. */
  gate(open: boolean): boolean {
    if (this.pending) {
      open = false
      this.pending = false
    }
    this.wasOpen = open
    return open
  }
}

/** Rising-edge detector for gate and sync inputs. */
export class EdgeDetector {
  private was = false
  private previous = 0
  private fraction = 1

  /** True on the sample the signal crosses the gate threshold upward. */
  rose(value: number): boolean {
    const now = value > 0.5
    const rising = now && !this.was
    if (rising) {
      // Where between the two samples the threshold was actually passed.
      // `previous` is at or below the threshold whenever this branch runs --
      // it is what made `was` false -- so the span is never zero or negative.
      const span = value - this.previous
      this.fraction = span > 0 ? (0.5 - this.previous) / span : 1
    }
    this.was = now
    this.previous = value
    return rising
  }

  /**
   * Where inside the last sample interval the crossing sat: 0 at the previous
   * sample, 1 at this one. Only meaningful on a sample `rose` returned true.
   *
   * A gate arrives as a step, and interpolating across a step puts the
   * crossing where a ramp would have reached it -- which is arbitrary, but
   * arbitrary in the same place every cycle, so a periodic source keeps a
   * steady period. A source with a real slope through the threshold, which is
   * what an oscillator syncing another one is, gets the true instant.
   */
  get crossing() {
    return this.fraction
  }

  get isHigh() {
    return this.was
  }
}
