export interface ParamSpec {
  id: string
  label: string
  min: number
  max: number
  default: number
  unit: string
  /** 'exp' for anything the ear hears logarithmically: pitch, time, cutoff. */
  curve: 'lin' | 'exp'
  /**
   * Discrete parameter. The value is an index into this list, and the UI
   * renders a switch instead of a knob.
   */
  steps?: string[]
  /**
   * Set by playing the module's own panel rather than by turning a knob.
   *
   * Two consequences, and they are the same idea twice: the panel draws no
   * generic control for it, and a render batch leaves it alone. A batch
   * varies the patch, and which key you are holding is not part of the
   * patch -- eight takes of a note that wandered two semitones apiece would
   * be eight different notes rather than eight versions of one.
   */
  played?: true
  /**
   * A frequency that is heard as a note.
   *
   * The readout names it and says how far off it is, the knob can be snapped
   * to semitones with Alt, and the value can be typed as a note. What earns
   * that is being tuned against something else: two oscillators a fifth apart
   * cannot be set by eye on a knob covering twelve octaves, and "220 Hz" does
   * not tell you that it is an octave under the one next to it whereas "A3"
   * under an "A4" does.
   *
   * Not every frequency is one. A filter cutoff, an LFO rate and a grain
   * density are all measured in hertz and none of them is a note anybody
   * tunes.
   */
  tuned?: true
}

/** Concert pitch, and the one number everything below is measured from. */
const A4_HZ = 440
/** MIDI 69 is A4, which is what makes the octave arithmetic whole numbers. */
const A4_MIDI = 69
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/**
 * C0, 16.35 Hz. Below this a frequency is a rate rather than a note: the
 * oscillator reaches 2 Hz, which is something to count, and naming it "C#-3"
 * would be a readout pretending to be useful.
 */
const LOWEST_NOTE_HZ = 16.35

/** Semitones from A4, fractional. */
export function semitonesFrom440(hz: number): number {
  return 12 * Math.log2(hz / A4_HZ)
}

/** And back: the frequency that many semitones from A4. */
export function hzFromSemitones(semitones: number): number {
  return A4_HZ * Math.pow(2, semitones / 12)
}

/** The nearest note and how far off it this is, or null below C0. */
export function noteOf(hz: number): { name: string; cents: number } | null {
  if (!(hz >= LOWEST_NOTE_HZ)) return null
  const semitones = semitonesFrom440(hz)
  const nearest = Math.round(semitones)
  const midi = nearest + A4_MIDI
  return {
    name: `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`,
    cents: Math.round((semitones - nearest) * 100),
  }
}

/**
 * The note as it reads beside a knob: "A2" when it is one, "A2 +13¢" when it
 * is on the way to the next. The cents are what make it a tuning aid rather
 * than a label -- without them every value between two notes reads as the
 * note it is nearest, and a knob two semitones wide looks perfectly in tune.
 */
export function formatNote(hz: number): string {
  const note = noteOf(hz)
  if (!note) return ''
  if (note.cents === 0) return note.name
  return `${note.name} ${note.cents > 0 ? '+' : '-'}${Math.abs(note.cents)}¢`
}

/** The nearest note, exactly, for a knob being snapped to one. */
export function snapToNote(spec: ParamSpec, hz: number): number {
  return clampValue(spec, hzFromSemitones(Math.round(semitonesFrom440(hz))))
}

/** A note as it may be typed: `A2`, `f#3`, `Bb1`. Null if that is not one. */
function hzOfName(text: string): number | null {
  const m = /^([a-g])([#b]?)(-?\d+)$/.exec(text)
  if (!m) return null
  const letter = NOTE_NAMES.indexOf(m[1].toUpperCase())
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const midi = (Number(m[3]) + 1) * 12 + letter + accidental
  return hzFromSemitones(midi - A4_MIDI)
}

/** Knob position (0..1) to parameter value. */
export function denormalize(spec: ParamSpec, t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  if (spec.steps) return Math.round(spec.min + (spec.max - spec.min) * c)
  if (spec.curve === 'exp') return spec.min * Math.pow(spec.max / spec.min, c)
  return spec.min + (spec.max - spec.min) * c
}

/**
 * Parameter value back to knob position (0..1).
 *
 * Guarded because a missing or out-of-range value must not reach the SVG: on
 * an exponential curve a value of zero is log(0), and the resulting -Infinity
 * turns every knob coordinate into NaN.
 */
export function normalize(spec: ParamSpec, value: number): number {
  const t =
    spec.curve === 'exp' && !spec.steps
      ? Math.log(value / spec.min) / Math.log(spec.max / spec.min)
      : (value - spec.min) / (spec.max - spec.min)
  if (!Number.isFinite(t)) return 0
  return t < 0 ? 0 : t > 1 ? 1 : t
}

export function formatValue(spec: ParamSpec, value: number): string {
  if (spec.steps) return spec.steps[Math.round(value)] ?? '?'
  if (spec.unit === 'Hz') {
    if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`
    // An LFO spends most of its range below 10 Hz, and so does the sample and
    // hold's clock. Rounding those to whole numbers reads "0 Hz" for
    // everything from a slow drift to nearly two cycles a second.
    if (value < 10) return `${value.toFixed(2)} Hz`
    return `${value.toFixed(0)} Hz`
  }
  if (spec.unit === 's') {
    return value < 1 ? `${(value * 1000).toFixed(0)} ms` : `${value.toFixed(2)} s`
  }
  if (spec.unit === 'oct') return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
  // A count, not a measurement. The knob detents onto whole numbers, and
  // "4.00 steps" reads as though there were something in between.
  if (spec.unit === '#') return `${Math.round(value)}`
  if (spec.unit === 'x') return `${value.toFixed(2)}x`
  if (spec.unit === 'vowel') return formatVowel(value)
  // Signed, as octaves are: a threshold is below zero and a makeup gain is
  // above it, and the sign is the first thing you want to see on either.
  if (spec.unit === 'dB') return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
  return value.toFixed(2)
}

/**
 * The smallest change the readout can show, at this value.
 *
 * Shift plus the wheel steps by exactly this and lands on multiples of it,
 * so every value the knob can display is a value the knob can be set to --
 * an FM amount can be put on 1.00 rather than somewhere near it.
 *
 * It follows the formatter rather than the range because the formatter is
 * where the scale changes: the same frequency knob steps by 1 Hz at 440 and
 * by 10 Hz at 8 kHz, which is one digit of the readout either way.
 */
export function stepFor(spec: ParamSpec, value: number): number {
  if (spec.steps || spec.unit === '#') return 1
  const v = Math.abs(value)
  if (spec.unit === 'Hz') {
    if (v >= 1000) return 10 // 0.01 kHz
    return v < 10 ? 0.01 : 1
  }
  if (spec.unit === 's') return v < 1 ? 0.001 : 0.01 // 1 ms, or 0.01 s
  if (spec.unit === 'dB') return 0.1
  return 0.01
}

/**
 * Round onto a multiple of `step`, in decimal.
 *
 * `Math.round(v / step) * step` is not enough on its own: 0.1 three times
 * over is 0.30000000000000004, which reaches the readout as the right number
 * and the patch file as the wrong one.
 */
export function snap(value: number, step: number): number {
  if (!(step > 0)) return value
  const places = Math.max(0, Math.min(12, -Math.floor(Math.log10(step))))
  return Number((Math.round(value / step) * step).toFixed(places))
}

export function clampValue(spec: ParamSpec, value: number): number {
  const v = spec.steps || spec.unit === '#' ? Math.round(value) : value
  return v < spec.min ? spec.min : v > spec.max ? spec.max : v
}

/**
 * Unit suffixes a value may be written with, and what one of them is worth
 * in the unit the patch stores. The keys are lower case; the text is folded
 * before it is looked up, so `kHz`, `khz` and `KHZ` are one suffix.
 */
const SUFFIX: Record<string, { unit: string; scale: number }> = {
  hz: { unit: 'Hz', scale: 1 },
  khz: { unit: 'Hz', scale: 1000 },
  k: { unit: 'Hz', scale: 1000 },
  s: { unit: 's', scale: 1 },
  sec: { unit: 's', scale: 1 },
  ms: { unit: 's', scale: 0.001 },
  x: { unit: 'x', scale: 1 },
  db: { unit: 'dB', scale: 1 },
  oct: { unit: 'oct', scale: 1 },
  '#': { unit: '#', scale: 1 },
}

/**
 * The Formant's vowels, in the order its Vowel knob passes through them. The
 * DSP keeps its own table in the same order; this is only their names.
 */
export const VOWEL_LETTERS = ['u', 'o', 'a', 'e', 'i']

/**
 * A vowel position as a reader thinks of it: "a" on one, "a→e 40%" on the way
 * to the next. A number alone would say 2.40 and leave the reader counting
 * along a list they cannot see.
 */
function formatVowel(value: number): string {
  const last = VOWEL_LETTERS.length - 1
  const v = value < 0 ? 0 : value > last ? last : value
  const lo = Math.floor(v + 0.005)
  const t = v - lo
  if (t < 0.005 || lo >= last) return VOWEL_LETTERS[Math.min(lo, last)]
  return `${VOWEL_LETTERS[lo]}→${VOWEL_LETTERS[lo + 1]} ${Math.round(t * 100)}%`
}

/** What a parameter's unit is called when a paste has to be turned down. */
export function unitName(spec: ParamSpec): string {
  if (spec.tuned) return 'a frequency or a note'
  if (spec.unit === 'Hz') return 'a frequency'
  if (spec.unit === 's') return 'a time'
  if (spec.unit === 'oct') return 'an amount in octaves'
  if (spec.unit === 'x') return 'a multiplier'
  if (spec.unit === 'dB') return 'a level in decibels'
  if (spec.unit === '#') return 'a whole number'
  if (spec.unit === 'vowel') return 'a vowel or a number'
  return 'a plain number'
}

export type ParseResult =
  | { ok: true; value: number }
  /** Why not, in words a menu row or a field can show as it stands. */
  | { ok: false; reason: string }

/**
 * Read a value written as text -- typed into the readout, or carried between
 * knobs by a copy.
 *
 * A bare number is taken to be in the knob's own unit, which is what someone
 * typing `1` into an FM amount means. A number with a unit on it has to be a
 * unit this knob could mean: `250 ms` is a time and goes into a time, and
 * nothing at all goes into a knob that wanted seconds from something
 * measured in hertz. Out of range clamps rather than fails, because the
 * intent -- as far up or as far down as this knob goes -- is clear.
 */
export function parseValue(spec: ParamSpec, text: string): ParseResult {
  const t = text.trim().toLowerCase().replace(/,/g, '')
  if (!t) return { ok: false, reason: 'nothing to read' }
  // A note, for a knob that reads in notes. Tried before the number, because
  // `b` is both a note and nothing else a value could end with.
  if (spec.tuned) {
    const hz = hzOfName(t)
    if (hz !== null) return { ok: true, value: clampValue(spec, hz) }
  }
  // A vowel by its letter, for the knob that reads in them.
  if (spec.unit === 'vowel' && VOWEL_LETTERS.includes(t)) {
    return { ok: true, value: VOWEL_LETTERS.indexOf(t) }
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z#]*)$/.exec(t)
  if (!m) return { ok: false, reason: `not ${unitName(spec)}` }
  const n = Number(m[1])
  if (!Number.isFinite(n)) return { ok: false, reason: `not ${unitName(spec)}` }
  if (!m[2]) return { ok: true, value: clampValue(spec, n) }
  const suffix = SUFFIX[m[2]]
  const want = spec.steps ? '#' : spec.unit
  if (!suffix || suffix.unit !== want) return { ok: false, reason: `not ${unitName(spec)}` }
  return { ok: true, value: clampValue(spec, n * suffix.scale) }
}
