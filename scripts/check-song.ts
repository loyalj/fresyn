/**
 * Headless checks for the song layer and for scheduled events.
 *
 * Two things are being proved here, and the second is the one that matters.
 *
 * The first is that an arrangement turns into the events it should: windows
 * that tile without dropping or repeating a note, a pattern that means the
 * same thing wherever it is placed, and solo and mute behaving the way a desk
 * does.
 *
 * The second is that a scheduled note lands on the sample it was stamped for,
 * and on the same sample whatever size buffer the rack is being rendered in.
 * That is what makes a bounce sound like what was playing: the speakers hear
 * 128 samples at a time and an offline render can use any block it likes, and
 * if those two disagree by even one sample the rendered file is not the take
 * anybody approved.
 *
 * Run with: npm run check:song
 */
import { GraphEngine, type EngineEvent } from '../src/dsp/GraphEngine'
import { SongEngine } from '../src/dsp/SongEngine'
import { compile } from '../src/patch/compile'
import type { Cable, Patch, PatchModule } from '../src/patch/types'
import { engineEvents, noteTarget } from '../src/song/bind'
import {
  addPattern,
  contextNotes,
  firstPlacement,
  addMarker,
  markersOf,
  movePlacement,
  patternOnly,
  removeMarker,
  renameMarker,
  reorderTracks,
  sectionAt,
  setMeter,
  updatePattern,
  placementAt,
  removePattern,
  removeTrack,
  setPatternLength,
  soloTrack,
  togglePlacement,
} from '../src/song/edit'
import { fromStoredProject, toStoredProject } from '../src/song/project'
import { renderSong, renderStems } from '../src/audio/renderSong'
import { updateConsole, updateStrip } from '../src/song/edit'
import { SongPlayer, loadProject } from '../src/song/runtime'
import { framesPerTick, songEnd, songEvents, type SongEvent } from '../src/song/schedule'
import { fill, playheadTick } from '../src/song/transport'
import {
  copyNotes,
  duplicateNotes,
  humanizeNotes,
  moveNotes,
  notesIn,
  pasteNotes,
  quantizeNotes,
  removeNotes,
  shiftVelocity,
  stretchEnds,
  stretchStarts,
  transposeNotes,
} from '../src/song/noteEdit'
import { degreesBetween, inScale, nearestInScale, stepInScale } from '../src/song/scale'
import { chordById, chordPitches } from '../src/song/chord'
import { parseSong } from '../src/song/serialize'
import { barTicks, beatTicks, PPQ, type Song } from '../src/song/types'

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

const mod = (id: string, type: string, params: Record<string, number> = {}): PatchModule => ({
  id,
  type,
  params,
})

/**
 * Run a patch with a list of events queued against it.
 *
 * `block` is the point of the whole exercise: the same events rendered in
 * different sized chunks have to come out identical, so it is a parameter
 * rather than a constant.
 */
function run(
  patch: Patch,
  events: EngineEvent[],
  frames: number,
  block = 128,
  params: Record<string, number> = {},
) {
  const compiled = compile(patch)
  const initial = compiled.params.slice()
  for (const [key, value] of Object.entries(params)) {
    const index = compiled.paramIndex[key]
    if (index === undefined) throw new Error(`no such param: ${key}`)
    initial[index] = value
  }

  const engine = new GraphEngine(compiled, SR, initial)
  // The recorder is the clean probe: a tap and nothing else, so a control
  // voltage patched to it arrives as itself rather than through the mixer.
  engine.setTap('recorder')
  for (const e of events) engine.schedule(e)

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const bl = new Float32Array(block)
  const br = new Float32Array(block)
  for (let i = 0; i < frames; i += block) {
    engine.render(bl, br)
    const n = Math.min(block, frames - i)
    left.set(bl.subarray(0, n), i)
    right.set(br.subarray(0, n), i)
  }
  return { left, right, engine }
}

/** Two event lists holding the same things, in the same order. */
function sameEvents(a: readonly SongEvent[], b: readonly SongEvent[]) {
  const key = (e: SongEvent) => `${e.frame}:${e.track}:${e.kind}:${e.pitch}:${e.velocity}`
  return a.length === b.length && a.every((e, i) => key(e) === key(b[i]))
}

/** How many times a signal crosses a threshold upward. */
function rises(buf: Float32Array, threshold = 0.5) {
  let n = 0
  let was = false
  for (const v of buf) {
    const now = v > threshold
    if (now && !was) n++
    was = now
  }
  return n
}

/** The first sample at which a signal crosses a threshold upward. */
const firstAbove = (buf: Float32Array, threshold: number) => buf.findIndex((v) => v > threshold)
/** And the first at which it falls back, having been above it. */
function firstBelow(buf: Float32Array, threshold: number, after: number) {
  for (let i = Math.max(after, 0); i < buf.length; i++) if (buf[i] <= threshold) return i
  return -1
}

// A pitched voice: the keyboard's gate and pitch, taken straight off the
// module so a test measures the note rather than something downstream of it.
const keysPatch: Patch = {
  modules: [mod('key1', 'keys'), mod('rec1', 'rec')],
  cables: [cable('key1', 'gate', 'rec1', 'l')],
}
const pitchPatch: Patch = {
  modules: [mod('key1', 'keys'), mod('rec1', 'rec')],
  cables: [cable('key1', 'pitch', 'rec1', 'l'), cable('key1', 'vel', 'rec1', 'r')],
}

const note = (frame: number, pitch: number, velocity = 1): EngineEvent => ({
  frame,
  kind: 'noteOn',
  module: 'key1',
  pitch,
  velocity,
})
const off = (frame: number): EngineEvent => ({ frame, kind: 'noteOff', module: 'key1' })
const offAt = (frame: number, pitch: number): EngineEvent => ({ frame, kind: 'noteOff', module: 'key1', pitch })

console.log('\ntick arithmetic')
{
  // 120 bpm, 960 ticks to the quarter: a beat is half a second, so a tick is
  // 25 samples at 48k and a quarter note is exactly 24000 of them.
  const fpt = framesPerTick(120, SR)
  check('a tick is 25 samples at 120bpm/48k', fpt === 25, `got ${fpt}`)
  check('a quarter note is 24000 samples', PPQ * fpt === 24000, `got ${PPQ * fpt}`)
  check('tempo scales it', framesPerTick(60, SR) === 50, `got ${framesPerTick(60, SR)}`)
}

console.log('\nscheduled notes land on their own sample')
{
  // Deliberately not a multiple of 128: a note on a block boundary would pass
  // even if the events were still being applied a block at a time, which is
  // the exact bug this whole mechanism exists to remove.
  for (const at of [1, 127, 128, 129, 1234, 5000]) {
    const { left } = run(keysPatch, [note(at, 0)], 8192)
    check(`gate opens at frame ${at}`, firstAbove(left, 0.5) === at, `got ${firstAbove(left, 0.5)}`)
  }

  const { left } = run(keysPatch, [note(1000, 0), off(3777)], 8192)
  check(
    'gate shuts at its own frame',
    firstBelow(left, 0.5, 1000) === 3777,
    `got ${firstBelow(left, 0.5, 1000)}`,
  )
}

console.log('\nblock size changes nothing')
{
  // A real voice this time, so the comparison covers oscillator phase and
  // envelope state rather than a step function.
  const voice: Patch = {
    modules: [
      mod('key1', 'keys'),
      mod('osc1', 'osc', { fmAmount: 1, envAmount: 1, pitch: 110 }),
      mod('rec1', 'rec'),
    ],
    cables: [
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('key1', 'gate', 'osc1', 'gate'),
      cable('osc1', 'out', 'rec1', 'l'),
    ],
  }
  const events = [note(333, 7, 0.8), off(9000), note(11111, 12, 0.4), off(20000)]
  const frames = 24000
  const reference = run(voice, events, frames, 128).left
  for (const block of [1, 37, 64, 256, 1000, 24000]) {
    const other = run(voice, events, frames, block).left
    let worst = 0
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(reference[i] - other[i]))
    check(`block of ${block} matches a block of 128`, worst === 0, `worst diff ${worst}`)
  }
}

console.log('\npitch and velocity')
{
  const { left, right } = run(pitchPatch, [note(100, 12, 0.5)], 4096)
  // Pitch is in octaves: twelve semitones is one.
  check('twelve semitones is one octave', left[200] === 1, `got ${left[200]}`)
  check(
    'pitch arrives on the note frame',
    left[99] === 0 && left[100] === 1,
    `${left[99]} / ${left[100]}`,
  )
  check('velocity arrives with it', Math.abs(right[200] - 0.5) < 1e-6, `got ${right[200]}`)
  check('velocity is full before any note', right[50] === 1, `got ${right[50]}`)

  // The octave switch moves a sequenced note as well as a pressed one, so on
  // a track in a song it is a transpose.
  const shifted = run(pitchPatch, [note(100, 12, 1)], 4096, 128, { 'key1.octave': -1 })
  check(
    'the octave switch transposes a sequenced note',
    shifted.left[200] === 0,
    `got ${shifted.left[200]}`,
  )

  // The tail is the reason this matters: an envelope is still releasing after
  // the gate shuts, and the pitch and velocity it is releasing at must not
  // jump back to whatever the panel was set to.
  const held = run(pitchPatch, [note(100, 12, 0.5), off(500)], 4096)
  check('pitch survives note-off', held.left[1000] === 1, `got ${held.left[1000]}`)
  check(
    'velocity survives note-off',
    Math.abs(held.right[1000] - 0.5) < 1e-6,
    `got ${held.right[1000]}`,
  )
}

console.log('\na hand takes the keyboard back')
{
  // Turning the note knob is what a panel key press does, and it has to win:
  // auditioning a patch by hand after a sequenced note must not play at
  // whatever velocity that note happened to carry.
  const compiled = compile(pitchPatch)
  const engine = new GraphEngine(compiled, SR, compiled.params.slice())
  engine.setTap('recorder')
  engine.schedule(note(10, 24, 0.25))
  const l = new Float32Array(128)
  const r = new Float32Array(128)
  engine.render(l, r)
  check('the sequenced note sounds', l[64] === 2 && Math.abs(r[64] - 0.25) < 1e-6, `${l[64]} / ${r[64]}`)

  engine.setParam(compiled.paramIndex['key1.note'], 12)
  engine.render(l, r)
  check('the panel note takes over', l[64] === 1, `got ${l[64]}`)
  check('and velocity goes back to full', r[64] === 1, `got ${r[64]}`)
}

console.log('\nan edited patch does not break playback')
{
  // Events already queued against a module that has just been deleted are
  // simply past. The rack has to keep running: a patch is edited while the
  // song plays, and that is the whole point of building it into this app.
  const compiled = compile(keysPatch)
  const engine = new GraphEngine(compiled, SR, compiled.params.slice())
  engine.setTap('recorder')
  engine.schedule(note(4000, 0))
  const stripped = compile({ modules: [mod('rec1', 'rec')], cables: [] })
  engine.rebuild(stripped, stripped.params.slice())
  const l = new Float32Array(8192)
  const r = new Float32Array(8192)
  let threw = false
  try {
    engine.render(l, r)
  } catch {
    threw = true
  }
  check('a note for a deleted module is a no-op', !threw && firstAbove(l, 0.5) === -1)
}

// --- the arrangement ---------------------------------------------------

function song(over: Partial<Song> = {}): Song {
  return {
    tempo: 120,
    tracks: [
      { id: 'lead', name: 'Lead', patch: 'p1', gain: 1 },
      { id: 'drum', name: 'Drum', patch: 'p2', gain: 1 },
    ],
    patterns: [
      {
        id: 'a',
        name: 'A',
        length: PPQ * 4,
        notes: [
          { track: 'lead', tick: 0, length: PPQ, pitch: 0, velocity: 1 },
          { track: 'lead', tick: PPQ, length: PPQ, pitch: 4, velocity: 0.5 },
          { track: 'drum', tick: 0, length: 120, pitch: 0, velocity: 1 },
        ],
      },
    ],
    playlist: [{ pattern: 'a', tick: 0 }],
    ...over,
  }
}

console.log('\nan arrangement becomes events')
{
  const s = song()
  const all = songEvents(s, SR, 0, PPQ * 4)
  check('every note gives an on and an off', all.length === 6, `got ${all.length}`)
  check('the song is four beats long', songEnd(s) === PPQ * 4, `got ${songEnd(s)}`)

  const leadOns = all.filter((e) => e.track === 'lead' && e.kind === 'on')
  check('first note is at frame 0', leadOns[0].frame === 0, `got ${leadOns[0].frame}`)
  check('second is a beat later', leadOns[1].frame === 24000, `got ${leadOns[1].frame}`)
  check('and carries its velocity', leadOns[1].velocity === 0.5, `got ${leadOns[1].velocity}`)
  check('and its pitch', leadOns[1].pitch === 4, `got ${leadOns[1].pitch}`)

  // A note whose end meets the next note's start has to let go first, or the
  // off closes the gate the new note just opened and the line goes silent.
  const atBeat = all.filter((e) => e.frame === 24000 && e.track === 'lead')
  check(
    'a release sorts before a press at the same frame',
    atBeat[0].kind === 'off' && atBeat[1].kind === 'on',
  )
}

console.log('\nwindows tile the song exactly')
{
  const s = song()
  const whole = songEvents(s, SR, 0, PPQ * 4)
  const tiled = []
  // Deliberately uneven, and not aligned to anything in the pattern.
  for (let t = 0; t < PPQ * 4; t += 317) tiled.push(...songEvents(s, SR, t, t + 317))
  check(
    'no event is dropped or repeated',
    tiled.length === whole.length,
    `${tiled.length} vs ${whole.length}`,
  )
  const key = (e: { frame: number; track: string; kind: string }) => `${e.frame}:${e.track}:${e.kind}`
  check('and they are the same events', tiled.map(key).sort().join() === whole.map(key).sort().join())

  // Half-open: a note on the boundary belongs to the later window and is
  // emitted once, not by both neighbours.
  const before = songEvents(s, SR, 0, PPQ)
  const after = songEvents(s, SR, PPQ, PPQ * 2)
  check(
    'a note on the boundary falls in the later window',
    before.every((e) => e.frame !== 24000) && after.some((e) => e.frame === 24000 && e.kind === 'on'),
  )
}

console.log('\nplacement, length and silence')
{
  // The same pattern placed twice plays twice, offset by where it sits.
  const s = song({
    playlist: [
      { pattern: 'a', tick: 0 },
      { pattern: 'a', tick: PPQ * 4 },
    ],
  })
  const ons = songEvents(s, SR, 0, PPQ * 8).filter((e) => e.kind === 'on' && e.track === 'lead')
  check('a pattern placed twice plays twice', ons.length === 4, `got ${ons.length}`)
  check('the second copy is offset by the placement', ons[2].frame === 96000, `got ${ons[2].frame}`)
  check('the song runs to the end of the last placement', songEnd(s) === PPQ * 8, `got ${songEnd(s)}`)

  // A note running past the end of its own pattern is cut there, or it would
  // sound over whatever was placed next.
  const long = song()
  long.patterns[0].notes = [{ track: 'lead', tick: PPQ * 3, length: PPQ * 4, pitch: 0, velocity: 1 }]
  const cutOff = songEvents(long, SR, 0, PPQ * 8).filter((e) => e.kind === 'off')[0]
  check('a note is cut at the end of its pattern', cutOff.frame === PPQ * 4 * 25, `got ${cutOff.frame}`)

  // And one sitting past the end never sounds at all.
  const outside = song()
  outside.patterns[0].notes = [{ track: 'lead', tick: PPQ * 5, length: PPQ, pitch: 0, velocity: 1 }]
  check('a note past the end of its pattern is silent', songEvents(outside, SR, 0, PPQ * 8).length === 0)

  // A note of no length still has to close the gate it opened.
  const zero = song()
  zero.patterns[0].notes = [{ track: 'lead', tick: 0, length: 0, pitch: 0, velocity: 1 }]
  const zeroEvents = songEvents(zero, SR, 0, PPQ * 4)
  check('a zero-length note still closes', zeroEvents.length === 2 && zeroEvents[1].kind === 'off')
}

console.log('\nmute and solo')
{
  const muted = song()
  muted.tracks[1].mute = true
  check('a muted track is silent', songEvents(muted, SR, 0, PPQ * 4).every((e) => e.track !== 'drum'))

  const soloed = song()
  soloed.tracks[1].solo = true
  const only = songEvents(soloed, SR, 0, PPQ * 4)
  check('a solo silences everything else', only.every((e) => e.track === 'drum'), `${only.length} events`)

  // Solo beats mute, which is what every desk does.
  const both = song()
  both.tracks[1].solo = true
  both.tracks[1].mute = true
  check('solo wins over mute on the same track', songEvents(both, SR, 0, PPQ * 4).some((e) => e.track === 'drum'))
}

console.log('\nfinding what to play in a patch')
{
  check('a keyboard makes a patch pitched', noteTarget(keysPatch)?.kind === 'note')
  check('and names the module', noteTarget(keysPatch)?.module === 'key1')

  const drum: Patch = {
    modules: [mod('gate1', 'gate'), mod('osc1', 'osc'), mod('rec1', 'rec')],
    cables: [cable('gate1', 'gate', 'osc1', 'gate'), cable('osc1', 'out', 'rec1', 'l')],
  }
  const target = noteTarget(drum)
  check('a patch with no keyboard is a drum', target?.kind === 'trigger' && target.module === 'gate1')

  // The sequencer has a trigger button, but firing it would play something in
  // the middle of the patch rather than playing the patch.
  const seqOnly: Patch = { modules: [mod('seq1', 'seq'), mod('rec1', 'rec')], cables: [] }
  check('a trigger button is not a way in', noteTarget(seqOnly) === null)

  const events = songEvents(song(), SR, 0, PPQ * 4).filter((e) => e.track === 'lead')
  const pitched = engineEvents(events, { module: 'key1', kind: 'note' })
  check('a pitched track gets notes', pitched[0].kind === 'noteOn' && pitched[1].kind === 'noteOff')
  // A drum track goes down the same path, because a plain gate cannot carry a
  // retrigger and two hits on one sixteenth would come out as one.
  const triggered = engineEvents(events, { module: 'gate1', kind: 'trigger' })
  check(
    'a drum track gets notes too',
    triggered[0].kind === 'noteOn' && triggered[1].kind === 'noteOff',
  )
  check(
    'and they are addressed to its trigger',
    triggered.every((e) => 'module' in e && e.module === 'gate1'),
  )
}

console.log('\ntwo hits in a row are two hits')
{
  // The drum case of the same bug: a Trigger on `once` fires on a rising
  // edge, and back-to-back notes would close and reopen its gate between two
  // samples. Counting edges rather than looking at one sample, so this says
  // what it means -- the second hit either happened or it did not.
  const drum: Patch = {
    modules: [mod('gate1', 'gate', { mode: 1, length: 0.005 }), mod('rec1', 'rec')],
    cables: [cable('gate1', 'gate', 'rec1', 'l')],
  }
  const hit = (frame: number, kind: 'noteOn' | 'noteOff'): EngineEvent =>
    kind === 'noteOn'
      ? { frame, kind, module: 'gate1', pitch: 0, velocity: 1 }
      : { frame, kind, module: 'gate1' }

  const adjacent = run(drum, [hit(0, 'noteOn'), hit(1000, 'noteOff'), hit(1000, 'noteOn'), hit(2000, 'noteOff')], 8192)
  check('two adjacent hits fire twice', rises(adjacent.left) === 2, `got ${rises(adjacent.left)}`)

  // And one hit is still one hit: the gap is owed only when a note lands on a
  // gate that is already up.
  const single = run(drum, [hit(0, 'noteOn'), hit(1000, 'noteOff')], 8192)
  check('a single hit fires once', rises(single.left) === 1, `got ${rises(single.left)}`)

  // Held mode has the same problem and the same answer.
  const held: Patch = {
    modules: [mod('gate1', 'gate', { mode: 0 }), mod('rec1', 'rec')],
    cables: [cable('gate1', 'gate', 'rec1', 'l')],
  }
  const two = run(held, [hit(0, 'noteOn'), hit(1000, 'noteOff'), hit(1000, 'noteOn'), hit(2000, 'noteOff')], 8192)
  check('held mode retriggers as well', rises(two.left) === 2, `got ${rises(two.left)}`)

  // A clock patched into the Trigger must be untouched by any of this: the
  // gap is owed to notes, and nothing here is playing one.
  const clocked: Patch = {
    modules: [mod('clk1', 'clock', { rate: 8, width: 0.5 }), mod('gate1', 'gate', { mode: 0 }), mod('rec1', 'rec')],
    cables: [cable('clk1', 'x1', 'gate1', 'trig'), cable('gate1', 'gate', 'rec1', 'l')],
  }
  const ticked = run(clocked, [], SR)
  check('a clock into the Trigger still ticks', rises(ticked.left) === 8, `got ${rises(ticked.left)}`)
}

console.log('\nend to end: an arrangement plays the rack')
{
  // The whole path, in the order the app will use it: a song, scheduled into
  // an engine through the binding, rendered, and measured at the jack.
  const s = song()
  const target = noteTarget(keysPatch)!
  const { left } = run(
    keysPatch,
    engineEvents(
      songEvents(s, SR, 0, PPQ * 4).filter((e) => e.track === 'lead'),
      target,
    ),
    PPQ * 4 * 25,
  )
  check('the first note opens the gate at zero', left[0] === 1)
  // Two notes back to back. The first one's release and the second one's
  // press land on the same sample, so the gate is forced down for exactly one
  // of them -- which is the rising edge every envelope downstream is waiting
  // for, and the difference between two eighth notes and one held drone.
  check(
    'the first note runs up to the second',
    left[23999] === 1,
    `got ${left[23999]}`,
  )
  check(
    'it retriggers between the two notes',
    left[24000] === 0 && left[24001] === 1,
    `${left[24000]} / ${left[24001]}`,
  )
  check(
    'and shuts at the end of the second',
    firstBelow(left, 0.5, 24001) === 48000,
    `got ${firstBelow(left, 0.5, 24001)}`,
  )
}

console.log('\nfilling windows ahead of the speakers')
{
  const s = song()
  const whole = songEvents(s, SR, 0, PPQ * 4)

  // One fill reaching the end of the song gives exactly what a bounce would.
  const one = fill(s, SR, { tick: 0, frame: 0 }, 96000, null)
  check(
    'a single fill matches the whole song',
    sameEvents(one.events, whole),
    `${one.events.length} vs ${whole.length}`,
  )
  check(
    'and leaves the cursor at the end',
    one.cursor.tick === PPQ * 4 && one.cursor.frame === 96000,
    `${one.cursor.tick} / ${one.cursor.frame}`,
  )
  check('a song with nothing left says so', fill(s, SR, one.cursor, 120000, null).ended)

  // And so does any number of fills, wherever their edges fall. This is the
  // one that matters: the lookahead lands wherever the audio callback happens
  // to be, so no window boundary may drop a note or play one twice.
  let cursor = { tick: 0, frame: 0 }
  const tiled: SongEvent[] = []
  for (let f = 1234; f <= 96000 + 1234; f += 1234) {
    const step = fill(s, SR, cursor, f, null)
    tiled.push(...step.events)
    cursor = step.cursor
  }
  check('many uneven fills match one', sameEvents(tiled, whole), `${tiled.length} vs ${whole.length}`)
}

console.log('\nlooping does not drift')
{
  const s = song()
  const loop = { from: 0, to: PPQ }
  // Ten times round a one-beat loop. Frames are accumulated as fractions and
  // only rounded per event, so the tenth pass has to land on exactly the same
  // sample as counting beats would give -- half a sample rounded off per
  // window would be a whole beat adrift after a few minutes.
  const out = fill(s, SR, { tick: 0, frame: 0 }, 24000 * 10, loop)
  const leadOns = out.events.filter((e) => e.track === 'lead' && e.kind === 'on')
  check('ten passes give ten notes', leadOns.length === 10, `got ${leadOns.length}`)
  check(
    'every pass lands on the beat',
    leadOns.every((e, i) => e.frame === i * 24000),
    leadOns.map((e) => e.frame).join(' '),
  )

  // Every seam closes whatever was still sounding, or a note held across the
  // loop point would have nothing left to end it.
  const seams = out.events.filter((e) => e.kind === 'off' && e.frame === 24000)
  check('the seam releases every track', seams.length === s.tracks.length, `got ${seams.length}`)
  check(
    'and it sorts before the note that follows',
    out.events.findIndex((e) => e.frame === 24000 && e.kind === 'off') <
      out.events.findIndex((e) => e.frame === 24000 && e.kind === 'on'),
  )

  // A loop shorter than a tick cannot be allowed to spin forever.
  const degenerate = fill(s, SR, { tick: 0, frame: 0 }, 480000, { from: 100, to: 100 })
  check('a loop of no length is refused', degenerate.events.length === 0)
}

console.log('\nthe playhead')
{
  const loop = { from: 0, to: PPQ }
  check(
    'it advances with the frames',
    playheadTick(12000, 0, 0, 120, SR, null) === PPQ / 2,
    `got ${playheadTick(12000, 0, 0, 120, SR, null)}`,
  )
  check(
    'it wraps at the end of the loop',
    playheadTick(36000, 0, 0, 120, SR, loop) === PPQ / 2,
    `got ${playheadTick(36000, 0, 0, 120, SR, loop)}`,
  )
  check(
    'it stays inside the loop before the start frame',
    playheadTick(-12000, 0, 0, 120, SR, loop) === PPQ / 2,
    `got ${playheadTick(-12000, 0, 0, 120, SR, loop)}`,
  )
}

console.log('\nend to end: a loop plays the rack')
{
  // Three times round, into a real engine, measured at the jack. A seam that
  // failed to release would show up here as one long gate instead of three.
  const s = song()
  const loop = { from: 0, to: PPQ }
  const out = fill(s, SR, { tick: 0, frame: 0 }, 24000 * 3, loop)
  const target = noteTarget(keysPatch)!
  const { left } = run(
    keysPatch,
    engineEvents(
      out.events.filter((e) => e.track === 'lead'),
      target,
    ),
    24000 * 3,
  )
  check('three passes are three notes', rises(left) === 3, `got ${rises(left)}`)
}


// --- several racks at once ---------------------------------------------

/** A rack that makes a steady tone and sends it to the speakers. */
function tonePatch(pitch: number): Patch {
  return {
    modules: [mod('osc1', 'osc', { pitch, wave: 3, level: 1 }), mod('mix1', 'mixer')],
    cables: [cable('osc1', 'out', 'mix1', 'in1')],
  }
}

function runTracks(
  patches: Record<string, Patch>,
  frames: number,
  setup?: (e: SongEngine) => void,
) {
  const tracks = Object.entries(patches).map(([id, p]) => {
    const compiled = compile(p)
    return { id, patch: compiled, params: compiled.params.slice() }
  })
  const engine = new SongEngine(SR, tracks)
  setup?.(engine)

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
  return { left, right, engine }
}

const rms = (buf: Float32Array) => {
  let sum = 0
  for (const v of buf) sum += v * v
  return Math.sqrt(sum / buf.length)
}

console.log('\nracks sum without reaching each other')
{
  const one = runTracks({ a: tonePatch(220) }, 8192)
  const two = runTracks({ a: tonePatch(220), b: tonePatch(330) }, 8192)
  check('one track makes a noise', rms(one.left) > 0.01, `rms ${rms(one.left).toFixed(3)}`)
  check('two tracks are louder than one', rms(two.left) > rms(one.left), `${rms(one.left).toFixed(3)} -> ${rms(two.left).toFixed(3)}`)

  // Exactly the sum: nothing in one rack may reach another, so two tracks
  // have to come out as the two of them added and nothing else.
  const other = runTracks({ b: tonePatch(330) }, 8192)
  let worst = 0
  for (let i = 0; i < 8192; i++) {
    worst = Math.max(worst, Math.abs(two.left[i] - (one.left[i] + other.left[i])))
  }
  check('and are exactly the two summed', worst < 1e-6, `worst ${worst}`)
}

console.log('\nmute, solo and level')
{
  const both = runTracks({ a: tonePatch(220), b: tonePatch(330) }, 8192)
  const muted = runTracks({ a: tonePatch(220), b: tonePatch(330) }, 8192, (e) =>
    e.setMix({ a: { gain: 1, audible: true }, b: { gain: 1, audible: false } }),
  )
  const soloA = runTracks({ a: tonePatch(220) }, 8192)

  let worst = 0
  for (let i = 0; i < 8192; i++) worst = Math.max(worst, Math.abs(muted.left[i] - soloA.left[i]))
  check('a silenced track is exactly absent', worst < 1e-6, `worst ${worst}`)
  check('and the rest is unchanged', rms(muted.left) < rms(both.left))

  const half = runTracks({ a: tonePatch(220) }, 8192, (e) =>
    e.setMix({ a: { gain: 0.5, audible: true } }),
  )
  let off = 0
  for (let i = 0; i < 8192; i++) off = Math.max(off, Math.abs(half.left[i] - soloA.left[i] * 0.5))
  check('level scales what a track contributes', off < 1e-6, `worst ${off}`)
}

console.log('\na track added mid-song starts in step')
{
  const compiled = compile(tonePatch(220))
  const engine = new SongEngine(SR, [{ id: 'a', patch: compiled, params: compiled.params.slice() }])
  const l = new Float32Array(1000)
  const r = new Float32Array(1000)
  engine.render(l, r)
  check('the clock has moved', engine.currentFrame === 1000, `got ${engine.currentFrame}`)

  // A rack that started counting from zero would treat every frame already
  // gone as still to come, and fire its whole first window at once.
  const second = compile(keysPatch)
  engine.setTrack('b', second, second.params.slice())
  engine.schedule('b', { frame: 1500, kind: 'noteOn', module: 'key1', pitch: 0, velocity: 1 })
  engine.render(l, r)
  check('a note before the new track existed has not fired yet', engine.currentFrame === 2000)
  check('and the engine still runs', Number.isFinite(l[0]))
}

console.log('\nevents reach the right rack')
{
  const engine = runTracks({ a: keysPatch, b: keysPatch }, 1).engine
  engine.scheduleMany([
    { frame: 0, kind: 'noteOn', module: 'key1', pitch: 12, velocity: 1, track: 'a' },
    { frame: 0, kind: 'noteOn', module: 'key1', pitch: 0, velocity: 1, track: 'nosuch' },
  ])
  const l = new Float32Array(64)
  const r = new Float32Array(64)
  let threw = false
  try {
    engine.render(l, r)
  } catch {
    threw = true
  }
  check('an event for a track that is not there is a no-op', !threw)
}

// --- editing an arrangement --------------------------------------------

console.log('\narrangement edits keep what depends on them')
{
  const base = song()

  // A track's notes go with it, or the file grows notes nothing can play and
  // the reader drops them on the way back in with nobody the wiser.
  const gone = removeTrack(base, 'drum')
  check('removing a track takes its notes', gone.patterns[0].notes.every((n) => n.track !== 'drum'))
  check('and leaves the others', gone.patterns[0].notes.length === 2, `got ${gone.patterns[0].notes.length}`)
  check('the last track cannot be removed', removeTrack(removeTrack(gone, 'lead'), 'lead').tracks.length === 1)

  // Solo is exclusive, which is what makes one button per track enough.
  const soloed = soloTrack(soloTrack(base, 'lead'), 'drum')
  check('solo moves rather than accumulating', soloed.tracks.filter((t) => t.solo).length === 1)
  check('and it is the last one pressed', soloed.tracks.find((t) => t.solo)?.id === 'drum')
  check('pressing it again clears it', soloTrack(soloed, 'drum').tracks.every((t) => !t.solo))

  // A placement is only meaningful while its pattern exists.
  const two = addPattern(base, 'b', 'B')
  const placed = togglePlacement(two, 'b', PPQ * 4)
  check('a pattern can be placed', placed.playlist.length === 2, `got ${placed.playlist.length}`)
  check('clicking it again takes it off', togglePlacement(placed, 'b', PPQ * 4).playlist.length === 1)
  check('removing a pattern takes its placements', removePattern(placed, 'b').playlist.length === 1)
  check('the last pattern cannot be removed', removePattern(base, 'a').patterns.length === 1)
}

console.log('\nwhere a placement covers')
{
  // The pattern is four beats -- one bar -- so it fills exactly one cell.
  const one = song()
  check('a bar-long pattern covers its own bar', placementAt(one, 'a', 0) === 0)
  check('and not the next', placementAt(one, 'a', PPQ * 4) === null)

  // A longer one fills several, and every cell has to be able to remove it.
  const long = setPatternLength(song(), 'a', PPQ * 8)
  check('a two-bar pattern covers the second bar too', placementAt(long, 'a', PPQ * 4) === 0)
  check('and reports where it starts', placementAt(long, 'a', PPQ * 7) === 0)
  check('but not past its end', placementAt(long, 'a', PPQ * 8) === null)
}

console.log('\nplaying one pattern rather than the arrangement')
{
  const two = togglePlacement(addPattern(song(), 'b', 'B'), 'b', PPQ * 4)
  const only = patternOnly(two, 'b')
  check('it holds one pattern', only.patterns.length === 1 && only.patterns[0].id === 'b')
  check('placed at the start', only.playlist.length === 1 && only.playlist[0].tick === 0)
  check('and keeps the tracks, so mute and solo still apply', only.tracks.length === two.tracks.length)
  check('a pattern that is not there plays nothing', patternOnly(two, 'nope').playlist.length === 0)
}

// --- the project file ---------------------------------------------------

console.log('\na project survives the round trip')
{
  const s = togglePlacement(addPattern(song(), 'b', 'B'), 'b', PPQ * 4)
  const racks = {
    lead: { patch: keysPatch, values: { 'key1.octave': -1 } },
    drum: { patch: tonePatch(220), values: {} },
  }
  const back = fromStoredProject(JSON.parse(JSON.stringify(toStoredProject('Piece', s, racks))))
  if ('error' in back) {
    check('it reads back', false, back.error)
  } else {
    check('the name comes back', back.name === 'Piece', back.name)
    check('every track comes back', back.song.tracks.length === 2)
    check('every pattern comes back', back.song.patterns.length === 2)
    check('the playlist comes back', back.song.playlist.length === 2)
    check('the notes come back', back.song.patterns[0].notes.length === 3)
    check('each track has its rack', Object.keys(back.racks).length === 2)
    check(
      'and its modules',
      back.racks.lead.patch.modules.map((m) => m.id).join() === 'key1,rec1',
      back.racks.lead.patch.modules.map((m) => m.id).join(),
    )
    // Knobs are baked into the patch on the way out and read back off it, the
    // same path a patch file takes.
    check('knobs survive', back.racks.lead.values['key1.octave'] === -1, `got ${back.racks.lead.values['key1.octave']}`)
  }
}

console.log('\nolder files still open')
{
  // A patch file from before there were projects: one rack, and the pattern
  // that was written on it. It has to come back as a project of one track.
  const legacy = {
    version: 1,
    name: 'Old rack',
    patch: keysPatch,
    song: song(),
  }
  const back = fromStoredProject(JSON.parse(JSON.stringify(legacy)))
  if ('error' in back) {
    check('a single-patch file opens', false, back.error)
  } else {
    check('a single-patch file opens as a project', back.name === 'Old rack')
    check('its pattern survives', back.song.patterns[0].notes.length === 3)
    check('and its rack lands on a track', Object.keys(back.racks).length === 1)
  }

  // One with no pattern at all -- every patch written before the roll existed.
  const plain = fromStoredProject({ version: 1, name: 'Plain', patch: keysPatch })
  check('a patch with no pattern opens too', !('error' in plain))
  check('with an empty bar to write in', !('error' in plain) && plain.song.patterns.length === 1)

  check('rubbish is refused', 'error' in fromStoredProject({ hello: true }))
  check('so is a newer format', 'error' in fromStoredProject({ version: 99, racks: {}, song: song() }))
}


// --- bouncing ----------------------------------------------------------

/** A rack a note can actually be played on, ending at the speakers. */
function voiceRack(pitch: number): Patch {
  return {
    modules: [
      mod('key1', 'keys'),
      mod('osc1', 'osc', { pitch, fmAmount: 1, envAmount: 1, decay: 0.25 }),
      mod('mix1', 'mixer'),
    ],
    cables: [
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('key1', 'gate', 'osc1', 'gate'),
      cable('osc1', 'out', 'mix1', 'in1'),
    ],
  }
}

const band = () => ({
  lead: { patch: voiceRack(110), values: {} },
  drum: { patch: voiceRack(220), values: {} },
})

/** No trimming and no fade, so two renderings can be compared sample by sample. */
const RAW = { sampleRate: SR, tailSeconds: 1, fadeMs: 0, silenceDb: -200 }

console.log('\nbouncing the arrangement')
{
  const s = song()
  const mix = await renderSong(s, band(), RAW)
  check('it makes a noise', rms(mix.left) > 0.005, `rms ${rms(mix.left).toFixed(4)}`)
  // Four beats at 120bpm is two seconds. The file is never shorter than the
  // arrangement -- that is what makes a loop tile -- and never longer than it
  // plus the tail that was asked for.
  check(
    'it is at least as long as the arrangement',
    mix.seconds >= 2 - 1e-6,
    `${mix.seconds.toFixed(3)}s`,
  )
  check('and no longer than that plus its tail', mix.seconds <= 3.01, `${mix.seconds.toFixed(3)}s`)
  check('and reports its peak', mix.peak > 0 && Number.isFinite(mix.peak), `${mix.peak}`)

  // Nothing placed is nothing to bounce, and must not be an error.
  const empty = await renderSong({ ...s, playlist: [] }, band(), RAW)
  check('an empty playlist bounces silence', empty.peak === 0, `peak ${empty.peak}`)
}

console.log('\nthe tail is kept and then trimmed')
{
  const s = song()
  // Generous tail, then trimmed back: the only cost of asking for too much is
  // a moment of arithmetic, and asking for too little cuts the last note off.
  const long = await renderSong(s, band(), { sampleRate: SR, tailSeconds: 10 })
  const short = await renderSong(s, band(), { sampleRate: SR, tailSeconds: 1 })
  check('a longer tail does not make a longer file', long.seconds <= short.seconds + 0.05,
    `${long.seconds.toFixed(2)} vs ${short.seconds.toFixed(2)}`)
  check('and the file still holds the whole bar', long.seconds >= 2 - 1e-6, `${long.seconds.toFixed(3)}s`)

  // A bar whose notes stop half way through is still a bar. Trimming it back
  // to the last audible sample would give a file that no longer tiles, which
  // for a piece of looping game music is the whole job.
  const sparse = song()
  sparse.patterns[0].notes = [{ track: 'lead', tick: 0, length: 120, pitch: 0, velocity: 1 }]
  const tiled = await renderSong(sparse, band(), { sampleRate: SR, tailSeconds: 4 })
  check('a half-empty bar still bounces whole', tiled.seconds >= 2 - 1e-6, `${tiled.seconds.toFixed(3)}s`)
  // And with nothing past the bar to fade, the cut is exactly the loop seam.
  check('with no fade inside it', tiled.seconds <= 2.01, `${tiled.seconds.toFixed(3)}s`)
}

console.log('\nstems add back up to the mix')
{
  const s = song()
  // The mix before its master bus, which is what stems are taken from: the
  // limiter works on the whole mix, so a stem cannot carry its share of it.
  const mix = await renderSong(s, band(), { ...RAW, routing: { strips: true, sends: true, master: false } })
  const stems = await renderStems(s, band(), RAW)
  check('one stem per audible track', stems.length === 2, `got ${stems.length}`)
  check('named after the tracks', stems.map((x) => x.name).join() === 'Lead,Drum', stems.map((x) => x.name).join())

  // The whole point of a stem: put them back together and you have the mix.
  // Compared over the arrangement itself rather than the tail, since each
  // rendering trims its own silence and they need not end on the same sample.
  const span = 96000
  check('every stem covers the whole arrangement', stems.every((x) => x.audio.left.length >= span),
    stems.map((x) => x.audio.left.length).join(' '))
  let worst = 0
  for (let i = 0; i < span; i++) {
    const summed = stems[0].audio.left[i] + stems[1].audio.left[i]
    worst = Math.max(worst, Math.abs(mix.left[i] - summed))
  }
  check('and they sum to it', worst < 1e-6, `worst ${worst}`)

  // Each stem holds its own track and nothing else.
  const alone = await renderSong(s, band(), { ...RAW, only: ['lead'] })
  let off = 0
  for (let i = 0; i < span; i++) off = Math.max(off, Math.abs(alone.left[i] - stems[0].audio.left[i]))
  check('a stem is that track on its own', off < 1e-6, `worst ${off}`)
}

console.log('\nmute and solo reach the bounce')
{
  const muted = song()
  muted.tracks[1].mute = true
  const stems = await renderStems(muted, band(), RAW)
  check('a muted track gets no stem at all', stems.length === 1, `got ${stems.length}`)
  check('and it is the one still playing', stems[0].track === 'lead', stems[0].track)

  // Which is what makes the set add up: the mix does not have it either.
  const mix = await renderSong(muted, band(), RAW)
  let worst = 0
  for (let i = 0; i < 96000; i++) worst = Math.max(worst, Math.abs(mix.left[i] - stems[0].audio.left[i]))
  check('the mix matches the one stem', worst < 1e-6, `worst ${worst}`)

  const soloed = song()
  soloed.tracks[1].solo = true
  const only = await renderStems(soloed, band(), RAW)
  check('a solo leaves one stem', only.length === 1 && only[0].track === 'drum')
}

console.log('\nlevels reach it too')
{
  const quiet = song()
  quiet.tracks[0].gain = 0.5
  const half = await renderSong(quiet, band(), { ...RAW, only: ['lead'] })
  const full = await renderSong(song(), band(), { ...RAW, only: ['lead'] })
  let worst = 0
  for (let i = 0; i < 96000; i++) worst = Math.max(worst, Math.abs(half.left[i] - full.left[i] * 0.5))
  check('a track level scales its stem', worst < 1e-6, `worst ${worst}`)
}

// --- the headless player ------------------------------------------------

console.log('\nthe player a game would run')
{
  const s = song()
  const player = new SongPlayer(s, band(), { sampleRate: SR })
  check('it says which tracks can be played', player.playable.length === 2, player.playable.join())

  // Any block size, same samples: a game pulling 1024 at a time and a bounce
  // walking 128 have to agree, or the music is a different piece in the game.
  const reference = await renderSong(s, band(), RAW)
  const out = new Float32Array(96000)
  const other = new Float32Array(96000)
  const bl = new Float32Array(512)
  const br = new Float32Array(512)
  for (let i = 0; i < 96000; i += 512) {
    player.render(bl, br)
    out.set(bl.subarray(0, Math.min(512, 96000 - i)), i)
  }
  let worst = 0
  for (let i = 0; i < 96000; i++) worst = Math.max(worst, Math.abs(reference.left[i] - out[i]))
  check('a block of 512 matches the bounce', worst < 1e-6, `worst ${worst}`)
  check('the silent buffer was left alone', other[0] === 0)
}

console.log('\nit loops, and it ends')
{
  const s = song()
  const looped = new SongPlayer(s, band(), { sampleRate: SR, loop: { from: 0, to: PPQ * 4 } })
  const l = new Float32Array(96000 * 3)
  const r = new Float32Array(96000 * 3)
  looped.render(l, r)
  check('a looping player never ends', !looped.ended)
  // Three passes over a bar: the second and third have to sound as well.
  check('the second pass sounds', rms(l.subarray(96000, 192000)) > 0.005,
    `rms ${rms(l.subarray(96000, 192000)).toFixed(4)}`)
  check('and the third', rms(l.subarray(192000, 288000)) > 0.005)

  const once = new SongPlayer(s, band(), { sampleRate: SR })
  once.render(l, r)
  check('one that is not looping runs out', once.ended)
}

console.log('\na project file plays with no browser anywhere')
{
  // The whole runtime path, in the order a game would use it: read the file
  // as text, build a player, pull audio out of it.
  const s = song()
  const json = JSON.stringify(toStoredProject('Piece', s, band()))
  const loaded = loadProject(json)
  if ('error' in loaded) {
    check('the project reads', false, loaded.error)
  } else {
    check('the project reads', true)
    const player = new SongPlayer(loaded.song, loaded.racks, { sampleRate: SR })
    const l = new Float32Array(48000)
    const r = new Float32Array(48000)
    player.render(l, r)
    check('and plays', rms(l) > 0.005, `rms ${rms(l).toFixed(4)}`)
  }

  check('rubbish is refused rather than thrown', 'error' in loadProject('{not json'))
}


console.log('\nchords')
{
  // Counted through a module each voice has a copy of, because the recorder
  // is shared and hears the copies summed: a VCA passing a steady 1 while its
  // voice's gate is up reads 3 for three held notes, and a CV Utility passing
  // each voice's pitch reads the sum of the chord.
  const gatesPatch: Patch = {
    modules: [mod('key1', 'keys'), mod('one', 'cv', { offset1: 1 }), mod('vca1', 'vca'), mod('rec1', 'rec')],
    cables: [
      cable('one', 'out1', 'vca1', 'in'),
      cable('key1', 'gate', 'vca1', 'cv'),
      cable('vca1', 'out', 'rec1', 'l'),
    ],
  }
  const pitchesPatch: Patch = {
    modules: [mod('key1', 'keys'), mod('cv1', 'cv'), mod('rec1', 'rec')],
    cables: [cable('key1', 'pitch', 'cv1', 'in1'), cable('cv1', 'out1', 'rec1', 'l')],
  }
  const chord = [note(100, 0), note(100, 4), note(100, 7)]
  const poly = { 'key1.voices': 4 }

  const three = run(gatesPatch, chord, 4096, 128, poly).left
  check('three notes hold three gates', three[500] === 3, `got ${three[500]}`)
  const sum = run(pitchesPatch, chord, 4096, 128, poly).left
  check('each voice carries its own pitch', Math.abs(sum[500] - 11 / 12) < 1e-6, `got ${sum[500]}`)

  const lifted = run(gatesPatch, [...chord, offAt(1000, 4), offAt(2000, 0), offAt(2000, 7)], 4096, 128, poly).left
  check('a release lets go of its own note', lifted[1500] === 2, `got ${lifted[1500]}`)
  check('and the rest follow', lifted[2500] === 0, `got ${lifted[2500]}`)

  const pitches = run(pitchesPatch, [...chord, offAt(1000, 4)], 4096, 128, poly).left
  // The released voice keeps its pitch through the tail, as a single keyboard
  // does, so the sum is unchanged; only the gate moved.
  check('a released voice keeps its pitch', Math.abs(pitches[1500] - 11 / 12) < 1e-6, `got ${pitches[1500]}`)

  const stolen = run(gatesPatch, [...chord, note(200, 12)], 4096, 128, { 'key1.voices': 3 }).left
  check('a fourth note on three voices takes one', stolen[500] === 3, `got ${stolen[500]}`)

  const everything = run(gatesPatch, [...chord, off(1000)], 4096, 128, poly).left
  check('a release with no pitch lets go of them all', everything[1500] === 0, `got ${everything[1500]}`)

  // Patched straight to something shared, the keyboard's own jacks carry the
  // newest note, as a single keyboard's do. A sum of pitches is no pitch.
  const direct = run(pitchPatch, chord, 4096, 128, poly).left
  check('its own Pitch jack reads the newest note', Math.abs(direct[500] - 7 / 12) < 1e-6, `got ${direct[500]}`)

  // One voice is the rack as it always was: overlapping notes take over from
  // one another on a single gate.
  const monoGate = run(keysPatch, chord, 4096).left
  check('one voice holds one gate', monoGate[500] === 1, `got ${monoGate[500]}`)
  const monoPitch = run(pitchPatch, [note(100, 0), note(200, 4)], 4096).left
  check('and plays the latest note', Math.abs(monoPitch[500] - 4 / 12) < 1e-6, `got ${monoPitch[500]}`)
}

console.log('\nchords through a real voice')
{
  const voice: Patch = {
    modules: [
      mod('key1', 'keys', { voices: 6 }),
      mod('osc1', 'osc', { fmAmount: 1, envAmount: 1, pitch: 220, sustain: 1, release: 0.05 }),
      mod('lfo1', 'lfo', { rate: 5 }),
      mod('mix1', 'mixer'),
    ],
    cables: [
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('key1', 'gate', 'osc1', 'gate'),
      // A shared LFO, heard by every voice alike.
      cable('lfo1', 'out', 'osc1', 'pwm'),
      cable('osc1', 'out', 'mix1', 'in1'),
    ],
  }
  const compiled = compile(voice)
  check('the oscillator runs per voice', compiled.modules.find((m) => m.id === 'osc1')?.poly === true)
  check('the LFO does not', !compiled.modules.find((m) => m.id === 'lfo1')?.poly)
  check('nor the mixer', !compiled.modules.find((m) => m.id === 'mix1')?.poly)

  const events = [note(333, 0), note(333, 4), note(5000, 7), offAt(9000, 4), offAt(12000, 0), offAt(12000, 7)]
  const frames = 72000
  let sleeping = true
  const speakers = (block: number) => {
    const engine = new GraphEngine(compiled, SR, compiled.params)
    for (const e of events) engine.schedule(e)
    const left = new Float32Array(frames)
    const bl = new Float32Array(block)
    const br = new Float32Array(block)
    for (let i = 0; i < frames; i += block) {
      engine.render(bl, br)
      left.set(bl.subarray(0, Math.min(block, frames - i)), i)
    }
    // Private, and read only here: a voice that never went back to sleep
    // would sound right and cost a voice's worth of work forever.
    if ((engine as unknown as { activeList: number[] }).activeList.length !== 0) sleeping = false
    return left
  }
  const reference = speakers(128)
  let same = true
  for (const block of [1, 37, 1000]) {
    const other = speakers(block)
    for (let i = 0; i < frames; i++) if (other[i] !== reference[i]) same = false
  }
  check('a chord renders the same in any block size', same)

  const two = rms(reference.subarray(1000, 4000))
  const three = rms(reference.subarray(6000, 8500))
  check('a chord reaches the mixer', two > 0.01, `rms ${two.toFixed(4)}`)
  check('a third note adds to it', three > two * 1.1, `${two.toFixed(4)} -> ${three.toFixed(4)}`)
  const after = rms(reference.subarray(60000))
  check('and it all falls quiet on release', after < 1e-4, `rms ${after.toExponential(2)}`)
  check('and the voices go back to sleep', sleeping)
}

console.log('\na hand on a keyboard with voices')
{
  // The Trigger into the Gate jack, as the starting rack has it: each press
  // is a note of its own, alongside whatever the roll is playing.
  const handPatch: Patch = {
    modules: [
      mod('gate1', 'gate'),
      mod('key1', 'keys', { voices: 4 }),
      mod('one', 'cv', { offset1: 1 }),
      mod('vca1', 'vca'),
      mod('rec1', 'rec'),
    ],
    cables: [
      cable('gate1', 'gate', 'key1', 'trig'),
      cable('one', 'out1', 'vca1', 'in'),
      cable('key1', 'gate', 'vca1', 'cv'),
      cable('vca1', 'out', 'rec1', 'l'),
    ],
  }
  const compiled = compile(handPatch)
  const engine = new GraphEngine(compiled, SR, compiled.params)
  engine.setTap('recorder')
  engine.schedule(note(0, 3))
  const l = new Float32Array(256)
  const r = new Float32Array(256)
  engine.render(l, r)
  check('the roll plays a note', l[200] === 1, `got ${l[200]}`)
  engine.setModuleGate('gate1', true)
  engine.render(l, r)
  check('a press adds a second', l[200] === 2, `got ${l[200]}`)
  engine.setModuleGate('gate1', false)
  engine.render(l, r)
  check('and letting go takes only its own', l[200] === 1, `got ${l[200]}`)

  // The panel and the jack are one hand, as they are one gate on a single
  // keyboard: a render holding the keys down while a Trigger fires the jack
  // is one note, not two.
  engine.setPlayed(true)
  engine.setModuleGate('gate1', true)
  engine.render(l, r)
  check('the panel and the jack are one hand', l[200] === 2, `got ${l[200]}`)
}

console.log('\na drum hears how hard it was hit')
{
  // The Trigger's Vel, straight to the recorder: a roll note's velocity while
  // it is played, and full for a hand on the key.
  const drum: Patch = {
    modules: [mod('gate1', 'gate'), mod('rec1', 'rec')],
    cables: [cable('gate1', 'vel', 'rec1', 'l'), cable('gate1', 'gate', 'rec1', 'r')],
  }
  const compiled = compile(drum)
  const engine = new GraphEngine(compiled, SR, compiled.params)
  engine.setTap('recorder')
  engine.schedule({ frame: 0, kind: 'noteOn', module: 'gate1', pitch: 0, velocity: 0.4 })
  engine.schedule({ frame: 100, kind: 'noteOff', module: 'gate1', pitch: 0 })
  const l = new Float32Array(256)
  const r = new Float32Array(256)
  engine.render(l, r)
  check('a soft hit reads soft', Math.abs(l[50] - 0.4) < 1e-6, `got ${l[50]}`)
  check('and stays there through the tail', Math.abs(l[200] - 0.4) < 1e-6, `got ${l[200]}`)
  engine.setModuleGate('gate1', true)
  engine.render(l, r)
  check('a hand on the key plays at full', l[200] === 1, `got ${l[200]}`)
}

// --- editing notes in the roll -------------------------------------------
/**
 * The roll's group edits, at the edges where they go wrong: a group pushed
 * against the end of the pattern or the top row, a note shortened to nothing,
 * a paste or a duplicate that runs off the end.
 */
console.log('\nediting a group of notes')
{
  const BAR = PPQ * 4
  const G = PPQ / 4
  const n = (tick: number, pitch: number, length = G) => ({ track: 't', tick, length, pitch, velocity: 0.8 })
  const notes = [n(0, 0), n(G, 4), n(2 * G, 7), n(BAR - G, 24)]

  const moved = moveNotes(notes, [0, 1, 2], G, 2, BAR, 25)
  check(
    'a group moves together',
    moved.notes[0].tick === G && moved.notes[2].pitch === 9 && moved.notes[3].tick === BAR - G,
    JSON.stringify(moved.notes.map((x) => [x.tick, x.pitch])),
  )
  const pushed = moveNotes(notes, [1, 2], BAR, 40, BAR, 25)
  check(
    'and stops as a whole at the end and the top, rather than folding up',
    pushed.notes[2].tick === BAR - G && pushed.notes[1].tick === BAR - 2 * G &&
      pushed.notes[2].pitch === 24 && pushed.notes[1].pitch === 21,
    JSON.stringify(pushed.notes.slice(1, 3).map((x) => [x.tick, x.pitch])),
  )

  const longer = stretchEnds(notes, [0, 1], G, G, BAR)
  check('stretching adds the same length to every note', longer.notes[0].length === 2 * G && longer.notes[1].length === 2 * G)
  const crushed = stretchEnds(notes, [0], -10 * G, G, BAR)
  check('and never shrinks one below a grid step', crushed.notes[0].length === G, `got ${crushed.notes[0].length}`)
  const past = stretchEnds(notes, [3], 4 * G, G, BAR)
  check('or runs it past the end of the pattern', past.notes[3].length === G, `got ${past.notes[3].length}`)
  const early = stretchStarts(notes, [1], -G, G)
  check(
    'a start pulled earlier keeps its end where it was',
    early.notes[1].tick === 0 && early.notes[1].tick + early.notes[1].length === 2 * G,
  )

  const louder = shiftVelocity(notes, [0, 1], 0.5)
  check('velocity moves together and stops at full', louder.notes[0].velocity === 1 && louder.notes[2].velocity === 0.8)

  const clip = copyNotes(notes, [2, 1])
  check('a copy counts from its first note', clip[0].tick === 0 && clip[1].tick === G && clip[0].pitch === 4)
  const pasted = pasteNotes(notes, clip, BAR - G, 'lead', BAR)
  check(
    'a paste lands on the column asked for, on this track, and selected',
    pasted.notes.length === 5 && pasted.notes[4].tick === BAR - G && pasted.notes[4].track === 'lead' &&
      pasted.selected.length === 1 && pasted.selected[0] === 4,
    `${pasted.notes.length} notes, selected ${pasted.selected}`,
  )
  check('leaving out what would start past the end', !pasted.notes.some((x) => x.tick >= BAR))

  const twice = duplicateNotes(notes, [0, 1], G, BAR, 't')
  check(
    'a duplicate starts where the group ends, and is what is selected after',
    twice.notes.length === 6 && twice.notes[4].tick === 2 * G && twice.notes[5].tick === 3 * G &&
      twice.selected.join() === '4,5',
    JSON.stringify(twice.notes.slice(4).map((x) => x.tick)),
  )

  const gone = removeNotes(notes, [1, 3])
  check('removing takes exactly those', gone.notes.length === 2 && gone.notes[1].pitch === 7)

  check('a rubber band picks what it touches', notesIn(notes, G / 2, 2 * G + 1, 3, 10).join() === '1,2')
  check('including a note that starts before it', notesIn([n(0, 0, BAR)], BAR / 2, BAR / 2 + 1, 0, 0).length === 1)
}

console.log('\nquantize, humanize and the key')
{
  const BAR = PPQ * 4
  const G = PPQ / 4
  const n = (tick: number, pitch: number, length = G) => ({ track: 't', tick, length, pitch, velocity: 0.8 })

  const loose = [n(G + 30, 0, 200), n(2 * G - 100, 4), n(BAR - 10, 7)]
  const tight = quantizeNotes(loose, [0, 1, 2], G, BAR)
  check(
    'quantize snaps starts to the nearest grid line and keeps lengths',
    tight.notes[0].tick === G && tight.notes[0].length === 200 && tight.notes[1].tick === 2 * G,
    JSON.stringify(tight.notes.map((x) => [x.tick, x.length])),
  )
  check('and never pushes a note off the end', tight.notes[2].tick + tight.notes[2].length <= BAR,
    `${tight.notes[2].tick}+${tight.notes[2].length}`)
  const triplet = quantizeNotes([n(330, 0)], [0], PPQ / 3, BAR)
  check('onto a triplet grid as well', triplet.notes[0].tick === 320, `got ${triplet.notes[0].tick}`)

  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const grid = [n(0, 0), n(G, 0), n(2 * G, 0), n(3 * G, 0)]
  const human = humanizeNotes(grid, [0, 1, 2, 3], 40, 0.1, BAR, random)
  const drift = human.notes.map((x, i) => x.tick - grid[i].tick)
  check('humanize moves notes a little either way, and no further than asked',
    drift.some((d) => d !== 0) && drift.every((d) => Math.abs(d) <= 40), drift.join(', '))
  check('and leaves velocities inside what they can be',
    human.notes.every((x) => x.velocity >= 0.01 && x.velocity <= 1 && Math.abs(x.velocity - 0.8) <= 0.1 + 1e-9))

  const cMajor = { root: 0, mode: 'major' }
  check('C major has no black keys in it', [0, 2, 4, 5, 7, 9, 11].every((p) => inScale(p, cMajor)) &&
    [1, 3, 6, 8, 10].every((p) => !inScale(p, cMajor)))
  check('an accidental snaps to its nearest, up on a tie', nearestInScale(6, cMajor) === 7 && nearestInScale(1, cMajor) === 2)
  check('a step along the scale skips what is not in it', stepInScale(4, 1, cMajor) === 5 && stepInScale(5, -1, cMajor) === 4 &&
    stepInScale(0, 7, cMajor) === 12)
  check('and degrees are counted the same way', degreesBetween(0, 12, cMajor) === 7 && degreesBetween(7, 4, cMajor) === -2)
  const aMinorPent = { root: 9, mode: 'pentatonicMinor' }
  check('a scale can start anywhere', inScale(9, aMinorPent) && inScale(12, aMinorPent) && !inScale(11, aMinorPent))

  const triad = [n(0, 0), n(0, 4), n(0, 7)]
  const up = transposeNotes(triad, [0, 1, 2], 1, 25, (p, d) => stepInScale(p, d, cMajor))
  check('C major up one degree is D minor, which is what staying in the key means',
    up.notes.map((x) => x.pitch).join() === '2,5,9', up.notes.map((x) => x.pitch).join())
  const top = transposeNotes([n(0, 21), n(0, 24)], [0, 1], 3, 25, (p, d) => stepInScale(p, d, cMajor))
  check('and a group that would leave the keyboard goes as far as it can',
    top.notes.map((x) => x.pitch).join() === '21,24', top.notes.map((x) => x.pitch).join())

  const song = {
    tempo: 120,
    tracks: [{ id: 't', name: 'T', patch: 't', gain: 1 }],
    patterns: [{ id: 'p', name: 'P', length: BAR, notes: [] }],
    playlist: [],
    scale: { root: 9, mode: 'minor', snap: true },
  }
  const back = parseSong(JSON.parse(JSON.stringify(song)))
  check('the key is saved with the song', JSON.stringify(back?.scale) === JSON.stringify(song.scale), JSON.stringify(back?.scale))
  const odd = parseSong({ ...song, scale: { root: 3, mode: 'lydian-flat-nine' } })
  check('and one this build does not know is dropped rather than kept', odd !== null && odd.scale === undefined)
}

console.log('\npatterns and tracks, kept house')
{
  const BAR = PPQ * 4
  const song: Song = {
    tempo: 120,
    tracks: [
      { id: 'a', name: 'A', patch: 'a', gain: 1 },
      { id: 'b', name: 'B', patch: 'b', gain: 1, color: 200 },
      { id: 'c', name: 'C', patch: 'c', gain: 1 },
    ],
    patterns: [
      { id: 'p', name: 'Verse', length: BAR, notes: [], color: 30 },
      { id: 'q', name: 'Chorus', length: BAR, notes: [] },
    ],
    playlist: [
      { pattern: 'p', tick: 0 },
      { pattern: 'p', tick: 2 * BAR },
    ],
  }
  check('a pattern can be renamed', updatePattern(song, 'q', { name: 'Hook' }).patterns[1].name === 'Hook')
  check('but not to nothing', updatePattern(song, 'q', { name: '  ' }) === song)
  check('and given a colour, and have it taken away',
    updatePattern(song, 'q', { color: 150 }).patterns[1].color === 150 &&
      !('color' in updatePattern(song, 'p', { color: null }).patterns[0]))

  const slid = movePlacement(song, 'p', 2 * BAR, 5 * BAR)
  check('a placement slides to another bar', slid.playlist.some((x) => x.tick === 5 * BAR) && !slid.playlist.some((x) => x.tick === 2 * BAR))
  check('and the other placement stays put', slid.playlist.some((x) => x.tick === 0))
  check('sliding onto another of the same pattern merges them', movePlacement(song, 'p', 2 * BAR, 0).playlist.length === 1)
  check('and never before the start', movePlacement(song, 'p', 2 * BAR, -BAR).playlist.some((x) => x.tick === 0 && x.pattern === 'p'))

  check('tracks go in the order asked for', reorderTracks(song, ['c', 'a', 'b']).tracks.map((t) => t.id).join() === 'c,a,b')
  check('and one the order does not mention keeps its place at the end',
    reorderTracks(song, ['b', 'zz']).tracks.map((t) => t.id).join() === 'b,a,c')

  const back = parseSong(JSON.parse(JSON.stringify(song)))
  check('colours are saved with the song', back?.tracks[1].color === 200 && back?.patterns[0].color === 30)
}

console.log('\ntime signatures and sections')
{
  const BAR = PPQ * 4
  const song: Song = {
    tempo: 120,
    tracks: [{ id: 't', name: 'T', patch: 't', gain: 1 }],
    patterns: [{ id: 'p', name: 'P', length: 2 * BAR, notes: [{ track: 't', tick: 480, length: 240, pitch: 3, velocity: 1 }] }],
    playlist: [{ pattern: 'p', tick: 0 }, { pattern: 'p', tick: 4 * BAR }],
  }
  check('4/4 is the default: a bar is four quarter notes', barTicks(song) === BAR && beatTicks(song) === PPQ)
  const waltz = setMeter(song, { beats: 3, unit: 4 })
  check('a bar of 3/4 is three quarters', barTicks(waltz) === 3 * PPQ)
  check('a two-bar pattern stays two bars', waltz.patterns[0].length === 6 * PPQ, String(waltz.patterns[0].length))
  check('and a placement at bar five stays at bar five', waltz.playlist[1].tick === 4 * 3 * PPQ, String(waltz.playlist[1].tick))
  check('with its notes where they were', waltz.patterns[0].notes[0].tick === 480)
  const jig = setMeter(song, { beats: 6, unit: 8 })
  check('6/8 is six eighths to the bar, and an eighth to the beat', barTicks(jig) === 3 * PPQ && beatTicks(jig) === PPQ / 2)
  check('and back to 4/4 leaves nothing behind', !('meter' in setMeter(waltz, { beats: 4, unit: 4 })))
  const saved = parseSong(JSON.parse(JSON.stringify(jig)))
  check('the time signature is saved with the song', saved?.meter?.beats === 6 && saved?.meter?.unit === 8)

  let marked = addMarker(song, 0, 'Intro')
  marked = addMarker(marked, 4 * BAR)
  check('markers can be added, named after the sections already there',
    markersOf(marked).map((m) => m.name).join() === 'Intro,Section 2', markersOf(marked).map((m) => m.name).join())
  check('but not two in one place', addMarker(marked, 0) === marked)
  check('a section runs to the next marker', JSON.stringify(sectionAt(marked, 0)) === JSON.stringify({ from: 0, to: 4 * BAR }))
  check('and the last one to the end of the song', JSON.stringify(sectionAt(marked, 4 * BAR)) === JSON.stringify({ from: 4 * BAR, to: 6 * BAR }))
  check('a marker can be renamed', markersOf(renameMarker(marked, 4 * BAR, 'Drop'))[1].name === 'Drop')
  check('and removed, taking nothing else with it', markersOf(removeMarker(marked, 0)).length === 1 && removeMarker(marked, 0).playlist.length === 2)
  check('the last one removed leaves no marker list behind', !('markers' in removeMarker(addMarker(song, 0), 0)))
  check('markers move with the bars when the meter changes', markersOf(setMeter(marked, { beats: 3, unit: 4 }))[1].tick === 4 * 3 * PPQ)
  check('and are saved with the song', parseSong(JSON.parse(JSON.stringify(marked)))?.markers?.length === 2)
}

console.log('\nthe song console')
{
  const s = song()
  const peakOf = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const energy = (buf: Float32Array, from: number, to: number) => {
    let e = 0
    for (let i = from; i < to; i++) e += buf[i] * buf[i]
    return e
  }
  const loud = { ...s, tracks: s.tracks.map((t) => ({ ...t, gain: 2 })) }
  const limited = await renderSong(loud, band(), RAW)
  check('the limiter holds the mix under -1 dB, however hot the tracks', peakOf(limited.left) <= Math.pow(10, -1 / 20) + 1e-6,
    peakOf(limited.left).toFixed(4))
  const unlimited = await renderSong(updateConsole(loud, { master: { limiter: false } }), band(), RAW)
  check('and switched off, it lets the peaks through', peakOf(unlimited.left) > Math.pow(10, -1 / 20), peakOf(unlimited.left).toFixed(4))

  const flat = await renderSong(s, band(), { ...RAW, routing: { strips: true, sends: true, master: false } })
  const raw = await renderSong(s, band(), { ...RAW, routing: { strips: false, sends: false, master: false } })
  let worst = 0
  for (let i = 0; i < 96000; i++) worst = Math.max(worst, Math.abs(flat.left[i] - raw.left[i]))
  check('a strip nobody has touched passes its track through unchanged', worst < 1e-6, `worst ${worst}`)

  const lead = s.tracks[0].id
  const left = await renderSong(updateStrip(s, lead, { pan: -1 }), band(), { ...RAW, only: [lead], routing: { strips: true, sends: false, master: false } })
  check('panned hard left, a track leaves the right side silent', peakOf(left.right) < 1e-6 && peakOf(left.left) > 0.01,
    `L ${peakOf(left.left).toFixed(3)} R ${peakOf(left.right).toFixed(6)}`)

  const dry = await renderSong(s, band(), { ...RAW, only: [lead] })
  const wet = await renderSong(updateStrip(s, lead, { space: 1 }), band(), { ...RAW, only: [lead] })
  const tail = (buf: Float32Array) => energy(buf, 96000, Math.min(buf.length, 96000 + 48000))
  check('a send to the Space leaves a reverb tail after the notes', tail(wet.left) > tail(dry.left) * 10 + 1e-6,
    `${tail(wet.left).toExponential(2)} vs ${tail(dry.left).toExponential(2)}`)
  const stemRaw = await renderStems(updateStrip(s, lead, { space: 1, pan: -1 }), band(), { ...RAW, stemMix: 'raw' })
  const stemSends = await renderStems(updateStrip(s, lead, { space: 1, pan: -1 }), band(), { ...RAW, stemMix: 'sends' })
  check('a raw stem is the rack alone: no pan, no reverb', peakOf(stemRaw[0].audio.right) > 0.01)
  check('a stem with its sends carries its reverb', tail(stemSends[0].audio.left) > tail(stemRaw[0].audio.left) * 10 + 1e-6)

  const mixed = updateConsole(updateStrip(s, lead, { eq: { low: 3, mid: -2, high: 1 }, space: 0.4 }), {
    master: { balance: 0.2, limiter: false },
    space: { decay: 4 },
  })
  const back = parseSong(JSON.parse(JSON.stringify(mixed)))
  check('the strips and the desk are saved with the song',
    back?.tracks[0].strip?.eq.low === 3 && back?.tracks[0].strip?.space === 0.4 &&
      back?.console?.master.limiter === false && back?.console?.space.decay === 4)
}

console.log('\nchords in the roll')
{
  const at = (id: string, root: number, inversion = 0, scale?: { root: number; mode: string }) =>
    chordPitches(root, chordById(id)!, inversion, scale, 25).join()
  check('a major chord is a root, a major third and a fifth', at('maj', 0) === '0,4,7', at('maj', 0))
  check('a minor seventh has four notes', at('min7', 9) === '9,12,16,19', at('min7', 9))
  check('the first inversion puts the root on top', at('maj', 0, 1) === '4,7,12', at('maj', 0, 1))
  check('an inversion past the last note stops at the last', at('maj', 0, 3) === at('maj', 0, 2))
  check('a chord clicked near the top folds down rather than losing notes', at('maj', 22) === '14,17,22', at('maj', 22))
  const cMajor = { root: 0, mode: 'major' }
  check('a key triad on D in C major is D minor', at('key3', 2, 0, cMajor) === '2,5,9', at('key3', 2, 0, cMajor))
  check('and on B it is B diminished', at('key3', 11, 0, cMajor) === '11,14,17', at('key3', 11, 0, cMajor))
  check('a key 7th on G is G dominant 7', at('key7', 7, 0, cMajor) === '7,11,14,17', at('key7', 7, 0, cMajor))
  check('with no key it is just the note clicked', at('key3', 5) === '5')
}

console.log('\nthe song over a pattern')
{
  const BAR = PPQ * 4
  const song: Song = {
    tempo: 120,
    tracks: [],
    patterns: [
      { id: 'drums', name: 'Drums', length: 4 * BAR, notes: [
        { track: 'd', tick: 0, length: PPQ, pitch: 0, velocity: 1 },
        { track: 'd', tick: 2 * BAR, length: PPQ, pitch: 0, velocity: 1 },
        { track: 'd', tick: 4 * BAR, length: PPQ, pitch: 0, velocity: 1 },
      ] },
      { id: 'lead', name: 'Lead', length: 2 * BAR, notes: [] },
    ],
    playlist: [
      { pattern: 'drums', tick: 0 },
      { pattern: 'lead', tick: 6 * BAR },
      { pattern: 'lead', tick: 2 * BAR },
    ],
  }
  check('a pattern is found where it first plays', firstPlacement(song, 'lead') === 2 * BAR)
  check('and one not in the song is not', firstPlacement(song, 'nowhere') === null)
  const under = contextNotes(song, 'lead', 2 * BAR)
  check(
    'what plays over it is what the other patterns play in those bars, counted from its start',
    under.length === 1 && under[0].tick === 0 && under[0].track === 'd',
    JSON.stringify(under),
  )
  check(
    'and a note past the end of its own pattern is not heard, so is not drawn',
    !contextNotes(song, 'lead', 2 * BAR).some((x) => x.tick === 2 * BAR),
  )
  check('a placement with nothing under it has nothing drawn', contextNotes(song, 'lead', 6 * BAR).length === 0)
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
