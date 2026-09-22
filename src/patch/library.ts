import { defOf } from './defs'
import { defaultPatch } from './defaultPatch'
import { addModule, connect, nextModuleId } from './edit'
import type { Patch, PatchModule } from './types'

/**
 * A rack to start from.
 *
 * These are templates, not files. Choosing one replaces what is on the bench
 * with a copy of it; nothing here is ever written back, and a template cannot
 * be changed from inside the app. That is the whole distinction -- a patch
 * library is a shelf of starting points, and the file you make from one is
 * yours to save wherever you keep files.
 *
 * Every one of them is a tutorial from MANUAL.md, built by the same code the
 * manual's own check renders and listens to. So a template that stopped
 * making a sound, drifted out of range, started clipping or lost a cable
 * fails `npm run check:manual` before anyone opens the menu -- which is the
 * only way a shelf of fifteen racks stays trustworthy while the modules
 * underneath them keep changing.
 */
export interface Template {
  /** Stable across renames: it is what a saved reference would name. */
  id: string
  name: string
  /** What the sound is, in one line, for the list. */
  description: string
  /** What building it teaches, taken from the tutorial it comes from. */
  teaches: string
  /** Which tutorial in MANUAL.md, for the reader who wants the prose. */
  tutorial: number
  /** The rack, with everything it does not use already taken out. */
  build(): Built
}

/** A shelf entry before pruning, which is the only way one is written. */
interface Entry extends Omit<Template, 'build'> {
  make(): Built
}

export interface Built {
  patch: Patch
  /**
   * Knob positions, keyed `moduleId.paramId` and sparse: anything a template
   * does not mention is left wherever the module's own default puts it.
   */
  values: Record<string, number>
}

// --- building blocks ---------------------------------------------------

/** `"osc1.out -> lpf1.in"`, as the manual writes a cable. */
export function wire(patch: Patch, ...wires: string[]): Patch {
  let next = patch
  for (const w of wires) {
    const [from, to] = w.split(' -> ')
    const [fromModule, fromPort] = from.split('.')
    const [toModule, toPort] = to.split('.')
    const before = next
    next = connect(next, { module: fromModule, port: fromPort }, { module: toModule, port: toPort })
    // `connect` silently declines a cable it cannot make, which would leave a
    // template quietly missing a step and sounding like nothing much.
    if (next === before) throw new Error(`the cable "${w}" did not connect`)
  }
  return next
}

/**
 * Add a module, at the top.
 *
 * Where the Modules menu puts them, and these racks are meant to be the ones
 * a reader following the tutorial ends up with. What a patch does is decided
 * by its cables rather than by the order of its units, but a template built
 * in an order nobody can actually produce would not match the prose.
 */
export function add(patch: Patch, type: string): Patch {
  return addModule(patch, { id: nextModuleId(patch, type), type, params: {} }, 'top')
}

/** Several of a kind, in order. */
function addAll(patch: Patch, types: string[]): Patch {
  let next = patch
  for (const type of types) next = add(next, type)
  return next
}

/**
 * The rack every tutorial starts from, as MANUAL's "Build the tutorial rack"
 * tells the reader to build it.
 *
 * The stock rack is a voice but not a workbench. Several of these run noise
 * through the filter, and noise has no envelope of its own, so they need a
 * separate envelope and a VCA for it to open. The Trigger they are all fired
 * from is already in the stock rack, on Space.
 */
export function tutorialRack(): Patch {
  const patch = wire(
    addAll(defaultPatch(), ['adsr', 'vca', 'noise', 'osc']),
    'gate1.gate -> env1.gate',
    // Both of these land in occupied inputs and push out a stock cable: the
    // envelope takes the filter over, and the VCA takes over the mixer feed.
    'env1.out -> lpf1.cv',
    'lpf1.out -> vca1.in',
    'env1.out -> vca1.cv',
    'vca1.out -> mix1.in1',
  )
  // The oscillator hands its envelope duties to env1. Left at full it would
  // shape the sound a second time underneath the one being set.
  return patch
}

/** The tutorial rack's one knob change, which every template inherits. */
const RACK_VALUES = { 'osc1.envAmount': 0 }

/**
 * Take out everything the rack cannot be heard through.
 *
 * The tutorial rack is shared by all fifteen of these, so it carries an
 * envelope, a VCA, a noise source and a second oscillator whether or not a
 * given patch wants them. That is right for a reader building the tutorials
 * one after another -- they build it once and keep it -- and wrong for a
 * finished rack handed over on its own, where a unit patched to nothing is
 * just a thing to wonder about. The second oscillator was idle in thirteen of
 * the fifteen before this existed.
 *
 * Reachability rather than "has a cable", because a cable is not the same as
 * being audible: the stock rack wires the Trigger into the oscillator's Gate,
 * so an oscillator whose output has been replaced downstream still has a
 * cable on it while feeding precisely nothing. So the walk goes backwards
 * from whatever leaves the rack -- a mixer bus, or a recorder's tap -- and
 * anything it does not reach comes out, along with its cables and its knobs.
 */
function prune({ patch, values }: Built): Built {
  const feeding = new Map<string, string[]>()
  for (const c of patch.cables) {
    const list = feeding.get(c.to.module)
    if (list) list.push(c.from.module)
    else feeding.set(c.to.module, [c.from.module])
  }

  const keep = new Set<string>()
  const queue: string[] = []
  for (const m of patch.modules) {
    const def = defOf(m.type)
    // A bus goes to the speakers and a tap goes to a file. Either way it is
    // the end of the chain, and it stays whatever is patched to it.
    if (def.bus || def.tap) {
      keep.add(m.id)
      queue.push(m.id)
    }
  }
  while (queue.length > 0) {
    for (const from of feeding.get(queue.pop()!) ?? []) {
      if (keep.has(from)) continue
      keep.add(from)
      queue.push(from)
    }
  }

  const modules = patch.modules.filter((m) => keep.has(m.id))
  if (modules.length === patch.modules.length) return { patch, values }

  // Anything feeding a kept module was itself kept, so the only cables left
  // to drop are the ones running into something on its way out.
  const cables = patch.cables.filter((c) => keep.has(c.from.module) && keep.has(c.to.module))
  const kept: Record<string, number> = {}
  for (const [key, v] of Object.entries(values)) {
    if (keep.has(key.slice(0, key.lastIndexOf('.')))) kept[key] = v
  }
  return { patch: { modules, cables }, values: kept }
}

// --- the shelf ---------------------------------------------------------

const SHELF: Entry[] = [
  {
    id: 'laser',
    name: 'Laser',
    description: 'A descending electronic pew, the way arcade games have always made one.',
    teaches: 'Using an envelope to move pitch rather than volume.',
    tutorial: 1,
    make: () => ({
      patch: wire(tutorialRack(), 'env1.out -> osc1.fm'),
      values: {
        ...RACK_VALUES,
        'osc1.pitch': 220,
        'osc1.wave': 0,
        'osc1.fmAmount': 3,
        'env1.attack': 0.0005,
        'env1.decay': 0.18,
        'env1.sustain': 0,
        'env1.release': 0.05,
        'lpf1.cutoff': 12000,
        'lpf1.resonance': 0.2,
        'lpf1.cvAmount': 0,
      },
    }),
  },
  {
    id: 'footstep',
    name: 'Footstep',
    description: 'A soft thump on a wooden floor. Pink noise, shaped twice by one envelope.',
    teaches: 'Noise as a sound source, and why an input takes only one cable.',
    tutorial: 2,
    make: () => ({
      patch: wire(tutorialRack(), 'noise1.out -> lpf1.in'),
      values: {
        ...RACK_VALUES,
        'noise1.color': 1,
        'noise1.level': 1,
        'env1.attack': 0.001,
        'env1.decay': 0.07,
        'env1.sustain': 0,
        'env1.release': 0.04,
        'lpf1.cutoff': 300,
        'lpf1.resonance': 0.25,
        'lpf1.drive': 2,
        'lpf1.cvAmount': 2.5,
      },
    }),
  },
  {
    id: 'chatter',
    name: 'Computer chatter',
    description: 'Burbling machine talk that runs on its own, with no trigger at all.',
    teaches: 'The Sample & Hold as a free-running source, and scaling CV.',
    tutorial: 3,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['sh', 'cv']),
        'sh1.out1 -> cv1.in1',
        'cv1.out1 -> osc1.fm',
        'sh1.clk1 -> osc1.gate',
      ),
      values: {
        ...RACK_VALUES,
        'sh1.rate1': 9,
        'cv1.gain1': 0.5,
        'osc1.pitch': 700,
        'osc1.wave': 1,
        'osc1.fmAmount': 2,
        'osc1.envAmount': 1,
        'osc1.attack': 0.002,
        'osc1.decay': 0.03,
        'osc1.sustain': 0,
        'osc1.release': 0.01,
        'lpf1.cutoff': 12000,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
      },
    }),
  },
  {
    id: 'wind',
    name: 'Wind',
    description: 'A bed that never stops and never quite repeats, wandering in tone.',
    teaches: 'Building a sound with no end, and Slew turning steps into drift.',
    tutorial: 4,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['sh', 'slew']),
        'noise1.out -> lpf1.in',
        'sh1.out1 -> slew1.in',
        'slew1.out -> lpf1.cv',
      ),
      values: {
        ...RACK_VALUES,
        'noise1.color': 1,
        'noise1.level': 1,
        'sh1.rate1': 1.5,
        'slew1.rise': 0.5,
        'slew1.fall': 0.5,
        'slew1.shape': 1,
        'lpf1.cutoff': 700,
        'lpf1.resonance': 0.55,
        'lpf1.drive': 1,
        'lpf1.cvAmount': 1.5,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
      },
    }),
  },
  {
    id: 'explosion',
    name: 'Explosion',
    description: 'A low thump under a long rumble. Two layers, mixed.',
    teaches: 'Layering through the Mixer, and an oscillator shaping itself.',
    tutorial: 5,
    make: () => ({
      patch: wire(
        tutorialRack(),
        'noise1.out -> lpf1.in',
        'gate1.gate -> osc1.gate',
        'osc1.env -> osc1.fm',
        'osc1.out -> mix1.in2',
      ),
      values: {
        ...RACK_VALUES,
        'noise1.color': 1,
        'noise1.level': 1,
        'env1.attack': 0.002,
        'env1.decay': 1.2,
        'env1.sustain': 0,
        'env1.release': 0.4,
        'lpf1.cutoff': 180,
        'lpf1.resonance': 0.3,
        'lpf1.drive': 3,
        'lpf1.cvAmount': 3,
        'osc1.pitch': 70,
        'osc1.wave': 3,
        'osc1.fmAmount': 1.5,
        'osc1.envAmount': 1,
        'osc1.attack': 0.004,
        'osc1.decay': 0.7,
        'osc1.sustain': 0,
        'osc1.release': 0.3,
        'mix1.level1': 0.8,
        'mix1.level2': 0.7,
      },
    }),
  },
  {
    id: 'siren',
    name: 'Siren',
    description: 'A wailing two-tone that runs for as long as you leave it.',
    teaches: 'The LFO, and a sound that needs no trigger.',
    tutorial: 6,
    make: () => ({
      patch: wire(tutorialRack(), 'lfo1.out -> osc1.fm'),
      values: {
        ...RACK_VALUES,
        'osc1.pitch': 440,
        'osc1.wave': 0,
        'osc1.fmAmount': 0.6,
        'lfo1.rate': 0.7,
        'lfo1.shape': 2,
        'lfo1.depth': 1,
        'lpf1.cutoff': 6000,
        'lpf1.resonance': 0.2,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
      },
    }),
  },
  {
    id: 'drop',
    name: 'Water drop',
    description: 'A bubble surfacing: a pitch that climbs as it fades.',
    teaches: 'Resonance as a sound source, and a gate held longer than the sound.',
    tutorial: 7,
    make: () => ({
      patch: wire(
        add(tutorialRack(), 'slew'),
        'noise1.out -> lpf1.in',
        'gate1.gate -> slew1.in',
        'slew1.out -> lpf1.cv',
      ),
      values: {
        ...RACK_VALUES,
        'noise1.level': 1,
        'slew1.rise': 0.25,
        'slew1.fall': 0.02,
        'slew1.shape': 1,
        'lpf1.cutoff': 260,
        'lpf1.resonance': 0.97,
        'lpf1.drive': 1.5,
        'lpf1.cvAmount': 2.5,
        'env1.attack': 0.004,
        'env1.decay': 0.3,
        'env1.sustain': 0,
        'env1.release': 0.08,
      },
    }),
  },
  {
    id: 'engine',
    name: 'Engine',
    description: 'An idling motor, thickened by a second oscillator a hair out of tune.',
    teaches: 'Pulse width modulation, and beating two oscillators together.',
    tutorial: 8,
    make: () => ({
      patch: wire(tutorialRack(), 'lfo1.out -> osc1.pwm', 'osc2.out -> mix1.in2'),
      values: {
        ...RACK_VALUES,
        'osc1.pitch': 55,
        'osc1.wave': 1,
        'osc1.width': 0.5,
        'osc2.pitch': 56,
        'osc2.wave': 0,
        'lfo1.rate': 7,
        'lfo1.shape': 3,
        'lfo1.depth': 0.8,
        'lpf1.cutoff': 420,
        'lpf1.resonance': 0.4,
        'lpf1.drive': 2.5,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
        'mix1.level1': 0.8,
        'mix1.level2': 0.35,
      },
    }),
  },
  {
    id: 'powerup',
    name: 'Power-up',
    description: 'A ladder of blips climbing away, the coin-collected sound.',
    teaches: 'Feeding the Sample & Hold a real signal instead of noise.',
    tutorial: 9,
    make: () => ({
      patch: wire(
        add(tutorialRack(), 'sh'),
        'lfo1.out -> sh1.in1',
        'sh1.out1 -> osc1.fm',
        'sh1.clk1 -> osc1.gate',
      ),
      values: {
        ...RACK_VALUES,
        'lfo1.rate': 0.5,
        'lfo1.shape': 0,
        'lfo1.depth': 1,
        'sh1.rate1': 12,
        'osc1.pitch': 440,
        'osc1.wave': 1,
        'osc1.width': 0.35,
        'osc1.fmAmount': 1.5,
        'osc1.envAmount': 1,
        'osc1.attack': 0.002,
        'osc1.decay': 0.05,
        'osc1.sustain': 0,
        'osc1.release': 0.02,
        'lpf1.cutoff': 9000,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
      },
    }),
  },
  {
    id: 'synczap',
    name: 'Sync zap',
    description: 'A tearing, gritty zap that no filter sweep can imitate.',
    teaches: 'Hard sync, the one thing in this rack that makes that sound.',
    tutorial: 10,
    make: () => ({
      patch: wire(
        tutorialRack(),
        'osc1.out -> osc2.sync',
        'osc2.out -> lpf1.in',
        'env1.out -> osc2.fm',
      ),
      values: {
        ...RACK_VALUES,
        'osc1.pitch': 165,
        'osc1.wave': 0,
        'osc2.pitch': 165,
        'osc2.wave': 0,
        'osc2.fmAmount': 3,
        'env1.attack': 0.002,
        'env1.decay': 0.5,
        'env1.sustain': 0,
        'env1.release': 0.12,
        'lpf1.cutoff': 14000,
        'lpf1.resonance': 0.15,
        'lpf1.cvAmount': 0,
      },
    }),
  },
  {
    id: 'ricochet',
    name: 'Ricochet',
    description: 'A bullet spanging away, each ping lower and closer than the last.',
    teaches: 'The Burst generator, the Resonator, and what the Ramp output is for.',
    tutorial: 11,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['burst', 'res']),
        'noise1.out -> lpf1.in',
        // The Trigger fires the run, and the run fires the envelope. Without
        // the first of these the Burst answers to nothing but its own button,
        // and the key plays silence.
        'gate1.gate -> brst1.trig',
        // Replaces gate1's cable into the envelope: the pulses drive it now.
        'brst1.gate -> env1.gate',
        'vca1.out -> res1.in',
        // The ramp climbs across the run, and a negative CV Amt turns that
        // into a pitch that falls -- each ping lower than the one before it.
        'brst1.ramp -> res1.cv',
        'res1.out -> mix1.in1',
      ),
      values: {
        ...RACK_VALUES,
        'brst1.count': 6,
        'brst1.rate': 11,
        'brst1.curve': -0.5,
        'brst1.jitter': 0.3,
        'brst1.width': 0.05,
        'env1.attack': 0.001,
        'env1.decay': 0.02,
        'env1.sustain': 0,
        'env1.release': 0.01,
        'lpf1.cutoff': 1200,
        'lpf1.cvAmount': 0,
        'res1.pitch': 1400,
        'res1.cvAmount': -2,
        'res1.decay': 0.25,
        'res1.damping': 0.3,
      },
    }),
  },
  {
    id: 'machinegun',
    name: 'Machine gun',
    description: 'Eight rounds of cracking gunfire, spaced just unevenly enough.',
    teaches: 'The Burst as a rate of fire, and asymmetric drive as a crack.',
    tutorial: 12,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['burst', 'drive']),
        'noise1.out -> lpf1.in',
        'gate1.gate -> brst1.trig',
        'brst1.gate -> env1.gate',
        'vca1.out -> drv1.in',
        'drv1.out -> mix1.in1',
      ),
      values: {
        ...RACK_VALUES,
        'brst1.count': 8,
        'brst1.rate': 14,
        'brst1.curve': 0,
        'brst1.jitter': 0.15,
        'brst1.width': 0.1,
        'noise1.color': 0,
        'env1.attack': 0.001,
        'env1.decay': 0.035,
        'env1.sustain': 0,
        'env1.release': 0.02,
        'lpf1.cutoff': 1800,
        'lpf1.resonance': 0.3,
        'lpf1.drive': 2,
        'lpf1.cvAmount': 3,
        'drv1.drive': 20,
        'drv1.curve': 1,
        'drv1.bias': 0.35,
        'drv1.level': 0.7,
      },
    }),
  },
  {
    id: 'transmission',
    name: 'Alien transmission',
    description: 'Clipped, metallic speech arriving through a very cheap radio.',
    teaches: 'The Ring Modulator and the Bitcrusher, and why they suit each other.',
    tutorial: 13,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['sh', 'cv', 'ring', 'crush']),
        'sh1.out1 -> cv1.in1',
        'cv1.out1 -> osc1.fm',
        'sh1.clk1 -> osc1.gate',
        'vca1.out -> ring1.in',
        'ring1.out -> bits1.in',
        'bits1.out -> mix1.in1',
      ),
      values: {
        ...RACK_VALUES,
        'sh1.rate1': 7,
        'cv1.gain1': 0.5,
        'osc1.pitch': 600,
        'osc1.wave': 1,
        'osc1.fmAmount': 2,
        'osc1.envAmount': 1,
        'osc1.attack': 0.002,
        'osc1.decay': 0.04,
        'osc1.sustain': 0,
        'osc1.release': 0.01,
        'lpf1.cutoff': 12000,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
        'ring1.freq': 180,
        'ring1.mix': 0.8,
        'bits1.bits': 4,
        'bits1.rate': 4500,
        'bits1.mix': 1,
      },
    }),
  },
  {
    id: 'arpeggio',
    name: 'Arpeggio',
    description: 'A repeating eight-note pattern in a wide room.',
    teaches: 'The Clock and Sequencer together, and putting a sound in a space.',
    tutorial: 14,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['clock', 'seq', 'reverb']),
        'clk1.x1 -> seq1.clock',
        'seq1.cv -> osc1.fm',
        'seq1.gate -> osc1.gate',
        'vca1.out -> spc1.in',
        // The reverb is stereo, so it takes two mixer channels. The first
        // replaces vca1's own cable.
        'spc1.l -> mix1.in1',
        'spc1.r -> mix1.in2',
      ),
      values: {
        ...RACK_VALUES,
        'clk1.rate': 9,
        'clk1.width': 0.4,
        'seq1.gateLen': 0.4,
        'seq1.length': 8,
        'osc1.pitch': 330,
        'osc1.wave': 1,
        'osc1.width': 0.4,
        'osc1.fmAmount': 1,
        'osc1.envAmount': 1,
        'osc1.attack': 0.002,
        'osc1.decay': 0.09,
        'osc1.sustain': 0,
        'osc1.release': 0.04,
        'lpf1.cutoff': 9000,
        'lpf1.cvAmount': 0,
        // Space lets it through. env1 is shaped as a plain gate follower --
        // up fast, sustain at full, a short fade on the way out -- so holding
        // the key opens the VCA and letting go closes it without a click.
        'vca1.level': 0,
        'env1.attack': 0.005,
        'env1.decay': 0.01,
        'env1.sustain': 1,
        'env1.release': 0.04,
        'spc1.size': 0.6,
        'spc1.decay': 2,
        'spc1.mix': 0.35,
        'mix1.pan1': -1,
        'mix1.pan2': 1,
      },
    }),
  },
  {
    id: 'door',
    name: 'Sci-fi door',
    description: 'A metallic hiss and clank, sliding open into a large hard room.',
    teaches: 'The Wavefolder, and an envelope bending a delay as it plays.',
    tutorial: 15,
    make: () => ({
      patch: wire(
        addAll(tutorialRack(), ['fold', 'delay', 'reverb']),
        'osc1.out -> fold1.in',
        // Replaces osc1's own cable into the filter.
        'fold1.out -> lpf1.in',
        'vca1.out -> dly1.in',
        // The envelope drags the delay's read distance, which bends the pitch
        // of everything already inside it.
        'env1.out -> dly1.cv',
        'dly1.out -> spc1.in',
        'spc1.l -> mix1.in1',
        'spc1.r -> mix1.in2',
      ),
      values: {
        ...RACK_VALUES,
        'osc1.pitch': 140,
        'osc1.wave': 3,
        'fold1.fold': 7,
        'fold1.symmetry': 0.25,
        'env1.attack': 0.01,
        'env1.decay': 0.8,
        'env1.sustain': 0,
        'env1.release': 0.3,
        'lpf1.cutoff': 3000,
        'lpf1.resonance': 0.4,
        'lpf1.cvAmount': 2,
        'dly1.time': 0.012,
        'dly1.cvAmount': 1.2,
        'dly1.feedback': 0.6,
        'dly1.damping': 0.35,
        'dly1.mix': 0.5,
        'spc1.size': 0.8,
        'spc1.decay': 3,
        'spc1.mix': 0.4,
        'mix1.pan1': -1,
        'mix1.pan2': 1,
      },
    }),
  },
]

/**
 * Pair the half-width panels up, so the rack has no half-empty rows.
 *
 * The rack is two columns wide. A full panel takes a row, two half panels
 * share one, and auto-placement fills them in patch order -- so a half panel
 * with a full one after it leaves the rest of its row blank. Built in the
 * order the tutorials add modules, these racks wasted twenty-two half-rows
 * between them, and a template is something somebody looks at.
 *
 * Each half pulls the next half forward to sit beside it, which leaves every
 * full panel where it was and moves the halves as little as the pairing
 * allows. A rack with an odd number of half panels still ends one short, and
 * nothing can be done about that.
 *
 * Purely cosmetic, as every reordering here is: what a patch does is decided
 * by its cables, and the engine runs it in topological order whatever the
 * rails say.
 */
function pack({ patch, values }: Built): Built {
  const half = (m: PatchModule) => defOf(m.type).width === 'half'

  const rest = patch.modules.slice()
  const modules: PatchModule[] = []
  while (rest.length > 0) {
    const next = rest.shift()!
    modules.push(next)
    if (!half(next)) continue

    // It has half a row to itself; give it the nearest neighbour that fits.
    const beside = rest.findIndex(half)
    if (beside >= 0) modules.push(...rest.splice(beside, 1))
  }

  return { patch: { ...patch, modules }, values }
}

/**
 * The shelf as it is offered: every rack pruned down to what it can be heard
 * through, then laid out so the panels sit tidily on the rails.
 *
 * Done here rather than in each entry so that none of them can forget, and so
 * that a template is written as the tutorial builds it rather than as a list
 * of what survives.
 */
export const LIBRARY: Template[] = SHELF.map((entry) => ({
  ...entry,
  build: () => pack(prune(entry.make())),
}))

/** One template by id, for anything that stores a reference to one. */
export function templateById(id: string): Template | undefined {
  return LIBRARY.find((t) => t.id === id)
}
