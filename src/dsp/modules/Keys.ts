import { DspModule, Retrigger, type Playable } from './types'

const P_NOTE = 0
const P_OCTAVE = 1

/** The panel calls it Gate; see the note on the id in defs.ts. */
const IN_TRIG = 0

const OUT_PITCH = 0
const OUT_GATE = 1
/** Appended: the DSP reads its ports by position, so the others stay put. */
const OUT_VEL = 2

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
 *
 * This is also the module a sequencer plays. `noteOn` carries a pitch and a
 * velocity in together, which is the reason a note is not simply a parameter
 * write followed by a gate: the two would cross a block boundary apart, and
 * the gap is audible as a blip at whatever the last note was.
 */
export class KeysModule extends DspModule implements Playable {
  /**
   * The transport reaches it, so an offline render can play it. Its own keys
   * open the same gate, through the same path.
   */
  readonly hasTrigger = true
  /** Played by hand, like the Trigger, which is why a render holds it down. */
  readonly isPlayed = true
  /** And played by a roll, a MIDI keyboard, or a game, through here. */
  readonly playable: Playable = this

  /**
   * The note a sequencer last played, in semitones, or null while the panel
   * is the only thing that has set one.
   *
   * Held rather than written into the `note` parameter because the two are
   * different things: the parameter is the key you chose by hand, it is saved
   * with the patch, and a roll that overwrote it would silently rewrite the
   * patch every time the song played.
   */
  private notePitch: number | null = null
  /** Velocity of that note. Hands have none, so anything else plays at full. */
  private noteVel = 1
  /**
   * The `note` parameter as it read last sample, so a change to it can be
   * spotted. Seeded in `prepare` rather than here: starting it at NaN would
   * make the first sample look like a change, and a note scheduled at frame
   * zero fires before that sample runs.
   */
  private lastPanelNote = 0
  /** Makes a new note read as a new note; see the class for why. */
  private retrig = new Retrigger()
  /**
   * Set by the engine while this is one voice of several.
   *
   * A voice plays the note it was handed and nothing else. The two things a
   * single keyboard listens to on its own -- a key pressed on the panel, and
   * a gate arriving at its jack -- belong to the whole instrument once there
   * is more than one voice, so the engine hears them instead and decides
   * which voice they go to. Left to every voice, one click on the panel
   * would retune every note still ringing, and one press of Space would
   * reopen every tail at once.
   */
  voiced = false

  /**
   * Pitch and velocity land together, and the gate opens on the same sample.
   *
   * The gate is the module's ordinary one, so a note and a finger and a cable
   * are all opening the same thing -- which is what makes a rack that a roll
   * is playing still respond to its own keys.
   */
  noteOn(pitch: number, velocity: number) {
    this.retrig.notify()
    this.notePitch = pitch
    this.noteVel = velocity
    this.gateOpen = true
  }

  /**
   * The gate, and only the gate. `notePitch` deliberately survives: an
   * envelope is still releasing, and putting the pitch back to the panel's
   * note part way through a tail is a chirp at the end of every note.
   */
  noteOff() {
    this.gateOpen = false
  }

  prepare() {
    this.lastPanelNote = this.params[P_NOTE]
  }

  process(slots: Float32Array) {
    // A hand on the panel takes the keyboard back from whatever was playing
    // it. Pressing a key writes this parameter, so a change to it is the one
    // signal available that the note now being asked for is somebody's
    // finger rather than the roll that was running a moment ago -- and
    // without it, a key pressed to audition a patch would sound at whatever
    // velocity the last sequenced note happened to carry.
    const panelNote = this.params[P_NOTE]
    if (panelNote !== this.lastPanelNote) {
      this.lastPanelNote = panelNote
      if (!this.voiced) {
        this.notePitch = null
        this.noteVel = 1
      }
    }

    // Pitch is a standing value, not an event: it is whatever key was pressed
    // last and it stays there. That is what makes the Gate jack below worth
    // having -- the note outlives the press that set it.
    //
    // Octave applies to a sequenced note as well as to a pressed one, so the
    // switch stays what its label says it is: it moves the whole keyboard,
    // whoever is playing it. On a track in a song that makes it a transpose.
    const note = this.notePitch ?? panelNote
    slots[this.outs[OUT_PITCH]] = note / OCTAVE + this.params[P_OCTAVE]

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
    const open = this.retrig.gate(this.gateOpen || (!this.voiced && slots[this.ins[IN_TRIG]] > 0.5))
    slots[this.outs[OUT_GATE]] = open ? 1 : 0

    // Standing, exactly as the pitch is, and for the same reason: an envelope
    // is still releasing after the gate shuts, and a velocity that snapped
    // back to full at note-off would make every tail swell instead of fade.
    // It goes back to full when a finger takes the keyboard back, above.
    slots[this.outs[OUT_VEL]] = this.noteVel
  }
}
