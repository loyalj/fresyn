/**
 * Builds every patch MANUAL.md teaches, following its steps, and checks the
 * result does what the manual says it does.
 *
 * A tutorial that no longer makes the sound it promises is worse than no
 * tutorial: the reader assumes they mis-clicked. Each patch here starts from
 * the same stock rack the reader gets from New, and is wired with the same
 * `connect` and `addModule` the rack UI calls, so a moved default, a renamed
 * port or a changed cable rule fails here before it confuses anybody.
 *
 * Run with: npm run check:manual
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPatch } from '../src/audio/render'
import { disconnectAt } from '../src/patch/edit'
import { defOf, MODULE_DEFS } from '../src/patch/defs'
import { helpFor, parseKnobHelp } from '../src/patch/knobHelp'
import { add, LIBRARY, templateById, wire } from '../src/patch/library'
import { formatValue } from '../src/patch/param'
import type { Patch } from '../src/patch/types'

const SR = 48000

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

/**
 * A template from the shipped library, which is where these racks live now.
 *
 * The patches below used to be built here, which meant the app's library and
 * the checks that prove the library works were two copies of the same fifteen
 * racks. They are one copy now: everything this file renders and listens to
 * is exactly what the Patch > Library menu hands the user.
 */
const built = new Set<string>()

function fromLibrary(id: string) {
  const template = templateById(id)
  if (!template) throw new Error(`no template called "${id}"`)
  built.add(id)
  return template.build()
}

function unwire(patch: Patch, ref: string): Patch {
  const [module, port] = ref.split('.')
  const next = disconnectAt(patch, { module, port })
  if (next === patch) throw new Error(`nothing was patched at "${ref}"`)
  return next
}

/** Which tutorial is being built, so its knob table can be checked. */
let chapter = ''
/** Every `module | knob | value` row a tutorial actually rendered with. */
const rendered = new Map<string, Set<string>>()

function tutorial(number: string, title: string) {
  chapter = number
  rendered.set(number, rendered.get(number) ?? new Set())
  console.log(`\n${number}. ${title}`)
}

/**
 * Knob settings, keyed the way the manual prints them. Checked against the
 * module definitions so a parameter the manual invents fails here, and
 * recorded as the panel would read it so the manual's tables can be checked
 * against what was really rendered.
 */
function knobs(patch: Patch, values: Record<string, number>): Record<string, number> {
  const byId = new Map(patch.modules.map((m) => [m.id, m]))
  for (const key of Object.keys(values)) {
    const id = key.slice(0, key.lastIndexOf('.'))
    const param = key.slice(key.lastIndexOf('.') + 1)
    const m = byId.get(id)
    if (!m) throw new Error(`the manual sets a knob on "${id}", which is not in the rack`)
    const spec = defOf(m.type).params.find((p) => p.id === param)
    if (!spec) throw new Error(`${m.type} has no parameter "${param}"`)
    const v = values[key]
    if (v < spec.min || v > spec.max) {
      throw new Error(`${key} = ${v} is outside ${spec.min}..${spec.max}`)
    }
    rendered.get(chapter)?.add(`${id} | ${spec.label} | ${formatValue(spec, v)}`)
  }
  return values
}

interface Shape {
  peak: number
  rms: number
  nan: number
}

function stats(buf: Float32Array, from = 0, to = buf.length): Shape {
  let peak = 0
  let sumSq = 0
  let nan = 0
  for (let i = from; i < to; i++) {
    const s = buf[i]
    if (!Number.isFinite(s)) {
      nan++
      continue
    }
    const a = s < 0 ? -s : s
    if (a > peak) peak = a
    sumSq += s * s
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, to - from)), nan }
}

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** Zero crossings per second: a cheap stand-in for "how high does it sound". */
function brightness(buf: Float32Array, from: number, to: number): number {
  let crossings = 0
  for (let i = from + 1; i < to && i < buf.length; i++) {
    if (buf[i - 1] <= 0 !== buf[i] <= 0) crossings++
  }
  return (crossings * SR) / Math.max(1, to - from)
}

const at = (seconds: number) => Math.round(SR * seconds)

function render(patch: Patch, values: Record<string, number>, gateSeconds: number, duration: number) {
  return renderPatch(patch, values, { sampleRate: SR, duration, gateSeconds, seed: 7 })
}

/** Every one-shot has to be audible, clean, and actually stop. */
function oneShot(
  name: string,
  patch: Patch,
  values: Record<string, number>,
  gateSeconds: number,
  duration: number,
) {
  const out = render(patch, values, gateSeconds, duration)
  const whole = stats(out.left)
  check(`${name}: makes a sound`, whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check(`${name}: no NaN`, whole.nan === 0)
  check(`${name}: does not clip`, whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  // A trimmed length shorter than the window only happens if the tail really
  // fell to silence, so this catches a note that never releases.
  check(`${name}: decays to silence`, out.seconds < duration - 0.05, `${out.seconds.toFixed(2)}s`)
  return out
}

/** A knob baked into the patch, as the manual's build step sets it. */
/**
 * Roughly how high the sound reads, sampled across the render.
 *
 * Zero crossings are a coarse pitch proxy, but a sustained sound that sweeps
 * has to be measured in slices rather than as a whole: averaged over three
 * seconds a siren and a steady tone look identical.
 */
function pitchRange(buf: Float32Array, seconds: number, slices = 12) {
  const step = Math.floor((seconds * SR) / slices)
  let low = Infinity
  let high = 0
  for (let i = 0; i + step < buf.length; i += step) {
    const f = brightness(buf, i, i + step)
    if (f < low) low = f
    if (f > high) high = f
  }
  return { low: low === Infinity ? 0 : low, high }
}

/**
 * Separate bursts of sound.
 *
 * The floor is a fraction of the sound's own peak rather than an absolute
 * level, because a run of notes that dips to a tenth between them is still
 * heard as separate notes -- it is the shape that makes them blips, not
 * whether they reach digital silence.
 */
function blips(buf: Float32Array, seconds: number, window = 0.01, floor = 0.3) {
  const w = at(window)
  const level = stats(buf).peak * floor
  let bursts = 0
  let wasQuiet = true
  for (let i = 0; i + w < at(seconds) && i + w < buf.length; i += w) {
    const loud = stats(buf, i, i + w).peak > level
    if (loud && wasQuiet) bursts++
    wasQuiet = !loud
  }
  return bursts
}


/** How much of one exact frequency is present, for spotting an FM partial. */
function toneAt(buf: Float32Array, hz: number, from: number, to: number) {
  let re = 0
  let im = 0
  const end = Math.min(to, buf.length)
  for (let i = from; i < end; i++) {
    const t = (2 * Math.PI * hz * i) / SR
    re += buf[i] * Math.cos(t)
    im += buf[i] * Math.sin(t)
  }
  return Math.sqrt(re * re + im * im) / Math.max(1, end - from)
}

/**
 * The strongest repeating period in a window, as a frequency.
 *
 * Zero crossings are enough for "does this get brighter", but they cannot
 * find a pitch underneath a noisy excitation -- a resonator rung by a filtered
 * click is mostly click, and counting crossings measures the click. Looking
 * for what actually repeats finds the ringing instead.
 */
function ringPitch(buf: Float32Array, from: number, to: number) {
  let best = 0
  let bestLag = 0
  for (let lag = 12; lag < 700; lag++) {
    let sum = 0
    for (let i = from; i + lag < to && i + lag < buf.length; i++) sum += buf[i] * buf[i + lag]
    if (sum > best) {
      best = sum
      bestLag = lag
    }
  }
  return bestLag ? SR / bestLag : 0
}

/**
 * The fraction of a window spent above zero, which is what pulse width
 * means. Measured with the filter opened right up, because the point is what
 * the oscillator is doing and a filter would smear it.
 */
function dutyRange(buf: Float32Array, from: number, window = 0.025) {
  const w = at(window)
  let low = 1
  let high = 0
  for (let i = at(from); i + w < buf.length; i += w) {
    let up = 0
    for (let j = i; j < i + w; j++) if (buf[j] > 0) up++
    const d = up / w
    if (d < low) low = d
    if (d > high) high = d
  }
  return { low, high, spread: high - low }
}

/**
 * How much of a window is high frequencies, as the level of its slope against
 * the level of the signal. A saw at a steady pitch through an opening filter
 * crosses zero the same number of times throughout -- the fundamental decides
 * that -- so counting crossings cannot hear it brighten. The slope can: it is
 * the treble end, weighted up.
 */
function treble(buf: Float32Array, from: number, to: number) {
  let slope = 0
  let level = 0
  for (let i = from + 1; i < to && i < buf.length; i++) {
    const d = buf[i] - buf[i - 1]
    slope += d * d
    level += buf[i] * buf[i]
  }
  return Math.sqrt(slope / Math.max(1e-12, level))
}

/** Rising edges of loudness in a window: separate drops, clicks, strikes. */
function events(buf: Float32Array, from: number, to: number, window = 0.002, floor = 0.3) {
  const w = at(window)
  const level = stats(buf, from, to).peak * floor
  let count = 0
  let wasQuiet = true
  for (let i = from; i + w < to && i + w < buf.length; i += w) {
    const loud = stats(buf, i, i + w).peak > level
    if (loud && wasQuiet) count++
    wasQuiet = !loud
  }
  return count
}

// --- the smallest rack the manual promises ---------------------------
/**
 * "The smallest rack that works is an Oscillator and a Mixer." A reader who
 * clears the rack and follows that has no recorder either, so this renders
 * the way they would hear it -- through the speaker bus, with nothing
 * patched to a tap.
 */
console.log('\n0. an oscillator and a mixer')
{
  const patch: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [],
  }
  const wired = wire(patch, 'osc1.out -> mix1.in1')
  // Env Amt at zero, so it drones. There is no Trigger in a rack of two and
  // nothing else to fire one: an oscillator carrying its own envelope with
  // nothing to open it is silence, which is not what "the smallest rack that
  // works" is claiming.
  const values = knobs(wired, { 'osc1.pitch': 220, 'osc1.envAmount': 0 })
  const out = render(wired, values, 0.05, 1)
  const whole = stats(out.left)
  check('two modules and a cable make a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('it is clean', whole.nan === 0 && whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  check('and it renders without a recorder', out.seconds > 0, `${out.seconds.toFixed(2)}s`)
}

// --- the tutorial rack ------------------------------------------------
console.log('\nthe tutorial rack')
{
  // On the shelf so a reader can start the tutorials without building the
  // bench by hand, and kept whole: its idle units are what they patch.
  const { patch, values: preset } = fromLibrary('bench')
  const ids = patch.modules.map((m) => m.id).sort().join(',')
  const expected = ['env1', 'gate1', 'lfo1', 'lpf1', 'mix1', 'noise1', 'osc1', 'osc2', 'vca1'].join(',')
  check('it holds every unit the tutorials name', ids === expected, ids)

  const out = render(patch, knobs(patch, preset), 0.05, 1)
  const whole = stats(out.left)
  check('and it sounds when Space is pressed', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('cleanly', whole.nan === 0 && whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
}

// --- 1. laser --------------------------------------------------------
tutorial('1', 'laser zap')
{
  const { patch, values: preset } = fromLibrary('laser')
  const values = knobs(patch, preset)

  const out = oneShot('descending', patch, values, 0.02, 2)
  const head = brightness(out.left, 0, at(0.02))
  const tail = brightness(out.left, at(0.1), at(0.16))
  check('descending: the pitch falls', head > tail * 2, `${head.toFixed(0)} -> ${tail.toFixed(0)} Hz`)

  // The variation: the same envelope, inverted through the CV utility.
  let rising = add(patch, 'cv')
  rising = unwire(rising, 'osc1.fm')
  rising = wire(rising, 'env1.out -> cv1.in1', 'cv1.out1 -> osc1.fm')
  const risingValues = knobs(rising, { ...values, 'cv1.gain1': -1, 'cv1.offset1': 1 })

  const up = oneShot('rising', rising, risingValues, 0.02, 2)
  const upHead = brightness(up.left, 0, at(0.02))
  const upTail = brightness(up.left, at(0.1), at(0.16))
  check('rising: the pitch climbs', upTail > upHead * 2, `${upHead.toFixed(0)} -> ${upTail.toFixed(0)} Hz`)

  // The second variation: the keyboard plays it. FM takes one cable, so the
  // envelope and the keyboard have to be added together before they get
  // there -- which is what the CV utility's Sum output is for.
  let played = add(add(patch, 'keys'), 'cv')
  played = unwire(played, 'osc1.fm')
  played = wire(
    played,
    'key1.gate -> env1.gate',
    'env1.out -> cv1.in1',
    'key1.pitch -> cv1.in2',
    'cv1.sum -> osc1.fm',
  )
  const playedValues = (note: number) =>
    knobs(played, {
      ...values,
      'osc1.fmAmount': 1,
      'cv1.gain1': 2,
      'cv1.gain2': 1,
      'key1.note': note,
    })

  const bottom = oneShot('played', played, playedValues(0), 0.02, 2)
  check(
    'played: it still falls',
    brightness(bottom.left, 0, at(0.02)) > brightness(bottom.left, at(0.1), at(0.16)) * 2,
    `${brightness(bottom.left, 0, at(0.02)).toFixed(0)} -> ${brightness(bottom.left, at(0.1), at(0.16)).toFixed(0)} Hz`,
  )

  // An octave up the keyboard is an octave up the shot, all the way through.
  const octave = render(played, playedValues(12), 0.02, 2)
  const low = brightness(bottom.left, 0, at(0.2))
  const high = brightness(octave.left, 0, at(0.2))
  check(
    'played: a key an octave up shoots an octave higher',
    high > low * 1.7 && high < low * 2.4,
    `${low.toFixed(0)} -> ${high.toFixed(0)} Hz`,
  )
}

// --- 2. footstep -----------------------------------------------------
tutorial('2', 'footstep')
{
  const { patch, values: preset } = fromLibrary('footstep')

  check(
    'the new cable replaced the old one',
    patch.cables.filter((c) => c.to.module === 'lpf1' && c.to.port === 'in').length === 1,
  )
  const values = knobs(patch, preset)

  const out = oneShot('footstep', patch, values, 0.01, 1)
  const head = brightness(out.left, 0, at(0.01))
  const tail = brightness(out.left, at(0.05), at(0.09))
  check('footstep: the filter closes as it decays', head > tail, `${head.toFixed(0)} -> ${tail.toFixed(0)} Hz`)
}

// --- 3. computer chatter ---------------------------------------------
tutorial('3', 'computer chatter')
{
  const { patch, values: preset } = fromLibrary('chatter')
  const values = knobs(patch, preset)

  // Free-running: it needs no trigger at all, so the render just listens.
  // Held for the whole render: Space is what lets this through now, and a
  // gate open for a millisecond would record the release and nothing else.
  const out = render(patch, values, 1.5, 1.5)
  const whole = stats(out.left)
  check('chatter: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('chatter: no NaN', whole.nan === 0)

  const window = at(0.01)
  let quiet = 0
  let bursts = 0
  let wasQuiet = true
  for (let i = 0; i + window < at(1.2); i += window) {
    const loud = stats(out.left, i, i + window).peak > 0.02
    if (!loud) quiet++
    if (loud && wasQuiet) bursts++
    wasQuiet = !loud
  }
  // 9 Hz across 1.2 s is about eleven ticks.
  check('chatter: it blips rather than drones', bursts >= 8 && bursts <= 14, `${bursts} blips`)
  check('chatter: there is silence between them', quiet > 20, `${quiet} quiet windows`)

  // The variation: a slew turns the steps into glides.
  let glide = add(patch, 'slew')
  glide = unwire(glide, 'cv1.in1')
  glide = wire(glide, 'sh1.out1 -> slew1.in', 'slew1.out -> cv1.in1')
  const glideValues = knobs(glide, {
    ...values,
    'slew1.rise': 0.08,
    'slew1.fall': 0.08,
    'slew1.shape': 1,
    'osc1.wave': 3,
    'osc1.envAmount': 0,
  })
  const sung = render(glide, glideValues, 1, 1)
  check('glide: it sings continuously', stats(sung.left, at(0.5)).rms > 0.05, `rms=${stats(sung.left, at(0.5)).rms.toFixed(3)}`)
}

// --- 4. wind ---------------------------------------------------------
tutorial('4', 'wind')
{
  const { patch, values: preset } = fromLibrary('wind')
  const values = knobs(patch, preset)

  const out = render(patch, values, 3, 3)
  const whole = stats(out.left)
  check('wind: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('wind: no NaN', whole.nan === 0)
  check('wind: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)

  const tail = stats(out.left, at(2.5), at(2.9))
  check('wind: it keeps blowing', tail.rms > 0.02, `rms=${tail.rms.toFixed(3)}`)

  // It has to move, or it is only filtered noise.
  const a = brightness(out.left, at(0.6), at(0.9))
  const b = brightness(out.left, at(1.8), at(2.1))
  check('wind: the tone wanders', Math.abs(a - b) / Math.max(a, b) > 0.05, `${a.toFixed(0)} vs ${b.toFixed(0)} Hz`)
}

// --- 5. explosion ----------------------------------------------------
tutorial('5', 'explosion')
{
  const { patch, values: preset } = fromLibrary('explosion')
  const values = knobs(patch, preset)

  const out = oneShot('explosion', patch, values, 0.05, 4)
  check('explosion: it is long', out.seconds > 0.8, `${out.seconds.toFixed(2)}s`)

  // Both layers have to carry their weight: muting either must still leave a
  // sound, or the patch is really only teaching one of them.
  const lowOnly = render(patch, { ...values, 'mix1.level1': 0 }, 0.05, 4)
  const noiseOnly = render(patch, { ...values, 'mix1.level2': 0 }, 0.05, 4)
  check('explosion: the low layer sounds alone', stats(lowOnly.left).peak > 0.05, `peak=${stats(lowOnly.left).peak.toFixed(3)}`)
  check('explosion: the noise layer sounds alone', stats(noiseOnly.left).peak > 0.05, `peak=${stats(noiseOnly.left).peak.toFixed(3)}`)
  check(
    'explosion: the low layer drops in pitch',
    brightness(lowOnly.left, 0, at(0.05)) > brightness(lowOnly.left, at(0.5), at(0.7)),
  )
}

// --- 6. siren --------------------------------------------------------
tutorial('6', 'siren')
{
  const { patch, values: preset } = fromLibrary('siren')
  const values = knobs(patch, preset)

  const out = render(patch, values, 3, 3)
  const whole = stats(out.left)
  check('siren: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('siren: no NaN', whole.nan === 0)
  const tail = stats(out.left, at(2.5), at(3)).rms
  check('siren: it never stops', tail > 0.05, `rms=${tail.toFixed(3)}`)
  const sweep = pitchRange(out.left, 3)
  check(
    'siren: the pitch sweeps',
    sweep.high > sweep.low * 1.5,
    `${sweep.low.toFixed(0)} - ${sweep.high.toFixed(0)} Hz`,
  )
}

// --- 7. water drop ---------------------------------------------------
tutorial('7', 'water drop')
{
  const { patch, values: preset } = fromLibrary('drop')
  const values = knobs(patch, preset)

  // The gate is held longer than the sound lasts on purpose: the Slew is
  // still climbing when the envelope has already faded it out, which is why
  // the pitch rises all the way through instead of turning over.
  const out = oneShot('drop', patch, values, 0.3, 1.5)
  const sweep = pitchRange(out.left, out.seconds)
  check('drop: it rings at a pitch', sweep.low > 50, `${sweep.low.toFixed(0)} - ${sweep.high.toFixed(0)} Hz`)
  const head = brightness(out.left, 0, at(0.04))
  const later = brightness(out.left, at(0.2), at(0.24))
  check('drop: the pitch climbs', later > head * 1.5, `${head.toFixed(0)} -> ${later.toFixed(0)} Hz`)
}

// --- 8. engine -------------------------------------------------------
tutorial('8', 'engine')
{
  const { patch, values: preset } = fromLibrary('engine')
  const values = knobs(patch, preset)

  const out = render(patch, values, 3, 3)
  const whole = stats(out.left)
  check('engine: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('engine: no NaN', whole.nan === 0)
  const tail = stats(out.left, at(2.5), at(3)).rms
  check('engine: it keeps running', tail > 0.05, `rms=${tail.toFixed(3)}`)

  // The PWM is the whole point, and pulse width is measurable directly: the
  // share of each window the wave spends above zero. Taken with the filter
  // opened right up and osc2 muted, so what is measured is the oscillator
  // rather than everything downstream of it.
  const bare = { ...values, 'lpf1.cutoff': 18000, 'lpf1.drive': 1, 'lpf1.resonance': 0, 'mix1.level2': 0 }
  const flat = { ...patch, cables: patch.cables.filter((c) => c.to.port !== 'pwm') }
  const moving = dutyRange(render(patch, bare, 3, 3).left, 0.6)
  const still = dutyRange(render(flat, bare, 3, 3).left, 0.6)
  check(
    'engine: the LFO is moving the pulse width',
    moving.spread > 0.6,
    `${moving.low.toFixed(2)} - ${moving.high.toFixed(2)} duty`,
  )
  check(
    'engine: and it sits still without the cable',
    still.spread < 0.4,
    `${still.low.toFixed(2)} - ${still.high.toFixed(2)} duty`,
  )
}

// --- 9. power-up -----------------------------------------------------
tutorial('9', 'power-up')
{
  const { patch, values: preset } = fromLibrary('powerup')
  const values = knobs(patch, preset)

  const out = render(patch, values, 1, 1)
  const whole = stats(out.left)
  check('power-up: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('power-up: no NaN', whole.nan === 0)
  const early = brightness(out.left, at(0.05), at(0.25))
  const late = brightness(out.left, at(0.7), at(0.9))
  check('power-up: the steps climb', late > early * 1.4, `${early.toFixed(0)} -> ${late.toFixed(0)} Hz`)
  check('power-up: it blips rather than drones', blips(out.left, 1) >= 6, `${blips(out.left, 1)} blips`)
}

// --- 10. sync zap ----------------------------------------------------
tutorial('10', 'sync zap')
{
  const { patch, values: preset } = fromLibrary('synczap')
  const values = knobs(patch, preset)

  const out = oneShot('zap', patch, values, 0.05, 2)
  const head = brightness(out.left, 0, at(0.05))
  const later = brightness(out.left, at(0.3), at(0.4))
  check('zap: it tears as the sweep falls', head > later * 1.3, `${head.toFixed(0)} -> ${later.toFixed(0)} Hz`)

  // Sync is what makes this a zap rather than a sweep: without it the same
  // envelope only slides osc2's pitch about.
  const unsynced = render(
    { ...patch, cables: patch.cables.filter((c) => c.to.port !== 'sync') },
    values,
    0.05,
    2,
  )
  check(
    'zap: the sync cable is doing the work',
    !same(out.left.subarray(0, 4096), unsynced.left.subarray(0, 4096)),
  )
}

// --- 11. ricochet -----------------------------------------------------
tutorial('11', 'ricochet')
{
  const { patch, values: preset } = fromLibrary('ricochet')

  check(
    'the burst took the envelope over from the trigger',
    patch.cables.filter((c) => c.to.module === 'env1' && c.to.port === 'gate').length === 1,
  )
  const values = knobs(patch, preset)

  const out = oneShot('ricochet', patch, values, 0.01, 3)
  const hits = blips(out.left, 1.2, 0.01, 0.08)
  check('ricochet: it is a run of hits, not one', hits >= 4, `${hits} hits`)
  // Measured off what is ringing rather than off zero crossings: the
  // excitation is a filtered noise click, and crossings count the click.
  const first = ringPitch(out.left, at(0.008), at(0.06))
  const last = ringPitch(out.left, at(0.40), at(0.45))
  check(
    'ricochet: each ping is lower than the last',
    last < first * 0.7,
    `${first.toFixed(0)} -> ${last.toFixed(0)} Hz`,
  )

  // Without the ramp cable every ping is the same note, which is a rattle
  // rather than something bouncing away from you.
  const flat = render(
    { ...patch, cables: patch.cables.filter((c) => c.from.port !== 'ramp') },
    values,
    0.01,
    3,
  )
  check(
    'ricochet: the Ramp cable is what makes it bounce',
    !same(out.left.subarray(at(0.3), at(0.5)), flat.left.subarray(at(0.3), at(0.5))),
  )
}

// --- 12. machine gun --------------------------------------------------
tutorial('12', 'machine gun')
{
  const { patch, values: preset } = fromLibrary('machinegun')
  const values = knobs(patch, preset)

  const out = oneShot('gunfire', patch, values, 0.01, 3)
  const shots = blips(out.left, 1, 0.01, 0.15)
  check('gunfire: eight shots, not one long one', shots >= 6, `${shots} shots`)

  // Bias is what turns a clean clip into a crack, and the tutorial says so.
  const centred = render(
    patch,
    { ...values, 'drv1.bias': 0 },
    0.01,
    3,
  )
  check(
    'gunfire: the Bias knob changes the sound',
    !same(out.left.subarray(0, 4096), centred.left.subarray(0, 4096)),
  )
}

// --- 13. alien transmission -------------------------------------------
tutorial('13', 'alien transmission')
{
  const { patch, values: preset } = fromLibrary('transmission')
  const values = knobs(patch, preset)

  const out = render(patch, values, 2, 2)
  const whole = stats(out.left)
  check('transmission: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('transmission: no NaN', whole.nan === 0)
  check('transmission: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  const talking = blips(out.left, 1.5, 0.01, 0.2)
  check('transmission: it chatters rather than drones', talking >= 5, `${talking} blips`)

  // Both new modules have to be earning their place in the chain.
  const noRing = render(patch, { ...values, 'ring1.mix': 0 }, 2, 2)
  check(
    'transmission: the Ring Mod is doing work',
    !same(out.left.subarray(0, 4096), noRing.left.subarray(0, 4096)),
  )
  const noCrush = render(patch, { ...values, 'bits1.mix': 0 }, 2, 2)
  check(
    'transmission: so is the Bitcrusher',
    !same(out.left.subarray(0, 4096), noCrush.left.subarray(0, 4096)),
  )
}

// --- 14. arpeggio ------------------------------------------------------
tutorial('14', 'arpeggio')
{
  const { patch, values: preset } = fromLibrary('arpeggio')
  const values = knobs(patch, preset)

  const out = render(patch, values, 2, 2)
  const whole = stats(out.left)
  check('arpeggio: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('arpeggio: no NaN', whole.nan === 0)
  check('arpeggio: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)

  const notes = blips(out.left, 1.5, 0.01, 0.5)
  check('arpeggio: it plays notes rather than a chord', notes >= 6, `${notes} notes`)

  const range = pitchRange(out.left, 1.5)
  check(
    'arpeggio: the pattern moves through pitches',
    range.high > range.low * 1.4,
    `${range.low.toFixed(0)} - ${range.high.toFixed(0)} Hz`,
  )

  // A stereo reverb has to put something different on each side, or the two
  // mixer channels were a waste of a cable.
  check('arpeggio: the room has width', !same(out.left, out.right))
}

// --- 15. sci-fi door ---------------------------------------------------
tutorial('15', 'sci-fi door')
{
  const { patch, values: preset } = fromLibrary('door')
  const values = knobs(patch, preset)

  const out = oneShot('door', patch, values, 0.05, 8)
  check('door: the room has width', !same(out.left, out.right))

  // Folding is what makes a sine metallic; without it this is a soft bloop.
  const unfolded = render(
    { ...patch, cables: patch.cables.filter((c) => c.to.module !== 'fold1') },
    values,
    0.05,
    8,
  )
  const folded = brightness(out.left, at(0.05), at(0.3))
  const plain = brightness(unfolded.left, at(0.05), at(0.3))
  check('door: the folder is what makes it metallic', folded > plain, `${folded.toFixed(0)} vs ${plain.toFixed(0)} Hz`)

  // And the Time CV is what makes it move rather than simply echo.
  const still = render(patch, { ...values, 'dly1.cvAmount': 0 }, 0.05, 8)
  check(
    'door: Time CV is bending the delay',
    !same(out.left.subarray(0, 4096), still.left.subarray(0, 4096)),
  )
}

// --- 16. bell ----------------------------------------------------------
tutorial('16', 'bell')
{
  const { patch, values: preset } = fromLibrary('bell')
  const values = knobs(patch, preset)

  const out = oneShot('bell', patch, values, 0.05, 12)

  // Struck, then ringing. The index envelope is far shorter than the note, so
  // the partials belong to the strike and the ring is left with the note on
  // its own -- which is what a bell does and what a fixed FM index cannot.
  const partials = (from: number, to: number) =>
    (toneAt(out.left, 440 + 1214, from, to) + toneAt(out.left, 1214 - 440, from, to)) /
    Math.max(1e-9, toneAt(out.left, 440, from, to))
  const struck = partials(0, at(0.15))
  const ringing = partials(at(1.5), at(2))
  check(
    'bell: the strike is bright and the ring is not',
    struck > ringing * 20,
    `${struck.toFixed(3)} -> ${ringing.toFixed(3)}`,
  )

  // Metal rather than organ. 2.76 is no musical interval, so what the
  // modulator adds lands nowhere near a harmonic of the note.
  const sideband = toneAt(out.left, 440 + 1214, 0, at(0.15))
  const harmonic = toneAt(out.left, 880, 0, at(0.15))
  check(
    'bell: its partials are not harmonics of the note',
    sideband > harmonic * 10,
    `${sideband.toFixed(4)} at 1654 Hz vs ${harmonic.toFixed(4)} at 880`,
  )

  // The mode switch is the whole tutorial. Exponential FM this deep at audio
  // rate does not leave a note behind at all -- the pitch it averages out to
  // is nowhere near the Pitch knob, and there is nothing left to ring.
  const wobble = render(patch, { ...values, 'osc1.fmMode': 0 }, 0.05, 12)
  check(
    'bell: linear FM is what keeps the note where it was tuned',
    toneAt(out.left, 440, 0, at(0.15)) > toneAt(wobble.left, 440, 0, at(0.15)) * 10,
    `${toneAt(out.left, 440, 0, at(0.15)).toFixed(4)} vs ${toneAt(wobble.left, 440, 0, at(0.15)).toFixed(4)}`,
  )
}

// --- 17. coin ----------------------------------------------------------
tutorial('17', 'coin')
{
  const { patch, values: preset } = fromLibrary('coin')
  const values = knobs(patch, preset)

  const out = oneShot('coin', patch, values, 0.05, 4)

  const first = brightness(out.left, at(0.01), at(0.06))
  const second = brightness(out.left, at(0.12), at(0.3))
  check('coin: the second note is the higher one', second > first * 1.2, `${first.toFixed(0)} -> ${second.toFixed(0)} Hz`)

  // Two notes rather than one that changes pitch: the level has to come back
  // up after the first has faded.
  const faded = stats(out.left, at(0.06), at(0.08)).peak
  const arrives = stats(out.left, at(0.09), at(0.12)).peak
  check('coin: the second note arrives after the first has gone', arrives > faded * 2, `${faded.toFixed(2)} -> ${arrives.toFixed(2)}`)

  // Take the Delay away and the two land together, which is one chord rather
  // than two notes.
  const together = render(patch, { ...values, 'osc3.delay': 0.0002 }, 0.05, 4)
  check(
    'coin: the envelope Delay is what splits them',
    stats(together.left, at(0.09), at(0.12)).peak <= stats(together.left, at(0.06), at(0.08)).peak,
    `${stats(together.left, at(0.06), at(0.08)).peak.toFixed(2)} -> ${stats(together.left, at(0.09), at(0.12)).peak.toFixed(2)}`,
  )

  // And the fixed-length gate is what guarantees the delayed note gets to
  // start at all. Held instead, a 50 ms tap releases it before it opens and
  // the coin is a single blip.
  const tapped = render(patch, { ...values, 'gate1.mode': 0 }, 0.05, 4)
  check(
    'coin: the Trigger holds the gate open long enough to reach it',
    stats(tapped.left, at(0.12), at(0.3)).peak < stats(out.left, at(0.12), at(0.3)).peak * 0.25,
    `${tapped.seconds.toFixed(2)}s against ${out.seconds.toFixed(2)}s`,
  )
}

// --- 18. rain --------------------------------------------------------
tutorial('18', 'rain')
{
  const { patch, values: preset } = fromLibrary('rain')
  const values = knobs(patch, preset)

  const out = render(patch, values, 2, 6)
  const whole = stats(out.left)
  check('rain: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('rain: no NaN', whole.nan === 0)
  check('rain: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  check('rain: it keeps falling while the key is held', stats(out.left, at(1), at(2)).rms > 0.02,
    `rms=${stats(out.left, at(1), at(2)).rms.toFixed(3)}`)
  check('rain: and eases off after', out.seconds < 5.95, `${out.seconds.toFixed(2)}s`)
  check('rain: it builds rather than starting at full',
    stats(out.left, 0, at(0.1)).rms < stats(out.left, at(0.5), at(0.6)).rms / 2)

  // Separate drops, dozens of them: the manual's ninety a second, counted as
  // onsets, which overlap and so undercount.
  const drops = events(out.left, at(1), at(2))
  check('rain: it is made of separate drops, dozens a second', drops > 30, `${drops} in a second`)

  // The Try: Density down and Tone to click is a Geiger counter.
  const geiger = render(patch, { ...values, 'dust1.density': 6, 'dust1.tone': 0 }, 2, 6)
  const clicks = events(geiger.left, at(1), at(2))
  check('rain: at 6 Hz it is a handful of clicks instead', clicks > 0 && clicks < drops / 5, `${clicks} against ${drops}`)
}

// --- 19. fly ---------------------------------------------------------
tutorial('19', 'fly')
{
  const { patch, values: preset } = fromLibrary('fly')
  const values = knobs(patch, preset)

  const out = render(patch, values, 3, 4)
  const whole = stats(out.left)
  check('fly: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('fly: no NaN', whole.nan === 0)
  check('fly: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)

  // Tenth-of-a-second windows across the hold: a fly never sits on a note.
  const spread = (buf: Float32Array) => {
    let low = Infinity
    let high = 0
    for (let t = 0.2; t < 2.9; t += 0.25) {
      const f = brightness(buf, at(t), at(t + 0.1))
      low = Math.min(low, f)
      high = Math.max(high, f)
    }
    return high / low
  }
  const wanders = spread(out.left)
  check('fly: its pitch wanders', wanders > 1.2, `${wanders.toFixed(2)}x between highest and lowest`)
  const landed = spread(render(patch, { ...values, 'drk1.step': 0.01 }, 3, 4).left)
  check('fly: with Step at 0.01 it all but settles', landed < 1.1, `${landed.toFixed(2)}x`)
}

// --- 20. pipe --------------------------------------------------------
tutorial('20', 'pipe')
{
  const { patch, values: preset } = fromLibrary('pipe')
  const values = knobs(patch, preset)

  const out = oneShot('pipe', patch, values, 0.05, 3)
  // The strike is over in twelve milliseconds; what follows is the comb.
  const pitch = ringPitch(out.left, at(0.05), at(0.3))
  check('pipe: it rings at Cutoff', Math.abs(pitch - 220) < 5, `${pitch.toFixed(1)} Hz`)
  check('pipe: for a good while after the strike', stats(out.left, at(0.2), at(0.3)).rms > 0.002,
    `rms=${stats(out.left, at(0.2), at(0.3)).rms.toFixed(4)}`)

  const higher = ringPitch(render(patch, { ...values, 'mmf1.cutoff': 440 }, 0.05, 3).left, at(0.05), at(0.3))
  check('pipe: Cutoff is the note', Math.abs(higher - 440) < 8, `${higher.toFixed(1)} Hz`)

  const hollow = render(patch, { ...values, 'mmf1.mode': 6 }, 0.05, 3)
  const under = ringPitch(hollow.left, at(0.05), at(0.3))
  check('pipe: comb− rings an octave lower', Math.abs(under - 110) < 3, `${under.toFixed(1)} Hz`)

  const dry = render(patch, { ...values, 'mmf1.resonance': 0 }, 0.05, 3)
  check('pipe: with no Res it is only the click', stats(dry.left, at(0.1), at(0.2)).rms < stats(out.left, at(0.1), at(0.2)).rms / 20,
    `${stats(dry.left, at(0.1), at(0.2)).rms.toFixed(5)} against ${stats(out.left, at(0.1), at(0.2)).rms.toFixed(5)}`)
}

// --- 21. jet flyby ---------------------------------------------------
tutorial('21', 'jet')
{
  const { patch, values: preset } = fromLibrary('jet')
  const values = knobs(patch, preset)

  const out = render(patch, values, 1.5, 8)
  const whole = stats(out.left)
  check('jet: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('jet: no NaN', whole.nan === 0 && stats(out.right).nan === 0)
  check('jet: does not clip', whole.peak <= 1.0001 && stats(out.right).peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  check('jet: and passes', out.seconds < 7.95, `${out.seconds.toFixed(2)}s`)
  check('jet: the two sides differ', !same(out.left, out.right))

  // The comb's spacing is the flanger's delay. As the envelope lengthens it,
  // the comb's pitch falls -- the approach.
  const early = ringPitch(out.left, at(0.1), at(0.25))
  const later = ringPitch(out.left, at(0.4), at(0.55))
  check('jet: the sweep falls as the envelope rises', early > later * 2, `${early.toFixed(0)} -> ${later.toFixed(0)} Hz`)

  // Unpatch the envelope from Center and nothing sweeps it: the comb stays
  // up where the knob put it, a delay so short its teeth are above anything
  // this can measure, instead of coming down.
  const still = render(unwire(patch, 'cho1.cv'), values, 1.5, 8)
  const unswept = ringPitch(still.left, at(0.4), at(0.55))
  check('jet: and it is the Center cable that sweeps it', unswept > later * 2, `${unswept.toFixed(0)} Hz without it, ${later.toFixed(0)} with`)
}

// --- 22. charge-up ---------------------------------------------------
tutorial('22', 'charge-up')
{
  const { patch, values: preset } = fromLibrary('chargeup')
  const values = knobs(patch, preset)

  const out = render(patch, values, 2, 5)
  const whole = stats(out.left)
  check('charge-up: makes a sound', whole.peak > 0.05, `peak=${whole.peak.toFixed(3)}`)
  check('charge-up: no NaN', whole.nan === 0)
  check('charge-up: does not clip', whole.peak <= 1.0001, `peak=${whole.peak.toFixed(3)}`)
  check('charge-up: and stops when let go', out.seconds < 4.95, `${out.seconds.toFixed(2)}s`)

  const start = treble(out.left, at(0.1), at(0.25))
  const top = treble(out.left, at(1.7), at(1.85))
  check('charge-up: it brightens as it charges', top > start * 2.5, `${start.toFixed(3)} -> ${top.toFixed(3)}`)

  // Lane 3's window opens at 0.50. Until the envelope carries the macro that
  // far the Drive's jack reads exactly nothing, so the rack is sample for
  // sample the one with that cable pulled -- and after, it is not.
  const unstaged = render(unwire(patch, 'drv1.cv'), values, 2, 5)
  let first = -1
  for (let i = 0; i < out.left.length; i++) {
    if (out.left[i] !== unstaged.left[i]) {
      first = i
      break
    }
  }
  check('charge-up: the drive lane waits for its half of the turn', first > at(0.6) && first < at(1.2),
    first < 0 ? 'never differs' : `wakes at ${(first / SR).toFixed(2)}s`)
}

// --- the shelf is covered ----------------------------------------------
/**
 * Nothing may sit in the library that this file has not built, rendered and
 * listened to.
 *
 * The library is offered to the user as a shelf of racks that work. A template
 * added to it without a tutorial here would ship on nobody's word at all,
 * which is the single thing moving these patches into the app could have
 * cost us.
 */
console.log('\nthe library')
{
  // The tutorials are this file's to render; the instruments on the other
  // shelves are check:instruments'.
  const tutorials = LIBRARY.filter((t) => t.category === 'tutorial')
  const untested = tutorials.filter((t) => !built.has(t.id)).map((t) => t.id)
  check(
    'every tutorial on the shelf was built and rendered',
    untested.length === 0,
    untested.length ? untested.join(', ') : `${built.size} of ${tutorials.length}`,
  )

  const ids = new Set(LIBRARY.map((t) => t.id))
  check('and no two share an id', ids.size === LIBRARY.length)

  const missing = tutorials.filter((t) => !t.name || !t.description || !t.teaches)
  check('every template says what it is', missing.length === 0, missing.map((t) => t.id).join(', '))

  // A template is pruned down to what it can be heard through, and the
  // Trigger is reachable only while something is patched to it. Take that
  // cable away -- as the Burst tutorials did, firing the envelope themselves
  // -- and the keyboard goes with it: the rack still renders, and still
  // cannot be played. Nothing else would have noticed.
  const unplayable = LIBRARY.filter(
    (t) => !t.build().patch.modules.some((m) => defOf(m.type).keyed),
  ).map((t) => t.id)
  check(
    'every template can be played from the keyboard',
    unplayable.length === 0,
    unplayable.length ? unplayable.join(', ') : `all ${LIBRARY.length} keep a Trigger`,
  )

  const mute = LIBRARY.filter((t) => !t.build().patch.modules.some((m) => defOf(m.type).bus)).map((t) => t.id)
  check('and every one has a way out to the speakers', mute.length === 0, mute.join(', '))

  // Nothing on the shelf may waste a row it could have filled.
  //
  // The rack is two columns: a full panel takes a row, two half panels share
  // one, and they are placed in patch order. So the order these are built in
  // decides how many half-empty rows a reader is looking at, and building
  // them in the order the tutorial adds modules left twenty-two of them.
  // A rack with an odd number of half panels must end one short; anything
  // beyond that is a rack nobody laid out.
  const untidy: string[] = []
  for (const t of LIBRARY) {
    const widths = t.build().patch.modules.map((m) => (defOf(m.type).width === 'half' ? 1 : 2))
    let gaps = 0
    let filled = 0
    for (const w of widths) {
      if (filled + w > 2) {
        gaps++
        filled = 0
      }
      filled = (filled + w) % 2
    }
    if (filled === 1) gaps++
    const forced = widths.filter((w) => w === 1).length % 2
    if (gaps !== forced) untidy.push(`${t.id}: ${gaps} gaps, ${forced} unavoidable`)
  }
  check('and none of them leaves a row half empty', untidy.length === 0, untidy.join('; '))
}

// --- the manual's own tables ------------------------------------------
/**
 * Every knob value printed in a tutorial has to be one that tutorial was
 * actually rendered with, spelled the way the panel spells it.
 *
 * This is the drift nothing else would catch. The patches above are built
 * from code, so they keep working while the prose beside them quietly stops
 * being true -- a value edited in one place and not the other, or a number
 * written the way it is stored rather than the way the readout shows it. A
 * reader following a table that does not match is left turning knobs until
 * they give up.
 */
console.log('\nthe manual matches what was rendered')
{
  // From the working directory, not from import.meta.url: this file is
  // bundled into node_modules/.cache before it runs.
  // Carriage returns stripped: the file is checked out with CRLF endings,
  // and a stray one at the end of a row would fail every match silently.
  const manual = readFileSync(join(process.cwd(), 'MANUAL.md'), 'utf8').split('\r').join('')
  const sections = manual.split(/^### Tutorial (\d+) /m)
  let checked = 0
  const wrong: string[] = []

  // split() gives [preamble, number, body, number, body, ...].
  for (let i = 1; i < sections.length; i += 2) {
    const number = sections[i]
    const used = rendered.get(number)
    if (!used) {
      wrong.push(`tutorial ${number} is in the manual but nothing rendered it`)
      continue
    }
    for (const line of sections[i + 1].split('\n')) {
      const row = /^\|\s*([a-z]+\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line)
      if (!row) continue
      const [, id, knob, value] = row
      const printed = `${id} | ${knob} | ${value}`.replace(/\*\*/g, '')
      checked++
      if (!used.has(printed)) wrong.push(`${number}: "${printed}"`)
    }
  }

  check('every tutorial table row was rendered', wrong.length === 0, wrong.join('; '))
  check('and there were rows to check', checked > 60, `${checked} rows`)
}

// --- knob help ---------------------------------------------------------
/**
 * The help a resting pointer shows is the manual's own knob tables, read at
 * load. So every knob a panel draws has to have a row in its module's table,
 * under the label the panel prints -- a knob added without one would simply
 * have no help, and nobody would notice it missing.
 */
console.log('\nevery knob has help')
{
  const manual = readFileSync(join(process.cwd(), 'MANUAL.md'), 'utf8').split('\r').join('')
  const help = parseKnobHelp(manual)
  // The mixer's mute and solo are its own buttons, with their own titles,
  // not knobs; everything a knob or a switch draws is here.
  const missing = Object.values(MODULE_DEFS).flatMap((def) =>
    def.params
      .filter((p) => !p.played && !(def.type === 'mixer' && /^(Mute|Solo) \d$/.test(p.label)))
      .filter((p) => !helpFor(help, def.name, p.label))
      .map((p) => `${def.name} › ${p.label}`),
  )
  check('every knob and switch is described in the manual', missing.length === 0, missing.join(', '))
  check('and the help is the sentence the table gives', helpFor(help, 'Ladder Filter', 'Cutoff') === 'Where the filter turns over',
    String(helpFor(help, 'Ladder Filter', 'Cutoff')))
  check('a numbered knob finds the row for all of them', helpFor(help, 'Mixer', 'Lvl 5') === 'Volume of that channel')
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
