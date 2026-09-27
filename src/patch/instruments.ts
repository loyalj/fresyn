import { defOf } from './defs'
import type { Built } from './library'
import { wire } from './library'
import type { Patch } from './types'

/**
 * Off-the-shelf voices: racks that play like an instrument the moment they
 * are loaded, for somebody who wants to write music rather than build a sound
 * first.
 *
 * Every pitched one follows the same outline, which is the starting rack's:
 * a Trigger on Space into a Keyboard, the Keyboard's Pitch into each
 * oscillator's Pitch jack, its Gate into whatever shapes the note, and its
 * Vel into a VCA near the end so a softer note in the roll is a quieter one.
 * The bottom key is always a C, because the roll labels it C: each voice
 * tunes its oscillators to the C its instrument would sit on, and Octave on
 * the Keyboard moves it from there.
 *
 * The drums have no Keyboard. A rack with only a Trigger is a single lane of
 * hits in the roll, which is what a kick or a hat is.
 *
 * Levels are set for a chord rather than a note. The mixer rounds off
 * anything that goes over, which is kind to a chord and cruel to a chord
 * that was already loud, so a single note here sits well down and six of
 * them together still have room. `npm run check:instruments` renders every
 * one and holds them to that, and to playing in tune.
 */

/** The C each voice's bottom key sits on. */
const C1 = 32.7032
const C2 = 65.4064
const C3 = 130.8128
const C4 = 261.6256
const C5 = 523.2511
const C6 = 1046.502

export type InstrumentCategory =
  | 'keys'
  | 'plucked'
  | 'mallets'
  | 'strings'
  | 'brass'
  | 'bass'
  | 'leads'
  | 'drums'

export interface Instrument {
  id: string
  name: string
  category: InstrumentCategory
  /** What it sounds like, in one line, for the list. */
  description: string
  /** One thing worth doing with it, for the list's second line. */
  tip: string
  make(): Built
}

// --- building ------------------------------------------------------------

/** `[id, type, knobs]`, in rack order. Ids use the Modules menu's slugs. */
type Unit = [id: string, type: string, knobs?: Record<string, number>]

/**
 * A rack from a list of units and the cables between them.
 *
 * Knobs are checked against the catalogue as the rack is made, so a typo
 * throws here -- and so in the check -- instead of shipping a voice with a
 * knob quietly left at its default.
 */
function rack(units: Unit[], cables: string[]): Built {
  const patch: Patch = {
    modules: units.map(([id, type]) => ({
      id,
      type,
      params: {},
      ...(type === 'gate' ? { key: 'Space' } : {}),
    })),
    cables: [],
  }
  const values: Record<string, number> = {}
  for (const [id, type, knobs] of units) {
    const specs = defOf(type).params
    for (const [knob, value] of Object.entries(knobs ?? {})) {
      if (!specs.some((s) => s.id === knob)) throw new Error(`${id} (${type}) has no knob "${knob}"`)
      values[`${id}.${knob}`] = value
    }
  }
  return { patch: wire(patch, ...cables), values }
}

/**
 * The top of every pitched voice: Space into a Keyboard with this many
 * voices. One is a single line, for basses and leads that glide or take over
 * from the note before; anything more plays chords.
 */
function played(voices: number): { units: Unit[]; cables: string[] } {
  return {
    units: [
      ['gate1', 'gate'],
      ['key1', 'keys', { voices }],
    ],
    cables: ['gate1.gate -> key1.trig'],
  }
}

/**
 * An oscillator envelope: amplitude only, with these stages.
 *
 * Decay and Release are time constants, as they are on every envelope in the
 * rack: the level falls to a third in that long and is gone in about nine
 * times it. So a bell that rings for ten seconds has a Decay near one.
 */
function env(attack: number, decay: number, sustain: number, release: number) {
  return { envAmount: 1, attack, decay, sustain, release }
}

/** The mixer at the bottom, taking a stereo pair on 1 and 2. */
const STEREO_OUT: Unit = ['mix1', 'mixer', { pan1: -1, pan2: 1, level1: 0.8, level2: 0.8 }]
/** Or a mono voice on 1, centred. */
const MONO_OUT: Unit = ['mix1', 'mixer', { level1: 0.8 }]

/**
 * How hard a drum is hit: the Trigger's Vel into a VCA just before the way
 * out, a quarter open at the softest so a ghost note is quiet rather than
 * gone.
 */
const TOUCH = { level: 0.25, cvAmount: 0.75 }

/** A room at the end: `from` into the Space, and its two sides out. */
function room(from: string, size: number, decay: number, mix: number, damping = 0.4) {
  return {
    unit: ['spc1', 'reverb', { size, decay, mix, damping }] as Unit,
    cables: [`${from} -> spc1.in`, 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
  }
}

/**
 * Two-operator FM, which is most of the keys and every bell here.
 *
 * `osc2` is the modulator, tuned to `ratio` times the carrier and never heard
 * on its own: its envelope is the brightness of the note, and it reaches the
 * carrier through a VCA opened by velocity, so a harder note is a brighter
 * one as well as a louder one. The carrier runs in linear FM, and both are
 * played on their Pitch jacks, so the timbre is the same at every key.
 */
interface FmVoice {
  base: number
  ratio: number
  /** How far the modulator bends the carrier at full velocity. */
  index: number
  /** Modulator envelope: how the brightness moves over the note. */
  bright: ReturnType<typeof env>
  /** Carrier envelope: how the loudness moves. */
  body: ReturnType<typeof env>
  level: number
  /** How much of the brightness velocity decides, 0..1. */
  touch?: number
}

function fm(v: FmVoice): { units: Unit[]; cables: string[] } {
  const touch = v.touch ?? 0.7
  return {
    units: [
      ['osc2', 'osc', { pitch: v.base * v.ratio, wave: 3, ...v.bright }],
      ['vca1', 'vca', { level: 1 - touch, cvAmount: touch }],
      ['osc1', 'osc', { pitch: v.base, wave: 3, fmMode: 1, fmAmount: v.index, level: v.level, ...v.body }],
      ['vca2', 'vca', { level: 0.25, cvAmount: 0.75 }],
    ],
    cables: [
      'key1.pitch -> osc2.pitch',
      'key1.gate -> osc2.gate',
      'osc2.out -> vca1.in',
      'key1.vel -> vca1.cv',
      'vca1.out -> osc1.fm',
      'key1.pitch -> osc1.pitch',
      'key1.gate -> osc1.gate',
      'osc1.out -> vca2.in',
      'key1.vel -> vca2.cv',
    ],
  }
}

/**
 * A plucked string: Karplus-Strong on the Resonator.
 *
 * A very short burst from an oscillator -- at the note's own pitch, so the
 * string is struck with harmonics it can ring at -- goes through a filter
 * that sets how hard the pick is, into a Resonator tuned by the Keyboard. A
 * VCA after it follows the key, so letting go damps the string the way a
 * finger does; a long Release is a string left to ring.
 */
interface Pluck {
  base: number
  /** The pick: which wave, how long, how bright. */
  wave: number
  width?: number
  strike: number
  tone: number
  /** The string: how long it rings, and how fast its top end dies. */
  ring: number
  damping: number
  /** How long it keeps ringing after the key comes up. */
  release: number
}

function pluck(p: Pluck): { units: Unit[]; cables: string[] } {
  return {
    units: [
      ['osc1', 'osc', { pitch: p.base, wave: p.wave, width: p.width ?? 0.5, level: 0.8, ...env(0.0005, p.strike, 0, p.strike) }],
      ['vca1', 'vca', { level: 0.15, cvAmount: 0.85 }],
      ['lpf1', 'ladder', { mode: 1, cutoff: p.tone, resonance: 0, drive: 1, cvAmount: 1 }],
      ['res1', 'res', { pitch: p.base, cvAmount: 1, decay: p.ring, damping: p.damping }],
      ['env1', 'adsr', { attack: 0.0005, decay: 0.01, sustain: 1, release: p.release }],
      ['vca2', 'vca', { level: 0, cvAmount: 1 }],
    ],
    cables: [
      'key1.pitch -> osc1.pitch',
      'key1.gate -> osc1.gate',
      'osc1.out -> vca1.in',
      'key1.vel -> vca1.cv',
      'vca1.out -> lpf1.in',
      // The pick's brightness follows the note, as a real one does.
      'key1.pitch -> lpf1.cv',
      'lpf1.out -> res1.in',
      'key1.pitch -> res1.cv',
      'key1.gate -> env1.gate',
      'res1.out -> vca2.in',
      'env1.out -> vca2.cv',
    ],
  }
}

/** A voice assembled from parts, each contributing units and cables. */
function build(...parts: ({ units: Unit[]; cables: string[] } | { unit: Unit; cables: string[] })[]): Built {
  const units: Unit[] = []
  const cables: string[] = []
  for (const part of parts) {
    if ('unit' in part) units.push(part.unit)
    else units.push(...part.units)
    cables.push(...part.cables)
  }
  // The console belongs at the bottom, whatever order the parts came in.
  const at = units.findIndex(([, type]) => type === 'mixer')
  if (at >= 0) units.push(...units.splice(at, 1))
  return rack(units, cables)
}

const out = (unit: Unit, ...cables: string[]) => ({ unit, cables })
const units = (list: Unit[], ...cables: string[]) => ({ units: list, cables })

// --- the voices ------------------------------------------------------------

export const INSTRUMENTS: Instrument[] = [
  // --- keys ---------------------------------------------------------------
  {
    id: 'epiano',
    name: 'Electric piano',
    category: 'keys',
    description: 'A warm tine piano that barks when you dig in and glows when you do not.',
    tip: 'Velocity is the whole instrument: vary it in the roll and the tone follows.',
    make: () =>
      build(
        played(8),
        fm({
          base: C3,
          ratio: 1,
          index: 1.1,
          bright: env(0.0005, 0.4, 0.12, 0.2),
          body: env(0.001, 1.8, 0, 0.3),
          level: 0.4,
        }),
        // The tine: a high partial that is there for the first moment only.
        units(
          [
            ['osc3', 'osc', { pitch: C3 * 14, wave: 3, level: 0.05, ...env(0.0005, 0.12, 0, 0.05) }],
            ['cv1', 'cv', {}],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
        ),
        room('cv1.sum', 0.35, 1.2, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'organ',
    name: 'Organ',
    category: 'keys',
    description: 'Three drawbars of sine through a slowly turning chorus.',
    tip: 'The first mixer is the drawbars: pull faders 1 to 3 for a different register.',
    make: () =>
      rack(
        [
          ...played(8).units,
          // 8', 4' and 2 2/3': the fundamental, the octave, and the twelfth.
          ['osc1', 'osc', { pitch: C3, wave: 3, level: 1, ...env(0.004, 0.1, 1, 0.04) }],
          ['osc2', 'osc', { pitch: C3 * 2, wave: 3, level: 1, ...env(0.004, 0.1, 1, 0.04) }],
          ['osc3', 'osc', { pitch: C3 * 3, wave: 3, level: 1, ...env(0.004, 0.1, 1, 0.04) }],
          // A real organ ignores how hard a key is pressed. This one listens,
          // gently, so a roll's dynamics are not thrown away.
          ['vca1', 'vca', { level: 0.5, cvAmount: 0.5 }],
          ['vca2', 'vca', { level: 0.5, cvAmount: 0.5 }],
          ['vca3', 'vca', { level: 0.5, cvAmount: 0.5 }],
          ['mix1', 'mixer', { level1: 0.5, level2: 0.36, level3: 0.26, master: 1 }],
          ['lfo1', 'lfo', { rate: 0.8, shape: 3 }],
          ['dly1', 'delay', { time: 0.005, cvAmount: 0.15, feedback: 0.1, damping: 0.2, mix: 0.5 }],
          ['spc1', 'reverb', { size: 0.5, decay: 1.4, mix: 0.2 }],
          ['mix2', 'mixer', { pan1: -1, pan2: 1 }],
        ],
        [
          ...played(8).cables,
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'key1.gate -> osc3.gate',
          'osc1.out -> vca1.in',
          'osc2.out -> vca2.in',
          'osc3.out -> vca3.in',
          'key1.vel -> vca1.cv',
          'key1.vel -> vca2.cv',
          'key1.vel -> vca3.cv',
          'vca1.out -> mix1.in1',
          'vca2.out -> mix1.in2',
          'vca3.out -> mix1.in3',
          'mix1.l -> dly1.in',
          'lfo1.out -> dly1.cv',
          'dly1.out -> spc1.in',
          'spc1.l -> mix2.in1',
          'spc1.r -> mix2.in2',
        ],
      ),
  },
  {
    id: 'harpsichord',
    name: 'Harpsichord',
    category: 'keys',
    description: 'A bright plucked keyboard with a second string an octave up.',
    tip: 'Short notes in the roll: letting go damps the strings, as on the real one.',
    make: () =>
      build(
        played(8),
        pluck({ base: C3, wave: 1, width: 0.15, strike: 0.004, tone: 9000, ring: 3.5, damping: 0.08, release: 0.12 }),
        // The 4' register: the same pick into a string tuned an octave up.
        units(
          [
            ['res2', 'res', { pitch: C3 * 2, cvAmount: 1, decay: 2.5, damping: 0.12 }],
            ['vca3', 'vca', { level: 0, cvAmount: 0.6 }],
            ['cv1', 'cv', {}],
          ],
          'lpf1.out -> res2.in',
          'key1.pitch -> res2.cv',
          'res2.out -> vca3.in',
          'env1.out -> vca3.cv',
          'vca2.out -> cv1.in1',
          'vca3.out -> cv1.in2',
        ),
        room('cv1.sum', 0.3, 1, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'clavinet',
    name: 'Clavinet',
    category: 'keys',
    description: 'A funky, snapping keyboard: a thin pulse through a filter that opens on every note.',
    tip: 'Play it staccato and syncopated. It mutes the moment a key comes up.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 1, width: 0.22, level: 0.22, ...env(0.0008, 1.2, 0.35, 0.03) }],
            // Filter CV: the note's own envelope, plus some of its pitch so
            // the top of the keyboard is as bright as the bottom.
            ['cv1', 'cv', { gain1: 1.2, gain2: 0.5 }],
            ['lpf1', 'ladder', { cutoff: 700, resonance: 0.45, drive: 2, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.env -> cv1.in1',
          'key1.pitch -> cv1.in2',
          'osc1.out -> lpf1.in',
          'cv1.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.25, 0.7, 0.12),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'musicbox',
    name: 'Music box',
    category: 'keys',
    description: 'Tiny struck tines, bright on the attack and ringing clear.',
    tip: 'High and sparse: a lullaby melody, or an arpeggio over a pad.',
    make: () =>
      build(
        played(8),
        fm({
          base: C5,
          ratio: 4,
          index: 0.6,
          bright: env(0.0005, 0.06, 0, 0.05),
          body: env(0.0008, 0.9, 0, 0.6),
          level: 0.4,
        }),
        room('vca2.out', 0.45, 1.8, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'synthpiano',
    name: 'Synth piano',
    category: 'keys',
    description: 'A piano as a synthesiser hears one: bright strike, darkening decay.',
    tip: 'Not a grand, and not trying to be. Good for chords under a melody.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.9985, wave: 0, level: 0.35, ...env(0.001, 1.3, 0, 0.3) }],
            ['osc2', 'osc', { pitch: C3 * 1.0015, wave: 1, width: 0.35, level: 0.25, ...env(0.001, 1.3, 0, 0.3) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', { gain1: 2, gain2: 0.8 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 500, resonance: 0.1, drive: 1.2, cvAmount: 1.5 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          // The strike opens the filter and the decay closes it again, which
          // is what a hammered string does to its own top end.
          'osc1.env -> cv2.in1',
          'key1.pitch -> cv2.in2',
          'cv2.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.45, 1.6, 0.2),
        out(STEREO_OUT),
      ),
  },

  // --- plucked ------------------------------------------------------------
  {
    id: 'guitar',
    name: 'Nylon guitar',
    category: 'plucked',
    description: 'A soft-picked classical string with a round, woody tone.',
    tip: 'Arpeggiate chords a sixteenth apart instead of stacking them: that is a strum.',
    make: () =>
      build(
        played(8),
        pluck({ base: C3, wave: 0, strike: 0.006, tone: 2200, ring: 3.5, damping: 0.35, release: 0.25 }),
        room('vca2.out', 0.35, 1, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'harp',
    name: 'Harp',
    category: 'plucked',
    description: 'Gentle strings that ring on long after they are plucked.',
    tip: 'Sweep a scale up in quick notes for a glissando; the strings ring over each other.',
    make: () =>
      build(
        played(8),
        pluck({ base: C3, wave: 0, strike: 0.01, tone: 1400, ring: 6, damping: 0.25, release: 1.2 }),
        room('vca2.out', 0.7, 2.5, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'pizzicato',
    name: 'Pizzicato strings',
    category: 'plucked',
    description: 'A string section plucking, short and bouncy, in a hall.',
    tip: 'Staccato bass lines and off-beat chords -- the classic comedy-caper sound.',
    make: () =>
      build(
        played(8),
        pluck({ base: C3, wave: 0, strike: 0.004, tone: 3000, ring: 0.45, damping: 0.4, release: 0.2 }),
        room('vca2.out', 0.75, 1.8, 0.4),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'koto',
    name: 'Koto',
    category: 'plucked',
    description: 'A bright, twanging zither string with a long, clear ring.',
    tip: 'Pentatonic melodies suit it: try C, D, E, G and A only.',
    make: () =>
      build(
        played(8),
        pluck({ base: C4, wave: 1, width: 0.1, strike: 0.003, tone: 8000, ring: 2.5, damping: 0.06, release: 0.6 }),
        room('vca2.out', 0.4, 1.4, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'kalimba',
    name: 'Kalimba',
    category: 'plucked',
    description: 'A thumb piano: soft metal tines with a little tick on the front.',
    tip: 'Loops of four or five notes; it is at its best repeating.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 7,
          index: 0.5,
          bright: env(0.0005, 0.02, 0, 0.02),
          body: env(0.0008, 0.6, 0, 0.4),
          level: 0.45,
        }),
        room('vca2.out', 0.35, 1.1, 0.2),
        out(STEREO_OUT),
      ),
  },

  // --- bells and mallets --------------------------------------------------
  {
    id: 'tubularbell',
    name: 'Tubular bell',
    category: 'mallets',
    description: 'A long orchestral chime, clangorous at first and singing as it fades.',
    tip: 'One note on the downbeat of a section says more than a melody.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          // No musical interval, which is what makes it metal.
          ratio: 3.5,
          index: 1.3,
          bright: env(0.0005, 0.7, 0, 0.6),
          body: env(0.0008, 1.5, 0, 1),
          level: 0.35,
        }),
        room('vca2.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'glockenspiel',
    name: 'Glockenspiel',
    category: 'mallets',
    description: 'Small steel bars, high and glittering.',
    tip: 'Double a melody from another track an octave or two up for sparkle.',
    make: () =>
      build(
        played(8),
        fm({
          base: C6,
          ratio: 2.76,
          index: 0.5,
          bright: env(0.0005, 0.12, 0, 0.1),
          body: env(0.0005, 0.8, 0, 0.5),
          level: 0.35,
        }),
        room('vca2.out', 0.55, 1.6, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'marimba',
    name: 'Marimba',
    category: 'mallets',
    description: 'Warm wooden bars with a soft mallet knock.',
    tip: 'Fast repeated notes are how a marimba sustains: roll them in sixteenths.',
    make: () =>
      build(
        played(8),
        fm({
          base: C3,
          ratio: 4,
          index: 0.8,
          bright: env(0.0005, 0.03, 0, 0.03),
          body: env(0.0008, 0.28, 0, 0.18),
          level: 0.5,
        }),
        room('vca2.out', 0.4, 1, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'vibraphone',
    name: 'Vibraphone',
    category: 'mallets',
    description: 'Metal bars with the motor on: a soft ring with a slow shimmer.',
    tip: 'Jazz chords, held: the tremolo does the moving for you.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 4,
          index: 0.25,
          bright: env(0.0005, 0.15, 0, 0.15),
          body: env(0.0008, 1.4, 0, 0.5),
          level: 0.4,
        }),
        // The motor: every voice dipped in time by one shared LFO.
        units(
          [
            ['lfo1', 'lfo', { rate: 5.5, shape: 3 }],
            ['vca3', 'vca', { level: 0.6, cvAmount: 0.4 }],
          ],
          'vca2.out -> vca3.in',
          'lfo1.out -> vca3.cv',
        ),
        room('vca3.out', 0.55, 1.8, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'steeldrum',
    name: 'Steel drum',
    category: 'mallets',
    description: 'A Caribbean pan: bright and hollow, ringing with its own octave.',
    tip: 'Bouncy calypso rhythms, with the melody doubled in thirds.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 2,
          index: 0.9,
          bright: env(0.0005, 0.12, 0.1, 0.1),
          body: env(0.0008, 0.5, 0, 0.3),
          level: 0.4,
        }),
        room('vca2.out', 0.4, 1, 0.2),
        out(STEREO_OUT),
      ),
  },

  // --- strings and pads ---------------------------------------------------
  {
    id: 'strings',
    name: 'String ensemble',
    category: 'strings',
    description: 'A section of bowed strings swelling in, with vibrato and a wide hall.',
    tip: 'Hold chords for a bar or more and let them overlap: the attack is slow.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 5.2, shape: 2 }],
            ['osc1', 'osc', { pitch: C3 * 0.997, wave: 0, fmAmount: 0.006, level: 0.3, ...env(0.3, 0.5, 1, 0.4) }],
            ['osc2', 'osc', { pitch: C3 * 1.003, wave: 0, fmAmount: 0.006, level: 0.3, ...env(0.3, 0.5, 1, 0.4) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2400, resonance: 0.1, drive: 1, cvAmount: 0.6 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['lfo2', 'lfo', { rate: 0.35, shape: 2 }],
            ['dly1', 'delay', { time: 0.012, cvAmount: 0.35, feedback: 0.15, damping: 0.3, mix: 0.45 }],
          ],
          'lfo1.out -> osc1.fm',
          'lfo1.out -> osc2.fm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          // A slow chorus, which is what turns two oscillators into a section.
          'vca1.out -> dly1.in',
          'lfo2.out -> dly1.cv',
        ),
        room('dly1.out', 0.8, 3.5, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'warmpad',
    name: 'Warm pad',
    category: 'strings',
    description: 'A soft, slow analogue pad that sits under everything.',
    tip: 'Whole-bar chords under a melody. Turn the Space up for more distance.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.3, shape: 2 }],
            ['osc1', 'osc', { pitch: C3 * 1.0015, wave: 1, width: 0.5, level: 0.3, ...env(1.2, 1, 0.85, 0.8) }],
            ['osc2', 'osc', { pitch: C3 * 0.9985, wave: 0, level: 0.25, ...env(1.2, 1, 0.85, 0.8) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 900, resonance: 0.25, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'lfo1.out -> osc1.pwm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.9, 5, 0.45, 0.5),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'glasspad',
    name: 'Glass pad',
    category: 'strings',
    description: 'A bright, crystalline pad whose shimmer blooms in as it is held.',
    tip: 'Leave space between chords; the echoes and the long room fill it.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 3,
          index: 0.9,
          bright: env(1.5, 2, 0.6, 0.9),
          body: env(0.6, 1, 1, 0.9),
          level: 0.55,
          touch: 0.3,
        }),
        units(
          [
            ['osc3', 'osc', { pitch: C5, wave: 2, level: 0.18, ...env(0.6, 1, 1, 0.9) }],
            ['cv1', 'cv', {}],
            ['dly1', 'delay', { time: 0.33, feedback: 0.4, damping: 0.5, mix: 0.25 }],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
          'cv1.sum -> dly1.in',
        ),
        room('dly1.out', 0.95, 7, 0.5),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'evolvingpad',
    name: 'Slow-evolving pad',
    category: 'strings',
    description: 'A dark, restless pad whose filter drifts open and shut on its own.',
    tip: 'Hold one chord for eight bars and listen to it change.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.06, shape: 2 }],
            ['lfo2', 'lfo', { rate: 0.13, shape: 3 }],
            ['osc1', 'osc', { pitch: C3 * 0.9975, wave: 0, level: 0.45, ...env(2, 1, 1, 1.1) }],
            ['osc2', 'osc', { pitch: C3 * 1.0025, wave: 1, width: 0.5, level: 0.45, ...env(2, 1, 1, 1.1) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', { gain1: 1, gain2: 0.5 }],
            ['lpf1', 'ladder', { cutoff: 800, resonance: 0.5, drive: 1.5, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['dly1', 'delay', { time: 0.45, feedback: 0.45, damping: 0.6, mix: 0.3 }],
          ],
          'lfo2.out -> osc2.pwm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lfo1.out -> cv2.in1',
          'key1.pitch -> cv2.in2',
          'cv2.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.95, 8, 0.5, 0.5),
        out(STEREO_OUT),
      ),
  },

  // --- brass and winds ----------------------------------------------------
  {
    id: 'brass',
    name: 'Brass section',
    category: 'brass',
    description: 'A punchy synth brass stab that brightens as it swells.',
    tip: 'Short chord stabs on the off-beat, or a held chord that swells in.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['lfo1', 'lfo', { rate: 5, shape: 2 }],
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, fmAmount: 0.005, level: 0.3, ...env(0.06, 0.3, 0.85, 0.2) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 0, fmAmount: 0.005, level: 0.3, ...env(0.06, 0.3, 0.85, 0.2) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', { gain1: 1.4, gain2: 0.5 }],
            ['lpf1', 'ladder', { cutoff: 350, resonance: 0.15, drive: 1.5, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'lfo1.out -> osc2.fm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'osc1.env -> cv2.in1',
          'key1.pitch -> cv2.in2',
          'cv2.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.5, 1.5, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'trumpet',
    name: 'Trumpet',
    category: 'brass',
    description: 'A solo trumpet line: bright, a little brassy edge, with vibrato.',
    tip: 'Melodies in the middle of the roll; velocity sets how hard it is blown.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 5.5, shape: 2 }],
            ['osc1', 'osc', { pitch: C4, wave: 0, fmAmount: 0.006, level: 0.45, ...env(0.035, 0.25, 0.8, 0.12) }],
            ['cv1', 'cv', { gain1: 1.3, gain2: 0.8 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 800, resonance: 0.2, drive: 1.5, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.env -> cv1.in1',
          'key1.pitch -> cv1.in2',
          'osc1.out -> lpf1.in',
          'cv1.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.45, 1.3, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'horn',
    name: 'French horn',
    category: 'brass',
    description: 'A round, mellow horn, soft at the edges and far away.',
    tip: 'Slow melodies and held fifths; it wants a lot of room.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 0, level: 0.5, ...env(0.12, 0.5, 0.9, 0.35) }],
            ['cv1', 'cv', { gain1: 0.9, gain2: 0.7 }],
            ['lpf1', 'ladder', { cutoff: 280, resonance: 0.05, drive: 1.2, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.env -> cv1.in1',
          'key1.pitch -> cv1.in2',
          'osc1.out -> lpf1.in',
          'cv1.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.8, 2.4, 0.4),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'flute',
    name: 'Flute',
    category: 'brass',
    description: 'A breathy, airy flute with a gentle vibrato.',
    tip: 'High melodies with space between phrases, so the breath can be heard.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 5, shape: 3 }],
            ['osc1', 'osc', { pitch: C4, wave: 2, fmAmount: 0.006, level: 0.4, ...env(0.07, 0.2, 0.9, 0.12) }],
            ['osc2', 'osc', { pitch: C5, wave: 3, fmAmount: 0.006, level: 0.08, ...env(0.07, 0.2, 0.9, 0.12) }],
            ['noise1', 'noise', {}],
            // The breath: noise in a band that follows the note, as loud as
            // the note is.
            ['lpf1', 'ladder', { mode: 2, cutoff: 2000, resonance: 0.2, drive: 1, cvAmount: 1 }],
            ['vca2', 'vca', { level: 0, cvAmount: 0.12 }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'lfo1.out -> osc2.fm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'noise1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'osc1.env -> vca2.cv',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'vca2.out -> cv2.in2',
          'cv2.sum -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.6, 1.8, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'clarinet',
    name: 'Clarinet',
    category: 'brass',
    description: 'A hollow, woody reed: all odd harmonics, dark and smooth.',
    tip: 'Low, lyrical lines. It is at its best in the bottom octave of the roll.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 4.8, shape: 3 }],
            ['osc1', 'osc', { pitch: C3, wave: 1, width: 0.5, fmAmount: 0.004, level: 0.45, ...env(0.04, 0.2, 0.9, 0.1) }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 1100, resonance: 0.15, drive: 1, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.5, 1.4, 0.22),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'panflute',
    name: 'Pan flute',
    category: 'brass',
    description: 'Hollow bamboo pipes, more breath than tone.',
    tip: 'Slow, bending melodies. Overlap notes a little so they breathe into each other.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 4.5, shape: 3 }],
            ['osc1', 'osc', { pitch: C4, wave: 3, fmAmount: 0.006, level: 0.45, ...env(0.08, 0.3, 0.85, 0.15) }],
            ['noise1', 'noise', {}],
            ['lpf1', 'ladder', { mode: 2, cutoff: 1500, resonance: 0.35, drive: 1, cvAmount: 1 }],
            ['vca2', 'vca', { level: 0, cvAmount: 0.35 }],
            ['cv1', 'cv', {}],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'noise1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'osc1.env -> vca2.cv',
          'osc1.out -> cv1.in1',
          'vca2.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.7, 2.2, 0.35),
        out(STEREO_OUT),
      ),
  },

  // --- bass -----------------------------------------------------------------
  {
    id: 'synthbass',
    name: 'Synth bass',
    category: 'bass',
    description: 'The classic analogue bass: a fat saw and square with a plucky filter.',
    tip: 'Eighth-note lines on the root. One voice, so each note takes over from the last.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C1, wave: 0, level: 0.4, ...env(0.002, 0.4, 0.7, 0.08) }],
            ['osc2', 'osc', { pitch: C1, wave: 1, width: 0.5, level: 0.3, ...env(0.002, 0.4, 0.7, 0.08) }],
            ['cv1', 'cv', {}],
            ['env1', 'adsr', { attack: 0.001, decay: 0.25, sustain: 0.1, release: 0.1 }],
            ['cv2', 'cv', { gain1: 1.4, gain2: 0.5 }],
            ['lpf1', 'ladder', { cutoff: 140, resonance: 0.35, drive: 2, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'key1.gate -> env1.gate',
          'env1.out -> cv2.in1',
          'key1.pitch -> cv2.in2',
          'cv2.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },
  {
    id: 'subbass',
    name: 'Sub bass',
    category: 'bass',
    description: 'A deep, clean sine you feel more than hear, with a touch of grit to carry it.',
    tip: 'Long notes under a kick. Check it on headphones; small speakers barely reach it.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C1, wave: 3, level: 0.8, ...env(0.004, 0.3, 0.9, 0.06) }],
            ['drv1', 'drive', { drive: 1.8, level: 0.6 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },
  {
    id: 'acidbass',
    name: 'Acid bass',
    category: 'bass',
    description: 'A squelching, gliding bass: a saw through a filter on the edge of whistling.',
    tip: 'Sixteenth-note patterns with octave jumps; every note slides into the next.',
    make: () =>
      build(
        played(1),
        units(
          [
            // The glide: the pitch is slewed before anything plays it.
            ['slew1', 'slew', { rise: 0.06, fall: 0.06, shape: 0 }],
            ['osc1', 'osc', { pitch: C2, wave: 0, level: 0.5, ...env(0.001, 0.3, 0.8, 0.03) }],
            ['env1', 'adsr', { attack: 0.001, decay: 0.18, sustain: 0, release: 0.05 }],
            ['cv1', 'cv', { gain1: 1.6, gain2: 0.8 }],
            ['lpf1', 'ladder', { cutoff: 220, resonance: 0.78, drive: 3, cvAmount: 2.5 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['drv1', 'drive', { drive: 2.5, level: 0.6 }],
          ],
          'key1.pitch -> slew1.in',
          'slew1.out -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> env1.gate',
          'env1.out -> cv1.in1',
          'slew1.out -> cv1.in2',
          'osc1.out -> lpf1.in',
          'cv1.sum -> lpf1.cv',
          // Velocity after the drive rather than into it: going in, a
          // softer note only distorts less, and comes out nearly as loud.
          'lpf1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },
  {
    id: 'pluckbass',
    name: 'Plucked bass',
    category: 'bass',
    description: 'A fingered electric bass string, round and woody.',
    tip: 'Walking lines in quarter notes; letting go of a key damps the string.',
    make: () =>
      build(
        played(1),
        pluck({ base: C1, wave: 0, strike: 0.008, tone: 900, ring: 1.8, damping: 0.45, release: 0.1 }),
        // A sine under the string, because a string this low has more
        // overtone than fundamental.
        units(
          [
            ['osc3', 'osc', { pitch: C1, wave: 3, level: 0.25, ...env(0.002, 0.8, 0.2, 0.1) }],
            ['cv1', 'cv', {}],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
        ),
        // The pick already follows velocity, but a string this low saturates
        // and the sine under it does not listen: this is what a soft note
        // actually hears.
        units([['vca3', 'vca', { level: 0.25, cvAmount: 0.75 }]], 'cv1.sum -> vca3.in', 'key1.vel -> vca3.cv'),
        out(['mix1', 'mixer', { level1: 1, master: 1 }], 'vca3.out -> mix1.in1'),
      ),
  },
  {
    id: 'fmbass',
    name: 'FM bass',
    category: 'bass',
    description: 'A slapped, popping bass with a bright knock on every note.',
    tip: 'Syncopated funk lines; hit the accents harder in the roll.',
    make: () =>
      build(
        played(1),
        fm({
          base: C1,
          ratio: 1,
          index: 2.2,
          bright: env(0.0005, 0.12, 0.15, 0.08),
          body: env(0.001, 0.9, 0.5, 0.08),
          level: 0.6,
        }),
        out(MONO_OUT, 'vca2.out -> mix1.in1'),
      ),
  },
  {
    id: 'reese',
    name: 'Reese bass',
    category: 'bass',
    description: 'Three detuned saws beating against each other: a dark, moving drone bass.',
    tip: 'Long notes; the beating is the movement. Drum and bass lives here.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C1, wave: 0, level: 0.3, ...env(0.005, 0.3, 1, 0.1) }],
            ['osc2', 'osc', { pitch: C1 * 1.008, wave: 0, level: 0.3, ...env(0.005, 0.3, 1, 0.1) }],
            ['osc3', 'osc', { pitch: C1 * 0.992, wave: 0, level: 0.3, ...env(0.005, 0.3, 1, 0.1) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 500, resonance: 0.15, drive: 2, cvAmount: 0.8 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'key1.gate -> osc3.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'osc3.out -> cv2.in2',
          'cv2.sum -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },

  // --- leads --------------------------------------------------------------
  {
    id: 'squarelead',
    name: 'Square lead',
    category: 'leads',
    description: 'A clean, hollow square wave with vibrato and a short echo.',
    tip: 'Melodies. One voice, so a new note always cuts the last one off.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['lfo1', 'lfo', { rate: 5.5, shape: 2 }],
            ['osc1', 'osc', { pitch: C4, wave: 1, width: 0.5, fmAmount: 0.006, level: 0.4, ...env(0.005, 0.2, 0.85, 0.12) }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 3200, resonance: 0.1, drive: 1, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.3, feedback: 0.3, damping: 0.4, mix: 0.2 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.4, 1.2, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'sawlead',
    name: 'Glide lead',
    category: 'leads',
    description: 'Two fat detuned saws that slide from note to note.',
    tip: 'Big intervals: the glide is the hook. Try a slow melody an octave up.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['slew1', 'slew', { rise: 0.07, fall: 0.07, shape: 0 }],
            ['osc1', 'osc', { pitch: C4 * 0.997, wave: 0, level: 0.3, ...env(0.005, 0.3, 0.9, 0.15) }],
            ['osc2', 'osc', { pitch: C4 * 1.003, wave: 0, level: 0.3, ...env(0.005, 0.3, 0.9, 0.15) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 3800, resonance: 0.25, drive: 1.5, cvAmount: 0.8 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.375, feedback: 0.35, damping: 0.45, mix: 0.22 }],
          ],
          'key1.pitch -> slew1.in',
          'slew1.out -> osc1.pitch',
          'slew1.out -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'slew1.out -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.5, 1.5, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'synclead',
    name: 'Sync lead',
    category: 'leads',
    description: 'A tearing, vocal lead: a hard-synced saw sweeping down on every note.',
    tip: 'Long notes, so the sweep has time to happen. Cuts through any mix.',
    make: () =>
      build(
        played(1),
        units(
          [
            // The master: never heard, only resetting the one that is.
            ['osc1', 'osc', { pitch: C4, wave: 0 }],
            // Its own envelope only sweeps the pitch; Env Amt at zero leaves
            // the level alone for the Envelope below.
            ['osc2', 'osc', { pitch: C4, wave: 0, level: 0.4, envAmount: 0, envPitch: 1.5, attack: 0.001, decay: 0.35, sustain: 0.35, release: 0.2 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 6000, resonance: 0.1, drive: 1, cvAmount: 0.5 }],
            ['env1', 'adsr', { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.15 }],
            ['vca1', 'vca', { level: 0, cvAmount: 1 }],
            ['vca2', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.28, feedback: 0.3, damping: 0.5, mix: 0.18 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'osc1.out -> osc2.sync',
          'key1.gate -> osc2.gate',
          'osc2.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'key1.gate -> env1.gate',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'key1.vel -> vca2.cv',
          'vca2.out -> dly1.in',
        ),
        room('dly1.out', 0.45, 1.3, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'chiplead',
    name: 'Chiptune lead',
    category: 'leads',
    description: 'A thin, buzzy pulse straight out of an old game console.',
    tip: 'Fast melodies and arpeggios; pair it with the Coin and Power-up tutorials.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['lfo1', 'lfo', { rate: 7, shape: 2 }],
            ['osc1', 'osc', { pitch: C4, wave: 1, width: 0.125, fmAmount: 0.005, level: 0.35, ...env(0.001, 0.08, 0.8, 0.03) }],
            ['bits1', 'crush', { bits: 5, rate: 24000, mix: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> bits1.in',
          'bits1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },

  // --- drums ----------------------------------------------------------------
  {
    id: 'kick',
    name: 'Kick',
    category: 'drums',
    description: 'A deep, punchy kick: a sine dropping fast from a click to a boom.',
    tip: 'Four on the floor, one note every beat. Its own track, like every drum here.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.045, sustain: 0, release: 0.045 }],
          ['osc1', 'osc', { pitch: 48, wave: 3, fmAmount: 3, level: 0.9, ...env(0.0005, 0.45, 0, 0.45) }],
          ['drv1', 'drive', { drive: 2.5, level: 0.7 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'gate1.gate -> osc1.gate',
          // The pitch drop, much faster than the note: the click is the
          // first few milliseconds of it.
          'env1.out -> osc1.fm',
          'osc1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'snare',
    name: 'Snare',
    category: 'drums',
    description: 'A tight snare: a short tone for the drum and a burst of noise for the wires.',
    tip: 'Beats two and four.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 190, wave: 2, level: 0.6, envPitch: 0.3, ...env(0.0005, 0.12, 0, 0.12) }],
          ['noise1', 'noise', {}],
          ['lpf1', 'ladder', { mode: 3, cutoff: 1500, resonance: 0.1, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.2, sustain: 0, release: 0.2 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          // The drum and the wires, balanced here so one VCA can play both.
          ['cv1', 'cv', { gain1: 0.75, gain2: 0.69 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env1.gate',
          'noise1.out -> lpf1.in',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'osc1.out -> cv1.in1',
          'vca1.out -> cv1.in2',
          'cv1.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'closedhat',
    name: 'Closed hat',
    category: 'drums',
    description: 'A short, crisp hi-hat tick with a metallic edge.',
    tip: 'Eighths or sixteenths; vary the velocity so it grooves.',
    make: () => hat(0.045),
  },
  {
    id: 'openhat',
    name: 'Open hat',
    category: 'drums',
    description: 'A hi-hat left to sizzle for a moment.',
    tip: 'On the off-beat, on its own track next to the Closed hat.',
    make: () => hat(0.4),
  },
  {
    id: 'clap',
    name: 'Clap',
    category: 'drums',
    description: 'A handclap: a few quick slaps and a short room behind them.',
    tip: 'Beats two and four, on top of or instead of the Snare.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['brst1', 'burst', { count: 3, rate: 90, width: 0.3 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.01, sustain: 0, release: 0.01 }],
          ['env2', 'adsr', { attack: 0.02, decay: 0.18, sustain: 0, release: 0.18 }],
          ['cv1', 'cv', { gain1: 1.6, gain2: 1 }],
          ['noise1', 'noise', {}],
          ['lpf1', 'ladder', { mode: 2, cutoff: 1100, resonance: 0.3, drive: 1, cvAmount: 0 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          ['spc1', 'reverb', { size: 0.3, decay: 0.6, mix: 0.2 }],
          STEREO_OUT,
        ],
        [
          'gate1.gate -> brst1.trig',
          'brst1.gate -> env1.gate',
          'gate1.gate -> env2.gate',
          'env1.out -> cv1.in1',
          'env2.out -> cv1.in2',
          'noise1.out -> lpf1.in',
          'lpf1.out -> vca1.in',
          'cv1.sum -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> spc1.in',
          'spc1.l -> mix1.in1',
          'spc1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'tom',
    name: 'Tom',
    category: 'drums',
    description: 'A round floor tom with a little pitch drop.',
    tip: 'Fills at the end of a phrase. Make a second one with a higher Pitch for a pair.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.12, sustain: 0, release: 0.12 }],
          ['osc1', 'osc', { pitch: 105, wave: 3, fmAmount: 0.7, level: 0.8, ...env(0.0005, 0.5, 0, 0.5) }],
          ['drv1', 'drive', { drive: 1.6, level: 0.8 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'gate1.gate -> osc1.gate',
          'env1.out -> osc1.fm',
          'osc1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'woodblock',
    name: 'Woodblock',
    category: 'drums',
    description: 'A hollow wooden knock, like a rimshot with the metal taken out.',
    tip: 'Syncopated clave patterns: 3-2 over two bars.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 1, wave: 1, width: 0.5, level: 0.8, ...env(0.0005, 0.002, 0, 0.002) }],
          ['res1', 'res', { pitch: 780, decay: 0.07, damping: 0.2 }],
          ['drv1', 'drive', { drive: 1.5, level: 0.8 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'osc1.out -> res1.in',
          'res1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'cowbell',
    name: 'Cowbell',
    category: 'drums',
    description: 'The drum-machine cowbell: two square waves a fifth-and-a-bit apart.',
    tip: 'Sparingly. Then more.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 540, wave: 1, level: 0.5 }],
          ['osc2', 'osc', { pitch: 800, wave: 1, level: 0.5 }],
          ['cv1', 'cv', {}],
          ['lpf1', 'ladder', { mode: 2, cutoff: 1800, resonance: 0.35, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.05, sustain: 0, release: 0.05 }],
          ['env2', 'adsr', { attack: 0.0005, decay: 0.35, sustain: 0, release: 0.35 }],
          ['cv2', 'cv', { gain1: 0.7, gain2: 0.35 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'gate1.gate -> env1.gate',
          'gate1.gate -> env2.gate',
          'env1.out -> cv2.in1',
          'env2.out -> cv2.in2',
          'lpf1.out -> vca1.in',
          'cv2.sum -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'shaker',
    name: 'Shaker',
    category: 'drums',
    description: 'A soft rattle of seeds, swelling in rather than struck.',
    tip: 'Straight sixteenths with every other one quieter.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', {}],
          ['lpf1', 'ladder', { mode: 3, cutoff: 5500, resonance: 0.1, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.018, decay: 0.07, sustain: 0, release: 0.07 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'noise1.out -> lpf1.in',
          'gate1.gate -> env1.gate',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'crash',
    name: 'Crash',
    category: 'drums',
    description: 'A crash cymbal washing out over a couple of seconds.',
    tip: 'On the first beat of a new section, and nowhere else.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', {}],
          ['osc1', 'osc', { pitch: 400, wave: 1 }],
          ['osc2', 'osc', { pitch: 590, wave: 1 }],
          ['ring1', 'ring', { mix: 1 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.5 }],
          ['lpf1', 'ladder', { mode: 3, cutoff: 3500, resonance: 0.1, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.8, sustain: 0, release: 0.8 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          ['spc1', 'reverb', { size: 0.6, decay: 2.5, mix: 0.25 }],
          STEREO_OUT,
        ],
        [
          'osc1.out -> ring1.in',
          'osc2.out -> ring1.car',
          'noise1.out -> cv1.in1',
          'ring1.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'gate1.gate -> env1.gate',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> spc1.in',
          'spc1.l -> mix1.in1',
          'spc1.r -> mix1.in2',
        ],
      ),
  },
]

/**
 * A hi-hat, open or closed by how long it lasts: noise and a ring-modulated
 * pair of squares for the metal, high-passed, through a short envelope.
 */
function hat(length: number): Built {
  return rack(
    [
      ['gate1', 'gate'],
      ['noise1', 'noise', {}],
      ['osc1', 'osc', { pitch: 317, wave: 1 }],
      ['osc2', 'osc', { pitch: 540, wave: 1 }],
      ['ring1', 'ring', { mix: 1 }],
      ['cv1', 'cv', { gain1: 1, gain2: 0.6 }],
      ['lpf1', 'ladder', { mode: 3, cutoff: 7500, resonance: 0.25, drive: 1, cvAmount: 0 }],
      ['env1', 'adsr', { attack: 0.0005, decay: length, sustain: 0, release: length }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
      ['vca2', 'vca', TOUCH],
      MONO_OUT,
    ],
    [
      'osc1.out -> ring1.in',
      'osc2.out -> ring1.car',
      'noise1.out -> cv1.in1',
      'ring1.out -> cv1.in2',
      'cv1.sum -> lpf1.in',
      'gate1.gate -> env1.gate',
      'lpf1.out -> vca1.in',
      'env1.out -> vca1.cv',
      'vca1.out -> vca2.in',
      'gate1.vel -> vca2.cv',
      'vca2.out -> mix1.in1',
    ],
  )
}
