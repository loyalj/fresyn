import { rack, type Built, type Unit } from './build'
import { DEFAULT_KIT, padPatch, setKitSlot } from './kit'
import { KITS, kitShell, type KitDef, type KitPad } from './kits'

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
 * hits in the roll, which is what a kick or a hat is. The sound effects and
 * the ambience are built the same way: their pitch is part of their design,
 * and a game fires them rather than playing them.
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
  | 'sfx'
  | 'ambience'

export interface Instrument {
  id: string
  name: string
  category: InstrumentCategory
  /**
   * A heading within its shelf, for a shelf long enough to want one: each
   * kit's own drums sit under the kit's name.
   */
  group?: string
  /** What it sounds like, in one line, for the list. */
  description: string
  /** One thing worth doing with it, for the list's second line. */
  tip: string
  /**
   * It sounds for as long as its note is held, rather than being fired and
   * left to finish: a loop, a hum, an alarm. Says so on its badge.
   */
  held?: true
  make(): Built
}

// --- building ------------------------------------------------------------

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
    id: 'drumkit',
    name: 'Drum Kit',
    category: 'drums',
    description: 'Sixteen of the drums on this shelf in one rack, on the notes General MIDI puts them on.',
    tip: 'A whole beat on one track: each row of the roll is a pad. Space plays the kick.',
    make: () => {
      const built = rack([['gate1', 'gate'], ['kit1', 'kit']], ['gate1.gate -> kit1.trig1'])
      let patch = built.patch
      const values = { ...built.values }
      DEFAULT_KIT.forEach((pad, i) => {
        // Looked up when the kit is made rather than when this list is: the
        // drums it holds are further down the same list.
        const inst = INSTRUMENTS.find((x) => x.id === pad.instrument)
        if (!inst) throw new Error(`the standard kit wants "${pad.instrument}", which is not on the shelf`)
        const b = inst.make()
        patch = setKitSlot(patch, 'kit1', i, { name: inst.name, note: pad.note, patch: padPatch(b.patch, b.values) })
        if (pad.choke) values[`kit1.choke${i + 1}`] = pad.choke
      })
      return { patch, values }
    },
  },
  ...KITS.map(kitInstrument),
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
          // A click, not a note: two milliseconds of a pulse this slow is a
          // single step. The bottom of the knob, which the panel can show.
          ['osc1', 'osc', { pitch: 2, wave: 1, width: 0.5, level: 0.8, ...env(0.0005, 0.002, 0, 0.002) }],
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

  // --- more voices, on the new modules ---------------------------------------
  {
    id: 'stringmachine',
    name: 'String machine',
    category: 'strings',
    description: 'The 70s string ensemble: detuned saws and an octave, made lush by a chorus.',
    tip: 'Sustained chords, high up. The Chorus is the instrument -- bypass it to hear why.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.996, wave: 0, level: 0.3, ...env(0.12, 0.5, 1, 0.6) }],
            ['osc2', 'osc', { pitch: C3 * 1.004, wave: 0, level: 0.3, ...env(0.12, 0.5, 1, 0.6) }],
            // The 4': an octave up, quieter, which is what makes it a machine
            // rather than a section.
            ['osc3', 'osc', { pitch: C3 * 2, wave: 0, level: 0.15, ...env(0.12, 0.5, 1, 0.6) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 3200, resonance: 0.05, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            // Gentle: a chorus sweeps its delay, and a fast deep sweep is a
            // pitch wobble. This much is width, not seasickness.
            ['cho1', 'chorus', { mode: 0, rate: 0.5, depth: 0.3, center: 0.35, feedback: 0.15, mix: 0.5 }],
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
          'vca1.out -> cho1.in',
        ),
        out(STEREO_OUT, 'cho1.l -> mix1.in1', 'cho1.r -> mix1.in2'),
      ),
  },
  {
    id: 'phaserep',
    name: 'Phaser electric piano',
    category: 'keys',
    description: 'The tine piano through a slow phaser: the swirl of every 70s ballad and jazz-funk record.',
    tip: 'Slow the Chorus Rate right down for a sweep that lasts a whole phrase.',
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
        units(
          [
            ['osc3', 'osc', { pitch: C3 * 14, wave: 3, level: 0.05, ...env(0.0005, 0.12, 0, 0.05) }],
            ['cv1', 'cv', {}],
            ['cho1', 'chorus', { mode: 2, rate: 0.35, depth: 0.7, center: 0.45, feedback: 0.45, mix: 0.5 }],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
          'cv1.sum -> cho1.in',
        ),
        out(STEREO_OUT, 'cho1.l -> mix1.in1', 'cho1.r -> mix1.in2'),
      ),
  },
  {
    id: 'tubepluck',
    name: 'Tube pluck',
    category: 'plucked',
    description: 'A plucked metal tube: a click rung by a comb filter that plays in tune.',
    tip: 'Switch the Multimode Filter to comb− for a hollow, woodwind-like pluck an octave down.',
    make: () =>
      build(
        played(6),
        units(
          [
            // The pick: a click at the note's own pitch, so the comb is struck
            // with the harmonics it rings at.
            ['osc1', 'osc', { pitch: C3, wave: 1, level: 0.8, ...env(0.0005, 0.004, 0, 0.004) }],
            ['vca1', 'vca', { level: 0.2, cvAmount: 0.8 }],
            // The tube: a comb tuned by the Keyboard, one octave per unit.
            ['mmf1', 'svf', { mode: 5, cutoff: C3, resonance: 0.93, cvAmount: 1 }],
            ['env1', 'adsr', { attack: 0.0005, decay: 0.01, sustain: 1, release: 0.35 }],
            ['vca2', 'vca', { level: 0, cvAmount: 1 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> mmf1.in',
          'key1.pitch -> mmf1.cv',
          'key1.gate -> env1.gate',
          'mmf1.out -> vca2.in',
          'env1.out -> vca2.cv',
        ),
        room('vca2.out', 0.4, 1.2, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'adaptivedrone',
    name: 'Adaptive drone',
    category: 'strings',
    description: 'A pad whose Macro takes it from calm to dread: brighter, grittier, shakier, and a tritone creeping in.',
    tip: 'Macro Amount is the tension. From a game, setParam(track, \'mac1.amount\', danger) and the score follows.',
    make: () =>
      build(
        played(6),
        units(
          [
            // Four lanes of one mood: 1 opens the filter; 2, from half way,
            // adds drive; 3 fades in a vibrato, so calm is steady and dread
            // shakes; 4, only near the top, brings in a tritone above.
            ['mac1', 'macro', { amount: 0.25, curve1: 0.3, start2: 0.5, start3: 0.3, start4: 0.7 }],
            ['lfo1', 'lfo', { rate: 5.5, shape: 3, depth: 1 }],
            ['vca4', 'vca', { level: 0, cvAmount: 1 }],
            ['osc1', 'osc', { pitch: C2 * 0.997, wave: 0, fmAmount: 0.03, level: 0.35, ...env(0.6, 0.5, 1, 1.2) }],
            ['osc2', 'osc', { pitch: C2 * 1.003, wave: 0, fmAmount: 0.03, level: 0.35, ...env(0.6, 0.5, 1, 1.2) }],
            ['osc3', 'osc', { pitch: C2 * Math.SQRT2, wave: 0, level: 0.3, ...env(0.6, 0.5, 1, 1.2) }],
            ['cv1', 'cv', {}],
            ['vca3', 'vca', { level: 0, cvAmount: 1 }],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 400, resonance: 0.3, drive: 1, cvAmount: 3 }],
            ['drv1', 'drive', { drive: 1, level: 0.7, cvAmount: 3 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'key1.gate -> osc3.gate',
          'lfo1.out -> vca4.in',
          'mac1.out3 -> vca4.cv',
          'vca4.out -> osc1.fm',
          'vca4.out -> osc2.fm',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'osc3.out -> vca3.in',
          'mac1.out4 -> vca3.cv',
          'cv1.sum -> cv2.in1',
          'vca3.out -> cv2.in2',
          'cv2.sum -> lpf1.in',
          'mac1.out1 -> lpf1.cv',
          'lpf1.out -> drv1.in',
          'mac1.out2 -> drv1.cv',
          'drv1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },

  // --- keys, continued ------------------------------------------------------
  {
    id: 'reedpiano',
    name: 'Reed piano',
    category: 'keys',
    description: 'A struck-reed electric piano: a soft bell that growls when hit hard, with tremolo.',
    tip: 'Dig in on the accents: velocity is what turns the glow into a bark.',
    make: () =>
      build(
        played(8),
        fm({
          base: C3,
          ratio: 1,
          index: 1.7,
          bright: env(0.0005, 0.25, 0.05, 0.15),
          body: env(0.001, 1.2, 0, 0.25),
          level: 0.4,
          touch: 0.85,
        }),
        units(
          [
            // Tremolo: the amplifier's, a gentle pulse in level.
            ['lfo1', 'lfo', { rate: 5.2, shape: 3, depth: 1 }],
            ['vca3', 'vca', { level: 0.75, cvAmount: 0.25 }],
            ['drv1', 'drive', { drive: 1.6, level: 0.8 }],
          ],
          'vca2.out -> vca3.in',
          'lfo1.uni -> vca3.cv',
          'vca3.out -> drv1.in',
        ),
        room('drv1.out', 0.35, 1.1, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'accordion',
    name: 'Accordion',
    category: 'keys',
    description: 'Reeds and bellows: a buzzy, beating squeezebox with the musette shimmer.',
    tip: 'Waltzes and sea shanties -- oom-pah chords under a held melody.',
    make: () =>
      build(
        played(8),
        units(
          [
            // Two reeds a few cents apart, which is what musette tuning is.
            ['osc1', 'osc', { pitch: C3 * 0.997, wave: 1, width: 0.4, level: 0.25, ...env(0.03, 0.3, 1, 0.08) }],
            ['osc2', 'osc', { pitch: C3 * 1.003, wave: 1, width: 0.4, level: 0.25, ...env(0.03, 0.3, 1, 0.08) }],
            ['osc3', 'osc', { pitch: C3 * 2, wave: 0, level: 0.1, ...env(0.03, 0.3, 1, 0.08) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { mode: 1, cutoff: 2200, resonance: 0.1, drive: 1, cvAmount: 0.7 }],
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
        room('vca1.out', 0.4, 1.2, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'toypiano',
    name: 'Toy piano',
    category: 'keys',
    description: 'Little metal rods struck by hammers: bright, plinky and slightly out of this world.',
    tip: 'Simple tunes high up. It is funniest played completely straight.',
    make: () =>
      build(
        played(8),
        // The rods ring at partials no string has, which is the toy.
        fm({
          base: C4,
          ratio: 3.6,
          index: 0.9,
          bright: env(0.0005, 0.08, 0, 0.05),
          body: env(0.0005, 0.55, 0, 0.25),
          level: 0.45,
        }),
        room('vca2.out', 0.3, 0.9, 0.15),
        out(STEREO_OUT),
      ),
  },

  // --- plucked, continued ---------------------------------------------------
  {
    id: 'steelguitar',
    name: 'Steel-string guitar',
    category: 'plucked',
    description: 'A bright acoustic guitar with steel strings: crisp pick, long shimmering ring.',
    tip: 'Strum a chord by staggering its notes a few ticks apart in the roll.',
    make: () =>
      build(
        played(6),
        pluck({ base: C3, wave: 0, strike: 0.006, tone: 3500, ring: 2.5, damping: 0.25, release: 0.3 }),
        room('vca2.out', 0.4, 1.2, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'banjo',
    name: 'Banjo',
    category: 'plucked',
    description: 'A twangy, snappy banjo: a thin, bright pick and a short, drum-headed ring.',
    tip: 'Fast rolling arpeggios -- three notes over and over, a sixteenth apart.',
    make: () =>
      build(
        played(6),
        pluck({ base: C3, wave: 1, width: 0.2, strike: 0.003, tone: 5500, ring: 0.5, damping: 0.15, release: 0.1 }),
        // The head: a short bright resonance under every note.
        units([['mmf1', 'svf', { mode: 4, cutoff: 1800, resonance: 0.5, cvAmount: 0 }]], 'vca2.out -> mmf1.in'),
        room('mmf1.out', 0.3, 0.8, 0.12),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'sitar',
    name: 'Sitar',
    category: 'plucked',
    description: 'A long-ringing string with the sitar\'s buzzing bridge folding extra harmonics in.',
    tip: 'Slow melodies over a drone: hold a low C on another track underneath.',
    make: () =>
      build(
        played(4),
        pluck({ base: C3, wave: 0, strike: 0.004, tone: 4000, ring: 3, damping: 0.1, release: 0.5 }),
        // The jawari: the flat bridge the string buzzes against, as a fold.
        units([['fold1', 'fold', { fold: 2.2, symmetry: 0.3 }], ['vca3', 'vca', { level: 0.55, cvAmount: 0 }]], 'vca2.out -> fold1.in', 'fold1.out -> vca3.in'),
        room('vca3.out', 0.5, 1.6, 0.22),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'mutedguitar',
    name: 'Muted guitar',
    category: 'plucked',
    description: 'Palm-muted electric guitar: a dull, percussive chug that stops almost at once.',
    tip: 'Eighth-note chugs on one low note under a busier part.',
    make: () =>
      build(
        played(6),
        pluck({ base: C3, wave: 0, strike: 0.004, tone: 1500, ring: 0.15, damping: 0.6, release: 0.05 }),
        units([['drv1', 'drive', { drive: 2.5, level: 0.6 }]], 'vca2.out -> drv1.in'),
        out(MONO_OUT, 'drv1.out -> mix1.in1'),
      ),
  },

  // --- bells & mallets, continued -------------------------------------------
  {
    id: 'xylophone',
    name: 'Xylophone',
    category: 'mallets',
    description: 'Hard rosewood bars: a dry, bright knock, gone almost as soon as it is struck.',
    tip: 'Quick runs and repeated notes. Nothing sustains, so fill the time.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 3,
          index: 0.6,
          bright: env(0.0005, 0.02, 0, 0.02),
          body: env(0.0005, 0.15, 0, 0.1),
          level: 0.55,
        }),
        room('vca2.out', 0.35, 0.9, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'celesta',
    name: 'Celesta',
    category: 'mallets',
    description: 'Hammers on steel plates over wooden resonators: sweet, soft and twinkling.',
    tip: 'Delicate melodies an octave above everything else. The sugar-plum sound.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 1,
          index: 0.35,
          bright: env(0.0005, 0.2, 0, 0.1),
          body: env(0.0008, 0.8, 0, 0.3),
          level: 0.45,
        }),
        // A twinkle two octaves up that fades first.
        units(
          [
            ['osc3', 'osc', { pitch: C4 * 4, wave: 3, level: 0.06, ...env(0.0005, 0.15, 0, 0.05) }],
            ['cv1', 'cv', {}],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
        ),
        room('cv1.sum', 0.45, 1.4, 0.22),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'handbell',
    name: 'Handbell',
    category: 'mallets',
    description: 'A choir handbell: a round tone with a bright, clanging hum that rings on.',
    tip: 'One note per beat, letting each ring into the next. Christmas, instantly.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 2.4,
          index: 1.2,
          bright: env(0.0005, 0.5, 0, 0.4),
          body: env(0.001, 1.2, 0, 0.8),
          level: 0.35,
        }),
        room('vca2.out', 0.7, 2.2, 0.28),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'gamelan',
    name: 'Gamelan',
    category: 'mallets',
    description: 'A bronze metallophone: inharmonic, shimmering, beating slowly as it rings.',
    tip: 'Interlocking patterns: two tracks, each playing the notes the other leaves out.',
    make: () =>
      build(
        played(8),
        fm({
          base: C3,
          ratio: 1.41,
          index: 1.3,
          bright: env(0.0005, 0.3, 0, 0.3),
          body: env(0.0005, 1.1, 0, 0.6),
          level: 0.4,
        }),
        // The ombak: a partner tuned a few hertz sharp, heard as a slow beat.
        units(
          [
            ['osc3', 'osc', { pitch: C3 * 1.02, wave: 3, level: 0.12, ...env(0.0005, 1.1, 0, 0.6) }],
            ['cv1', 'cv', {}],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
        ),
        room('cv1.sum', 0.6, 2, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'singingbowl',
    name: 'Singing bowl',
    category: 'mallets',
    description: 'A struck meditation bowl: a pure tone with a slow, wavering shimmer above it.',
    tip: 'One note, and wait. Leave it bars of room.',
    make: () =>
      build(
        played(4),
        fm({
          base: C3,
          ratio: 2.71,
          index: 0.55,
          bright: env(0.002, 1.2, 0, 1),
          body: env(0.002, 1.3, 0, 1.2),
          level: 0.45,
          touch: 0.5,
        }),
        room('vca2.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },

  // --- strings & pads, continued --------------------------------------------
  {
    id: 'cello',
    name: 'Solo cello',
    category: 'strings',
    description: 'A single bowed cello: a rich saw through a wooden body, vibrato and all.',
    tip: 'Slow, singing lines low in the roll. One voice, so each note bows over the last.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['lfo1', 'lfo', { rate: 5, shape: 3 }],
            ['osc1', 'osc', { pitch: C2, wave: 0, fmAmount: 0.008, level: 0.45, ...env(0.09, 0.3, 0.9, 0.2) }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 1100, resonance: 0.1, drive: 1.2, cvAmount: 0.8 }],
            // The body: a broad wooden resonance.
            ['mmf1', 'svf', { mode: 4, cutoff: 420, resonance: 0.45, cvAmount: 0 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> mmf1.in',
          'mmf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.7, 2.4, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'choir',
    name: 'Choir',
    category: 'strings',
    description: 'A soft choir singing "aah": sung voices through a mouth, thickened into a section.',
    tip: 'Held chords behind everything. Change the Formant\'s Vowel for "ooh" or "eeh".',
    make: () =>
      build(
        played(6),
        units(
          [
            // Gated: the Voice's default is a drone, which a keyboard cannot stop.
            ['voice1', 'voice', { pitch: C3, mode: 1, tone: 0.45, breath: 0.2, jitter: 0.02, vibDepth: 0.08, vibRate: 5, attack: 0.25, release: 0.5, level: 0.8 }],
            ['fmt1', 'formant', { vowel: 2, size: 1, res: 0.55 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['cho1', 'chorus', { mode: 0, rate: 0.35, depth: 0.3, center: 0.4, feedback: 0.1, mix: 0.5 }],
          ],
          'key1.pitch -> voice1.pitch',
          'key1.gate -> voice1.gate',
          'voice1.out -> fmt1.in',
          'fmt1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> cho1.in',
        ),
        {
          units: [['spc1', 'reverb', { size: 0.85, decay: 3, damping: 0.4, mix: 0.3 }] as Unit],
          cables: ['cho1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },
  {
    id: 'sweeppad',
    name: 'Sweep pad',
    category: 'strings',
    description: 'A resonant analogue pad whose filter slowly opens and closes on its own.',
    tip: 'Whole chords held for several bars, so the sweep has time to travel.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.997, wave: 0, level: 0.3, ...env(0.4, 0.5, 1, 0.8) }],
            ['osc2', 'osc', { pitch: C3 * 1.003, wave: 0, level: 0.3, ...env(0.4, 0.5, 1, 0.8) }],
            ['cv1', 'cv', {}],
            ['lfo1', 'lfo', { rate: 0.08, shape: 2, depth: 1 }],
            ['lpf1', 'ladder', { cutoff: 700, resonance: 0.55, drive: 1.2, cvAmount: 2 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lfo1.out -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'shimmerpad',
    name: 'Shimmer pad',
    category: 'strings',
    description: 'A soft pad with a sparkling halo an octave above, scattered by a granulator.',
    tip: 'Sparse chords with long gaps. The halo keeps glittering after the chord ends.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 2, level: 0.45, ...env(0.5, 0.5, 1, 0.9) }],
            ['osc2', 'osc', { pitch: C3 * 2, wave: 3, level: 0.2, ...env(0.5, 0.5, 1, 0.9) }],
            ['cv1', 'cv', {}],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['gran1', 'gran', { size: 0.12, density: 30, position: 0.2, spray: 0.5, pitch: 1, spread: 0.9, mix: 0.35 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> gran1.in',
        ),
        {
          units: [['spc1', 'reverb', { size: 0.9, decay: 3.2, damping: 0.3, mix: 0.35 }] as Unit],
          cables: ['gran1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },

  // --- more strings ---------------------------------------------------------
  {
    id: 'violin',
    name: 'Solo violin',
    category: 'strings',
    description: 'A single violin: bright and singing, with vibrato that blooms as the note is held.',
    tip: 'Melodies high in the roll. One voice, so a new note bows on from the last.',
    make: () =>
      build(
        played(1),
        bowed({ base: C4, cutoff: 2600, body: 900, bodyRes: 0.4, attack: 0.08, vibRate: 5.8, vibDepth: 0.006, vibIn: 0.5 }),
        room('vca1.out', 0.7, 2.2, 0.28),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'viola',
    name: 'Viola',
    category: 'strings',
    description: 'Darker and more nasal than the violin: the voice in the middle of the strings.',
    tip: 'Inner lines and counter-melodies between a violin and a cello.',
    make: () =>
      build(
        played(1),
        bowed({ base: C3, cutoff: 1700, body: 620, bodyRes: 0.55, attack: 0.1, vibRate: 5.3, vibDepth: 0.006, vibIn: 0.6 }),
        room('vca1.out', 0.7, 2.4, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'contrabass',
    name: 'Contrabass',
    category: 'strings',
    description: 'A bowed double bass: a slow, rough start, rosin and all, and a deep wooden body.',
    tip: 'Long low notes under the orchestra. One voice, low in the roll.',
    make: () =>
      build(
        played(1),
        bowed({ base: C1, cutoff: 700, body: 160, bodyRes: 0.4, attack: 0.18, vibRate: 4.5, vibDepth: 0.004, vibIn: 0.8, rosin: 0.25 }),
        room('vca1.out', 0.6, 2, 0.22),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'fiddle',
    name: 'Fiddle',
    category: 'strings',
    description: 'A folk fiddle: brighter and scratchier than the violin, quick off the bow.',
    tip: 'Reels and jigs: fast runs of short notes. Velocity is how hard the bow digs in.',
    make: () =>
      build(
        played(1),
        bowed({ base: C4, cutoff: 3600, body: 1100, bodyRes: 0.35, attack: 0.025, vibRate: 6, vibDepth: 0.003, vibIn: 0.2, rosin: 0.35, grit: 2.2 }),
        room('vca1.out', 0.5, 1.4, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'erhu',
    name: 'Erhu',
    category: 'strings',
    description: 'The Chinese two-string fiddle: nasal and singing, sliding up into every note.',
    tip: 'Slow, expressive melodies on a pentatonic scale. Leave space for each slide.',
    make: () =>
      build(
        played(1),
        bowed({ base: C4, cutoff: 3000, body: 1500, bodyRes: 0.65, attack: 0.06, vibRate: 5.5, vibDepth: 0.009, vibIn: 0.3, slide: 0.12 }),
        room('vca1.out', 0.7, 2.4, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'lowstrings',
    name: 'Low strings',
    category: 'strings',
    description: 'Celli and basses together: dark, heavy and wide.',
    tip: 'Drones, pedal notes and slow bass lines under a cinematic cue.',
    make: () =>
      build(
        played(6),
        section({ base: C2, detune: 0.0012, cutoff: 900, body: 300, attack: 0.25, release: 0.5 }),
        room('dly1.out', 0.85, 3.5, 0.32),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'highstrings',
    name: 'High strings',
    category: 'strings',
    description: 'Violins in divisi, high and airy, swelling in slowly with a shimmer on top.',
    tip: 'Sustained chords up high over everything. Changes of one note at a time sound best.',
    make: () =>
      build(
        played(8),
        section({ base: C4, detune: 0.0035, cutoff: 4200, body: 1200, attack: 0.6, release: 0.8, level: 0.85 }),
        room('dly1.out', 0.95, 5, 0.42),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'tremolostrings',
    name: 'Tremolo strings',
    category: 'strings',
    description: 'A section shaking its bows: a nervous flutter on every note.',
    tip: 'Suspense and horror: hold a chord, or creep up one semitone at a time.',
    make: () =>
      build(
        played(8),
        section({ base: C3, detune: 0.003, cutoff: 2600, body: 700, attack: 0.08, release: 0.4, level: 0.95 }),
        units(
          [
            ['lfo3', 'lfo', { rate: 13, shape: 2 }],
            ['vca2', 'vca', { level: 0.25, cvAmount: 0.75 }],
          ],
          'dly1.out -> vca2.in',
          'lfo3.uni -> vca2.cv',
        ),
        room('vca2.out', 0.8, 2.8, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'staccatostrings',
    name: 'Staccato strings',
    category: 'strings',
    description: 'Short, punchy section stabs for driving ostinatos: every note is clipped, however long.',
    tip: 'Eighth or sixteenth notes repeating under an action cue. Accent the downbeats.',
    make: () =>
      build(
        played(8),
        section({ base: C3, detune: 0.0015, cutoff: 3200, body: 800, attack: 0.008, release: 0.15, decay: 0.15, sustain: 0, level: 1 }),
        room('dly1.out', 0.6, 1.6, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'swellstrings',
    name: 'Swell strings',
    category: 'strings',
    description: 'Each note starts from nothing and grows to full over two seconds, opening as it comes.',
    tip: 'Builds into a drop or a new section. Start the chord a bar before it arrives.',
    make: () =>
      build(
        played(8),
        section({ base: C3, detune: 0.003, cutoff: 900, body: 700, attack: 2, release: 0.6, open: 2, level: 1.4 }),
        room('dly1.out', 0.85, 3.5, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'ponticello',
    name: 'Sul ponticello',
    category: 'strings',
    description: 'Bowed right by the bridge: glassy, thin and eerie, all upper harmonics.',
    tip: 'Ghostly held chords under a quiet, uneasy scene.',
    make: () =>
      build(
        played(8),
        section({ base: C3, detune: 0.004, cutoff: 6000, body: 2800, bodyRes: 0.6, attack: 0.15, release: 0.5, thin: 900, level: 1 }),
        room('dly1.out', 0.85, 3.5, 0.38),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'harmonics',
    name: 'String harmonics',
    category: 'strings',
    description: 'Flute-like harmonics, a finger barely touching the string: pure, high and ghostly.',
    tip: 'A few high notes, held, over a quiet passage.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['lfo1', 'lfo', { rate: 5, shape: 3 }],
            ['osc1', 'osc', { pitch: C4, wave: 3, fmAmount: 0.003, level: 0.45, ...env(0.25, 1, 1, 0.7) }],
            ['osc2', 'osc', { pitch: C4 * 2, wave: 3, fmAmount: 0.003, level: 0.08, ...env(0.25, 1, 1, 0.7) }],
            ['noise1', 'noise', { color: 0.7 }],
            ['bpf1', 'svf', { mode: 1, cutoff: 2000, resonance: 0.5, cvAmount: 1 }],
            ['env1', 'adsr', { attack: 0.25, decay: 1, sustain: 1, release: 0.7 }],
            ['vca1', 'vca', { level: 0, cvAmount: 0.06 }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'lfo1.out -> osc1.fm',
          'lfo1.out -> osc2.fm',
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          // The bow's whisper, at the note: a breath around it.
          'noise1.out -> bpf1.in',
          'key1.pitch -> bpf1.cv',
          'bpf1.out -> vca1.in',
          'key1.gate -> env1.gate',
          'env1.out -> vca1.cv',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'vca1.out -> cv2.in2',
          'cv2.sum -> vca2.in',
          'key1.vel -> vca2.cv',
        ),
        room('vca2.out', 0.9, 4, 0.4),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'tapestrings',
    name: 'Tape strings',
    category: 'strings',
    description: 'A string sample on a wobbling tape, the way a Mellotron plays it: lo-fi, and it runs out after eight seconds.',
    tip: 'Psychedelic and 60s chords. Like the real thing, a held note fades as its tape ends.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, level: 0.3, ...env(0.12, 3, 0, 0.3) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 0, level: 0.3, ...env(0.12, 3, 0, 0.3) }],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2200, resonance: 0.15, drive: 1.3, cvAmount: 0.5 }],
            ['mmf1', 'svf', { mode: 4, cutoff: 700, resonance: 0.35, cvAmount: 0 }],
            ['vca1', 'vca', { level: 0.38, cvAmount: 0.5 }],
            // The tape the strings were recorded on: its wow and flutter.
            ['tape1', 'tape', { drive: 0.3, wow: 0.5, flutter: 0.45, age: 0.5, hiss: 0 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv2.in1',
          'osc2.out -> cv2.in2',
          'cv2.sum -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> mmf1.in',
          'mmf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> tape1.in',
        ),
        room('tape1.out', 0.5, 1.5, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'octavestrings',
    name: 'Octave strings',
    category: 'strings',
    description: 'A section doubled an octave below and above: one huge unison line.',
    tip: 'An epic melody, one note at a time; chords get very thick very fast.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 5.2, shape: 2 }],
            ['osc1', 'osc', { pitch: C2, wave: 0, fmAmount: 0.005, level: 0.3, ...env(0.2, 0.5, 1, 0.5) }],
            ['osc2', 'osc', { pitch: C3 * 1.003, wave: 0, fmAmount: 0.005, level: 0.3, ...env(0.2, 0.5, 1, 0.5) }],
            ['osc3', 'osc', { pitch: C4 * 0.997, wave: 0, fmAmount: 0.005, level: 0.22, ...env(0.2, 0.5, 1, 0.5) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2800, resonance: 0.1, drive: 1, cvAmount: 0.5 }],
            ['mmf1', 'svf', { mode: 4, cutoff: 500, resonance: 0.35, cvAmount: 0 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['lfo2', 'lfo', { rate: 0.35, shape: 2 }],
            ['dly1', 'delay', { time: 0.012, cvAmount: 0.35, feedback: 0.15, damping: 0.3, mix: 0.45 }],
          ],
          'lfo1.out -> osc1.fm',
          'lfo1.out -> osc2.fm',
          'lfo1.out -> osc3.fm',
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
          'lpf1.out -> mmf1.in',
          'mmf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
          'lfo2.out -> dly1.cv',
        ),
        room('dly1.out', 0.95, 4.5, 0.38),
        out(STEREO_OUT),
      ),
  },

  // --- more pads ------------------------------------------------------------
  {
    id: 'obpad',
    name: 'OB brass pad',
    category: 'strings',
    description: 'The big 80s synth pad: two detuned saws whose filter swells open as the chord is held.',
    tip: 'Synth-pop chords on the bar. Velocity opens the filter further.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, level: 0.3, ...env(0.4, 1, 0.9, 0.8) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 0, level: 0.3, ...env(0.4, 1, 0.9, 0.8) }],
            ['cv1', 'cv', {}],
            ['env1', 'adsr', { attack: 0.9, decay: 1.5, sustain: 0.55, release: 0.9 }],
            ['cv2', 'cv', { gain1: 1, gain2: 0.4 }],
            ['lpf1', 'ladder', { cutoff: 450, resonance: 0.2, drive: 1.3, cvAmount: 2.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
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
        room('vca1.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'junopad',
    name: 'Juno pad',
    category: 'strings',
    description: 'One pulse wave whose width breathes, spread wide by a stereo chorus: thin, warm and nostalgic.',
    tip: 'Slow chords in an 80s ballad, or held under a drum machine.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.6, shape: 2 }],
            ['osc1', 'osc', { pitch: C3, wave: 1, width: 0.5, level: 0.4, ...env(0.35, 1, 1, 0.9) }],
            ['lpf1', 'ladder', { cutoff: 1800, resonance: 0.15, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'lfo1.out -> osc1.pwm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        wide('vca1.out', { mode: 0, rate: 0.5, depth: 0.6, center: 0.5, feedback: 0, mix: 0.5 }, 0.6, 2.2),
        out(wideOut(0.15)),
      ),
  },
  {
    id: 'pwmpad',
    name: 'PWM strings pad',
    category: 'strings',
    description: 'Two pulse waves whose widths drift against each other: warmer and softer than the string machine.',
    tip: 'Long chords that overlap. The movement is in the sound, so keep the part simple.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.23, shape: 2 }],
            ['lfo2', 'lfo', { rate: 0.31, shape: 3 }],
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 1, width: 0.5, level: 0.3, ...env(0.6, 1, 1, 0.8) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 1, width: 0.5, level: 0.3, ...env(0.6, 1, 1, 0.8) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2200, resonance: 0.1, drive: 1, cvAmount: 0.6 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['lfo3', 'lfo', { rate: 0.4, shape: 2 }],
            ['dly1', 'delay', { time: 0.014, cvAmount: 0.3, feedback: 0.1, damping: 0.3, mix: 0.4 }],
          ],
          'lfo1.out -> osc1.pwm',
          'lfo2.out -> osc2.pwm',
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
          'vca1.out -> dly1.in',
          'lfo3.out -> dly1.cv',
        ),
        room('dly1.out', 0.85, 4, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'hollowpad',
    name: 'Hollow pad',
    category: 'strings',
    description: 'Square waves through a band-pass that never quite opens: woody, hollow, like singing into a tube.',
    tip: 'Mid-range chords; it leaves the top and bottom free for everything else.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 1, width: 0.5, level: 0.75, ...env(0.7, 1, 1, 0.9) }],
            ['osc2', 'osc', { pitch: C3 * 2.003, wave: 1, width: 0.35, level: 0.3, ...env(0.7, 1, 1, 0.9) }],
            ['cv1', 'cv', {}],
            ['bpf1', 'svf', { mode: 1, cutoff: 700, resonance: 0.55, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.6, cvAmount: 0.4 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> bpf1.in',
          'key1.pitch -> bpf1.cv',
          'bpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.8, 3.5, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'syncpad',
    name: 'Sync pad',
    category: 'strings',
    description: 'A hard-sync sweep that climbs as the chord is held, growing more and more nasal.',
    tip: 'Hold a chord for two bars or more to hear the whole climb. Short notes stay mellow.',
    make: () =>
      build(
        played(8),
        units(
          [
            // Heard only through osc2, whose cycle it restarts.
            ['osc1', 'osc', { pitch: C3, wave: 0, level: 1 }],
            ['env1', 'adsr', { attack: 2, decay: 2, sustain: 1, release: 1 }],
            ['cv1', 'cv', { gain1: 1, gain2: 1.5 }],
            ['osc2', 'osc', { pitch: C3, wave: 0, level: 0.6, ...env(0.6, 1, 1, 0.9) }],
            ['lpf1', 'ladder', { cutoff: 3200, resonance: 0.1, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['dly1', 'delay', { time: 0.3, feedback: 0.35, damping: 0.6, mix: 0.2 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> env1.gate',
          'key1.pitch -> cv1.in1',
          'env1.out -> cv1.in2',
          'cv1.sum -> osc2.pitch',
          'osc1.out -> osc2.sync',
          'key1.gate -> osc2.gate',
          'osc2.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.8, 3, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'supersawpad',
    name: 'Supersaw pad',
    category: 'strings',
    description: 'The trance pad: seven detuned saws in one Unison Oscillator, chorused wide and sent into a big hall.',
    tip: 'Big, bright chords for a breakdown. Leave the low end to the bass.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['uni1', 'unison', { pitch: C3, wave: 0, voices: 7, detune: 0.1, width: 0, level: 0.45 }],
            ['lpf1', 'ladder', { cutoff: 4000, resonance: 0.1, drive: 1, cvAmount: 0.4 }],
            ['env1', 'adsr', { attack: 0.25, decay: 1, sustain: 1, release: 0.9 }],
            ['vca2', 'vca', { level: 0, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.35, cvAmount: 0.65 }],
          ],
          'key1.pitch -> uni1.pitch',
          'uni1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'key1.gate -> env1.gate',
          'env1.out -> vca2.cv',
          'vca2.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        wide('vca1.out', { mode: 0, rate: 0.7, depth: 0.5, center: 0.4, feedback: 0.1, mix: 0.5 }, 0.95, 5),
        out(wideOut(0.3)),
      ),
  },
  {
    id: 'airpad',
    name: 'Air pad',
    category: 'strings',
    description: 'Breath more than tone: noise ringing a pitched resonator, with a faint sine underneath.',
    tip: 'Very quiet, very high in a mix. Lovely an octave or two above the melody.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['noise1', 'noise', { color: 0.6 }],
            ['env1', 'adsr', { attack: 1.2, decay: 1, sustain: 1, release: 1.2 }],
            ['vca1', 'vca', { level: 0, cvAmount: 1 }],
            ['res1', 'res', { pitch: C3, cvAmount: 1, decay: 0.8, damping: 0.6 }],
            ['osc1', 'osc', { pitch: C3, wave: 3, level: 0.15, ...env(1.2, 1, 1, 1.2) }],
            ['cv1', 'cv', { gain1: 0.75, gain2: 1 }],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.gate -> env1.gate',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> res1.in',
          'key1.pitch -> res1.cv',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'res1.out -> cv1.in1',
          'osc1.out -> cv1.in2',
          'cv1.sum -> vca2.in',
          'key1.vel -> vca2.cv',
        ),
        room('vca2.out', 0.95, 6, 0.45, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'bellpad',
    name: 'Bell pad',
    category: 'strings',
    description: 'An FM bell strikes each chord, then melts into a soft pad underneath.',
    tip: 'Slow chord changes: each one rings in on its own bell.',
    make: () =>
      build(
        played(8),
        fm({
          base: C4,
          ratio: 3.5,
          index: 1.2,
          bright: env(0.0005, 0.7, 0, 0.6),
          body: env(0.0005, 1.4, 0.25, 1),
          level: 0.4,
        }),
        units(
          [
            ['osc3', 'osc', { pitch: C4, wave: 2, level: 0.22, ...env(1.2, 1, 1, 1) }],
            ['cv1', 'cv', {}],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
        ),
        room('cv1.sum', 0.9, 5, 0.4),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'crystalpad',
    name: 'Crystal pad',
    category: 'strings',
    description: 'A high, ring-modulated shimmer with sparks of light scattered over it.',
    tip: 'Above everything else, in a quiet passage. Sparse chords.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C4, wave: 2, level: 0.5, ...env(0.8, 1, 1, 1.2) }],
            ['osc2', 'osc', { pitch: C5, wave: 3 }],
            ['ring1', 'ring', { mix: 1 }],
            ['cv1', 'cv', { gain1: 0.6, gain2: 0.35 }],
            // The sparks: dust, only while a note sounds.
            ['dust1', 'dust', { density: 7, spread: 0.6, decay: 0.004, tone: 1 }],
            ['hpf1', 'svf', { mode: 2, cutoff: 4000, resonance: 0.2 }],
            ['env1', 'adsr', { attack: 0.8, decay: 1, sustain: 1, release: 1.2 }],
            ['vca1', 'vca', { level: 0, cvAmount: 1 }],
            ['cv2', 'cv', { gain1: 1, gain2: 0.6 }],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['dly1', 'delay', { time: 0.37, feedback: 0.4, damping: 0.4, mix: 0.25 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> ring1.in',
          'osc2.out -> ring1.car',
          'osc1.out -> cv1.in1',
          'ring1.out -> cv1.in2',
          'dust1.out -> hpf1.in',
          'hpf1.out -> vca1.in',
          'key1.gate -> env1.gate',
          'env1.out -> vca1.cv',
          'cv1.sum -> cv2.in1',
          'vca1.out -> cv2.in2',
          'cv2.sum -> vca2.in',
          'key1.vel -> vca2.cv',
          'vca2.out -> dly1.in',
        ),
        room('dly1.out', 0.95, 6, 0.45),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'frozenpad',
    name: 'Frozen pad',
    category: 'strings',
    description: 'A granulator holding the chord in place, like a sample frozen in time.',
    tip: 'A held chord as a bed. The grains keep it still while everything else moves.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 0, level: 0.5, ...env(0.3, 1, 1, 1) }],
            ['osc2', 'osc', { pitch: C4, wave: 2, level: 0.2, ...env(0.3, 1, 1, 1) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2500, resonance: 0.1, drive: 1, cvAmount: 0.4 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['gran1', 'gran', { size: 0.2, density: 25, position: 0.25, spray: 0, pitch: 0, spread: 0.6, mix: 0.7 }],
          ],
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
          'vca1.out -> gran1.in',
        ),
        {
          units: [['spc1', 'reverb', { size: 0.9, decay: 4, damping: 0.4, mix: 0.35 }] as Unit],
          cables: ['gran1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },
  {
    id: 'darkmatter',
    name: 'Dark matter',
    category: 'strings',
    description: 'A low sine slowly folding into harmonics and back: deep, dark and alive.',
    tip: 'Single low notes or open fifths, held for a long time. Space horror and ambient.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.07, shape: 3 }],
            ['osc1', 'osc', { pitch: C2, wave: 3, level: 0.6, ...env(1.5, 1, 1, 1.2) }],
            ['fold1', 'fold', { fold: 2.5, symmetry: 0.1, cvAmount: 1.5 }],
            ['lpf1', 'ladder', { cutoff: 1200, resonance: 0.2, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> fold1.in',
          'lfo1.out -> fold1.cv',
          'fold1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.9, 5, 0.35, 0.6),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'tensionpad',
    name: 'Tension pad',
    category: 'strings',
    description: 'A saw rubbing against the semitone above it, with noise that rises the longer it is held.',
    tip: 'Suspense under a scene. Hold one note and let it build.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 0, level: 0.4, ...env(2, 1, 1, 1.2) }],
            ['osc2', 'osc', { pitch: C3 * 1.0595, wave: 0, level: 0.1, ...env(2, 1, 1, 1.2) }],
            ['noise1', 'noise', { color: 0.4 }],
            ['bpf1', 'svf', { mode: 1, cutoff: 1500, resonance: 0.4 }],
            ['env1', 'adsr', { attack: 2, decay: 1, sustain: 1, release: 1.2 }],
            // Longer than any envelope rises: the build over six seconds or so.
            ['slew1', 'slew', { rise: 4, fall: 1, shape: 0 }],
            ['vca1', 'vca', { level: 0, cvAmount: 0.6 }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 600, resonance: 0.3, drive: 1.2, cvAmount: 2 }],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'noise1.out -> bpf1.in',
          'bpf1.out -> vca1.in',
          'key1.gate -> env1.gate',
          'env1.out -> slew1.in',
          'slew1.out -> vca1.cv',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'vca1.out -> cv2.in2',
          'cv2.sum -> lpf1.in',
          'slew1.out -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'key1.vel -> vca2.cv',
        ),
        room('vca2.out', 0.85, 4, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'underwaterpad',
    name: 'Underwater pad',
    category: 'strings',
    description: 'Muffled and swaying: a filter that wanders on its own, through a slow, deep chorus.',
    tip: 'Under a lo-fi beat or a calm level. It never sits still.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.9985, wave: 2, level: 0.45, ...env(0.8, 1, 1, 1) }],
            ['osc2', 'osc', { pitch: C3 * 1.0015, wave: 0, level: 0.2, ...env(0.8, 1, 1, 1) }],
            ['cv1', 'cv', {}],
            ['drunk1', 'drunk', { rate: 0.6, step: 0.4, smooth: 1, pull: 0.3 }],
            ['lpf1', 'ladder', { cutoff: 500, resonance: 0.35, drive: 1, cvAmount: 1.5 }],
            ['vca1', 'vca', { level: 0.45, cvAmount: 0.55 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'drunk1.out -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        wide('vca1.out', { mode: 0, rate: 0.2, depth: 0.45, center: 0.6, feedback: 0.15, mix: 0.5 }, 0.85, 3.5),
        out(wideOut(0.2)),
      ),
  },
  {
    id: 'cathedralpad',
    name: 'Cathedral pad',
    category: 'strings',
    description: 'An organ stack of octaves and a fifth, played into a vast stone room.',
    tip: 'Slow hymn-like chords. Let each one ring out before the next.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['osc1', 'osc', { pitch: C3, wave: 3, level: 0.3, ...env(0.15, 1, 1, 0.4) }],
            ['osc2', 'osc', { pitch: C4, wave: 3, level: 0.2, ...env(0.15, 1, 1, 0.4) }],
            ['osc3', 'osc', { pitch: C3 * 1.5, wave: 3, level: 0.12, ...env(0.15, 1, 1, 0.4) }],
            ['osc4', 'osc', { pitch: C5, wave: 3, level: 0.1, ...env(0.15, 1, 1, 0.4) }],
            ['cv1', 'cv', {}],
            ['cv2', 'cv', {}],
            ['cv3', 'cv', {}],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.pitch -> osc3.pitch',
          'key1.pitch -> osc4.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'key1.gate -> osc3.gate',
          'key1.gate -> osc4.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'osc3.out -> cv2.in1',
          'osc4.out -> cv2.in2',
          'cv1.sum -> cv3.in1',
          'cv2.sum -> cv3.in2',
          'cv3.sum -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 1, 7, 0.5, 0.5),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'rustpad',
    name: 'Rust pad',
    category: 'strings',
    description: 'A pad off a worn-out tape: driven, crushed, wobbling and dull.',
    tip: 'Lo-fi and post-apocalyptic scenes. Chords sound better here than single notes.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, level: 0.3, ...env(0.6, 1, 1, 0.9) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 1, width: 0.4, level: 0.25, ...env(0.6, 1, 1, 0.9) }],
            ['cv1', 'cv', {}],
            ['crs1', 'crush', { bits: 6, rate: 9000, mix: 0.6 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            // Worn out: driven hard, wobbling and dull.
            ['tape1', 'tape', { drive: 0.9, wow: 0.45, flutter: 0.35, age: 0.75, hiss: 0 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> crs1.in',
          'crs1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> tape1.in',
        ),
        room('tape1.out', 0.6, 2.5, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'pulsepad',
    name: 'Pulsing pad',
    category: 'strings',
    description: 'A warm pad chopped into a steady pulse, like a gated synth bed.',
    tip: 'The pulse runs at its own pace, eight a second: set the LFO Rate to fit the tempo.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, level: 0.3, ...env(0.05, 1, 1, 0.6) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 1, width: 0.5, level: 0.25, ...env(0.05, 1, 1, 0.6) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 1400, resonance: 0.25, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['lfo1', 'lfo', { rate: 8, shape: 1, width: 0.5 }],
            ['vca2', 'vca', { level: 0.1, cvAmount: 0.9 }],
          ],
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
          'vca1.out -> vca2.in',
          'lfo1.uni -> vca2.cv',
        ),
        room('vca2.out', 0.6, 1.8, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'breathpad',
    name: 'Breathing pad',
    category: 'strings',
    description: 'Filter and volume rise and fall together, slowly, like breathing.',
    tip: 'A held chord under dialogue or a quiet scene: it moves without anyone playing.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.18, shape: 3 }],
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 0, level: 0.3, ...env(1, 1, 1, 1) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 2, level: 0.35, ...env(1, 1, 1, 1) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 900, resonance: 0.2, drive: 1, cvAmount: 1.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['vca2', 'vca', { level: 0.45, cvAmount: 0.55 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lfo1.out -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> vca2.in',
          'lfo1.uni -> vca2.cv',
        ),
        room('vca2.out', 0.85, 4, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'wanderpad',
    name: 'Wandering pad',
    category: 'strings',
    description: 'One of its two oscillators drifts in and out of tune on a slow random walk, so the chorus never repeats.',
    tip: 'Long chords in an ambient piece. It sounds slightly different every time.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['drunk1', 'drunk', { rate: 0.4, step: 0.5, smooth: 1, pull: 0.5 }],
            ['osc1', 'osc', { pitch: C3, wave: 0, level: 0.3, ...env(0.8, 1, 1, 1) }],
            ['osc2', 'osc', { pitch: C3, wave: 0, fmAmount: 0.007, level: 0.3, ...env(0.8, 1, 1, 1) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 1600, resonance: 0.15, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
          'drunk1.out -> osc2.fm',
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
        room('vca1.out', 0.85, 4, 0.35),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'phaserpad',
    name: 'Phaser pad',
    category: 'strings',
    description: 'Saws through a slow phaser: the classic 70s swirl.',
    tip: 'Held chords in funk, disco or space rock. One chord per bar or longer.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.997, wave: 0, level: 0.3, ...env(0.3, 1, 1, 0.8) }],
            ['osc2', 'osc', { pitch: C3 * 1.003, wave: 0, level: 0.3, ...env(0.3, 1, 1, 0.8) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 3000, resonance: 0.1, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
          ],
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
        wide('vca1.out', { mode: 2, rate: 0.15, depth: 0.85, center: 0.5, feedback: 0.6, mix: 0.6 }, 0.7, 2.5),
        out(wideOut(0.15)),
      ),
  },
  {
    id: 'echopad',
    name: 'Echo pad',
    category: 'strings',
    description: 'A soft pluck into a long, darkening echo: the repeats become the pad.',
    tip: 'Play short notes, sparsely, and let the echoes fill the gaps.',
    make: () =>
      build(
        played(8),
        units(
          [
            // An oscillator pluck rather than a string: a string's pitch moves
            // as it is struck, and the echoes would replay that against it.
            ['osc1', 'osc', { pitch: C3, wave: 2, level: 0.5, ...env(0.004, 0.6, 0.12, 0.6) }],
            ['osc2', 'osc', { pitch: C3 * 2, wave: 0, level: 0.15, ...env(0.002, 0.15, 0, 0.15) }],
            ['cv1', 'cv', {}],
            ['lpf1', 'ladder', { cutoff: 2200, resonance: 0.1, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.375, feedback: 0.55, damping: 0.6, mix: 0.45 }],
          ],
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
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.9, 4, 0.4),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'oohchoir',
    name: 'Ooh choir',
    category: 'strings',
    description: 'A soft choir singing "ooh": darker and rounder than the Choir.',
    tip: 'Low, slow chords. Mix with the Choir for an "ooh" turning into "aah".',
    make: () =>
      build(
        played(6),
        units(
          [
            ['voice1', 'voice', { pitch: C3, mode: 1, tone: 0.35, breath: 0.15, jitter: 0.02, vibDepth: 0.06, vibRate: 4.8, attack: 0.35, release: 0.6, level: 0.8 }],
            ['fmt1', 'formant', { vowel: 0.2, size: 1.1, res: 0.6 }],
            // "Oo" is the quietest vowel a mouth makes: made up for here.
            ['cv1', 'cv', { gain1: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['cho1', 'chorus', { mode: 0, rate: 0.3, depth: 0.35, center: 0.4, feedback: 0.1, mix: 0.5 }],
          ],
          'key1.pitch -> voice1.pitch',
          'key1.gate -> voice1.gate',
          'voice1.out -> fmt1.in',
          'fmt1.out -> cv1.in1',
          'cv1.out1 -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> cho1.in',
        ),
        {
          units: [['spc1', 'reverb', { size: 0.9, decay: 3.5, damping: 0.45, mix: 0.35 }] as Unit],
          cables: ['cho1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },
  {
    id: 'whisperpad',
    name: 'Whisper pad',
    category: 'strings',
    description: 'A choir that is mostly breath: whispered voices with only a hint of a note.',
    tip: 'Ghostly and close. Quiet chords in a haunted level.',
    make: () =>
      build(
        played(6),
        units(
          [
            ['voice1', 'voice', { pitch: C3, mode: 1, tone: 0.25, breath: 0.75, jitter: 0.05, vibDepth: 0.04, vibRate: 4, attack: 0.5, release: 0.8, level: 0.9 }],
            ['fmt1', 'formant', { vowel: 1.5, size: 1, res: 0.5 }],
            ['cv1', 'cv', { gain1: 1.6 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['cho1', 'chorus', { mode: 0, rate: 0.25, depth: 0.5, center: 0.4, feedback: 0.1, mix: 0.5 }],
          ],
          'key1.pitch -> voice1.pitch',
          'key1.gate -> voice1.gate',
          'voice1.out -> fmt1.in',
          'fmt1.out -> cv1.in1',
          'cv1.out1 -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> cho1.in',
        ),
        {
          units: [['spc1', 'reverb', { size: 0.9, decay: 4, damping: 0.3, mix: 0.4 }] as Unit],
          cables: ['cho1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },
  {
    id: 'vinylpad',
    name: 'Vinyl pad',
    category: 'strings',
    description: 'A warm pad as a lo-fi record plays it: soft, wobbling, crackling and rolled off.',
    tip: 'Chords under a lo-fi beat, with the Lo-fi Kit.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.998, wave: 2, level: 0.4, ...env(0.6, 1, 1, 0.9) }],
            ['osc2', 'osc', { pitch: C3 * 1.002, wave: 0, level: 0.2, ...env(0.6, 1, 1, 0.9) }],
            ['cv1', 'cv', {}],
            ['dust1', 'dust', { density: 25, spread: 0.6, decay: 0.002, tone: 0.5 }],
            ['env1', 'adsr', { attack: 0.6, decay: 1, sustain: 1, release: 0.9 }],
            ['vca1', 'vca', { level: 0, cvAmount: 0.5 }],
            ['cv2', 'cv', {}],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
            // The record: its wobble, its saturation and its dull top end.
            ['tape1', 'tape', { drive: 0.35, wow: 0.35, flutter: 0.25, age: 0.85, hiss: 0 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'dust1.out -> vca1.in',
          'key1.gate -> env1.gate',
          'env1.out -> vca1.cv',
          'cv1.sum -> cv2.in1',
          'vca1.out -> cv2.in2',
          'cv2.sum -> vca2.in',
          'key1.vel -> vca2.cv',
          'vca2.out -> tape1.in',
        ),
        room('tape1.out', 0.5, 1.5, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'cloudpad',
    name: 'Granular cloud',
    category: 'strings',
    description: 'A soft pad scattered into a dense, drifting cloud of grains.',
    tip: 'Ambient beds. Chords blur into each other, so change them slowly.',
    make: () =>
      build(
        played(8),
        units(
          [
            ['osc1', 'osc', { pitch: C3 * 0.9985, wave: 2, level: 0.9, ...env(1, 1, 1, 1.2) }],
            ['osc2', 'osc', { pitch: C3 * 1.0015, wave: 0, level: 0.25, ...env(1, 1, 1, 1.2) }],
            ['cv1', 'cv', {}],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['gran1', 'gran', { size: 0.1, density: 80, position: 0.3, spray: 0.6, pitch: 0, spread: 1, mix: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> gran1.in',
        ),
        {
          units: [
            ['spc1', 'reverb', { size: 0.95, decay: 5, damping: 0.35, mix: 0.4 }] as Unit,
          ],
          cables: ['gran1.l -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2'],
        },
        out(STEREO_OUT),
      ),
  },

  // --- brass & winds, continued ---------------------------------------------
  {
    id: 'tuba',
    name: 'Tuba',
    category: 'brass',
    description: 'A big, round tuba: soft and dark, opening up into a blat when pushed.',
    tip: 'Oom-pah bass lines on the beat, or long low notes under the brass section.',
    make: () =>
      build(
        played(2),
        units(
          [
            ['osc1', 'osc', { pitch: C1, wave: 0, level: 0.5, ...env(0.05, 0.3, 0.85, 0.12) }],
            ['cv1', 'cv', { gain1: 1.2, gain2: 0.9 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 260, resonance: 0.15, drive: 1.8, cvAmount: 2 }],
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
        room('vca1.out', 0.5, 1.4, 0.18),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'saxophone',
    name: 'Saxophone',
    category: 'brass',
    description: 'A breathy tenor sax: a reedy buzz through a bright horn, with a lazy vibrato.',
    tip: 'Smoky late-night melodies. Soft velocities are breathier; hard ones honk.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['lfo1', 'lfo', { rate: 4.8, shape: 3 }],
            ['osc1', 'osc', { pitch: C3, wave: 1, width: 0.38, fmAmount: 0.007, level: 0.45, ...env(0.04, 0.25, 0.85, 0.1) }],
            ['cv1', 'cv', { gain1: 1.4, gain2: 0.8 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 700, resonance: 0.2, drive: 1.8, cvAmount: 2 }],
            // The horn's bright formant.
            ['mmf1', 'svf', { mode: 4, cutoff: 1500, resonance: 0.55, cvAmount: 0 }],
            ['noise1', 'noise', {}],
            ['lpf2', 'ladder', { mode: 2, cutoff: 1800, resonance: 0.2, drive: 1, cvAmount: 1 }],
            ['vca2', 'vca', { level: 0, cvAmount: 0.1 }],
            ['cv2', 'cv', {}],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.env -> cv1.in1',
          'key1.pitch -> cv1.in2',
          'osc1.out -> lpf1.in',
          'cv1.sum -> lpf1.cv',
          'lpf1.out -> mmf1.in',
          'noise1.out -> lpf2.in',
          'key1.pitch -> lpf2.cv',
          'lpf2.out -> vca2.in',
          'osc1.env -> vca2.cv',
          'mmf1.out -> cv2.in1',
          'vca2.out -> cv2.in2',
          'cv2.sum -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.55, 1.6, 0.22),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'oboe',
    name: 'Oboe',
    category: 'brass',
    description: 'A plaintive, nasal double reed: thin and focused, singing over an orchestra.',
    tip: 'Sad solo melodies in the middle of the roll, over strings.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['lfo1', 'lfo', { rate: 5.2, shape: 3 }],
            ['osc1', 'osc', { pitch: C4, wave: 1, width: 0.22, fmAmount: 0.005, level: 0.32, ...env(0.04, 0.2, 0.85, 0.1) }],
            // The nasal peak, which is what makes it an oboe and not a clarinet.
            ['mmf1', 'svf', { mode: 4, cutoff: 1400, resonance: 0.7, cvAmount: 0 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 3500, resonance: 0.05, drive: 1, cvAmount: 0.5 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'lfo1.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> mmf1.in',
          'mmf1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.6, 1.8, 0.25),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'harmonica',
    name: 'Harmonica',
    category: 'brass',
    description: 'A blues harp: reedy chords that wail, with the hand-cupped wah of the player.',
    tip: 'Two- and three-note chords, bent and repeated. Blues in C, played on the black keys.',
    make: () =>
      build(
        played(4),
        units(
          [
            ['osc1', 'osc', { pitch: C4 * 0.998, wave: 1, width: 0.42, level: 0.3, ...env(0.03, 0.2, 0.9, 0.08) }],
            ['osc2', 'osc', { pitch: C4 * 1.002, wave: 0, level: 0.15, ...env(0.03, 0.2, 0.9, 0.08) }],
            ['cv1', 'cv', {}],
            // The hands: a slow wah opening and closing the tone.
            ['lfo1', 'lfo', { rate: 3.5, shape: 3, depth: 1 }],
            ['cv2', 'cv', { gain1: 0.5, gain2: 1 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 1400, resonance: 0.3, drive: 1.5, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
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
        ),
        room('vca1.out', 0.4, 1.1, 0.15),
        out(STEREO_OUT),
      ),
  },

  // --- bass, continued --------------------------------------------------------
  {
    id: 'uprightbass',
    name: 'Upright bass',
    category: 'bass',
    description: 'A plucked double bass: a warm, woody thump with a short, round ring.',
    tip: 'Walking lines for jazz: a note on every beat, stepping through the chord.',
    make: () =>
      build(
        played(1),
        pluck({ base: C1, wave: 2, strike: 0.012, tone: 500, ring: 1.2, damping: 0.55, release: 0.15 }),
        units(
          [
            ['osc3', 'osc', { pitch: C1, wave: 3, level: 0.3, ...env(0.004, 0.5, 0.1, 0.12) }],
            ['cv1', 'cv', {}],
            ['vca3', 'vca', { level: 0.25, cvAmount: 0.75 }],
          ],
          'key1.pitch -> osc3.pitch',
          'key1.gate -> osc3.gate',
          'vca2.out -> cv1.in1',
          'osc3.out -> cv1.in2',
          'cv1.sum -> vca3.in',
          'key1.vel -> vca3.cv',
        ),
        room('vca3.out', 0.35, 0.9, 0.12),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'wobblebass',
    name: 'Wobble bass',
    category: 'bass',
    description: 'A dubstep wobble: a fat saw whose filter throbs open and shut, restarting on every note.',
    tip: 'The LFO\'s Rate is the rhythm -- set it to a multiple of the tempo, 2 Hz at 120 bpm is eighths.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C1, wave: 0, level: 0.45, ...env(0.004, 0.3, 1, 0.08) }],
            ['osc2', 'osc', { pitch: C2, wave: 1, width: 0.5, level: 0.25, ...env(0.004, 0.3, 1, 0.08) }],
            ['cv1', 'cv', {}],
            // Restarted by each note, so the wobble lands on the beat.
            ['lfo1', 'lfo', { rate: 4, shape: 3, depth: 1 }],
            ['lpf1', 'ladder', { cutoff: 180, resonance: 0.55, drive: 2.5, cvAmount: 4 }],
            ['drv1', 'drive', { drive: 2, level: 0.6 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'key1.gate -> lfo1.sync',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lfo1.uni -> lpf1.cv',
          'lpf1.out -> drv1.in',
          'drv1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },
  {
    id: 'chipbass',
    name: 'Chiptune bass',
    category: 'bass',
    description: 'The old console\'s triangle channel: a stepped, buzzy triangle for 8-bit bass lines.',
    tip: 'Pair it with the Chiptune lead. Octave jumps on every other note are the style.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C2, wave: 2, level: 0.6, ...env(0.001, 0.1, 1, 0.02) }],
            // Four bits: the triangle's staircase.
            ['bits1', 'crush', { bits: 4, rate: 24000, mix: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> bits1.in',
          'bits1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },
  {
    id: 'growlbass',
    name: 'Growl bass',
    category: 'bass',
    description: 'A talking bass: a saw through a mouth that sweeps "oh-yah" on every note.',
    tip: 'Short, punchy notes. The vowel sweep resets on each one, so rhythm is everything.',
    make: () =>
      build(
        played(1),
        units(
          [
            // The oscillator's own envelope moves the vowel as well as the level.
            ['osc1', 'osc', { pitch: C1, wave: 0, level: 0.6, ...env(0.004, 0.25, 0.6, 0.08) }],
            ['osc2', 'osc', { pitch: C2, wave: 0, level: 0.35, ...env(0.004, 0.25, 0.6, 0.08) }],
            ['cv1', 'cv', {}],
            ['fmt1', 'formant', { vowel: 1, size: 1.6, res: 0.6, vowelAmount: 1.5 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 900, resonance: 0.1, drive: 1, cvAmount: 1 }],
            ['drv1', 'drive', { drive: 3, level: 0.6 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.pitch -> osc2.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> fmt1.in',
          'osc1.env -> fmt1.vowel',
          'fmt1.out -> drv1.in',
          'drv1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        out(MONO_OUT, 'vca1.out -> mix1.in1'),
      ),
  },

  // --- leads, continued --------------------------------------------------------
  {
    id: 'supersaw',
    name: 'Supersaw lead',
    category: 'leads',
    description: 'Five detuned saws from one Unison Oscillator in a wide chorus: the huge trance and anthem lead.',
    tip: 'Big, simple melodies. It fills a whole mix on its own, so leave room around it.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['uni1', 'unison', { pitch: C4, wave: 0, voices: 5, detune: 0.2, width: 0, level: 0.45 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 5000, resonance: 0.1, drive: 1, cvAmount: 0.6 }],
            ['env1', 'adsr', { attack: 0.005, decay: 0.3, sustain: 0.9, release: 0.2 }],
            ['vca2', 'vca', { level: 0, cvAmount: 1 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['cho1', 'chorus', { mode: 0, rate: 0.3, depth: 0.12, center: 0.4, feedback: 0.1, mix: 0.4 }],
          ],
          'key1.pitch -> uni1.pitch',
          'uni1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'key1.gate -> env1.gate',
          'env1.out -> vca2.cv',
          'vca2.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> cho1.in',
        ),
        out(STEREO_OUT, 'cho1.l -> mix1.in1', 'cho1.r -> mix1.in2'),
      ),
  },
  {
    id: 'pwmlead',
    name: 'PWM lead',
    category: 'leads',
    description: 'A pulse whose width is always moving: a lively, chorused, slightly nasal lead.',
    tip: 'Mid-tempo melodies. The slow width sweep makes long notes interesting.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['lfo1', 'lfo', { rate: 0.9, shape: 2 }],
            ['lfo2', 'lfo', { rate: 5.5, shape: 2 }],
            ['osc1', 'osc', { pitch: C4, wave: 1, width: 0.5, fmAmount: 0.005, level: 0.4, ...env(0.01, 0.3, 0.85, 0.15) }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 3000, resonance: 0.15, drive: 1, cvAmount: 0.8 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.33, feedback: 0.3, damping: 0.45, mix: 0.2 }],
          ],
          'lfo1.out -> osc1.pwm',
          'lfo2.out -> osc1.fm',
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'key1.pitch -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.45, 1.3, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'theremin',
    name: 'Theremin',
    category: 'leads',
    description: 'The eerie sci-fi theremin: a pure tone gliding between notes with a wide vibrato.',
    tip: 'Slow, sliding melodies. Space-age B-movies and haunted houses.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['slew1', 'slew', { rise: 0.15, fall: 0.15, shape: 0 }],
            ['lfo1', 'lfo', { rate: 6, shape: 3 }],
            ['osc1', 'osc', { pitch: C4, wave: 3, fmAmount: 0.012, level: 0.5, ...env(0.08, 0.3, 0.95, 0.25) }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> slew1.in',
          'slew1.out -> osc1.pitch',
          'lfo1.out -> osc1.fm',
          'key1.gate -> osc1.gate',
          'osc1.out -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.6, 2, 0.3),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'whistle',
    name: 'Whistle',
    category: 'leads',
    description: 'Someone whistling a tune: a pure, breathy tone that slips between notes.',
    tip: 'Carefree melodies high in the roll. Western standoffs, too.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['slew1', 'slew', { rise: 0.04, fall: 0.04, shape: 0 }],
            ['lfo1', 'lfo', { rate: 5.5, shape: 3 }],
            ['osc1', 'osc', { pitch: C5, wave: 3, fmAmount: 0.006, level: 0.5, ...env(0.03, 0.2, 0.9, 0.08) }],
            // The breath around the tone, in a band that follows it.
            ['noise1', 'noise', {}],
            ['lpf1', 'ladder', { mode: 2, cutoff: 1100, resonance: 0.5, drive: 1, cvAmount: 1 }],
            ['vca2', 'vca', { level: 0, cvAmount: 0.18 }],
            ['cv1', 'cv', {}],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
          ],
          'key1.pitch -> slew1.in',
          'slew1.out -> osc1.pitch',
          'lfo1.out -> osc1.fm',
          'key1.gate -> osc1.gate',
          'noise1.out -> lpf1.in',
          'slew1.out -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'osc1.env -> vca2.cv',
          'osc1.out -> cv1.in1',
          'vca2.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'key1.vel -> vca1.cv',
        ),
        room('vca1.out', 0.5, 1.5, 0.2),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'screamer',
    name: 'Screaming lead',
    category: 'leads',
    description: 'A saw driven into a wavefolder and distortion: the shredding rock-synth lead.',
    tip: 'Long bent notes and fast runs. Velocity is how hard the amp is pushed.',
    make: () =>
      build(
        played(1),
        units(
          [
            ['slew1', 'slew', { rise: 0.03, fall: 0.03, shape: 0 }],
            ['lfo1', 'lfo', { rate: 5.8, shape: 2 }],
            ['osc1', 'osc', { pitch: C4, wave: 0, fmAmount: 0.006, level: 0.8, ...env(0.004, 0.3, 0.9, 0.15) }],
            ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['fold1', 'fold', { fold: 2.5, symmetry: 0.2 }],
            ['drv1', 'drive', { drive: 6, level: 0.35 }],
            ['lpf1', 'ladder', { mode: 1, cutoff: 4500, resonance: 0.15, drive: 1, cvAmount: 0.4 }],
            ['vca2', 'vca', { level: 0.4, cvAmount: 0.6 }],
            ['dly1', 'delay', { time: 0.36, feedback: 0.35, damping: 0.5, mix: 0.22 }],
          ],
          'key1.pitch -> slew1.in',
          'slew1.out -> osc1.pitch',
          'lfo1.out -> osc1.fm',
          'key1.gate -> osc1.gate',
          'osc1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> fold1.in',
          'fold1.out -> drv1.in',
          'drv1.out -> lpf1.in',
          'slew1.out -> lpf1.cv',
          'lpf1.out -> vca2.in',
          'key1.vel -> vca2.cv',
          'vca2.out -> dly1.in',
        ),
        room('dly1.out', 0.5, 1.4, 0.15),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'vowellead',
    name: 'Vowel lead',
    category: 'leads',
    description: 'A synth that talks: every note opens from "oo" to "ah", like a voice box.',
    tip: 'Funky, stabbing phrases. Short notes say "wow"; long ones hold on the "ah".',
    make: () =>
      build(
        played(1),
        units(
          [
            ['osc1', 'osc', { pitch: C4, wave: 0, level: 0.5, ...env(0.01, 0.35, 0.7, 0.12) }],
            // A separate envelope for the mouth, faster than the note.
            ['env1', 'adsr', { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.2 }],
            ['fmt1', 'formant', { vowel: 0, size: 1, res: 0.65, vowelAmount: 2 }],
            ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
            ['dly1', 'delay', { time: 0.25, feedback: 0.25, damping: 0.4, mix: 0.18 }],
          ],
          'key1.pitch -> osc1.pitch',
          'key1.gate -> osc1.gate',
          'key1.gate -> env1.gate',
          'osc1.out -> fmt1.in',
          'env1.out -> fmt1.vowel',
          'fmt1.out -> vca1.in',
          'key1.vel -> vca1.cv',
          'vca1.out -> dly1.in',
        ),
        room('dly1.out', 0.45, 1.2, 0.15),
        out(STEREO_OUT),
      ),
  },

  // --- drums, continued ---------------------------------------------------------
  {
    id: 'kick808',
    name: '808 kick',
    category: 'drums',
    description: 'The drum-machine boom: a long sub sine sliding down, felt as much as heard.',
    tip: 'Sparse hip-hop and trap patterns. Leave room: its tail is the bass line.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.06, sustain: 0, release: 0.06 }],
          ['osc1', 'osc', { pitch: 44, wave: 3, fmAmount: 1.6, level: 0.9, ...env(0.0005, 0.9, 0, 0.5) }],
          ['drv1', 'drive', { drive: 1.8, level: 0.75 }],
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
    id: 'rimshot',
    name: 'Rimshot',
    category: 'drums',
    description: 'A stick cracking the rim of the snare: a sharp, woody, high click.',
    tip: 'Instead of the snare in quiet verses, or as a ghost-note accent.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 1700, wave: 2, level: 0.8, ...env(0.0005, 0.02, 0, 0.02) }],
          ['osc2', 'osc', { pitch: 480, wave: 3, level: 0.6, ...env(0.0005, 0.03, 0, 0.03) }],
          ['cv1', 'cv', {}],
          ['lpf1', 'ladder', { mode: 3, cutoff: 350, resonance: 0.1, drive: 2, cvAmount: 0 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lpf1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'ride',
    name: 'Ride',
    category: 'drums',
    description: 'A ride cymbal: a clear ping on top of a long, washy metallic shimmer.',
    tip: 'Steady eighths or a jazz swing pattern, in place of the closed hat.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 427, wave: 1 }],
          ['osc2', 'osc', { pitch: 613, wave: 1 }],
          ['ring1', 'ring', { mix: 1 }],
          ['noise1', 'noise', {}],
          ['cv1', 'cv', { gain1: 0.8, gain2: 0.5 }],
          ['lpf1', 'ladder', { mode: 3, cutoff: 5500, resonance: 0.2, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.9, sustain: 0, release: 0.9 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          // The bell: a short pure ping at the stick.
          ['osc3', 'osc', { pitch: 3100, wave: 3, level: 0.25, ...env(0.0005, 0.15, 0, 0.15) }],
          ['cv2', 'cv', {}],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'osc1.out -> ring1.in',
          'osc2.out -> ring1.car',
          'ring1.out -> cv1.in1',
          'noise1.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'gate1.gate -> env1.gate',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'gate1.gate -> osc3.gate',
          'vca1.out -> cv2.in1',
          'osc3.out -> cv2.in2',
          'cv2.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'conga',
    name: 'Conga',
    category: 'drums',
    description: 'A hand on a tall drum: a warm, round tone that bends slightly as it sounds.',
    tip: 'Syncopated Latin patterns. Pair with Bongo, pitched higher, on its own track.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 196, wave: 3, level: 0.8, envPitch: 0.25, ...env(0.0005, 0.22, 0, 0.18) }],
          // The slap of the palm.
          ['noise1', 'noise', {}],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.012, sustain: 0, release: 0.01 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['lpf1', 'ladder', { mode: 2, cutoff: 1800, resonance: 0.3, drive: 1, cvAmount: 0 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.5 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env1.gate',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> lpf1.in',
          'osc1.out -> cv1.in1',
          'lpf1.out -> cv1.in2',
          'cv1.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'bongo',
    name: 'Bongo',
    category: 'drums',
    description: 'A small, high hand drum: a bright, tight pop.',
    tip: 'Quick fills and off-beats above the Conga.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 410, wave: 3, level: 0.8, envPitch: 0.2, ...env(0.0005, 0.11, 0, 0.08) }],
          ['noise1', 'noise', {}],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.008, sustain: 0, release: 0.008 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['lpf1', 'ladder', { mode: 2, cutoff: 3000, resonance: 0.3, drive: 1, cvAmount: 0 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.45 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env1.gate',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> lpf1.in',
          'osc1.out -> cv1.in1',
          'lpf1.out -> cv1.in2',
          'cv1.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'tambourine',
    name: 'Tambourine',
    category: 'drums',
    description: 'A shaken tambourine: a quick cluster of bright metal jingles.',
    tip: 'On the two and four with the snare, or steady sixteenths for lift.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // The jingles: three hits a few milliseconds apart.
          ['brst1', 'burst', { count: 3, rate: 45, curve: 0, jitter: 0.4, width: 0.3 }],
          ['osc1', 'osc', { pitch: 2350, wave: 1 }],
          ['osc2', 'osc', { pitch: 3310, wave: 1 }],
          ['ring1', 'ring', { mix: 1 }],
          ['noise1', 'noise', {}],
          ['cv1', 'cv', { gain1: 0.7, gain2: 0.6 }],
          ['lpf1', 'ladder', { mode: 3, cutoff: 6500, resonance: 0.2, drive: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.05, sustain: 0, release: 0.08 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> brst1.trig',
          'brst1.gate -> env1.gate',
          'osc1.out -> ring1.in',
          'osc2.out -> ring1.car',
          'ring1.out -> cv1.in1',
          'noise1.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'snap',
    name: 'Finger snap',
    category: 'drums',
    description: 'A crisp finger snap: a short, dry crack of mid-range noise.',
    tip: 'Instead of the clap on two and four, for something smaller and cooler.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', {}],
          ['mmf1', 'svf', { mode: 1, cutoff: 2300, resonance: 0.5, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.03, sustain: 0, release: 0.03 }],
          ['vca1', 'vca', { level: 0, cvAmount: 2 }],
          ['osc1', 'osc', { pitch: 1200, wave: 3, level: 0.2, ...env(0.0005, 0.015, 0, 0.01) }],
          ['cv1', 'cv', {}],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'gate1.gate -> osc1.gate',
          'noise1.out -> mmf1.in',
          'mmf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> cv1.in1',
          'osc1.out -> cv1.in2',
          'cv1.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'claves',
    name: 'Claves',
    category: 'drums',
    description: 'Two hardwood sticks struck together: a high, pure, penetrating click.',
    tip: 'The son clave: 3-2 across two bars, the backbone of salsa.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 2500, wave: 2, level: 0.8, ...env(0.0005, 0.045, 0, 0.03) }],
          ['res1', 'res', { pitch: 2500, decay: 0.06, damping: 0.1 }],
          ['cv1', 'cv', { gain1: 0.6, gain2: 0.5 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'osc1.out -> res1.in',
          'osc1.out -> cv1.in1',
          'res1.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'triangle',
    name: 'Triangle',
    category: 'drums',
    description: 'An orchestral triangle: a bright, silvery ding that rings on and on.',
    tip: 'Sparingly, on the downbeat of a new section. A little goes a very long way.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Three inharmonic partials, which is what a bent steel bar rings at.
          ['osc1', 'osc', { pitch: 4180, wave: 3, level: 0.5, ...env(0.0005, 1, 0, 0.8) }],
          ['osc2', 'osc', { pitch: 6030, wave: 3, level: 0.3, ...env(0.0005, 0.7, 0, 0.6) }],
          ['osc3', 'osc', { pitch: 8710, wave: 3, level: 0.2, ...env(0.0005, 0.5, 0, 0.4) }],
          ['cv1', 'cv', {}],
          ['cv2', 'cv', {}],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'gate1.gate -> osc3.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'osc3.out -> cv2.in2',
          'cv2.sum -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'timpani',
    name: 'Timpani',
    category: 'drums',
    description: 'An orchestral kettle drum: a deep, booming, pitched roll of thunder.',
    tip: 'Fast repeated hits for a roll that builds; one hard hit to end a phrase.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // A drumhead's partials, not a string's: 1, 1.5 and 1.99.
          ['osc1', 'osc', { pitch: 98, wave: 3, level: 0.8, envPitch: 0.08, ...env(0.001, 1, 0, 0.8) }],
          ['osc2', 'osc', { pitch: 147, wave: 3, level: 0.35, ...env(0.001, 0.7, 0, 0.6) }],
          ['osc3', 'osc', { pitch: 195, wave: 3, level: 0.2, ...env(0.001, 0.5, 0, 0.4) }],
          ['cv1', 'cv', {}],
          ['cv2', 'cv', {}],
          // The felt mallet: a soft thump of low noise.
          ['noise1', 'noise', { color: 1 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.03, sustain: 0, release: 0.03 }],
          ['vca1', 'vca', { level: 0, cvAmount: 0.6 }],
          ['lpf1', 'ladder', { cutoff: 600, resonance: 0, drive: 1, cvAmount: 0 }],
          ['cv3', 'cv', {}],
          ['vca2', 'vca', TOUCH],
          ['spc1', 'reverb', { size: 0.8, decay: 2, damping: 0.4, mix: 0.25 }],
          STEREO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'gate1.gate -> osc3.gate',
          'gate1.gate -> env1.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'osc3.out -> cv2.in2',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> lpf1.in',
          'cv2.sum -> cv3.in1',
          'lpf1.out -> cv3.in2',
          'cv3.sum -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> spc1.in',
          'spc1.l -> mix1.in1',
          'spc1.r -> mix1.in2',
        ],
      ),
  },

  // --- sound fx: interface -------------------------------------------------
  //
  // One-shots, fired by a press. No Keyboard: a sound effect is one lane of
  // hits in the roll, as a drum is, and its pitch is part of its design.
  // Every one ends in a VCA on the Trigger's Vel, so a softer hit from the
  // roll or a game is a quieter one.
  {
    id: 'uiconfirm',
    name: 'UI confirm',
    category: 'sfx',
    description: 'Two quick rising sine blips: yes, done, accepted.',
    tip: 'Keep it on buttons that commit something, and let a plain tick do the rest.',
    make: () =>
      rack(
        [
          // A fixed-length gate, as the Coin's is: the second blip waits 60 ms,
          // and a quick tap would otherwise let go before it arrived.
          ['gate1', 'gate', { mode: 1, length: 0.12 }],
          ['osc1', 'osc', { pitch: 1046.5, wave: 3, level: 0.5, ...env(0.0005, 0.03, 0, 0.03) }],
          ['osc2', 'osc', { pitch: 1568, wave: 3, level: 0.5, delay: 0.06, ...env(0.0005, 0.07, 0, 0.07) }],
          ['cv1', 'cv', {}],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'uierror',
    name: 'UI error',
    category: 'sfx',
    description: 'A low two-tone buzz, falling: no, not that, try again.',
    tip: 'Rare is the point. An error sound heard every few seconds stops meaning anything.',
    make: () =>
      rack(
        [
          ['gate1', 'gate', { mode: 1, length: 0.25 }],
          ['osc1', 'osc', { pitch: 233, wave: 1, width: 0.35, level: 0.5, ...env(0.001, 0.08, 0, 0.04) }],
          ['osc2', 'osc', { pitch: 175, wave: 1, width: 0.35, level: 0.5, delay: 0.1, ...env(0.001, 0.12, 0, 0.06) }],
          ['cv1', 'cv', {}],
          ['lpf1', 'ladder', { cutoff: 1400, resonance: 0.2, drive: 1.5, cvAmount: 0 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lpf1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'uitick',
    name: 'Menu tick',
    category: 'sfx',
    description: 'A tiny wooden tick for hover and scroll: a click rung briefly by a comb.',
    tip: 'Play it on every step of a scrolling list; it is short enough not to smear.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', {}],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.002, sustain: 0, release: 0.002 }],
          ['vca1', 'vca', { level: 0, cvAmount: 2 }],
          // A short ring at a pitch is what makes a click sound like a thing.
          ['mmf1', 'svf', { mode: 5, cutoff: 2600, resonance: 0.7, cvAmount: 0 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> mmf1.in',
          'mmf1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'gameover',
    name: 'Game over',
    category: 'sfx',
    description: 'A machine powering down: pitch and filter falling together into the dark.',
    tip: 'Leave a beat of silence after it. The fall is the ending; nothing should land on it.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // The oscillator's own envelope drags its pitch two octaves down as
          // the note fades, and the same envelope closes the filter.
          ['osc1', 'osc', { pitch: 98, wave: 0, level: 0.7, envPitch: 2, ...env(0.002, 0.7, 0, 0.5) }],
          ['osc2', 'osc', { pitch: 98 * 1.498, wave: 1, width: 0.3, level: 0.35, envPitch: 2, ...env(0.002, 0.7, 0, 0.5) }],
          ['cv1', 'cv', {}],
          ['lpf1', 'ladder', { cutoff: 220, resonance: 0.35, drive: 2, cvAmount: 4 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> osc2.gate',
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'osc1.env -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },

  // --- sound fx: gameplay --------------------------------------------------
  {
    id: 'jump',
    name: 'Jump',
    category: 'sfx',
    description: 'A short square chirp that bends upwards: the platformer hop.',
    tip: 'Nudge the pitch up for a smaller character, down for a heavier one.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Env Pitch negative: at the top of the envelope the pitch is an
          // octave down, and it climbs back as the note fades -- the rise.
          ['osc1', 'osc', { pitch: 700, wave: 1, level: 0.6, envPitch: -1, ...env(0.001, 0.09, 0, 0.05) }],
          ['lpf1', 'ladder', { cutoff: 5000, resonance: 0, drive: 1, cvAmount: 0 }],
          ['vca1', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'osc1.out -> lpf1.in',
          'lpf1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'hurt',
    name: 'Hurt',
    category: 'sfx',
    description: 'Taking a hit: a dropping tone roughened by ring modulation, over a burst of noise.',
    tip: 'Velocity from the game as damage: a graze plays soft, a heavy hit plays loud.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 260, wave: 0, level: 0.8, envPitch: 1, ...env(0.001, 0.12, 0, 0.08) }],
          ['ring1', 'ring', { freq: 73, mix: 0.7 }],
          ['noise1', 'noise', {}],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.05, sustain: 0, release: 0.04 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['cv1', 'cv', { gain1: 0.7, gain2: 0.4 }],
          ['lpf1', 'ladder', { cutoff: 2600, resonance: 0.15, drive: 2, cvAmount: 0 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env1.gate',
          'osc1.out -> ring1.in',
          'noise1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'ring1.out -> cv1.in1',
          'vca1.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'lpf1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'heal',
    name: 'Heal',
    category: 'sfx',
    description: 'A shimmering rising arpeggio, through a wide chorus: health coming back.',
    tip: 'The Quantizer\'s Scale picks the mood -- major is cheerful, pent is magic.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Six quick notes, and a ramp climbing across them that the
          // Quantizer snaps to a scale: a rising arpeggio from one press.
          ['brst1', 'burst', { count: 6, rate: 16, curve: 0, jitter: 0, width: 0.4 }],
          ['qnt1', 'quant', { root: 0, scale: 6 }],
          ['osc1', 'osc', { pitch: 523.25, wave: 2, fmAmount: 1, level: 0.55, ...env(0.001, 0.12, 0, 0.12) }],
          ['vca1', 'vca', TOUCH],
          ['cho1', 'chorus', { mode: 0, rate: 0.8, depth: 0.7, center: 0.3, feedback: 0.2, mix: 0.5 }],
          STEREO_OUT,
        ],
        [
          'gate1.gate -> brst1.trig',
          'brst1.ramp -> qnt1.in',
          'qnt1.out -> osc1.fm',
          'brst1.gate -> osc1.gate',
          'osc1.out -> vca1.in',
          'gate1.vel -> vca1.cv',
          'vca1.out -> cho1.in',
          'cho1.l -> mix1.in1',
          'cho1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'teleport',
    name: 'Teleport',
    category: 'sfx',
    description: 'A rising tone and a hiss, through a flanger swept by the same press: whoosh, gone.',
    tip: 'Play it in reverse order with a falling Env Pitch for arriving instead of leaving.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 600, wave: 0, level: 0.6, envPitch: -2, ...env(0.01, 0.25, 0, 0.2) }],
          ['noise1', 'noise', {}],
          ['cv1', 'cv', { gain1: 0.7, gain2: 0.35 }],
          ['env1', 'adsr', { attack: 0.02, decay: 0.3, sustain: 0, release: 0.2 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          ['cho1', 'chorus', { mode: 1, rate: 0.1, depth: 0.1, center: 0.05, feedback: 0.85, mix: 0.5 }],
          STEREO_OUT,
        ],
        [
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env1.gate',
          'osc1.out -> cv1.in1',
          'noise1.out -> cv1.in2',
          'cv1.sum -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> cho1.in',
          // The Jet flyby's trick, much faster: the envelope sweeps the comb.
          'env1.out -> cho1.cv',
          'cho1.l -> mix1.in1',
          'cho1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'swish',
    name: 'Sword swish',
    category: 'sfx',
    description: 'A blade cutting air: a band of noise swept up and back in a fraction of a second.',
    tip: 'Res narrows the band -- higher for a thin rapier, lower for a heavy axe.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', {}],
          ['env1', 'adsr', { attack: 0.05, decay: 0.12, sustain: 0, release: 0.08 }],
          ['mmf1', 'svf', { mode: 1, cutoff: 500, resonance: 0.55, cvAmount: 3 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1.6 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'noise1.out -> mmf1.in',
          'env1.out -> mmf1.cv',
          'mmf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'punch',
    name: 'Punch',
    category: 'sfx',
    description: 'A fist landing: a low thump with a snap of noise on top, pushed through drive.',
    tip: 'Layer it under Hurt for a hit the player takes, on its own for one they land.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.03, sustain: 0, release: 0.03 }],
          ['osc1', 'osc', { pitch: 70, wave: 3, fmAmount: 2.5, level: 0.9, ...env(0.0005, 0.12, 0, 0.1) }],
          ['noise1', 'noise', {}],
          ['env2', 'adsr', { attack: 0.0005, decay: 0.015, sustain: 0, release: 0.015 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['cv1', 'cv', { gain1: 0.8, gain2: 0.5 }],
          ['drv1', 'drive', { drive: 3, level: 0.6 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'gate1.gate -> osc1.gate',
          'gate1.gate -> env2.gate',
          'env1.out -> osc1.fm',
          'noise1.out -> vca1.in',
          'env2.out -> vca1.cv',
          'osc1.out -> cv1.in1',
          'vca1.out -> cv1.in2',
          'cv1.sum -> drv1.in',
          'drv1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'glass',
    name: 'Glass break',
    category: 'sfx',
    description: 'A pane shattering: a dense crackle of impacts ringing two high, clashing pitches.',
    tip: 'Two Resonators a non-harmonic ratio apart are the glass. Move either for a different pane.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Noise, not clicks: a click carries DC, and a Resonator rings at
          // nought hertz as readily as at its pitch -- which is a thud.
          ['dust1', 'dust', { density: 500, spread: 0.7, decay: 0.0008, tone: 1, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.0005, decay: 0.12, sustain: 0, release: 0.1 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['res1', 'res', { pitch: 3150, decay: 0.35, damping: 0.1 }],
          ['res2', 'res', { pitch: 3790, decay: 0.25, damping: 0.1 }],
          ['cv1', 'cv', { gain1: 0.6, gain2: 0.55 }],
          // Mostly the rings: the crackle on its own is low and thuddy, and
          // any more of it and the pane sounds like gravel.
          ['cv2', 'cv', { gain1: 1, gain2: 0.2 }],
          ['mmf1', 'svf', { mode: 2, cutoff: 1800, resonance: 0.1, cvAmount: 0 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'dust1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> res1.in',
          'vca1.out -> res2.in',
          'res1.out -> cv1.in1',
          'res2.out -> cv1.in2',
          // The rings, and the crackle itself on top of them.
          'cv1.sum -> cv2.in1',
          'vca1.out -> cv2.in2',
          'cv2.sum -> mmf1.in',
          'mmf1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'creak',
    held: true,
    name: 'Door creak',
    category: 'sfx',
    description: 'A slow door on a dry hinge, for as long as the key is held: grinding clicks rung by a wandering comb.',
    tip: 'Hold it for the length of the swing. A longer note is a slower door.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Stick and slip: clicks that come in clusters, a walk moving their
          // rate and the pitch they ring at together.
          ['drk1', 'drunk', { rate: 4, step: 0.35, smooth: 1, pull: 0.2, rateAmount: 0 }],
          ['dust1', 'dust', { density: 110, spread: 0.5, decay: 0.0006, tone: 0, cvAmount: 1.5 }],
          ['mmf1', 'svf', { mode: 5, cutoff: 280, resonance: 0.9, cvAmount: 0.7 }],
          ['env1', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.12 }],
          ['vca1', 'vca', { level: 0, cvAmount: 2 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'drk1.out -> dust1.density',
          'drk1.out -> mmf1.cv',
          'dust1.out -> mmf1.in',
          'gate1.gate -> env1.gate',
          'mmf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'spell',
    name: 'Spell cast',
    category: 'sfx',
    description: 'A rising, shimmering tone scattered into a sparkling cloud an octave up.',
    tip: 'Turn the Granular\'s Pitch to 0 for a darker, more ominous cast.',
    make: () =>
      rack(
        [
          // A fixed length, so a tap casts the whole spell: the rise takes
          // a third of a second and a tap is over long before that.
          ['gate1', 'gate', { mode: 1, length: 0.4 }],
          ['lfo1', 'lfo', { rate: 7, shape: 3, depth: 1 }],
          ['env1', 'adsr', { attack: 0.35, decay: 0.7, sustain: 0, release: 0.5 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.03 }],
          // The rise: the envelope bends the pitch up as it builds, and a
          // vibrato rides on top.
          ['osc1', 'osc', { pitch: 392, wave: 2, fmAmount: 1 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          ['gran1', 'gran', { size: 0.05, density: 45, position: 0.08, spray: 0.4, pitch: 1, spread: 0.9, mix: 0.55 }],
          STEREO_OUT,
        ],
        [
          'gate1.gate -> env1.gate',
          'env1.out -> cv1.in1',
          'lfo1.out -> cv1.in2',
          'cv1.sum -> osc1.fm',
          'osc1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> gran1.in',
          'gran1.l -> mix1.in1',
          'gran1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'klaxon',
    held: true,
    name: 'Alarm klaxon',
    category: 'sfx',
    description: 'A two-tone alarm for as long as the key is held: something has gone badly wrong.',
    tip: 'Hold it for bars at a time under the music, or tap it for one warning.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // A square LFO flips the pitch between two notes a fourth apart,
          // restarted by the press so every alarm starts on the same one.
          ['lfo1', 'lfo', { rate: 1.6, shape: 1, width: 0.5, depth: 1 }],
          ['osc1', 'osc', { pitch: 440, wave: 0, fmAmount: 0.415, level: 0.6 }],
          ['lpf1', 'ladder', { cutoff: 2200, resonance: 0.3, drive: 2.5, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.005, decay: 0.01, sustain: 1, release: 0.06 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'gate1.gate -> lfo1.sync',
          'lfo1.uni -> osc1.fm',
          'osc1.out -> lpf1.in',
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
    id: 'forcefield',
    held: true,
    name: 'Force field',
    category: 'sfx',
    description: 'A shield humming while the key is held, wobbling through a phaser. Its Macro is how strong it is.',
    tip: 'Macro Amount is the shield: from a game, setParam(track, \'mac1.amount\', health) and it strains as it weakens.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Amount: the shield's strength. Lane 1 brightens it, lane 2 makes
          // it restless, and lane 3 -- only in the top third -- adds grit.
          ['mac1', 'macro', { amount: 0.35, curve1: 0.3, start3: 0.65 }],
          ['osc1', 'osc', { pitch: 55, wave: 0, level: 0.6 }],
          ['osc2', 'osc', { pitch: 82.7, wave: 1, width: 0.3, level: 0.4 }],
          ['cv1', 'cv', {}],
          ['lpf1', 'ladder', { cutoff: 300, resonance: 0.45, drive: 1.5, cvAmount: 3 }],
          ['drv1', 'drive', { drive: 1, level: 0.7, cvAmount: 3 }],
          ['drk1', 'drunk', { rate: 1.5, step: 0.3, smooth: 1, pull: 0.3, rateAmount: 3 }],
          ['env1', 'adsr', { attack: 0.02, decay: 0.05, sustain: 1, release: 0.25 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1.5 }],
          ['vca2', 'vca', TOUCH],
          ['cho1', 'chorus', { mode: 2, rate: 0.3, depth: 0.3, center: 0.4, feedback: 0.6, mix: 0.5 }],
          STEREO_OUT,
        ],
        [
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> lpf1.in',
          'mac1.out1 -> lpf1.cv',
          'lpf1.out -> drv1.in',
          'mac1.out3 -> drv1.cv',
          'mac1.out2 -> drk1.rate',
          'gate1.gate -> env1.gate',
          'drv1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> cho1.in',
          'drk1.out -> cho1.cv',
          'cho1.l -> mix1.in1',
          'cho1.r -> mix1.in2',
        ],
      ),
  },

  // --- ambience ------------------------------------------------------------
  //
  // Beds that go on for as long as the key is held: a whole-bar note in the
  // roll, or a game holding the gate open while the player is in the place.
  {
    id: 'campfire',
    held: true,
    name: 'Campfire',
    category: 'ambience',
    description: 'A low roar of flame with crackles that flare and settle, for as long as the key is held.',
    tip: 'One long note across the scene. Pull the Dust\'s Density down for embers.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', { color: 1 }],
          ['lpf1', 'ladder', { cutoff: 380, resonance: 0.1, drive: 1, cvAmount: 0 }],
          // The walk moves how busy the crackle is, so the fire breathes.
          ['drk1', 'drunk', { rate: 0.8, step: 0.4, smooth: 1, pull: 0.2, rateAmount: 0 }],
          ['dust1', 'dust', { density: 14, spread: 0.75, decay: 0.004, tone: 1, cvAmount: 1.5 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.9 }],
          ['env1', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.4 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'noise1.out -> lpf1.in',
          'drk1.out -> dust1.density',
          'lpf1.out -> cv1.in1',
          'dust1.out -> cv1.in2',
          'gate1.gate -> env1.gate',
          'cv1.sum -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'drips',
    held: true,
    name: 'Cave drips',
    category: 'ambience',
    description: 'Water dripping in a cave: sparse drops at random moments, each at its own pitch, echoing.',
    tip: 'Every press drips once straight away, so it also works as a one-shot drop.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['dust1', 'dust', { density: 2.5, spread: 0.5, decay: 0.0005, tone: 0, cvAmount: 0 }],
          // One drop on the press itself, so the cave is never silent at first.
          ['env1', 'adsr', { attack: 0.0005, decay: 0.002, sustain: 0, release: 0.002 }],
          ['cv1', 'cv', { gain1: 1, gain2: 1 }],
          // A new pitch for every drop: noise, sampled when one lands.
          ['noise1', 'noise', {}],
          ['sh1', 'sh', {}],
          ['res1', 'res', { pitch: 1300, cvAmount: 1, decay: 0.12, damping: 0.15 }],
          ['dly1', 'delay', { time: 0.32, feedback: 0.45, damping: 0.5, mix: 0.35 }],
          ['env2', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.8 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1.8 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'dust1.out -> cv1.in1',
          'gate1.gate -> env1.gate',
          'env1.out -> cv1.in2',
          'noise1.out -> sh1.in1',
          'dust1.trig -> sh1.trig1',
          'sh1.out1 -> res1.cv',
          'cv1.sum -> res1.in',
          'res1.out -> dly1.in',
          'gate1.gate -> env2.gate',
          'dly1.out -> vca1.in',
          'env2.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'surf',
    held: true,
    name: 'Ocean surf',
    category: 'ambience',
    description: 'Waves rolling in and drawing back, slow and endless, for as long as the key is held.',
    tip: 'The LFO\'s Rate is the sea: slower for a calm bay, faster for a rough shore.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['noise1', 'noise', { color: 1 }],
          // Each wave: the filter opening and the level rising together,
          // with a second, slower swell under it so no two are alike.
          ['lfo1', 'lfo', { rate: 0.13, shape: 2, width: 0.3, depth: 1 }],
          ['lfo2', 'lfo', { rate: 0.047, shape: 3, depth: 0.5 }],
          ['cv1', 'cv', { gain1: 1, gain2: 0.6 }],
          ['lpf1', 'ladder', { cutoff: 700, resonance: 0.15, drive: 1, cvAmount: 2.2 }],
          // Never shut: between waves there is still the hiss of the foam.
          ['vca1', 'vca', { level: 0.45, cvAmount: 0.6 }],
          ['env1', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.8 }],
          ['vca2', 'vca', { level: 0, cvAmount: 2 }],
          ['vca3', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'noise1.out -> lpf1.in',
          'gate1.gate -> lfo1.sync',
          'lfo1.uni -> cv1.in1',
          'lfo2.out -> cv1.in2',
          'cv1.sum -> lpf1.cv',
          'lpf1.out -> vca1.in',
          'lfo1.uni -> vca1.cv',
          'gate1.gate -> env1.gate',
          'vca1.out -> vca2.in',
          'env1.out -> vca2.cv',
          'vca2.out -> vca3.in',
          'gate1.vel -> vca3.cv',
          'vca3.out -> mix1.in1',
        ],
      ),
  },
  {
    id: 'crickets',
    held: true,
    name: 'Night crickets',
    category: 'ambience',
    description: 'A cricket chirping in the dark, never quite in rhythm, for as long as the key is held.',
    tip: 'Two tracks of it, one an octave-ish apart, sound like a field rather than one insect.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 4300, wave: 3, level: 0.7 }],
          // The rasp inside a chirp, and the chirps themselves, which a walk
          // keeps from ever settling into a clock.
          ['lfo1', 'lfo', { rate: 32, shape: 1, width: 0.45, depth: 1 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['drk1', 'drunk', { rate: 0.7, step: 0.3, smooth: 1, pull: 0.3, rateAmount: 0 }],
          ['lfo2', 'lfo', { rate: 1.4, shape: 1, width: 0.28, depth: 1, cvAmount: 0.5 }],
          ['vca2', 'vca', { level: 0, cvAmount: 1 }],
          ['env1', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.2 }],
          ['vca3', 'vca', { level: 0, cvAmount: 1 }],
          ['vca4', 'vca', TOUCH],
          ['spc1', 'reverb', { size: 0.7, decay: 1.8, damping: 0.5, mix: 0.3 }],
          STEREO_OUT,
        ],
        [
          'osc1.out -> vca1.in',
          'lfo1.uni -> vca1.cv',
          'gate1.gate -> lfo2.sync',
          'drk1.out -> lfo2.cv',
          'vca1.out -> vca2.in',
          'lfo2.uni -> vca2.cv',
          'gate1.gate -> env1.gate',
          'vca2.out -> vca3.in',
          'env1.out -> vca3.cv',
          'vca3.out -> vca4.in',
          'gate1.vel -> vca4.cv',
          'vca4.out -> spc1.in',
          'spc1.l -> mix1.in1',
          'spc1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'shiphum',
    held: true,
    name: 'Spaceship hum',
    category: 'ambience',
    description: 'The engine room of a starship: a deep, beating drone slowly turning in a chorus.',
    tip: 'Under a whole level. Detune osc2 further for an older, sicker ship.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          ['osc1', 'osc', { pitch: 55, wave: 0, level: 0.6 }],
          ['osc2', 'osc', { pitch: 55.35, wave: 0, level: 0.6 }],
          ['osc3', 'osc', { pitch: 110, wave: 3, level: 0.5 }],
          ['cv1', 'cv', {}],
          ['cv2', 'cv', {}],
          ['lpf1', 'ladder', { cutoff: 480, resonance: 0.3, drive: 1.5, cvAmount: 0 }],
          ['env1', 'adsr', { attack: 0.02, decay: 0.05, sustain: 1, release: 0.6 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1 }],
          ['vca2', 'vca', TOUCH],
          ['drk1', 'drunk', { rate: 0.4, step: 0.3, smooth: 1, pull: 0.3, rateAmount: 0 }],
          ['cho1', 'chorus', { mode: 0, rate: 0.12, depth: 0.7, center: 0.5, feedback: 0.3, mix: 0.5 }],
          STEREO_OUT,
        ],
        [
          'osc1.out -> cv1.in1',
          'osc2.out -> cv1.in2',
          'cv1.sum -> cv2.in1',
          'osc3.out -> cv2.in2',
          'cv2.sum -> lpf1.in',
          'gate1.gate -> env1.gate',
          'lpf1.out -> vca1.in',
          'env1.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> cho1.in',
          'drk1.out -> cho1.cv',
          'cho1.l -> mix1.in1',
          'cho1.r -> mix1.in2',
        ],
      ),
  },
  {
    id: 'radiation',
    held: true,
    name: 'Radiation zone',
    category: 'ambience',
    description: 'A Geiger counter ticking over faint static. Its Macro is how hot the zone is.',
    tip: 'Macro Amount is the dose: from a game, setParam(track, \'mac1.amount\', nearness) and the clicks crowd in.',
    make: () =>
      rack(
        [
          ['gate1', 'gate'],
          // Lane 1: how fast it ticks, a few a second to a hundred. Lane 2,
          // only past half way: the static rising underneath.
          ['mac1', 'macro', { amount: 0.3, curve1: 0.4, start2: 0.5, to2: 0.6 }],
          ['dust1', 'dust', { density: 3, spread: 0.3, decay: 0.0004, tone: 0, cvAmount: 5 }],
          // A click on the press itself, so the counter answers at once.
          ['env1', 'adsr', { attack: 0.0005, decay: 0.002, sustain: 0, release: 0.002 }],
          ['cv1', 'cv', { gain1: 1, gain2: 1 }],
          ['mmf1', 'svf', { mode: 4, cutoff: 2800, resonance: 0.7, cvAmount: 0 }],
          ['noise1', 'noise', {}],
          ['vca3', 'vca', { level: 0, cvAmount: 0.08 }],
          ['cv2', 'cv', { gain1: 1, gain2: 1 }],
          ['env2', 'adsr', { attack: 0.01, decay: 0.05, sustain: 1, release: 0.15 }],
          ['vca1', 'vca', { level: 0, cvAmount: 1.6 }],
          ['vca2', 'vca', TOUCH],
          MONO_OUT,
        ],
        [
          'mac1.out1 -> dust1.density',
          'dust1.out -> cv1.in1',
          'gate1.gate -> env1.gate',
          'env1.out -> cv1.in2',
          'cv1.sum -> mmf1.in',
          'noise1.out -> vca3.in',
          'mac1.out2 -> vca3.cv',
          'mmf1.out -> cv2.in1',
          'vca3.out -> cv2.in2',
          'gate1.gate -> env2.gate',
          'cv2.sum -> vca1.in',
          'env2.out -> vca1.cv',
          'vca1.out -> vca2.in',
          'gate1.vel -> vca2.cv',
          'vca2.out -> mix1.in1',
        ],
      ),
  },
  // --- more basses ----------------------------------------------------------
  {
    id: 'moogbass',
    name: 'Moog bass',
    category: 'bass',
    description: 'A fat saw and square through a ladder filter that thumps open on every note.',
    tip: 'Funk and prog: syncopated lines with plenty of rests, so each thump lands.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.35 }, { wave: 1, ratio: 2.004, level: 0.25 }, { wave: 0, ratio: 0.998, level: 0.25 }],
        filter: { cutoff: 180, res: 0.35, drive: 2, track: 0.6, env: [0.001, 0.25, 0.2, 0.15], envAmount: 3 },
        amp: [0.002, 0.4, 0.8, 0.08],
      }),
  },
  {
    id: 'junobass',
    name: 'Juno sub bass',
    category: 'bass',
    description: 'A round pulse wave with a square an octave below it: soft, warm and very 80s.',
    tip: 'Long notes on the root under synth-pop chords.',
    make: () =>
      synth({
        base: C1,
        pwmRate: 0.4,
        oscs: [{ wave: 1, level: 0.35 }, { wave: 1, ratio: 2, width: 0.5, level: 0.3, pwm: true }],
        filter: { cutoff: 600, res: 0.15, track: 0.5, env: [0.002, 0.4, 0.4, 0.2], envAmount: 1 },
        amp: [0.003, 0.5, 0.9, 0.12],
      }),
  },
  {
    id: 'hooverbass',
    name: 'Hoover bass',
    category: 'bass',
    description: 'The rave hoover: detuned, swirling pulse-saws that swoop down into every note.',
    tip: 'Hardcore and jungle stabs, long and loud. Hold a note and let it swirl.',
    make: () =>
      synth({
        base: C2,
        pwmRate: 0.9,
        oscs: [
          { wave: 0, ratio: 0.996, level: 0.25, envPitch: 0.35, pitchDecay: 0.12 },
          { wave: 1, ratio: 1.004, width: 0.3, level: 0.25, pwm: true, envPitch: 0.35, pitchDecay: 0.12 },
          { wave: 0, ratio: 0.5, level: 0.2, envPitch: 0.35, pitchDecay: 0.12 },
        ],
        filter: { cutoff: 2200, res: 0.2, drive: 1.5, track: 0.5 },
        amp: [0.01, 0.5, 0.9, 0.25],
        room: [0.5, 1.4, 0.15],
      }),
  },
  {
    id: 'seqbass',
    name: 'Sequencer bass',
    category: 'bass',
    description: 'A short, resonant blip for running sixteenth-note sequences, Berlin-school style.',
    tip: 'Sixteenth notes all the way through, on two or three notes of the chord.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.45 }],
        filter: { cutoff: 220, res: 0.6, drive: 1.5, track: 0.8, env: [0.001, 0.15, 0, 0.1], envAmount: 3.5 },
        amp: [0.001, 0.25, 0.3, 0.08],
        delay: { time: 0.375, feedback: 0.3, mix: 0.15 },
      }),
  },
  {
    id: 'octavebass',
    name: 'Octave bass',
    category: 'bass',
    description: 'Two oscillators an octave apart, punchy and bright: the disco bass.',
    tip: 'Octave-jumping eighth notes, the disco way: low, high, low, high.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.35 }, { wave: 1, ratio: 2, width: 0.4, level: 0.3 }],
        filter: { cutoff: 500, res: 0.25, track: 0.6, env: [0.001, 0.2, 0.3, 0.1], envAmount: 2 },
        amp: [0.002, 0.3, 0.7, 0.08],
      }),
  },
  {
    id: 'unisonbass',
    name: 'Unison saw bass',
    category: 'bass',
    description: 'Five saws on one note from a Unison Oscillator, slightly apart: a huge, buzzing wall of bass.',
    tip: 'Big-room drops: long notes on the root, side by side with a kick.',
    make: () =>
      synth({
        base: C1,
        oscs: [],
        unison: { wave: 0, voices: 5, detune: 0.15, level: 0.4 },
        filter: { cutoff: 900, res: 0.15, drive: 1.8, track: 0.6 },
        amp: [0.003, 0.5, 0.9, 0.1],
      }),
  },
  {
    id: 'bass808',
    name: '808 bass',
    category: 'bass',
    description: 'A long, tuned 808 boom with a pitch drop and a little grit: the trap bass, played as notes.',
    tip: 'One long note per bar or two, sliding between roots. Keep the kick out of its way.',
    make: () =>
      synth({
        base: C1,
        glide: 0.04,
        oscs: [{ wave: 3, level: 0.8, envPitch: 1.2, pitchDecay: 0.035 }],
        drive: { drive: 2.5, level: 0.6, pre: true },
        filter: { cutoff: 1500, res: 0, track: 0.5 },
        amp: [0.001, 1.6, 0.25, 0.25],
      }),
  },
  {
    id: 'neurobass',
    name: 'Neuro bass',
    category: 'bass',
    description: 'A folded, snarling bass whose band-pass rips back and forth: drum and bass at its nastiest.',
    tip: 'Half-time drum and bass: long notes, and let the movement do the work.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.4 }, { wave: 1, ratio: 1.002, width: 0.3, level: 0.3 }],
        fold: { fold: 3, symmetry: 0.2, lfoRate: 0.5, lfoAmount: 1.5 },
        filter: { svf: true, mode: 1, cutoff: 500, res: 0.4, track: 0.5, lfo: { rate: 2, amount: 2, shape: 0 } },
        drive: { drive: 3, level: 0.4 },
        amp: [0.003, 0.5, 0.9, 0.1],
      }),
  },
  {
    id: 'donkbass',
    name: 'Donk bass',
    category: 'bass',
    description: 'The hollow, bouncing "donk" of UK hard house: a short pitch-dropping bonk.',
    tip: 'Off-beat eighths against a four-to-the-floor kick.',
    make: () =>
      synth({
        base: C2,
        oscs: [{ wave: 1, width: 0.5, level: 0.6, envPitch: 1, pitchDecay: 0.03 }],
        filter: { svf: true, mode: 1, cutoff: 500, res: 0.5, track: 1 },
        amp: [0.001, 0.18, 0, 0.08],
      }),
  },
  {
    id: 'fizzbass',
    name: 'Fizz bass',
    category: 'bass',
    description: 'A clean sine sub with a ring-modulated fizz on top that cuts on small speakers.',
    tip: 'Future bass and garage: the sub carries the weight, the fizz the note.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 3, level: 0.55 }],
        extra: {
          units: [
            ['osc8', 'osc', { pitch: C1 * 2, wave: 0 }],
            ['osc9', 'osc', { pitch: C1 * 3, wave: 3 }],
            ['ring1', 'ring', { mix: 1 }],
            ['hpf1', 'svf', { mode: 2, cutoff: 900, resonance: 0.2, cvAmount: 0 }],
            ['cvR', 'cv', { gain1: 0.4 }],
          ],
          cables: ['key1.pitch -> osc8.pitch', 'key1.pitch -> osc9.pitch', 'osc8.out -> ring1.in', 'osc9.out -> ring1.car', 'ring1.out -> hpf1.in', 'hpf1.out -> cvR.in1'],
          after: ['cvR.out1'],
        },
        filter: { cutoff: 400, res: 0, track: 0.8 },
        amp: [0.003, 0.4, 0.9, 0.1],
      }),
  },
  {
    id: 'garagebass',
    name: 'Garage bass',
    category: 'bass',
    description: 'A woody FM organ bass that bounces: UK garage and 2-step.',
    tip: 'Skippy, syncopated two-step lines with short notes.',
    make: () =>
      build(
        played(1),
        fm({ base: C1, ratio: 1, index: 1.4, bright: env(0.001, 0.15, 0.15, 0.08), body: env(0.002, 0.35, 0.6, 0.08), level: 0.6, touch: 0.6 }),
        out(MONO_OUT, 'vca2.out -> mix1.in1'),
      ),
  },
  {
    id: 'dubbass',
    name: 'Dub bass',
    category: 'bass',
    description: 'A deep, round sine-and-triangle bass with a soft start: heavy, warm, and felt more than heard.',
    tip: 'Reggae and dub: slow, melodic lines with long gaps.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 3, level: 0.6 }, { wave: 2, level: 0.25 }],
        filter: { cutoff: 260, res: 0.1, track: 0.7 },
        amp: [0.025, 0.6, 0.85, 0.15],
      }),
  },
  {
    id: 'fretless',
    name: 'Fretless bass',
    category: 'bass',
    description: 'A soft, singing fretless bass that slides between notes, with a gentle vibrato.',
    tip: 'Jazz fusion: melodic lines that slide up into the long notes.',
    make: () =>
      synth({
        base: C1,
        glide: 0.07,
        vib: { rate: 5, depth: 0.005, delay: 0.5 },
        oscs: [{ wave: 2, level: 0.5 }, { wave: 0, level: 0.15 }],
        filter: { cutoff: 380, res: 0.25, track: 0.8, env: [0.01, 0.4, 0.3, 0.2], envAmount: 1.5 },
        amp: [0.008, 1.2, 0.4, 0.15],
        room: [0.35, 0.8, 0.1],
      }),
  },
  {
    id: 'slapbass',
    name: 'Slap bass',
    category: 'bass',
    description: 'A bright thumb slap with a click on top: funk, popping and percussive.',
    tip: 'Funk: short notes with octave pops on the off-beats. Velocity is how hard you slap.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.4 }, { wave: 2, level: 0.3 }],
        extra: {
          units: [
            ['noise9', 'noise', {}],
            ['hpfC', 'svf', { mode: 2, cutoff: 3000, resonance: 0.1, cvAmount: 0 }],
            ['envC', 'adsr', { attack: 0.0005, decay: 0.012, sustain: 0, release: 0.01 }],
            ['vcaC', 'vca', { level: 0, cvAmount: 0.5 }],
          ],
          cables: ['noise9.out -> hpfC.in', 'hpfC.out -> vcaC.in', 'key1.gate -> envC.gate', 'envC.out -> vcaC.cv'],
          after: ['vcaC.out'],
        },
        filter: { cutoff: 600, res: 0.3, drive: 1.5, track: 0.8, env: [0.001, 0.12, 0.25, 0.1], envAmount: 3 },
        amp: [0.001, 0.5, 0.35, 0.08],
      }),
  },
  {
    id: 'pickedbass',
    name: 'Picked bass',
    category: 'bass',
    description: 'An electric bass played with a pick: punchy, mid-forward, a little growl.',
    tip: 'Rock: straight eighth notes on the root, locking in with the kick.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.45 }, { wave: 1, width: 0.35, level: 0.2 }],
        drive: { drive: 2, level: 0.55, pre: true },
        filter: { cutoff: 700, res: 0.2, track: 0.8, env: [0.001, 0.1, 0.35, 0.1], envAmount: 1.8 },
        amp: [0.002, 0.8, 0.5, 0.1],
      }),
  },
  {
    id: 'tubabass',
    name: 'Tuba bass',
    category: 'bass',
    description: 'A brassy low end that blooms on each note: for bass lines that want to be a band.',
    tip: 'Oom-pah: the root on one and the fifth on three, or a marching line.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.45 }],
        filter: { cutoff: 200, res: 0.15, drive: 1.3, track: 0.8, env: [0.04, 0.3, 0.5, 0.15], envAmount: 2 },
        amp: [0.03, 0.4, 0.85, 0.12],
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'kotobass',
    name: 'Synth-koto bass',
    category: 'bass',
    description: 'A plucked, metallic FM bass with a bright twang: 80s Japanese city pop.',
    tip: 'Busy, melodic lines under bright chords. Syncopate it.',
    make: () =>
      build(
        played(1),
        fm({ base: C1, ratio: 3, index: 2, bright: env(0.0005, 0.18, 0.05, 0.1), body: env(0.001, 0.8, 0.3, 0.1), level: 0.6 }),
        out(MONO_OUT, 'vca2.out -> mix1.in1'),
      ),
  },
  {
    id: 'rubberbass',
    name: 'Rubber bass',
    category: 'bass',
    description: 'A bouncy, squelchy bass that slides: a filter snapping shut on every note.',
    tip: 'Playful, jumpy lines with slides. Overlap notes to glide.',
    make: () =>
      synth({
        base: C1,
        glide: 0.05,
        oscs: [{ wave: 1, width: 0.4, level: 0.45 }],
        filter: { cutoff: 260, res: 0.65, drive: 1.5, track: 0.8, env: [0.001, 0.09, 0.1, 0.08], envAmount: 3 },
        amp: [0.002, 0.3, 0.7, 0.06],
      }),
  },
  {
    id: 'distbass',
    name: 'Distorted bass',
    category: 'bass',
    description: 'A saw driven hard into a speaker cabinet: industrial and rock.',
    tip: 'Simple, heavy lines. Fewer notes, more weight.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.4 }, { wave: 1, ratio: 1.003, width: 0.5, level: 0.25 }],
        drive: { drive: 10, level: 0.35, pre: true },
        filter: { svf: true, mode: 4, cutoff: 900, res: 0.3, track: 0.3 },
        amp: [0.002, 0.5, 0.9, 0.1],
      }),
  },
  {
    id: 'crushbass',
    name: 'Bitcrushed bass',
    category: 'bass',
    description: 'A chunky, lo-fi bass at six bits: crunchy and gritty, like an old sampler.',
    tip: 'Lo-fi hip-hop and chip-hop: short notes on the beat.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 1, width: 0.5, level: 0.45 }, { wave: 2, level: 0.25 }],
        crush: { bits: 6, rate: 8000, mix: 1 },
        filter: { cutoff: 800, res: 0.15, track: 0.6 },
        amp: [0.002, 0.4, 0.8, 0.08],
      }),
  },
  {
    id: 'formantbass',
    name: 'Formant bass',
    category: 'bass',
    description: 'A bass that talks: every note says "yoi", the mouth opening as it goes.',
    tip: 'Dubstep and electro: short, rhythmic notes so each one speaks.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, level: 0.45 }, { wave: 0, ratio: 2.004, level: 0.25 }],
        drive: { drive: 2, level: 0.6, pre: true },
        filter: { cutoff: 3000, res: 0.1, track: 0.3 },
        vowel: { vowel: 0, res: 0.7, size: 1.2, env: [0.05, 0.25, 0.4, 0.15], amount: 3.5 },
        amp: [0.003, 0.4, 0.9, 0.1],
      }),
  },
  {
    id: 'plucksub',
    name: 'Pluck sub',
    category: 'bass',
    description: 'A short saw pluck over a steady sine sub: punch on top, weight underneath.',
    tip: 'Future bass: chord roots with the pluck on every hit and the sub holding.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, ratio: 2, level: 0.4 }],
        extra: {
          // The sub skips the filter: it stays put while the pluck closes.
          units: [['osc9', 'osc', { pitch: C1, wave: 3, level: 0.5 }]],
          cables: ['key1.pitch -> osc9.pitch'],
          after: ['osc9.out'],
        },
        filter: { cutoff: 300, res: 0.3, track: 0.7, env: [0.001, 0.12, 0, 0.1], envAmount: 3.5 },
        amp: [0.002, 0.5, 0.85, 0.1],
      }),
  },
  {
    id: 'dronebass',
    name: 'Drone bass',
    category: 'bass',
    description: 'One low tone that never sits still: folding, filtering and swelling on its own.',
    tip: 'A single long note for a whole section. Horror, ambient and dread.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 3, level: 0.55 }, { wave: 0, ratio: 1.003, level: 0.15 }],
        fold: { fold: 2, symmetry: 0.1, lfoRate: 0.08, lfoAmount: 1.2 },
        filter: { cutoff: 400, res: 0.3, track: 0.5, lfo: { rate: 0.05, amount: 1.2 } },
        amp: [1.5, 1, 1, 2],
        room: [0.85, 4, 0.3],
      }),
  },
  {
    id: 'liquidreese',
    name: 'Liquid Reese',
    category: 'bass',
    description: 'A smooth, slowly phasing Reese: two saws drifting gently, rounder than the Reese.',
    tip: 'Liquid drum and bass: long, melodic notes under rolling breaks.',
    make: () =>
      synth({
        base: C1,
        oscs: [{ wave: 0, ratio: 0.997, level: 0.35 }, { wave: 0, ratio: 1.003, level: 0.35 }],
        filter: { cutoff: 380, res: 0.2, drive: 1.3, track: 0.6, lfo: { rate: 0.15, amount: 0.5 } },
        amp: [0.01, 0.5, 0.95, 0.15],
      }),
  },

  // --- more leads -----------------------------------------------------------
  {
    id: 'minilead',
    name: 'Mini lead',
    category: 'leads',
    description: 'The Minimoog solo: three fat saws, glide, and a filter that bites.',
    tip: 'Prog and funk solos: fast runs, bends and long held notes with vibrato.',
    make: () =>
      synth({
        base: C3,
        glide: 0.05,
        vib: { rate: 5.5, depth: 0.005, delay: 0.5 },
        oscs: [{ wave: 0, level: 0.3 }, { wave: 0, ratio: 1.0025, level: 0.25 }, { wave: 1, ratio: 0.9975, width: 0.4, level: 0.2 }],
        filter: { cutoff: 900, res: 0.35, drive: 2, track: 0.8, env: [0.003, 0.3, 0.4, 0.15], envAmount: 2 },
        amp: [0.003, 0.3, 0.9, 0.12],
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'plainsawlead',
    name: 'Saw lead',
    category: 'leads',
    description: 'One bright saw with a touch of vibrato: the plain, honest workhorse lead.',
    tip: 'Any melody. Start here and change the filter to taste.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 5.5, depth: 0.004, delay: 0.3 },
        oscs: [{ wave: 0, level: 0.45 }],
        filter: { cutoff: 3500, res: 0.15, track: 0.6 },
        amp: [0.004, 0.3, 0.9, 0.12],
        delay: { time: 0.33, feedback: 0.3, mix: 0.18 },
        room: [0.4, 1.2, 0.12],
      }),
  },
  {
    id: 'brasslead',
    name: 'Brass lead',
    category: 'leads',
    description: 'A synth-brass lead whose filter swells open on each note: 80s and bold.',
    tip: 'Fanfares and hooks: strong, rhythmic phrases with held notes at the end.',
    make: () =>
      synth({
        base: C3,
        vib: { rate: 5, depth: 0.004, delay: 0.6 },
        oscs: [{ wave: 0, ratio: 0.998, level: 0.3 }, { wave: 0, ratio: 1.002, level: 0.3 }],
        filter: { cutoff: 500, res: 0.15, drive: 1.3, track: 0.8, env: [0.07, 0.4, 0.55, 0.2], envAmount: 2.5 },
        amp: [0.03, 0.3, 0.9, 0.15],
        room: [0.5, 1.5, 0.15],
      }),
  },
  {
    id: 'hollowlead',
    name: 'Hollow square lead',
    category: 'leads',
    description: 'A soft square through a band-pass: hollow and woody, like a synthetic flute.',
    tip: 'Gentle melodies in the middle of the range.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 5, depth: 0.004, delay: 0.4 },
        oscs: [{ wave: 1, width: 0.5, level: 0.6 }],
        filter: { svf: true, mode: 1, cutoff: 600, res: 0.45, track: 1 },
        amp: [0.02, 0.3, 0.9, 0.15],
        room: [0.5, 1.5, 0.18],
      }),
  },
  {
    id: 'arplead',
    name: 'Arp lead',
    category: 'leads',
    description: 'A short, plucky lead made for fast arpeggios, with an echo behind it.',
    tip: 'Sixteenth-note arpeggios: use the roll\'s Arpeggiate on a held chord.',
    make: () =>
      synth({
        base: C4,
        oscs: [{ wave: 0, level: 0.35 }, { wave: 1, ratio: 1.003, width: 0.4, level: 0.25 }],
        filter: { cutoff: 900, res: 0.3, track: 0.7, env: [0.001, 0.12, 0.1, 0.1], envAmount: 2.5 },
        amp: [0.001, 0.2, 0, 0.1],
        delay: { time: 0.375, feedback: 0.35, mix: 0.25 },
        room: [0.4, 1.2, 0.12],
      }),
  },
  {
    id: 'detunedlead',
    name: 'Detuned lead',
    category: 'leads',
    description: 'Two saws drifting apart into a warm, woozy chorus: nostalgic and a little seasick.',
    tip: 'Slow, wistful melodies. Boards of Canada territory.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 0.4, depth: 0.003 },
        oscs: [{ wave: 0, ratio: 0.9965, level: 0.3 }, { wave: 2, ratio: 1.0035, level: 0.3 }],
        filter: { cutoff: 1800, res: 0.1, track: 0.5 },
        amp: [0.05, 0.4, 0.9, 0.3],
        room: [0.6, 2, 0.22],
      }),
  },
  {
    id: 'talkbox',
    name: 'Talkbox lead',
    category: 'leads',
    description: 'A saw played through a mouth: "wah-yeah" on every note, funk-robot style.',
    tip: 'Short, funky phrases with slides. Daft Punk and Zapp.',
    make: () =>
      synth({
        base: C3,
        glide: 0.04,
        oscs: [{ wave: 0, level: 0.45 }, { wave: 1, ratio: 1.003, width: 0.4, level: 0.2 }],
        filter: { cutoff: 4000, res: 0.1, track: 0.3 },
        vowel: { vowel: 0.5, res: 0.75, env: [0.06, 0.3, 0.5, 0.15], amount: 2.5 },
        amp: [0.005, 0.3, 0.9, 0.12],
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'robotvoice',
    name: 'Robot voice',
    category: 'leads',
    description: 'A flat, buzzing machine voice, like a vocoder with nothing to say but notes.',
    tip: 'Monotone melodies on one or two notes, in time with the beat.',
    make: () =>
      synth({
        base: C3,
        oscs: [{ wave: 1, width: 0.15, level: 0.5 }, { wave: 0, level: 0.2 }],
        filter: { cutoff: 5000, res: 0.1, track: 0.2 },
        vowel: { vowel: 3, res: 0.85, size: 0.9, lfo: { rate: 2, amount: 0.3 } },
        crush: { bits: 10, rate: 12000, mix: 0.6 },
        amp: [0.005, 0.3, 0.95, 0.08],
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'sirenlead',
    name: 'Siren lead',
    category: 'leads',
    description: 'Every note whoops up an octave into its pitch: the rave siren.',
    tip: 'Rave and hardcore: long notes, a bar or two each, so each whoop lands.',
    make: () =>
      synth({
        base: C4,
        oscs: [{ wave: 1, width: 0.5, level: 0.4, envPitch: -1, pitchDecay: 0.18 }, { wave: 0, ratio: 1.004, level: 0.25, envPitch: -1, pitchDecay: 0.18 }],
        filter: { cutoff: 4000, res: 0.15, track: 0.4 },
        amp: [0.005, 0.3, 0.9, 0.3],
        delay: { time: 0.375, feedback: 0.4, mix: 0.25 },
        room: [0.5, 1.5, 0.15],
      }),
  },
  {
    id: 'bendylead',
    name: 'Bendy lead',
    category: 'leads',
    description: 'Every note starts a semitone flat and bends up into tune, like a guitar string pushed.',
    tip: 'Bluesy melodies on the minor pentatonic. Long notes show the bend.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 5.5, depth: 0.006, delay: 0.5 },
        oscs: [{ wave: 0, level: 0.4, envPitch: -0.083, pitchDecay: 0.12 }, { wave: 1, width: 0.4, level: 0.2, envPitch: -0.083, pitchDecay: 0.12 }],
        filter: { cutoff: 2600, res: 0.2, drive: 1.5, track: 0.6 },
        amp: [0.004, 0.4, 0.85, 0.15],
        room: [0.4, 1.2, 0.15],
      }),
  },
  {
    id: 'ocarina',
    name: 'Ocarina',
    category: 'leads',
    description: 'A clay ocarina: a pure, breathy tone with a soft start. Very fantasy game.',
    tip: 'Short, simple tunes high in the roll, as a hero would play them.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 4.8, depth: 0.004, delay: 0.4 },
        oscs: [{ wave: 3, level: 0.6 }, { wave: 2, ratio: 2, level: 0.05 }],
        noise: { level: 0.12, color: 0.6 },
        filter: { cutoff: 2000, res: 0.05, track: 1 },
        amp: [0.04, 0.3, 0.9, 0.12],
        room: [0.6, 1.8, 0.25],
      }),
  },
  {
    id: 'recorder',
    name: 'Recorder',
    category: 'leads',
    description: 'A wooden recorder: airy, woody and a little reedy, the school-music classic.',
    tip: 'Folk tunes and medieval melodies; no vibrato on short notes.',
    make: () =>
      synth({
        base: C4,
        oscs: [{ wave: 2, level: 0.55 }, { wave: 1, width: 0.2, level: 0.08 }],
        noise: { level: 0.08, color: 0.7 },
        filter: { cutoff: 2600, res: 0.05, track: 1 },
        amp: [0.025, 0.3, 0.9, 0.08],
        room: [0.5, 1.2, 0.2],
      }),
  },
  {
    id: 'shakuhachi',
    name: 'Shakuhachi',
    category: 'leads',
    description: 'The Japanese bamboo flute: breathy, bending into each note, with a deep wavering vibrato.',
    tip: 'Slow, sparse phrases with long notes, on a pentatonic scale.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 4.5, depth: 0.008, delay: 0.7 },
        oscs: [{ wave: 3, level: 0.5, envPitch: -0.05, pitchDecay: 0.15 }, { wave: 2, level: 0.15, envPitch: -0.05, pitchDecay: 0.15 }],
        noise: { level: 0.2, color: 0.55 },
        filter: { cutoff: 1800, res: 0.1, track: 1 },
        amp: [0.08, 0.4, 0.85, 0.25],
        room: [0.7, 2.5, 0.3],
      }),
  },
  {
    id: 'bagpipe',
    name: 'Bagpipe lead',
    category: 'leads',
    description: 'A nasal, reedy chanter over a drone on C that never stops while a note is held.',
    tip: 'Highland tunes in C or G, with quick grace notes. The drone is on C.',
    make: () =>
      synth({
        base: C4,
        oscs: [{ wave: 1, width: 0.3, level: 0.45 }, { wave: 0, level: 0.15 }, { wave: 0, fixed: C2, level: 0.1 }, { wave: 0, fixed: C3, level: 0.08 }],
        filter: { svf: true, mode: 4, cutoff: 1400, res: 0.55, track: 0.6 },
        amp: [0.02, 0.3, 0.95, 0.15],
        room: [0.6, 1.8, 0.2],
      }),
  },
  {
    id: 'guitarlead',
    name: 'Lead guitar',
    category: 'leads',
    description: 'A distorted, singing guitar lead with a wide vibrato on held notes.',
    tip: 'Rock solos: bends, fast runs and one long note at the end of the phrase.',
    make: () =>
      synth({
        base: C3,
        glide: 0.02,
        vib: { rate: 5.5, depth: 0.01, delay: 0.5 },
        oscs: [{ wave: 0, level: 0.4 }, { wave: 1, ratio: 1.003, width: 0.4, level: 0.25 }],
        drive: { drive: 12, level: 0.3, pre: true },
        filter: { svf: true, mode: 0, cutoff: 3000, res: 0.2, track: 0.3 },
        amp: [0.003, 1, 0.75, 0.15],
        room: [0.5, 1.5, 0.2],
      }),
  },
  {
    id: 'harplead',
    name: 'Harmonica lead',
    category: 'leads',
    description: 'A blues harp played as a lead: reedy, bending into notes, with a pulsing tremolo.',
    tip: 'Blues licks: bend up into the long notes and leave gaps between phrases.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 6, depth: 0.005, delay: 0.3 },
        oscs: [{ wave: 1, width: 0.35, level: 0.4, envPitch: -0.06, pitchDecay: 0.1 }, { wave: 0, ratio: 1.003, level: 0.15, envPitch: -0.06, pitchDecay: 0.1 }],
        noise: { level: 0.05 },
        filter: { svf: true, mode: 4, cutoff: 1300, res: 0.5, track: 0.7 },
        amp: [0.02, 0.3, 0.9, 0.1],
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'gameboylead',
    name: 'Gameboy lead',
    category: 'leads',
    description: 'A thin 12.5% pulse, crunched down: the sound of a handheld from 1989.',
    tip: 'Fast, bouncy melodies. Pair it with the Chiptune bass and the Chiptune Kit.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 6, depth: 0.006, delay: 0.35 },
        oscs: [{ wave: 1, width: 0.125, level: 0.6 }],
        crush: { bits: 5, rate: 22050, mix: 1 },
        filter: { cutoff: 9000, res: 0, track: 0 },
        amp: [0.001, 0.2, 0.85, 0.05],
      }),
  },
  {
    id: 'sidlead',
    name: 'SID lead',
    category: 'leads',
    description: 'The Commodore 64: a pulse whose width sweeps as it plays, through a resonant filter.',
    tip: 'Fast arpeggios and soaring melodies, like a 1986 game\'s title screen.',
    make: () =>
      synth({
        base: C4,
        pwmRate: 1.2,
        oscs: [{ wave: 1, width: 0.5, level: 0.5, pwm: true }],
        crush: { bits: 8, rate: 18000, mix: 0.5 },
        filter: { cutoff: 1800, res: 0.45, track: 0.7, env: [0.001, 0.3, 0.4, 0.1], envAmount: 1.5 },
        amp: [0.002, 0.3, 0.85, 0.1],
      }),
  },
  {
    id: 'laserlead',
    name: 'Laser lead',
    category: 'leads',
    description: 'Every note zaps down from on high into its pitch: sci-fi and arcade.',
    tip: 'Short, staccato notes, each its own little laser.',
    make: () =>
      synth({
        base: C4,
        oscs: [{ wave: 0, level: 0.45, envPitch: 2, pitchDecay: 0.05 }],
        filter: { svf: true, mode: 0, cutoff: 3500, res: 0.4, track: 0.5 },
        amp: [0.001, 0.25, 0.6, 0.1],
        delay: { time: 0.25, feedback: 0.35, mix: 0.25 },
        room: [0.4, 1, 0.12],
      }),
  },
  {
    id: 'chimelead',
    name: 'Chime lead',
    category: 'leads',
    description: 'A bell-like FM lead that holds its note: glassy, dreamy and sweet.',
    tip: 'Slow, dreamy melodies over pads. Lovely an octave up.',
    make: () =>
      build(
        played(1),
        fm({ base: C4, ratio: 3, index: 1, bright: env(0.001, 0.6, 0.25, 0.3), body: env(0.002, 0.8, 0.8, 0.4), level: 0.55 }),
        units([['dly1', 'delay', { time: 0.42, feedback: 0.35, damping: 0.5, mix: 0.22 }]], 'vca2.out -> dly1.in'),
        room('dly1.out', 0.7, 2.5, 0.28),
        out(STEREO_OUT),
      ),
  },
  {
    id: 'glasslead',
    name: 'Glass lead',
    category: 'leads',
    description: 'A clean sine with a ring-modulated shimmer: high, clear and fragile.',
    tip: 'Simple melodies high up, with space around them.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 5, depth: 0.003, delay: 0.5 },
        oscs: [{ wave: 3, level: 0.5 }],
        extra: {
          units: [
            ['osc8', 'osc', { pitch: C4 * 2, wave: 3 }],
            ['osc9', 'osc', { pitch: C4 * 3, wave: 3 }],
            ['ring1', 'ring', { mix: 1 }],
            ['cvR', 'cv', { gain1: 0.2 }],
          ],
          cables: ['key1.pitch -> osc8.pitch', 'key1.pitch -> osc9.pitch', 'osc8.out -> ring1.in', 'osc9.out -> ring1.car', 'ring1.out -> cvR.in1'],
          into: ['cvR.out1'],
        },
        filter: { cutoff: 8000, res: 0, track: 0 },
        amp: [0.01, 0.4, 0.85, 0.3],
        delay: { time: 0.4, feedback: 0.35, mix: 0.2 },
        room: [0.7, 2.5, 0.3],
      }),
  },
  {
    id: 'trancepluck',
    name: 'Trance pluck lead',
    category: 'leads',
    description: 'A short supersaw pluck into a long echo: the trance riff.',
    tip: 'Offbeat sixteenth-note riffs, the echo filling the gaps between them.',
    make: () =>
      synth({
        base: C4,
        voices: 6,
        oscs: [{ wave: 0, ratio: 0.9985, level: 0.2 }, { wave: 0, level: 0.2 }, { wave: 0, ratio: 1.0015, level: 0.2 }],
        filter: { cutoff: 700, res: 0.2, track: 0.6, env: [0.001, 0.15, 0, 0.1], envAmount: 3 },
        amp: [0.001, 0.25, 0, 0.15],
        delay: { time: 0.375, feedback: 0.45, mix: 0.28 },
        room: [0.7, 2.2, 0.25],
      }),
  },
  {
    id: 'dirtylead',
    name: 'Dirty lead',
    category: 'leads',
    description: 'A saw and a square crushed and driven until they spit: electro and dubstep.',
    tip: 'Short, aggressive hooks. Slide between notes for extra snarl.',
    make: () =>
      synth({
        base: C3,
        glide: 0.03,
        oscs: [{ wave: 0, level: 0.35 }, { wave: 1, ratio: 1.004, width: 0.3, level: 0.3 }],
        crush: { bits: 7, rate: 14000, mix: 0.7 },
        drive: { drive: 6, level: 0.35 },
        filter: { cutoff: 2500, res: 0.3, drive: 2, track: 0.5 },
        amp: [0.002, 0.3, 0.9, 0.08],
      }),
  },
  {
    id: 'formantlead',
    name: 'Formant lead',
    category: 'leads',
    description: 'A lead whose vowel slowly morphs from "ooo" to "aaa" as the note is held.',
    tip: 'Long notes, so the vowel has time to open. Sounds sung rather than played.',
    make: () =>
      synth({
        base: C4,
        vib: { rate: 5.2, depth: 0.005, delay: 0.5 },
        oscs: [{ wave: 0, level: 0.5 }],
        filter: { cutoff: 5000, res: 0.05, track: 0.2 },
        vowel: { vowel: 0, res: 0.7, env: [1.2, 0.5, 1, 0.3], amount: 2 },
        amp: [0.02, 0.3, 0.9, 0.2],
        room: [0.5, 1.5, 0.2],
      }),
  },

  // --- each kit's drums, on their own ---------------------------------------
  ...KITS.flatMap(kitDrums),
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

/**
 * One of the kits in `kits.ts` as a library instrument: its Drum Kit and what
 * follows it, each pad loaded with its own rack or one of this shelf's drums.
 */
function kitInstrument(def: KitDef): Instrument {
  return {
    id: def.id,
    name: def.name,
    category: 'drums',
    description: def.description,
    tip: def.tip,
    make: () => {
      const built = kitShell(def)
      let patch = built.patch
      const values = { ...built.values }
      def.pads.forEach((pad, i) => {
        let b: Built
        if (typeof pad.sound === 'function') b = pad.sound()
        else {
          // Looked up when the kit is made: the drums are further down the list.
          const id = pad.sound.instrument
          const inst = INSTRUMENTS.find((x) => x.id === id)
          if (!inst) throw new Error(`${def.name} wants "${id}", which is not on the shelf`)
          b = inst.make()
        }
        patch = setKitSlot(patch, 'kit1', i, { name: pad.name, note: pad.note, patch: padPatch(b.patch, b.values) })
        if (pad.choke) values[`kit1.choke${i + 1}`] = pad.choke
        if (pad.level !== undefined) values[`kit1.level${i + 1}`] = pad.level
        if (pad.pan !== undefined) values[`kit1.pan${i + 1}`] = pad.pan
      })
      return { patch, values }
    },
  }
}

/**
 * A chorus straight to the console, wide, with a room beside it rather than
 * after it: the room takes one side of the chorus in, so it would fold the
 * width back to the middle. The chorus is on 1 and 2 and the room on 3 and 4,
 * which `wideOut` is the console for.
 */
function wide(
  from: string,
  chorus: { mode: number; rate: number; depth: number; center: number; feedback: number; mix: number },
  size: number,
  decay: number,
) {
  return {
    units: [
      ['cho1', 'chorus', chorus] as Unit,
      // All wet: how much room there is, is its level on the console.
      ['spc1', 'reverb', { size, decay, damping: 0.4, mix: 1 }] as Unit,
    ],
    cables: [
      `${from} -> cho1.in`,
      `${from} -> spc1.in`,
      'cho1.l -> mix1.in1',
      'cho1.r -> mix1.in2',
      'spc1.l -> mix1.in3',
      'spc1.r -> mix1.in4',
    ],
  }
}

/** The console for `wide`: the chorus on 1 and 2, the room on 3 and 4. */
function wideOut(room: number): Unit {
  return ['mix1', 'mixer', { pan1: -1, pan2: 1, level1: 0.8, level2: 0.8, pan3: -1, pan4: 1, level3: room, level4: room }]
}

/**
 * A kit's own drums as instruments of their own, under the kit's name on the
 * Drums shelf, so a new kit can be made from any of them. A pad that is one
 * of this shelf's drums already is left out: it is on the shelf.
 */
function kitDrums(def: KitDef): Instrument[] {
  return def.pads.flatMap((pad) => {
    const sound = pad.sound
    if (typeof sound !== 'function') return []
    const name = kitDrumName(def, pad)
    const drum: Instrument = {
      id: `${def.id}-${pad.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
      name,
      category: 'drums',
      group: def.name,
      description: `From the ${def.name}: its ${kitDrumRest(def, pad)}, on its own.`,
      tip: `In the ${def.name} it is on ${noteName(pad.note)} (${pad.note}). Load it into any kit's pad.`,
      make: sound,
    }
    if (pad.held) drum.held = true
    return [drum]
  })
}

/** "808 rim", "World udu": the kit's short name, then the drum. */
function kitDrumName(def: KitDef, pad: KitPad): string {
  return `${def.short} ${kitDrumRest(def, pad)}`
}

/** The drum without its kit: "rim", "long kick", "tabla \"na\"". */
function kitDrumRest(def: KitDef, pad: KitPad): string {
  const own = pad.name.toLowerCase().startsWith(`${def.short.toLowerCase()} `) ? pad.name.slice(def.short.length + 1) : pad.name
  return /^[A-Z][a-z]/.test(own) ? own[0].toLowerCase() + own.slice(1) : own
}

/** A MIDI note as the roll names it: 36 is C2. */
function noteName(note: number): string {
  return `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note % 12]}${Math.floor(note / 12) - 1}`
}

/**
 * One bowed string, as the Solo cello is made: a saw through a filter that
 * follows the note, a wooden body, and vibrato that comes in as the note is
 * held, the way a player's does. Ends at `vca1.out`.
 */
interface Bowed {
  base: number
  /** How bright, at the bottom key; it follows the note up. */
  cutoff: number
  /** The body's resonance, and how pronounced it is. */
  body: number
  bodyRes: number
  attack: number
  vibRate: number
  /** In octaves. */
  vibDepth: number
  /** How long the vibrato takes to arrive, in seconds. */
  vibIn: number
  /** The scrape of the bow at the start of each note, 0..1. */
  rosin?: number
  /** A Drive after the body, for a bow dug in hard. */
  grit?: number
  /** Each note slides up into its pitch from this far below, in octaves. */
  slide?: number
}

function bowed(o: Bowed): { units: Unit[]; cables: string[] } {
  const list: Unit[] = [
    ['lfo1', 'lfo', { rate: o.vibRate, shape: 3 }],
    ['env1', 'adsr', { attack: o.vibIn, decay: 0.1, sustain: 1, release: 0.3 }],
    ['vca2', 'vca', { level: 0, cvAmount: 1 }],
    ['cv1', 'cv', { gain1: o.vibDepth, gain2: -(o.slide ?? 0) }],
    ['osc1', 'osc', { pitch: o.base, wave: 0, fmAmount: 1, level: 0.45, ...env(o.attack, 0.3, 0.9, 0.25) }],
    ['lpf1', 'ladder', { mode: 1, cutoff: o.cutoff, resonance: 0.1, drive: 1.2, cvAmount: 0.8 }],
    ['mmf1', 'svf', { mode: 4, cutoff: o.body, resonance: o.bodyRes, cvAmount: 0 }],
    ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
  ]
  const cables = [
    'lfo1.out -> vca2.in',
    'key1.gate -> env1.gate',
    'env1.out -> vca2.cv',
    'vca2.out -> cv1.in1',
    'cv1.sum -> osc1.fm',
    'key1.pitch -> osc1.pitch',
    'key1.gate -> osc1.gate',
    'key1.pitch -> lpf1.cv',
    'lpf1.out -> mmf1.in',
    'key1.vel -> vca1.cv',
  ]
  if (o.slide) {
    // Falls from one to nothing as the note starts: the pitch rises to meet it.
    list.push(['env2', 'adsr', { attack: 0.0005, decay: 0.08, sustain: 0, release: 0.05 }])
    cables.push('key1.gate -> env2.gate', 'env2.out -> cv1.in2')
  }
  if (o.rosin) {
    list.push(
      ['noise1', 'noise', {}],
      ['bpf1', 'svf', { mode: 1, cutoff: 2500, resonance: 0.3, cvAmount: 0 }],
      ['env3', 'adsr', { attack: 0.005, decay: 0.12, sustain: 0.15, release: 0.1 }],
      ['vca3', 'vca', { level: 0, cvAmount: o.rosin }],
      ['cv2', 'cv', {}],
    )
    cables.push(
      'noise1.out -> bpf1.in',
      'bpf1.out -> vca3.in',
      'key1.gate -> env3.gate',
      'env3.out -> vca3.cv',
      'osc1.out -> cv2.in1',
      'vca3.out -> cv2.in2',
      'cv2.sum -> lpf1.in',
    )
  } else cables.push('osc1.out -> lpf1.in')
  if (o.grit) {
    list.push(['drv1', 'drive', { drive: o.grit, level: 0.6 }])
    cables.push('mmf1.out -> drv1.in', 'drv1.out -> vca1.in')
  } else cables.push('mmf1.out -> vca1.in')
  return { units: list, cables }
}

/**
 * A string section, as the String ensemble is made: two detuned saws with
 * vibrato, a filter that follows the note, a body, and a slow chorus that
 * makes two players a section. Ends at `dly1.out`.
 */
interface Section {
  base: number
  /** How far apart the two players are, as a ratio either side. */
  detune: number
  cutoff: number
  body: number
  bodyRes?: number
  attack: number
  release: number
  decay?: number
  sustain?: number
  /** How loud the players are, against the String ensemble's at 1. */
  level?: number
  /** How far the filter opens with the swell, in octaves. */
  open?: number
  /** A high-pass first: bowed by the bridge, the bottom falls away. */
  thin?: number
}

function section(o: Section): { units: Unit[]; cables: string[] } {
  const amp = env(o.attack, o.decay ?? 0.5, o.sustain ?? 1, o.release)
  const level = 0.3 * (o.level ?? 0.9)
  const list: Unit[] = [
    ['lfo1', 'lfo', { rate: 5.2, shape: 2 }],
    ['osc1', 'osc', { pitch: o.base * (1 - o.detune), wave: 0, fmAmount: 0.006, level, ...amp }],
    ['osc2', 'osc', { pitch: o.base * (1 + o.detune), wave: 0, fmAmount: 0.006, level, ...amp }],
    ['cv1', 'cv', {}],
    ['lpf1', 'ladder', { cutoff: o.cutoff, resonance: 0.1, drive: 1, cvAmount: 1 }],
    ['mmf1', 'svf', { mode: 4, cutoff: o.body, resonance: o.bodyRes ?? 0.35, cvAmount: 0 }],
    ['vca1', 'vca', { level: 0.4, cvAmount: 0.6 }],
    ['lfo2', 'lfo', { rate: 0.35, shape: 2 }],
    ['dly1', 'delay', { time: 0.012, cvAmount: 0.35, feedback: 0.15, damping: 0.3, mix: 0.45 }],
  ]
  const cables = [
    'lfo1.out -> osc1.fm',
    'lfo1.out -> osc2.fm',
    'key1.pitch -> osc1.pitch',
    'key1.pitch -> osc2.pitch',
    'key1.gate -> osc1.gate',
    'key1.gate -> osc2.gate',
    'osc1.out -> cv1.in1',
    'osc2.out -> cv1.in2',
    'lpf1.out -> mmf1.in',
    'mmf1.out -> vca1.in',
    'key1.vel -> vca1.cv',
    'vca1.out -> dly1.in',
    'lfo2.out -> dly1.cv',
  ]
  if (o.thin) {
    list.push(['hpf1', 'svf', { mode: 2, cutoff: o.thin, resonance: 0.2, cvAmount: 1 }])
    cables.push('cv1.sum -> hpf1.in', 'key1.pitch -> hpf1.cv', 'hpf1.out -> lpf1.in')
  } else cables.push('cv1.sum -> lpf1.in')
  if (o.open) {
    // The filter follows the note, and opens with the swell besides.
    list.push(
      ['env1', 'adsr', { attack: o.attack, decay: 0.5, sustain: 1, release: o.release }],
      ['cv2', 'cv', { gain1: 0.6, gain2: o.open }],
    )
    cables.push('key1.pitch -> cv2.in1', 'key1.gate -> env1.gate', 'env1.out -> cv2.in2', 'cv2.sum -> lpf1.cv')
  } else {
    list.push(['cv2', 'cv', { gain1: 0.6 }])
    cables.push('key1.pitch -> cv2.in1', 'cv2.out1 -> lpf1.cv')
  }
  return { units: list, cables }
}

/**
 * The shape most basses and leads share, described rather than wired:
 * oscillators summed, a shaper, a filter with its own envelope or LFO, the
 * note's envelope, velocity, and an effect or two. Anything one of them needs
 * beyond that -- a ring modulator, a click, a drone -- comes in as `extra`.
 */
interface SynthOsc {
  wave: number
  /** Its pitch against the bottom key's: 0.5 an octave down, 2 an octave up. */
  ratio?: number
  level: number
  width?: number
  /** Its width swept by the shared PWM LFO. */
  pwm?: true
  /**
   * Each note starts this many octaves off -- above, or below if negative --
   * and settles onto its pitch over `pitchDecay`.
   */
  envPitch?: number
  pitchDecay?: number
  /** Not played by the keys at all: a drone at this many hertz. */
  fixed?: number
}

interface Synth {
  base: number
  voices?: number
  /** Portamento, in seconds: each note slides from the last. */
  glide?: number
  /** Vibrato, in octaves; `delay` brings it in as the note is held. */
  vib?: { rate: number; depth: number; delay?: number }
  oscs: SynthOsc[]
  /** A Unison Oscillator on the note, alongside or instead of `oscs`. */
  unison?: { wave: number; voices: number; detune: number; level: number }
  pwmRate?: number
  noise?: { level: number; color?: number }
  /** Signals made in `extra`, added to the oscillators before the filter. */
  extra?: { units: Unit[]; cables: string[]; into?: string[]; after?: string[] }
  fold?: { fold: number; symmetry?: number; lfoRate?: number; lfoAmount?: number }
  /** Driven before the filter, as an amp is, or after it. */
  drive?: { drive: number; level?: number; pre?: true }
  crush?: { bits: number; rate: number; mix?: number }
  filter: {
    svf?: true
    mode?: number
    cutoff: number
    res: number
    drive?: number
    /** How far the cutoff follows the note, 0..1. */
    track?: number
    env?: [number, number, number, number]
    /** How far the envelope opens it, in octaves. */
    envAmount?: number
    lfo?: { rate: number; amount: number; shape?: number }
  }
  /** A mouth after the filter: a vowel, moved by its own envelope or an LFO. */
  vowel?: { vowel: number; res: number; size?: number; env?: [number, number, number, number]; amount?: number; lfo?: { rate: number; amount: number } }
  amp: [number, number, number, number]
  delay?: { time: number; feedback: number; mix: number; damping?: number }
  room?: [number, number, number]
}

function synth(o: Synth): Built {
  const u: Unit[] = []
  const c: string[] = []
  let pitch = 'key1.pitch'
  if (o.glide) {
    u.push(['slew1', 'slew', { rise: o.glide, fall: o.glide, shape: 0 }])
    c.push('key1.pitch -> slew1.in')
    pitch = 'slew1.out'
  }
  let vib: string | null = null
  if (o.vib) {
    u.push(['lfoV', 'lfo', { rate: o.vib.rate, shape: 3 }])
    vib = 'lfoV.out'
    if (o.vib.delay) {
      u.push(['envV', 'adsr', { attack: o.vib.delay, decay: 0.1, sustain: 1, release: 0.2 }], ['vcaV', 'vca', { level: 0, cvAmount: 1 }])
      c.push('lfoV.out -> vcaV.in', 'key1.gate -> envV.gate', 'envV.out -> vcaV.cv')
      vib = 'vcaV.out'
    }
  }
  if (o.oscs.some((x) => x.pwm)) u.push(['lfoP', 'lfo', { rate: o.pwmRate ?? 0.5, shape: 2 }])
  // Oscillators detuned around the note are centred on it, however the
  // detune was written: one at 1 and one at 1.004 would sit sharp of the key.
  const unison = o.oscs.filter((x) => !x.fixed && Math.abs(Math.log2(x.ratio ?? 1)) < 0.02).map((x) => x.ratio ?? 1)
  const centre = unison.length ? Math.exp(unison.reduce((a, r) => a + Math.log(r), 0) / unison.length) : 1
  const outs: string[] = []
  o.oscs.forEach((x, i) => {
    const id = `osc${i + 1}`
    const p: Record<string, number> = { pitch: x.fixed ?? (o.base * (x.ratio ?? 1)) / centre, wave: x.wave, level: x.level }
    if (x.width !== undefined) p.width = x.width
    if (vib && !x.fixed) p.fmAmount = o.vib!.depth
    // The oscillator's own envelope moves only its pitch; the note's level is the Envelope below.
    if (x.envPitch) Object.assign(p, { envAmount: 0, envPitch: x.envPitch, attack: 0.0005, decay: x.pitchDecay ?? 0.1, sustain: 0, release: 0.05 })
    u.push([id, 'osc', p])
    if (!x.fixed) c.push(`${pitch} -> ${id}.pitch`)
    if (x.envPitch) c.push(`key1.gate -> ${id}.gate`)
    if (vib && !x.fixed) c.push(`${vib} -> ${id}.fm`)
    if (x.pwm) c.push(`lfoP.out -> ${id}.pwm`)
    outs.push(`${id}.out`)
  })
  if (o.unison) {
    const x = o.unison
    const p: Record<string, number> = { pitch: o.base, wave: x.wave, voices: x.voices, detune: x.detune, width: 0, level: x.level }
    if (vib) p.fmAmount = o.vib!.depth
    u.push(['uni1', 'unison', p])
    c.push(`${pitch} -> uni1.pitch`)
    if (vib) c.push(`${vib} -> uni1.fm`)
    outs.push('uni1.out')
  }
  if (o.noise) {
    u.push(['noise1', 'noise', { color: o.noise.color ?? 0.5, level: o.noise.level }])
    outs.push('noise1.out')
  }
  if (o.extra) {
    u.push(...o.extra.units)
    c.push(...o.extra.cables)
    outs.push(...(o.extra.into ?? []))
  }
  let n = 0
  const sum = (signals: string[]) => {
    let at = signals[0]
    for (let i = 1; i < signals.length; i++) {
      const id = `sum${++n}`
      u.push([id, 'cv', {}])
      c.push(`${at} -> ${id}.in1`, `${signals[i]} -> ${id}.in2`)
      at = `${id}.sum`
    }
    return at
  }
  let sig = sum(outs)

  if (o.fold) {
    u.push(['fold1', 'fold', { fold: o.fold.fold, symmetry: o.fold.symmetry ?? 0, cvAmount: o.fold.lfoAmount ?? 0 }])
    c.push(`${sig} -> fold1.in`)
    sig = 'fold1.out'
    if (o.fold.lfoRate) {
      u.push(['lfoW', 'lfo', { rate: o.fold.lfoRate, shape: 3 }])
      c.push('lfoW.out -> fold1.cv')
    }
  }
  if (o.drive?.pre) {
    u.push(['drv1', 'drive', { drive: o.drive.drive, level: o.drive.level ?? 0.5 }])
    c.push(`${sig} -> drv1.in`)
    sig = 'drv1.out'
  }

  // The filter, its cutoff moved by the note, an envelope and an LFO at once.
  const f = o.filter
  const moves: [string, number][] = [[pitch, f.track ?? 0.5]]
  if (f.env) {
    u.push(['envF', 'adsr', { attack: f.env[0], decay: f.env[1], sustain: f.env[2], release: f.env[3] }])
    c.push('key1.gate -> envF.gate')
    moves.push(['envF.out', f.envAmount ?? 2])
  }
  if (f.lfo) {
    u.push(['lfoF', 'lfo', { rate: f.lfo.rate, shape: f.lfo.shape ?? 3 }])
    moves.push(['lfoF.out', f.lfo.amount])
  }
  // A CV utility's gains stop at 2: anything more is made up on the filter's own amount.
  const scale = Math.max(1, ...moves.map(([, g]) => Math.abs(g) / 2))
  if (f.svf) u.push(['flt1', 'svf', { mode: f.mode ?? 0, cutoff: f.cutoff, resonance: f.res, cvAmount: scale }])
  else u.push(['flt1', 'ladder', { mode: f.mode ?? 0, cutoff: f.cutoff, resonance: f.res, drive: f.drive ?? 1, cvAmount: scale }])
  c.push(`${sig} -> flt1.in`)
  sig = 'flt1.out'
  let move = ''
  moves.forEach(([from, gain], i) => {
    const id = `cvF${i + 1}`
    if (i === 0) {
      u.push([id, 'cv', { gain1: gain / scale }])
      c.push(`${from} -> ${id}.in1`)
      move = `${id}.out1`
    } else {
      u.push([id, 'cv', { gain1: 1, gain2: gain / scale }])
      c.push(`${move} -> ${id}.in1`, `${from} -> ${id}.in2`)
      move = `${id}.sum`
    }
  })
  c.push(`${move} -> flt1.cv`)

  if (o.extra?.after?.length) sig = sum([sig, ...o.extra.after])
  if (o.vowel) {
    const v = o.vowel
    u.push(['fmt1', 'formant', { vowel: v.vowel, size: v.size ?? 1, res: v.res, vowelAmount: v.lfo?.amount ?? v.amount ?? 2 }])
    c.push(`${sig} -> fmt1.in`)
    sig = 'fmt1.out'
    if (v.env) {
      u.push(['envO', 'adsr', { attack: v.env[0], decay: v.env[1], sustain: v.env[2], release: v.env[3] }])
      c.push('key1.gate -> envO.gate', 'envO.out -> fmt1.vowel')
    } else if (v.lfo) {
      u.push(['lfoO', 'lfo', { rate: v.lfo.rate, shape: 3 }])
      c.push('lfoO.out -> fmt1.vowel')
    }
  }
  if (o.crush) {
    u.push(['crs1', 'crush', { bits: o.crush.bits, rate: o.crush.rate, mix: o.crush.mix ?? 1 }])
    c.push(`${sig} -> crs1.in`)
    sig = 'crs1.out'
  }
  if (o.drive && !o.drive.pre) {
    u.push(['drv1', 'drive', { drive: o.drive.drive, level: o.drive.level ?? 0.5 }])
    c.push(`${sig} -> drv1.in`)
    sig = 'drv1.out'
  }

  // The note's envelope, then velocity, as two VCAs.
  u.push(
    ['envA', 'adsr', { attack: o.amp[0], decay: o.amp[1], sustain: o.amp[2], release: o.amp[3] }],
    ['vcaA', 'vca', { level: 0, cvAmount: 1 }],
    ['vca1', 'vca', { level: 0.3, cvAmount: 0.7 }],
  )
  c.push('key1.gate -> envA.gate', `${sig} -> vcaA.in`, 'envA.out -> vcaA.cv', 'vcaA.out -> vca1.in', 'key1.vel -> vca1.cv')
  sig = 'vca1.out'
  if (o.delay) {
    u.push(['dly1', 'delay', { time: o.delay.time, feedback: o.delay.feedback, damping: o.delay.damping ?? 0.45, mix: o.delay.mix }])
    c.push(`${sig} -> dly1.in`)
    sig = 'dly1.out'
  }
  const ends = o.room ? [room(sig, o.room[0], o.room[1], o.room[2]), out(STEREO_OUT)] : [out(MONO_OUT, `${sig} -> mix1.in1`)]
  return build(played(o.voices ?? 1), { units: u, cables: c }, ...ends)
}
