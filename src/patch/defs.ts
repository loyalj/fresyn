import { WAVEFORMS } from '../dsp/PolyBlepOsc'
import type { ModuleDef, ModuleGroup } from './types'

// The Wave and Shape switches are labelled from the list the oscillator and
// LFO play from, so the two cannot drift. It is imported from the DSP rather
// than the other way round: the worklet bundles the DSP, and a list kept here
// would drag the definitions -- and what they import -- onto the audio thread.
const WAVES = WAVEFORMS
const CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8]
const SH_CHANNELS = [1, 2, 3, 4]
const SEQ_STEPS = [1, 2, 3, 4, 5, 6, 7, 8]
const MACRO_LANES = [1, 2, 3, 4]
/** The Drum Kit's pads, numbered as its panel numbers them. */
const KIT_PADS = Array.from({ length: 16 }, (_, i) => i + 1)
/**
 * What a freshly added sequencer plays: a minor seventh arpeggio up and back
 * down, in octaves. A row of zeroes would be a sequencer that does nothing
 * until eight knobs have been turned, and nothing is a poor demonstration of
 * a module whose whole point is the pattern.
 */
const SEQ_DEFAULT = [0, 3, 7, 10, 12, 10, 7, 3].map((semitones) => semitones / 12)

/**
 * The module catalogue. Ports and knobs are declared once here; the rack UI
 * and the DSP registry both read this, so a module cannot grow a knob in one
 * place and not the other.
 */
export const MODULE_DEFS: Record<string, ModuleDef> = {
  gate: {
    type: 'gate',
    name: 'Trigger',
    group: 'control',
    slug: 'gate',
    trigger: true,
    // The one module you can play from the keyboard. Add a second for a
    // second key; anything else in the rack is fired by a cable from one.
    keyed: true,
    width: 'half',
    // Fired by a cable as well as by the key, which is what turns this module
    // into a gate shaper: a clock into Trig with Mode on `once` puts out a
    // fixed length at the clock's rate, where the Clock's own Width gives a
    // fraction of the period and changes with it.
    inputs: [{ id: 'trig', label: 'Trig' }],
    outputs: [
      { id: 'gate', label: 'Gate' },
      // How hard a note from the roll struck it, 0..1, as the Keyboard's Vel
      // is: full for a key, a button or a cable. Appended, because the DSP
      // reads its ports by position.
      { id: 'vel', label: 'Vel' },
    ],
    params: [
      // Held, a fixed length, or on until the next press. The DSP reads these
      // by index, so the order is load bearing.
      { id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, unit: '', curve: 'lin', steps: ['held', 'once', 'latch'] },
      // Only read in 'once'. Left on the panel in the other two rather than
      // hidden, so choosing a mode does not make the face jump about.
      { id: 'length', label: 'Length', min: 0.002, max: 2, default: 0.08, unit: 's', curve: 'exp' },
    ],
  },

  osc: {
    type: 'osc',
    name: 'Oscillator',
    group: 'voice',
    slug: 'osc',
    trigger: true,
    // Gate and Env are appended rather than inserted: the DSP reads its ports
    // by position, so the existing indices have to stay put.
    inputs: [
      { id: 'fm', label: 'FM', block: 'mod' },
      { id: 'pwm', label: 'PWM', block: 'mod' },
      { id: 'sync', label: 'Sync', block: 'mod' },
      { id: 'gate', label: 'Gate', block: 'play' },
      // What a keyboard plays it with: one octave per unit, always, and added
      // to whatever FM is doing rather than sharing its jack. With the pitch
      // on its own input the FM jack is free for another oscillator, so a
      // voice can be played and frequency-modulated at once -- which is every
      // electric piano, bell and FM bass there is.
      { id: 'pitch', label: 'Pitch', block: 'play' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      { id: 'env', label: 'Env' },
    ],
    params: [
      // Twelve and a half octaves, which is wider than a knob can be turned
      // accurately -- Octave below is the coarse half of the pair, and shift
      // makes any knob five times finer. The ends are what they are for: 2 Hz
      // is a rumble you count rather than hear, and 12 kHz is the sparkle on
      // top of a sound rather than the sound.
      { id: 'pitch', label: 'Pitch', min: 2, max: 12000, default: 110, unit: 'Hz', curve: 'exp', tuned: true },
      { id: 'wave', label: 'Wave', min: 0, max: 3, default: 0, unit: '', curve: 'lin', steps: WAVES },
      { id: 'width', label: 'Width', min: 0.02, max: 0.98, default: 0.5, unit: '', curve: 'lin' },
      { id: 'fmAmount', label: 'FM Amt', min: -4, max: 4, default: 0, unit: 'oct', curve: 'lin' },
      // Zero by default, so an oscillator in a patch saved before it had an
      // envelope still passes a plain continuous tone.
      { id: 'envAmount', label: 'Env Amt', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'delay', label: 'Delay', min: 0.0002, max: 2, default: 0.0002, unit: 's', curve: 'exp' },
      { id: 'attack', label: 'Attack', min: 0.0005, max: 2, default: 0.002, unit: 's', curve: 'exp' },
      { id: 'hold', label: 'Hold', min: 0.0002, max: 2, default: 0.0002, unit: 's', curve: 'exp' },
      { id: 'decay', label: 'Decay', min: 0.002, max: 4, default: 0.35, unit: 's', curve: 'exp' },
      { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'release', label: 'Release', min: 0.002, max: 4, default: 0.15, unit: 's', curve: 'exp' },
      // Last, like Gate and Env, and for the same reason: the DSP reads its
      // parameters by position. Exponential is the default because it is what
      // every patch saved before this switch existed was using.
      { id: 'fmMode', label: 'FM Mode', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['exp', 'linear'] },
      // Whole octaves, detented, and the coarse half of the tuning pair. A
      // count rather than a measurement, so the readout says -1 and not
      // -1.00.
      { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, unit: '#', curve: 'lin' },
      // Full by default: an oscillator that arrived quieter than it used to
      // would change every patch ever saved.
      { id: 'level', label: 'Level', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      // The envelope's other two destinations. Both default to zero, so the
      // envelope still does nothing but amplitude unless it is asked to.
      { id: 'envPitch', label: 'Env Pitch', min: -4, max: 4, default: 0, unit: 'oct', curve: 'lin' },
      { id: 'envWidth', label: 'Env Width', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
    ],
  },

  sampler: {
    type: 'sampler',
    name: 'Sampler',
    group: 'voice',
    slug: 'smp',
    trigger: true,
    inputs: [
      { id: 'gate', label: 'Gate' },
      { id: 'pitch', label: 'Pitch' },
    ],
    // Stereo out, like the Granular and the Space: a file has two sides and
    // the rack is mono until the mixer, so both of them get a jack.
    outputs: [
      { id: 'l', label: 'L' },
      { id: 'r', label: 'R' },
      { id: 'end', label: 'End' },
    ],
    params: [
      { id: 'start', label: 'Start', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      // A fraction of what is left after Start, so full always means "to the
      // end" wherever Start has been put.
      { id: 'length', label: 'Length', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      { id: 'speed', label: 'Speed', min: 0.25, max: 4, default: 1, unit: 'x', curve: 'exp' },
      { id: 'cvAmount', label: 'Pitch Amt', min: -4, max: 4, default: 0, unit: 'oct', curve: 'lin' },
      // Both ends of the region, and the reason a sampler does not click. Two
      // milliseconds is inaudible as a fade and completely audible as a
      // click, which is why it is the default rather than zero.
      { id: 'fade', label: 'Fade', min: 0.0005, max: 0.5, default: 0.002, unit: 's', curve: 'exp' },
      { id: 'level', label: 'Level', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      { id: 'loop', label: 'Loop', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['one-shot', 'loop'] },
      { id: 'direction', label: 'Direction', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['forward', 'reverse'] },
    ],
  },

  voice: {
    type: 'voice',
    name: 'Voice',
    group: 'voice',
    slug: 'vox',
    // Its button opens the gate, as the oscillator's does. It only matters in
    // gated mode; a drone sounds whether or not anything is holding it.
    trigger: true,
    inputs: [
      { id: 'gate', label: 'Gate', block: 'play' },
      // One octave per unit, as on the oscillator, so a Keyboard plays it.
      { id: 'pitch', label: 'Pitch', block: 'play' },
      // Added to the Breath knob. An envelope here is a breathy onset; a
      // Sample & Hold is a voice that keeps catching.
      { id: 'breath', label: 'Breath', block: 'mod' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      // The note's envelope, whichever mode it is in: patched to a Formant's
      // Vowel jack, every note says "wah".
      { id: 'env', label: 'Env' },
    ],
    params: [
      // A voice rather than an oscillator: low enough for a giant, high enough
      // for a soprano's top and a cartoon mouse.
      { id: 'pitch', label: 'Pitch', min: 30, max: 1200, default: 110, unit: 'Hz', curve: 'exp', tuned: true },
      // Soft and breathy at 0, pressed and buzzy at 1.
      { id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      // At 1 there is no buzz left at all: a whisper.
      { id: 'breath', label: 'Breath', min: 0, max: 1, default: 0.1, unit: '', curve: 'lin' },
      { id: 'jitter', label: 'Jitter', min: 0, max: 1, default: 0.2, unit: '', curve: 'lin' },
      { id: 'growl', label: 'Growl', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'vibRate', label: 'Vib Rate', min: 1, max: 12, default: 5.5, unit: 'Hz', curve: 'exp' },
      // Up to a semitone either side. Zero by default, because a vibrato is a
      // singer's and most of what this module will make is not singing.
      { id: 'vibDepth', label: 'Vib Depth', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['drone', 'gated'] },
      { id: 'attack', label: 'Attack', min: 0.002, max: 2, default: 0.04, unit: 's', curve: 'exp' },
      { id: 'release', label: 'Release', min: 0.005, max: 4, default: 0.2, unit: 's', curve: 'exp' },
      { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, unit: '', curve: 'lin' },
    ],
  },

  kit: {
    type: 'kit',
    name: 'Drum Kit',
    group: 'voice',
    slug: 'kit',
    // Sixteen pads, each a whole rack from the library. A note from the roll
    // plays the pad it is mapped to; the kit sums them, and its L and R go to
    // the speakers like a mixer's when nothing is patched after them.
    bus: ['l', 'r'],
    inputs: [
      // A gate here plays that pad, as a note would: a Sequencer into Trig 3
      // is a hat pattern with no roll at all.
      ...KIT_PADS.map((n) => ({ id: `trig${n}`, label: `${n}`, block: 'trig' })),
      // Where each pad's rack arrives. Wired by the compiler, never by hand.
      ...KIT_PADS.flatMap((n) => [
        { id: `ret${n}l`, label: `${n} L`, hidden: true as const },
        { id: `ret${n}r`, label: `${n} R`, hidden: true as const },
      ]),
    ],
    outputs: [
      { id: 'l', label: 'L', block: 'mix' },
      { id: 'r', label: 'R', block: 'mix' },
      // Each pad on its own, after its level and before its pan: patch the
      // snare alone into a Space. It is in the mix as well.
      ...KIT_PADS.map((n) => ({ id: `out${n}`, label: `${n}`, block: 'pads' })),
    ],
    params: [
      // Level and pan by pad, then the choke groups. The DSP reaches each
      // block with one base plus the pad number, so the order is load bearing.
      ...KIT_PADS.flatMap((n) => [
        { id: `level${n}`, label: `Lvl ${n}`, min: 0, max: 1, default: 0.8, unit: '', curve: 'lin' as const },
        { id: `pan${n}`, label: `Pan ${n}`, min: -1, max: 1, default: 0, unit: '', curve: 'lin' as const },
      ]),
      // Pads in the same group cut each other off: the closed hat stops the
      // open one ringing. Nought is no group. A count rather than a switch,
      // so the catalogue check does not take the product of sixteen of them.
      ...KIT_PADS.map((n) => ({
        id: `choke${n}`, label: `Choke ${n}`, min: 0, max: 4, default: 0, unit: '#', curve: 'lin' as const,
      })),
    ],
  },

  keys: {
    type: 'keys',
    name: 'Keyboard',
    group: 'control',
    slug: 'key',
    // No Trigger button: the keys are the trigger. A cable into the Gate jack
    // is the other way in -- it plays whichever key was pressed last, which
    // turns this module into the pitch setting for whatever fires it.
    //
    // Called `trig` although the panel says Gate, and although it is a gate:
    // hold it and the note holds. The id cannot be `gate` because the output
    // already is, and a jack is addressed by `moduleId.portId` throughout the
    // UI -- registration, geometry, occupancy, drag targeting -- with no side
    // in the key. Two jacks with one address is a bug, so the ids differ and
    // the label says what it actually does.
    // What a piano roll, a MIDI keyboard or a game plays notes on. The rack
    // has exactly one such module today, and a track in a song finds it by
    // this flag rather than by name.
    playable: true,
    inputs: [{ id: 'trig', label: 'Gate' }],
    // Appended, never reordered: the DSP reads its ports by position.
    outputs: [
      { id: 'pitch', label: 'Pitch' },
      { id: 'gate', label: 'Gate' },
      // How hard a sequenced note was struck, 0..1. Full scale for anything
      // played by hand, so patching it into a VCA costs nothing until
      // something with velocity is actually driving the module.
      { id: 'vel', label: 'Vel' },
    ],
    // Played, not designed: both of these are set by the panel itself, and a
    // render batch must not wander off the note you chose.
    params: [
      { id: 'note', label: 'Note', min: 0, max: 24, default: 0, unit: '', curve: 'lin', played: true },
      { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, unit: '', curve: 'lin', played: true },
      // How many notes sound at once. One is the rack as it always was: a
      // single line, where each note takes over from the last. Above that,
      // every note gets its own copy of the modules downstream of this one,
      // up to the first shared module -- see `shared` in types.ts. Appended,
      // because the DSP reads parameters by position.
      { id: 'voices', label: 'Voices', min: 1, max: 8, default: 1, unit: '#', curve: 'lin' },
    ],
  },

  noise: {
    type: 'noise',
    name: 'Noise',
    group: 'voice',
    slug: 'noise',
    width: 'half',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'color', label: 'Color', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['white', 'pink'] },
      { id: 'level', label: 'Level', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
    ],
  },

  dust: {
    type: 'dust',
    name: 'Dust',
    group: 'voice',
    slug: 'dust',
    width: 'half',
    inputs: [{ id: 'density', label: 'Density' }],
    outputs: [
      { id: 'out', label: 'Out' },
      // A short gate on every impulse, so the same random timing can strike
      // an envelope, a resonator or a sampler: a Geiger counter's clicks, or
      // raindrops that each ring.
      { id: 'trig', label: 'Trig' },
    ],
    params: [
      // An average: the gaps are random, so twenty a second never sounds
      // like a clock. Exponential, because the ear hears density in ratios.
      { id: 'density', label: 'Density', min: 0.5, max: 5000, default: 20, unit: 'Hz', curve: 'exp' },
      // How much each impulse's height varies. At zero they are all full
      // scale, which is a machine; real crackle is mostly small ones.
      { id: 'spread', label: 'Spread', min: 0, max: 1, default: 0.6, unit: '', curve: 'lin' },
      { id: 'decay', label: 'Decay', min: 0.0002, max: 0.2, default: 0.003, unit: 's', curve: 'exp' },
      { id: 'tone', label: 'Tone', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['click', 'noise'] },
      { id: 'cvAmount', label: 'Density Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  lfo: {
    type: 'lfo',
    name: 'LFO',
    group: 'modulation',
    slug: 'lfo',
    // The widest panel that still fits half a row: four controls and the
    // shape switch, with about fifty pixels to spare.
    width: 'half',
    // PWM is appended rather than inserted, as on the oscillator: the DSP
    // reads its ports by position, so Sync has to keep index 0.
    inputs: [
      { id: 'sync', label: 'Sync' },
      { id: 'pwm', label: 'PWM' },
      // Appended, like every port added after the fact: the DSP reads them by
      // position. Rate was the only control on this panel a cable could not
      // reach, which left every accelerating wobble -- an engine revving, a
      // siren winding up -- out of reach with it.
      { id: 'cv', label: 'Rate' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      { id: 'uni', label: 'Uni' },
    ],
    params: [
      { id: 'rate', label: 'Rate', min: 0.02, max: 200, default: 4, unit: 'Hz', curve: 'exp' },
      { id: 'shape', label: 'Shape', min: 0, max: 3, default: 3, unit: '', curve: 'lin', steps: WAVES },
      // Width sits next to Shape, as it does on the oscillator, because it is
      // the shape it modifies. Parameters are addressed by name everywhere
      // outside the DSP, so putting it here costs saved patches nothing.
      { id: 'width', label: 'Width', min: 0.02, max: 0.98, default: 0.5, unit: '', curve: 'lin' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      { id: 'cvAmount', label: 'Rate Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  adsr: {
    type: 'adsr',
    name: 'Envelope',
    group: 'modulation',
    slug: 'env',
    // Four knobs and two jacks: half a row is all it has ever needed.
    width: 'half',
    inputs: [{ id: 'gate', label: 'Gate' }],
    // End and Inv are appended, as ports always are here. End fires when the
    // shape finishes, the way the Burst and the Sequencer say they are done;
    // Inv is the shape upside down, which is a whole CV Utility saved every
    // time something has to duck rather than swell.
    outputs: [
      { id: 'out', label: 'Out' },
      { id: 'end', label: 'End' },
      { id: 'inv', label: 'Inv' },
    ],
    params: [
      { id: 'attack', label: 'Attack', min: 0.0005, max: 2, default: 0.002, unit: 's', curve: 'exp' },
      { id: 'decay', label: 'Decay', min: 0.002, max: 4, default: 0.35, unit: 's', curve: 'exp' },
      { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'release', label: 'Release', min: 0.002, max: 4, default: 0.15, unit: 's', curve: 'exp' },
    ],
  },

  sh: {
    type: 'sh',
    name: 'Sample & Hold',
    group: 'modulation',
    slug: 'sh',
    // Four independent channels, because one knob on a whole panel was a poor
    // trade for a rack unit -- and because wanting a second stepped source is
    // the normal case, not the exception.
    //
    // Both inputs of every channel are normalled, as on hardware: In falls
    // back to an internal noise source and Trig to that channel's own clock,
    // so a channel with nothing patched at all is a stepped random generator.
    // Jacks are grouped by channel rather than by function, so patching
    // channel 3 means looking in one place.
    inputs: SH_CHANNELS.flatMap((n) => [
      { id: `in${n}`, label: `In ${n}`, block: `ch ${n}` },
      { id: `trig${n}`, label: `Trig ${n}`, block: `ch ${n}` },
    ]),
    outputs: SH_CHANNELS.flatMap((n) => [
      { id: `out${n}`, label: `Out ${n}`, block: `ch ${n}` },
      { id: `clk${n}`, label: `Clk ${n}`, block: `ch ${n}` },
    ]),
    params: SH_CHANNELS.map((n) => ({
      id: `rate${n}`,
      label: `Rate ${n}`,
      min: 0.1,
      max: 50,
      default: 6,
      unit: 'Hz',
      curve: 'exp' as const,
    })),
  },

  drunk: {
    type: 'drunk',
    name: 'Drunk',
    group: 'modulation',
    slug: 'drk',
    width: 'half',
    inputs: [
      // Steps on each rising edge instead of at Rate, when anything is
      // patched here -- a clock, a sequencer's gate, a Dust's triggers.
      { id: 'clock', label: 'Clock' },
      { id: 'rate', label: 'Rate' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      { id: 'uni', label: 'Uni' },
      // Fires on every step, whatever set it off.
      { id: 'trig', label: 'Trig' },
    ],
    params: [
      { id: 'rate', label: 'Rate', min: 0.05, max: 50, default: 2, unit: 'Hz', curve: 'exp' },
      // A fraction of the whole range, which is two units wide: 1.00 can
      // land anywhere, which is smooth random rather than a walk.
      { id: 'step', label: 'Step', min: 0.01, max: 1, default: 0.25, unit: '', curve: 'exp' },
      { id: 'smooth', label: 'Smooth', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      { id: 'pull', label: 'Pull', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'rateAmount', label: 'Rate Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  clock: {
    type: 'clock',
    name: 'Clock',
    group: 'control',
    slug: 'clk',
    width: 'half',
    inputs: [
      { id: 'reset', label: 'Reset' },
      { id: 'cv', label: 'CV' },
    ],
    // Divisions rather than multiplications: what a patch wants is several
    // rates that stay related, and the fastest one is the one you set.
    outputs: [
      { id: 'x1', label: 'x1', block: 'divisions' },
      { id: 'd2', label: '/2', block: 'divisions' },
      { id: 'd3', label: '/3', block: 'divisions' },
      { id: 'd4', label: '/4', block: 'divisions' },
      { id: 'd8', label: '/8', block: 'divisions' },
    ],
    params: [
      { id: 'rate', label: 'Rate', min: 0.1, max: 200, default: 4, unit: 'Hz', curve: 'exp' },
      { id: 'cvAmount', label: 'CV Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
      // Shared by every output, so narrowing it turns all five into triggers
      // together rather than making the divisions a different shape.
      { id: 'width', label: 'Width', min: 0.02, max: 0.98, default: 0.5, unit: '', curve: 'lin' },
    ],
  },

  burst: {
    type: 'burst',
    name: 'Burst',
    group: 'control',
    slug: 'brst',
    trigger: true,
    width: 'half',
    inputs: [{ id: 'trig', label: 'Trig' }],
    outputs: [
      { id: 'gate', label: 'Gate' },
      // Steps from 0 on the first pulse to 1 on the last, so one cable makes
      // each hit of a run differ from the one before it.
      { id: 'ramp', label: 'Ramp' },
      { id: 'end', label: 'End' },
    ],
    params: [
      { id: 'count', label: 'Count', min: 1, max: 16, default: 4, unit: '#', curve: 'lin' },
      { id: 'rate', label: 'Rate', min: 0.5, max: 200, default: 12, unit: 'Hz', curve: 'exp' },
      // Negative packs the run together as it goes, positive spreads it out.
      { id: 'curve', label: 'Curve', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'jitter', label: 'Jitter', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'width', label: 'Width', min: 0.02, max: 0.98, default: 0.3, unit: '', curve: 'lin' },
    ],
  },

  seq: {
    type: 'seq',
    name: 'Sequencer',
    group: 'control',
    slug: 'seq',
    // Its button restarts the pattern, and so does the Reset jack. Either
    // works whether or not the other is used, as the Burst's trigger does.
    trigger: true,
    inputs: [
      { id: 'clock', label: 'Clock' },
      { id: 'reset', label: 'Reset' },
    ],
    outputs: [
      { id: 'cv', label: 'CV', block: 'step' },
      { id: 'gate', label: 'Gate', block: 'step' },
      { id: 'vel', label: 'Vel', block: 'step' },
      // Free-running whatever is patched, as the sample and hold's clocks are.
      { id: 'clk', label: 'Clk', block: 'chain' },
      { id: 'end', label: 'End', block: 'chain' },
    ],
    params: [
      // Steps first, then levels, then the three that govern the pattern as a
      // whole. The DSP reads all three groups by index, so the order is load
      // bearing.
      ...SEQ_STEPS.map((n) => ({
        id: `step${n}`, label: `CV ${n}`,
        min: -2, max: 2, default: SEQ_DEFAULT[n - 1], unit: 'oct', curve: 'lin' as const,
      })),
      ...SEQ_STEPS.map((n) => ({
        id: `level${n}`, label: `Lvl ${n}`,
        min: 0, max: 1, default: 1, unit: '', curve: 'lin' as const,
      })),
      { id: 'rate', label: 'Rate', min: 0.1, max: 50, default: 4, unit: 'Hz', curve: 'exp' },
      { id: 'length', label: 'Steps', min: 1, max: 8, default: 8, unit: '#', curve: 'lin' },
      { id: 'gateLen', label: 'Gate', min: 0.05, max: 0.95, default: 0.5, unit: '', curve: 'lin' },
    ],
  },

  macro: {
    type: 'macro',
    name: 'Macro',
    group: 'control',
    slug: 'mac',
    // A whole row: one big knob, the lanes drawn against it, and four sets of
    // three knobs underneath. It is the panel you perform on, so it gets room.
    inputs: [{ id: 'cv', label: 'Amount' }],
    outputs: MACRO_LANES.map((n) => ({ id: `out${n}`, label: `${n}` })),
    params: [
      // Zero by default, so adding one to a patch changes nothing until it
      // is turned -- every lane starts at its From.
      { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      // Five per lane, in the order the DSP reads them. Start and End are the
      // lane's window and are set by dragging its handles on the graph,
      // which is why the face draws no knob for them.
      ...MACRO_LANES.flatMap((n) => [
        { id: `from${n}`, label: `From ${n}`, min: -1, max: 1, default: 0, unit: '', curve: 'lin' as const },
        { id: `to${n}`, label: `To ${n}`, min: -1, max: 1, default: 1, unit: '', curve: 'lin' as const },
        { id: `curve${n}`, label: `Curve ${n}`, min: -1, max: 1, default: 0, unit: '', curve: 'lin' as const },
        { id: `start${n}`, label: `Start ${n}`, min: 0, max: 1, default: 0, unit: '', curve: 'lin' as const },
        { id: `end${n}`, label: `End ${n}`, min: 0, max: 1, default: 1, unit: '', curve: 'lin' as const },
      ]),
    ],
  },

  slew: {
    type: 'slew',
    name: 'Slew',
    group: 'modulation',
    slug: 'slew',
    width: 'half',
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'rise', label: 'Rise', min: 0.0005, max: 4, default: 0.05, unit: 's', curve: 'exp' },
      { id: 'fall', label: 'Fall', min: 0.0005, max: 4, default: 0.05, unit: 's', curve: 'exp' },
      { id: 'shape', label: 'Shape', min: 0, max: 1, default: 1, unit: '', curve: 'lin', steps: ['lin', 'exp'] },
    ],
  },

  quant: {
    type: 'quant',
    name: 'Quantizer',
    group: 'modulation',
    slug: 'qnt',
    width: 'half',
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [
      { id: 'out', label: 'Out' },
      // Fires on every new note, so something can be struck on each one.
      { id: 'trig', label: 'Trig' },
    ],
    params: [
      {
        id: 'root', label: 'Root', min: 0, max: 11, default: 0, unit: '', curve: 'lin',
        steps: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
      },
      // In the order the DSP's list is in: chromatic, then the song's scales.
      {
        id: 'scale', label: 'Scale', min: 0, max: 8, default: 1, unit: '', curve: 'lin',
        steps: ['chrom', 'major', 'minor', 'harm', 'dorian', 'mixo', 'pent', 'pent m', 'blues'],
      },
    ],
  },

  cv: {
    type: 'cv',
    name: 'CV Utility',
    group: 'modulation',
    slug: 'cv',
    width: 'half',
    // No multiple: outputs already fan out to as many cables as you like.
    inputs: [
      { id: 'in1', label: '1' },
      { id: 'in2', label: '2' },
    ],
    outputs: [
      { id: 'out1', label: '1' },
      { id: 'out2', label: '2' },
      { id: 'sum', label: 'Sum' },
    ],
    params: [
      // Bipolar gain, which is the point: negative inverts. With nothing
      // patched the input is ground, so the offset alone comes out and the
      // channel is a manual CV source.
      { id: 'gain1', label: 'Gain 1', min: -2, max: 2, default: 1, unit: '', curve: 'lin' },
      { id: 'offset1', label: 'Off 1', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'gain2', label: 'Gain 2', min: -2, max: 2, default: 1, unit: '', curve: 'lin' },
      { id: 'offset2', label: 'Off 2', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
    ],
  },

  ladder: {
    type: 'ladder',
    name: 'Ladder Filter',
    group: 'voice',
    slug: 'lpf',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'CV' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'cutoff', label: 'Cutoff', min: 20, max: 18000, default: 1400, unit: 'Hz', curve: 'exp' },
      { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0.35, unit: '', curve: 'lin' },
      { id: 'drive', label: 'Drive', min: 1, max: 12, default: 1.5, unit: 'x', curve: 'exp' },
      { id: 'cvAmount', label: 'CV Amt', min: -5, max: 5, default: 2.5, unit: 'oct', curve: 'lin' },
      // Last, because the DSP reads these by index and the four above were
      // here first. Position 0 is the plain 24 dB lowpass, so a patch saved
      // before this knob existed opens sounding exactly as it did.
      { id: 'mode', label: 'Mode', min: 0, max: 3, default: 0, unit: '', curve: 'lin', steps: ['lp24', 'lp12', 'bp', 'hp'] },
    ],
  },

  svf: {
    type: 'svf',
    name: 'Multimode Filter',
    group: 'voice',
    slug: 'mmf',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'CV' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      // In the comb modes this is the comb's pitch rather than a corner.
      { id: 'cutoff', label: 'Cutoff', min: 20, max: 18000, default: 1000, unit: 'Hz', curve: 'exp' },
      { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0.3, unit: '', curve: 'lin' },
      // One octave per unit by default, where the Ladder's is two and a half:
      // a comb is a pitch, and 1.00 is what plays it in tune from a keyboard.
      { id: 'cvAmount', label: 'CV Amt', min: -5, max: 5, default: 1, unit: 'oct', curve: 'lin' },
      {
        id: 'mode', label: 'Mode', min: 0, max: 6, default: 0, unit: '', curve: 'lin',
        steps: ['lp', 'bp', 'hp', 'notch', 'peak', 'comb+', 'comb−'],
      },
    ],
  },

  formant: {
    type: 'formant',
    name: 'Formant',
    group: 'voice',
    slug: 'fmt',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'vowel', label: 'Vowel' },
      { id: 'size', label: 'Size' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      // Continuous, not a switch: in between is where a mouth moving is heard.
      { id: 'vowel', label: 'Vowel', min: 0, max: 4, default: 2, unit: 'vowel', curve: 'lin' },
      // Bigger is lower formants, whatever pitch the source is at.
      { id: 'size', label: 'Size', min: 0.4, max: 2.5, default: 1, unit: 'x', curve: 'exp' },
      { id: 'res', label: 'Res', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      // Vowels per unit of CV, so a full-scale LFO at 2.00 sweeps oo to ee.
      { id: 'vowelAmount', label: 'Vowel Amt', min: -4, max: 4, default: 2, unit: '', curve: 'lin' },
      { id: 'sizeAmount', label: 'Size Amt', min: -2, max: 2, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  eq: {
    type: 'eq',
    name: 'EQ',
    group: 'effects',
    slug: 'eq',
    bypass: true,
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      // Cut goes further than boost, as on every console: taking a problem
      // out is most of what an EQ is for, and a boost past twelve decibels is
      // a different sound rather than a correction.
      { id: 'lowGain', label: 'Low', min: -24, max: 12, default: 0, unit: 'dB', curve: 'lin' },
      { id: 'lowFreq', label: 'Low Freq', min: 40, max: 800, default: 200, unit: 'Hz', curve: 'exp' },
      { id: 'midGain', label: 'Mid', min: -24, max: 12, default: 0, unit: 'dB', curve: 'lin' },
      { id: 'midFreq', label: 'Mid Freq', min: 200, max: 8000, default: 1000, unit: 'Hz', curve: 'exp' },
      { id: 'highGain', label: 'High', min: -24, max: 12, default: 0, unit: 'dB', curve: 'lin' },
      { id: 'highFreq', label: 'High Freq', min: 1500, max: 16000, default: 5000, unit: 'Hz', curve: 'exp' },
    ],
  },

  drive: {
    type: 'drive',
    name: 'Drive',
    group: 'effects',
    slug: 'drv',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'Drive' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'drive', label: 'Drive', min: 1, max: 64, default: 2, unit: 'x', curve: 'exp' },
      {
        id: 'curve', label: 'Curve', min: 0, max: 3, default: 0, unit: '', curve: 'lin',
        steps: ['tanh', 'clip', 'fold', 'rect'],
      },
      // Off centre before shaping, which is what makes one half of the wave
      // clip harder than the other and puts even harmonics in the result.
      { id: 'bias', label: 'Bias', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'level', label: 'Level', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      // Exponential, like every other CV in the rack: a fixed amount moves
      // it by the same number of doublings wherever the knob is set. Last in
      // the list because the DSP reads parameters by position.
      { id: 'cvAmount', label: 'Drive Amt', min: -4, max: 4, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  fold: {
    type: 'fold',
    name: 'Wavefolder',
    group: 'effects',
    slug: 'fold',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'Fold' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      // The Fold jack moves this, in octaves scaled by Fold Amt, and leaves
      // the level alone. A VCA in front still modulates it too -- folding
      // depends on how hard the wave is driven into the rails -- but takes
      // the level with it.
      { id: 'fold', label: 'Fold', min: 1, max: 16, default: 2, unit: 'x', curve: 'exp' },
      { id: 'symmetry', label: 'Sym', min: -1, max: 1, default: 0, unit: '', curve: 'lin' },
      // Exponential, like every other CV in the rack: a fixed amount moves
      // it by the same number of doublings wherever the knob is set. Last in
      // the list because the DSP reads parameters by position.
      { id: 'cvAmount', label: 'Fold Amt', min: -4, max: 4, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  ring: {
    type: 'ring',
    name: 'Ring Mod',
    group: 'effects',
    slug: 'ring',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'car', label: 'Car' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      // Free-running, as the sample and hold's clocks are, so the knob always
      // does something and the rack gains a spare sine.
      { id: 'sine', label: 'Sine' },
    ],
    params: [
      { id: 'freq', label: 'Freq', min: 1, max: 4000, default: 220, unit: 'Hz', curve: 'exp' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
    ],
  },

  crush: {
    type: 'crush',
    name: 'Bitcrusher',
    group: 'effects',
    slug: 'bits',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'Rate' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'bits', label: 'Bits', min: 1, max: 16, default: 8, unit: '#', curve: 'lin' },
      { id: 'rate', label: 'Rate', min: 100, max: 24000, default: 8000, unit: 'Hz', curve: 'exp' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
      // Exponential, like every other CV in the rack: a fixed amount moves
      // it by the same number of doublings wherever the knob is set. Last in
      // the list because the DSP reads parameters by position.
      { id: 'cvAmount', label: 'Rate Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
    ],
  },

  comp: {
    type: 'comp',
    name: 'Compressor',
    group: 'effects',
    slug: 'comp',
    bypass: true,
    shared: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      // Listens to this instead when something is patched to it, so one sound
      // can duck under another.
      { id: 'key', label: 'Key' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      // How hard it is working, as a control voltage: 0 doing nothing, and
      // towards 1 as it clamps down.
      { id: 'gr', label: 'GR' },
    ],
    params: [
      { id: 'threshold', label: 'Thresh', min: -60, max: 0, default: -18, unit: 'dB', curve: 'lin' },
      // Exponential, because the useful settings crowd the bottom: 2 and 4 are
      // different compressors, 16 and 20 are the same limiter.
      { id: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, unit: '', curve: 'exp' },
      { id: 'attack', label: 'Attack', min: 0.0002, max: 0.2, default: 0.005, unit: 's', curve: 'exp' },
      { id: 'release', label: 'Release', min: 0.005, max: 2, default: 0.15, unit: 's', curve: 'exp' },
      // Stops at 12 dB. With nothing over the threshold the module is a plain
      // amplifier, so the top of this knob is the loudest it can ever be, and
      // four times full scale is already as hot as anything else in the rack.
      { id: 'makeup', label: 'Makeup', min: 0, max: 12, default: 0, unit: 'dB', curve: 'lin' },
    ],
  },

  gran: {
    type: 'gran',
    name: 'Granular',
    group: 'effects',
    slug: 'gran',
    bypass: true,
    shared: true,
    // Seven knobs, so it takes a whole row. It is also the module you spend
    // the longest adjusting, and two rows of knobs in half a panel is a worse
    // place to do that than one row in a whole one.
    inputs: [
      { id: 'in', label: 'In' },
      // Both are read when a grain starts and held for its lifetime, so these
      // scatter the cloud rather than bending what is already sounding.
      { id: 'pos', label: 'Pos' },
      { id: 'pitch', label: 'Pitch' },
    ],
    // Stereo, because a cloud that arrives from one point is not a cloud. Two
    // mixer channels panned hard apart, as the Space module wants.
    outputs: [
      { id: 'l', label: 'L' },
      { id: 'r', label: 'R' },
    ],
    params: [
      { id: 'size', label: 'Size', min: 0.002, max: 0.5, default: 0.08, unit: 's', curve: 'exp' },
      { id: 'density', label: 'Density', min: 0.5, max: 200, default: 20, unit: 'Hz', curve: 'exp' },
      // How far behind the live signal the grains are read from.
      { id: 'position', label: 'Pos', min: 0.005, max: 2, default: 0.1, unit: 's', curve: 'exp' },
      // A fraction of the whole buffer, not of Position: at 1.00 grains come
      // from anywhere in the last two seconds, which is what makes a texture
      // rather than a stutter.
      { id: 'spray', label: 'Spray', min: 0, max: 1, default: 0.2, unit: '', curve: 'lin' },
      { id: 'pitch', label: 'Pitch', min: -2, max: 2, default: 0, unit: 'oct', curve: 'lin' },
      { id: 'spread', label: 'Spread', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '', curve: 'lin' },
    ],
  },

  delay: {
    type: 'delay',
    name: 'Delay',
    group: 'effects',
    slug: 'dly',
    bypass: true,
    shared: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'Time' },
    ],
    outputs: [
      { id: 'out', label: 'Out' },
      // The repeats without the dry signal, for sending them somewhere else.
      { id: 'wet', label: 'Wet' },
    ],
    params: [
      // Short by default. A slapback is what a sound effect wants, and it is
      // also the setting where the feedback and damping knobs are audible
      // rather than a quarter of a second away.
      { id: 'time', label: 'Time', min: 0.002, max: 2, default: 0.04, unit: 's', curve: 'exp' },
      { id: 'cvAmount', label: 'Time Amt', min: -2, max: 2, default: 0, unit: 'oct', curve: 'lin' },
      { id: 'feedback', label: 'Fdbk', min: 0, max: 0.95, default: 0.35, unit: '', curve: 'lin' },
      { id: 'damping', label: 'Damp', min: 0, max: 1, default: 0.3, unit: '', curve: 'lin' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.35, unit: '', curve: 'lin' },
    ],
  },

  chorus: {
    type: 'chorus',
    name: 'Chorus',
    group: 'effects',
    slug: 'cho',
    bypass: true,
    // One for the whole chord, as the echo and the room are: a chorus per
    // voice would cost eight and sound like one.
    shared: true,
    inputs: [
      { id: 'in', label: 'In' },
      // Added straight to Center, so an envelope can sweep a flanger by hand.
      { id: 'cv', label: 'Center' },
    ],
    // Stereo, the right side's sweep a quarter cycle behind the left's, so
    // the movement crosses the field.
    outputs: [
      { id: 'l', label: 'L' },
      { id: 'r', label: 'R' },
    ],
    params: [
      { id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, unit: '', curve: 'lin', steps: ['chorus', 'flanger', 'phaser'] },
      { id: 'rate', label: 'Rate', min: 0.02, max: 10, default: 0.4, unit: 'Hz', curve: 'exp' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      { id: 'center', label: 'Center', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      // Bipolar, because a flanger fed back upside down is a different and
      // hollower sound, not just a quieter one.
      { id: 'feedback', label: 'Fdbk', min: -0.95, max: 0.95, default: 0, unit: '', curve: 'lin' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
    ],
  },

  reverb: {
    type: 'reverb',
    name: 'Space',
    group: 'effects',
    slug: 'spc',
    bypass: true,
    shared: true,
    width: 'half',
    inputs: [{ id: 'in', label: 'In' }],
    // Stereo, because the tail is what gives a rack its width and the two
    // sides come out of the network already decorrelated.
    outputs: [
      { id: 'l', label: 'L' },
      { id: 'r', label: 'R' },
    ],
    params: [
      { id: 'size', label: 'Size', min: 0, max: 1, default: 0.5, unit: '', curve: 'lin' },
      { id: 'decay', label: 'Decay', min: 0.05, max: 20, default: 1.6, unit: 's', curve: 'exp' },
      { id: 'damping', label: 'Damp', min: 0, max: 1, default: 0.4, unit: '', curve: 'lin' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, unit: '', curve: 'lin' },
    ],
  },

  res: {
    type: 'res',
    name: 'Resonator',
    group: 'effects',
    slug: 'res',
    bypass: true,
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'CV' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      { id: 'pitch', label: 'Pitch', min: 20, max: 4000, default: 220, unit: 'Hz', curve: 'exp' },
      { id: 'cvAmount', label: 'CV Amt', min: -5, max: 5, default: 0, unit: 'oct', curve: 'lin' },
      { id: 'decay', label: 'Decay', min: 0.01, max: 10, default: 0.6, unit: 's', curve: 'exp' },
      { id: 'damping', label: 'Damp', min: 0, max: 1, default: 0.4, unit: '', curve: 'lin' },
    ],
  },

  vca: {
    type: 'vca',
    name: 'VCA',
    group: 'voice',
    slug: 'vca',
    width: 'half',
    inputs: [
      { id: 'in', label: 'In' },
      { id: 'cv', label: 'CV' },
    ],
    outputs: [{ id: 'out', label: 'Out' }],
    params: [
      // Initial gain, as on a real VCA: with nothing patched to CV and this at
      // zero the VCA is closed, which is why the default patch cables an
      // envelope into it.
      { id: 'level', label: 'Level', min: 0, max: 1, default: 0, unit: '', curve: 'lin' },
      { id: 'cvAmount', label: 'CV Amt', min: 0, max: 2, default: 1, unit: '', curve: 'lin' },
    ],
  },

  mixer: {
    type: 'mixer',
    name: 'Mixer',
    group: 'output',
    slug: 'mix',
    shared: true,
    // The console is the end of the chain: a mixer nobody has patched onward
    // goes straight to the speakers, which is what makes an oscillator and a
    // mixer a working rack.
    bus: ['l', 'r'],
    inputs: CHANNELS.map((n) => ({ id: `in${n}`, label: `${n}`, block: 'channels' })),
    outputs: [
      { id: 'l', label: 'L', block: 'main' },
      { id: 'r', label: 'R', block: 'main' },
    ],
    params: [
      ...CHANNELS.flatMap((n) => [
        {
          id: `level${n}`, label: `Lvl ${n}`,
          min: 0, max: 1, default: 0.8, unit: '', curve: 'lin' as const,
        },
        {
          id: `pan${n}`, label: `Pan ${n}`,
          min: -1, max: 1, default: 0, unit: '', curve: 'lin' as const,
        },
      ]),
      { id: 'master', label: 'Master', min: 0, max: 1, default: 0.8, unit: '', curve: 'lin' },
      // After Master, because the DSP addresses the level and pan pair for
      // each channel by index and the master after them, and none of those
      // may move. Mute before Solo, and both in channel order, so the DSP can
      // reach either block with one base plus the channel number.
      // No `steps`, although these are switches. `steps` is what makes the
      // generic control row draw a knob as a switch, and the mixer draws its
      // own face -- so all it would buy here is sixteen two-position switches
      // for the catalogue check to take the product of, which is sixty-five
      // thousand rigs to render for a module that also has thirty-three knobs.
      ...CHANNELS.map((n) => ({
        id: `mute${n}`, label: `Mute ${n}`,
        min: 0, max: 1, default: 0, unit: '', curve: 'lin' as const,
      })),
      ...CHANNELS.map((n) => ({
        id: `solo${n}`, label: `Solo ${n}`,
        min: 0, max: 1, default: 0, unit: '', curve: 'lin' as const,
      })),
    ],
  },

  scope: {
    type: 'scope',
    name: 'Scope',
    group: 'output',
    slug: 'scope',
    shared: true,
    // No outputs: a scope taps a signal rather than sitting in the chain, so
    // patching one in cannot change what the rack sounds like.
    // Two traces: comparing a carrier against its modulator, or a filter's
    // input against its output, is most of what a scope is for. A is the one
    // the spectrum reads, and the one that was here before.
    inputs: [
      { id: 'in', label: 'A' },
      { id: 'in2', label: 'B' },
    ],
    outputs: [],
    // Read by the display rather than by the DSP, but declared here like any
    // other parameter so the UI builds them the usual way and a saved patch
    // remembers where the scope was set.
    params: [
      { id: 'timebase', label: 'Time', min: 0.001, max: 0.08, default: 0.02, unit: 's', curve: 'exp' },
      { id: 'gain', label: 'Gain', min: 0.1, max: 16, default: 1, unit: 'x', curve: 'exp' },
      { id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, unit: '', curve: 'lin', steps: ['wave', 'spectrum'] },
    ],
  },

  rec: {
    type: 'rec',
    name: 'Recorder',
    group: 'output',
    slug: 'rec',
    shared: true,
    // A tape machine, not a fader: it takes the level it is given. The rack's
    // own volume lives on the mixer, where the signal is actually balanced.
    tap: ['l', 'r'],
    // The L jack normals to both sides when R is unpatched, as on hardware,
    // so a mono patch needs only one cable. With neither patched the whole
    // module normals to the speaker bus, so it records what you hear.
    inputs: [
      { id: 'l', label: 'L / Mono' },
      { id: 'r', label: 'R' },
    ],
    outputs: [],
    params: [],
  },
}

export const MIXER_CHANNELS = CHANNELS
export const SEQ_STEPS_LIST = SEQ_STEPS

/** The order the menus and the add panel list the groups in. */
export const MODULE_GROUPS: { id: ModuleGroup; name: string }[] = [
  { id: 'voice', name: 'Voice' },
  { id: 'effects', name: 'Effects' },
  { id: 'modulation', name: 'Modulation' },
  { id: 'control', name: 'Control' },
  { id: 'output', name: 'Output' },
]

/** The catalogue split by group, in catalogue order within each. */
export function modulesByGroup(group: ModuleGroup) {
  return Object.values(MODULE_DEFS).filter((d) => d.group === group)
}

export const MODULE_TYPES = Object.keys(MODULE_DEFS)

export function defOf(type: string) {
  const def = MODULE_DEFS[type]
  if (!def) throw new Error(`unknown module type: ${type}`)
  return def
}

/** What travels down a cable from an output: sound, a control voltage, or on/off. */
export type Signal = 'audio' | 'cv' | 'gate'

/** Outputs that only ever carry on and off, whatever module they are on. */
const GATE_OUTPUTS = new Set(['gate', 'trig', 'end', 'clk', 'x1', 'd2', 'd3', 'd4', 'd8'])
/** Outputs of a sound-making module that carry control rather than sound. */
const CONTROL_OUTPUTS = new Set(['env', 'pitch', 'vel', 'ramp', 'gr', 'cv'])

/**
 * Worked out from the catalogue rather than declared on every port: the
 * gate-shaped names mean the same on every module that has them, and the
 * rest is audio on a module that makes or treats sound and control on one
 * that modulates. Used for colouring cables, where a guess that is right
 * nine times in ten is a guide rather than a claim.
 */
export function signalOf(type: string, port: string): Signal {
  const def = MODULE_DEFS[type]
  if (!def) return 'cv'
  if (GATE_OUTPUTS.has(port) || /^clk\d$/.test(port)) return 'gate'
  if (CONTROL_OUTPUTS.has(port)) return 'cv'
  return def.group === 'voice' || def.group === 'effects' || def.group === 'output' ? 'audio' : 'cv'
}
