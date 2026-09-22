import { DspModule } from './types'

const P_NOTE = 0
const P_OCTAVE = 1

/** The panel calls it Gate; see the note on the id in defs.ts. */
const IN_TRIG = 0

const OUT_PITCH = 0
const OUT_GATE = 1

/** Semitones per octave, which is what turns a key number into a pitch. */
const OCTAVE = 12

/**
 * A 25-key keyboard: a pitch to patch and a gate to fire.
 *
 * Pitch is in octaves rather than hertz, because that is the unit every
 * destination in this rack already takes -- an oscillator's FM input and a
 * filter's CV input are both scaled in octaves. So the bottom key puts out
 * zero and leaves the oscillator on its Pitch knob, and every key above it
 * adds a twelfth of an octave. Patch Pitch to an oscillator's FM with FM Amt
 * at +1.00 and the keyboard plays in tune.
 *
 * Nothing is smoothed. A keyboard steps between notes, and the rack already
 * has a Slew for anyone who wants portamento -- putting a glide in here would
 * be a decision taken away from the patch.
 */
export class KeysModule extends DspModule {
  /**
   * The transport reaches it, so an offline render can play it. Its own keys
   * open the same gate, through the same path.
   */
  readonly hasTrigger = true
  /** Played by hand, like the Trigger, which is why a render holds it down. */
  readonly isPlayed = true

  process(slots: Float32Array) {
    // Pitch is a standing value, not an event: it is whatever key was pressed
    // last and it stays there. That is what makes the Gate jack below worth
    // having -- the note outlives the press that set it.
    slots[this.outs[OUT_PITCH]] = this.params[P_NOTE] / OCTAVE + this.params[P_OCTAVE]

    // Either the keys or a cable into the Gate jack will open it, whichever
    // arrives first, and the last to leave closes it.
    //
    // The cable is the interesting one. A Trigger patched in here plays the
    // key you pressed last, which makes this module the pitch setting for
    // whatever fires it: click a key to choose the note, then play it from the
    // keyboard, a Burst, a Sequencer's gate, or anything else that puts out a
    // gate. The note is a parameter rather than part of the gate, so choosing
    // it and firing it stay separate -- which is also why a render batch of
    // eight takes is eight versions of one note rather than eight notes.
    const open = this.gateOpen || slots[this.ins[IN_TRIG]] > 0.5
    slots[this.outs[OUT_GATE]] = open ? 1 : 0
  }
}
