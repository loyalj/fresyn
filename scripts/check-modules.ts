/**
 * An audit of the whole module catalogue, rather than of one module at a time.
 *
 * Two questions, asked of every module the rack can make:
 *
 *   1. Does it stay finite? Every parameter is driven to both ends of its
 *      range, with every input fed a steady full-scale signal and then an
 *      audio-rate one, gate open and shut. Nothing may produce NaN, an
 *      infinity, or a number far outside what its own design allows.
 *
 *   2. Does every knob reach the DSP? The modules address their parameters by
 *      integer index, and those indices have to line up with the order in
 *      `defs.ts` by hand. A knob that moves nothing means the two have
 *      drifted apart -- a silent failure no other test would notice, because
 *      the patch still compiles and still makes a sound.
 *
 * Run with: npm run check:modules
 */
import { GraphEngine } from '../src/dsp/GraphEngine'
import type { SampleBank } from '../src/dsp/samples'
import { SCOPE_CAPTURE } from '../src/dsp/modules/Scope'
import { compile } from '../src/patch/compile'
import { MODULE_DEFS, MODULE_GROUPS, MODULE_TYPES, defOf } from '../src/patch/defs'
import { formatNote, snapToNote, type ParamSpec } from '../src/patch/param'
import type { Cable, Patch, PatchModule } from '../src/patch/types'

const SR = 48000
const FRAMES = 4096

/**
 * Modules that need longer than `FRAMES` before they say anything, and how
 * long to give them.
 *
 * The granulator plays back a two-second history of its own input. Eighty-five
 * milliseconds in, wherever Position points is still the silence the buffer
 * started as, so every knob on it reads as dead -- which is a fact about this
 * check's window and not about the module. A second is long enough for the
 * buffer to hold something wherever Position lands.
 */
const LONG_RUN: Record<string, number> = { gran: SR }

/**
 * The largest magnitude each module is designed to produce, given inputs no
 * bigger than full scale.
 *
 * Held per module rather than as one loose "has it exploded" limit, because a
 * loose limit is nearly useless: the LFO quietly reached 28 here, which is
 * absurd for something whose depth knob stops at 1, and a blanket ceiling of
 * 100 waved it through. A bound a module should actually respect is what
 * turns this from a crash test into a check on the arithmetic.
 */
const CEILING: Record<string, number> = {
  // A gate is 0 or 1.
  gate: 1,
  // Full scale, plus what the band-limiting overshoots by at the corners.
  osc: 1.3,
  // Pink noise is normalised by ear rather than by peak, and runs hotter.
  noise: 2,
  // An impulse is at most full scale, and a new one replaces the last rather
  // than adding to it; Trig is a gate.
  dust: 1,
  // The fuzz cannot drop a file on a panel, so what this bounds is the
  // module's arithmetic rather than anybody's audio: with nothing loaded it
  // is silent, and with a file it only ever attenuates -- Level and the fade
  // are both at most one, and a read between two frames cannot come out
  // larger than the louder of them.
  sampler: 1,
  // The glottal pulse peaks at full scale, the breath noise is crossfaded
  // against it rather than added, Level only attenuates, and Env is 0..1.
  voice: 1.1,
  // Two octaves of keys on top of a three-octave switch, and a 0/1 gate.
  keys: 5.1,
  // Depth stops at 1, and the unipolar tap is half that plus a half -- with
  // the same allowance the oscillator gets for what the band limiting
  // overshoots at a corner. The LFO never needed it while its Rate was a knob
  // that stopped at 200 Hz; the Rate jack can drive it five octaves past that,
  // where a sample is a sixth of a cycle and the corners have room to ring.
  lfo: 1.3,
  // Zero to one, and Inv is one minus it.
  adsr: 1,
  // The held value can only be as large as what it sampled.
  sh: 1.1,
  // The walk reflects off plus and minus one, and a cosine glide between two
  // points inside them never leaves them. Uni is half that plus a half.
  drunk: 1,
  // Every output is a gate.
  clock: 1,
  // Gates and an End pulse, plus a ramp that stops at 1.
  burst: 1,
  // The CV steps stop at two octaves; everything else it puts out is 0..1.
  seq: 2.1,
  // Every lane runs between its From and To, and both stop at one.
  macro: 1,
  // It can only chase its input.
  slew: 1.1,
  // Gain 2 and offset 1 on a full-scale input is 3 a channel, so 6 summed.
  cv: 6.1,
  // Only ever a note of the scale nearest what came in, which from a 1.0
  // offset is at most a semitone past it; the trigger is 0/1.
  quant: 1.1,
  // Drive saturates before the ladder, and resonance compensation lifts it.
  ladder: 4,
  // Clean, so nothing saturates it: at full Res the lowpass is ten times up
  // at its corner, which a full-scale tone sitting there comes out at. The
  // combs saturate in their loops and stay under two.
  svf: 10.5,
  // Linear, and three bands of up to +12 dB each: with the low shelf and the
  // bell both boosting the same frequency, a full-scale tone there comes out
  // 24 dB up -- sixteen times -- which is what it was asked for.
  eq: 17,
  // Linear, and unity at each band's centre before the makeup gain: a sine
  // sitting exactly on the first formant comes out 4.5 times as loud, and
  // nothing a rack feeds it can land on two bands at full level at once.
  formant: 5,
  // Makeup gain stops at 12 dB, and with nothing over the threshold there is
  // no reduction to offset it: four times whatever went in is the worst case.
  comp: 4.2,
  // The grains are saturated, so the wet half of the output cannot pass 1.
  // The dry half is whatever arrived, which from an oscillator overshoots a
  // little at the corners of a band-limited edge.
  gran: 1.5,
  // Every curve is bounded at full scale, and Level only ever attenuates.
  // Hard clipping at maximum drive is a square, and a DC blocker fed a square
  // overshoots on every edge before it settles.
  drive: 2.2,
  // Folding is bounded by construction, plus the same DC blocker overshoot.
  fold: 1.6,
  // Two full-scale signals multiplied, and the oscillator overshoots.
  ring: 1.8,
  // It can only quantise what it was given; rounding can lift it by one step.
  crush: 1.5,
  // The loop saturates at full scale, so the wet tap cannot pass it; the
  // mixed output is a blend of that and a dry signal from the oscillator,
  // which overshoots a little at the corners of its band limiting.
  delay: 1.4,
  // Half dry and half wet at most of each, and the wet side is its input
  // plus a feedback that saturates at 0.95 -- so a little over two.
  chorus: 2.5,
  reverb: 1.4,
  // Wet only, and the loop saturates.
  res: 1.1,
  // Level 1 plus CV 1 at an amount of 2.
  vca: 3.1,
  // Eight channels at full level cannot leave the bus above full scale: the
  // mixer drives the speakers now, so it saturates rather than summing past 1.
  mixer: 1,
  // It has no output at all.
  scope: 0,
  // Nor has the recorder: it is a tap, and taps nothing at audio rate.
  rec: 0,
}

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function cable(from: string, to: string): Cable {
  const [fromModule, fromPort] = from.split('.')
  const [toModule, toPort] = to.split('.')
  return { id: `${from}->${to}`, from: { module: fromModule, port: fromPort }, to: { module: toModule, port: toPort } }
}

/**
 * A sample for whatever is under test, the way `Driver` is a signal for it.
 *
 * A module that plays audio it was given cannot be fuzzed without giving it
 * some: with nothing loaded the Sampler is correctly silent and correctly
 * reports every one of its knobs as dead. So the rig hands the module under
 * test a file, exactly as it patches something into every input, and the
 * modules that have no use for one go on ignoring it.
 *
 * A sweep rather than a tone, at a rate that is not the rack's: Start, Length,
 * Speed and Direction all have to change what comes out, and 44.1 kHz against
 * 48 exercises the ratio that keeps a file at its own pitch.
 */
const SAMPLE_ID = 'fuzz'
const SAMPLE_RATE = 44100

function fuzzSample(): SampleBank {
  const frames = 4410
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE
    data[i] = Math.sin(2 * Math.PI * t * (200 + i * 0.05)) * (1 - i / frames)
  }
  const bank: SampleBank = new Map()
  bank.set(SAMPLE_ID, { channels: [data], rate: SAMPLE_RATE, frames })
  return bank
}

const SAMPLES = fuzzSample()

/** The signals a module's inputs are fed while it is under test. */
type Driver = 'unpatched' | 'dc' | 'audio'

/**
 * Builds a rack holding the module under test, whatever drives it, and a
 * scope on each of its outputs.
 */
/**
 * Inputs the rig leaves alone.
 *
 * It drives every input at once, which is what you want for a signal: the
 * module gets something to chew on and its knobs have something to act upon.
 * A reset is not a signal, though -- it is something done to a module now and
 * then -- and holding one at 300 Hz is a patch nobody would make. A Sequencer
 * reset on every other sample never leaves step one, so all six of its later
 * step knobs read as dead and the check reports a drift that is not there.
 */
const NEVER_DRIVEN = new Set([
  'seq.reset',
  'clock.reset',
  // The same shape of problem. A patched Clock replaces the Drunk's own Rate
  // entirely -- that is what patching one means -- so driving it would call
  // Rate and Rate Amt dead when they are only overruled.
  'drunk.clock',
])

function rig(type: string, driver: Driver): Patch {
  const def = defOf(type)
  const modules: PatchModule[] = [
    { id: 'sut', type, params: {}, sample: { id: SAMPLE_ID, name: 'fuzz.wav' } },
  ]
  const cables: Cable[] = []
  const driven = def.inputs.filter((p) => !NEVER_DRIVEN.has(`${type}.${p.id}`))

  if (driver !== 'unpatched') {
    if (driver === 'dc') {
      // A steady full-scale value: the worst case for anything exponential,
      // because it never lets the signal fall back.
      modules.push({ id: 'drive', type: 'cv', params: { offset1: 1 } })
      for (const port of driven) cables.push(cable('drive.out1', `sut.${port.id}`))
    } else {
      modules.push({ id: 'drive', type: 'osc', params: { pitch: 300, wave: 3 } })
      for (const port of driven) cables.push(cable('drive.out', `sut.${port.id}`))
    }
  }

  def.outputs.forEach((port, i) => {
    modules.push({ id: `tap${i}`, type: 'scope', params: {} })
    cables.push(cable(`sut.${port.id}`, `tap${i}.in`))
  })

  // Every rack needs a mixer, or the compiler rightly complains that nothing
  // reaches the speakers. Nothing is patched to it: the scopes above are what
  // this rig measures, and a bus with nothing in it stays at zero.
  modules.push({ id: 'end', type: 'mixer', params: {} })

  return { modules, cables }
}

interface Run {
  /**
   * Every observable the module produced, one array per output. A module
   * with no outputs has none, which is the point of a scope and of the
   * recorder: neither can change what the rack sounds like.
   */
  taps: Float32Array[]
}

function run(
  patch: Patch,
  values: Record<string, number>,
  gate: boolean,
  frames = FRAMES,
): Run {
  const compiled = compile(patch)
  if (compiled.warnings.length) throw new Error(compiled.warnings.join('; '))

  const params = compiled.params.slice()
  for (const [key, value] of Object.entries(values)) {
    const index = compiled.paramIndex[key]
    if (index === undefined) throw new Error(`no such param: ${key}`)
    params[index] = value
  }

  const engine = new GraphEngine(compiled, SR, params, undefined, SAMPLES)
  engine.setGate(gate)

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const bl = new Float32Array(128)
  const br = new Float32Array(128)
  for (let i = 0; i < frames; i += 128) {
    engine.render(bl, br)
    left.set(bl, i)
    right.set(br, i)
  }

  // Scope frames hold the last SCOPE_CAPTURE samples, which FRAMES covers.
  const taps = engine.captures
    .filter((c) => c.id.startsWith('tap'))
    .map((c) => c.mod.snapshot().slice())

  return { taps }
}

function worst(buf: Float32Array) {
  let peak = 0
  let bad = 0
  for (const v of buf) {
    if (!Number.isFinite(v)) {
      bad++
      continue
    }
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  return { peak, bad }
}

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Parameter settings to sweep: both ends of every range, the defaults, and a
 * handful of seeded mixtures.
 *
 * The mixtures matter because the extremes are correlated: moving every knob
 * to its maximum together is one corner of the space, and trouble often
 * needs one knob high while another is low.
 */
function extremes(def: { params: ParamSpec[] }): [string, Record<string, number>][] {
  const at = (pick: (spec: ParamSpec) => number) => {
    const out: Record<string, number> = {}
    for (const spec of def.params) out[`sut.${spec.id}`] = pick(spec)
    return out
  }

  const cases: [string, Record<string, number>][] = [
    ['defaults', at((s) => s.default)],
    ['all at minimum', at((s) => s.min)],
    ['all at maximum', at((s) => s.max)],
  ]

  // Deterministic, so a failure here can be reproduced exactly.
  let seed = 0x9e3779b9
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  for (let i = 0; i < 6; i++) {
    cases.push([`mixture ${i + 1}`, at((s) => s.min + (s.max - s.min) * next())])
  }
  return cases
}

/**
 * Both ends of every *pair* of knobs, with everything else left at its
 * default.
 *
 * Sweeping all the knobs together is not enough, and the oscillator shows
 * why: driving it past the sample rate needs Pitch and FM Amt both at
 * maximum, but moving everything to maximum also sets Env Amt to 1 and
 * Attack to two seconds, so the envelope holds the module silent and the
 * runaway underneath it never shows. Defaults are chosen to be benign, which
 * is exactly what makes them the right background to test a pair against.
 */
function pairs(def: { params: ParamSpec[] }): [string, Record<string, number>][] {
  const free = def.params.filter((p) => !p.steps)
  const base: Record<string, number> = {}
  for (const spec of def.params) base[`sut.${spec.id}`] = spec.default

  const cases: [string, Record<string, number>][] = []
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      for (const a of ['min', 'max'] as const) {
        for (const b of ['min', 'max'] as const) {
          cases.push([
            `${free[i].id}=${a} ${free[j].id}=${b}`,
            { ...base, [`sut.${free[i].id}`]: free[i][a], [`sut.${free[j].id}`]: free[j][b] },
          ])
        }
      }
    }
  }
  return cases
}

/** Names the switch positions a failing case was found under. */
function describe(shape: Record<string, number>) {
  const parts = Object.entries(shape).map(([k, v]) => `${k.replace('sut.', '')}=${v}`)
  return parts.length ? ` (${parts.join(' ')})` : ''
}

// --- 1. nothing comes apart -------------------------------------------
console.log('\nstability under extremes')
{
  const drivers: Driver[] = ['unpatched', 'dc', 'audio']

  for (const type of MODULE_TYPES) {
    const def = defOf(type)
    const ceiling = CEILING[type]
    if (ceiling === undefined) throw new Error(`no ceiling declared for "${type}"`)
    const frames = LONG_RUN[type] ?? FRAMES
    let worstPeak = 0
    const broken: string[] = []

    for (const driver of drivers) {
      const patch = rig(type, driver)
      // The pair sweep only runs with the gate open, since the broad sweep
      // above already covers the shut case across every module.
      for (const [label, values] of [...extremes(def), ...pairs(def)]) {
        // Switch positions are crossed with the extremes rather than swept
        // along with them. Left correlated, "everything at maximum" also
        // picks the last waveform in the list, and a sine survives abuse
        // that tears a saw apart -- which is exactly how the oscillator's
        // runaway above Nyquist hid from this check to begin with.
        for (const shape of switchSettings(def.params)) {
          const settings = { ...values, ...shape }
          const where = `${driver}/${label}${describe(shape)}`
          for (const gate of [true, false]) {
            const r = run(patch, settings, gate, frames)
            for (const buf of r.taps) {
              const { peak, bad } = worst(buf)
              if (peak > worstPeak) worstPeak = peak
              if (bad > 0) broken.push(`${where}/gate ${gate}: ${bad} non-finite`)
              else if (peak > ceiling) {
                broken.push(`${where}/gate ${gate}: peak ${peak.toPrecision(3)} over ${ceiling}`)
              }
            }
          }
        }
      }
    }

    check(
      `${def.name} stays inside its range`,
      broken.length === 0,
      broken.length ? `${broken.length} case(s), first: ${broken[0]}` : `worst peak ${worstPeak.toFixed(2)} of ${ceiling}`,
    )
  }
}

// --- 2. every knob is wired to something ------------------------------
/**
 * The scope's three knobs are read by the display, not by the audio thread,
 * so they are expected to change nothing here. Every other silent knob is a
 * parameter index that has drifted out of step with `defs.ts`.
 */
const DISPLAY_ONLY = new Set(['scope.timebase', 'scope.gain', 'scope.mode'])

console.log('\nevery parameter reaches the DSP')
{
  for (const type of MODULE_TYPES) {
    const def = defOf(type)
    if (def.params.length === 0) continue

    const dead: string[] = []
    const frames = LONG_RUN[type] ?? FRAMES

    for (const spec of def.params) {
      if (DISPLAY_ONLY.has(`${type}.${spec.id}`)) continue

      let moved = false

      // A parameter can be inert in one context and decisive in another --
      // pulse width does nothing to a sine -- so a knob only counts as dead
      // if nothing it was tried against responded to it.
      for (const driver of ['dc', 'audio'] as Driver[]) {
        if (moved) break
        const patch = rig(type, driver)

        // Try each setting of the module's switches, since those choose which
        // of the other knobs are in play at all.
        for (const shape of switchSettings(def.params)) {
          if (moved) break
          for (const rest of companions(def)) {
            if (moved) break
            for (const gate of [true, false]) {
              // The switch settings win: `rest` turns one knob at a time and
              // has no business overruling which waveform is selected.
              const base: Record<string, number> = { ...rest, ...shape }
              // Every position of a switch, not just its ends. Two positions
              // of one switch can legitimately sound the same while a third
              // does not -- the Trigger's Mode is held, once and latch, and
              // latch is the main thread's business, so down here it is held
              // exactly. Comparing only min against max would call that knob
              // dead and hide the drift this check exists to find.
              const settings = spec.steps
                ? Array.from({ length: spec.max - spec.min + 1 }, (_, i) => spec.min + i)
                : [spec.min, spec.max]

              const first = run(patch, { ...base, [`sut.${spec.id}`]: settings[0] }, gate, frames).taps
              for (const value of settings.slice(1)) {
                const other = run(patch, { ...base, [`sut.${spec.id}`]: value }, gate, frames).taps
                if (first.some((buf, i) => !same(buf, other[i]))) {
                  moved = true
                  break
                }
              }
              if (moved) break
            }
          }
        }
      }

      if (!moved) dead.push(spec.id)
    }

    check(
      `${def.name}: every knob changes something`,
      dead.length === 0,
      dead.length ? `silent: ${dead.join(', ')}` : `${def.params.length} checked`,
    )
  }
}

/**
 * How many switch combinations are worth enumerating before falling back to
 * moving one at a time.
 *
 * Nothing in the catalogue comes near this today -- the widest is four
 * positions on one switch. It is here because the product is what it is: two
 * more switches on a module that already has a couple turns this check from
 * seconds into minutes, and the person who adds them should get a slower
 * check rather than a hung one.
 */
const COMBO_LIMIT = 48

/** Each combination of the module's switch positions, capped to stay quick. */
/**
 * What the rest of the panel is doing while one knob is being tried.
 *
 * Defaults first, since that is the rack a reader has in front of them. But a
 * knob can be gated by another knob rather than by a switch -- FM Mode does
 * nothing whatsoever while FM Amt sits at zero, which is where it starts --
 * so the rest of the list turns one other knob to each of its ends and leaves
 * everything else alone.
 *
 * One at a time, rather than the whole panel at once. All at once is its own
 * trap, and this check walked straight into it: with every oscillator knob at
 * maximum both FM modes ask for a frequency past Nyquist and get the same
 * clamped one, and with every knob at minimum the Level knob is shut and the
 * module is silent. Either way FM Mode reads as dead when it is not.
 */
function companions(def: { params: ParamSpec[] }): Record<string, number>[] {
  const base: Record<string, number> = {}
  for (const spec of def.params) base[`sut.${spec.id}`] = spec.default

  const all = [base]
  for (const spec of def.params) {
    all.push({ ...base, [`sut.${spec.id}`]: spec.max })
    all.push({ ...base, [`sut.${spec.id}`]: spec.min })
  }
  return all
}

function switchSettings(params: ParamSpec[]): Record<string, number>[] {
  const switches = params.filter((p) => p.steps)
  if (switches.length === 0) return [{}]

  const total = switches.reduce((n, spec) => n * (spec.max - spec.min + 1), 1)

  if (total > COMBO_LIMIT) {
    // Every position of every switch, but one switch at a time against the
    // rest at their defaults. That still visits each setting -- which is what
    // catches a parameter index that has drifted -- without the product.
    const base: Record<string, number> = {}
    for (const spec of switches) base[`sut.${spec.id}`] = spec.default

    const sampled = [base]
    for (const spec of switches) {
      for (let v = spec.min; v <= spec.max; v++) {
        if (v !== spec.default) sampled.push({ ...base, [`sut.${spec.id}`]: v })
      }
    }
    return sampled
  }

  let combos: Record<string, number>[] = [{}]
  for (const spec of switches) {
    const next: Record<string, number>[] = []
    for (const combo of combos) {
      for (let v = spec.min; v <= spec.max; v++) {
        next.push({ ...combo, [`sut.${spec.id}`]: v })
      }
    }
    combos = next
  }
  return combos
}

// --- 3. turning a knob does not click ---------------------------------
/**
 * Knobs that scale a signal rather than describe one, with the setting that
 * makes their effect audible and the value that silences the module.
 *
 * These are the ones where a raw jump is heard as a click, because the
 * output is multiplied by them directly. The rack already smooths its
 * levels and cutoffs for exactly this reason; these had been missed.
 */
interface GainKnob {
  type: string
  knob: string
  /** Sources need nothing patched; the VCA needs both a signal and a CV. */
  driver: Driver
  gate: boolean
  others: Record<string, number>
  loud: number
  silent: number
}

const GAIN_KNOBS: GainKnob[] = [
  { type: 'noise', knob: 'level', driver: 'unpatched', gate: false, others: {}, loud: 1, silent: 0 },
  {
    type: 'lfo',
    knob: 'depth',
    driver: 'unpatched',
    gate: false,
    others: { shape: 3, rate: 100 },
    loud: 1,
    silent: 0,
  },
  {
    type: 'vca',
    knob: 'cvAmount',
    driver: 'dc',
    gate: false,
    others: { level: 0 },
    loud: 2,
    silent: 0,
  },
  {
    // Unpatched and ungated on purpose: the steady driver would hold this
    // module's own Gate jack open, and a decaying envelope underneath would
    // be mistaken for the knob gliding.
    type: 'osc',
    knob: 'envAmount',
    driver: 'unpatched',
    gate: false,
    others: { pitch: 300, wave: 3 },
    loud: 0,
    silent: 1,
  },
  // A drone, so the voice is sounding with nothing patched or held.
  { type: 'voice', knob: 'level', driver: 'unpatched', gate: false, others: { mode: 0 }, loud: 1, silent: 0 },
]

console.log('\nturning a gain knob glides instead of jumping')
{
  for (const { type, knob, driver, gate, others, loud, silent } of GAIN_KNOBS) {
    const patch = rig(type, driver)
    const compiled = compile(patch)
    const params = compiled.params.slice()
    for (const [id, v] of Object.entries(others)) params[compiled.paramIndex[`sut.${id}`]] = v
    const index = compiled.paramIndex[`sut.${knob}`]
    params[index] = loud

    const engine = new GraphEngine(compiled, SR, params)
    engine.setGate(gate)

    const bl = new Float32Array(128)
    const br = new Float32Array(128)
    const tap = engine.captures.find((c) => c.id === 'tap0')!

    // Every reading comes off the scope on the module's own output. The
    // engine's stereo pair is silent here -- nothing in the rig is patched to
    // the output module -- so measuring that instead reports zero throughout
    // and every one of these checks passes or fails for the wrong reason.
    const lastBlock = () => rms(tap.mod.snapshot().subarray(SCOPE_CAPTURE - 128))

    for (let i = 0; i < 4096; i += 128) engine.render(bl, br)
    const before = lastBlock()

    // Turn the knob all the way down, the way a drag's last frame would.
    engine.setParam(index, silent)
    engine.render(bl, br)
    const justAfter = lastBlock()

    // And let the smoother finish.
    for (let i = 0; i < 4096; i += 128) engine.render(bl, br)
    const settled = lastBlock()

    check(
      `${defOf(type).name} ${knob}: settles to silence`,
      settled < before * 0.02,
      `${before.toFixed(3)} -> ${settled.toFixed(4)}`,
    )
    // One 128-sample block is 2.7 ms, well inside the 8 ms glide, so a
    // smoothed knob is still most of the way up here. An unsmoothed one has
    // already arrived, and that step is the click.
    check(
      `${defOf(type).name} ${knob}: does not arrive instantly`,
      justAfter > before * 0.25,
      `${(justAfter / before).toFixed(3)} of the way through the first block`,
    )
  }
}

function rms(buf: Float32Array) {
  let sum = 0
  for (const v of buf) sum += v * v
  return Math.sqrt(sum / buf.length)
}

// --- 4. the catalogue agrees with itself ------------------------------
console.log('\ncatalogue')
{
  const slugs = new Map<string, string>()
  const problems: string[] = []

  for (const [key, def] of Object.entries(MODULE_DEFS)) {
    if (def.type !== key) problems.push(`${key}: type says "${def.type}"`)

    // One namespace, not two. A jack is addressed as `moduleId.portId`
    // everywhere outside the compiler -- jack registration, cable geometry,
    // occupancy, drag targeting, cable ids -- and none of those carry which
    // side it is on. So an input and an output sharing an id are two jacks at
    // one address, and the patching UI cannot tell them apart. The Keyboard
    // ran into this: its gate input is `trig` although the panel says Gate,
    // because its gate output had the name first.
    const seen = new Set<string>()
    for (const p of [...def.inputs, ...def.outputs]) {
      if (seen.has(p.id)) problems.push(`${key}: port id "${p.id}" is used twice`)
      seen.add(p.id)
    }

    // The back panel gathers a block by name across both sides, so a def
    // whose blocks interleave -- in1, out1, in2, out2 under two headings --
    // still draws two tidy boxes, and the list it was read from is the only
    // place the mess shows. Keeping each block to one run means the def reads
    // in the order the panel lays it out.
    for (const side of [def.inputs, def.outputs]) {
      const started = new Set<string | undefined>()
      let run: string | undefined | null = null
      for (const p of side) {
        if (p.block !== undefined && p.block.trim() === '') {
          problems.push(`${key}.${p.id}: empty block name`)
        }
        if (p.block === run) continue
        if (started.has(p.block)) problems.push(`${key}: block "${p.block}" is split up`)
        started.add(p.block)
        run = p.block
      }
    }

    const ids = new Set<string>()
    for (const spec of def.params) {
      if (ids.has(spec.id)) problems.push(`${key}: duplicate param "${spec.id}"`)
      ids.add(spec.id)
      if (!(spec.min < spec.max)) problems.push(`${key}.${spec.id}: min is not below max`)
      if (spec.default < spec.min || spec.default > spec.max) {
        problems.push(`${key}.${spec.id}: default outside its range`)
      }
      // An exponential curve is a ratio, so it cannot reach or cross zero.
      if (spec.curve === 'exp' && !spec.steps && spec.min <= 0) {
        problems.push(`${key}.${spec.id}: exponential range starts at ${spec.min}`)
      }
      if (spec.steps && spec.steps.length !== spec.max - spec.min + 1) {
        problems.push(`${key}.${spec.id}: ${spec.steps.length} labels for ${spec.max - spec.min + 1} positions`)
      }
    }

    // Two places list the catalogue -- the Modules menu and the panel under
    // the rack -- and both read this. A module with a group neither of them
    // knows would simply not appear, in silence.
    if (!MODULE_GROUPS.some((g) => g.id === def.group)) {
      problems.push(`${key}: group "${def.group}" is not one the menus list`)
    }

    const clash = slugs.get(def.slug)
    if (clash) problems.push(`${key}: shares the slug "${def.slug}" with ${clash}`)
    slugs.set(def.slug, key)
  }

  check('every definition is well formed', problems.length === 0, problems.join(' | '))

  // A knob that names its note has to be a frequency, and an exponential one:
  // the note readout reads hertz, and Alt-dragging onto a semitone is a knob
  // whose travel is already in octaves. Marking a linear or a non-frequency
  // parameter would be a readout quietly talking nonsense.
  const mistuned = Object.entries(MODULE_DEFS).flatMap(([key, def]) =>
    def.params
      .filter((p) => p.tuned && (p.unit !== 'Hz' || p.curve !== 'exp' || p.steps))
      .map((p) => `${key}.${p.id}`),
  )
  check('every tuned parameter is an exponential frequency', mistuned.length === 0, mistuned.join(', '))

  // The note arithmetic itself, against numbers anyone can check: A4 is the
  // tuning fork, A2 is the oscillator's own default, and C0 is where naming
  // notes stops being useful and starts being "C#-3".
  const named = (hz: number) => formatNote(hz)
  const notes: [number, string][] = [
    [440, 'A4'],
    [110, 'A2'],
    [220, 'A3'],
    [261.6256, 'C4'],
    [16.35, 'C0'],
    [12000, 'F#9 +23¢'],
    // Off a note, which is the case the cents exist for: near enough to read
    // as an A and not one.
    [440 * Math.pow(2, 0.4 / 12), 'A4 +40¢'],
    [440 * Math.pow(2, -0.13 / 12), 'A4 -13¢'],
    // Exactly half way is a coin toss, and it is called for the note above:
    // worth pinning down so that it stays one answer rather than two.
    [440 * Math.pow(2, 0.5 / 12), 'A#4 -50¢'],
    // Below C0 there is no note to give, and a readout saying so is better
    // than one inventing an octave nobody counts in.
    [8, ''],
    [2, ''],
  ]
  const wrong = notes.filter(([hz, want]) => named(hz) !== want).map(([hz, want]) => `${hz} read as "${named(hz)}", not "${want}"`)
  check('a frequency names its note', wrong.length === 0, wrong.join('; '))

  // And back again, so the knob can be snapped to one.
  const osc = defOf('osc').params.find((p) => p.id === 'pitch')!
  check(
    'and snapping lands exactly on it',
    snapToNote(osc, 452) === 440 && Math.abs(snapToNote(osc, 218) - 220) < 1e-9,
    `452 -> ${snapToNote(osc, 452)}, 218 -> ${snapToNote(osc, 218)}`,
  )
  // The ends of the knob are not notes, and a snap may not leave the range.
  check(
    'without leaving the knob',
    snapToNote(osc, osc.min) >= osc.min && snapToNote(osc, osc.max) <= osc.max,
    `${snapToNote(osc, osc.min)} .. ${snapToNote(osc, osc.max)}`,
  )
  check(
    'every module is in exactly one group',
    MODULE_GROUPS.reduce((n, g) => n + Object.values(MODULE_DEFS).filter((d) => d.group === g.id).length, 0) ===
      MODULE_TYPES.length,
    MODULE_GROUPS.map((g) => `${g.name} ${Object.values(MODULE_DEFS).filter((d) => d.group === g.id).length}`).join(', '),
  )
  check(
    'every type has a DSP implementation',
    MODULE_TYPES.every((t) => {
      try {
        run(rig(t, 'unpatched'), {}, true)
        return true
      } catch {
        return false
      }
    }),
  )
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
