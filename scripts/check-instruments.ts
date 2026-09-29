/**
 * Headless checks for the instrument voices in the patch library.
 *
 * A tutorial rack is checked by the manual that teaches it. An instrument has
 * no manual, only a promise in its name, so this is where it is held to one:
 * every voice is built, played and listened to the way a piano roll would
 * play it, and has to
 *
 *   - build, with every knob it names being a knob that exists;
 *   - keep a Trigger on Space, so the computer keyboard plays it;
 *   - play in tune: the bottom key a C, the middle one a C an octave up, the
 *     top one a C above that, each within a few cents;
 *   - leave room for a chord: one note sits well under full scale, and four
 *     at once do not drive the mixer hard into its limiter;
 *   - fall silent after the last note lets go, and let its voices sleep.
 *
 * Run with: npm run check:instruments
 * Set INSTRUMENT_WAVS to a folder to also write a short demo of each voice.
 */
// First, before the library, on purpose: the instruments once imported their
// building blocks back out of the library that lists them, and a program that
// reached for the instruments before the library threw at load. Imported in
// this order the bundle evaluates them in this order, so the check below is
// that regression.
import { INSTRUMENTS } from '../src/patch/instruments'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GraphEngine, type EngineEvent } from '../src/dsp/GraphEngine'
import { encodeWav } from '../src/audio/wav'
import { compile } from '../src/patch/compile'
import { defOf } from '../src/patch/defs'
import { CATEGORIES, LIBRARY, type Template } from '../src/patch/library'
import { midiNameCents, rowZero, tuningOf } from '../src/song/tuning'

const SR = 48000
const WAVS = process.env.INSTRUMENT_WAVS

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

console.log('\nthe instruments load on their own')
{
  let built = false
  try {
    built = INSTRUMENTS.length > 0 && INSTRUMENTS[0].make().patch.modules.length > 0
  } catch {
    built = false
  }
  check('importing the instruments before the library works', built)
}

/** A note, as the roll would hand it over: on, then off, by pitch. */
interface Note {
  at: number
  length: number
  pitch: number
  velocity?: number
}

function render(t: Template, notes: Note[], seconds: number, dry = false, over: Record<string, number> = {}) {
  const { patch, values: built } = t.build()
  const values = { ...built, ...over }
  const compiled = compile(patch)
  const params = compiled.params.slice()
  for (const [key, value] of Object.entries(values)) params[compiled.paramIndex[key]] = value
  // The room off, for measuring pitch: its own resonances sit near the note
  // and outlast a short one, and a spectrum taken then reads the room.
  if (dry) for (const m of patch.modules) if (m.type === 'reverb') params[compiled.paramIndex[`${m.id}.mix`]] = 0
  const engine = new GraphEngine(compiled, SR, params)

  const target = patch.modules.find((m) => defOf(m.type).playable) ?? patch.modules.find((m) => defOf(m.type).keyed)!
  const events: EngineEvent[] = []
  for (const n of notes) {
    const on = Math.round(n.at * SR)
    const off = Math.round((n.at + n.length) * SR)
    events.push({ frame: on, kind: 'noteOn', module: target.id, pitch: n.pitch, velocity: n.velocity ?? 0.8 })
    events.push({ frame: off, kind: 'noteOff', module: target.id, pitch: n.pitch })
  }
  // Releases before presses on the same sample, as the song scheduler sorts
  // them: the engine applies same-frame events in the order they arrive.
  events.sort((a, b) => a.frame - b.frame || (a.kind === 'noteOff' ? -1 : 1))
  for (const e of events) engine.schedule(e)

  const frames = Math.round(seconds * SR)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const bl = new Float32Array(128)
  const br = new Float32Array(128)
  for (let i = 0; i < frames; i += 128) {
    engine.render(bl, br)
    const n = Math.min(128, frames - i)
    left.set(bl.subarray(0, n), i)
    right.set(br.subarray(0, n), i)
  }
  const asleep = (engine as unknown as { activeList: number[] }).activeList.length === 0
  return { left, right, asleep, pitched: defOf(target.type).playable === true }
}

const peak = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const rms = (buf: Float32Array) => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / Math.max(1, buf.length))
const mono = (l: Float32Array, r: Float32Array) => l.map((v, i) => (v + r[i]) / 2)

/**
 * The latest quarter-second of a held note that is still near full voice. A
 * pad has only just arrived at half a second; a pizzicato has long gone by
 * one. Measuring both at the same instant would be measuring one of them in
 * its attack or in its silence.
 */
function steady(buf: Float32Array, seconds = 0.25): Float32Array {
  const len = Math.round(seconds * SR)
  const starts = [0.1, 0.35, 0.6, 0.9, 1.2].map((x) => Math.round(x * SR))
  const level = starts.map((x) => rms(buf.subarray(x, x + len)))
  const loudest = Math.max(...level)
  let pick = 0
  starts.forEach((_, i) => {
    if (level[i] >= loudest * 0.3) pick = i
  })
  return buf.subarray(starts[pick], starts[pick] + len)
}

/**
 * How far the fundamental near `expect` is from it, in cents.
 *
 * The strongest spectral peak within half a semitone either side, found
 * coarsely and then to a tenth of a cent. A peak rather than a period,
 * because the period of a waveform is set by its overtones as much as by its
 * fundamental: a string whose fundamental had drifted forty cents sharp once
 * measured in tune that way, with every overtone still where it should be.
 */
function centsOff(buf: Float32Array, expect: number): number {
  const n = buf.length
  const win = new Float32Array(n)
  for (let i = 0; i < n; i++) win[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  const power = (cents: number) => {
    const w = (2 * Math.PI * expect * 2 ** (cents / 1200)) / SR
    // Goertzel: one bin, anywhere.
    const k = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < n; i++) {
      const s0 = win[i] + k * s1 - s2
      s2 = s1
      s1 = s0
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2
  }
  let best = 0
  let bestP = -1
  for (let c = -50; c <= 50; c += 2) {
    const p = power(c)
    if (p > bestP) (bestP = p), (best = c)
  }
  const from = best - 2
  for (let c = from; c <= from + 4; c += 0.1) {
    const p = power(c)
    if (p > bestP) (bestP = p), (best = c)
  }
  return best
}

/**
 * The frequency a voice's bottom key plays, read off the rack: the lowest
 * Pitch knob on anything the Keyboard's Pitch reaches, directly or through a
 * Slew. For an FM voice that is the carrier; for a harpsichord, the 8' string.
 * Oscillators detuned a few cents either side of it for thickness count as
 * one, at the middle of the spread.
 */
function bottomKey(t: Template): number {
  const { patch, values } = t.build()
  const fed = new Set<string>()
  for (const c of patch.cables) {
    if (c.from.module === 'key1' && c.from.port === 'pitch') fed.add(c.to.module)
  }
  for (const c of patch.cables) {
    const via = patch.modules.find((m) => m.id === c.from.module)
    if (via?.type === 'slew' && fed.has(via.id)) fed.add(c.to.module)
  }
  const pitches = [...fed].map((id) => values[`${id}.pitch`]).filter((v) => v !== undefined)
  const lowest = Math.min(...pitches)
  const spread = pitches.filter((p) => p < lowest * 2 ** (30 / 1200))
  return Math.exp(spread.reduce((sum, p) => sum + Math.log(p), 0) / spread.length)
}

/** Cents from the nearest C, and which C it is. */
function fromC(freq: number) {
  const semis = 12 * Math.log2(freq / 16.3516)
  const octave = Math.round(semis / 12)
  return { cents: (semis - octave * 12) * 100, octave }
}

const instruments = LIBRARY.filter((t) => t.category !== 'tutorial')

console.log('\nthe shelf')
{
  const shelves = new Set(CATEGORIES.map((c) => c.id))
  const stray = LIBRARY.filter((t) => !shelves.has(t.category)).map((t) => t.id)
  check('every template is on a shelf', stray.length === 0, stray.join(', '))
  const empty = CATEGORIES.filter((c) => !LIBRARY.some((t) => t.category === c.id)).map((c) => c.name)
  check('and no shelf is empty', empty.length === 0, empty.join(', '))
  const ids = new Set(LIBRARY.map((t) => t.id))
  check('no two templates share an id', ids.size === LIBRARY.length)
  const bare = instruments.filter((t) => !t.name || !t.description || !t.tip).map((t) => t.id)
  check('every instrument says what it is and what to do with it', bare.length === 0, bare.join(', '))
}

for (const cat of CATEGORIES.filter((c) => c.id !== 'tutorial')) {
  console.log(`\n${cat.name.toLowerCase()}`)
  for (const t of instruments.filter((x) => x.category === cat.id)) {
    const problems: string[] = []
    const facts: string[] = []
    const { patch } = t.build()
    const compiled = compile(patch)
    if (compiled.warnings.length) problems.push(compiled.warnings.join('; '))
    if (!patch.modules.some((m) => m.type === 'gate' && m.key === 'Space')) problems.push('no Trigger on Space')

    const probe = render(t, [{ at: 0.05, length: 0.05, pitch: 0 }], 0.2)

    if (probe.pitched) {
      // In tune across the roll: the bottom key a C, and the seventh, the
      // twelfth and the top key where they should be above it. The G on the
      // seventh is what catches a keyboard tracked at the wrong rate.
      const base = bottomKey(t)
      const { cents: baseOff, octave } = fromC(base)
      if (Math.abs(baseOff) > 0.5) problems.push(`the bottom key is ${base.toFixed(2)} Hz, not a C`)
      // And the roll and the Keyboard panel name that key by the note it
      // plays, read off the knobs by a rule of their own. Held to the one
      // here, which the renders below hold to the ear.
      const tuning = tuningOf(t.build())
      const heard = 69 + 12 * Math.log2(base / 440)
      if (!tuning) problems.push("the roll cannot name its keys: nothing tuned is on the Keyboard's pitch")
      else if (Math.abs(rowZero(tuning) - heard) > 0.01) {
        problems.push(`the roll names the bottom key ${midiNameCents(rowZero(tuning))}, but it plays ${midiNameCents(heard)}`)
      }
      for (const pitch of [0, 7, 12, 24]) {
        const r = render(t, [{ at: 0, length: 2, pitch }], 2, true)
        const expect = base * 2 ** (pitch / 12)
        // Long enough to hold a dozen cycles, so a bass note's fundamental is
        // resolved from the partials either side of it.
        const off = centsOff(steady(mono(r.left, r.right), Math.max(0.25, 12 / expect)), expect)
        if (Math.abs(off) > 10) problems.push(`key ${pitch} is ${off.toFixed(0)} cents out`)
      }
      facts.push(`C${octave}`)

      // One note, and a chord where the voices allow.
      const one = render(t, [{ at: 0, length: 1, pitch: 12, velocity: 1 }], 1.5)
      const p1 = Math.max(peak(one.left), peak(one.right))
      facts.push(`note ${p1.toFixed(2)}`)
      if (p1 < 0.12) problems.push(`a note peaks at only ${p1.toFixed(2)}`)
      if (p1 > 0.7) problems.push(`a note peaks at ${p1.toFixed(2)}, leaving no room`)

      const voices = (patch.modules.find((m) => m.type === 'keys') && t.build().values['key1.voices']) || 1
      if (voices > 1) {
        const chord = [0, 4, 7, 12].map((pitch) => ({ at: 0, length: 1.5, pitch, velocity: 1 }))
        const c = render(t, chord, 2)
        const p4 = Math.max(peak(c.left), peak(c.right))
        facts.push(`chord ${p4.toFixed(2)}`)
        // tanh(1.4) is 0.885: beyond that the mixer is flattening the chord.
        if (p4 > 0.885) problems.push(`a four-note chord peaks at ${p4.toFixed(2)}`)
      }
      facts.push(`${voices} voice${voices > 1 ? 's' : ''}`)
    } else {
      const hit = render(t, [{ at: 0, length: 0.05, pitch: 0, velocity: 1 }], 1)
      const p = Math.max(peak(hit.left), peak(hit.right))
      facts.push(`hit ${p.toFixed(2)}`)
      if (p < 0.2) problems.push(`a hit peaks at only ${p.toFixed(2)}`)
      if (p > 0.9) problems.push(`a hit peaks at ${p.toFixed(2)}`)
    }

    // Velocity reaches the sound: a soft note from the roll is a quieter one,
    // on a drum as much as on a keyboard.
    {
      const hard = render(t, [{ at: 0, length: 0.3, pitch: 12, velocity: 1 }], 0.6)
      const soft = render(t, [{ at: 0, length: 0.3, pitch: 12, velocity: 0.3 }], 0.6)
      const ratio = Math.max(peak(soft.left), peak(soft.right)) / Math.max(peak(hard.left), peak(hard.right))
      if (!(ratio < 0.8)) problems.push(`a soft note is ${Math.round(ratio * 100)}% as loud as a hard one`)
    }

    // Silence after the last note, however long the tail. Eight seconds is
    // the longest room on the shelf with its release on top.
    const tail = render(t, [{ at: 0, length: 0.6, pitch: 5 }], 16)
    const after = rms(mono(tail.left, tail.right).subarray(Math.round(14 * SR)))
    if (after > 1e-4) problems.push(`still sounding 13 s after release (rms ${after.toExponential(1)})`)
    // A single voice runs all the time, as the rack always did; only a rack
    // with voices to spare puts them to sleep.
    const spare = (t.build().values['key1.voices'] ?? 1) > 1
    if (spare && !tail.asleep) problems.push('its voices never went back to sleep')

    check(`${t.name}`, problems.length === 0, problems.length ? problems.join('; ') : facts.join(', '))

    if (WAVS) {
      mkdirSync(WAVS, { recursive: true })
      const demo = demoFor(t, probe.pitched)
      const d = render(t, demo.notes, demo.seconds)
      writeFileSync(join(WAVS, `${cat.id}-${t.id}.wav`), encodeWav([d.left, d.right], SR))
    }
  }
}

// --- sound fx and ambience do what they say ----------------------------
/**
 * The shelf checks above hold every voice to being playable. A sound effect
 * also makes a promise in its name -- a jump goes up, a power-down comes down,
 * a loop keeps going -- and nothing above would notice one that stopped
 * keeping it. These listen for the one thing each is for.
 */
console.log('\nsound fx and ambience do what they say')
{
  const byId = (id: string) => LIBRARY.find((t) => t.id === id)!
  const at = (s: number) => Math.round(s * SR)
  /** Zero crossings a second: rough, and plenty for "higher or lower". */
  const crossings = (buf: Float32Array, from: number, to: number) => {
    let n = 0
    for (let i = from + 1; i < to; i++) if (buf[i - 1] <= 0 !== buf[i] <= 0) n++
    return (n * SR) / (to - from)
  }
  /** The slope's level against the signal's: how much treble. */
  const treble = (buf: Float32Array, from: number, to: number) => {
    let d = 0
    let x = 0
    for (let i = from + 1; i < to; i++) {
      d += (buf[i] - buf[i - 1]) ** 2
      x += buf[i] ** 2
    }
    return Math.sqrt(d / Math.max(1e-12, x))
  }
  const level = (buf: Float32Array, from: number, to: number) => rms(buf.subarray(from, to))
  const hit = (id: string, seconds = 1.5, over: Record<string, number> = {}) =>
    render(byId(id), [{ at: 0, length: 0.05, pitch: 0, velocity: 1 }], seconds, false, over)
  const held = (id: string, seconds: number, over: Record<string, number> = {}) =>
    render(byId(id), [{ at: 0, length: seconds, pitch: 0, velocity: 1 }], seconds + 2, false, over)
  const ratio = (a: number, b: number) => `${a.toFixed(0)} -> ${b.toFixed(0)}`

  {
    const o = hit('uiconfirm').left
    const a = crossings(o, at(0.005), at(0.035))
    const b = crossings(o, at(0.07), at(0.1))
    check('UI confirm: the second blip is the higher', b > a * 1.3, ratio(a, b))
  }
  {
    const o = hit('uierror').left
    const a = crossings(o, at(0.01), at(0.07))
    const b = crossings(o, at(0.12), at(0.2))
    check('UI error: and the error falls', b < a * 0.85, ratio(a, b))
  }
  {
    const o = hit('jump').left
    const a = crossings(o, at(0.002), at(0.03))
    const b = crossings(o, at(0.08), at(0.12))
    check('Jump: it bends upwards', b > a * 1.3, ratio(a, b))
  }
  {
    const o = hit('gameover', 4).left
    const a = crossings(o, at(0.02), at(0.2))
    const b = crossings(o, at(1), at(1.4))
    check('Game over: it winds down', b < a * 0.6, ratio(a, b))
  }
  {
    const o = hit('hurt').left
    const a = crossings(o, at(0.005), at(0.03))
    const b = crossings(o, at(0.1), at(0.2))
    check('Hurt: its tone drops', b < a, ratio(a, b))
  }
  {
    const o = hit('heal', 2)
    const first = crossings(o.left, at(0.005), at(0.05))
    const last = crossings(o.left, at(0.32), at(0.37))
    check('Heal: the arpeggio climbs', last > first * 1.3, ratio(first, last))
    check('Heal: and spreads across the speakers', o.left.some((v, i) => Math.abs(v - o.right[i]) > 1e-3))
  }
  {
    const o = hit('swish').left
    const middle = treble(o, at(0.04), at(0.08))
    const start = treble(o, at(0.002), at(0.02))
    check('Sword swish: the band sweeps up through the cut', middle > start * 1.3, `${start.toFixed(3)} -> ${middle.toFixed(3)}`)
  }
  {
    const o = hit('glass').left
    const c = crossings(o, at(0.01), at(0.2))
    check('Glass break: it rings high', c > 4000, `${c.toFixed(0)} crossings a second`)
  }
  {
    const o = held('klaxon', 2).left
    const tones = [0.1, 0.4, 0.75, 1.05, 1.4].map((t) => crossings(o, at(t), at(t + 0.15)))
    const high = Math.max(...tones)
    const low = Math.min(...tones)
    check('Alarm klaxon: it flips between two tones', high > low * 1.2, tones.map((t) => t.toFixed(0)).join(' '))
  }
  {
    const o = held('creak', 2).left
    check('Door creak: it creaks for as long as it is held', level(o, at(1.5), at(1.9)) > 0.01,
      `rms ${level(o, at(1.5), at(1.9)).toFixed(3)}`)
  }
  for (const id of ['campfire', 'drips', 'surf', 'crickets', 'shiphum']) {
    const o = held(id, 5)
    const late = level(mono(o.left, o.right), at(3.5), at(5))
    // A second and a half after letting go: a hum's release is a fade, not
    // a cut, and that is the right way for a bed to leave a scene.
    const gone = level(mono(o.left, o.right), at(6.5), at(6.6))
    check(`${byId(id).name}: it goes on for as long as it is held`, late > 0.01, `rms ${late.toFixed(3)}`)
    check(`${byId(id).name}: and goes quiet when let go`, gone < late / 4, `rms ${gone.toFixed(4)}`)
  }
  {
    // The Macro patches: turning Amount has to be heard.
    const calm = held('forcefield', 2, { 'mac1.amount': 0 }).left
    const strained = held('forcefield', 2, { 'mac1.amount': 1 }).left
    const a = treble(calm, at(1), at(1.8))
    const b = treble(strained, at(1), at(1.8))
    check('Force field: its Macro strains it', b > a * 1.5, `${a.toFixed(3)} -> ${b.toFixed(3)}`)
  }
  {
    const count = (buf: Float32Array) => {
      let n = 0
      let quiet = true
      const w = at(0.002)
      const floor = Math.max(...Array.from(buf.subarray(at(0.5), at(3)), Math.abs)) * 0.3
      for (let i = at(0.5); i + w < at(3); i += w) {
        let p = 0
        for (let j = i; j < i + w; j++) p = Math.max(p, Math.abs(buf[j]))
        if (p > floor && quiet) n++
        quiet = p <= floor
      }
      return n
    }
    const cool = count(held('radiation', 3, { 'mac1.amount': 0 }).left)
    const hot = count(held('radiation', 3, { 'mac1.amount': 0.9 }).left)
    check('Radiation zone: its Macro crowds the clicks in', hot > cool * 4, ratio(cool, hot))
  }
  {
    const note = (amount: number) =>
      render(byId('adaptivedrone'), [{ at: 0, length: 3, pitch: 12, velocity: 1 }], 3.5, true, { 'mac1.amount': amount }).left
    const a = treble(note(0), at(2), at(2.8))
    const b = treble(note(1), at(2), at(2.8))
    check('Adaptive drone: its Macro darkens the mood into dread', b > a * 1.5, `${a.toFixed(3)} -> ${b.toFixed(3)}`)
  }
}

/**
 * Something short to listen to: a phrase and a chord for a voice that plays
 * them, a line for one that plays one note at a time, a bar for a drum.
 */
function demoFor(t: Template, pitched: boolean): { notes: Note[]; seconds: number } {
  const beat = 0.4
  if (!pitched) {
    const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ at: i * beat, length: 0.05, pitch: 0, velocity: i % 2 ? 0.6 : 1 }))
    return { notes, seconds: 8 * beat + 2.5 }
  }
  const voices = t.build().values['key1.voices'] ?? 1
  const tune = [0, 4, 7, 12, 11, 7, 9, 5, 7]
  const notes: Note[] = tune.map((pitch, i) => ({ at: i * beat, length: beat * 0.9, pitch: pitch + 5 }))
  let end = tune.length * beat
  if (voices > 1) {
    for (const [i, chord] of [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7, 12]].entries()) {
      for (const pitch of chord) notes.push({ at: end + i * 4 * beat, length: 4 * beat * 0.95, pitch })
    }
    end += 16 * beat
  }
  return { notes, seconds: end + 3 }
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
