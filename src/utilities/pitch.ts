/**
 * The arithmetic behind the Notes & frequencies utility: a note's frequency,
 * a frequency's note, and what lies around them.
 *
 * Notes are named as everywhere else in the app (see `midiName`): sharps,
 * and octaves counted the scientific way, so MIDI 60 is C4 and A4 is 69. The
 * reference is a parameter rather than 440, because orchestras and old
 * recordings tune elsewhere and a converter is most wanted exactly then.
 */
import { midiName } from '../song/tuning'

export const A4_MIDI = 69
export const DEFAULT_A4 = 440
/** The references a person may set: a semitone either side of 440, which covers every tuning in use. */
export const A4_MIN = 415
export const A4_MAX = 466

/** A MIDI note number, fractional, to hertz at a reference. */
export function midiToHz(midi: number, a4 = DEFAULT_A4): number {
  return a4 * Math.pow(2, (midi - A4_MIDI) / 12)
}

/** Hertz to a MIDI note number, fractional. */
export function hzToMidi(hz: number, a4 = DEFAULT_A4): number {
  return A4_MIDI + 12 * Math.log2(hz / a4)
}

/** The nearest note to a fractional MIDI number, and how far from it, in cents. */
export function nearest(midi: number): { midi: number; name: string; cents: number } {
  const n = Math.round(midi)
  let cents = Math.round((midi - n) * 1000) / 10
  if (Object.is(cents, -0)) cents = 0
  return { midi: n, name: midiName(n), cents }
}

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/**
 * What a person typed, as a pitch: a note name (`A4`, `c#3`, `Bb2`, `F♯1`,
 * `Ebb4` for the double flat), a MIDI number (`60`, or `midi 60`), or a
 * frequency (`440 Hz`, `261.6hz`, `1.2 kHz`). A bare number is a MIDI note
 * when it is a whole one from 0 to 127 and a frequency otherwise -- so `60`
 * is middle C and `60.5` is a low B -- unless it says which.
 */
export function parsePitch(text: string, a4 = DEFAULT_A4): { midi: number; hz: number } | null {
  const t = text.trim().toLowerCase().replace(/♯/g, '#').replace(/♭/g, 'b')
  if (t === '') return null

  const note = /^([a-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(t)
  if (note) {
    const accidental = note[2] ? (note[2][0] === '#' ? 1 : -1) * note[2].length : 0
    const midi = (Number(note[3]) + 1) * 12 + LETTERS[note[1]] + accidental
    return valid(midi, a4)
  }

  const midiWord = /^midi\s*(-?\d+(?:\.\d+)?)$/.exec(t)
  if (midiWord) return valid(Number(midiWord[1]), a4)

  const freq = /^(\d+(?:\.\d+)?)\s*(k?hz)?$/.exec(t)
  if (freq) {
    const value = Number(freq[1])
    if (!freq[2] && Number.isInteger(value) && value <= 127) return valid(value, a4)
    const hz = freq[2] === 'khz' ? value * 1000 : value
    return hz > 0 ? valid(hzToMidi(hz, a4), a4) : null
  }
  return null
}

function valid(midi: number, a4: number) {
  if (!Number.isFinite(midi)) return null
  const hz = midiToHz(midi, a4)
  return hz > 0 && hz < 100_000 ? { midi, hz } : null
}

/** The first `count` harmonics of a pitch: each one's frequency and its nearest note. */
export function harmonics(hz: number, count: number, a4 = DEFAULT_A4) {
  return Array.from({ length: count }, (_, i) => {
    const f = hz * (i + 1)
    return { n: i + 1, hz: f, ...nearest(hzToMidi(f, a4)) }
  })
}

/**
 * How much faster or slower a pitch moves by `semitones`: the ratio to play
 * a sample at to transpose it, which is what a Sampler's Speed is.
 */
export function semitoneRatio(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

/** Hertz for showing and copying: as many decimals as are worth reading at its size. */
export function formatHz(hz: number): string {
  const places = hz < 10 ? 3 : hz < 1000 ? 2 : 1
  return String(Number(hz.toFixed(places)))
}
