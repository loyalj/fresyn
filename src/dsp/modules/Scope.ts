import { DspModule, type Capturing } from './types'

/**
 * Samples kept per scope: about 85 ms at 48 kHz, and a power of two so the
 * UI can run an FFT over the frame without resampling it first.
 */
export const SCOPE_CAPTURE = 4096
const MASK = SCOPE_CAPTURE - 1

const IN_A = 0
const IN_B = 1
/** Slot zero is the rack's ground, which is what an unpatched input reads. */
const GROUND = 0

/**
 * An oscilloscope tap. It writes every sample that reaches it into a ring
 * buffer and produces no output of its own, so patching one in never changes
 * what the rack sounds like -- outputs fan out, so you tap a signal rather
 * than inserting into it.
 *
 * Its three knobs are read by the display, not by this class. They live in
 * the module definition like any other parameter so the UI builds them the
 * same way, and so a saved patch remembers where the scope was set.
 */
export class ScopeModule extends DspModule implements Capturing {
  /** This module is its own capture source; see `DspModule.capture`. */
  readonly capture: Capturing = this

  private ring = new Float32Array(SCOPE_CAPTURE)
  private frame = new Float32Array(SCOPE_CAPTURE)
  private ringB = new Float32Array(SCOPE_CAPTURE)
  private frameB = new Float32Array(SCOPE_CAPTURE)
  private write = 0

  process(slots: Float32Array) {
    this.ring[this.write] = slots[this.ins[IN_A]]
    this.ringB[this.write] = slots[this.ins[IN_B]]
    this.write = (this.write + 1) & MASK
  }

  /**
   * The last `SCOPE_CAPTURE` samples, oldest first, in a buffer this module
   * owns. Handing back a fresh array each time would put an allocation and
   * eventually a garbage collection on the audio thread; the caller copies it
   * by posting it, so reusing one buffer is safe.
   */
  snapshot(): Float32Array {
    return unroll(this.ring, this.frame, this.write)
  }

  /**
   * The same for B, or null when nothing is patched to it -- which is what
   * keeps an unused channel from being drawn as a flat line and from being
   * posted to the main thread sixteen kilobytes at a time, thirty times a
   * second, for a jack nobody plugged into.
   */
  snapshotB(): Float32Array | null {
    if (this.ins[IN_B] === GROUND) return null
    return unroll(this.ringB, this.frameB, this.write)
  }
}

/** A ring into a frame, oldest first. */
function unroll(ring: Float32Array, frame: Float32Array, write: number) {
  frame.set(ring.subarray(write), 0)
  frame.set(ring.subarray(0, write), SCOPE_CAPTURE - write)
  return frame
}
