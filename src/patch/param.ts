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

/** What a parameter's unit is called when a paste has to be turned down. */
export function unitName(spec: ParamSpec): string {
  if (spec.unit === 'Hz') return 'a frequency'
  if (spec.unit === 's') return 'a time'
  if (spec.unit === 'oct') return 'an amount in octaves'
  if (spec.unit === 'x') return 'a multiplier'
  if (spec.unit === 'dB') return 'a level in decibels'
  if (spec.unit === '#') return 'a whole number'
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
