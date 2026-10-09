import { SCALES } from '../../song/scale'
import { DspModule, EdgeDetector } from './types'

const P_QUALITY = 0
const P_ROOT = 1
const P_SCALE = 2
const P_INVERSION = 3
const P_VOICING = 4
const P_STRUM = 5
const P_DIRECTION = 6

const IN_PITCH = 0
const IN_GATE = 1

/** P1 to P4 are outputs 0 to 3, G1 to G4 are 4 to 7. */
const NOTES = 4
const OUT_GATE = NOTES

/**
 * The fixed chords, four notes each, as semitones over the root, in the
 * order the Quality switch lists them. A triad doubles its root an octave up
 * so every output always has a note to play.
 */
export const CHORD_SHAPES = [
  [0, 4, 7, 12],
  [0, 3, 7, 12],
  [0, 4, 7, 10],
  [0, 4, 7, 11],
  [0, 3, 7, 10],
  [0, 2, 7, 12],
  [0, 5, 7, 12],
  [0, 3, 6, 9],
  [0, 4, 8, 12],
  [0, 7, 12, 19],
]
/** The two Quality settings past the fixed chords, which build one from the key instead. */
const IN_KEY = CHORD_SHAPES.length
const IN_KEY_7 = IN_KEY + 1

/** The longest Strum, in seconds: what the gate's history has to hold, three gaps deep. */
export const MAX_STRUM_S = 0.25

/**
 * Chord: one note in, four out.
 *
 * A pitch arrives at Pitch, one octave per unit as a Keyboard puts it out,
 * and P1 to P4 put out the four notes of a chord built on it, lowest first.
 * Quality chooses the chord -- major, minor, sevenths, suspended, diminished,
 * augmented, a power chord -- or builds one from the key: **in key** stacks
 * thirds of the scale on whichever of its notes the pitch is nearest, so
 * every chord belongs to Root and Scale, and **key 7** adds the seventh.
 *
 * Inversion moves the lowest notes up an octave; Voicing spreads the chord
 * out. Patch four oscillators to P1 to P4 and a whole chord plays from one
 * key.
 *
 * Gate, when something is patched to it, is passed on to G1 to G4 one after
 * another, Strum apart -- upward or downward -- so four envelopes strike
 * like a hand across strings. Each note's pitch is held from when its gate
 * opens, so a note is never moved under its own release.
 */
export class ChordModule extends DspModule {
  private edge = new EdgeDetector()
  private outEdges = Array.from({ length: NOTES }, () => new EdgeDetector())
  /** The gate's recent past, a sample a byte, so each output can read it late. */
  private history = new Uint8Array(Math.ceil(MAX_STRUM_S * (NOTES - 1) * this.ctx.sampleRate) + 2)
  private at = 0
  private chord = new Float64Array(NOTES)
  /** The chord as it was when the gate last opened, for the outputs still to open. */
  private pending = new Float64Array(NOTES)
  /** What each output is holding. */
  private holding = new Float64Array(NOTES)
  private work = new Float64Array(NOTES)
  /** The pitch and the settings the chord was last worked out for. */
  private chordFor = NaN
  private settingsFor = NaN
  /** Whether each output has opened yet: until it has, it plays the chord as it stands. */
  private struck = new Uint8Array(NOTES)

  processBlock(from: number, to: number) {
    const pitchIn = this.inputs[IN_PITCH]
    const gateIn = this.inputs[IN_GATE]
    const outs = this.outputs
    const quality = Math.round(this.params[P_QUALITY])
    const root = Math.round(this.params[P_ROOT])
    const scale = SCALES[Math.round(this.params[P_SCALE])]?.steps ?? SCALES[0].steps
    const inversion = Math.round(this.params[P_INVERSION])
    const voicing = Math.round(this.params[P_VOICING])
    const strum = Math.round(this.params[P_STRUM] * this.ctx.sampleRate)
    const down = Math.round(this.params[P_DIRECTION]) === 1
    // A Gate jack with nothing in it reads the ground slot, and then the
    // pitches simply follow what comes in.
    const gated = this.ins[IN_GATE] !== 0
    // Every switch in one number, so a change to any of them is noticed
    // without building a string on the audio thread.
    const settings = quality + 16 * (root + 16 * (Math.round(this.params[P_SCALE]) + 16 * (inversion + 16 * voicing)))
    if (settings !== this.settingsFor) {
      this.settingsFor = settings
      this.chordFor = NaN
    }
    const size = this.history.length
    const chord = this.chord

    for (let i = from; i < to; i++) {
      let pitch = pitchIn[i]
      if (pitch - pitch !== 0) pitch = 0
      if (pitch !== this.chordFor) {
        this.chordFor = pitch
        this.build(pitch, quality, root, scale, inversion, voicing)
      }
      if (!gated) {
        for (let k = 0; k < NOTES; k++) {
          outs[k][i] = chord[k]
          outs[OUT_GATE + k][i] = 0
        }
        continue
      }

      const open = gateIn[i] > 0.5
      if (this.edge.rose(gateIn[i])) for (let k = 0; k < NOTES; k++) this.pending[k] = chord[k]
      this.history[this.at] = open ? 1 : 0
      for (let k = 0; k < NOTES; k++) {
        const place = down ? NOTES - 1 - k : k
        let back = this.at - place * strum
        if (back < 0) back += size
        const g = this.history[back]
        if (this.outEdges[k].rose(g)) {
          this.holding[k] = this.pending[k]
          this.struck[k] = 1
        }
        outs[k][i] = this.struck[k] ? this.holding[k] : chord[k]
        outs[OUT_GATE + k][i] = g
      }
      this.at = this.at + 1 < size ? this.at + 1 : 0
    }
  }

  /** The four notes, lowest first, in octaves, for a pitch in octaves. */
  private build(pitch: number, quality: number, root: number, scale: number[], inversion: number, voicing: number) {
    const notes = this.work
    const semis = pitch * 12
    let base = semis
    if (quality === IN_KEY || quality === IN_KEY_7) {
      // The scale note nearest the pitch, and thirds of the scale stacked on
      // it: every other note, wrapping into the octaves above.
      const n = scale.length
      const rel = semis - root
      let bestDegree = 0
      let bestOctave = 0
      let bestDistance = Infinity
      const octave = Math.floor(rel / 12)
      for (let o = octave - 1; o <= octave + 1; o++) {
        for (let d = 0; d < n; d++) {
          const distance = Math.abs(o * 12 + scale[d] - rel)
          if (distance < bestDistance) {
            bestDistance = distance
            bestDegree = d
            bestOctave = o
          }
        }
      }
      base = root + bestOctave * 12
      for (let k = 0; k < NOTES; k++) {
        const step = k < 3 || quality === IN_KEY_7 ? bestDegree + 2 * k : bestDegree + n
        notes[k] = scale[step % n] + 12 * Math.floor(step / n)
      }
    } else {
      const shape = CHORD_SHAPES[quality] ?? CHORD_SHAPES[0]
      for (let k = 0; k < NOTES; k++) notes[k] = shape[k]
    }

    // Inversion: the lowest notes up an octave, one at a time.
    for (let r = 0; r < inversion; r++) {
      sortUp(notes)
      notes[0] += 12
    }
    sortUp(notes)
    // Drop 2 takes the second from the top down an octave; open lifts the
    // second from the bottom one up. Both leave the chord's notes alone.
    if (voicing === 1) notes[NOTES - 2] -= 12
    else if (voicing === 2) notes[1] += 12
    sortUp(notes)
    for (let k = 0; k < NOTES; k++) this.chord[k] = (base + notes[k]) / 12
  }
}

/** Four numbers in place, smallest first, without allocating. */
function sortUp(a: Float64Array) {
  for (let i = 1; i < a.length; i++) {
    const v = a[i]
    let j = i - 1
    while (j >= 0 && a[j] > v) {
      a[j + 1] = a[j]
      j--
    }
    a[j + 1] = v
  }
}
