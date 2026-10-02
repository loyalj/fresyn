/**
 * The music theory behind the Scales & chords and Progressions utilities: a
 * key's notes, spelled the way the key spells them, the chords that belong
 * to it, and a progression of those chords voiced and played in a rhythm.
 *
 * Keys are the song's own (see `Scale`): a root counted up from C and one of
 * the roll's scales. Pitches here are MIDI note numbers, so C4 is 60 -- the
 * real notes -- and a utility turns them into a track's rows at the last
 * moment, by the track's tuning, as a MIDI controller's keys are.
 */
import { PPQ } from '../song/types'
import { SCALES } from '../song/scale'

const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12

/** The major scale, which every chord numeral is counted against. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11]

/**
 * The seven-note scale a five- or six-note one takes its chords from: a
 * pentatonic has too few notes to stack thirds in, so its chords are its
 * parent's, marked where a chord reaches outside it.
 */
const PARENT: Record<string, string> = { pentatonic: 'major', pentatonicMinor: 'minor', blues: 'minor' }

/** Semitones up from the root, for a mode; the major scale for one this build does not know. */
export function scaleSteps(mode: string): number[] {
  return SCALES.find((s) => s.id === mode)?.steps ?? MAJOR
}

/** The pitch classes in a key, 0..11, root first. */
export function scaleClasses(root: number, mode: string): number[] {
  return scaleSteps(mode).map((s) => mod12(root + s))
}

/** The seven notes a key's chords are stacked from. */
export function chordSteps(mode: string): number[] {
  const steps = scaleSteps(mode)
  return steps.length === 7 ? steps : scaleSteps(PARENT[mode] ?? 'major')
}

// --- spelling -------------------------------------------------------------

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const NATURAL = [0, 2, 4, 5, 7, 9, 11]
const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
const ACCIDENTAL: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' }

/**
 * Every note of a key by name, as the key spells them: one of each letter,
 * so F major has a B♭ and not an A♯, and E♭ minor is preferred to D♯ minor
 * for having fewer accidentals. Notes outside the key -- a blues scale's
 * flat fifth -- are named with flats in a flat key and sharps otherwise.
 */
export function spelling(root: number, mode: string): (pc: number) => string {
  const steps = chordSteps(mode)
  const r = mod12(root)
  let best: { names: Map<number, string>; cost: number; flats: boolean } | null = null
  for (let letter = 0; letter < 7; letter++) {
    const off = wrap(r - NATURAL[letter])
    if (Math.abs(off) > 1) continue
    const names = new Map<number, string>()
    let cost = 0
    let flats = false
    for (let i = 0; i < 7; i++) {
      const l = (letter + i) % 7
      const pc = mod12(r + steps[i])
      const acc = wrap(pc - NATURAL[l])
      if (Math.abs(acc) > 2) {
        cost = Infinity
        break
      }
      cost += Math.abs(acc) + (Math.abs(acc) === 2 ? 4 : 0)
      if (acc < 0) flats = true
      names.set(pc, LETTERS[l] + ACCIDENTAL[acc])
    }
    // On a tie -- F♯ or G♭ major, six each -- the sharp key, as the roll names it.
    if (!best || cost < best.cost || (cost === best.cost && off > 0 && !best.flats)) best = { names, cost, flats }
  }
  const names = best!.names
  const fallback = best!.flats ? FLAT_NAMES : SHARP_NAMES
  return (pc) => names.get(mod12(pc)) ?? fallback[mod12(pc)]
}

/** -6..5: how far one pitch class is above another, the short way round. */
const wrap = (n: number) => {
  const m = mod12(n)
  return m > 6 ? m - 12 : m
}

/** The name of a key: "E♭ Minor", "C Major". */
export function keyName(root: number, mode: string): string {
  const name = SCALES.find((s) => s.id === mode)?.name ?? 'Major'
  return `${spelling(root, mode)(root)} ${name}`
}

// --- chords ---------------------------------------------------------------

export type Quality = 'maj' | 'min' | 'dim' | 'aug' | 'maj7' | 'min7' | 'dom7' | 'm7b5' | 'dim7' | 'minMaj7' | 'augMaj7'

const QUALITIES: Record<string, { quality: Quality; name: string; numeral: string; minor: boolean }> = {
  '0,4,7': { quality: 'maj', name: '', numeral: '', minor: false },
  '0,3,7': { quality: 'min', name: 'm', numeral: '', minor: true },
  '0,3,6': { quality: 'dim', name: 'dim', numeral: '°', minor: true },
  '0,4,8': { quality: 'aug', name: 'aug', numeral: '+', minor: false },
  '0,4,7,11': { quality: 'maj7', name: 'maj7', numeral: 'maj7', minor: false },
  '0,3,7,10': { quality: 'min7', name: 'm7', numeral: '7', minor: true },
  '0,4,7,10': { quality: 'dom7', name: '7', numeral: '7', minor: false },
  '0,3,6,10': { quality: 'm7b5', name: 'm7♭5', numeral: 'ø7', minor: true },
  '0,3,6,9': { quality: 'dim7', name: 'dim7', numeral: '°7', minor: true },
  '0,3,7,11': { quality: 'minMaj7', name: 'm(maj7)', numeral: '(maj7)', minor: true },
  '0,4,8,11': { quality: 'augMaj7', name: 'aug(maj7)', numeral: '+(maj7)', minor: false },
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']

export interface Chord {
  /** Which degree of the key it is built on, 0 for the tonic. */
  degree: number
  /** Its root, as a pitch class. */
  root: number
  /** Semitones from the root, lowest first, in root position. */
  intervals: number[]
  quality: Quality | null
  /** "Dm", "B♭maj7", "F♯dim". */
  name: string
  /** "ii", "♭VII", "viiø7". */
  numeral: string
  /** Its notes by name, root first. */
  notes: string[]
  /** Whether a note of it is outside the key itself: a pentatonic's chords borrowed from its parent. */
  outside: boolean
}

/**
 * The chords of a key, one on each degree: every other note of the scale
 * stacked from it -- a triad, or with `sevenths` a seventh chord. In C major,
 * C Dm Em F G Am Bdim; in A minor, Am Bdim C Dm Em F G.
 */
export function diatonicChords(root: number, mode: string, sevenths = false): Chord[] {
  const steps = chordSteps(mode)
  const inKey = new Set(scaleClasses(root, mode))
  const name = spelling(root, mode)
  const stack = sevenths ? [0, 2, 4, 6] : [0, 2, 4]
  return steps.map((step, degree) => {
    const intervals = stack.map((k) => {
      const i = degree + k
      return steps[i % 7] + 12 * Math.floor(i / 7) - step
    })
    const pcs = intervals.map((s) => mod12(root + step + s))
    const q = QUALITIES[intervals.join(',')]
    const accidental = ACCIDENTAL[wrap(step - MAJOR[degree])] ?? ''
    const roman = q?.minor ? ROMAN[degree].toLowerCase() : ROMAN[degree]
    return {
      degree,
      root: pcs[0],
      intervals,
      quality: q?.quality ?? null,
      name: name(pcs[0]) + (q ? q.name : '?'),
      numeral: accidental + roman + (q?.numeral ?? ''),
      notes: pcs.map(name),
      outside: pcs.some((pc) => !inKey.has(pc)),
    }
  })
}

/** The circle of fifths, as pitch classes clockwise from C at the top. */
export const CIRCLE: readonly number[] = Array.from({ length: 12 }, (_, i) => (i * 7) % 12)

/** The major key at each place on the circle, named as it is usually written. */
export const CIRCLE_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'D♭', 'A♭', 'E♭', 'B♭', 'F']
/** And the minor key that shares its notes. */
export const CIRCLE_MINOR = ['Am', 'Em', 'Bm', 'F♯m', 'C♯m', 'G♯m', 'D♯m', 'B♭m', 'Fm', 'Cm', 'Gm', 'Dm']

/** The notes of a chord as MIDI notes, in root position, its root in `octave` (4 is C4 to B4). */
export function chordMidi(chord: Chord, octave: number): number[] {
  const base = 12 * (octave + 1) + chord.root
  return chord.intervals.map((s) => base + s)
}

// --- progressions ---------------------------------------------------------

export interface ProgressionPreset {
  id: string
  /** What it is known as. Its numerals are worked out for the key it is played in. */
  name: string
  /** Degrees of the key, 0 for the tonic. */
  degrees: number[]
}

/**
 * Progressions everybody has heard, as degrees of the key: in a minor key
 * the same degrees are that key's own chords, so the pop progression in A
 * minor is i–v–VI–iv.
 */
export const PROGRESSIONS: readonly ProgressionPreset[] = [
  { id: 'pop', name: 'Pop', degrees: [0, 4, 5, 3] },
  { id: 'axis', name: 'Axis', degrees: [5, 3, 0, 4] },
  { id: 'fifties', name: 'Fifties', degrees: [0, 5, 3, 4] },
  { id: 'jazz', name: 'Jazz turnaround', degrees: [1, 4, 0] },
  { id: 'circle', name: 'Circle', degrees: [5, 1, 4, 0] },
  { id: 'rock', name: 'Three-chord', degrees: [0, 3, 4, 0] },
  { id: 'royal', name: 'Royal road', degrees: [3, 4, 2, 5] },
  { id: 'canon', name: 'Canon', degrees: [0, 4, 5, 2, 3, 0, 3, 4] },
  { id: 'blues', name: '12-bar blues', degrees: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4] },
]

export type Voicing = 'close' | 'smooth' | 'spread' | 'bass'

export const VOICINGS: readonly { id: Voicing; name: string; description: string }[] = [
  { id: 'close', name: 'Close', description: 'Every chord in root position, stacked as tightly as it goes' },
  { id: 'smooth', name: 'Smooth', description: 'Each chord inverted to move as little as it can from the one before' },
  { id: 'spread', name: 'Spread', description: 'Root position with the third lifted an octave: wider and airier' },
  { id: 'bass', name: 'With bass', description: 'Smooth chords over the root an octave below' },
]

export type Rhythm = 'held' | 'beats' | 'eighths' | 'offbeats' | 'charleston' | 'arpUp' | 'arpUpDown'

export const RHYTHMS: readonly { id: Rhythm; name: string; description: string }[] = [
  { id: 'held', name: 'Held', description: 'Each chord held for as long as it lasts' },
  { id: 'beats', name: 'Beats', description: 'Struck on every beat' },
  { id: 'eighths', name: 'Eighths', description: 'Struck on every eighth note' },
  { id: 'offbeats', name: 'Off-beats', description: 'Between the beats, as a skank or a house stab' },
  { id: 'charleston', name: 'Charleston', description: 'On one and the and of two, in every bar' },
  { id: 'arpUp', name: 'Arp up', description: 'Its notes one at a time, upward, in eighths' },
  { id: 'arpUpDown', name: 'Arp up & down', description: 'Its notes upward and back, in eighths' },
]

export interface ProgressionSpec {
  root: number
  mode: string
  degrees: readonly number[]
  sevenths: boolean
  voicing: Voicing
  rhythm: Rhythm
  /** The octave the first chord's root sits in: 3 is C3 to B3. */
  octave: number
  /** How long each chord lasts, in ticks. */
  chordTicks: number
  /** A beat, in ticks: what Beats and Off-beats count in. */
  beatTicks: number
  /** A bar, in ticks: what the Charleston repeats in. */
  barTicks: number
  velocity: number
}

/** One note of a written progression, in MIDI notes and ticks from the start. */
export interface WrittenNote {
  tick: number
  length: number
  midi: number
  velocity: number
}

/**
 * Each chord of a progression as the notes it is voiced with, lowest first.
 *
 * Smooth voice leading tries every inversion of a chord, an octave either
 * way, and keeps the one whose notes are nearest the last chord's -- pinned
 * to stay within a fifth of where the progression started, so a long one
 * cannot wander off the keyboard one small step at a time.
 */
export function voiceProgression(spec: Pick<ProgressionSpec, 'root' | 'mode' | 'degrees' | 'sevenths' | 'voicing' | 'octave'>): number[][] {
  const chords = diatonicChords(spec.root, spec.mode, spec.sevenths)
  const out: number[][] = []
  let last: number[] | null = null
  let home: number | null = null
  for (const d of spec.degrees) {
    const chord = chords[((d % 7) + 7) % 7]
    const close = chordMidi(chord, spec.octave)
    if (spec.voicing === 'close') {
      out.push(close)
      continue
    }
    if (spec.voicing === 'spread') {
      // Root, fifth, then the third and any seventh an octave up.
      const [r, third, ...rest] = close
      out.push([r, ...rest.slice(0, 1), third + 12, ...rest.slice(1).map((p) => p + 12)].sort((a, b) => a - b))
      continue
    }
    let voiced = close
    if (last && home !== null) {
      let bestCost = Infinity
      for (let inv = 0; inv < close.length; inv++) {
        const inverted = close.map((p, i) => (i < inv ? p + 12 : p)).sort((a, b) => a - b)
        for (const shift of [-12, 0, 12]) {
          const v = inverted.map((p) => p + shift)
          if (Math.abs(v[0] - home) > 7) continue
          const cost = distance(last, v)
          if (cost < bestCost) {
            bestCost = cost
            voiced = v
          }
        }
      }
    }
    home ??= voiced[0]
    last = voiced
    out.push(spec.voicing === 'bass' ? [close[0] - 12, ...voiced] : voiced)
  }
  return out
}

/** How far the notes of one chord move to reach another's: each to the nearest. */
function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (const p of b) sum += Math.min(...a.map((q) => Math.abs(p - q)))
  for (const q of a) sum += Math.min(...b.map((p) => Math.abs(p - q)))
  return sum
}

/**
 * A progression as notes: each chord voiced, then played in the rhythm for
 * as long as it lasts. A hit that would run past the end of its chord is cut
 * at the chord's end, so a chord never rings into the next.
 */
export function progressionNotes(spec: ProgressionSpec): WrittenNote[] {
  const voiced = voiceProgression(spec)
  const out: WrittenNote[] = []
  const eighth = PPQ / 2
  voiced.forEach((notes, i) => {
    const start = i * spec.chordTicks
    const end = start + spec.chordTicks
    const hit = (at: number, length: number, pitches: readonly number[], velocity = spec.velocity) => {
      const tick = start + at
      if (tick >= end) return
      const len = Math.min(length, end - tick)
      for (const midi of pitches) out.push({ tick, length: len, midi, velocity })
    }
    const every = (step: number, offset: number, length: number) => {
      for (let at = offset; at < spec.chordTicks; at += step) hit(at, length, notes)
    }
    const gap = (n: number) => Math.max(1, Math.round(n * 0.9))
    switch (spec.rhythm) {
      case 'held':
        hit(0, spec.chordTicks, notes)
        break
      case 'beats':
        every(spec.beatTicks, 0, gap(spec.beatTicks))
        break
      case 'eighths':
        every(eighth, 0, gap(eighth))
        break
      case 'offbeats':
        every(spec.beatTicks, spec.beatTicks / 2, gap(spec.beatTicks / 2))
        break
      case 'charleston':
        for (let bar = 0; bar < spec.chordTicks; bar += spec.barTicks) {
          hit(bar, gap(PPQ), notes)
          hit(bar + PPQ * 1.5, gap(eighth), notes, spec.velocity * 0.85)
        }
        break
      case 'arpUp':
      case 'arpUpDown': {
        // The bass of a "with bass" voicing is held under the arpeggio rather than taking a turn in it.
        const bass = spec.voicing === 'bass'
        if (bass) hit(0, spec.chordTicks, notes.slice(0, 1))
        const upper = bass ? notes.slice(1) : notes
        const order = spec.rhythm === 'arpUp' ? upper : [...upper, ...upper.slice(1, -1).reverse()]
        let k = 0
        for (let at = 0; at < spec.chordTicks; at += eighth) hit(at, gap(eighth), [order[k++ % order.length]])
        break
      }
    }
  })
  return out
}

/**
 * The progression written out for a pattern: round again to fill it when
 * asked, and how long the pattern has to be to hold it once.
 */
export function fitProgression(notes: readonly WrittenNote[], once: number, patternLength: number, fill: boolean) {
  const length = Math.max(patternLength, once)
  if (!fill || once <= 0 || once >= length) return { notes: [...notes], length }
  const out: WrittenNote[] = []
  for (let start = 0; start < length; start += once) {
    for (const n of notes) {
      const tick = start + n.tick
      if (tick >= length) continue
      out.push({ ...n, tick, length: Math.min(n.length, length - tick) })
    }
  }
  return { notes: out, length }
}
