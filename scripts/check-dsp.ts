/**
 * Headless checks for the patch compiler and graph engine.
 *
 * Covers the things that are easy to get quietly wrong: execution order,
 * feedback cables, the mixer's pan law, and numerical stability under the
 * settings that have broken the filter before.
 *
 * Run with: npm run check:dsp
 */
import { integratedLoudness } from '../src/dsp/Loudness'
import { normalize } from '../src/audio/normalize'
import { GraphEngine } from '../src/dsp/GraphEngine'
import { LadderFilter, ladderResponse } from '../src/dsp/LadderFilter'
import type { SampleBank } from '../src/dsp/samples'
import { SCOPE_CAPTURE } from '../src/dsp/modules/Scope'
import { svfResponse } from '../src/dsp/modules/Svf'
import { compile } from '../src/patch/compile'
import { fft } from '../src/ui/fft'
import { defaultPatch, triggerPatch } from '../src/patch/defaultPatch'
import { noteTarget } from '../src/song/bind'
import type { Cable, Patch, PatchModule } from '../src/patch/types'

const SR = 48000

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function cable(fromModule: string, fromPort: string, toModule: string, toPort: string): Cable {
  return {
    id: `${fromModule}.${fromPort}->${toModule}.${toPort}`,
    from: { module: fromModule, port: fromPort },
    to: { module: toModule, port: toPort },
  }
}

interface RenderOpts {
  frames?: number
  gate?: boolean
  params?: Record<string, number>
  /**
   * Where to listen. The recorder is the clean probe -- it is a tap and
   * nothing else, so a signal patched to it arrives untouched -- which is
   * why it is the default here. `speakers` is the other thing worth
   * testing: the sum of every main mix, which is what the room hears.
   */
  tap?: 'speakers' | 'recorder'
  /**
   * Gates set on named modules after the rack-wide one, so a test can open
   * one module and leave another shut. That is the only way to prove a gate
   * arrived down a cable rather than through the transport, now that a module
   * with a trigger of its own can be fired either way.
   */
  gates?: Record<string, boolean>
  /** Audio for any Sampler in the patch, keyed the way the patch asks for it. */
  samples?: SampleBank
}

function render(patch: Patch, opts: RenderOpts = {}) {
  const frames = opts.frames ?? SR
  const compiled = compile(patch)

  // Seed through the constructor, the same path a patch load takes, so the
  // render starts at these values instead of gliding to them.
  const initial = compiled.params.slice()
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    const index = compiled.paramIndex[key]
    if (index === undefined) throw new Error(`no such param: ${key}`)
    initial[index] = value
  }

  const engine = new GraphEngine(compiled, SR, initial, undefined, opts.samples)
  engine.setTap(opts.tap ?? 'recorder')
  engine.setGate(opts.gate ?? true)
  for (const [id, open] of Object.entries(opts.gates ?? {})) engine.setModuleGate(id, open)

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const bl = new Float32Array(128)
  const br = new Float32Array(128)
  for (let i = 0; i < frames; i += 128) {
    engine.render(bl, br)
    // The last block may hang off the end when frames is not a multiple of 128.
    const n = Math.min(128, frames - i)
    left.set(bl.subarray(0, n), i)
    right.set(br.subarray(0, n), i)
  }
  return { left, right, compiled }
}

function stats(buf: Float32Array) {
  let peak = 0
  let sumSq = 0
  let dc = 0
  let nan = 0
  for (const s of buf) {
    if (!Number.isFinite(s)) {
      nan++
      continue
    }
    const a = Math.abs(s)
    if (a > peak) peak = a
    sumSq += s * s
    dc += s
  }
  return { peak, rms: Math.sqrt(sumSq / buf.length), dc: dc / buf.length, nan }
}

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Runs a patch and returns what each scope in it captured, keyed by module id.
 *
 * The scope doubles as the test probe. Control voltages cannot be measured at
 * the output -- it blocks DC and saturates -- and reaching into the engine for
 * a raw slot would test something the rack cannot actually do.
 */
function capture(patch: Patch, opts: RenderOpts = {}): Record<string, Float32Array> {
  const compiled = compile(patch)

  const initial = compiled.params.slice()
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    const index = compiled.paramIndex[key]
    if (index === undefined) throw new Error(`no such param: ${key}`)
    initial[index] = value
  }

  const engine = new GraphEngine(compiled, SR, initial, undefined, opts.samples)
  engine.setGate(opts.gate ?? true)
  for (const [id, open] of Object.entries(opts.gates ?? {})) engine.setModuleGate(id, open)

  // A frame holds the last SCOPE_CAPTURE samples, so rendering fewer than
  // that would leave the front of it as the zeros it started from.
  const frames = Math.max(opts.frames ?? SCOPE_CAPTURE, SCOPE_CAPTURE)
  const bl = new Float32Array(128)
  const br = new Float32Array(128)
  for (let i = 0; i < frames; i += 128) engine.render(bl, br)

  const out: Record<string, Float32Array> = {}
  // Copied, because a module hands back the one buffer it reuses every frame.
  for (const c of engine.captures) {
    out[c.id] = c.mod.snapshot().slice()
    const b = c.mod.snapshotB?.()
    if (b) out[`${c.id}.b`] = b.slice()
  }
  return out
}

function sane(name: string, buf: Float32Array) {
  const s = stats(buf)
  const problems: string[] = []
  if (s.nan > 0) problems.push(`${s.nan} NaN`)
  if (s.peak < 0.01) problems.push('silent')
  if (s.peak > 1.0001) problems.push('clipping')
  if (Math.abs(s.dc) > 0.01) problems.push(`DC ${s.dc.toFixed(4)}`)

  const detail =
    `peak=${s.peak.toFixed(4)} rms=${s.rms.toFixed(4)}` +
    (problems.length ? '  <- ' + problems.join(', ') : '')
  check(name, problems.length === 0, detail)
  return s
}

// --- the voice, now expressed as the default patch -------------------
console.log('\ndefault patch')

const VOICE_CASES: [string, Record<string, number>][] = [
  ['saw', {}],
  ['pulse narrow', { 'osc1.wave': 1, 'osc1.width': 0.08 }],
  ['tri', { 'osc1.wave': 2 }],
  ['sine', { 'osc1.wave': 3 }],
  ['self-osc', { 'lpf1.resonance': 1, 'lpf1.cutoff': 300, 'lpf1.cvAmount': 0 }],
  ['max drive + res', { 'lpf1.resonance': 0.98, 'lpf1.drive': 12, 'osc1.sustain': 1 }],
  ['high pitch', { 'osc1.pitch': 3900, 'osc1.sustain': 1 }],
]

for (const [name, params] of VOICE_CASES) {
  sane(name, render(triggerPatch(), { params }).left)
}

// --- compiler --------------------------------------------------------
console.log('\ncompiler')
{
  const c = compile(triggerPatch())
  const order = c.modules.map((m) => m.id)
  const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b)

  check('no warnings on the default patch', c.warnings.length === 0, c.warnings.join('; '))
  check('producers run before consumers', before('osc1', 'lpf1') && before('lpf1', 'mix1'))
  check('the console runs last', order[order.length - 1] === 'mix1', order.join(' -> '))
  check('no feedback cables in an acyclic patch', c.feedbackCables.length === 0)
  check('every module is scheduled', order.length === triggerPatch().modules.length)
  // Five modules, and the rack makes a sound you can play: that is the claim
  // the starting rack is making, so it is worth stating as a check. The fifth
  // is the Trigger, which is what the keyboard reaches.
  check('the stock rack is five modules', triggerPatch().modules.length === 5)
  check('one of them is a main mix', c.monitors.length === 1)
}

{
  // The rack New project hands out is the one a piano roll plays in tune:
  // notes land on the Keyboard, and its Pitch drives the oscillator an octave
  // per octave. No Trigger: the keys and the roll are how it is played.
  const p = defaultPatch()
  const c = compile(p)
  const wired = (from: string, to: string) =>
    p.cables.some((k) => `${k.from.module}.${k.from.port}` === from && `${k.to.module}.${k.to.port}` === to)
  check('no warnings on the starting rack', c.warnings.length === 0, c.warnings.join('; '))
  check('the roll plays it as notes', noteTarget(p)?.kind === 'note', JSON.stringify(noteTarget(p)))
  check(
    'in tune: pitch into FM at +1.00',
    wired('key1.pitch', 'osc1.fm') && p.modules.find((m) => m.id === 'osc1')?.params.fmAmount === 1,
  )
  check('velocity sets the level', wired('key1.vel', 'vca1.cv'))
  check('it carries no Trigger', !p.modules.some((m) => m.type === 'gate'))
  check('one main mix', c.monitors.length === 1)
}

{
  // An input with two cables keeps the last, as a hardware jack would.
  const p = triggerPatch()
  p.cables.push(cable('lfo1', 'out', 'lpf1', 'in'))
  const c = compile(p)
  check(
    'duplicate cable into one input is reported',
    c.warnings.some((w) => w.includes('more than one cable')),
  )
}

{
  const p = triggerPatch()
  p.cables.push(cable('osc1', 'out', 'lpf1', 'nosuchport'))
  const c = compile(p)
  check(
    'cable to an unknown port is rejected',
    c.warnings.some((w) => w.includes('no input')),
  )
}

// --- feedback --------------------------------------------------------
console.log('\nfeedback')
{
  // Patch the filter back into the oscillator's FM input: a genuine cycle.
  const p = triggerPatch()
  p.cables.push(cable('lpf1', 'out', 'osc1', 'fm'))
  const c = compile(p)

  check('cycle is detected as a feedback cable', c.feedbackCables.length === 1, c.feedbackCables.join())
  check('cycle does not drop any module', c.modules.length === p.modules.length)

  const out = render(p, { params: { 'osc1.fmAmount': 1.5, 'osc1.sustain': 1 } })
  sane('feedback patch stays stable', out.left)
}

// --- what reaches the speakers ---------------------------------------
/**
 * A bus is a main mix unless it feeds something that can carry the signal
 * on. These are the four cases that rule has to get right: the smallest rack
 * that works, a rack with nothing to sum through, a sub-mix, and a mixer
 * feeding a tap.
 */
console.log('\nthe speaker bus')
{
  // The smallest rack that makes a sound, and the one the manual opens with.
  const basic: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: 220, wave: 3 } },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'mix1', 'in1')],
  }
  const c = compile(basic)
  check('an oscillator and a mixer is a whole rack', c.warnings.length === 0, c.warnings.join('; '))
  const heard = stats(render(basic, { frames: SR / 4, tap: 'speakers' }).left)
  check('and the speakers hear it', heard.peak > 0.1, `peak=${heard.peak.toFixed(3)}`)

  // Nothing patched to the recorder: it records what the room hears.
  const recorded = stats(render(basic, { frames: SR / 4 }).left)
  check(
    'an unpatched recorder renders the speakers',
    Math.abs(recorded.rms - heard.rms) < 1e-9,
    `${recorded.rms.toFixed(6)} vs ${heard.rms.toFixed(6)}`,
  )

  // A rack with nothing to sum through is silent, and says so rather than
  // leaving the reader to wonder.
  const bare: Patch = { modules: [{ id: 'osc1', type: 'osc', params: {} }], cables: [] }
  const bareC = compile(bare)
  check(
    'a rack with no mixer warns',
    bareC.warnings.some((w) => w.includes('speakers')),
    bareC.warnings.join('; ') || 'no warnings',
  )
  check('and is silent', stats(render(bare, { frames: 4096, tap: 'speakers' }).left).peak === 0)

  // A sub-mix is heard through the mixer it feeds, not twice.
  const sub: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: 220, wave: 3 } },
      { id: 'sub1', type: 'mixer', params: {} },
      { id: 'main1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'sub1', 'in1'), cable('sub1', 'l', 'main1', 'in1')],
  }
  check('a mixer patched into another is not a main mix', compile(sub).monitors.length === 1)

  // A recorder has no outputs, so it cannot carry a signal onward: patching a
  // mixer into one leaves the mixer exactly as audible as it was.
  const tapped: Patch = {
    modules: [...basic.modules, { id: 'rec1', type: 'rec', params: {} }],
    cables: [...basic.cables, cable('mix1', 'l', 'rec1', 'l'), cable('mix1', 'r', 'rec1', 'r')],
  }
  check('a mixer patched into a recorder still is', compile(tapped).monitors.length === 1)
  const tappedHeard = stats(render(tapped, { frames: SR / 4, tap: 'speakers' }).left)
  check('and is still heard', tappedHeard.peak > 0.1, `peak=${tappedHeard.peak.toFixed(3)}`)
}

// --- mixer -----------------------------------------------------------
console.log('\nmixer 8:2')
{
  const p: Patch = {
    modules: [
      { id: 'a', type: 'osc', params: { pitch: 220, wave: 3 } },
      { id: 'b', type: 'osc', params: { pitch: 330, wave: 3 } },
      { id: 'mix1', type: 'mixer', params: {} },
      { id: 'rec1', type: 'rec', params: {} },
    ],
    cables: [
      cable('a', 'out', 'mix1', 'in1'),
      cable('b', 'out', 'mix1', 'in2'),
      cable('mix1', 'l', 'rec1', 'l'),
      cable('mix1', 'r', 'rec1', 'r'),
    ],
  }

  const hard = render(p, { frames: SR / 2, params: { 'mix1.pan1': -1, 'mix1.pan2': 1 } })
  const hardL = stats(hard.left)
  const hardR = stats(hard.right)
  check(
    'hard-panned channels both reach the bus',
    hardL.peak > 0.1 && hardR.peak > 0.1,
    `L=${hardL.peak.toFixed(3)} R=${hardR.peak.toFixed(3)}`,
  )

  // Channel 1 alone, hard left: the right bus must be silent.
  const solo = render(p, { frames: SR / 4, params: { 'mix1.pan1': -1, 'mix1.level2': 0 } })
  const soloR = stats(solo.right)
  check('hard left leaves the right bus silent', soloR.peak < 1e-4, `R peak=${soloR.peak.toExponential(2)}`)

  // Constant power: centred, each side sits at 1/sqrt(2) of hard-panned.
  // Measured quietly on purpose -- the tanh on the mixer's bus is deliberate,
  // and at normal levels it compresses the louder hard-panned render more than
  // the centred one, which would show up here as a pan law that is not quite
  // right.
  const QUIET = { 'mix1.master': 0.2, 'mix1.level2': 0 }
  const soloQuiet = render(p, { frames: SR / 4, params: { ...QUIET, 'mix1.pan1': -1 } })
  const centre = render(p, { frames: SR / 4, params: { ...QUIET, 'mix1.pan1': 0 } })
  const ratio = stats(centre.left).rms / stats(soloQuiet.left).rms
  check(
    'pan law is constant power',
    Math.abs(ratio - Math.SQRT1_2) < 0.02,
    `ratio=${ratio.toFixed(4)} expected=${Math.SQRT1_2.toFixed(4)}`,
  )

  // Unpatched channels contribute nothing regardless of their level knobs.
  const quiet = render(p, {
    frames: 4096,
    params: { 'mix1.level1': 0, 'mix1.level2': 0, 'mix1.level7': 1, 'mix1.level8': 1 },
  })
  check('unpatched channels stay silent', stats(quiet.left).peak < 1e-4)
}

// --- the oscillator's own envelope -------------------------------------
console.log('\noscillator envelope')
{
  const solo: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: 220, wave: 3 } },
      { id: 'rec1', type: 'rec', params: {} },
    ],
    cables: [cable('osc1', 'out', 'rec1', 'l')],
  }

  // Env Amt at zero has to leave the oscillator exactly as it was, gate or no
  // gate: every patch saved before the envelope existed depends on it.
  const idle = render(solo, { frames: SR / 4, gate: false })
  const gated = render(solo, { frames: SR / 4, gate: true })
  check('at zero amount it runs free', stats(idle.left).peak > 0.1, `peak=${stats(idle.left).peak.toFixed(3)}`)
  check('at zero amount the trigger does nothing', same(idle.left, gated.left))

  const shut = render(solo, { frames: SR / 4, gate: false, params: { 'osc1.envAmount': 1 } })
  const open = render(solo, { frames: SR / 4, gate: true, params: { 'osc1.envAmount': 1 } })
  check('at full amount an untriggered oscillator is silent', stats(shut.left).peak < 1e-4)
  check('at full amount a triggered one sounds', stats(open.left).peak > 0.1, `peak=${stats(open.left).peak.toFixed(3)}`)

  // The Env jack, proved by using it somewhere else: the output stage blocks
  // DC, so an envelope cannot be measured by listening to it directly.
  const routed: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: {} },
      { id: 'osc2', type: 'osc', params: { pitch: 330, wave: 3 } },
      { id: 'vca1', type: 'vca', params: { level: 0, cvAmount: 1 } },
      { id: 'rec1', type: 'rec', params: {} },
    ],
    cables: [
      cable('osc2', 'out', 'vca1', 'in'),
      cable('osc1', 'env', 'vca1', 'cv'),
      cable('vca1', 'out', 'rec1', 'l'),
    ],
  }
  const envShut = render(routed, { frames: SR / 4, gate: false })
  const envOpen = render(routed, { frames: SR / 4, gate: true })
  check('the Env jack is silent until triggered', stats(envShut.left).peak < 1e-4)
  check('the Env jack drives another module', stats(envOpen.left).peak > 0.1, `peak=${stats(envOpen.left).peak.toFixed(3)}`)

  // A cable into the Gate jack fires it just as the panel button does.
  const byCable: Patch = {
    modules: [
      { id: 'gate1', type: 'gate', params: {} },
      { id: 'osc1', type: 'osc', params: { envAmount: 1 } },
      { id: 'rec1', type: 'rec', params: {} },
    ],
    cables: [cable('gate1', 'gate', 'osc1', 'gate'), cable('osc1', 'out', 'rec1', 'l')],
  }
  check('a cable into Gate triggers it', stats(render(byCable, { frames: SR / 4 }).left).peak > 0.1)

  // Delay holds the envelope shut before the attack begins.
  const delayed = render(solo, {
    frames: SR / 2,
    params: { 'osc1.envAmount': 1, 'osc1.delay': 0.1, 'osc1.sustain': 1 },
  })
  const early = stats(delayed.left.subarray(0, Math.round(SR * 0.08)))
  const later = stats(delayed.left.subarray(Math.round(SR * 0.15), Math.round(SR * 0.25)))
  check('delay keeps it shut at first', early.peak < 1e-4, `peak=${early.peak.toExponential(2)}`)
  check('and it opens afterwards', later.peak > 0.1, `peak=${later.peak.toFixed(3)}`)

  // Hold keeps it at full level before the decay starts.
  const common = { 'osc1.envAmount': 1, 'osc1.attack': 0.001, 'osc1.decay': 0.01, 'osc1.sustain': 0 }
  const held = render(solo, { frames: SR / 2, params: { ...common, 'osc1.hold': 0.2 } })
  const unheld = render(solo, { frames: SR / 2, params: common })
  const window = (b: Float32Array) => stats(b.subarray(Math.round(SR * 0.1), Math.round(SR * 0.15)))
  check('hold sustains the peak', window(held.left).peak > 0.1, `peak=${window(held.left).peak.toFixed(3)}`)
  check('without hold it has already decayed', window(unheld.left).peak < 1e-3)
}

// --- CV utilities ----------------------------------------------------
// Control voltages are read through a scope rather than through the output
// stage. The output blocks DC and saturates, which is right for audio and
// useless here: a steady offset would come back as silence.
console.log('\nCV utility')
{
  const held = capture({
    modules: [
      { id: 'cv1', type: 'cv', params: { offset1: 0.5, offset2: 0.25 } },
      { id: 'scope1', type: 'scope', params: {} },
      { id: 'scope2', type: 'scope', params: {} },
    ],
    cables: [cable('cv1', 'out1', 'scope1', 'in'), cable('cv1', 'sum', 'scope2', 'in')],
  })

  // Nothing patched, so the input reads ground and the offset alone comes out.
  const flat = held.scope1.every((v) => Math.abs(v - 0.5) < 1e-6)
  check('an unpatched channel puts out its offset', flat, `first=${held.scope1[0].toFixed(4)}`)
  check(
    'the sum adds both channels',
    Math.abs(held.scope2[4000] - 0.75) < 1e-6,
    held.scope2[4000].toFixed(4),
  )

  const through = (gain: number) =>
    capture({
      modules: [
        { id: 'lfo1', type: 'lfo', params: { rate: 20, shape: 3, depth: 1 } },
        { id: 'cv1', type: 'cv', params: { gain1: gain, offset1: 0 } },
        { id: 'scope1', type: 'scope', params: {} },
      ],
      cables: [cable('lfo1', 'out', 'cv1', 'in1'), cable('cv1', 'out1', 'scope1', 'in')],
    }).scope1

  const plus = through(1)
  const minus = through(-1)
  let inverted = true
  for (let i = 0; i < plus.length; i++) {
    if (Math.abs(plus[i] + minus[i]) > 1e-6) inverted = false
  }
  check('a negative gain inverts the signal', inverted)
  // The reason the module exists: nothing else in the rack could do that.
  check('and it is not simply silent', stats(plus).peak > 0.5, `peak=${stats(plus).peak.toFixed(3)}`)
}

// --- oscillator width -------------------------------------------------
console.log('\noscillator width')
{
  const solo = (wave: number, width: number) =>
    render(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: { pitch: 220, wave } },
          { id: 'rec1', type: 'rec', params: {} },
        ],
        cables: [cable('osc1', 'out', 'rec1', 'l')],
      },
      { frames: 8192, params: { 'osc1.width': width } },
    ).left

  // Width reaches the triangle as well as the pulse: the core puts the
  // triangle's peak at the width, so the two share the control. The manual
  // claimed this was pulse-only, which was wrong.
  check('width changes a pulse', !same(solo(1, 0.5), solo(1, 0.2)))
  check('width changes a triangle too', !same(solo(2, 0.5), solo(2, 0.2)))
  // The two shapes that have no width to speak of must ignore it entirely,
  // or turning the knob on a saw patch would be an audible surprise.
  check('but not a saw', same(solo(0, 0.5), solo(0, 0.2)))
  check('and not a sine', same(solo(3, 0.5), solo(3, 0.2)))
}

/**
 * The share of a signal's energy that does not sit on a multiple of `bin`.
 *
 * A window holding a whole number of cycles of something periodic puts all of
 * its energy on multiples of that something's bin, so this reads zero. It is
 * the measure for anything of the form "this is still locked to that": what
 * lands between the multiples arrived from somewhere else, whether that is
 * aliasing folded down from above Nyquist or a spectrum that was never
 * periodic to begin with.
 */
function offGrid(buf: Float32Array, bin: number, window: number, from: number) {
  const re = new Float32Array(window)
  const im = new Float32Array(window)
  re.set(buf.subarray(from, from + window))
  fft(re, im)
  let total = 0
  let onGrid = 0
  for (let k = 1; k < window / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    total += p
    if (k % bin === 0) onGrid += p
  }
  return (total - onGrid) / Math.max(1e-30, total)
}

// --- oscillator hard sync ---------------------------------------------
/**
 * Sync is the one thing in the rack that cannot be had any other way, and it
 * is also the easiest place in it to make aliasing: the slave's wave is cut
 * off wherever it happens to have got to, and that step is full scale, sharp,
 * and repeating at a rate that belongs to neither oscillator.
 *
 * Measured as the share of the energy that is not on a harmonic of the
 * master. Hard sync is strictly periodic at the master's rate, so in a window
 * holding a whole number of master cycles everything that belongs there lands
 * on a multiple of it, and whatever sits between the harmonics has been
 * folded down from above Nyquist.
 *
 * The master's period is deliberately not a whole number of samples. On one
 * that is -- 187.5 Hz is exactly 256 samples at this rate -- a sync rounded
 * to the sample grid is still exact on every single cycle, the aliasing folds
 * back onto the same harmonics it came from, and this measure reads zero for
 * any implementation whatsoever.
 */
console.log('\noscillator hard sync')
{
  const WINDOW = 16384
  // Long enough for the pitch smoothing to have arrived before the window
  // opens; a glide of 20 ms is a frequency that is not yet what it will be.
  const SETTLE = 4096
  // 56 whole cycles inside the window, and 292.57 samples in each of them.
  const MASTER_BIN = 56
  const MASTER = (SR * MASTER_BIN) / WINDOW

  const slaved = (wave: number, slave: number, linked = true) => {
    const cables = [cable('osc2', 'out', 'rec1', 'l')]
    if (linked) cables.unshift(cable('osc1', 'out', 'osc2', 'sync'))
    return render(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: {} },
          { id: 'osc2', type: 'osc', params: {} },
          { id: 'rec1', type: 'rec', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables,
      },
      {
        frames: SETTLE + WINDOW,
        params: {
          'osc1.pitch': MASTER,
          'osc1.wave': 0,
          'osc2.pitch': slave,
          'osc2.wave': wave,
        },
      },
    ).left
  }

  /** The share of the energy sitting between the master's harmonics. */
  const offHarmonic = (buf: Float32Array) => offGrid(buf, MASTER_BIN, WINDOW, SETTLE)

  // Timing the restart between samples and correcting the step it makes
  // measured -33.3, -30.7, -34.9, -40.4 and -61.4 dB on the five cases below.
  // Restarting on the sample the crossing was noticed, with the step left
  // uncorrected, measured -20.3, -16.8, -21.9, -23.6 and -31.1: thirteen dB
  // worse on every wave, and thirty on a sine. The bar sits between the two.
  const LIMIT = 0.002
  const shown = (share: number) => `${(10 * Math.log10(share)).toFixed(1)} dB off-harmonic`

  for (const [label, wave, slave] of [
    ['saw', 0, 733],
    ['saw an octave up', 0, 1490],
    ['pulse', 1, 733],
    ['triangle', 2, 733],
    ['sine', 3, 733],
  ] as [string, number, number][]) {
    const share = offHarmonic(slaved(wave, slave))
    check(`a synced ${label} keeps to the master's harmonics`, share < LIMIT, shown(share))
  }

  // The control. Nothing makes a free oscillator land on another one's
  // harmonics, so this is what the measure reads when the sync is not
  // working at all -- without it, a check that happened to measure silence
  // or DC would pass everything above.
  const free = offHarmonic(slaved(0, 733, false))
  check('and an unsynced one has no reason to', free > 0.5, shown(free))
}

// --- oscillator FM ----------------------------------------------------
/**
 * The FM jack in both of its modes.
 *
 * Exponential moves the pitch in octaves, which is what a keyboard, a
 * sequencer or a falling envelope wants: the same signal is the same interval
 * wherever the oscillator is tuned. Linear moves it in Hz, by multiples of
 * the Pitch knob, which is what an audio-rate modulator wants: the partials
 * it makes land on a grid of the modulator's own rate, and a grid like that
 * is heard as a timbre rather than as a wobble.
 */
console.log('\noscillator FM')
{
  const tuned = (mode: number) =>
    render(
      {
        modules: [
          { id: 'cv1', type: 'cv', params: {} },
          { id: 'osc1', type: 'osc', params: {} },
          { id: 'rec1', type: 'rec', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('cv1', 'out1', 'osc1', 'fm'), cable('osc1', 'out', 'rec1', 'l')],
      },
      {
        frames: 24000,
        params: {
          'cv1.offset1': 1,
          'osc1.pitch': 400,
          'osc1.wave': 3,
          'osc1.fmAmount': 0.5,
          'osc1.fmMode': mode,
        },
      },
    ).left.subarray(4800)

  // A steady 1.0 into the FM jack is nothing but a tuning change, so where
  // the tone ends up is the arithmetic each mode does, in the open: half an
  // octave above 400 is 566 Hz, and half of 400 on top of it is 600.
  const exp = tuned(0)
  const linear = tuned(1)
  const HALF_OCTAVE = 400 * Math.SQRT2
  check(
    'exponential FM reads the amount in octaves',
    powerAt(exp, HALF_OCTAVE) > 10 * powerAt(exp, 600),
    `${powerAt(exp, HALF_OCTAVE).toFixed(3)} at 566 Hz vs ${powerAt(exp, 600).toFixed(3)} at 600`,
  )
  check(
    'and linear FM reads it in multiples of the pitch',
    powerAt(linear, 600) > 10 * powerAt(linear, HALF_OCTAVE),
    `${powerAt(linear, 600).toFixed(3)} at 600 Hz vs ${powerAt(linear, HALF_OCTAVE).toFixed(3)} at 566`,
  )

  const WINDOW = 16384
  const SETTLE = 4096
  const MOD_BIN = 64
  // 187.5 Hz, which is exactly 64 bins of the window, with the carrier four
  // times that. Anything periodic at the modulator's rate lands on multiples
  // of 64 and nothing else.
  const MOD = (SR * MOD_BIN) / WINDOW

  const modulated = (mode: number, amount: number) =>
    offGrid(
      render(
        {
          modules: [
            { id: 'osc1', type: 'osc', params: {} },
            { id: 'osc2', type: 'osc', params: {} },
            { id: 'rec1', type: 'rec', params: {} },
            { id: 'mix1', type: 'mixer', params: {} },
          ],
          cables: [cable('osc1', 'out', 'osc2', 'fm'), cable('osc2', 'out', 'rec1', 'l')],
        },
        {
          frames: SETTLE + WINDOW,
          params: {
            'osc1.pitch': MOD,
            'osc1.wave': 3,
            'osc2.pitch': MOD * 4,
            'osc2.wave': 3,
            'osc2.fmAmount': amount,
            'osc2.fmMode': mode,
          },
        },
      ).left,
      MOD_BIN,
      WINDOW,
      SETTLE,
    )

  // This is the whole of why the switch exists. Linear FM leaves the average
  // frequency exactly where the Pitch knob put it, so the wave still repeats
  // at the modulator's rate and every partial it grows lands on that grid.
  // Exponential cannot: the average of 2^x is not 2 to the average x, so the
  // carrier drifts upward with the index and the result is not periodic at
  // the modulator's rate at all. Both measure the extremes here -- nothing
  // measurable off the grid against nothing measurable on it.
  check('linear FM keeps its partials on the modulator', modulated(1, 0.5) < 0.001)
  check('and exponential FM does not', modulated(0, 0.5) > 0.5)

  // Through zero, which is what the negative half of the core's rate clamp
  // is for. Past an amount of 1 the frequency spends part of each cycle below
  // zero; running the wave backwards through it keeps the average where it
  // was and the grid with it. Stopping at zero instead holds the grid up to
  // an amount of 1 and loses it completely above -- measured off-grid at
  // -Infinity dB here and 0 dB at both of the amounts below, which is the
  // difference between a bell and a growl.
  check('and holds it through zero', modulated(1, 1.5) < 0.001)
  check('however far through', modulated(1, 3) < 0.001)
}

// --- oscillator level, octave and the envelope's other destinations ----
/**
 * The three things an oscillator gained when it stopped needing a VCA, a
 * second oscillator and a cable to do ordinary work.
 *
 * Level is what it says. Octave is the coarse half of the tuning pair. Env
 * Pitch and Env Width point the module's own envelope at something other than
 * its amplitude, which is what makes a laser or a PWM sweep a one-module
 * patch rather than a three-module one.
 */
console.log('\noscillator level, octave and envelope routing')
{
  const solo = (params: Record<string, number>, frames = 8192) =>
    render(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: {} },
          { id: 'rec1', type: 'rec', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('osc1', 'out', 'rec1', 'l')],
      },
      { frames, params: { 'osc1.pitch': 220, 'osc1.wave': 3, ...params } },
    ).left

  // Level is a plain multiply, so half the knob is half the peak. Measured
  // after the smoother has arrived, which is what the offset is for.
  const full = stats(solo({}).subarray(2048))
  const half = stats(solo({ 'osc1.level': 0.5 }).subarray(2048))
  const shut = stats(solo({ 'osc1.level': 0 }).subarray(2048))
  check('Level scales the output', Math.abs(half.peak / full.peak - 0.5) < 0.01, `${full.peak.toFixed(3)} -> ${half.peak.toFixed(3)}`)
  check('and closes it completely', shut.peak < 1e-6, shut.peak.toExponential(1))

  // Octave is whole octaves on top of the Pitch knob, and it detents, so
  // anything between two positions rounds to one of them.
  const up = powerAt(solo({ 'osc1.octave': 1 }).subarray(2048), 440)
  const down = powerAt(solo({ 'osc1.octave': -1 }).subarray(2048), 110)
  const base = powerAt(solo({}).subarray(2048), 220)
  check('Octave +1 doubles the pitch', up > base * 0.8, `${up.toFixed(3)} at 440 Hz`)
  check('and Octave -1 halves it', down > base * 0.8, `${down.toFixed(3)} at 110 Hz`)

  // The one-module laser: the envelope is the sweep, with nothing patched.
  // Exponential whatever the FM jack is set to, so the fall is an interval
  // rather than a slide in hertz. Measured as a rate rather than a bin,
  // because a pitch that is falling is not sitting on any one of them.
  const heard = (buf: Float32Array, from: number, to: number) => {
    let crossings = 0
    for (let i = from + 1; i < to; i++) if (buf[i - 1] <= 0 !== buf[i] <= 0) crossings++
    return (crossings * SR) / (2 * (to - from))
  }
  const sweeping = { 'osc1.envAmount': 0, 'osc1.decay': 0.08, 'osc1.sustain': 0 }
  const swept = solo({ ...sweeping, 'osc1.envPitch': 2 }, SR / 2)
  const flat = solo(sweeping, SR / 2)
  const from = heard(swept, 0, 720)
  const to = heard(swept, SR / 2 - 4800, SR / 2)
  check('Env Pitch sweeps the pitch on its own', from > to * 2.5, `${from.toFixed(0)} -> ${to.toFixed(0)} Hz`)
  check(
    'and settles back on the Pitch knob',
    Math.abs(to - 220) < 5 && Math.abs(heard(flat, 0, 720) - 220) < 20,
    `${to.toFixed(0)} Hz against a flat ${heard(flat, 0, 720).toFixed(0)}`,
  )

  // And the same envelope on the width, which is a PWM sweep without the LFO,
  // the cable or the second module. Only the two waves that have a width to
  // move can show it.
  //
  // 187.5 Hz is 256 samples a cycle, so a 2048-sample window holds exactly
  // eight of them. Duty measured across a fraction of a cycle reads the
  // fraction rather than the width, and the two windows below would disagree
  // by more than the thing being measured.
  const pulse = {
    'osc1.pitch': 187.5,
    'osc1.wave': 1,
    'osc1.envAmount': 0,
    'osc1.decay': 0.1,
    'osc1.sustain': 0,
  }
  const duty = (buf: Float32Array, from: number, to: number) => {
    let high = 0
    for (let i = from; i < to; i++) if (buf[i] > 0) high++
    return high / (to - from)
  }
  const moved = solo({ ...pulse, 'osc1.envWidth': 0.8 }, SR / 4)
  const still = solo(pulse, SR / 4)
  check(
    'Env Width sweeps the pulse width on its own',
    Math.abs(duty(moved, 0, 2048) - duty(moved, SR / 8, SR / 8 + 2048)) > 0.2,
    `${duty(moved, 0, 2048).toFixed(2)} -> ${duty(moved, SR / 8, SR / 8 + 2048).toFixed(2)}`,
  )
  check(
    'and leaves the width alone at zero',
    Math.abs(duty(still, 0, 2048) - duty(still, SR / 8, SR / 8 + 2048)) < 0.02,
  )
  // An oscillator that cannot be heard does not synthesise anything, which
  // is worth a great deal in a rack of voices that are mostly waiting -- and
  // is only allowed because it changes nothing. These two are what "nothing"
  // means: it has to come back, and the Env jack has to go on working while
  // the audio is not being made.
  const retriggered = render(
    {
      modules: [
        { id: 'clk1', type: 'clock', params: {} },
        { id: 'osc1', type: 'osc', params: { envAmount: 1 } },
        { id: 'rec1', type: 'rec', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('clk1', 'x1', 'osc1', 'gate'), cable('osc1', 'out', 'rec1', 'l')],
    },
    {
      frames: SR,
      gate: false,
      params: { 'clk1.rate': 8, 'osc1.pitch': 440, 'osc1.wave': 3, 'osc1.decay': 0.02, 'osc1.sustain': 0 },
    },
  ).left

  // Blips, counted the way an ear would: a burst is a run of samples above a
  // fraction of the loudest one, with the quiet between them to separate it.
  let bursts = 0
  let quiet = true
  const window = 256
  const floor = stats(retriggered).peak * 0.2
  for (let i = 0; i + window < retriggered.length; i += window) {
    const loud = stats(retriggered.subarray(i, i + window)).peak > floor
    if (loud && quiet) bursts++
    quiet = !loud
  }
  check('a skipped oscillator comes back when it is retriggered', bursts === 8, `${bursts} blips in a second at 8 Hz`)

  // Level shut is the other way to reach a gain of zero, and it must not take
  // the Env jack down with it: an oscillator used purely as an envelope
  // generator is a thing the manual offers.
  const asEnvelope = render(
    {
      modules: [
        { id: 'osc1', type: 'osc', params: {} },
        { id: 'osc2', type: 'osc', params: {} },
        { id: 'vca1', type: 'vca', params: {} },
        { id: 'rec1', type: 'rec', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [
        cable('osc2', 'out', 'vca1', 'in'),
        cable('osc1', 'env', 'vca1', 'cv'),
        cable('vca1', 'out', 'rec1', 'l'),
      ],
    },
    { frames: SR / 4, params: { 'osc1.level': 0, 'osc1.decay': 0.2, 'osc1.sustain': 0 } },
  ).left
  check('and its Env jack still works with its Level shut', stats(asEnvelope).peak > 0.1, `peak ${stats(asEnvelope).peak.toFixed(3)}`)

  // A sine has no width, and neither of these may invent one for it.
  const sineA = solo({ 'osc1.envAmount': 0, 'osc1.envWidth': 0 }, 8192)
  const sineB = solo({ 'osc1.envAmount': 0, 'osc1.envWidth': 1 }, 8192)
  check('but not on a sine, which has no width', same(sineA, sineB))
}

// --- LFO width and PWM ------------------------------------------------
/**
 * A rate that fits a whole number of cycles into one scope frame.
 *
 * Duty cycle measured across a frame holding 3.41 cycles is not the width:
 * the leftover 0.41 of a cycle is entirely the high part, which reads a
 * 50% square as 56% high. An exact number of cycles removes the bias
 * instead of papering over it with a loose tolerance.
 */
const LFO_CYCLES = 4
const LFO_RATE = (SR / SCOPE_CAPTURE) * LFO_CYCLES

console.log('\nLFO width')
{
  const scoped = (params: Record<string, number>) =>
    capture(
      {
        modules: [
          { id: 'lfo1', type: 'lfo', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
        ],
        cables: [cable('lfo1', 'out', 'scope1', 'in')],
      },
      { params },
    ).scope1

  // Duty cycle: the fraction of the cycle a pulse spends high is the width.
  const duty = (buf: Float32Array) => {
    let high = 0
    for (const v of buf) if (v > 0) high++
    return high / buf.length
  }

  const PULSE = { 'lfo1.shape': 1, 'lfo1.rate': LFO_RATE }
  const even = scoped({ ...PULSE, 'lfo1.width': 0.5 })
  const narrow = scoped({ ...PULSE, 'lfo1.width': 0.1 })
  const wide = scoped({ ...PULSE, 'lfo1.width': 0.9 })

  check('a square is half high', Math.abs(duty(even) - 0.5) < 0.01, duty(even).toFixed(3))
  // Narrowing the pulse is the whole point: a sliver is a repeating trigger,
  // which the rack previously had no way to produce.
  check('narrowing the width narrows the pulse', Math.abs(duty(narrow) - 0.1) < 0.01, duty(narrow).toFixed(3))
  check('and widening it widens the pulse', Math.abs(duty(wide) - 0.9) < 0.01, duty(wide).toFixed(3))

  // The default is unchanged, so every patch saved before Width existed
  // sounds exactly as it did: the shipped shape is a sine, which ignores it.
  const sineA = scoped({ 'lfo1.rate': LFO_RATE })
  const sineB = scoped({ 'lfo1.rate': LFO_RATE, 'lfo1.width': 0.2 })
  check('width does not touch the sine shape', same(sineA, sineB))

  // The core integrates its pulse to make a triangle, so width tilts that too
  // -- a down-ramp at one end, an up-ramp at the other. Worth pinning down
  // because the manual used to claim width was pulse-only.
  const TRI = { 'lfo1.shape': 2, 'lfo1.rate': LFO_RATE }
  const rise = (buf: Float32Array) => {
    let up = 0
    for (let i = 1; i < buf.length; i++) if (buf[i] > buf[i - 1]) up++
    return up / (buf.length - 1)
  }
  const down = rise(scoped({ ...TRI, 'lfo1.width': 0.1 }))
  const even3 = rise(scoped({ ...TRI, 'lfo1.width': 0.5 }))
  const up = rise(scoped({ ...TRI, 'lfo1.width': 0.9 }))
  check('width tilts the triangle as well', down < 0.3 && up > 0.7, `${down.toFixed(2)} / ${even3.toFixed(2)} / ${up.toFixed(2)} rising`)
  check('and leaves it symmetrical in the middle', Math.abs(even3 - 0.5) < 0.05, even3.toFixed(3))
}

console.log('\nLFO PWM input')
{
  const dutyOf = (buf: Float32Array, from = 0, to = buf.length) => {
    let high = 0
    for (let i = from; i < to; i++) if (buf[i] > 0) high++
    return high / (to - from)
  }

  // A steady offset through the PWM jack, which pins the scaling rather than
  // just proving something moved: the oscillator's 0.45 means an input of
  // 0.5 shifts the width by 0.225.
  const shifted = (offset: number) =>
    capture({
      modules: [
        { id: 'cv1', type: 'cv', params: { offset1: offset } },
        { id: 'lfo1', type: 'lfo', params: { rate: LFO_RATE, shape: 1, width: 0.5 } },
        { id: 'scope1', type: 'scope', params: {} },
      ],
      cables: [cable('cv1', 'out1', 'lfo1', 'pwm'), cable('lfo1', 'out', 'scope1', 'in')],
    }).scope1

  const up = dutyOf(shifted(0.5))
  const down = dutyOf(shifted(-0.5))
  check('a positive PWM input widens the pulse', Math.abs(up - 0.725) < 0.01, up.toFixed(3))
  check('a negative one narrows it', Math.abs(down - 0.275) < 0.01, down.toFixed(3))

  // And a moving input moves it. The sweep is a square at one cycle per
  // frame, so the first half of the capture sits at +1 and the second at -1,
  // each holding a whole number of the fast LFO's cycles.
  const swept = capture({
    modules: [
      { id: 'lfo1', type: 'lfo', params: { rate: SR / SCOPE_CAPTURE, shape: 1, width: 0.5 } },
      { id: 'lfo2', type: 'lfo', params: { rate: LFO_RATE, shape: 1, width: 0.5 } },
      { id: 'scope1', type: 'scope', params: {} },
    ],
    cables: [cable('lfo1', 'out', 'lfo2', 'pwm'), cable('lfo2', 'out', 'scope1', 'in')],
  }).scope1

  const first = dutyOf(swept, 0, SCOPE_CAPTURE / 2)
  const second = dutyOf(swept, SCOPE_CAPTURE / 2, SCOPE_CAPTURE)
  check('a swept PWM input sweeps the duty cycle', first - second > 0.7, `${first.toFixed(2)} then ${second.toFixed(2)}`)

  // Unpatched, the jack must leave the knob entirely alone.
  const still = capture({
    modules: [
      { id: 'lfo1', type: 'lfo', params: { rate: LFO_RATE, shape: 1, width: 0.25 } },
      { id: 'scope1', type: 'scope', params: {} },
    ],
    cables: [cable('lfo1', 'out', 'scope1', 'in')],
  }).scope1
  check(
    'an unpatched PWM jack leaves the width alone',
    Math.abs(dutyOf(still) - 0.25) < 0.01,
    dutyOf(still).toFixed(3),
  )
}

// --- keyboard ---------------------------------------------------------
/**
 * The keyboard's whole job is arithmetic: a key number and an octave switch
 * become a pitch in octaves, and a gate follows the transport. Both halves
 * are worth pinning down, because the pitch is what makes it play in tune
 * against an oscillator's FM input.
 */
console.log('\nkeyboard')
{
  const rig = (params: Record<string, number>, gate = true) =>
    capture(
      {
        modules: [
          { id: 'key1', type: 'keys', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'scope2', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('key1', 'pitch', 'scope1', 'in'),
          cable('key1', 'gate', 'scope2', 'in'),
        ],
      },
      { params, gate },
    )

  const held = (buf: Float32Array) => buf[buf.length - 1]

  const bottom = rig({})
  check('the bottom key puts out nothing', held(bottom.scope1) === 0, String(held(bottom.scope1)))
  check('and the gate is open while the transport is', held(bottom.scope2) === 1)

  // A semitone is a twelfth of an octave, which is what an oscillator's FM
  // input is scaled in: one octave up the keyboard must read exactly 1.
  const up = rig({ 'key1.note': 12 })
  check('twelve keys up is exactly an octave', held(up.scope1) === 1, String(held(up.scope1)))
  const top = rig({ 'key1.note': 24 })
  check('and the top key is two', held(top.scope1) === 2, String(held(top.scope1)))

  const shifted = rig({ 'key1.note': 3, 'key1.octave': -2 })
  check(
    'the octave switch adds whole octaves',
    Math.abs(held(shifted.scope1) - (3 / 12 - 2)) < 1e-6,
    String(held(shifted.scope1)),
  )

  const shut = rig({ 'key1.note': 7 }, false)
  check('the gate closes with the transport', held(shut.scope2) === 0)
  check('but the pitch stays where it was left', held(shut.scope1) > 0.58, String(held(shut.scope1)))
  // The Gate jack is the other way in, and the point of it is that the note
  // is a parameter rather than part of the gate: whatever fires it plays
  // whichever key was clicked last, so the keyboard is a pitch setting for
  // its source rather than something that has to be played by hand.
  //
  // key1's own transport is held shut throughout, so the only thing that can
  // open its gate here is the cable.
  const driven = (note: number, trigger: boolean) =>
    capture(
      {
        modules: [
          { id: 'gate1', type: 'gate', params: {} },
          { id: 'key1', type: 'keys', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'scope2', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('gate1', 'gate', 'key1', 'trig'),
          cable('key1', 'pitch', 'scope1', 'in'),
          cable('key1', 'gate', 'scope2', 'in'),
        ],
      },
      { params: { 'key1.note': note }, gate: false, gates: { gate1: trigger } },
    )

  const fired = driven(5, true)
  check('a Trigger cabled to Gate opens it', held(fired.scope2) === 1)
  check(
    'and it sounds the key that was clicked last',
    Math.abs(held(fired.scope1) - 5 / 12) < 1e-6,
    String(held(fired.scope1)),
  )

  const quiet = driven(5, false)
  check('with the Trigger shut the gate is shut', held(quiet.scope2) === 0)
  check(
    'and the note still stands, waiting to be fired',
    Math.abs(held(quiet.scope1) - 5 / 12) < 1e-6,
    String(held(quiet.scope1)),
  )

  // An unpatched Gate jack reads ground, which must not hold the gate open.
  check('an unpatched Gate jack is not a stuck gate', held(shut.scope2) === 0)
}


// --- trigger fire modes ----------------------------------------------
console.log('\ntrigger modes')
{
  // A Trigger on its own, with a scope reading the gate it puts out. The
  // render is exactly one capture long, so what the scope holds is the whole
  // of it from the first sample -- which is where the press lands.
  const rig = (params: Record<string, number>, open: boolean) =>
    capture(
      {
        modules: [
          { id: 'gate1', type: 'gate', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('gate1', 'gate', 'scope1', 'in')],
      },
      { params, gate: open },
    ).scope1

  /** How many of the captured samples the gate was open for. */
  const high = (buf: Float32Array) => {
    let n = 0
    for (const v of buf) if (v > 0.5) n++
    return n
  }

  // Held: the gate is the press and nothing else.
  check('held is open while the press is', high(rig({ 'gate1.mode': 0 }, true)) === SCOPE_CAPTURE)
  check('and shut when it is not', high(rig({ 'gate1.mode': 0 }, false)) === 0)

  // One shot: a fixed length from the press. Lengths are taken as a fraction
  // of the capture window so the whole shot fits inside what the scope holds.
  const shot = (fraction: number) =>
    high(rig({ 'gate1.mode': 1, 'gate1.length': (SCOPE_CAPTURE * fraction) / SR }, true))

  const half = Math.round(SCOPE_CAPTURE * 0.5)
  check('one shot is as long as Length says', Math.abs(shot(0.5) - half) <= 1, `${shot(0.5)} of ${half}`)

  const most = Math.round(SCOPE_CAPTURE * 0.75)
  check('and a longer Length is longer', Math.abs(shot(0.75) - most) <= 1, `${shot(0.75)} of ${most}`)

  // The point of the mode: the gate is the same shape however long the key
  // was down, so a shot longer than the window fills all of it.
  check('a Length past the window fills it', shot(2) === SCOPE_CAPTURE, `${shot(2)}`)

  // Never pressed, so the length is beside the point.
  check('a shot never fired stays shut', high(rig({ 'gate1.mode': 1, 'gate1.length': 1 }, false)) === 0)

  // Latch is the main thread's business: the engine only ever sees a held
  // gate whose release never arrived, so down here it behaves as held does.
  check('latch reads as held in the engine', high(rig({ 'gate1.mode': 2 }, true)) === SCOPE_CAPTURE)
}

// --- sample and hold -------------------------------------------------
console.log('\nsample and hold')
{
  const RATE = 50
  const free = capture({
    modules: [
      { id: 'sh1', type: 'sh', params: { rate1: RATE } },
      { id: 'scope1', type: 'scope', params: {} },
      { id: 'scope2', type: 'scope', params: {} },
    ],
    cables: [cable('sh1', 'out1', 'scope1', 'in'), cable('sh1', 'clk1', 'scope2', 'in')],
  })

  let steps = 0
  let outOfRange = 0
  for (let i = 1; i < free.scope1.length; i++) {
    if (free.scope1[i] !== free.scope1[i - 1]) steps++
    if (Math.abs(free.scope1[i]) > 1) outOfRange++
  }
  // One capture is 4096 samples, which at 48 kHz is 85 ms: four ticks at 50 Hz.
  const expected = Math.floor((SCOPE_CAPTURE / SR) * RATE)
  check(
    'it steps once per tick and holds in between',
    steps === expected,
    `${steps} steps, expected ${expected}`,
  )
  check('the held value stays in range', outOfRange === 0)

  let high = 0
  for (const v of free.scope2) if (v > 0.5) high++
  check(
    'the clock output is a square at the set rate',
    Math.abs(high / free.scope2.length - 0.5) < 0.05,
    `${(high / free.scope2.length).toFixed(3)} duty`,
  )

  // With something patched to In it samples that instead of its own noise.
  const patched = capture({
    modules: [
      { id: 'cv1', type: 'cv', params: { offset1: 0.5 } },
      { id: 'sh1', type: 'sh', params: { rate1: RATE } },
      { id: 'scope1', type: 'scope', params: {} },
    ],
    cables: [cable('cv1', 'out1', 'sh1', 'in1'), cable('sh1', 'out1', 'scope1', 'in')],
  })
  const sampled = patched.scope1[SCOPE_CAPTURE - 1]
  check(
    'a patched input replaces the internal noise',
    Math.abs(sampled - 0.5) < 1e-6,
    sampled.toFixed(4),
  )

  // --- four channels, and they are genuinely four -----------------------
  const four = (params: Record<string, number>) =>
    capture({
      modules: [
        { id: 'sh1', type: 'sh', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        { id: 'scope2', type: 'scope', params: {} },
        { id: 'scope3', type: 'scope', params: {} },
        { id: 'scope4', type: 'scope', params: {} },
      ],
      cables: [
        cable('sh1', 'out1', 'scope1', 'in'),
        cable('sh1', 'out2', 'scope2', 'in'),
        cable('sh1', 'out3', 'scope3', 'in'),
        cable('sh1', 'out4', 'scope4', 'in'),
      ],
      // The rig has no mixer; nothing here is listened to, only scoped.
    }, { params })

  // Fast enough that every channel ticks several times inside one capture;
  // at the default 6 Hz a 85 ms frame can pass without a single tick.
  const BASE = { 'sh1.rate1': RATE, 'sh1.rate2': RATE, 'sh1.rate3': RATE, 'sh1.rate4': RATE }
  const all = four(BASE)
  check(
    'every channel runs',
    [all.scope1, all.scope2, all.scope3, all.scope4].every((b) => b.some((v) => v !== 0)),
  )
  check(
    'and no two channels hold the same value',
    !same(all.scope1, all.scope2) && !same(all.scope2, all.scope3) && !same(all.scope3, all.scope4),
  )

  // The reason each channel has its own random stream: a shared one is drawn
  // from in whatever order the channels fire, so retuning one would quietly
  // reshuffle the others.
  const retuned = four({ ...BASE, 'sh1.rate1': 17 })
  check('retuning channel 1 changes channel 1', !same(all.scope1, retuned.scope1))
  check(
    'and leaves the other three alone',
    same(all.scope2, retuned.scope2) &&
      same(all.scope3, retuned.scope3) &&
      same(all.scope4, retuned.scope4),
  )
}

// --- ladder filter modes ----------------------------------------------
console.log('\nladder modes')
{
  // 500 Hz, so that three octaves either side of it -- 62.5 Hz and 4 kHz --
  // are both inside the oscillator's range. Probing above 4 kHz would silently
  // clamp to it and two of the checks below would be measuring the same tone.
  const CUTOFF = 500
  const SINE = 3
  const [LP24, LP12, BP, HP] = [0, 1, 2, 3]

  /** A sine through the filter, measured where the scope taps it. */
  const through = (mode: number, pitch: number) =>
    stats(
      capture({
        modules: [
          // Env Amt at zero so it drones: a response is measured on a steady
          // tone, not on something that is fading while it is being measured.
          { id: 'osc1', type: 'osc', params: { pitch, wave: SINE, envAmount: 0 } },
          // Turned well down on the way in. The ladder saturates its input
          // even at Drive 1, and a full-scale sine picks up enough harmonics
          // to be heard through a band it is nowhere near -- which reads as a
          // filter that does not reject, when it is the source that is dirty.
          { id: 'vca1', type: 'vca', params: { level: 0.08 } },
          {
            id: 'lpf1',
            type: 'ladder',
            // No resonance and no drive: a peak at the corner or a saturator
            // in the way would flatter whichever mode they happened to suit.
            params: { cutoff: CUTOFF, resonance: 0, drive: 1, cvAmount: 0, mode },
          },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('osc1', 'out', 'vca1', 'in'),
          cable('vca1', 'out', 'lpf1', 'in'),
          cable('lpf1', 'out', 'scope1', 'in'),
        ],
      }).scope1,
    ).rms

  const LOW = CUTOFF / 8
  const HIGH = CUTOFF * 8

  // Lowpass: the plain ladder, and what every patch saved before Mode existed
  // still gets.
  check(
    'lp24 passes below the cutoff and stops above it',
    through(LP24, LOW) > through(LP24, HIGH) * 20,
    `${through(LP24, LOW).toFixed(4)} low against ${through(LP24, HIGH).toFixed(6)} high`,
  )

  // Two poles instead of four is a gentler slope, which is the whole reason to
  // have it. Measured one octave up rather than at HIGH: three octaves up, a
  // four-pole slope is already under the residue the saturator and the
  // oscillator leave behind, and the comparison would be one noise floor
  // against another rather than one slope against another.
  const JUST_ABOVE = CUTOFF * 2
  check(
    'lp12 lets more of the top through than lp24',
    through(LP12, JUST_ABOVE) > through(LP24, JUST_ABOVE) * 3,
    `${through(LP12, JUST_ABOVE).toFixed(5)} against ${through(LP24, JUST_ABOVE).toFixed(5)}`,
  )

  // The one the rack had no way to make. Taking the mud out of a sound is the
  // daily job it is for.
  check(
    'hp passes above the cutoff and stops below it',
    through(HP, HIGH) > through(HP, LOW) * 20,
    `${through(HP, HIGH).toFixed(4)} high against ${through(HP, LOW).toFixed(6)} low`,
  )

  // Bandpass has to be checked from both sides: a mode that quietly did
  // nothing would still beat one end of it.
  //
  // Its skirts are not symmetrical, and deliberately so -- it is a two-pole
  // tap minus a three-pole one, which leaves one pole of slope below the band
  // against three above it. So the low side is probed four octaves out and the
  // high side three, to be looking at comparable rejection rather than at the
  // difference between the two slopes.
  const band = through(BP, CUTOFF)
  check(
    'bp rejects below its band',
    band > through(BP, CUTOFF / 16) * 4,
    `${through(BP, CUTOFF / 16).toFixed(4)} low against ${band.toFixed(4)} at cutoff`,
  )
  check(
    'bp rejects above its band',
    band > through(BP, HIGH) * 8,
    `${through(BP, HIGH).toFixed(4)} high against ${band.toFixed(4)} at cutoff`,
  )

  // No mode may run away: these are sums of taps with signs, and a highpass
  // that adds six times one stage is the one to worry about.
  for (const [name, mode] of [['lp24', LP24], ['lp12', LP12], ['bp', BP], ['hp', HP]] as const) {
    const loud = through(mode, CUTOFF)
    check(`${name} stays bounded at the corner`, Number.isFinite(loud) && loud < 4, loud.toFixed(4))
  }
}

console.log('\nladder response curve')
{
  // The panel's picture of the filter is a formula, not a measurement, so it
  // is checked against one: a quiet sine through the real filter, whose gain
  // has to land where the curve says it does. Quiet, because the formula
  // takes the saturators as straight lines, and at a thousandth of full scale
  // they are.
  const measure = (hz: number, cutoff: number, res: number, mode: number) => {
    const filter = new LadderFilter(SR)
    const frames = SR
    let re = 0
    let im = 0
    for (let i = 0; i < frames; i++) {
      const phase = (2 * Math.PI * hz * i) / SR
      const y = filter.process(1e-3 * Math.sin(phase), cutoff, res, 1, mode)
      // The second half only, once the resonance has finished ringing up.
      if (i >= frames / 2) {
        re += y * Math.sin(phase)
        im += y * Math.cos(phase)
      }
    }
    return (Math.hypot(re, im) * 2) / (frames / 2) / 1e-3
  }

  const db = (v: number) => 20 * Math.log10(v)
  let worst = 0
  let where = ''
  for (const mode of [0, 1, 2, 3]) {
    for (const res of [0, 0.5, 0.9]) {
      for (const hz of [60, 250, 800, 1000, 1250, 4000, 12000]) {
        const want = ladderResponse(hz, 1000, res, mode, SR)
        const got = measure(hz, 1000, res, mode)
        // Anything more than 60 dB down is under the residue of the probe
        // itself, and agreeing about silence proves nothing.
        if (db(want) < -60) continue
        const off = Math.abs(db(got) - db(want))
        if (off > worst) {
          worst = off
          where = `mode ${mode}, res ${res}, ${hz} Hz`
        }
      }
    }
  }
  check('the drawn curve matches the filter to within 0.5 dB', worst < 0.5, `worst ${worst.toFixed(3)} dB at ${where}`)
}

// --- compressor --------------------------------------------------------
console.log('\ncompressor')
{
  const SINE = 3
  // Long enough that the capture -- which is the tail of the render -- is the
  // settled state rather than the attack ramp on the way into it.
  const FRAMES = SR / 2

  /**
   * A sine at `level`, through the compressor, measured at both its jacks.
   *
   * `key` adds a second, louder oscillator on the sidechain, which is the
   * case the Key input exists for.
   */
  const run = (level: number, params: Record<string, number>, key?: number) =>
    capture(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: { pitch: 110, wave: SINE, envAmount: 0 } },
          { id: 'vca1', type: 'vca', params: { level } },
          { id: 'osc2', type: 'osc', params: { pitch: 300, wave: SINE, envAmount: 0 } },
          { id: 'vca2', type: 'vca', params: { level: key ?? 0 } },
          {
            id: 'comp1',
            type: 'comp',
            params: { threshold: -24, ratio: 8, attack: 0.001, release: 0.2, makeup: 0, ...params },
          },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'scope2', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('osc1', 'out', 'vca1', 'in'),
          cable('vca1', 'out', 'comp1', 'in'),
          ...(key === undefined
            ? []
            : [cable('osc2', 'out', 'vca2', 'in'), cable('vca2', 'out', 'comp1', 'key')]),
          cable('comp1', 'out', 'scope1', 'in'),
          cable('comp1', 'gr', 'scope2', 'in'),
        ],
      },
      { frames: FRAMES },
    )

  const LOUD = 1
  const QUIET = 0.03

  // Ratio 1 is the bypass to measure against: same rig, same level, nothing
  // turned down. Comparing against it rather than against an absolute number
  // keeps these checks about the compressor and not about the oscillator.
  const loudOpen = stats(run(LOUD, { ratio: 1 }).scope1).rms
  const loudSquashed = stats(run(LOUD, {}).scope1).rms
  check(
    'a signal over the threshold is turned down',
    loudSquashed < loudOpen * 0.3,
    `${loudSquashed.toFixed(4)} against ${loudOpen.toFixed(4)} at ratio 1`,
  )

  const quietOpen = stats(run(QUIET, { ratio: 1 }).scope1).rms
  const quietThrough = stats(run(QUIET, {}).scope1).rms
  check(
    'and one under it is left alone',
    Math.abs(quietThrough - quietOpen) < quietOpen * 0.02,
    `${quietThrough.toFixed(5)} against ${quietOpen.toFixed(5)}`,
  )

  // Ratio is how hard, so more of it is less signal.
  const gentle = stats(run(LOUD, { ratio: 2 }).scope1).rms
  const hard = stats(run(LOUD, { ratio: 20 }).scope1).rms
  check(
    'a higher ratio turns it down further',
    hard < gentle,
    `${hard.toFixed(4)} at 20 against ${gentle.toFixed(4)} at 2`,
  )

  // Threshold is where it starts, so lowering it catches more of the signal.
  const high = stats(run(LOUD, { threshold: -6 }).scope1).rms
  const low = stats(run(LOUD, { threshold: -48 }).scope1).rms
  check(
    'a lower threshold catches more of it',
    low < high,
    `${low.toFixed(4)} at -48 dB against ${high.toFixed(4)} at -6 dB`,
  )

  // Makeup is the gain back, and it is the one knob that acts on a signal the
  // compressor is not otherwise touching.
  const flat = stats(run(QUIET, {}).scope1).rms
  const lifted = stats(run(QUIET, { makeup: 12 }).scope1).rms
  check(
    'makeup puts gain back',
    Math.abs(lifted / flat - 4) < 0.1,
    `${(lifted / flat).toFixed(3)}x for 12 dB, expected 3.98x`,
  )

  // GR says how hard it is working, which is the jack you patch.
  const working = stats(run(LOUD, {}).scope2).rms
  const idle = stats(run(QUIET, {}).scope2).rms
  check('GR rises while it is working', working > 0.5, working.toFixed(3))
  check('and sits at zero while it is not', idle < 0.001, idle.toFixed(5))

  // The Key input: a quiet signal, ducked by a loud one that is not in the
  // signal path at all. Nothing else in the rack can do this.
  const ducked = run(QUIET, {}, LOUD)
  check(
    'a signal on Key ducks the input',
    stats(ducked.scope1).rms < quietOpen * 0.5,
    `${stats(ducked.scope1).rms.toFixed(5)} against ${quietOpen.toFixed(5)} undicked`,
  )
  check('and GR follows the Key', stats(ducked.scope2).rms > 0.5, stats(ducked.scope2).rms.toFixed(3))
}

// --- mixer mute and solo -----------------------------------------------
console.log('\nmute and solo')
{
  const SINE = 3

  /**
   * Two tones into two channels of a mixer, measured at its left output.
   *
   * mix2 is what the speakers hear: patching mix1 onward is what stops it
   * being a main mix, and a rack with no main mix at all is a rack the
   * compiler is right to complain about.
   */
  const bus = (params: Record<string, number>) =>
    stats(
      capture({
        modules: [
          { id: 'osc1', type: 'osc', params: { pitch: 110, wave: SINE, envAmount: 0 } },
          { id: 'osc2', type: 'osc', params: { pitch: 330, wave: SINE, envAmount: 0 } },
          { id: 'mix1', type: 'mixer', params: { pan1: 0, pan2: 0, ...params } },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'mix2', type: 'mixer', params: {} },
        ],
        cables: [
          cable('osc1', 'out', 'mix1', 'in1'),
          cable('osc2', 'out', 'mix1', 'in2'),
          cable('mix1', 'l', 'scope1', 'in'),
        ],
      }).scope1,
    ).rms

  const near = (a: number, b: number) => Math.abs(a - b) < Math.max(a, b) * 0.02

  const both = bus({})
  check('two channels both reach the bus', both > 0.05, both.toFixed(4))

  // Muting a channel and pulling its fader to zero have to be the same thing.
  // Measuring against the fader rather than against a number is what makes
  // this a check on the mute and not on the oscillators.
  const muted = bus({ mute1: 1 })
  const faded = bus({ level1: 0 })
  check('mute is the same as a fader at zero', near(muted, faded), `${muted.toFixed(4)} against ${faded.toFixed(4)}`)
  check('and the other channel still plays', muted > 0.02, muted.toFixed(4))

  // Solo is the same claim from the other side: one channel in is every other
  // channel out.
  const soloed = bus({ solo1: 1 })
  const others = bus({ level2: 0 })
  check('solo silences everything not soloed', near(soloed, others), `${soloed.toFixed(4)} against ${others.toFixed(4)}`)

  const two = bus({ solo1: 1, solo2: 1 })
  check('soloing both is the same as soloing neither', near(two, both), `${two.toFixed(4)} against ${both.toFixed(4)}`)

  // A desk lets you mute a channel you have soloed, and it stays muted: solo
  // says which channels are in the running, mute says which are switched off.
  const contradicted = bus({ solo1: 1, mute1: 1 })
  check('mute still mutes a soloed channel', contradicted < 0.001, contradicted.toFixed(5))

  // Soloing a silent channel is the standard way to find out a mixer is not
  // doing what it says: the bus has to go quiet, not carry on regardless.
  const soloSilence = bus({ solo3: 1 })
  check('soloing an empty channel leaves silence', soloSilence < 0.001, soloSilence.toFixed(5))
}

// --- granular ----------------------------------------------------------
console.log('\ngranular')
{
  const SINE = 3
  /** A second, so the buffer holds something wherever Position points. */
  const WARM = SR

  const DEFAULTS = {
    size: 0.1,
    density: 30,
    position: 0.05,
    // No spray and no spread unless a check asks for them: the point of most
    // of these is to compare two settings, and a cloud that scattered
    // differently each time would be comparing two random numbers.
    spray: 0,
    pitch: 0,
    spread: 0,
    mix: 1,
  }

  const gran = (params: Record<string, number>, frames = WARM) =>
    capture(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: { pitch: 200, wave: SINE, envAmount: 0 } },
          { id: 'gran1', type: 'gran', params: { ...DEFAULTS, ...params } },
          { id: 'scope0', type: 'scope', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'scope2', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('osc1', 'out', 'gran1', 'in'),
          // The source itself, to compare the bypass against.
          cable('osc1', 'out', 'scope0', 'in'),
          cable('gran1', 'l', 'scope1', 'in'),
          cable('gran1', 'r', 'scope2', 'in'),
        ],
      },
      { frames },
    )

  /** How often the signal changes sign, which is its pitch by another name. */
  const crossings = (buf: Float32Array) => {
    let n = 0
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0 !== buf[i] < 0) n++
    return n
  }

  /** The share of the capture that is holding still. */
  const quiet = (buf: Float32Array) => {
    let n = 0
    for (const v of buf) if (v > -0.001 && v < 0.001) n++
    return n / buf.length
  }

  // Mix at 0 is a bypass, and has to be an exact one. A granulator sitting in
  // a chain turned off should be indistinguishable from a piece of cable.
  const bypass = gran({ mix: 0 })
  check(
    'at Mix 0 the input passes through untouched',
    same(bypass.scope1, bypass.scope0) && same(bypass.scope2, bypass.scope0),
    `${stats(bypass.scope1).rms.toFixed(4)} against ${stats(bypass.scope0).rms.toFixed(4)}`,
  )

  const wet = gran({})
  check('and at Mix 1 it makes a sound of its own', stats(wet.scope1).rms > 0.05, stats(wet.scope1).rms.toFixed(4))

  // Grains take their pitch when they start and keep it, so the whole cloud
  // moves an octave together.
  const up = gran({ pitch: 1, size: 0.3, density: 20 })
  const level = gran({ pitch: 0, size: 0.3, density: 20 })
  const [fast, slow] = [crossings(up.scope1), crossings(level.scope1)]
  check(
    'Pitch moves the whole cloud by octaves',
    Math.abs(fast / slow - 2) < 0.15,
    `${fast} crossings against ${slow}, ${(fast / slow).toFixed(2)}x`,
  )

  // Size and Density together decide whether this is a texture or a scatter.
  // Short grains far apart leave the gaps between them audible; long grains
  // packed close leave none.
  //
  // Forty a second rather than three, so the window being measured holds
  // several grains and the gaps between them. At three a second it would
  // usually hold no grain at all, which reads as the same number for quite a
  // different reason.
  const scattered = quiet(gran({ size: 0.004, density: 40 }).scope1)
  const continuous = quiet(gran({ size: 0.2, density: 100 }).scope1)
  check(
    'sparse grains leave gaps and dense ones do not',
    scattered > 0.5 && continuous < 0.05,
    `${(scattered * 100).toFixed(0)}% silent sparse against ${(continuous * 100).toFixed(0)}% dense`,
  )

  // Spread is the difference between a point and a cloud.
  const centred = gran({ spread: 0 })
  check('at Spread 0 both channels are the same', same(centred.scope1, centred.scope2))
  const wide = gran({ spread: 1 })
  check('and at Spread 1 they are not', !same(wide.scope1, wide.scope2))

  // Position reaches back into the buffer, and the buffer starts as silence.
  // Half a second in, anything further back than that has nothing in it --
  // which is both a real property of the module and the cleanest way to show
  // that Position is reading where it says it is.
  const HALF = Math.round(SR / 2)
  const recent = gran({ position: 0.05 }, HALF)
  const older = gran({ position: 1.9 }, HALF)
  check('Position reads from the recent past', stats(recent.scope1).rms > 0.05, stats(recent.scope1).rms.toFixed(4))
  check(
    'and further back than the buffer has been filled is silence',
    stats(older.scope1).rms < 0.001,
    stats(older.scope1).rms.toFixed(5),
  )

  // Spray is what stops a cloud being a stutter: the same settings with and
  // without it cannot produce the same samples.
  const dry2 = gran({ spray: 0 })
  const sprayed = gran({ spray: 1 })
  check('Spray scatters where the grains come from', !same(dry2.scope1, sprayed.scope1))
}

// --- clock, burst and sequencer ---------------------------------------
/**
 * The timing modules are checked on what they promise rather than on their
 * waveform: a divider that divides by the wrong number, a burst that fires
 * one pulse too few and a sequencer that skips a step all still produce a
 * perfectly well-behaved train of gates.
 */

/** Indices where a gate signal goes high, which is what these modules speak. */
function risingEdges(buf: Float32Array): number[] {
  const out: number[] = []
  for (let i = 1; i < buf.length; i++) if (buf[i] > 0.5 && buf[i - 1] <= 0.5) out.push(i)
  return out
}

/** A held signal as the run of values it actually visits, in order. */
function held(buf: Float32Array): number[] {
  const out: number[] = []
  for (let i = 0; i < buf.length; i++) {
    if (i === 0 || buf[i] !== buf[i - 1]) out.push(buf[i])
  }
  return out
}

/** What fraction of the time a gate signal is open. */
const duty = (buf: Float32Array) => {
  let high = 0
  for (const v of buf) if (v > 0.5) high++
  return high / buf.length
}

console.log('\nclock divider')
{
  // Chosen so a whole number of ticks lands inside one scope frame.
  const TICKS = 16
  const RATE = (SR / SCOPE_CAPTURE) * TICKS
  const PORTS = ['x1', 'd2', 'd3', 'd4', 'd8']
  const DIVISORS = [1, 2, 3, 4, 8]

  const taps = capture({
    modules: [
      { id: 'clk1', type: 'clock', params: { rate: RATE } },
      ...PORTS.map((_, i) => ({ id: `scope${i}`, type: 'scope', params: {} })),
    ],
    cables: PORTS.map((p, i) => cable('clk1', p, `scope${i}`, 'in')),
  })

  const counts = PORTS.map((_, i) => risingEdges(taps[`scope${i}`]).length)
  const wrong: string[] = []
  DIVISORS.forEach((n, i) => {
    // Within one edge: the frame cannot begin and end on a tick boundary for
    // every divisor at once, so an edge may fall either side of it.
    const want = TICKS / n
    if (Math.abs(counts[i] - want) > 1) wrong.push(`/${n}: ${counts[i]} not ~${want}`)
  })
  check(
    'each output fires at its own division of the rate',
    wrong.length === 0,
    wrong.join(', ') || counts.join(','),
  )

  // Width is shared, so narrowing it has to narrow every output at once.
  const narrow = capture({
    modules: [
      { id: 'clk1', type: 'clock', params: { rate: RATE, width: 0.1 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'scope1', type: 'scope', params: {} },
    ],
    cables: [cable('clk1', 'x1', 'scope0', 'in'), cable('clk1', 'd4', 'scope1', 'in')],
  })
  check(
    'width narrows the divisions as well as the undivided output',
    Math.abs(duty(narrow.scope0) - 0.1) < 0.03 && Math.abs(duty(narrow.scope1) - 0.1) < 0.03,
    `x1 ${duty(narrow.scope0).toFixed(3)}, /4 ${duty(narrow.scope1).toFixed(3)}`,
  )

  // A reset that had to be released would be unusable from a held gate.
  const reset = capture({
    modules: [
      { id: 'gate1', type: 'gate', params: {} },
      { id: 'clk1', type: 'clock', params: { rate: RATE } },
      { id: 'scope0', type: 'scope', params: {} },
    ],
    cables: [cable('gate1', 'gate', 'clk1', 'reset'), cable('clk1', 'x1', 'scope0', 'in')],
  })
  check(
    'a reset held high does not stop the clock',
    Math.abs(risingEdges(reset.scope0).length - TICKS) <= 1,
    `${risingEdges(reset.scope0).length} of ~${TICKS}`,
  )
}

console.log('\nburst generator')
{
  const COUNT = 5
  const burst = (params: Record<string, number>) =>
    capture({
      modules: [
        { id: 'brst1', type: 'burst', params: { count: COUNT, rate: 100, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        { id: 'scope2', type: 'scope', params: {} },
      ],
      cables: [
        cable('brst1', 'gate', 'scope0', 'in'),
        cable('brst1', 'ramp', 'scope1', 'in'),
        cable('brst1', 'end', 'scope2', 'in'),
      ],
    })

  const even = burst({})
  // The first pulse opens on sample zero, with no low sample in front of it
  // for an edge to be found against.
  const pulses = risingEdges(even.scope0).length + (even.scope0[0] > 0.5 ? 1 : 0)
  check('it fires exactly as many pulses as Count', pulses === COUNT, `${pulses} of ${COUNT}`)
  check('and says so when the run is over', even.scope2.some((v) => v > 0.5))

  const ramp = held(even.scope1)
  check(
    'the ramp steps from 0 on the first pulse to 1 on the last',
    ramp.length === COUNT && ramp[0] === 0 && Math.abs(ramp[ramp.length - 1] - 1) < 1e-6,
    ramp.map((v) => v.toFixed(2)).join(', '),
  )

  // Curve is the difference between a machine and something physical.
  const gaps = (buf: Float32Array) => {
    const edges = [0, ...risingEdges(buf)]
    return edges.slice(1).map((v, i) => v - edges[i])
  }
  const slowing = gaps(burst({ curve: 1 }).scope0)
  const speeding = gaps(burst({ curve: -1 }).scope0)
  check(
    'a positive curve spreads the run out as it goes',
    slowing.length > 1 && slowing[slowing.length - 1] > slowing[0],
    slowing.join(', '),
  )
  check(
    'and a negative one packs it together',
    speeding.length > 1 && speeding[speeding.length - 1] < speeding[0],
    speeding.join(', '),
  )
}

console.log('\nsequencer')
{
  const RATE = (SR / SCOPE_CAPTURE) * 8
  const PATTERN = { step1: 0, step2: 0.25, step3: 0.5, step4: 0.75 }

  const seq = (params: Record<string, number>) =>
    capture({
      modules: [
        { id: 'seq1', type: 'seq', params: { rate: RATE, length: 4, ...PATTERN, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        { id: 'scope2', type: 'scope', params: {} },
      ],
      cables: [
        cable('seq1', 'cv', 'scope0', 'in'),
        cable('seq1', 'gate', 'scope1', 'in'),
        cable('seq1', 'clk', 'scope2', 'in'),
      ],
    })

  const plain = seq({})
  const visited = held(plain.scope0)
  check(
    'the CV walks the pattern in order and loops',
    visited.slice(0, 8).join(',') === '0,0.25,0.5,0.75,0,0.25,0.5,0.75',
    visited.slice(0, 8).join(','),
  )
  check('Steps is what decides where it loops', !visited.some((v) => v > 0.75))
  check(
    'its clock runs and is published',
    Math.abs(risingEdges(plain.scope2).length - 8) <= 1,
    `${risingEdges(plain.scope2).length} ticks`,
  )

  // A level of zero is the rest, which is what gives the pattern rhythm.
  const rest = seq({ level2: 0 })
  let gatedDuringRest = 0
  for (let i = 0; i < rest.scope0.length; i++) {
    if (Math.abs(rest.scope0[i] - 0.25) < 1e-6 && rest.scope1[i] > 0.5) gatedDuringRest++
  }
  check('a level of zero is a rest', gatedDuringRest === 0, `${gatedDuringRest} gated samples`)
  check(
    'and the steps either side of it still play',
    risingEdges(rest.scope1).length >= 4,
    `${risingEdges(rest.scope1).length} gates`,
  )

  // The Reset jack. A clock at half the step rate pulls the pattern back to
  // step one every second step, so the back half is never reached.
  //
  // The transport is left shut, so the jack is the only thing that can be
  // doing it: the button's path is what every check above already runs on.
  const held4 = (rate: number) =>
    held(
      capture(
        {
          modules: [
            { id: 'clk1', type: 'clock', params: { rate } },
            { id: 'seq1', type: 'seq', params: { rate: RATE, length: 4, ...PATTERN } },
            { id: 'scope0', type: 'scope', params: {} },
          ],
          cables: [cable('clk1', 'x1', 'seq1', 'reset'), cable('seq1', 'cv', 'scope0', 'in')],
        },
        { gate: false },
      ).scope0,
    )

  // Never as far as the last step, rather than never past the second. A reset
  // restarts the sequencer's own phase as well as its index, so the two clocks
  // slide against each other and a run sometimes fits an extra step in before
  // the next pull. What the jack guarantees is that the back of the pattern is
  // never reached, and that is what is worth asserting.
  const pulled = held4(RATE / 2)
  check(
    'the Reset jack keeps pulling the pattern back to step one',
    !pulled.some((v) => v > 0.6),
    pulled.slice(0, 8).join(','),
  )
  check('and it keeps stepping in between', pulled.some((v) => Math.abs(v - 0.25) < 1e-6))

  // Slow enough to be out of the way, so the same rig walks the whole pattern
  // -- which is what says the check above is about Reset and not about the rig.
  const free = held4(RATE / 64)
  check(
    'a reset slower than the pattern leaves it alone',
    free.some((v) => Math.abs(v - 0.75) < 1e-6),
    free.slice(0, 8).join(','),
  )

  // An external clock takes over from the internal one.
  const driven = capture({
    modules: [
      { id: 'clk1', type: 'clock', params: { rate: RATE * 2 } },
      { id: 'seq1', type: 'seq', params: { rate: RATE, length: 4, ...PATTERN } },
      { id: 'scope0', type: 'scope', params: {} },
    ],
    cables: [cable('clk1', 'x1', 'seq1', 'clock'), cable('seq1', 'cv', 'scope0', 'in')],
  })
  check(
    'a patched clock decides when it steps',
    held(driven.scope0).length > visited.length,
    `${held(driven.scope0).length} steps against ${visited.length} on its own clock`,
  )
}

// --- slew ------------------------------------------------------------
console.log('\nslew')
{
  // A gate is the one source in the rack that steps instantly. Every knob is
  // smoothed, so driving this from a knob would ramp the target itself and
  // measure the smoother rather than the slew limiter.
  const step = (params: Record<string, number>) =>
    capture(
      {
        modules: [
          { id: 'gate1', type: 'gate', params: {} },
          { id: 'slew1', type: 'slew', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
        ],
        cables: [cable('gate1', 'gate', 'slew1', 'in'), cable('slew1', 'out', 'scope1', 'in')],
      },
      { params },
    ).scope1

  const RISE = 0.01
  const n = Math.round(RISE * SR)
  const linear = step({ 'slew1.rise': RISE, 'slew1.shape': 0 })
  check(
    'a linear ramp is halfway at half the rise time',
    Math.abs(linear[n / 2 - 1] - 0.5) < 1e-5,
    linear[n / 2 - 1].toFixed(5),
  )
  check(
    'and arrives exactly at the rise time',
    Math.abs(linear[n - 1] - 1) < 1e-5,
    linear[n - 1].toFixed(5),
  )

  // One time constant is 63.2% of the way there, which is what makes the
  // exponential setting a lag rather than a ramp.
  const exponential = step({ 'slew1.rise': RISE, 'slew1.shape': 1 })
  check(
    'an exponential ramp is 63% there after one time constant',
    Math.abs(exponential[n - 1] - 0.632) < 0.005,
    exponential[n - 1].toFixed(4),
  )

  // Rise and fall have to be independent, which a symmetrical source proves.
  const asym = capture({
    modules: [
      { id: 'lfo1', type: 'lfo', params: { rate: 10, shape: 1, depth: 1 } },
      { id: 'slew1', type: 'slew', params: { rise: 0.002, fall: 0.04, shape: 0 } },
      { id: 'scope1', type: 'scope', params: {} },
    ],
    cables: [cable('lfo1', 'out', 'slew1', 'in'), cable('slew1', 'out', 'scope1', 'in')],
  }).scope1

  let up = 0
  let down = 0
  for (let i = 1; i < asym.length; i++) {
    const d = asym[i] - asym[i - 1]
    if (d > up) up = d
    if (d < down) down = d
  }
  const wantUp = 1 / (0.002 * SR)
  const wantDown = 1 / (0.04 * SR)
  check('rising uses the rise time', Math.abs(up - wantUp) / wantUp < 0.02, up.toFixed(6))
  check(
    'falling uses the fall time',
    Math.abs(-down - wantDown) / wantDown < 0.02,
    (-down).toFixed(6),
  )
}

// --- scope -----------------------------------------------------------
console.log('\nscope')
{
  const tapped: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: 110, wave: 3 } },
      { id: 'scope1', type: 'scope', params: {} },
      { id: 'rec1', type: 'rec', params: {} },
    ],
    cables: [cable('osc1', 'out', 'rec1', 'l'), cable('osc1', 'out', 'scope1', 'in')],
  }
  const untapped: Patch = {
    modules: tapped.modules.filter((m) => m.id !== 'scope1'),
    cables: [cable('osc1', 'out', 'rec1', 'l')],
  }

  // A scope taps a signal rather than sitting in the chain, so patching one
  // in must not change a single sample of what is heard.
  check(
    'a scope in the patch does not change the sound',
    same(render(tapped, { frames: 8192 }).left, render(untapped, { frames: 8192 }).left),
  )

  // Deliberately not a whole number of buffers, so the write pointer stops
  // somewhere in the middle and the frame really has to be unrolled. A ring
  // handed over as it sits would pass a peak check and tear on screen.
  const frame = capture(tapped, { frames: SCOPE_CAPTURE + 1234 }).scope1
  check('the frame carries the signal', stats(frame).peak > 0.5, stats(frame).peak.toFixed(3))

  let worst = 0
  for (let i = 1; i < frame.length; i++) {
    const d = Math.abs(frame[i] - frame[i - 1])
    if (d > worst) worst = d
  }
  // A 110 Hz sine at 48 kHz moves at most 0.0144 per sample. A frame unrolled
  // from the wrong place would jump much further than that, exactly once.
  check(
    'the frame is continuous across the ring wrap',
    worst < 0.02,
    `largest step ${worst.toFixed(5)}`,
  )
}

// --- the shapers ------------------------------------------------------
/**
 * Distortion is checked on the harmonics it adds, because that is the whole
 * job: a drive that quietly does nothing, a folder that only clips and a ring
 * modulator wired as a plain multiply against silence all pass a level meter.
 */

/** Harmonic content, as the share of energy that is not the fundamental. */
function harmonicRatio(buf: Float32Array, fundamentalHz: number) {
  // One bin per harmonic, by correlating against sine and cosine at each.
  const n = buf.length
  const power = (hz: number) => {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * hz * i) / SR
      re += buf[i] * Math.cos(t)
      im += buf[i] * Math.sin(t)
    }
    return (re * re + im * im) / (n * n)
  }
  let first = power(fundamentalHz)
  let rest = 0
  for (let h = 2; h <= 12; h++) {
    if (fundamentalHz * h < SR / 2) rest += power(fundamentalHz * h)
  }
  return rest / Math.max(1e-12, first + rest)
}

/** Energy at one frequency alone, for spotting a sideband. */
function powerAt(buf: Float32Array, hz: number) {
  let re = 0
  let im = 0
  for (let i = 0; i < buf.length; i++) {
    const t = (2 * Math.PI * hz * i) / SR
    re += buf[i] * Math.cos(t)
    im += buf[i] * Math.sin(t)
  }
  return Math.sqrt(re * re + im * im) / buf.length
}

/** How many distinct values a signal visits, for spotting quantisation. */
function distinctValues(buf: Float32Array) {
  const seen = new Set<number>()
  for (const v of buf) seen.add(Math.round(v * 1e6))
  return seen.size
}

const TONE = 200

/** A clean sine through the module under test, tapped at its output. */
function shaped(type: string, params: Record<string, number>, port = 'out') {
  return capture({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: TONE, wave: 3, envAmount: 0 } },
      { id: 'sut', type, params },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'sut', 'in'), cable('sut', port, 'scope0', 'in')],
  }).scope0
}

console.log('\ndrive')
{
  const clean = capture({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: TONE, wave: 3, envAmount: 0 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'scope0', 'in')],
  }).scope0
  const pure = harmonicRatio(clean, TONE)
  check('a sine starts out clean', pure < 0.02, `${(pure * 100).toFixed(2)}% harmonics`)

  const gentle = harmonicRatio(shaped('drive', { drive: 1, curve: 0 }), TONE)
  const hard = harmonicRatio(shaped('drive', { drive: 64, curve: 0 }), TONE)
  check(
    'Drive is what adds harmonics',
    hard > gentle * 4 && hard > 0.1,
    `${(gentle * 100).toFixed(2)}% -> ${(hard * 100).toFixed(2)}%`,
  )

  // Symmetrical clipping makes odd harmonics only; the Bias knob exists to
  // break that symmetry, and even harmonics are how you hear it.
  const evens = (buf: Float32Array) =>
    powerAt(buf, TONE * 2) + powerAt(buf, TONE * 4) + powerAt(buf, TONE * 6)
  const centred = evens(shaped('drive', { drive: 8, curve: 1, bias: 0 }))
  const offset = evens(shaped('drive', { drive: 8, curve: 1, bias: 0.4 }))
  check(
    'Bias is what puts even harmonics in',
    offset > centred * 10,
    `${centred.toFixed(5)} centred, ${offset.toFixed(5)} biased -- ${(offset / centred).toFixed(0)}x`,
  )

  // The four curves have to be four sounds, not one sound four times.
  const shapes = [0, 1, 2, 3].map((c) => shaped('drive', { drive: 6, curve: c }))
  let alike = 0
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) if (same(shapes[i], shapes[j])) alike++
  }
  check('each curve is its own shape', alike === 0, `${alike} pair(s) identical`)

  // Rectifying doubles the frequency, which is the thing that makes it sound
  // an octave up rather than merely dirty.
  const rect = shaped('drive', { drive: 1, curve: 3 })
  check(
    'rectify puts the energy an octave up',
    powerAt(rect, TONE * 2) > powerAt(rect, TONE) * 2,
    `${powerAt(rect, TONE).toFixed(4)} at the fundamental, ${powerAt(rect, TONE * 2).toFixed(4)} an octave up`,
  )

  const loud = shaped('drive', { drive: 8, level: 1 })
  const quiet = shaped('drive', { drive: 8, level: 0.25 })
  const peak = (b: Float32Array) => b.reduce((a, v) => Math.max(a, Math.abs(v)), 0)
  check(
    'Level trims the output without changing the shape',
    Math.abs(peak(quiet) / peak(loud) - 0.25) < 0.02,
    `${(peak(quiet) / peak(loud)).toFixed(3)} of full`,
  )
}

console.log('\nwavefolder')
{
  const little = harmonicRatio(shaped('fold', { fold: 1 }), TONE)
  const lots = harmonicRatio(shaped('fold', { fold: 16 }), TONE)
  check(
    'folding harder keeps adding harmonics',
    lots > little * 4 && lots > 0.3,
    `${(little * 100).toFixed(2)}% -> ${(lots * 100).toFixed(2)}%`,
  )

  // Overdrive flattens a wave, so past a point it stops changing much. A
  // folder should keep rearranging instead of settling down.
  const a = shaped('fold', { fold: 6 })
  const b = shaped('fold', { fold: 9 })
  check('and keeps changing rather than settling', !same(a, b))

  // The bug this check exists for: with Symmetry applied before the gain, the
  // two ends of its range sat exactly one fold period apart and sounded the
  // same at the default Fold setting.
  const left = shaped('fold', { fold: 2, symmetry: -1 })
  const right = shaped('fold', { fold: 2, symmetry: 1 })
  check('the ends of Symmetry are different sounds', !same(left, right))
  const centre = shaped('fold', { fold: 2, symmetry: 0 })
  check(
    'and Symmetry rearranges the harmonics',
    Math.abs(harmonicRatio(right, TONE) - harmonicRatio(centre, TONE)) > 0.01,
    `${harmonicRatio(centre, TONE).toFixed(3)} centred vs ${harmonicRatio(right, TONE).toFixed(3)}`,
  )

  const folded = shaped('fold', { fold: 16 })
  check(
    'and it stays inside the rails however hard it is driven',
    folded.every((v) => Math.abs(v) <= 1.3),
    `peak ${folded.reduce((a2, v) => Math.max(a2, Math.abs(v)), 0).toFixed(3)}`,
  )
}

console.log('\nring modulator')
{
  const CARRIER = 700
  const ring = shaped('ring', { freq: CARRIER, mix: 1 })

  // The whole point: the original frequency goes, and the sum and difference
  // arrive in its place.
  check(
    'the sum and difference appear',
    powerAt(ring, CARRIER - TONE) > 0.05 && powerAt(ring, CARRIER + TONE) > 0.05,
    `${powerAt(ring, CARRIER - TONE).toFixed(3)} at ${CARRIER - TONE} Hz, ${powerAt(ring, CARRIER + TONE).toFixed(3)} at ${CARRIER + TONE} Hz`,
  )
  check(
    'and the original tone does not survive',
    powerAt(ring, TONE) < 0.01,
    `${powerAt(ring, TONE).toFixed(4)} left at ${TONE} Hz`,
  )

  const dry = shaped('ring', { freq: CARRIER, mix: 0 })
  check(
    'mix at zero passes the signal untouched',
    powerAt(dry, TONE) > 0.2 && powerAt(dry, CARRIER - TONE) < 0.01,
    `${powerAt(dry, TONE).toFixed(3)} at ${TONE} Hz`,
  )

  // The carrier keeps running and is published, as the sample and hold's
  // clocks are, which is what keeps the Freq knob live when Car is patched.
  const sine = shaped('ring', { freq: CARRIER, mix: 1 }, 'sine')
  check(
    'the internal carrier is on its own jack',
    powerAt(sine, CARRIER) > 0.4,
    `${powerAt(sine, CARRIER).toFixed(3)} at ${CARRIER} Hz`,
  )

  // A patched carrier takes over from the internal one.
  const external = capture({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: TONE, wave: 3, envAmount: 0 } },
      { id: 'osc2', type: 'osc', params: { pitch: 1500, wave: 3, envAmount: 0 } },
      { id: 'ring1', type: 'ring', params: { freq: CARRIER, mix: 1 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [
      cable('osc1', 'out', 'ring1', 'in'),
      cable('osc2', 'out', 'ring1', 'car'),
      cable('ring1', 'out', 'scope0', 'in'),
    ],
  }).scope0
  check(
    'a patched carrier takes over',
    powerAt(external, 1500 - TONE) > 0.05 && powerAt(external, CARRIER - TONE) < 0.01,
    `${powerAt(external, 1300).toFixed(3)} at 1300 Hz, ${powerAt(external, 500).toFixed(4)} at 500 Hz`,
  )
}

console.log('\nbitcrusher')
{
  const full = shaped('crush', { bits: 16, rate: 24000, mix: 1 })
  const coarse = shaped('crush', { bits: 2, rate: 24000, mix: 1 })
  check(
    'fewer bits means fewer values',
    distinctValues(coarse) <= 5 && distinctValues(full) > distinctValues(coarse) * 8,
    `${distinctValues(coarse)} values at 2 bits, ${distinctValues(full)} at 16`,
  )

  // Sample rate reduction: how often the held value is allowed to change.
  const held = (buf: Float32Array) => {
    let steps = 0
    for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) steps++
    return Math.round(steps / (buf.length / SR))
  }
  const crushedNoise = (rate: number) =>
    capture({
      modules: [
        { id: 'noise1', type: 'noise', params: {} },
        { id: 'sut', type: 'crush', params: { bits: 16, rate, mix: 1 } },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('noise1', 'out', 'sut', 'in'), cable('sut', 'out', 'scope0', 'in')],
    }).scope0
  const slow = crushedNoise(2000)
  const fast = crushedNoise(12000)
  check(
    'Rate is how often it takes a reading',
    Math.abs(held(slow) - 2000) < 120 && Math.abs(held(fast) - 12000) < 400,
    `${held(slow)}/sec at 2 kHz, ${held(fast)}/sec at 12 kHz`,
  )

  // Decimation folds everything above half the new rate back down, which is
  // the metallic ringing that makes it sound broken rather than just rough.
  const crushed = shaped('crush', { bits: 16, rate: 1100, mix: 1 })
  check(
    'and it puts a tone in that was never there',
    powerAt(crushed, 1100 - TONE) > 0.02,
    `${powerAt(crushed, 900).toFixed(4)} at 900 Hz, which is the rate minus the tone`,
  )

  const bypass = shaped('crush', { bits: 1, rate: 100, mix: 0 })
  check(
    'mix at zero passes the signal untouched',
    distinctValues(bypass) > 100 && powerAt(bypass, TONE) > 0.2,
    `${distinctValues(bypass)} values`,
  )
}

// --- delay, space and resonator ---------------------------------------
/**
 * The three effects are checked on where their output lands in time, which
 * is the thing that makes them what they are. A delay that repeats at the
 * wrong distance, a reverb whose tail does not outlast its input and a
 * resonator ringing at the wrong note all look perfectly healthy on a meter.
 */

/** Where each run of signal above the floor begins, and how loud it got. */
function clusters(buf: Float32Array, floor = 0.05) {
  const out: { at: number; peak: number }[] = []
  let inRun = false
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > floor) {
      if (!inRun) out.push({ at: i, peak: a })
      else out[out.length - 1].peak = Math.max(out[out.length - 1].peak, a)
      inRun = true
    } else if (inRun && a < floor * 0.5) {
      // Hysteresis: a ringing repeat crosses zero, and counting every
      // crossing as a fresh repeat would find dozens of them.
      inRun = false
    }
  }
  return out
}

/** Energy in a slice of the frame, for asking whether a tail is still going. */
function energy(buf: Float32Array, from: number, to: number) {
  let e = 0
  for (let i = from; i < to; i++) e += buf[i] * buf[i]
  return e
}

/** A single short pulse at time zero, to hear a space with. */
const impulse = (params: Record<string, number> = {}) => ({
  id: 'brst1',
  type: 'burst',
  params: { count: 1, rate: 200, width: 0.02, ...params },
})

console.log('\ndelay')
{
  const TIME = 0.01
  const SPACING = TIME * SR

  const run = (params: Record<string, number>, extra: Cable[] = [], more: PatchModule[] = []) =>
    capture({
      modules: [
        impulse(),
        { id: 'dly1', type: 'delay', params: { time: TIME, mix: 1, damping: 0, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        ...more,
      ],
      cables: [
        cable('brst1', 'gate', 'dly1', 'in'),
        cable('dly1', 'wet', 'scope0', 'in'),
        cable('dly1', 'out', 'scope1', 'in'),
        ...extra,
      ],
    })

  const single = run({ feedback: 0 })
  const once = clusters(single.scope0)
  check(
    'it repeats once, a Time knob later',
    once.length === 1 && Math.abs(once[0].at - SPACING) < 24,
    `${once.length} repeat(s) at ${once.map((c) => c.at).join(', ')}, expected ~${SPACING}`,
  )

  const fed = run({ feedback: 0.6 })
  const many = clusters(fed.scope0)
  const gaps = many.slice(1).map((c, i) => c.at - many[i].at)
  check(
    'feedback repeats it again at the same distance',
    many.length >= 3 && gaps.every((g) => Math.abs(g - SPACING) < 24),
    `${many.length} repeats, gaps ${gaps.join(', ')}`,
  )
  check(
    'and each repeat is quieter than the one before',
    many.every((c, i) => i === 0 || c.peak < many[i - 1].peak),
    many.map((c) => c.peak.toFixed(3)).join(' > '),
  )

  // The dry signal must not be on the wet jack, or sending the repeats
  // somewhere else would send the original with them.
  check(
    'the wet output carries no dry signal',
    clusters(single.scope0).every((c) => c.at > SPACING / 2),
  )

  // Time CV moves the read distance, which is what bends pitch on the way.
  const shifted = run(
    { feedback: 0, cvAmount: 1 },
    [cable('cv1', 'out1', 'dly1', 'cv')],
    [{ id: 'cv1', type: 'cv', params: { offset1: 1 } }],
  )
  const later = clusters(shifted.scope0)
  check(
    'Time CV moves the repeat',
    later.length >= 1 && later[0].at > once[0].at * 1.5,
    `${later[0]?.at} against ${once[0].at} with no CV`,
  )

  // Mix at zero has to be the signal untouched, or it cannot be patched in
  // and left alone until it is wanted.
  const off = run({ mix: 0, feedback: 0.6 })
  const bypass = capture({
    modules: [impulse(), { id: 'scope1', type: 'scope', params: {} }],
    cables: [cable('brst1', 'gate', 'scope1', 'in')],
  })
  check('mix at zero passes the dry signal alone', same(off.scope1, bypass.scope1))
}

console.log('\nspace')
{
  const run = (params: Record<string, number>) =>
    capture({
      modules: [
        impulse(),
        { id: 'spc1', type: 'reverb', params: { mix: 1, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
      ],
      cables: [
        cable('brst1', 'gate', 'spc1', 'in'),
        cable('spc1', 'l', 'scope0', 'in'),
        cable('spc1', 'r', 'scope1', 'in'),
      ],
    })

  const room = run({})
  const late = energy(room.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE)
  check(
    'a tail outlasts the sound that made it',
    late > 0,
    `energy ${late.toExponential(2)} in the last 1024 samples`,
  )
  check(
    'the repeats smear rather than staying countable',
    clusters(room.scope0, 0.02).length > 8,
    `${clusters(room.scope0, 0.02).length} distinct arrivals`,
  )

  // Two jacks carrying the same signal would be a mono reverb in stereo
  // clothing, and patching both into the mixer would just be louder.
  check('the two sides are not the same signal', !same(room.scope0, room.scope1))

  const short = run({ decay: 0.08 })
  const long = run({ decay: 12 })
  check(
    'Decay is how long the tail lasts',
    energy(long.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE) >
      energy(short.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE) * 4,
    `${energy(long.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE).toExponential(2)} against ${energy(short.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE).toExponential(2)}`,
  )

  // Size moves the first reflections, which is what makes a room small.
  const small = run({ size: 0 })
  const big = run({ size: 1 })
  const firstOf = (buf: Float32Array) => clusters(buf, 0.02)[0]?.at ?? -1
  check(
    'Size is how far away the walls are',
    firstOf(big.scope0) > firstOf(small.scope0),
    `first reflection at ${firstOf(small.scope0)} small, ${firstOf(big.scope0)} large`,
  )
}

console.log('\nresonator')
{
  /** The period the ringing settles into, found by autocorrelation. */
  function period(buf: Float32Array) {
    const from = SCOPE_CAPTURE - 2048
    let best = 0
    let bestLag = 0
    for (let lag = 16; lag < 512; lag++) {
      let sum = 0
      for (let i = from; i < SCOPE_CAPTURE - lag; i++) sum += buf[i] * buf[i + lag]
      if (sum > best) {
        best = sum
        bestLag = lag
      }
    }
    return bestLag
  }

  const run = (params: Record<string, number>, extra: Cable[] = [], more: PatchModule[] = []) =>
    capture({
      modules: [
        impulse(),
        { id: 'res1', type: 'res', params: { pitch: 480, decay: 4, damping: 0.2, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
        ...more,
      ],
      cables: [
        cable('brst1', 'gate', 'res1', 'in'),
        cable('res1', 'out', 'scope0', 'in'),
        ...extra,
      ],
    })

  // A pluck: one short burst in, and it rings at the note it is tuned to.
  const low = run({ pitch: 480 })
  const high = run({ pitch: 960 })
  check(
    'it rings at the pitch it is tuned to',
    Math.abs(period(low.scope0) - SR / 480) <= 2,
    `${period(low.scope0)} samples, expected ${SR / 480}`,
  )
  check(
    'and an octave up rings at half the period',
    Math.abs(period(high.scope0) - SR / 960) <= 2,
    `${period(high.scope0)} samples, expected ${SR / 960}`,
  )

  const quick = run({ decay: 0.02 })
  const slow = run({ decay: 8 })
  check(
    'Decay is how long it rings for',
    energy(slow.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE) >
      energy(quick.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE) * 10,
    `${energy(slow.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE).toExponential(2)} against ${energy(quick.scope0, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE).toExponential(2)}`,
  )

  // Damping takes the high end off each time round, so the tail gets duller
  // rather than just quieter.
  const bright = run({ damping: 0 })
  const dark = run({ damping: 0.9 })
  const brightness = (buf: Float32Array) => {
    let e = 0
    for (let i = SCOPE_CAPTURE - 1024; i < SCOPE_CAPTURE - 1; i++) {
      const d = buf[i + 1] - buf[i]
      e += d * d
    }
    return e / Math.max(1e-12, energy(buf, SCOPE_CAPTURE - 1024, SCOPE_CAPTURE))
  }
  check(
    'Damping takes the high end off the tail',
    brightness(dark.scope0) < brightness(bright.scope0),
    `${brightness(dark.scope0).toFixed(4)} against ${brightness(bright.scope0).toFixed(4)}`,
  )

  // Pitch CV, so it can be played rather than only tuned.
  const shifted = run(
    { pitch: 480, cvAmount: 1 },
    [cable('cv1', 'out1', 'res1', 'cv')],
    [{ id: 'cv1', type: 'cv', params: { offset1: 1 } }],
  )
  check(
    'CV moves it by whole octaves',
    Math.abs(period(shifted.scope0) - SR / 960) <= 2,
    `${period(shifted.scope0)} samples, expected ${SR / 960}`,
  )
}

// --- rewiring --------------------------------------------------------
console.log('\nrewiring')
{
  const base = triggerPatch()
  const rewired: Patch = {
    ...base,
    cables: [...base.cables, cable('osc2', 'out', 'mix1', 'in2')],
  }

  const compiledA = compile(base)
  const compiledB = compile(rewired)
  const engine = new GraphEngine(compiledA, SR, compiledA.params)
  engine.setGate(true)

  const HALF = 4096
  const before = new Float32Array(HALF)
  const after = new Float32Array(HALF)
  const bl = new Float32Array(128)
  const br = new Float32Array(128)

  for (let i = 0; i < HALF; i += 128) {
    engine.render(bl, br)
    before.set(bl, i)
  }

  engine.rebuild(compiledB, compiledB.params)

  for (let i = 0; i < HALF; i += 128) {
    engine.render(bl, br)
    after.set(bl, i)
  }

  check('rewired output is not silent or broken', stats(after).peak > 0.01 && stats(after).nan === 0)
  check('patching a cable changes the sound', Math.abs(stats(after).rms - stats(before).rms) > 1e-4)
}

{
  // The strict test of state preservation: rebuild with an unchanged patch and
  // the output must continue exactly as if nothing had happened. Comparing a
  // seam against a waveform's own step size is far too lenient -- a sawtooth's
  // reset edge is bigger than most clicks.
  const patch = triggerPatch()
  const compiled = compile(patch)
  const FRAMES = 8192
  const HALF = FRAMES / 2

  const run = (rebuildAtHalf: boolean) => {
    const engine = new GraphEngine(compiled, SR, compiled.params)
    engine.setGate(true)
    const out = new Float32Array(FRAMES)
    const bl = new Float32Array(128)
    const br = new Float32Array(128)
    for (let i = 0; i < FRAMES; i += 128) {
      if (rebuildAtHalf && i === HALF) engine.rebuild(compile(patch), compiled.params)
      engine.render(bl, br)
      out.set(bl, i)
    }
    return out
  }

  const reference = run(false)
  const interrupted = run(true)

  let firstDiff = -1
  for (let i = 0; i < FRAMES; i++) {
    if (reference[i] !== interrupted[i]) {
      firstDiff = i
      break
    }
  }
  check(
    'rebuilding an unchanged patch is inaudible',
    firstDiff === -1,
    firstDiff === -1 ? 'sample-identical' : `diverges at sample ${firstDiff} (rebuild at ${HALF})`,
  )

  // And a held gate must survive the rewire rather than dropping the note.
  check('a held gate survives a rebuild', stats(interrupted.subarray(HALF)).peak > 0.01)
}

// --- the jacks added after the fact -----------------------------------
/**
 * Ports added to modules that had been getting along without them.
 *
 * Each is here because a patch wanted it and could not have it: an
 * accelerating wobble, an envelope into a folder, a fixed-length pulse at a
 * clock's rate, something firing when an envelope finishes, and two signals
 * on one screen.
 */
console.log('\nLFO rate CV')
{
  const cycles = (params: Record<string, number>) => {
    const buf = capture(
      {
        modules: [
          { id: 'cv1', type: 'cv', params: {} },
          { id: 'lfo1', type: 'lfo', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('cv1', 'out1', 'lfo1', 'cv'), cable('lfo1', 'out', 'scope1', 'in')],
      },
      { params: { 'cv1.offset1': 1, 'lfo1.rate': 100, ...params } },
    ).scope1
    let crossings = 0
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 !== buf[i] <= 0) crossings++
    return crossings / 2
  }

  // Exponential, like every other rate in the rack: the amount is in octaves,
  // so one cable is the same interval wherever the knob is set.
  const base = cycles({ 'lfo1.cvAmount': 0 })
  const up = cycles({ 'lfo1.cvAmount': 1 })
  const down = cycles({ 'lfo1.cvAmount': -1 })
  check('an octave of Rate CV doubles the rate', Math.abs(up / base - 2) < 0.1, `${base} -> ${up} cycles`)
  check('and a negative amount halves it', Math.abs(down / base - 0.5) < 0.1, `${base} -> ${down} cycles`)
}

console.log('\nthe shapers take CV')
{
  const shapedWith = (type: string, params: Record<string, number>) =>
    capture(
      {
        modules: [
          { id: 'osc1', type: 'osc', params: { pitch: TONE, wave: 3 } },
          { id: 'cv1', type: 'cv', params: {} },
          { id: 'sut', type, params: {} },
          { id: 'scope0', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [
          cable('osc1', 'out', 'sut', 'in'),
          cable('cv1', 'out1', 'sut', 'cv'),
          cable('sut', 'out', 'scope0', 'in'),
        ],
      },
      { params: { 'cv1.offset1': 1, ...params } },
    ).scope0

  // A steady 1.0 into the jack, with the amount in octaves: the arithmetic
  // the filter's cutoff CV already does. What makes these worth having is an
  // envelope there instead, which is a shape that changes as a sound decays.
  const driveOff = harmonicRatio(shapedWith('drive', { 'sut.drive': 2 }), TONE)
  const driveOn = harmonicRatio(shapedWith('drive', { 'sut.drive': 2, 'sut.cvAmount': 3 }), TONE)
  check('Drive CV drives harder', driveOn > driveOff * 1.5, `${driveOff.toFixed(3)} -> ${driveOn.toFixed(3)}`)

  const foldOff = harmonicRatio(shapedWith('fold', { 'sut.fold': 1.5 }), TONE)
  const foldOn = harmonicRatio(shapedWith('fold', { 'sut.fold': 1.5, 'sut.cvAmount': 2 }), TONE)
  check('Fold CV folds further', foldOn > foldOff * 1.5, `${foldOff.toFixed(3)} -> ${foldOn.toFixed(3)}`)

  // The crusher's is a sample rate, so what moves is how often the held value
  // changes rather than how rich it is.
  const steps = (buf: Float32Array) => {
    let changes = 0
    for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) changes++
    return changes
  }
  const fast = steps(shapedWith('crush', { 'sut.rate': 8000 }))
  const slow = steps(shapedWith('crush', { 'sut.rate': 8000, 'sut.cvAmount': -3 }))
  check('Rate CV slows the crusher down', slow < fast / 4, `${fast} steps -> ${slow}`)
}

console.log('\nthe Trigger takes a cable')
{
  /** How long each run of high samples lasts. */
  const runs = (params: Record<string, number>) => {
    const buf = capture(
      {
        modules: [
          { id: 'clk1', type: 'clock', params: {} },
          { id: 'gate1', type: 'gate', params: {} },
          { id: 'scope1', type: 'scope', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('clk1', 'x1', 'gate1', 'trig'), cable('gate1', 'gate', 'scope1', 'in')],
      },
      { gate: false, params: { 'clk1.rate': 20, ...params } },
    ).scope1
    const lengths: number[] = []
    let run = 0
    for (const v of buf) {
      if (v > 0.5) run++
      else if (run > 0) {
        lengths.push(run)
        run = 0
      }
    }
    return lengths
  }

  // Held: the Trigger passes the clock on as it arrives, so the pulse is the
  // clock's Width -- a quarter of a 20 Hz period is 600 samples.
  const held = runs({ 'clk1.width': 0.25 })
  check('a clock into Trig plays the Trigger', held.length >= 1, `${held.length} pulses`)
  check('and held mode passes its shape', Math.abs(held[0] - 600) < 30, `${held[0]} samples of 600`)

  // Once: a fixed length whatever arrived, which is what the Clock cannot do
  // on its own. Its Width is a fraction of the period, so its pulses stretch
  // as the rate falls.
  const fixed = runs({ 'clk1.width': 0.25, 'gate1.mode': 1, 'gate1.length': 0.005 })
  const wider = runs({ 'clk1.width': 0.75, 'gate1.mode': 1, 'gate1.length': 0.005 })
  check('once mode puts out Length instead', Math.abs(fixed[0] - 240) < 3, `${fixed[0]} samples of 240`)
  check('whatever shape arrived', Math.abs(wider[0] - fixed[0]) < 3, `${fixed[0]} against ${wider[0]}`)
}

console.log('\nthe envelope says when it is done')
{
  const frames = capture(
    {
      modules: [
        { id: 'gate1', type: 'gate', params: {} },
        { id: 'env1', type: 'adsr', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        { id: 'scope2', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [
        cable('gate1', 'gate', 'env1', 'gate'),
        cable('env1', 'out', 'scope1', 'in'),
        cable('env1', 'end', 'scope1', 'in2'),
        cable('env1', 'inv', 'scope2', 'in'),
      ],
    },
    // Short enough to start and finish inside the 85 ms a scope keeps. An
    // exponential decay is not over when it sounds over: at a Decay of 10 ms
    // the stage runs for 115, because it ends where the level does.
    {
      gate: true,
      params: { 'env1.attack': 0.001, 'env1.decay': 0.002, 'env1.sustain': 0, 'env1.release': 0.002 },
    },
  )
  const out = frames.scope1
  const end = frames['scope1.b']
  const inv = frames.scope2

  // A pulse, not a level: End says the shape finished, and a shape finishes
  // once.
  let pulses = 0
  for (let i = 1; i < end.length; i++) if (end[i] > 0.5 && end[i - 1] <= 0.5) pulses++
  check('End fires once when the shape finishes', pulses === 1, `${pulses} pulses`)

  // On the sample the level lands on zero, not a moment later: the pulse is
  // the end of the shape, so the sample before it is the last one with any
  // shape left in it.
  const endAt = end.findIndex((v) => v > 0.5)
  check(
    'on the sample the level reaches zero',
    out[endAt] === 0 && out[endAt - 1] > 0,
    `${out[endAt - 1].toExponential(1)} then ${out[endAt]}`,
  )

  // Inv is the shape upside down, which is the one thing a bipolar amount
  // knob at the far end cannot ask for.
  let worst = 0
  for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] + inv[i] - 1))
  check('and Inv is one minus the level, sample for sample', worst < 1e-6, `worst ${worst.toExponential(1)}`)
}

console.log('\nthe scope has two channels')
{
  const rack = (linked: boolean) =>
    capture({
      modules: [
        { id: 'cv1', type: 'cv', params: {} },
        { id: 'lfo1', type: 'lfo', params: {} },
        { id: 'scope1', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: linked
        ? [cable('cv1', 'out1', 'scope1', 'in'), cable('lfo1', 'out', 'scope1', 'in2')]
        : [cable('cv1', 'out1', 'scope1', 'in')],
    })

  const both = rack(true)
  check('B is captured beside A', !!both['scope1.b'] && !same(both.scope1, both['scope1.b']))
  check('and A is what it always was', both.scope1.length === SCOPE_CAPTURE)
  // Nothing patched, nothing published: an empty channel is not a flat line
  // to draw and not sixteen kilobytes to post thirty times a second.
  check('an empty B publishes nothing at all', rack(false)['scope1.b'] === undefined)
}

// --- the sampler ------------------------------------------------------
/**
 * The one module that plays audio the rack did not make.
 *
 * Its test material is built here rather than loaded: a ramp, because a
 * position is easiest to read off a signal that is its own clock; a flat
 * level, because a fade is only visible against something that starts loud;
 * and a pair of constants, because two jacks are only two jacks if they carry
 * different things. All at 44.1 kHz against a 48 kHz rack, which is the ratio
 * a sampler gets wrong.
 */
console.log('\nthe sampler')
{
  const RATE = 44100
  const FRAMES = 8820 // 0.2 s

  const filled = (fn: (i: number) => number) => {
    const d = new Float32Array(FRAMES)
    for (let i = 0; i < FRAMES; i++) d[i] = fn(i)
    return d
  }

  const bank: SampleBank = new Map()
  bank.set('ramp', { channels: [filled((i) => i / (FRAMES - 1))], rate: RATE, frames: FRAMES })
  bank.set('flat', { channels: [filled(() => 1)], rate: RATE, frames: FRAMES })
  bank.set('sides', {
    channels: [filled(() => 0.5), filled(() => -0.5)],
    rate: RATE,
    frames: FRAMES,
  })

  const play = (sample: string, params: Record<string, number>, seconds = 0.5) =>
    render(
      {
        modules: [
          { id: 'smp1', type: 'sampler', params: {}, sample: { id: sample, name: `${sample}.wav` } },
          { id: 'rec1', type: 'rec', params: {} },
          { id: 'mix1', type: 'mixer', params: {} },
        ],
        cables: [cable('smp1', 'l', 'rec1', 'l'), cable('smp1', 'r', 'rec1', 'r')],
      },
      { frames: Math.round(SR * seconds), samples: bank, params },
    )

  const at = (buf: Float32Array, seconds: number) => buf[Math.round(SR * seconds)]

  // Nothing loaded is a state, not a failure: the module names a sample the
  // bank has never heard of and stays silent rather than reaching for it.
  const missing = render(
    {
      modules: [
        { id: 'smp1', type: 'sampler', params: {}, sample: { id: 'gone', name: 'gone.wav' } },
        { id: 'rec1', type: 'rec', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('smp1', 'l', 'rec1', 'l')],
    },
    { frames: 4096, samples: bank },
  )
  check('a missing sample is silence, not a crash', stats(missing.left).peak === 0)

  // A ramp read at the right speed is a clock: half way through the region is
  // half way up the ramp, and it gets there in the time the file lasts rather
  // than 8.8% early, which is what reading 44.1 kHz audio at 48 would do.
  const forward = play('ramp', {})
  check('the middle of the file is the middle of the ramp', Math.abs(at(forward.left, 0.1) - 0.5) < 0.01, at(forward.left, 0.1).toFixed(3))
  check('and it lasts as long as the file does', Math.abs(at(forward.left, 0.19) - 0.95) < 0.02 && at(forward.left, 0.25) === 0, `${at(forward.left, 0.19).toFixed(3)} then ${at(forward.left, 0.25)}`)

  // Speed is a ratio on top of that, so double it and the same position
  // arrives in half the time.
  const fast = play('ramp', { 'smp1.speed': 2 })
  check('Speed doubles the rate it reads at', Math.abs(at(fast.left, 0.05) - 0.5) < 0.01, at(fast.left, 0.05).toFixed(3))

  // Start moves where it begins; Length moves where it stops.
  // Measured against the forward pass rather than against a number worked out
  // by hand: at any instant before either runs out, starting half way in is
  // the same read plus half a file, and that holds however far the playhead
  // has already travelled by the time it is sampled.
  const late = play('ramp', { 'smp1.start': 0.5 })
  const offset = at(late.left, 0.05) - at(forward.left, 0.05)
  check('Start offsets the read by exactly that much of the file', Math.abs(offset - 0.5) < 0.01, offset.toFixed(3))
  const short = play('ramp', { 'smp1.length': 0.25 })
  check('Length stops it early', at(short.left, 0.04) > 0.1 && at(short.left, 0.08) === 0, `${at(short.left, 0.04).toFixed(2)} then ${at(short.left, 0.08)}`)

  // Reverse starts at the far end and walks back, which on a ramp is the one
  // reading that cannot be confused with the forward pass.
  const back = play('ramp', { 'smp1.direction': 1 })
  check('Reverse reads from the end', at(back.left, 0.01) > 0.9 && at(back.left, 0.19) < 0.1, `${at(back.left, 0.01).toFixed(2)} down to ${at(back.left, 0.19).toFixed(2)}`)

  // One-shot stops at the end of the region; loop does not.
  const once = play('flat', {})
  const looped = play('flat', { 'smp1.loop': 1 })
  check('a one-shot stops when the region ends', stats(once.left.subarray(Math.round(SR * 0.25))).peak === 0)
  check('and a loop keeps going', stats(looped.left.subarray(Math.round(SR * 0.25))).peak > 0.9)

  // End is a blip, once, when the one-shot finishes.
  const ended = render(
    {
      modules: [
        { id: 'smp1', type: 'sampler', params: {}, sample: { id: 'flat', name: 'flat.wav' } },
        { id: 'rec1', type: 'rec', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('smp1', 'end', 'rec1', 'l')],
    },
    { frames: Math.round(SR * 0.5), samples: bank },
  )
  let pulses = 0
  for (let i = 1; i < ended.left.length; i++) {
    if (ended.left[i] > 0.5 && ended.left[i - 1] <= 0.5) pulses++
  }
  check('End fires once, when the region runs out', pulses === 1, `${pulses} pulses`)

  // The fade is what stops a sampler clicking. Against a file that is flat at
  // full scale, no fade would put a step of 1.0 on the very first sample.
  const faded = play('flat', { 'smp1.fade': 0.02 })
  check('the fade eases it in rather than stepping', Math.abs(faded.left[0]) < 0.02, faded.left[0].toFixed(4))
  check('and it is up to full by the end of the fade', Math.abs(at(faded.left, 0.021) - 1) < 0.02, at(faded.left, 0.021).toFixed(3))

  // Two jacks carry two channels, and a mono file answers both with the same
  // signal rather than leaving one of them silent.
  const stereo = play('sides', {})
  check('a stereo file comes out of both jacks', Math.abs(at(stereo.left, 0.1) - 0.5) < 0.01 && Math.abs(at(stereo.right, 0.1) + 0.5) < 0.01, `${at(stereo.left, 0.1).toFixed(2)} / ${at(stereo.right, 0.1).toFixed(2)}`)
  const mono = play('ramp', {})
  check('and a mono file answers both the same', at(mono.left, 0.1) === at(mono.right, 0.1))
}

// --- voice and formant -------------------------------------------------
/**
 * A voice is checked on the things an ear names it by: the pitch it sings at,
 * the growl an octave under it, and the vowel the Formant shapes it into. A
 * formant bank with its table read one column over still makes a pleasant
 * noise, and it says the wrong vowel.
 */
console.log('\nvoice and formant')
{
  const voice = (params: Record<string, number>) =>
    capture({
      modules: [
        { id: 'vox1', type: 'voice', params: { jitter: 0, breath: 0, level: 1, ...params } },
        { id: 'scope0', type: 'scope', params: {} },
      ],
      cables: [cable('vox1', 'out', 'scope0', 'in')],
    }).scope0

  // Autocorrelation over the lags a voice at these pitches can have.
  const period = (buf: Float32Array) => {
    let best = -Infinity
    let bestLag = 0
    for (let lag = 40; lag < 1200; lag++) {
      let sum = 0
      for (let i = 0; i < buf.length - lag; i++) sum += buf[i] * buf[i + lag]
      if (sum > best) {
        best = sum
        bestLag = lag
      }
    }
    return bestLag
  }

  const sung = voice({ pitch: 150 })
  check(
    'the Voice sings at the pitch it is set to',
    Math.abs(period(sung) - SR / 150) <= 1,
    `${period(sung)} samples, expected ${SR / 150}`,
  )
  // With jitter off the drawn cycles are all the same, so the pulse carries
  // no subharmonic at all until Growl makes alternate ones differ.
  //
  // Windowed, unlike `powerAt`: a scope frame is only a few cycles of 75 Hz
  // long, and without a window the fundamental's leakage alone reads as a
  // subharmonic a sixth the size of a real one.
  const windowed = (buf: Float32Array, hz: number) => {
    let re = 0
    let im = 0
    for (let i = 0; i < buf.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (buf.length - 1))
      const t = (2 * Math.PI * hz * i) / SR
      re += buf[i] * w * Math.cos(t)
      im += buf[i] * w * Math.sin(t)
    }
    return Math.sqrt(re * re + im * im) / buf.length
  }
  const smooth = voice({ pitch: 150, growl: 0 })
  const growled = voice({ pitch: 150, growl: 1 })
  check(
    'Growl puts a subharmonic an octave under it',
    windowed(growled, 75) > windowed(smooth, 75) * 20,
    `${windowed(growled, 75).toExponential(2)} against ${windowed(smooth, 75).toExponential(2)}`,
  )
  const whisper = voice({ pitch: 150, breath: 1 })
  check(
    'Breath at full is a whisper: no pitch left in it',
    powerAt(whisper, 150) < powerAt(sung, 150) * 0.05,
    `${powerAt(whisper, 150).toExponential(2)} against ${powerAt(sung, 150).toExponential(2)}`,
  )

  // A saw at 100 Hz has a harmonic on every hundred, falling evenly, so
  // which of them come out loudest is the filter speaking and nothing else.
  const vowel = (params: Record<string, number>) =>
    capture({
      modules: [
        { id: 'osc1', type: 'osc', params: { pitch: 100, wave: 0 } },
        { id: 'fmt1', type: 'formant', params },
        { id: 'scope0', type: 'scope', params: {} },
      ],
      cables: [cable('osc1', 'out', 'fmt1', 'in'), cable('fmt1', 'out', 'scope0', 'in')],
    }).scope0

  const ah = vowel({ vowel: 2 })
  const ee = vowel({ vowel: 4 })
  check(
    'ah has its first formant high, near 650 Hz',
    powerAt(ah, 700) > powerAt(ah, 300) * 2,
    `700 Hz ${powerAt(ah, 700).toExponential(2)}, 300 Hz ${powerAt(ah, 300).toExponential(2)}`,
  )
  check(
    'ee has it low, near 290 Hz, and its second one up near 1.9 kHz',
    powerAt(ee, 300) > powerAt(ee, 700) * 2 && powerAt(ee, 1900) > powerAt(ee, 1100) * 2,
    `300 ${powerAt(ee, 300).toExponential(2)} / 700 ${powerAt(ee, 700).toExponential(2)}, ` +
      `1900 ${powerAt(ee, 1900).toExponential(2)} / 1100 ${powerAt(ee, 1100).toExponential(2)}`,
  )
  // Size 2 halves every formant: ah's first one moves from 650 to 325.
  const bigAh = vowel({ vowel: 2, size: 2 })
  check(
    'Size 2 is a head twice as big: every formant an octave down',
    powerAt(bigAh, 300) > powerAt(bigAh, 700) * 2,
    `300 Hz ${powerAt(bigAh, 300).toExponential(2)}, 700 Hz ${powerAt(bigAh, 700).toExponential(2)}`,
  )
}

// --- loudness, the EQ and the quantizer --------------------------------
/**
 * Loudness is checked against the standard's own reference points: a 1 kHz
 * sine at full scale in both channels is 0 LUFS give or take the weighting's
 * tenth of a decibel there, and every 20 dB down is 20 LU down. A meter that
 * read a few LU out would put every normalised take a few LU off target.
 */
console.log('\nloudness')
{
  const tone = (amp: number, hz: number, seconds: number) => {
    const n = Math.round(SR * seconds)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    return buf
  }
  const full = tone(1, 1000, 3)
  const quiet = tone(0.1, 1000, 3)
  const l0 = integratedLoudness(full, full, SR)
  const l20 = integratedLoudness(quiet, quiet, SR)
  check('a full-scale 1 kHz sine in both channels reads about 0 LUFS', Math.abs(l0) < 0.2, `${l0.toFixed(2)} LUFS`)
  check('and 20 dB down reads 20 LU down', Math.abs(l20 + 20) < 0.2, `${l20.toFixed(2)} LUFS`)
  const withTail = new Float32Array(SR * 6)
  withTail.set(quiet)
  const lt = integratedLoudness(withTail, withTail, SR)
  check('silence after a sound is gated out rather than averaged in', Math.abs(lt - l20) < 0.3, `${lt.toFixed(2)} LUFS`)
  const click = tone(0.5, 1000, 0.05)
  check('a sound shorter than a block is still measured', Number.isFinite(integratedLoudness(click, click, SR)))

  const target = normalize(quiet, quiet, SR, '-16')
  const after = integratedLoudness(target.left, target.right, SR)
  check('normalising to -16 LUFS lands on -16', Math.abs(after + 16) < 0.2, `${after.toFixed(2)} LUFS`)
  // Clicks: loud peaks, very little energy -- the kind of sound that cannot
  // reach a loudness target without clipping on the way.
  const clicks = new Float32Array(SR * 2)
  for (let i = 0; i < clicks.length; i += SR / 10) clicks[i] = 0.5
  const hot = normalize(clicks, clicks, SR, '-14')
  check('but never past -1 dB peak, and says so', hot.peak <= Math.pow(10, -1 / 20) + 1e-6 && hot.limited,
    `peak ${hot.peak.toFixed(3)}, limited ${hot.limited}`)
  const peaked = normalize(quiet, quiet, SR, 'peak')
  check('peak normalising brings the peak to -1 dB', Math.abs(peaked.peak - Math.pow(10, -1 / 20)) < 1e-4, peaked.peak.toFixed(4))
  const untouched = normalize(quiet, quiet, SR, 'off')
  check('and off leaves it alone', untouched.left === quiet && untouched.gain === 1)
}

console.log('\nEQ')
{
  const through = (params: Record<string, number>, hz: number) => {
    const out = capture({
      modules: [
        { id: 'osc1', type: 'osc', params: { pitch: hz, wave: 3 } },
        { id: 'eq1', type: 'eq', params },
        { id: 'scope0', type: 'scope', params: {} },
      ],
      cables: [cable('osc1', 'out', 'eq1', 'in'), cable('eq1', 'out', 'scope0', 'in')],
    }).scope0
    let peak = 0
    for (let i = out.length / 2; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
    return 20 * Math.log10(peak)
  }
  const flat = through({}, 1000)
  check('flat, it passes a tone unchanged', Math.abs(flat) < 0.2, `${flat.toFixed(2)} dB`)
  const lowCut = through({ lowGain: -12, lowFreq: 400 }, 60)
  check('the low shelf cuts the bottom', Math.abs(lowCut + 12) < 1, `${lowCut.toFixed(2)} dB at 60 Hz`)
  const lowSpared = through({ lowGain: -12, lowFreq: 400 }, 5000)
  check('and leaves the top alone', Math.abs(lowSpared) < 0.5, `${lowSpared.toFixed(2)} dB at 5 kHz`)
  const bell = through({ midGain: 6, midFreq: 1000 }, 1000)
  check('the mid bell lifts its own frequency by what it says', Math.abs(bell - 6) < 0.5, `${bell.toFixed(2)} dB`)
  const highBoost = through({ highGain: 9, highFreq: 2000 }, 12000)
  check('the high shelf lifts the top', Math.abs(highBoost - 9) < 1, `${highBoost.toFixed(2)} dB at 12 kHz`)
}

console.log('\nquantizer')
{
  const quantize = (params: Record<string, number>, level: number) => {
    const out = capture({
      modules: [
        { id: 'cv1', type: 'cv', params: { offset1: level, gain1: 1 } },
        { id: 'q1', type: 'quant', params },
        { id: 'scope0', type: 'scope', params: {} },
      ],
      cables: [cable('cv1', 'out1', 'q1', 'in'), cable('q1', 'out', 'scope0', 'in')],
    }).scope0
    return Math.round(out[out.length - 1] * 12 * 1000) / 1000
  }
  check('in C major, a C# goes to the nearest note, D', quantize({ root: 0, scale: 1 }, 1.4 / 12) === 2, String(quantize({ root: 0, scale: 1 }, 1.4 / 12)))
  check('a note already in the scale stays put', quantize({ root: 0, scale: 1 }, 7 / 12) === 7)
  check('chromatic rounds to the nearest semitone', quantize({ root: 0, scale: 0 }, 6.4 / 12) === 6)
  check('the root moves the scale: E from D# in E minor', quantize({ root: 4, scale: 2 }, 3.2 / 12) === 4, String(quantize({ root: 4, scale: 2 }, 3.2 / 12)))
  check('and it works below the root too', quantize({ root: 0, scale: 1 }, -1.2 / 12) === -1, String(quantize({ root: 0, scale: 1 }, -1.2 / 12)))
}

// --- dust --------------------------------------------------------------
console.log('\ndust')
{
  const dust = (params: Record<string, number>, port = 'out') =>
    capture({
      modules: [
        { id: 'd1', type: 'dust', params },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('d1', port, 'scope0', 'in')],
    }, { frames: SR }).scope0

  // A scope frame is 4096 samples, 85 ms: at 2000 a second that is about 170
  // impulses, which is enough for the average to mean something.
  const expected = (2000 * SCOPE_CAPTURE) / SR
  const hits = risingEdges(dust({ density: 2000, decay: 0.0002 }, 'trig')).length
  check('Density is the average number of impulses a second', Math.abs(hits - expected) < expected * 0.3,
    `${hits} in a frame, expected about ${expected.toFixed(0)}`)

  const sparse = risingEdges(dust({ density: 50 }, 'trig')).length
  check('and fewer at a lower density', sparse < hits / 10, `${sparse} against ${hits}`)

  // Spread at zero: every impulse starts at full scale, one way or the other.
  const even = dust({ density: 400, spread: 0, decay: 0.0002 })
  const starts = even.filter((v, i) => i > 0 && Math.abs(v) > 0.99 && Math.abs(even[i - 1]) < 0.5).length
  check('with Spread at zero every impulse is full scale', starts > 10, `${starts} full-scale onsets`)

  const click = dust({ density: 400, tone: 0, decay: 0.02 })
  const hiss = dust({ density: 400, tone: 1, decay: 0.02 })
  check('Tone changes the sound', !same(click, hiss))
  // Same seed, same draws: the impulses land in the same places either way.
  check('and not where the impulses land',
    same(dust({ density: 400, tone: 0 }, 'trig'), dust({ density: 400, tone: 1 }, 'trig')))

  const short = stats(dust({ density: 200, decay: 0.0002 })).rms
  const long = stats(dust({ density: 200, decay: 0.05 })).rms
  check('a longer Decay is more sound per impulse', long > short * 3, `${short.toFixed(3)} -> ${long.toFixed(3)}`)
}

// --- drunk -------------------------------------------------------------
console.log('\ndrunk')
{
  const walk = (params: Record<string, number>, port = 'out', frames = SR) =>
    capture({
      modules: [
        { id: 'w1', type: 'drunk', params },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('w1', port, 'scope0', 'in')],
    }, { frames }).scope0

  const fast = walk({ rate: 50, step: 1, smooth: 0 })
  const s = stats(fast)
  check('it stays between the walls', s.peak <= 1 && s.nan === 0, `peak ${s.peak.toFixed(3)}`)

  // Smooth at zero: a staircase, one value per step.
  const stairs = held(fast).length
  const steps = (50 * SCOPE_CAPTURE) / SR
  check('Smooth at zero steps like a sample and hold', Math.abs(stairs - steps) <= 2, `${stairs} values, ${steps.toFixed(1)} steps`)
  check('Smooth at one glides', distinctValues(walk({ rate: 50, step: 1, smooth: 1 })) > 1000)

  // Small strides: no two neighbouring steps are further apart than Step.
  const small = held(walk({ rate: 50, step: 0.05, smooth: 0 }))
  let widest = 0
  for (let i = 1; i < small.length; i++) widest = Math.max(widest, Math.abs(small[i] - small[i - 1]))
  check('each stride is at most Step', widest <= 0.05 + 1e-6, `widest ${widest.toFixed(4)}`)

  // Pull at one forgets where it was: every step lands within Step of zero.
  const pulled = walk({ rate: 50, step: 0.2, smooth: 0, pull: 1 })
  check('full Pull keeps it within a stride of the middle', stats(pulled).peak <= 0.2 + 1e-6, `peak ${stats(pulled).peak.toFixed(3)}`)

  const uni = walk({ rate: 50, step: 1, smooth: 0 }, 'uni')
  check('Uni is the same walk between zero and one', uni.every((v, i) => Math.abs(v - (0.5 + 0.5 * fast[i])) < 1e-6))

  // A patched clock takes over: one step per tick, whatever Rate says.
  const clocked = capture({
    modules: [
      { id: 'c1', type: 'clock', params: { rate: 40 } },
      { id: 'w1', type: 'drunk', params: { rate: 0.05, step: 1, smooth: 0 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'scope1', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('c1', 'x1', 'w1', 'clock'), cable('w1', 'trig', 'scope0', 'in'), cable('c1', 'x1', 'scope1', 'in')],
  }, { frames: SR })
  const ticks = risingEdges(clocked.scope1).length
  const walked = risingEdges(clocked.scope0).length
  check('a patched Clock steps it on every tick', ticks > 0 && walked === ticks, `${walked} steps for ${ticks} ticks`)
}

// --- macro -------------------------------------------------------------
console.log('\nmacro')
{
  const lane = (params: Record<string, number>, cv?: number) => {
    const modules: PatchModule[] = [
      { id: 'm1', type: 'macro', params },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ]
    const cables = [cable('m1', 'out1', 'scope0', 'in')]
    if (cv !== undefined) {
      modules.push({ id: 'cv1', type: 'cv', params: { offset1: cv } })
      cables.push(cable('cv1', 'out1', 'm1', 'cv'))
    }
    const out = capture({ modules, cables }).scope0
    return out[out.length - 1]
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4

  check('by default a lane is the knob', near(lane({ amount: 0.3 }), 0.3), String(lane({ amount: 0.3 })))
  check('From and To are its ends', near(lane({ amount: 0.25, from1: 1, to1: -1 }), 0.5), String(lane({ amount: 0.25, from1: 1, to1: -1 })))
  check('below Start it holds at From', near(lane({ amount: 0.4, start1: 0.5, from1: -0.5 }), -0.5))
  check('past End it holds at To', near(lane({ amount: 0.8, end1: 0.5, to1: 0.7 }), 0.7))
  check('inside the window it travels the whole way', near(lane({ amount: 0.75, start1: 0.5, end1: 1 }), 0.5))
  check('a positive Curve is slow to leave From', near(lane({ amount: 0.5, curve1: 1 }), Math.pow(0.5, 5)), String(lane({ amount: 0.5, curve1: 1 })))
  check('a negative Curve is quick to', near(lane({ amount: 0.5, curve1: -1 }), 1 - Math.pow(0.5, 5)))
  check('the Amount jack adds to the knob', near(lane({ amount: 0.2 }, 0.3), 0.5), String(lane({ amount: 0.2 }, 0.3)))
  check('and the sum stops at the top of the travel', near(lane({ amount: 0.8 }, 0.9), 1))
}

// --- multimode filter --------------------------------------------------
console.log('\nmultimode filter')
{
  const through = (hz: number, params: Record<string, number>) => {
    const out = capture({
      modules: [
        { id: 'osc1', type: 'osc', params: { pitch: hz, wave: 3, envAmount: 0 } },
        { id: 'sut', type: 'svf', params },
        { id: 'scope0', type: 'scope', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [cable('osc1', 'out', 'sut', 'in'), cable('sut', 'out', 'scope0', 'in')],
    }, { frames: SR / 2 }).scope0
    // A sine's RMS is its peak over root two; this is the gain.
    return stats(out).rms * Math.SQRT2
  }
  const db = (g: number) => 20 * Math.log10(g)

  const lp = { cutoff: 1000, resonance: 0, mode: 0 }
  check('lowpass passes the lows', db(through(100, lp)) > -1, `${db(through(100, lp)).toFixed(1)} dB`)
  check('and cuts the highs at twelve a octave', db(through(8000, lp)) < -30, `${db(through(8000, lp)).toFixed(1)} dB`)
  const hp = { ...lp, mode: 2 }
  check('highpass is the other way round', db(through(100, hp)) < -30 && db(through(8000, hp)) > -1)
  const notch = { ...lp, mode: 3 }
  check('the notch takes its frequency out', db(through(1000, notch)) < -30, `${db(through(1000, notch)).toFixed(1)} dB`)
  check('and leaves the rest', db(through(100, notch)) > -1 && db(through(8000, notch)) > -1)
  const bp = { cutoff: 1000, resonance: 1, mode: 1 }
  check('the bandpass is unity at its centre, however narrow', Math.abs(db(through(1000, bp))) < 0.5, `${db(through(1000, bp)).toFixed(2)} dB`)
  const peak0 = { cutoff: 1000, resonance: 0, mode: 4 }
  const peak1 = { cutoff: 1000, resonance: 1, mode: 4 }
  check('peak at no Res is the dry signal', Math.abs(db(through(1000, peak0))) < 0.2)
  check('and at full Res lifts its band', db(through(1000, peak1)) > 12, `${db(through(1000, peak1)).toFixed(1)} dB`)

  // The drawing is the filter: the same curve the panel shows is the gain
  // measured through the module.
  let worstDb = 0
  for (const mode of [0, 1, 2, 3, 4]) {
    for (const hz of [150, 700, 1000, 2500]) {
      const params = { cutoff: 1000, resonance: 0.6, mode }
      const drawn = db(svfResponse(hz, 1000, 0.6, mode, SR))
      const heard = db(through(hz, params))
      if (drawn > -40) worstDb = Math.max(worstDb, Math.abs(drawn - heard))
    }
  }
  check('the drawn response is the measured one', worstDb < 0.5, `worst ${worstDb.toFixed(2)} dB apart`)

  // A comb rings at its pitch: fed noise, the loudest harmonic is the tuning.
  const comb = (mode: number) => capture({
    modules: [
      { id: 'n1', type: 'noise', params: {} },
      { id: 'sut', type: 'svf', params: { cutoff: 300, resonance: 1, mode } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('n1', 'out', 'sut', 'in'), cable('sut', 'out', 'scope0', 'in')],
  }, { frames: SR / 2 }).scope0
  const pos = comb(5)
  check('comb+ rings at Cutoff', powerAt(pos, 300) > 3 * powerAt(pos, 450), `${powerAt(pos, 300).toFixed(4)} vs ${powerAt(pos, 450).toFixed(4)}`)
  const neg = comb(6)
  check('comb− rings an octave under it', powerAt(neg, 150) > 3 * powerAt(neg, 300), `${powerAt(neg, 150).toFixed(4)} vs ${powerAt(neg, 300).toFixed(4)}`)
}

// --- chorus ------------------------------------------------------------
console.log('\nchorus')
{
  const dry = shaped('chorus', { mix: 0 }, 'l')
  const osc = capture({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: TONE, wave: 3, envAmount: 0 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'scope0', 'in')],
  }).scope0
  check('with Mix at zero it is the dry signal', same(dry, osc))

  for (const [mode, name] of [[0, 'chorus'], [1, 'flanger'], [2, 'phaser']] as const) {
    const l = shaped('chorus', { mode, rate: 2, depth: 1 }, 'l')
    const r = shaped('chorus', { mode, rate: 2, depth: 1 }, 'r')
    const s = stats(l)
    check(`${name}: sound comes out, and the sides differ`, s.nan === 0 && s.peak > 0.1 && !same(l, r))
  }

  // The flanger's comb: with the delay still and a millisecond long, 500 Hz
  // is half a cycle late and cancels, where 1 kHz arrives in step and adds.
  const flanged = (hz: number) => stats(capture({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: hz, wave: 3, envAmount: 0 } },
      // log2(10) / 6.3 is the Center that puts the delay at one millisecond.
      { id: 'sut', type: 'chorus', params: { mode: 1, depth: 0, center: Math.log2(10) / 6.3, mix: 0.5 } },
      { id: 'scope0', type: 'scope', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [cable('osc1', 'out', 'sut', 'in'), cable('sut', 'l', 'scope0', 'in')],
  }, { frames: SR / 4 }).scope0).rms
  check('the flanger notches where the delay is half a cycle', flanged(500) < 0.05 && flanged(1000) > 0.6,
    `${flanged(500).toFixed(3)} at 500 Hz, ${flanged(1000).toFixed(3)} at 1 kHz`)
}

// --- determinism -----------------------------------------------------
console.log('\ndeterminism')
{
  const a = render(triggerPatch(), { frames: 8192 })
  const b = render(triggerPatch(), { frames: 8192 })
  let same = true
  for (let i = 0; i < a.left.length; i++) {
    if (a.left[i] !== b.left[i]) {
      same = false
      break
    }
  }
  check('identical patches render identical samples', same)
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
