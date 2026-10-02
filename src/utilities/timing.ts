/**
 * The arithmetic behind the Timing utility: how long a song is in bars, and
 * how long a note is in milliseconds.
 *
 * Kept apart from the panel so the checks can hold it to its numbers, and so
 * the one rule that is easy to get wrong is written down once: **tempo counts
 * quarter notes**, whatever the time signature, as it does everywhere in this
 * app (see `framesPerTick`). 6/8 at 120 is 120 quarters a minute -- 240
 * eighths -- and a bar of it lasts a second and a half.
 */

export interface Signature {
  beats: number
  /** The note a beat is: 4 for a quarter, 8 for an eighth. */
  unit: number
}

/** One quarter note, in seconds. */
export function quarterSeconds(bpm: number): number {
  return 60 / bpm
}

/** One beat of the signature -- a quarter in 4/4, an eighth in 6/8 -- in seconds. */
export function beatSeconds(bpm: number, sig: Signature): number {
  return quarterSeconds(bpm) * (4 / sig.unit)
}

/** One bar, in seconds. */
export function barSeconds(bpm: number, sig: Signature): number {
  return beatSeconds(bpm, sig) * sig.beats
}

/** A length of time as bars, beats and what is left of a beat. */
export interface BarCount {
  /** Every beat that fits, fractional. */
  beats: number
  /** Whole bars, then whole beats past them, then the part of a beat after those. */
  bars: number
  extraBeats: number
  remainder: number
}

/**
 * How much music fits in `seconds`.
 *
 * Rounded to a millionth of a beat first, so that three minutes at 120 comes
 * out as 360 beats exactly rather than 359.99999999999994 and a stray beat
 * short of the last bar.
 */
export function countBars(seconds: number, bpm: number, sig: Signature): BarCount {
  const beats = Math.round((seconds / beatSeconds(bpm, sig)) * 1e6) / 1e6
  const bars = Math.floor(beats / sig.beats)
  const past = beats - bars * sig.beats
  const extraBeats = Math.floor(past + 1e-9)
  return { beats, bars, extraBeats, remainder: Math.max(0, past - extraBeats) }
}

/** How long `bars` bars last. */
export function barsToSeconds(bars: number, bpm: number, sig: Signature): number {
  return bars * barSeconds(bpm, sig)
}

// --- durations as people write them -----------------------------------------

/**
 * A length typed the way people type one: `3:00`, `2:30.5`, `1:02:03`, `180`
 * (seconds), `3m`, `90s`, `2m30s`. Null for anything else, or for nothing
 * longer than zero.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (t === '') return null
  let seconds: number
  if (/^\d+(\.\d+)?$/.test(t)) {
    seconds = Number(t)
  } else if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) {
    const parts = t.split(':').map(Number)
    if (parts.slice(1).some((p) => Math.floor(p) >= 60)) return null
    seconds = parts.reduce((total, p) => total * 60 + p, 0)
  } else {
    const m = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(t)
    if (!m || (!m[1] && !m[2] && !m[3])) return null
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  }
  return seconds > 0 && Number.isFinite(seconds) ? seconds : null
}

/**
 * Seconds as `m:ss`, with tenths when there are any: `3:00`, `3:12.5`, and
 * `1:02:03` past an hour.
 */
export function formatDuration(seconds: number): string {
  const tenths = Math.round(seconds * 10)
  const whole = Math.floor(tenths / 10)
  const frac = tenths % 10
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const ss = `${String(s).padStart(2, '0')}${frac ? `.${frac}` : ''}`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// --- note lengths ---------------------------------------------------------------

/** How a note value is played: as written, dotted, or three in the time of two. */
export type Feel = 'straight' | 'dotted' | 'triplet'

export const FEELS: readonly Feel[] = ['straight', 'dotted', 'triplet']

const FEEL_SCALE: Record<Feel, number> = { straight: 1, dotted: 1.5, triplet: 2 / 3 }

/** The note values the table lists, as fractions of a whole note. */
export const DIVISIONS = [1, 2, 4, 8, 16, 32, 64] as const

/** A whole note divided by `division`, played with `feel`, in seconds. */
export function noteSeconds(bpm: number, division: number, feel: Feel): number {
  return quarterSeconds(bpm) * (4 / division) * FEEL_SCALE[feel]
}

/** The name a note value goes by: 1/4, 1/8 dotted, 1/16 triplet. */
export function noteName(division: number, feel: Feel = 'straight'): string {
  const base = division === 1 ? '1/1' : `1/${division}`
  return feel === 'straight' ? base : `${base} ${feel}`
}

/**
 * A length in the unit a knob wants it: milliseconds for a delay's time, hertz
 * for an LFO's rate -- once per note is the rate that lands on the beat -- and
 * samples at `sampleRate` for anything counted in samples.
 */
export type TimeUnit = 'ms' | 'hz' | 'samples'

export function inUnit(seconds: number, unit: TimeUnit, sampleRate: number): number {
  switch (unit) {
    case 'ms':
      return seconds * 1000
    case 'hz':
      return 1 / seconds
    case 'samples':
      return seconds * sampleRate
  }
}

/**
 * A value for showing and copying: whole samples, and milliseconds and hertz
 * to as many decimals as are worth reading at their size.
 */
export function formatUnit(value: number, unit: TimeUnit): string {
  if (unit === 'samples') return String(Math.round(value))
  const places = unit === 'hz' ? (value < 1 ? 4 : value < 10 ? 3 : 2) : value < 10 ? 3 : value < 1000 ? 2 : 1
  return String(Number(value.toFixed(places)))
}

// --- tap tempo ---------------------------------------------------------------

/**
 * A pause longer than this starts a fresh count, so a new tempo can be tapped
 * without clearing the old one first. Two seconds: the gap between taps at
 * 30 BPM, slower than anything a person taps out.
 */
export const TAP_RESET_S = 2

/** How many of the latest taps a reading is taken over: enough to settle, few enough to follow a change. */
export const TAP_WINDOW = 16

export interface TapReading {
  /** Quarter notes a minute, to the tapping's own precision. */
  bpm: number
  /** How many taps the reading is over. */
  taps: number
  /**
   * How even the gaps were, 0 to 1: one less their spread against their
   * size. Near 1 is a steady hand; a reading much below 0.9 is still settling.
   */
  steadiness: number
}

/**
 * Tempo from taps.
 *
 * The tempo is the slope of a straight line through the tap times -- a least
 * squares fit -- rather than the average gap. The two agree for a steady
 * hand, but a fit leans on every tap, so one early and one late cancel rather
 * than the reading lurching with each, and it settles after a few taps.
 */
export class TapTempo {
  private times: number[] = []

  /** A tap at `seconds`, on any clock that only goes forward. Null after the first tap of a count. */
  tap(seconds: number): TapReading | null {
    const times = this.times
    const last = times[times.length - 1]
    if (last !== undefined && (seconds <= last || seconds - last > TAP_RESET_S)) times.length = 0
    times.push(seconds)
    if (times.length > TAP_WINDOW) times.shift()
    return this.reading()
  }

  /** Start the count again. */
  reset() {
    this.times.length = 0
  }

  reading(): TapReading | null {
    const t = this.times
    const n = t.length
    if (n < 2) return null
    // Tap number against time: the slope is seconds a beat.
    const meanI = (n - 1) / 2
    let meanT = 0
    for (const x of t) meanT += x
    meanT /= n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      num += (i - meanI) * (t[i] - meanT)
      den += (i - meanI) * (i - meanI)
    }
    const perBeat = num / den
    let spread = 0
    for (let i = 1; i < n; i++) spread += (t[i] - t[i - 1] - perBeat) ** 2
    const deviation = n > 2 ? Math.sqrt(spread / (n - 1)) : 0
    return {
      bpm: 60 / perBeat,
      taps: n,
      steadiness: Math.max(0, Math.min(1, 1 - deviation / perBeat)),
    }
  }
}
