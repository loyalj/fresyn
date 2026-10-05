import { rack, type Built, type Unit } from './build'

/**
 * The library's drum kits beyond the standard one: a Drum Kit module with
 * sixteen pads loaded, and the kit's own sound after it -- glue, tape, drive
 * or a hall.
 *
 * Every kit keeps General MIDI's notes for the drums General MIDI has -- kick
 * on 36, snare on 38, hats on 42 and 46, toms, crash, ride -- so a drum part
 * from a MIDI file, or a groove from the Rhythm utility, plays on any of them
 * unchanged. A kit's own sounds -- a hat roll, an anvil, a riser -- sit on
 * notes General MIDI leaves free or gives to something they stand in for.
 *
 * Most pads are built here from a handful of recipes, each a drum with knobs
 * of its own: a kick, a snare, a hat, a clap, a burst of noise, a metal hit,
 * a struck body, a chip blip. A few are the library's own drums, named by id
 * and loaded as they are; `instruments.ts` resolves those, since it holds them.
 */

export interface KitPad {
  name: string
  /** The MIDI note it plays on. */
  note: number
  /** A choke group, 1..4: pads in one cut each other off, as a pair of hats do. */
  choke?: number
  /** The kit's level for it, 0..1. Absent is the kit's default. */
  level?: number
  /** -1..1. */
  pan?: number
  /**
   * Sounds for as long as its note is held -- a roll, a swell, a crackle --
   * rather than being fired and left to finish.
   */
  held?: true
  /** Built here, or one of the library's drums by id. */
  sound: (() => Built) | { instrument: string }
}

/** What follows the kit: the sound of the whole kit together. */
export type KitAfter = 'none' | 'glue' | 'tape' | 'drive' | 'hall'

export interface KitDef {
  id: string
  name: string
  /** What its drums are called by on the shelf: "808 rim", "World udu". */
  short: string
  description: string
  tip: string
  after: KitAfter
  pads: KitPad[]
}

// --- recipes -----------------------------------------------------------------

/**
 * How hard a drum is hit: the Trigger's Vel into a VCA just before the way
 * out, a quarter open at the softest so a ghost note is quiet rather than
 * gone. As every drum on the shelf does it.
 */
const TOUCH = { level: 0.25, cvAmount: 0.75 }

/** Fired once by the note, or rolled: the note fires a Burst, whose pulses fire the drum. */
interface Hit {
  /** How loud the drum leaves its rack, 0..1. */
  level?: number
  /** A roll for as long as the note is held: so many strokes, so fast (Hz). */
  roll?: { count: number; rate: number; jitter?: number }
  /** A room of its own, on the way out. */
  room?: { size: number; decay: number; mix: number }
  /**
   * Made louder before the touch VCA, up to 2: for a drum that is quiet by
   * nature -- a breath of noise, a muffled skin -- and has to stand on its
   * own on the shelf as well as in its kit.
   */
  gain?: number
}

/**
 * A drum from its parts. `$T` in a cable is what fires it -- the Trigger's
 * gate, or a Burst's when it rolls -- and `last` is the drum's sound, which
 * goes through the touch VCA, any room, and out.
 */
function drum(parts: Unit[], cables: string[], last: string, hit: Hit = {}): Built {
  const fire = hit.roll ? 'brst1.gate' : 'gate1.gate'
  const units: Unit[] = [['gate1', 'gate']]
  const wires: string[] = []
  if (hit.roll) {
    units.push(['brst1', 'burst', { count: hit.roll.count, rate: hit.roll.rate, jitter: hit.roll.jitter ?? 0.1, width: 0.3 }])
    wires.push('gate1.gate -> brst1.trig')
  }
  units.push(...parts)
  wires.push(...cables.map((c) => c.replace(/\$T/g, fire)))
  if (hit.gain) {
    units.push(['gainT', 'cv', { gain1: hit.gain }])
    wires.push(`${last} -> gainT.in1`)
    last = 'gainT.out1'
  }
  units.push(['vcaT', 'vca', TOUCH])
  wires.push(`${last} -> vcaT.in`, 'gate1.vel -> vcaT.cv')
  const level = hit.level ?? 0.8
  if (hit.room) {
    units.push(['spc1', 'reverb', { size: hit.room.size, decay: hit.room.decay, mix: hit.room.mix, damping: 0.4 }])
    units.push(['mix1', 'mixer', { level1: level, level2: level, pan1: -1, pan2: 1 }])
    wires.push('vcaT.out -> spc1.in', 'spc1.l -> mix1.in1', 'spc1.r -> mix1.in2')
  } else {
    units.push(['mix1', 'mixer', { level1: level }])
    wires.push('vcaT.out -> mix1.in1')
  }
  return rack(units, wires)
}

/** An oscillator's own envelope, amplitude only. */
const env = (attack: number, decay: number, sustain = 0, release = decay) => ({ envAmount: 1, attack, decay, sustain, release })

/**
 * A kick, or a tom: a sine whose pitch drops fast from `drop` octaves above
 * `pitch`, the drop taking `dropTime`, into a Drive. `click` adds a few
 * milliseconds of bright noise on top, for a kick that cuts through.
 */
function kick(o: { pitch: number; drop: number; dropTime: number; decay: number; drive?: number; click?: number; wave?: number } & Hit): Built {
  const parts: Unit[] = [
    ['env1', 'adsr', { attack: 0.0005, decay: o.dropTime, sustain: 0, release: o.dropTime }],
    ['osc1', 'osc', { pitch: o.pitch, wave: o.wave ?? 3, fmAmount: o.drop, level: 0.9, ...env(0.0005, o.decay) }],
    ['drv1', 'drive', { drive: o.drive ?? 2.5, level: 0.7 }],
  ]
  const cables = ['$T -> env1.gate', '$T -> osc1.gate', 'env1.out -> osc1.fm', 'osc1.out -> drv1.in']
  if (!o.click) return drum(parts, cables, 'drv1.out', o)
  parts.push(
    ['noise1', 'noise', {}],
    ['hp1', 'svf', { mode: 2, cutoff: 3500, resonance: 0.1 }],
    ['env2', 'adsr', { attack: 0.0005, decay: 0.006, sustain: 0, release: 0.006 }],
    ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ['cv1', 'cv', { gain1: 1, gain2: o.click }],
  )
  cables.push('noise1.out -> hp1.in', 'hp1.out -> vca1.in', '$T -> env2.gate', 'env2.out -> vca1.cv', 'drv1.out -> cv1.in1', 'vca1.out -> cv1.in2')
  return drum(parts, cables, 'cv1.sum', o)
}

/**
 * A snare: a short tone for the drum and filtered noise for the wires,
 * balanced in one sum. `mode` is the Ladder's: 2 band-pass, 3 high-pass.
 */
function snare(o: {
  tone: number
  toneDecay: number
  cutoff: number
  noiseDecay: number
  mode?: number
  toneGain?: number
  noiseGain?: number
  bend?: number
  wave?: number
} & Hit): Built {
  return drum(
    [
      ['osc1', 'osc', { pitch: o.tone, wave: o.wave ?? 2, level: 0.6, envPitch: o.bend ?? 0.3, ...env(0.0005, o.toneDecay) }],
      ['noise1', 'noise', {}],
      ['lpf1', 'ladder', { mode: o.mode ?? 3, cutoff: o.cutoff, resonance: 0.1, drive: 1, cvAmount: 0 }],
      ['env1', 'adsr', { attack: 0.0005, decay: o.noiseDecay, sustain: 0, release: o.noiseDecay }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
      ['cv1', 'cv', { gain1: o.toneGain ?? 0.75, gain2: o.noiseGain ?? 0.7 }],
    ],
    ['$T -> osc1.gate', '$T -> env1.gate', 'noise1.out -> lpf1.in', 'lpf1.out -> vca1.in', 'env1.out -> vca1.cv', 'osc1.out -> cv1.in1', 'vca1.out -> cv1.in2'],
    'cv1.sum',
    o,
  )
}

/**
 * A hi-hat or a cymbal: two square waves ring-modulated for the metal, noise
 * for the sizzle, through a high-pass, cut short or left to ring.
 */
function hat(o: { decay: number; cutoff?: number; f1?: number; f2?: number; metal?: number; attack?: number } & Hit): Built {
  return drum(
    [
      ['noise1', 'noise', {}],
      ['osc1', 'osc', { pitch: o.f1 ?? 317, wave: 1 }],
      ['osc2', 'osc', { pitch: o.f2 ?? 540, wave: 1 }],
      ['ring1', 'ring', { mix: 1 }],
      ['cv1', 'cv', { gain1: 1, gain2: o.metal ?? 0.6 }],
      ['lpf1', 'ladder', { mode: 3, cutoff: o.cutoff ?? 7500, resonance: 0.25, drive: 1, cvAmount: 0 }],
      ['env1', 'adsr', { attack: o.attack ?? 0.0005, decay: o.decay, sustain: 0, release: o.decay }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    [
      'osc1.out -> ring1.in',
      'osc2.out -> ring1.car',
      'noise1.out -> cv1.in1',
      'ring1.out -> cv1.in2',
      'cv1.sum -> lpf1.in',
      '$T -> env1.gate',
      'lpf1.out -> vca1.in',
      'env1.out -> vca1.cv',
    ],
    'vca1.out',
    o,
  )
}

/** A handclap: a Burst of slaps and a short tail, band-passed noise. */
function clap(o: { count: number; rate: number; tail: number; cutoff: number } & Hit): Built {
  return drum(
    [
      ['brst2', 'burst', { count: o.count, rate: o.rate, width: 0.3 }],
      ['env1', 'adsr', { attack: 0.0005, decay: 0.01, sustain: 0, release: 0.01 }],
      ['env2', 'adsr', { attack: 0.02, decay: o.tail, sustain: 0, release: o.tail }],
      ['cv1', 'cv', { gain1: 1.6, gain2: 1 }],
      ['noise1', 'noise', {}],
      ['lpf1', 'ladder', { mode: 2, cutoff: o.cutoff, resonance: 0.3, drive: 1, cvAmount: 0 }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    [
      '$T -> brst2.trig',
      'brst2.gate -> env1.gate',
      '$T -> env2.gate',
      'env1.out -> cv1.in1',
      'env2.out -> cv1.in2',
      'noise1.out -> lpf1.in',
      'lpf1.out -> vca1.in',
      'cv1.sum -> vca1.cv',
    ],
    'vca1.out',
    o,
  )
}

/**
 * Noise, shaped: a shaker, a brush, a hiss, a swell. `mode` is the
 * Multimode Filter's -- 0 low-pass, 1 band-pass, 2 high-pass -- and `sweep`
 * moves its cutoff with the envelope, in octaves: a riser climbs.
 */
function noise(o: {
  mode: number
  cutoff: number
  res?: number
  attack: number
  decay: number
  sustain?: number
  color?: number
  sweep?: number
} & Hit): Built {
  const cables = ['noise1.out -> f1.in', 'f1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv']
  if (o.sweep) cables.push('env1.out -> f1.cv')
  return drum(
    [
      ['noise1', 'noise', { color: o.color ?? 0.5 }],
      ['f1', 'svf', { mode: o.mode, cutoff: o.cutoff, resonance: o.res ?? 0.2, cvAmount: o.sweep ?? 0 }],
      ['env1', 'adsr', { attack: o.attack, decay: o.decay, sustain: o.sustain ?? 0, release: o.decay }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    cables,
    'vca1.out',
    o,
  )
}

/**
 * Metal: an oscillator ring-modulated by a second tone -- two partials that
 * belong to no note -- band-passed and struck. A cowbell, an anvil, a sheet.
 */
function metal(o: { pitch: number; freq: number; decay: number; cutoff: number; wave?: number; res?: number; sustain?: number; drive?: number } & Hit): Built {
  const parts: Unit[] = [
    ['osc1', 'osc', { pitch: o.pitch, wave: o.wave ?? 1, level: 0.9 }],
    ['ring1', 'ring', { freq: o.freq, mix: 1 }],
    ['f1', 'svf', { mode: 1, cutoff: o.cutoff, resonance: o.res ?? 0.3 }],
    ['env1', 'adsr', { attack: 0.0005, decay: o.decay, sustain: o.sustain ?? 0, release: o.decay }],
    ['vca1', 'vca', { level: 0, cvAmount: 1 }],
  ]
  const cables = ['osc1.out -> ring1.in', 'ring1.out -> f1.in', 'f1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv']
  if (!o.drive) return drum(parts, cables, 'vca1.out', o)
  parts.push(['drv1', 'drive', { drive: o.drive, level: 0.6 }])
  cables.push('vca1.out -> drv1.in')
  return drum(parts, cables, 'drv1.out', o)
}

/**
 * Something struck: a click of noise ringing a Resonator tuned to `pitch`.
 * Wood, skin, clay, a pipe, a gong -- by how long it rings and how fast its
 * top end dies. `bend` moves the pitch with an envelope after the strike,
 * in octaves: a tabla's rising "ge", a udu's falling bloop.
 */
function struck(o: {
  pitch: number
  decay: number
  damping: number
  strike?: number
  tone?: number
  bend?: number
  bendTime?: number
} & Hit): Built {
  const parts: Unit[] = [
    ['noise1', 'noise', {}],
    ['lp1', 'svf', { mode: 0, cutoff: o.tone ?? 4000, resonance: 0 }],
    ['env1', 'adsr', { attack: 0.0005, decay: o.strike ?? 0.004, sustain: 0, release: o.strike ?? 0.004 }],
    ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ['res1', 'res', { pitch: o.pitch, decay: o.decay, damping: o.damping, cvAmount: o.bend ?? 0 }],
  ]
  const cables = ['noise1.out -> lp1.in', 'lp1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv', 'vca1.out -> res1.in']
  if (o.bend) {
    const t = o.bendTime ?? 0.08
    parts.push(['env2', 'adsr', { attack: t, decay: 0.6, sustain: 0, release: 0.6 }])
    cables.push('$T -> env2.gate', 'env2.out -> res1.cv')
  }
  return drum(parts, cables, 'res1.out', o)
}

/**
 * A blip: an oscillator with its own pitch envelope -- `envPitch` octaves
 * above where it settles, falling (or, negative, rising) as it decays --
 * optionally crushed to a few bits, and optionally sent to a random pitch on
 * every hit by a Sample & Hold of noise, `random` octaves wide.
 */
function blip(o: {
  pitch: number
  wave: number
  decay: number
  envPitch?: number
  bits?: number
  rate?: number
  random?: number
} & Hit): Built {
  const parts: Unit[] = [['osc1', 'osc', { pitch: o.pitch, wave: o.wave, width: 0.5, level: 0.8, envPitch: o.envPitch ?? 0, ...env(0.0005, o.decay) }]]
  const cables = ['$T -> osc1.gate']
  if (o.random) {
    parts.push(['noise1', 'noise', {}], ['sh1', 'sh', {}], ['cv1', 'cv', { gain1: o.random, gain2: 0 }])
    cables.push('noise1.out -> sh1.in1', '$T -> sh1.trig1', 'sh1.out1 -> cv1.in1', 'cv1.out1 -> osc1.pitch')
  }
  if (!o.bits) return drum(parts, cables, 'osc1.out', o)
  parts.push(['crs1', 'crush', { bits: o.bits, rate: o.rate ?? 11025, mix: 1 }])
  cables.push('osc1.out -> crs1.in')
  return drum(parts, cables, 'crs1.out', o)
}

/** Noise crushed to a few bits: a game console's noise channel, a snare or a hat by its length. */
function chipNoise(o: { decay: number; bits: number; rate: number; color?: number } & Hit): Built {
  return drum(
    [
      ['noise1', 'noise', { color: o.color ?? 0.5 }],
      ['crs1', 'crush', { bits: o.bits, rate: o.rate, mix: 1 }],
      ['env1', 'adsr', { attack: 0.0005, decay: o.decay, sustain: 0, release: o.decay }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    ['noise1.out -> crs1.in', 'crs1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv'],
    'vca1.out',
    o,
  )
}

/** Crackle: Dust's impulses, filtered, for as long as the note is held -- or a spray of sparks. */
function crackle(o: { density: number; tone: number; cutoff: number; decay: number; sustain?: number } & Hit): Built {
  return drum(
    [
      ['dust1', 'dust', { density: o.density, spread: 0.6, decay: 0.002, tone: o.tone }],
      ['f1', 'svf', { mode: 2, cutoff: o.cutoff, resonance: 0.1 }],
      ['env1', 'adsr', { attack: 0.002, decay: o.decay, sustain: o.sustain ?? 0, release: o.decay }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    ['dust1.out -> f1.in', 'f1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv'],
    'vca1.out',
    o,
  )
}

/** A low brass blast: detuned saws through a Ladder that opens and closes, driven hard. */
function braam(): Built {
  return drum(
    [
      ['osc1', 'osc', { pitch: 55, wave: 0, level: 0.6, ...env(0.03, 1.4) }],
      ['osc2', 'osc', { pitch: 55.6, wave: 0, level: 0.6, ...env(0.03, 1.4) }],
      ['osc3', 'osc', { pitch: 27.5, wave: 1, level: 0.5, ...env(0.03, 1.4) }],
      ['cv1', 'cv', { gain1: 0.6, gain2: 0.6 }],
      ['cv2', 'cv', { gain1: 1, gain2: 0.5 }],
      ['env1', 'adsr', { attack: 0.08, decay: 0.9, sustain: 0, release: 0.9 }],
      ['lpf1', 'ladder', { mode: 0, cutoff: 260, resonance: 0.35, drive: 3, cvAmount: 3 }],
      ['drv1', 'drive', { drive: 4, level: 0.5 }],
    ],
    [
      '$T -> osc1.gate',
      '$T -> osc2.gate',
      '$T -> osc3.gate',
      'osc1.out -> cv1.in1',
      'osc2.out -> cv1.in2',
      'cv1.sum -> cv2.in1',
      'osc3.out -> cv2.in2',
      'cv2.sum -> lpf1.in',
      '$T -> env1.gate',
      'env1.out -> lpf1.cv',
      'lpf1.out -> drv1.in',
    ],
    'drv1.out',
    { level: 0.7, room: { size: 0.85, decay: 3, mix: 0.3 } },
  )
}

/** A burst into a granular cloud: a hit smeared across a quarter of a second. */
function smear(o: { pitch: number } & Hit): Built {
  return drum(
    [
      ['osc1', 'osc', { pitch: o.pitch, wave: 0, level: 0.8, ...env(0.0005, 0.06) }],
      ['noise1', 'noise', {}],
      ['cv1', 'cv', { gain1: 1, gain2: 0.5 }],
      ['grn1', 'gran', { size: 0.04, density: 60, position: 0.08, spray: 0.7, pitch: 0, spread: 0.8, mix: 1 }],
      ['env1', 'adsr', { attack: 0.0005, decay: 0.35, sustain: 0, release: 0.35 }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
    ],
    ['$T -> osc1.gate', 'osc1.out -> cv1.in1', 'noise1.out -> cv1.in2', 'cv1.sum -> grn1.in', 'grn1.l -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv'],
    'vca1.out',
    o,
  )
}

/** A hit fed round a very short delay: a comb, metallic and pitched, crushed. */
function comb(o: { time: number; feedback: number; bits: number } & Hit): Built {
  return drum(
    [
      ['noise1', 'noise', {}],
      ['env1', 'adsr', { attack: 0.0005, decay: 0.03, sustain: 0, release: 0.03 }],
      ['vca1', 'vca', { level: 0, cvAmount: 1 }],
      ['dly1', 'delay', { time: o.time, feedback: o.feedback, damping: 0.2, mix: 0.8 }],
      ['crs1', 'crush', { bits: o.bits, rate: 12000, mix: 1 }],
    ],
    ['noise1.out -> vca1.in', '$T -> env1.gate', 'env1.out -> vca1.cv', 'vca1.out -> dly1.in', 'dly1.out -> crs1.in'],
    'crs1.out',
    o,
  )
}

// --- the kits ----------------------------------------------------------------

export const KITS: KitDef[] = [
  {
    id: 'kit808',
    name: '808 Kit',
    short: '808',
    description: 'The drum machine trap and hip-hop are built on: a long, tuned 808 kick, snappy snares, choked hats and a roll pad.',
    tip: 'The kick on 36 is long enough to be the bass line too. Hold G#1 (44) for a hat roll.',
    after: 'none',
    pads: [
      { name: '808 long kick', note: 36, sound: () => kick({ pitch: 46, drop: 1.6, dropTime: 0.05, decay: 1.1, drive: 1.6, level: 0.75 }) },
      { name: '808 short kick', note: 35, sound: () => kick({ pitch: 52, drop: 2.5, dropTime: 0.03, decay: 0.3, drive: 2.5 }) },
      { name: '808 snare', note: 38, sound: () => snare({ tone: 175, toneDecay: 0.1, cutoff: 1800, noiseDecay: 0.16, noiseGain: 0.8 }) },
      { name: 'Snappy snare', note: 40, sound: () => snare({ tone: 220, toneDecay: 0.06, cutoff: 3200, noiseDecay: 0.22, noiseGain: 0.95, toneGain: 0.45 }) },
      { name: '808 clap', note: 39, sound: () => clap({ count: 4, rate: 110, tail: 0.16, cutoff: 1200 }) },
      { name: 'Rim', note: 37, sound: () => struck({ pitch: 1700, decay: 0.05, damping: 0.5, tone: 9000, level: 0.9 }) },
      { name: 'Closed hat', note: 42, choke: 1, sound: () => hat({ decay: 0.035, cutoff: 8500 }) },
      { name: 'Open hat', note: 46, choke: 1, sound: () => hat({ decay: 0.35, cutoff: 8000 }) },
      { name: 'Hat roll', note: 44, choke: 1, held: true, sound: () => hat({ decay: 0.03, cutoff: 9000, roll: { count: 16, rate: 16 } }) },
      { name: 'Low tom', note: 41, sound: () => kick({ pitch: 72, drop: 0.5, dropTime: 0.1, decay: 0.55, drive: 1.3 }) },
      { name: 'Mid tom', note: 45, sound: () => kick({ pitch: 98, drop: 0.5, dropTime: 0.1, decay: 0.45, drive: 1.3 }) },
      { name: 'High tom', note: 48, sound: () => kick({ pitch: 135, drop: 0.5, dropTime: 0.08, decay: 0.35, drive: 1.3 }) },
      { name: '808 cowbell', note: 56, sound: () => metal({ pitch: 540, freq: 800, decay: 0.22, cutoff: 900, res: 0.4 }) },
      { name: 'Crash', note: 49, sound: () => hat({ decay: 1.3, cutoff: 5500, f1: 410, f2: 735, metal: 0.8 }) },
      { name: 'Maracas', note: 70, sound: () => noise({ mode: 2, cutoff: 7000, attack: 0.002, decay: 0.05 }) },
      { name: 'Claves', note: 75, sound: () => struck({ pitch: 2500, decay: 0.12, damping: 0.2, tone: 9000, level: 0.8 }) },
    ],
  },
  {
    id: 'kit909',
    name: '909 Kit',
    short: '909',
    description: 'House and techno: a punchy kick with a click on top, noisy snares, metallic hats and ride, and a clap in three slaps, glued.',
    tip: 'Four on the floor on 36, open hat on the off-beats, clap on two and four.',
    after: 'glue',
    pads: [
      { name: '909 kick', note: 36, sound: () => kick({ pitch: 55, drop: 3.5, dropTime: 0.035, decay: 0.38, drive: 3, click: 0.6 }) },
      { name: 'Hard kick', note: 35, sound: () => kick({ pitch: 50, drop: 4, dropTime: 0.03, decay: 0.45, drive: 7, click: 0.8 }) },
      { name: '909 snare', note: 38, sound: () => snare({ tone: 200, toneDecay: 0.09, cutoff: 2500, noiseDecay: 0.2, noiseGain: 0.95 }) },
      { name: 'Tight snare', note: 40, sound: () => snare({ tone: 240, toneDecay: 0.05, cutoff: 4000, noiseDecay: 0.1, noiseGain: 0.9 }) },
      { name: '909 clap', note: 39, sound: () => clap({ count: 3, rate: 80, tail: 0.2, cutoff: 1300, room: { size: 0.3, decay: 0.5, mix: 0.15 } }) },
      { name: 'Rim', note: 37, sound: () => metal({ pitch: 1700, freq: 520, decay: 0.03, cutoff: 2600, res: 0.5 }) },
      { name: 'Closed hat', note: 42, choke: 1, sound: () => hat({ decay: 0.05, cutoff: 9500, f1: 380, f2: 610, metal: 0.8 }) },
      { name: 'Open hat', note: 46, choke: 1, sound: () => hat({ decay: 0.45, cutoff: 9000, f1: 380, f2: 610, metal: 0.8 }) },
      { name: 'Pedal hat', note: 44, choke: 1, sound: () => hat({ decay: 0.08, cutoff: 7000, f1: 380, f2: 610 }) },
      { name: 'Ride', note: 51, sound: () => hat({ decay: 0.9, cutoff: 6000, f1: 470, f2: 870, metal: 1.2 }) },
      { name: 'Crash', note: 49, sound: () => hat({ decay: 1.5, cutoff: 5000, f1: 410, f2: 735, metal: 0.9 }) },
      { name: 'Low tom', note: 41, sound: () => kick({ pitch: 90, drop: 0.8, dropTime: 0.06, decay: 0.32, drive: 1.5 }) },
      { name: 'Mid tom', note: 45, sound: () => kick({ pitch: 120, drop: 0.8, dropTime: 0.05, decay: 0.28, drive: 1.5 }) },
      { name: 'High tom', note: 48, sound: () => kick({ pitch: 160, drop: 0.8, dropTime: 0.05, decay: 0.24, drive: 1.5 }) },
      { name: 'Tambourine', note: 54, sound: { instrument: 'tambourine' } },
      { name: 'Shaker', note: 70, sound: { instrument: 'shaker' } },
    ],
  },
  {
    id: 'kitlofi',
    name: 'Lo-fi Kit',
    short: 'Lo-fi',
    description: 'Boom-bap through a tape machine: a dusty kick and a fat snare, soft hats, and the whole kit through one worn, wobbling Tape like a sampled record.',
    tip: 'Swing the pattern to about 60%. Hold the crackle pad (A#0, 34) under the whole loop.',
    after: 'tape',
    pads: [
      { name: 'Dusty kick', note: 36, sound: () => kick({ pitch: 52, drop: 2, dropTime: 0.04, decay: 0.42, drive: 2 }) },
      { name: 'Fat snare', note: 38, sound: () => snare({ tone: 170, toneDecay: 0.12, cutoff: 3500, mode: 2, noiseDecay: 0.24, noiseGain: 0.8, room: { size: 0.35, decay: 0.6, mix: 0.18 } }) },
      { name: 'Ghost snare', note: 40, sound: () => snare({ tone: 190, toneDecay: 0.05, cutoff: 3000, mode: 2, noiseDecay: 0.08, level: 0.5, gain: 1.4 }) },
      { name: 'Rim', note: 37, sound: () => struck({ pitch: 1400, decay: 0.06, damping: 0.6, tone: 6000, level: 0.85 }) },
      { name: 'Soft clap', note: 39, sound: () => clap({ count: 2, rate: 70, tail: 0.14, cutoff: 1000 }) },
      { name: 'Closed hat', note: 42, choke: 1, sound: () => hat({ decay: 0.04, cutoff: 6000, metal: 0.4 }) },
      { name: 'Open hat', note: 46, choke: 1, sound: () => hat({ decay: 0.3, cutoff: 5500, metal: 0.4 }) },
      { name: 'Pedal hat', note: 44, choke: 1, sound: () => hat({ decay: 0.07, cutoff: 5000, metal: 0.3 }) },
      { name: 'Low tom', note: 41, sound: () => kick({ pitch: 85, drop: 0.6, dropTime: 0.08, decay: 0.4, drive: 1.4 }) },
      { name: 'Mid tom', note: 45, sound: () => kick({ pitch: 115, drop: 0.6, dropTime: 0.07, decay: 0.35, drive: 1.4 }) },
      { name: 'High tom', note: 48, sound: () => kick({ pitch: 150, drop: 0.6, dropTime: 0.06, decay: 0.3, drive: 1.4 }) },
      { name: 'Crash', note: 49, sound: { instrument: 'crash' } },
      { name: 'Ride', note: 51, sound: { instrument: 'ride' } },
      { name: 'Shaker', note: 70, sound: { instrument: 'shaker' } },
      { name: 'Finger snap', note: 75, sound: { instrument: 'snap' } },
      { name: 'Vinyl crackle', note: 34, held: true, sound: () => crackle({ density: 40, tone: 0.4, cutoff: 1500, decay: 0.3, sustain: 1, level: 0.9 }) },
    ],
  },
  {
    id: 'kitchip',
    name: 'Chiptune Kit',
    short: 'Chip',
    description: "An 8-bit console's drums: triangle kicks, crushed noise for snares and hats, square-wave toms, and a zap and a bloop.",
    tip: 'Pairs with the Chiptune bass and lead. Short notes; the console had no room for tails.',
    after: 'none',
    pads: [
      { name: 'Chip kick', note: 36, sound: () => blip({ pitch: 50, wave: 2, decay: 0.16, envPitch: 3, bits: 4, rate: 11025 }) },
      { name: 'Chip snare', note: 38, sound: () => chipNoise({ decay: 0.12, bits: 4, rate: 11025, level: 0.75 }) },
      { name: 'Long snare', note: 40, sound: () => chipNoise({ decay: 0.25, bits: 4, rate: 8000, level: 0.75 }) },
      { name: 'Noise clap', note: 39, sound: () => chipNoise({ decay: 0.05, bits: 3, rate: 9000, roll: { count: 2, rate: 40 } }) },
      { name: 'Closed hat', note: 42, choke: 1, sound: () => chipNoise({ decay: 0.025, bits: 5, rate: 22050, color: 0.9, level: 0.6 }) },
      { name: 'Open hat', note: 46, choke: 1, sound: () => chipNoise({ decay: 0.22, bits: 5, rate: 22050, color: 0.9, level: 0.55 }) },
      { name: 'Pedal hat', note: 44, choke: 1, sound: () => chipNoise({ decay: 0.05, bits: 5, rate: 16000, color: 0.8, level: 0.55 }) },
      { name: 'Low tom', note: 41, sound: () => blip({ pitch: 110, wave: 1, decay: 0.18, envPitch: 1.5, bits: 4 }) },
      { name: 'Mid tom', note: 45, sound: () => blip({ pitch: 150, wave: 1, decay: 0.16, envPitch: 1.5, bits: 4 }) },
      { name: 'High tom', note: 48, sound: () => blip({ pitch: 200, wave: 1, decay: 0.14, envPitch: 1.5, bits: 4 }) },
      { name: 'Crash', note: 49, sound: () => chipNoise({ decay: 0.8, bits: 4, rate: 6000, color: 0.7, level: 0.6 }) },
      { name: 'Ride', note: 51, sound: () => chipNoise({ decay: 0.35, bits: 3, rate: 14000, color: 0.95, level: 0.5 }) },
      { name: 'Rim', note: 37, sound: () => blip({ pitch: 900, wave: 1, decay: 0.03, bits: 4 }) },
      { name: 'Chip bell', note: 56, sound: () => blip({ pitch: 1000, wave: 1, decay: 0.25, bits: 4, level: 0.6 }) },
      { name: 'Zap', note: 60, sound: () => blip({ pitch: 220, wave: 1, decay: 0.18, envPitch: 2.5, bits: 4 }) },
      { name: 'Bloop', note: 62, sound: () => blip({ pitch: 500, wave: 2, decay: 0.16, envPitch: -1.5, bits: 4 }) },
    ],
  },
  {
    id: 'kitworld',
    name: 'World Kit',
    short: 'World',
    description: 'Hand drums from around the world: djembe, tabla with its bending "ge", cajón, darbuka, udu, talking drum, shekere, guiro and cuica.',
    tip: 'Velocity matters on every pad. Play the tabla pads (C4–C#4) against each other.',
    after: 'hall',
    pads: [
      { name: 'Djembe bass', note: 36, sound: () => kick({ pitch: 80, drop: 0.7, dropTime: 0.05, decay: 0.35, drive: 1.4 }) },
      { name: 'Djembe tone', note: 37, sound: () => struck({ pitch: 310, decay: 0.25, damping: 0.45, tone: 3000, gain: 1.7 }) },
      { name: 'Djembe slap', note: 38, sound: () => snare({ tone: 420, toneDecay: 0.04, cutoff: 2600, mode: 2, noiseDecay: 0.07, noiseGain: 0.9, toneGain: 0.5 }) },
      { name: 'Cajón bass', note: 35, sound: () => kick({ pitch: 75, drop: 0.4, dropTime: 0.04, decay: 0.22, drive: 1.2 }) },
      { name: 'Cajón slap', note: 40, sound: () => snare({ tone: 300, toneDecay: 0.03, cutoff: 2200, mode: 2, noiseDecay: 0.14, noiseGain: 0.95, toneGain: 0.4 }) },
      { name: 'Tabla "na"', note: 60, sound: () => struck({ pitch: 880, decay: 0.7, damping: 0.25, tone: 6000 }) },
      { name: 'Tabla "ge"', note: 61, sound: () => struck({ pitch: 120, decay: 0.6, damping: 0.4, tone: 1500, bend: 0.5, bendTime: 0.09, gain: 2 }) },
      { name: 'Talking drum', note: 62, sound: () => struck({ pitch: 170, decay: 0.55, damping: 0.35, tone: 2000, bend: 0.8, bendTime: 0.15, gain: 2 }) },
      { name: 'Conga', note: 63, sound: { instrument: 'conga' } },
      { name: 'Bongo', note: 64, sound: { instrument: 'bongo' } },
      { name: 'Darbuka doum', note: 65, sound: () => struck({ pitch: 110, decay: 0.5, damping: 0.4, tone: 3000, strike: 0.012, level: 1 }) },
      { name: 'Darbuka tek', note: 66, sound: () => struck({ pitch: 1900, decay: 0.07, damping: 0.5, tone: 9000 }) },
      { name: 'Udu', note: 67, sound: () => struck({ pitch: 230, decay: 1.1, damping: 0.1, tone: 2500, strike: 0.01, level: 1, bend: -0.35, bendTime: 0.04 }) },
      { name: 'Shekere', note: 69, sound: () => noise({ mode: 1, cutoff: 6000, res: 0.3, attack: 0.002, decay: 0.03, roll: { count: 3, rate: 30, jitter: 0.3 }, gain: 1.4 }) },
      { name: 'Guiro', note: 73, sound: () => noise({ mode: 1, cutoff: 3000, res: 0.6, attack: 0.001, decay: 0.008, roll: { count: 12, rate: 60, jitter: 0.2 }, gain: 1.4 }) },
      { name: 'Cuica', note: 78, sound: () => blip({ pitch: 520, wave: 3, decay: 0.28, envPitch: 0.9 }) },
    ],
  },
  {
    id: 'kitindustrial',
    name: 'Industrial Kit',
    short: 'Industrial',
    description: 'A factory for a drum kit: an overdriven kick, sheet-metal snares, anvil and pipe hits, chain rattles, steam, sparks and a grinder.',
    tip: 'Drive is on the whole kit. Hold the grinder (F#2, 54) for as long as the machine runs.',
    after: 'drive',
    pads: [
      { name: 'Driven kick', note: 36, sound: () => kick({ pitch: 50, drop: 3, dropTime: 0.04, decay: 0.4, drive: 12, click: 0.4 }) },
      { name: 'Factory hit', note: 35, sound: () => kick({ pitch: 45, drop: 2, dropTime: 0.06, decay: 0.7, drive: 8, click: 1 }) },
      { name: 'Metal snare', note: 38, sound: () => metal({ pitch: 240, freq: 450, decay: 0.25, cutoff: 2200, wave: 0, res: 0.2, drive: 3 }) },
      { name: 'Clang snare', note: 40, sound: () => struck({ pitch: 700, decay: 0.35, damping: 0.3, tone: 7000, level: 0.85 }) },
      { name: 'Metal tick', note: 42, choke: 1, sound: () => hat({ decay: 0.04, cutoff: 6000, f1: 610, f2: 1170, metal: 1.4 }) },
      { name: 'Metal hiss', note: 46, choke: 1, sound: () => hat({ decay: 0.5, cutoff: 5000, f1: 610, f2: 1170, metal: 1.2 }) },
      { name: 'Anvil', note: 39, sound: () => struck({ pitch: 1200, decay: 1.5, damping: 0.05, tone: 9000, strike: 0.002 }) },
      { name: 'Pipe', note: 37, sound: () => struck({ pitch: 520, decay: 0.8, damping: 0.1, tone: 6000 }) },
      { name: 'Low pipe', note: 41, sound: () => struck({ pitch: 230, decay: 1, damping: 0.12, tone: 4000, gain: 1.4 }) },
      { name: 'Clank', note: 45, sound: () => metal({ pitch: 330, freq: 471, decay: 0.25, cutoff: 1400, drive: 4 }) },
      { name: 'Steam', note: 49, sound: () => noise({ mode: 2, cutoff: 4000, attack: 0.02, decay: 1.2, color: 0.8 }) },
      { name: 'Chain rattle', note: 51, sound: () => struck({ pitch: 2400, decay: 0.08, damping: 0.4, tone: 9000, roll: { count: 10, rate: 25, jitter: 0.8 } }) },
      { name: 'Hammer', note: 56, sound: () => kick({ pitch: 120, drop: 1.5, dropTime: 0.02, decay: 0.2, drive: 6, click: 1 }) },
      { name: 'Grinder', note: 54, held: true, sound: () => metal({ pitch: 90, freq: 2000, decay: 0.15, cutoff: 3500, wave: 0, res: 0.4, sustain: 1, level: 0.6 }) },
      { name: 'Sparks', note: 70, sound: () => crackle({ density: 900, tone: 0.95, cutoff: 3000, decay: 0.35 }) },
      { name: 'Press', note: 60, sound: () => kick({ pitch: 38, drop: 1, dropTime: 0.15, decay: 0.9, drive: 10 }) },
    ],
  },
  {
    id: 'kitcinematic',
    name: 'Cinematic Kit',
    short: 'Cinematic',
    description: 'Trailer and boss-fight percussion: taiko, orchestral bass drum, timpani and snare rolls, a gong, a tam-tam, a sub boom, a riser and a braam, in a hall.',
    tip: 'Hold the rolls (G1 and G2) and the swell and riser pads for as long as they should build.',
    after: 'hall',
    pads: [
      { name: 'Taiko', note: 36, sound: () => kick({ pitch: 62, drop: 0.8, dropTime: 0.06, decay: 0.9, drive: 2.5, click: 0.3 }) },
      { name: 'Bass drum', note: 35, sound: () => kick({ pitch: 45, drop: 0.5, dropTime: 0.1, decay: 1.4, drive: 1.3 }) },
      { name: 'Snare', note: 38, sound: () => snare({ tone: 210, toneDecay: 0.08, cutoff: 2800, noiseDecay: 0.18, noiseGain: 0.9 }) },
      { name: 'Snare roll', note: 40, held: true, sound: () => snare({ tone: 210, toneDecay: 0.04, cutoff: 2800, noiseDecay: 0.06, noiseGain: 0.9, roll: { count: 16, rate: 22, jitter: 0.15 } }) },
      { name: 'Timpani', note: 41, sound: { instrument: 'timpani' } },
      { name: 'Timpani roll', note: 43, held: true, sound: () => kick({ pitch: 98, drop: 0.2, dropTime: 0.05, decay: 0.3, drive: 1.2, roll: { count: 16, rate: 18, jitter: 0.2 } }) },
      { name: 'Cymbal swell', note: 49, held: true, sound: () => hat({ decay: 1.6, attack: 1.4, cutoff: 4500, f1: 410, f2: 735, metal: 0.9 }) },
      { name: 'Crash', note: 57, sound: { instrument: 'crash' } },
      { name: 'Gong', note: 52, sound: () => struck({ pitch: 92, decay: 6, damping: 0.12, tone: 2500, strike: 0.01, level: 0.9, gain: 1.4 }) },
      { name: 'Tam-tam', note: 55, sound: () => metal({ pitch: 140, freq: 233, decay: 1.6, cutoff: 900, wave: 0, res: 0.2, level: 0.8 }) },
      { name: 'Sub boom', note: 60, sound: () => kick({ pitch: 38, drop: 1.2, dropTime: 0.5, decay: 1.3, drive: 2 }) },
      { name: 'Riser', note: 62, held: true, sound: () => noise({ mode: 1, cutoff: 400, res: 0.3, attack: 1.2, decay: 0.3, sustain: 0, sweep: 3.5, color: 0.8, level: 1 }) },
      { name: 'Braam', note: 63, sound: braam },
      { name: 'Orchestral hit', note: 64, sound: () => struck({ pitch: 220, decay: 0.7, damping: 0.3, tone: 5000, strike: 0.02 }) },
      { name: 'Stomp', note: 39, sound: () => kick({ pitch: 70, drop: 1, dropTime: 0.04, decay: 0.35, drive: 2, click: 0.8, room: { size: 0.5, decay: 0.9, mix: 0.25 } }) },
      { name: 'Clock tick', note: 42, sound: { instrument: 'woodblock' } },
    ],
  },
  {
    id: 'kitglitch',
    name: 'Glitch Kit',
    short: 'Glitch',
    description: 'IDM and hacker-terminal percussion: clicks, crushed bursts, stutters, ring-mod buzzes, granular smears, and blips that land somewhere new every hit.',
    tip: 'Render seeded takes of a pattern: the random pads are different every time.',
    after: 'glue',
    pads: [
      { name: 'Click kick', note: 36, sound: () => kick({ pitch: 60, drop: 4, dropTime: 0.01, decay: 0.15, drive: 4, click: 1 }) },
      { name: 'Crushed snare', note: 38, sound: () => chipNoise({ decay: 0.1, bits: 3, rate: 7000, roll: { count: 2, rate: 70 } }) },
      { name: 'Comb snare', note: 40, sound: () => comb({ time: 0.006, feedback: 0.85, bits: 5, level: 0.7 }) },
      { name: 'Stutter', note: 39, sound: () => chipNoise({ decay: 0.03, bits: 4, rate: 12000, roll: { count: 6, rate: 40 } }) },
      { name: 'Tick', note: 42, choke: 1, sound: () => blip({ pitch: 4000, wave: 1, decay: 0.006, level: 0.6 }) },
      { name: 'Buzz', note: 46, choke: 1, sound: () => metal({ pitch: 1200, freq: 77, decay: 0.08, cutoff: 3000, res: 0.6, gain: 1.4 }) },
      { name: 'Pop', note: 37, sound: () => blip({ pitch: 2000, wave: 3, decay: 0.012, envPitch: 1 }) },
      { name: 'Bit tom', note: 41, sound: () => blip({ pitch: 140, wave: 1, decay: 0.12, envPitch: 2, bits: 3, rate: 6000 }) },
      { name: 'Bit tom high', note: 45, sound: () => blip({ pitch: 230, wave: 1, decay: 0.1, envPitch: 2, bits: 3, rate: 6000 }) },
      { name: 'Smear', note: 51, sound: () => smear({ pitch: 300, level: 1, gain: 2 }) },
      { name: 'Dropout', note: 49, sound: () => noise({ mode: 0, cutoff: 6000, attack: 0.0005, decay: 0.012, roll: { count: 16, rate: 120, jitter: 0.5 } }) },
      { name: 'Random blip', note: 56, sound: () => blip({ pitch: 700, wave: 1, decay: 0.05, random: 1.5, bits: 5 }) },
      { name: 'Zap', note: 60, sound: () => blip({ pitch: 300, wave: 0, decay: 0.15, envPitch: 3, bits: 6 }) },
      { name: 'Crackle', note: 70, sound: () => crackle({ density: 2500, tone: 0.9, cutoff: 2000, decay: 0.15 }) },
      { name: 'Data', note: 75, sound: () => blip({ pitch: 1200, wave: 1, decay: 0.02, random: 1, roll: { count: 8, rate: 60 } }) },
      { name: 'Reverse click', note: 54, sound: () => noise({ mode: 2, cutoff: 2500, attack: 0.08, decay: 0.004, gain: 1.4 }) },
    ],
  },
]

/**
 * What follows a kit's Drum Kit module, as units and cables into a mixer that
 * takes the stereo pair. `glue` is a pair of compressors keyed from both
 * sides, so the kit pumps as one; `tape` is a Tape, the kit summed into it; `drive`
 * saturates; `hall` sends the kit to a big room beside the dry pair.
 */
export function kitAfter(after: KitAfter): { units: Unit[]; cables: string[] } {
  const out: Unit = ['mix1', 'mixer', { level1: 1, level2: 1, pan1: -1, pan2: 1, level3: 0.4, level4: 0.4, pan3: -1, pan4: 1 }]
  switch (after) {
    case 'glue':
      return {
        units: [
          ['sum1', 'cv', { gain1: 0.5, gain2: 0.5 }],
          ['cmpL', 'comp', { threshold: -20, ratio: 3, attack: 0.01, release: 0.15, makeup: 3 }],
          ['cmpR', 'comp', { threshold: -20, ratio: 3, attack: 0.01, release: 0.15, makeup: 3 }],
          out,
        ],
        cables: [
          'kit1.l -> sum1.in1',
          'kit1.r -> sum1.in2',
          'kit1.l -> cmpL.in',
          'kit1.r -> cmpR.in',
          'sum1.sum -> cmpL.key',
          'sum1.sum -> cmpR.key',
          'cmpL.out -> mix1.in1',
          'cmpR.out -> mix1.in2',
        ],
      }
    case 'tape':
      // One machine for the whole kit, summed to mono as a sampled record
      // nearly is: two would wobble out of step with each other.
      return {
        units: [
          ['sum1', 'cv', { gain1: 0.5, gain2: 0.5 }],
          ['tape1', 'tape', { drive: 0.45, wow: 0.2, flutter: 0.15, age: 0.4, hiss: 0 }],
          out,
        ],
        cables: ['kit1.l -> sum1.in1', 'kit1.r -> sum1.in2', 'sum1.sum -> tape1.in', 'tape1.out -> mix1.in1', 'tape1.out -> mix1.in2'],
      }
    case 'drive':
      return {
        units: [
          ['drvL', 'drive', { drive: 3, curve: 1, level: 0.55 }],
          ['drvR', 'drive', { drive: 3, curve: 1, level: 0.55 }],
          out,
        ],
        cables: ['kit1.l -> drvL.in', 'kit1.r -> drvR.in', 'drvL.out -> mix1.in1', 'drvR.out -> mix1.in2'],
      }
    case 'hall':
      return {
        units: [['sum1', 'cv', { gain1: 0.5, gain2: 0.5 }], ['hall1', 'reverb', { size: 0.85, decay: 3.2, damping: 0.35, mix: 1 }], out],
        cables: [
          'kit1.l -> mix1.in1',
          'kit1.r -> mix1.in2',
          'kit1.l -> sum1.in1',
          'kit1.r -> sum1.in2',
          'sum1.sum -> hall1.in',
          'hall1.l -> mix1.in3',
          'hall1.r -> mix1.in4',
        ],
      }
    default:
      return { units: [], cables: [] }
  }
}

/** Every kit, as a rack of its own with the Drum Kit and what follows it; the pads are loaded by the caller. */
export function kitShell(def: KitDef): Built {
  const after = kitAfter(def.after)
  return rack([['gate1', 'gate'], ['kit1', 'kit'], ...after.units], ['gate1.gate -> kit1.trig1', ...after.cables])
}
