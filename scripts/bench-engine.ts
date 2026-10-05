/**
 * How much of the audio thread songs and instruments cost, measured the way
 * PERFORMANCE.md's audit measured them: Node's V8 (the same JIT as Chrome's
 * audio thread), 48 kHz, 128-frame blocks, against a budget of 2.667 ms a
 * block.
 *
 *   1. Songs, rendered through `SongPlayer` as a bounce or a game plays them,
 *      console and all: the audit's eight-track song, the same doubled, and
 *      a heavy song made of the library's newest and costliest voices.
 *   2. Every instrument on the shelf on its own, holding a chord (or playing
 *      a beat, for a kit): which ones a song can least afford.
 *   3. Every module on its own, fed a saw: nanoseconds a sample.
 *
 * Not a check: nothing passes or fails. Run with `npm run bench`; set
 * BENCH_SECONDS to time longer (the default is 12 s of audio a song).
 */
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { GraphEngine } from '../src/dsp/GraphEngine'
import { compile } from '../src/patch/compile'
import { MODULE_DEFS } from '../src/patch/defs'
import { LIBRARY, type Template } from '../src/patch/library'
import type { Cable, Patch } from '../src/patch/types'
import { kitRow, noteTarget } from '../src/song/bind'
import type { Rack } from '../src/song/project'
import { SongPlayer } from '../src/song/runtime'
import { PPQ, type Note, type Song, type Track } from '../src/song/types'

const SR = 48000
const BLOCK = 128
const BUDGET_US = (BLOCK / SR) * 1e6
const SECONDS = Number(process.env.BENCH_SECONDS ?? 12)

// Garbage collections while timing, from V8's own reports.
let gcs = 0
new PerformanceObserver((list) => {
  gcs += list.getEntries().length
}).observe({ entryTypes: ['gc'] })

const byId = (id: string): Template => {
  const t = LIBRARY.find((x) => x.id === id)
  if (!t) throw new Error(`no instrument ${id}`)
  return t
}

// --- the songs ----------------------------------------------------------------

type Part = 'chords' | 'bass' | 'lead' | 'beat'

/** Eight bars of one part, on the rows the roll would use. */
function notesFor(track: string, part: Part, kit: boolean): Note[] {
  const bar = PPQ * 4
  const notes: Note[] = []
  if (part === 'beat' || kit) {
    for (let b = 0; b < 8; b++) {
      for (let s = 0; s < 16; s++) {
        const tick = b * bar + (s * PPQ) / 4
        notes.push({ track, tick, length: PPQ / 8, pitch: kitRow(42), velocity: s % 4 === 0 ? 0.9 : 0.6 })
        if (s % 8 === 0) notes.push({ track, tick, length: PPQ / 8, pitch: kitRow(36), velocity: 1 })
        if (s % 8 === 4) notes.push({ track, tick, length: PPQ / 8, pitch: kitRow(38), velocity: 1 })
      }
    }
    return notes
  }
  if (part === 'chords') {
    // Three-note chords every two seconds at 120 bpm: a bar each.
    const roots = [0, 5, 7, 3, 0, 5, 7, 3]
    roots.forEach((r, b) => {
      for (const i of [0, 4, 7]) notes.push({ track, tick: b * bar, length: bar, pitch: 12 + r + i, velocity: 0.8 })
    })
  } else if (part === 'bass') {
    for (let e = 0; e < 64; e++) notes.push({ track, tick: (e * PPQ) / 2, length: PPQ / 2 - 20, pitch: [0, 0, 12, 0, 5, 5, 7, 3][e % 8], velocity: 0.9 })
  } else {
    const tune = [12, 14, 16, 19, 16, 14, 12, 7]
    for (let q = 0; q < 32; q++) notes.push({ track, tick: q * PPQ, length: PPQ - 30, pitch: tune[q % 8] + 12, velocity: 0.85 })
  }
  return notes
}

function songOf(parts: [string, Part][]): { song: Song; racks: Record<string, Rack> } {
  const tracks: Track[] = []
  const racks: Record<string, Rack> = {}
  const notes: Note[] = []
  parts.forEach(([instrument, part], i) => {
    const id = `t${i + 1}`
    const built = byId(instrument).build()
    tracks.push({ id, name: `${instrument} ${i + 1}`, patch: instrument, gain: 0.5 })
    racks[id] = { patch: built.patch, values: built.values }
    const kit = noteTarget(built.patch)?.kind === 'kit'
    notes.push(...notesFor(id, part, kit))
  })
  const song: Song = {
    tempo: 120,
    tracks,
    patterns: [{ id: 'a', name: 'A', length: PPQ * 32, notes }],
    playlist: [{ pattern: 'a', tick: 0 }],
  }
  return { song, racks }
}

interface Timing {
  meanUs: number
  p99Us: number
  worstUs: number
  gcs: number
}

/** Blocks of `render` timed one at a time, after a warm-up the JIT is given first. */
function time(render: (l: Float32Array, r: Float32Array) => void, seconds = SECONDS): Timing {
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  const warm = Math.round((2 * SR) / BLOCK)
  for (let i = 0; i < warm; i++) render(l, r)
  const blocks = Math.round((seconds * SR) / BLOCK)
  const each = new Float64Array(blocks)
  gcs = 0
  for (let i = 0; i < blocks; i++) {
    const t0 = performance.now()
    render(l, r)
    each[i] = (performance.now() - t0) * 1000
  }
  const sorted = Array.from(each).sort((a, b) => a - b)
  return {
    meanUs: sorted.reduce((a, v) => a + v, 0) / blocks,
    p99Us: sorted[Math.floor(blocks * 0.99)],
    worstUs: sorted[blocks - 1],
    gcs,
  }
}

const pct = (us: number) => `${((us / BUDGET_US) * 100).toFixed(0)}%`
const row = (name: string, t: Timing) =>
  `  ${name.padEnd(34)} ${t.meanUs.toFixed(0).padStart(6)} us  ${pct(t.meanUs).padStart(5)}  ${(BUDGET_US / t.meanUs).toFixed(2).padStart(5)}x rt   p99 ${t.p99Us.toFixed(0).padStart(5)}   worst ${t.worstUs.toFixed(0).padStart(5)}   gc ${t.gcs}`

function benchSong(name: string, parts: [string, Part][]) {
  const { song, racks } = songOf(parts)
  const player = new SongPlayer(song, racks, { sampleRate: SR, loop: { from: 0, to: PPQ * 32 } })
  console.log(row(name, time((l, r) => player.render(l, r))))
}

const AUDIT: [string, Part][] = [
  ['strings', 'chords'],
  ['epiano', 'chords'],
  ['synthbass', 'bass'],
  ['sawlead', 'lead'],
  ['warmpad', 'chords'],
  ['drumkit', 'beat'],
  ['guitar', 'chords'],
  ['brass', 'chords'],
]

const HEAVY: [string, Part][] = [
  ['cloudpad', 'chords'],
  ['frozenpad', 'chords'],
  ['supersawpad', 'chords'],
  ['highstrings', 'chords'],
  ['cathedralpad', 'chords'],
  ['crystalpad', 'chords'],
  ['kitcinematic', 'beat'],
  ['kit909', 'beat'],
  ['bass808', 'bass'],
  ['neurobass', 'bass'],
  ['minilead', 'lead'],
  ['talkbox', 'lead'],
]

if (!process.env.BENCH_INSTRUMENTS) {
console.log(`\nsongs  (budget ${BUDGET_US.toFixed(0)} us a block; ${SECONDS} s of audio each)`)
benchSong('audit 8-track song', AUDIT)
benchSong('the same, twice over (16 tracks)', [...AUDIT, ...AUDIT])
// BENCH_ONLY=audit stops here: the songs any version of the library can play,
// for comparing one commit with another.
if (process.env.BENCH_ONLY === 'audit') process.exit(0)
benchSong('heavy: 12 of the newest voices', HEAVY)
benchSong('heavy, twice over (24 tracks)', [...HEAVY, ...HEAVY])
}

// --- every instrument ---------------------------------------------------------

console.log('\ninstruments, one each, playing  (us a block)')
{
  const results: { name: string; shelf: string; us: number }[] = []
  // BENCH_INSTRUMENTS=id,id times only those, and nothing else.
  const only = process.env.BENCH_INSTRUMENTS?.split(',')
  for (const t of LIBRARY.filter((x) => x.category !== 'tutorial' && !x.group && (!only || only.includes(x.id)))) {
    const built = t.build()
    const kit = noteTarget(built.patch)?.kind === 'kit'
    const part: Part = kit ? 'beat' : t.category === 'drums' || t.category === 'sfx' || t.category === 'ambience' ? 'beat' : t.category === 'bass' || t.category === 'leads' ? 'lead' : 'chords'
    const { song, racks } = songOf([[t.id, part]])
    const player = new SongPlayer(song, racks, { sampleRate: SR, loop: { from: 0, to: PPQ * 32 } })
    results.push({ name: t.name, shelf: t.category, us: time((l, r) => player.render(l, r), 3).meanUs })
  }
  results.sort((a, b) => b.us - a.us)
  for (const r of results.slice(0, 20)) console.log(`  ${r.name.padEnd(28)} ${r.shelf.padEnd(9)} ${r.us.toFixed(0).padStart(5)} us  ${pct(r.us).padStart(4)}`)
  const mean = results.reduce((a, r) => a + r.us, 0) / results.length
  console.log(`  ... ${results.length} instruments, mean ${mean.toFixed(0)} us (${pct(mean)}), cheapest ${results[results.length - 1].us.toFixed(0)} us`)
}

// --- every module -------------------------------------------------------------

if (process.env.BENCH_INSTRUMENTS) process.exit(0)
console.log('\nmodules, one each, fed a saw  (ns a sample, over a rack with nothing in it)')
{
  const cable = (from: string, to: string): Cable => {
    const [fm, fp] = from.split('.')
    const [tm, tp] = to.split('.')
    return { id: `${from}-${to}`, from: { module: fm, port: fp }, to: { module: tm, port: tp } }
  }
  const run = (patch: Patch) => {
    const compiled = compile(patch)
    const engine = new GraphEngine(compiled, SR, compiled.params)
    engine.setGate(true)
    return time((l, r) => engine.render(l, r), 2).meanUs
  }
  const bare = (extra: Patch['modules'], cables: Cable[]): Patch => ({
    modules: [{ id: 'src', type: 'osc', params: { pitch: 110, wave: 0 } }, ...extra, { id: 'end', type: 'mixer', params: {} }],
    cables,
  })
  const floor = run(bare([], [cable('src.out', 'end.in1')]))
  const results: { type: string; ns: number }[] = []
  for (const def of Object.values(MODULE_DEFS)) {
    if (['mixer', 'kit', 'rec', 'scope', 'sampler'].includes(def.type)) continue
    const input = def.inputs[0]?.id
    const output = def.outputs[0]?.id
    const cables = [cable('src.out', 'end.in1')]
    if (input) cables.push(cable('src.out', `sut.${input}`))
    if (output) cables.push(cable(`sut.${output}`, 'end.in2'))
    const us = run(bare([{ id: 'sut', type: def.type, params: {} }], cables))
    results.push({ type: def.type, ns: ((us - floor) * 1000) / BLOCK })
  }
  results.sort((a, b) => b.ns - a.ns)
  const cols = 4
  for (let i = 0; i < results.length; i += cols) {
    console.log('  ' + results.slice(i, i + cols).map((r) => `${r.type.padEnd(8)} ${r.ns.toFixed(0).padStart(4)}`).join('     '))
  }
}
