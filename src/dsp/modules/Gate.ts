import { DspModule, EdgeDetector } from './types'

const P_MODE = 0
const P_LENGTH = 1

/** Held: the gate is open for exactly as long as the key or button is. */
export const MODE_GATE = 0
/** One-shot: a fixed length, however briefly the key was touched. */
export const MODE_ONCE = 1
/**
 * Latch: tap on, tap again off. Handled entirely on the main thread, which
 * simply does not send the release -- so as far as this module is concerned a
 * latched gate is an ordinary held one, and there is no case for it here.
 *
 * It is named anyway, because the parameter has three positions and a reader
 * who finds only two of them accounted for will go looking for the third.
 */
export const MODE_LATCH = 2

/**
 * The player interface: a key or a button opens this, and everything
 * downstream sees an ordinary gate signal on a cable.
 *
 * Mode is what the gate does with the press. **Held** is the plain case. **One
 * shot** puts out a fixed length instead, which is the one that saves takes:
 * a percussive sound wants the same gate every time, and a finger that stayed
 * down 400 ms when it meant 80 is the usual way a render comes out wrong.
 * **Latch** stays open until the next press, for drones and for auditioning a
 * bed with both hands somewhere else.
 *
 * One shot is here, at audio rate, rather than on a timer upstairs. Two
 * reasons, and either would be enough: a browser timer is good to a few
 * milliseconds at best and is throttled outright in a background tab, and an
 * offline render drives the graph directly and never sees the main thread at
 * all -- so a timer would make a patch sound one way live and another way in
 * the take.
 *
 * Latch is the opposite case and lives upstairs for the matching reason. It
 * changes what the *key* does, not what the gate means, and a render has no
 * second press for it to answer.
 */
export class GateModule extends DspModule {
  readonly hasTrigger = true
  /** A key is bound to this; everything else in a rack hears it by cable. */
  readonly isPlayed = true

  private edge = new EdgeDetector()
  /** Samples the one-shot has left to stay open. */
  private left = 0

  process(slots: Float32Array) {
    const fired = this.edge.rose(this.gateOpen ? 1 : 0)

    if (Math.round(this.params[P_MODE]) !== MODE_ONCE) {
      // Dropped rather than left to run down, so switching away mid-shot stops
      // the sound now instead of at the end of a length nobody is waiting for.
      this.left = 0
      slots[this.outs[0]] = this.gateOpen ? 1 : 0
      return
    }

    // Unconditional, so a press during a shot restarts it rather than being
    // swallowed -- the same choice the Burst makes when a run is retriggered.
    if (fired) {
      this.left = Math.max(1, Math.round(this.params[P_LENGTH] * this.ctx.sampleRate))
    }

    // Read before the decrement, so Length samples come out high rather than
    // Length minus one.
    const open = this.left > 0
    if (this.left > 0) this.left--
    slots[this.outs[0]] = open ? 1 : 0
  }
}
