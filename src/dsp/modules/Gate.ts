import { DspModule, EdgeDetector, Retrigger, type Playable } from './types'

const P_MODE = 0
const P_LENGTH = 1

const IN_TRIG = 0

const OUT_GATE = 0
/** Appended: the DSP reads its ports by position. */
const OUT_VEL = 1

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
export class GateModule extends DspModule implements Playable {
  readonly hasTrigger = true
  /** A key is bound to this; everything else in a rack hears it by cable. */
  readonly isPlayed = true
  /**
   * A roll plays this module too, on a patch that has no Keyboard in it -- a
   * coin, a laser, a footstep. The pitch means nothing and is discarded; what
   * a drum lane has to get right is the rhythm, and that is exactly what goes
   * wrong without a `Playable` here: two hits on the same sixteenth boundary
   * would close and reopen the gate between samples, `once` would never see a
   * rising edge, and the second hit would be silent.
   */
  readonly playable: Playable = this

  private edge = new EdgeDetector()
  private retrig = new Retrigger()
  /** Samples the one-shot has left to stay open. */
  private left = 0
  /**
   * How hard the last press was, standing between presses as the Keyboard's
   * does, so a tail fades at the level it was struck at.
   */
  private vel = 1
  /**
   * A note from the roll is on its way to the next rising edge. Anything else
   * that raises the gate -- the key, the button, a cable -- is a press with no
   * velocity, and plays at full.
   */
  private fromNote = false
  private wasPressed = false

  /**
   * The pitch is discarded: this module has none, and a drum lane needs none.
   * The velocity is kept, so a drum can be played softly.
   */
  noteOn(_pitch: number, velocity: number) {
    this.retrig.notify()
    this.gateOpen = true
    this.vel = velocity
    this.fromNote = true
  }

  noteOff() {
    this.gateOpen = false
  }

  process(slots: Float32Array) {
    // Either the key or a cable into Trig will press it, whichever arrives
    // first, and the last to leave lets go -- the same rule the Keyboard and
    // the oscillator use for their gate jacks.
    //
    // A cable is what makes Mode worth having twice over: a clock into here
    // with Mode on `once` is a fixed length at the clock's rate, which the
    // Clock cannot do on its own. Its Width is a fraction of the period, so
    // the pulses get longer as the rate falls.
    // The gap goes in before the edge detector rather than on the way out, so
    // that it reaches both modes: `held` puts this straight out, and `once`
    // needs the fall so the rise after it can start a fresh shot.
    const pressed = this.retrig.gate(this.gateOpen || slots[this.ins[IN_TRIG]] > 0.5)
    const fired = this.edge.rose(pressed ? 1 : 0)

    if (pressed && !this.wasPressed) {
      if (!this.fromNote) this.vel = 1
      this.fromNote = false
    }
    this.wasPressed = pressed
    slots[this.outs[OUT_VEL]] = this.vel

    if (Math.round(this.params[P_MODE]) !== MODE_ONCE) {
      // Dropped rather than left to run down, so switching away mid-shot stops
      // the sound now instead of at the end of a length nobody is waiting for.
      this.left = 0
      slots[this.outs[OUT_GATE]] = pressed ? 1 : 0
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
    slots[this.outs[OUT_GATE]] = open ? 1 : 0
  }
}
