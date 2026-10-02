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
import { engineEvents, kitRow, noteTarget } from '../src/song/bind'
import { flattenKits, kitSlots, padView, setKitSlot, updateKitSlot, withPadView } from '../src/patch/kit'
import { templateById } from '../src/patch/library'
import { fromStored, toStored } from '../src/patch/serialize'
import { connect as wireUp, initialValues, reconcileValues } from '../src/patch/edit'
import { sampleIdsIn } from '../src/patch/sampleRefs'
import {
  addPattern,
  duplicatePattern,
  contextNotes,
  firstPlacement,
  patternOnly,
  reorderTracks,
  setMeter,
  updatePattern,
  removePattern,
  removeTrack,
  setPatternLength,
  setPatternSwing,
  soloTrack,
} from '../src/song/edit'
import { fromStoredProject, toStoredProject } from '../src/song/project'
import { addFolder, heardTracks, moveToFolder, removeFolder, soloFolder, tracksMatching, updateFolder } from '../src/song/folder'
import { addClip, duplicateClips, moveClips, removeClips, splitClip, trimClip } from '../src/song/clip'
import {
  addSection,
  colorSection,
  duplicateSection,
  moveSection,
  removeSection,
  renameSection,
  resizeSection,
  sectionAt,
  deleteSectionAndMusic,
  sectionsOf,
  slideSection,
  splitSection,
} from '../src/song/section'
import { renderSong, renderStems, STEM_ROUTING } from '../src/audio/renderSong'
import { Transport } from '../src/audio/Transport'
import type { AudioEngine } from '../src/audio/AudioEngine'
import { playlistBars, setPatternNotes, trackMix, updateConsole, updateStrip, updateTrack } from '../src/song/edit'
import { SongPlayer, loadProject } from '../src/song/runtime'
import { framesPerTick, releasedBySwing, songEnd, songEventTicks, songEvents, swungTick, unswungTick, type SongEvent } from '../src/song/schedule'
import { fill, playheadTick } from '../src/song/transport'
import { barsIn, barsOf, patternBars, secondsAt, tempoAt, tempoMap } from '../src/song/timeline'
import { cleanTimings, METER, moveAt, removeAt, removeBetween, setAt, TEMPO } from '../src/song/timing'
import {
  arpeggiateNotes,
  chopNotes,
  copyNotes,
  duplicateNotes,
  flamNotes,
  humanizeNotes,
  moveNotes,
  notesIn,
  pasteNotes,
  quantizeNotes,
  randomizePitches,
  removeNotes,
  reverseNotes,
  shiftVelocity,
  stretchEnds,
  stretchStarts,
  strumNotes,
  transposeNotes,
} from '../src/song/noteEdit'
import { degreesBetween, inScale, nearestInScale, stepInScale } from '../src/song/scale'
import { chordById, chordPitches } from '../src/song/chord'
import { midiName, midiNameCents, rowForMidi, rowZero, scaleForRows, tuningOf } from '../src/song/tuning'
import { clearTime, copyTime, deleteTime, duplicateTime, insertTime, pasteTime } from '../src/song/range'
import { addRecorded, MIN_RECORDED, patternTick, recordedNote, spanTicks } from '../src/song/record'
import { parseMidi } from '../src/input/midi'
import { parseSong } from '../src/song/serialize'
import { describeEdit } from '../src/hooks/describeEdit'
import { defaultPatch } from '../src/patch/defaultPatch'
import { initialValues as rackValues } from '../src/patch/edit'
import { barTicks, beatTicks, benchSong, minPatternLength, PITCH_RANGE, PPQ, type Song } from '../src/song/types'
import { defOf } from '../src/patch/defs'
/** The Keyboard's own reach, for the checks about what happens at an edge. */
const TWO_OCTAVES = { low: 0, high: 24 }

/** How long a song's first clip is. */
const clipLen = (s: Song) => s.playlist[0].length ?? s.patterns[0].length

const SR = 48000
/** The plain 120 bpm clock most of these checks count against. */
const T120 = tempoMap({ tempo: 120 }, SR)

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
  const seams = out.events.filter((e) => e.kind === 'off' && e.frame === 24000 && e.pitch === undefined)
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
    playheadTick(12000, 0, 0, T120, null) === PPQ / 2,
    `got ${playheadTick(12000, 0, 0, T120, null)}`,
  )
  check(
    'it wraps at the end of the loop',
    playheadTick(36000, 0, 0, T120, loop) === PPQ / 2,
    `got ${playheadTick(36000, 0, 0, T120, loop)}`,
  )
  check(
    'it stays inside the loop before the start frame',
    playheadTick(-12000, 0, 0, T120, loop) === PPQ / 2,
    `got ${playheadTick(-12000, 0, 0, T120, loop)}`,
  )
}

console.log('\nthe edges of a song')
{
  // The last note ends exactly where the song does. The window is half-open,
  // so that release sits on the one tick no window reaches -- and it is the
  // last note of every song.
  const s = song({
    patterns: [
      { id: 'a', name: 'A', length: PPQ * 2, notes: [{ track: 'lead', tick: PPQ, length: PPQ, pitch: 3, velocity: 1 }] },
    ],
  })
  const out = fill(s, SR, { tick: 0, frame: 0 }, 24000 * 8, null)
  const last = out.events.filter((e) => e.kind === 'off')
  check(
    'the final note-off is emitted',
    last.length === 1 && last[0].frame === 48000 && last[0].pitch === 3,
    JSON.stringify(last),
  )
  check('and the song then ends', out.ended)
  const again = fill(s, SR, out.cursor, 24000 * 16, null)
  check('a fill after the end emits nothing twice', again.events.length === 0, `got ${again.events.length}`)

  // Filled a little at a time, the edge is still emitted exactly once.
  let cursor = { tick: 0, frame: 0 }
  const tiled: SongEvent[] = []
  for (let f = 1000; f <= 24000 * 4; f += 1000) {
    const o = fill(s, SR, cursor, f, null)
    tiled.push(...o.events)
    cursor = o.cursor
  }
  check('tiled fills emit it once', tiled.filter((e) => e.kind === 'off').length === 1)

  // Looping: a release on the seam is heard, and the press at the top of the
  // loop is not doubled by it.
  const looped = fill(s, SR, { tick: 0, frame: 0 }, 48000 * 3, { from: PPQ, to: PPQ * 2 })
  const ons = looped.events.filter((e) => e.kind === 'on')
  check('a loop does not double its first press', ons.length === 5, `got ${ons.length}`)
  const wraps = looped.events.filter((e) => e.kind === 'off' && e.pitch === undefined)
  check('the seam sends a release with no pitch', wraps.length > 0 && wraps.every((e) => !('pitch' in e)))
}

console.log('\na chord held across the seam')
{
  // A pad held longer than the loop. Its own releases are past the seam, so
  // only the seam can let go of it; a seam that released pitch zero would
  // leave three voices held and the next pass would steal the fourth.
  const gatesPatch: Patch = {
    modules: [mod('key1', 'keys'), mod('one', 'cv', { offset1: 1 }), mod('vca1', 'vca'), mod('rec1', 'rec')],
    cables: [
      cable('one', 'out1', 'vca1', 'in'),
      cable('key1', 'gate', 'vca1', 'cv'),
      cable('vca1', 'out', 'rec1', 'l'),
    ],
  }
  const pad = (pitch: number) => ({ track: 'lead', tick: 0, length: PPQ * 4, pitch, velocity: 1 })
  const s = song({ patterns: [{ id: 'a', name: 'A', length: PPQ * 4, notes: [pad(2), pad(5), pad(9)] }] })
  const out = fill(s, SR, { tick: 0, frame: 0 }, 24000 * 3, { from: 0, to: PPQ })
  const target = noteTarget(gatesPatch)!
  const lead = engineEvents(
    out.events.filter((e) => e.track === 'lead'),
    target,
  )
  const gates = run(gatesPatch, lead, 24000 * 3, 128, { 'key1.voices': 4 }).left
  check('the first pass holds three', gates[12000] === 3, `got ${gates[12000]}`)
  check('the second pass holds three, not four', gates[36000] === 3, `got ${gates[36000]}`)
  check('and so does the third', gates[60000] === 3, `got ${gates[60000]}`)
}

console.log('\nthe playhead around a loop')
{
  const loop = { from: PPQ * 2, to: PPQ * 3 }
  check(
    'a start before the loop plays up to it unwrapped',
    playheadTick(24000, 0, 0, T120, loop) === PPQ,
    `got ${playheadTick(24000, 0, 0, T120, loop)}`,
  )
  check(
    'and wraps once it is past the end',
    playheadTick(24000 * 3.5, 0, 0, T120, loop) === PPQ * 2.5,
    `got ${playheadTick(24000 * 3.5, 0, 0, T120, loop)}`,
  )

  // Through the transport itself, with an engine that is only a clock.
  let onFrame: (frame: number) => void = () => {}
  const fake = {
    sampleRate: SR,
    start: async () => {},
    onFrame: (fn: (frame: number) => void) => {
      onFrame = fn
      return () => {}
    },
    schedule: () => {},
    unschedule: () => {},
    allNotesOff: () => {},
  }
  const transport = new Transport(fake as unknown as AudioEngine, song())
  transport.setLoop({ from: 0, to: PPQ * 8 })
  await transport.play(0)
  onFrame(0)
  onFrame(24000 * 10)
  check('ten beats into an eight-beat loop is beat two', transport.state.tick === PPQ * 2, `got ${transport.state.tick}`)
  // Shortened to three beats while playing. Wrapping everything elapsed into
  // the new length would draw beat one and a half; the audio is at two and a
  // half and plays on to three.
  transport.setLoop({ from: 0, to: PPQ * 3 })
  onFrame(24000 * 10.5)
  check('after the loop changes it carries on from where it was', transport.state.tick === PPQ * 2.5, `got ${transport.state.tick}`)
  onFrame(24000 * 11.5)
  check('and wraps at the new end', transport.state.tick === PPQ * 0.5, `got ${transport.state.tick}`)
  transport.stop()
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
  const placed = addClip(two, 'b', PPQ * 4, 1)
  check('a pattern can be placed', placed.playlist.length === 2, `got ${placed.playlist.length}`)
  check('and taken off again', removeClips(placed, [1]).playlist.length === 1)
  check('but a pattern that is not there cannot', addClip(two, 'nope', 0, 0) === two)
  check('removing a pattern takes its placements', removePattern(placed, 'b').playlist.length === 1)
  check('the last pattern cannot be removed', removePattern(base, 'a').patterns.length === 1)
}

console.log('\nclips: trimmed, stretched, offset and split')
{
  const BAR = PPQ * 4
  // Four quarter notes on the lead, a bar long.
  const quarters = (over: Partial<Song> = {}) =>
    song({
      patterns: [
        {
          id: 'a',
          name: 'A',
          length: BAR,
          notes: [0, 1, 2, 3].map((i) => ({ track: 'lead', tick: i * PPQ, length: PPQ / 2, pitch: i, velocity: 1 })),
        },
      ],
      ...over,
    })
  const ons = (s: Song) => songEventTicks(s, 0, 64 * BAR).filter((e) => e.kind === 'on')
  const same = (a: Song, b: Song) => JSON.stringify(songEventTicks(a, 0, 64 * BAR)) === JSON.stringify(songEventTicks(b, 0, 64 * BAR))

  const whole = quarters()
  check('an untouched clip plays its pattern once', ons(whole).length === 4)

  const short = trimClip(whole, 0, 'end', 2 * PPQ)
  check('trimming the end stops it there', ons(short).length === 2, `${ons(short).length} notes`)
  check('and the song ends with it', songEnd(short) === 2 * PPQ, String(songEnd(short)))
  check('a trimmed clip remembers its length', short.playlist[0].length === 2 * PPQ)

  const long = trimClip(whole, 0, 'end', 2 * BAR)
  check('drawn out past its pattern, the pattern repeats', ons(long).length === 8, `${ons(long).length} notes`)
  check('from the top, a pattern length later', ons(long)[4].tick === BAR && ons(long)[4].pitch === 0)

  const late = trimClip(whole, 0, 'start', PPQ)
  check('trimming the start moves the edge, not the notes', ons(late).map((e) => e.tick).join() === [PPQ, 2 * PPQ, 3 * PPQ].join(),
    ons(late).map((e) => e.tick).join())
  check('by moving the offset into the pattern', late.playlist[0].offset === PPQ && late.playlist[0].tick === PPQ)

  // Pulled back past the pattern's start, the front shows the end of the
  // repeat before -- the pattern loops both ways.
  const placedLate = { ...whole, playlist: [{ pattern: 'a', tick: BAR }] }
  const early = trimClip(placedLate, 0, 'start', BAR - PPQ)
  check('the front pulled back plays the end of the pattern first', ons(early)[0].tick === BAR - PPQ && ons(early)[0].pitch === 3,
    JSON.stringify(ons(early)[0]))
  check('and then the pattern as it was', ons(early)[1].tick === BAR && ons(early)[1].pitch === 0)

  check('no edge goes past the other', clipLen(trimClip(whole, 0, 'start', 10 * BAR)) >= 1 && clipLen(trimClip(whole, 0, 'end', -BAR)) >= 1)
  check('nor before the start of the song', trimClip(whole, 0, 'start', -BAR) === whole)

  // A split has to be inaudible: the two halves play exactly the whole.
  const stretched = trimClip(trimClip(whole, 0, 'end', 3 * BAR), 0, 'start', PPQ / 2)
  const halves = splitClip(stretched, 0, BAR + PPQ)
  check('a split makes two clips', halves.playlist.length === 2)
  check('which play exactly what the one did', same(stretched, halves))
  check('split again between notes, still the same', same(stretched, splitClip(halves, 1, 2 * BAR + PPQ + 600)))
  // Through a held note, the cut lets go of it: a clip's end is an end.
  const through = splitClip(stretched, 0, 2 * BAR + 100)
  check('a split through a held note cuts it there',
    songEventTicks(through, 0, 4 * BAR).some((e) => e.kind === 'off' && e.tick === 2 * BAR + 100))
  check('a split on an edge cuts nothing', splitClip(whole, 0, 0) === whole && splitClip(whole, 0, BAR) === whole)

  // A note is played by the clip its start falls in, and cut at the clip's end.
  const held = song({
    patterns: [{ id: 'a', name: 'A', length: BAR, notes: [{ track: 'lead', tick: PPQ, length: 2 * PPQ, pitch: 7, velocity: 1 }] }],
  })
  const cutIn = trimClip(held, 0, 'start', 2 * PPQ)
  check('a note whose start was trimmed off is not played', ons(cutIn).length === 0)
  const cutOff = trimClip(held, 0, 'end', 2 * PPQ)
  const offs = songEventTicks(cutOff, 0, BAR).filter((e) => e.kind === 'off')
  check('a note still held at the end of the clip lets go there', offs.length === 1 && offs[0].tick === 2 * PPQ, JSON.stringify(offs))

  // Windows tile a stretched, offset clip as they tile anything else.
  let tiled: ReturnType<typeof songEventTicks> = []
  for (let t = 0; t < 4 * BAR; t += 700) tiled = tiled.concat(songEventTicks(stretched, t, t + 700))
  check('windows tile a stretched clip without a note lost or doubled',
    JSON.stringify(tiled) === JSON.stringify(songEventTicks(stretched, 0, 4 * BAR)))

  // Lanes are where a clip is drawn, and nothing else.
  const laned = moveClips(whole, [0], 0, 3)
  check('a clip moves to another lane', laned.playlist[0].lane === 3)
  check('and sounds the same there', same(whole, laned))

  // Moving and copying.
  const pair = addClip(whole, 'a', 2 * BAR, 1)
  const slid = moveClips(pair, [0, 1], -3 * BAR, -2)
  check('a group held against the start keeps its shape',
    slid.playlist[0].tick === 0 && slid.playlist[1].tick === 2 * BAR && (slid.playlist[1].lane ?? 0) === 1,
    JSON.stringify(slid.playlist))
  check('moving by nothing is no edit', moveClips(pair, [0], 0, 0) === pair)
  const nudged = moveClips(pair, [1], PPQ, 0)
  check('a clip can start part way through a bar', nudged.playlist[1].tick === 2 * BAR + PPQ)
  check('and moving keeps every clip where it is in the list', nudged.playlist[0] === pair.playlist[0])
  const copied = duplicateClips(pair, [0, 1], 4 * BAR, 0)
  check('copies go on the end of the list', copied.playlist.length === 4 && copied.playlist[2].tick === 4 * BAR && copied.playlist[3].tick === 6 * BAR)
  check('removing takes only the clips named', removeClips(copied, [0, 2]).playlist.map((p) => p.tick).join() === [2 * BAR, 6 * BAR].join())

  // The roll plays and draws from the pattern's own start.
  check('the roll lines up with the pattern, not the trimmed edge', firstPlacement(late, 'a') === 0)
  const nearStart = moveClips(late, [0], -PPQ / 2, 0)
  check('and with the next repeat when that would be before the song', firstPlacement(nearStart, 'a') === BAR - PPQ / 2,
    String(firstPlacement(nearStart, 'a')))

  // Kept in a file, and tidied on the way in.
  const back = parseSong(JSON.parse(JSON.stringify(moveClips(stretched, [0], 0, 2))))!
  const c = back.playlist[0]
  check('a clip\'s lane, offset and length are saved', c.lane === 2 && c.offset === PPQ / 2 && c.length === 3 * BAR - PPQ / 2, JSON.stringify(c))
  const odd = parseSong({
    ...JSON.parse(JSON.stringify(whole)),
    playlist: [
      { pattern: 'a', tick: 0, offset: BAR + 10, lane: 0 },
      { pattern: 'a', tick: 0, offset: 10 },
      { pattern: 'a', tick: 0, lane: 1 },
    ],
  })!
  check('an offset past the pattern is wrapped into it', odd.playlist[0].offset === 10)
  check('the same clip twice is kept once', odd.playlist.length === 2, JSON.stringify(odd.playlist))
  check('and lane 0 is left unsaid', !('lane' in odd.playlist[0]))
}

console.log('\nplaying one pattern rather than the arrangement')
{
  const two = addClip(addPattern(song(), 'b', 'B'), 'b', PPQ * 4, 1)
  const only = patternOnly(two, 'b')
  check('it holds one pattern', only.patterns.length === 1 && only.patterns[0].id === 'b')
  check('placed at the start', only.playlist.length === 1 && only.playlist[0].tick === 0)
  check('and keeps the tracks, so mute and solo still apply', only.tracks.length === two.tracks.length)
  check('a pattern that is not there plays nothing', patternOnly(two, 'nope').playlist.length === 0)
}

// --- the project file ---------------------------------------------------

console.log('\na project from before lanes')
{
  // A version 1 playlist was a row per pattern, so each pattern gets a lane
  // of its own, in the order the patterns are listed -- counting only those
  // that were placed.
  const old = addClip(addPattern(addPattern(song(), 'b', 'B'), 'c', 'C'), 'c', PPQ * 4, 0)
  const racks = { lead: toStoredProject('x', song(), {}).racks.lead }
  const v1 = fromStoredProject({ version: 1, name: 'Old', song: JSON.parse(JSON.stringify(old)), racks })
  const v2 = fromStoredProject({ version: 2, name: 'New', song: JSON.parse(JSON.stringify(old)), racks })
  if ('error' in v1 || 'error' in v2) {
    check('both read', false)
  } else {
    check('an old project gets a lane per pattern', v1.song.playlist.map((p) => p.lane ?? 0).join() === '0,1', JSON.stringify(v1.song.playlist))
    check('a new one keeps the lanes it has', v2.song.playlist.every((p) => (p.lane ?? 0) === 0))
  }
}

console.log('\na project survives the round trip')
{
  const s = addClip(addPattern(song(), 'b', 'B'), 'b', PPQ * 4, 1)
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

  // The limiter looks ahead and so runs late; a bounce takes that back off
  // the front, or a loop would open on a sliver of silence at every seam.
  // A few samples are the oscillator's own attack; uncorrected it is 80-odd.
  const first = mix.left.findIndex((x) => Math.abs(x) > 1e-6)
  check('the first note starts on the first samples', first >= 0 && first < 32, `first sound at ${first}`)

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

  // A bounce leaves the unheard racks out rather than running them silent,
  // which is what stops stems costing the mix once per track. It must not be
  // heard: the same samples as running every rack, with the other track
  // sending to the reverb and echo so that a leak through a send would show.
  const wet = updateStrip(s, 'drum', { space: 1, delay: 1 })
  const player = (onlyHeard: boolean) =>
    new SongPlayer(wet, band(), { sampleRate: SR, only: ['lead'], routing: STEM_ROUTING.sends, onlyHeard })
  const every = player(false)
  const heard = player(true)
  const a = new Float32Array(128)
  const b = new Float32Array(128)
  const c = new Float32Array(128)
  const d = new Float32Array(128)
  let same = true
  for (let i = 0; i < span && same; i += 128) {
    every.render(a, b)
    heard.render(c, d)
    for (let j = 0; j < 128; j++) if (a[j] !== c[j] || b[j] !== d[j]) same = false
  }
  check('leaving unheard racks out changes no sample', same)
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
  // The bounce takes the limiter's lookahead off the front; a player running
  // live does not, so it is the same audio that many samples later.
  const lag = player.latency
  let worst = 0
  for (let i = 0; i + lag < 96000; i++) worst = Math.max(worst, Math.abs(reference.left[i] - out[i + lag]))
  check('a block of 512 matches the bounce', worst < 1e-6, `worst ${worst}`)
  check('the silent buffer was left alone', other[0] === 0)
}

console.log('\na game turns a knob while it plays')
{
  // A Macro on a VCA: at nought the lead is shut, and turning the macro from
  // the game is the only thing that can open it.
  const macroRack = (): Patch => ({
    modules: [
      mod('key1', 'keys'),
      mod('osc1', 'osc', { pitch: 110, fmAmount: 1, envAmount: 1, decay: 0.25 }),
      mod('mac1', 'macro'),
      mod('vca1', 'vca', { level: 0, cvAmount: 1 }),
      mod('mix1', 'mixer'),
    ],
    cables: [
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('key1', 'gate', 'osc1', 'gate'),
      cable('osc1', 'out', 'vca1', 'in'),
      cable('mac1', 'out1', 'vca1', 'cv'),
      cable('vca1', 'out', 'mix1', 'in1'),
    ],
  })
  const racks = { lead: { patch: macroRack(), values: {} }, drum: band().drum }
  const leadOnly = { sampleRate: SR, only: ['lead'] }
  const l = new Float32Array(24000)
  const r = new Float32Array(24000)

  const shut = new SongPlayer(song(), racks, leadOnly)
  shut.render(l, r)
  check('with the macro at nought the lead is silent', rms(l) < 1e-4, `rms ${rms(l).toFixed(5)}`)

  const open = new SongPlayer(song(), racks, leadOnly)
  check('a knob is found by the track\'s name', open.setParam('Lead', 'mac1.amount', 1))
  open.render(l, r)
  check('and turning it opens the lead', rms(l) > 0.005, `rms ${rms(l).toFixed(4)}`)

  check('by id as well', open.setParam('lead', 'mac1.amount', 0.5) && open.getParam('lead', 'mac1.amount') === 0.5)
  open.setParam('lead', 'mac1.amount', 7)
  check('a value past the end of the knob stops at it', open.getParam('lead', 'mac1.amount') === 1)
  open.setParam('lead', 'osc1.wave', 1.4)
  check('and a switch lands on a position', open.getParam('lead', 'osc1.wave') === 1)
  check('a knob that is not there is refused', !open.setParam('lead', 'mac9.amount', 1) && !open.setParam('bass', 'mac1.amount', 1))
  check('and a value that is not a number', !open.setParam('lead', 'mac1.amount', Number.NaN))
  check('it lists what can be reached', open.paramsOf('Lead').includes('mac1.amount') && open.paramsOf('Lead').includes('vca1.level'))
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

  // The roll's full range goes on under the Keyboard's bottom key, and still
  // has a bottom row to stop at.
  const under = moveNotes(notes, [0, 1], 0, -24, BAR, PITCH_RANGE)
  check('in the full range a group moves on below the Keyboard',
    under.notes[0].pitch === -24 && under.notes[1].pitch === -20, JSON.stringify(under.notes.map((x) => x.pitch)))
  const floor = moveNotes(notes, [0, 1], 0, -500, BAR, PITCH_RANGE)
  check('and stops at the bottom row',
    floor.notes[0].pitch === PITCH_RANGE.low && floor.notes[1].pitch === PITCH_RANGE.low + 4,
    JSON.stringify(floor.notes.map((x) => x.pitch)))
  check('which is 128 rows in all', PITCH_RANGE.high - PITCH_RANGE.low + 1 === 128)

  const moved = moveNotes(notes, [0, 1, 2], G, 2, BAR, TWO_OCTAVES)
  check(
    'a group moves together',
    moved.notes[0].tick === G && moved.notes[2].pitch === 9 && moved.notes[3].tick === BAR - G,
    JSON.stringify(moved.notes.map((x) => [x.tick, x.pitch])),
  )
  const pushed = moveNotes(notes, [1, 2], BAR, 40, BAR, TWO_OCTAVES)
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

  const half = quantizeNotes([n(G + 60, 0, 200)], [0], G, BAR, { strength: 0.5 })
  check('a half-strength quantize moves a note half way to the line', half.notes[0].tick === G + 30, `got ${half.notes[0].tick}`)
  check('at no strength it moves nothing',
    quantizeNotes([n(G + 60, 0, 200)], [0], G, BAR, { strength: 0 }).notes[0].tick === G + 60)
  const ends = quantizeNotes([n(G + 30, 0, 200)], [0], G, BAR, { what: 'end' })
  check('end quantize puts the end on a line and leaves the start',
    ends.notes[0].tick === G + 30 && (ends.notes[0].tick + ends.notes[0].length) % G === 0,
    `${ends.notes[0].tick}+${ends.notes[0].length}`)
  const stub = quantizeNotes([n(G + 10, 0, 30)], [0], G, BAR, { what: 'end' })
  check('an end that would round back onto its start takes the next line instead',
    stub.notes[0].tick + stub.notes[0].length === 2 * G, `${stub.notes[0].tick}+${stub.notes[0].length}`)
  const both = quantizeNotes([n(G - 20, 0, G + 50)], [0], G, BAR, { what: 'both' })
  check('start-and-end quantize lands both on lines',
    both.notes[0].tick === G && both.notes[0].length === G, `${both.notes[0].tick}+${both.notes[0].length}`)
  const lens = quantizeNotes([n(G + 17, 0, 400), n(0, 2, 40)], [0, 1], G, BAR, { what: 'length' })
  check('length quantize rounds lengths to whole steps and keeps starts',
    lens.notes[0].tick === G + 17 && lens.notes[0].length === 2 * G && lens.notes[1].length === G,
    lens.notes.map((x) => `${x.tick}+${x.length}`).join(' '))

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
  const up = transposeNotes(triad, [0, 1, 2], 1, TWO_OCTAVES, (p, d) => stepInScale(p, d, cMajor))
  check('C major up one degree is D minor, which is what staying in the key means',
    up.notes.map((x) => x.pitch).join() === '2,5,9', up.notes.map((x) => x.pitch).join())
  const top = transposeNotes([n(0, 21), n(0, 24)], [0, 1], 3, TWO_OCTAVES, (p, d) => stepInScale(p, d, cMajor))
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

  const slid = moveClips(song, [1], 3 * BAR, 0)
  check('a clip slides to another bar', slid.playlist[1].tick === 5 * BAR)
  check('and the other one stays put', slid.playlist[0].tick === 0)

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

  let marked = addSection(song, 0, 2 * BAR, 'Intro')
  marked = addSection(marked, 4 * BAR, 2 * BAR)
  check('sections can be added, named after the ones already there',
    sectionsOf(marked).map((m) => m.name).join() === 'Intro,Section 2', sectionsOf(marked).map((m) => m.name).join())
  check('but not on top of another', addSection(marked, BAR, BAR) === marked)
  check('a section is as long as it was made', JSON.stringify(sectionAt(marked, 0)) === JSON.stringify({ from: 0, to: 2 * BAR }))
  check('and adding one after it does not shorten it', JSON.stringify(sectionAt(marked, 4 * BAR)) === JSON.stringify({ from: 4 * BAR, to: 6 * BAR }))
  check('one made too long for the room stops at the next', sectionAt(addSection(marked, 3 * BAR, 4 * BAR), 3 * BAR)?.to === 4 * BAR)
  check('a section can be renamed', sectionsOf(renameSection(marked, 4 * BAR, 'Drop'))[1].name === 'Drop')
  check('but not to a name another has', sectionsOf(renameSection(marked, 4 * BAR, 'Intro'))[1].name === 'Intro 2')
  check('and removed, taking nothing else with it', sectionsOf(removeSection(marked, 0)).length === 1 && removeSection(marked, 0).playlist.length === 2)
  check('the last one removed leaves no section list behind', !('sections' in removeSection(addSection(song, 0, BAR), 0)))
  check('sections move with the bars when the meter changes', sectionsOf(setMeter(marked, { beats: 3, unit: 4 }))[1].tick === 4 * 3 * PPQ)
  check('and are saved with the song', parseSong(JSON.parse(JSON.stringify(colorSection(marked, 0, 120))))?.sections?.[0].color === 120)
}

console.log('\nfolders of tracks')
{
  // Two tracks in a folder, one loose.
  const three: Song = {
    ...song(),
    tracks: [
      { id: 'lead', name: 'Lead', patch: 'p1', gain: 1 },
      { id: 'drum', name: 'Kick', patch: 'p2', gain: 0.5 },
      { id: 'hat', name: 'Hat', patch: 'p3', gain: 1 },
    ],
  }
  const filed = addFolder(three, 'kit', 'Drum kit', ['drum', 'hat'])
  const heard = (s: Song) => [...heardTracks(s)].sort().join()
  check('a folder files its tracks', filed.tracks.filter((t) => t.folder === 'kit').length === 2)
  check('and changes nothing heard', heard(filed) === 'drum,hat,lead')
  const muted = updateFolder(filed, 'kit', { mute: true })
  check('muting a folder mutes its tracks', heard(muted) === 'lead', heard(muted))
  check('and they send nothing', !songEventTicks(muted, 0, PPQ * 4).some((e) => e.track === 'drum'))
  check('unmuted, it is the folder it was', JSON.stringify(updateFolder(muted, 'kit', { mute: false }).folders) === JSON.stringify(filed.folders))
  const soloed = soloFolder(filed, 'kit')
  check('soloing a folder solos its tracks', heard(soloed) === 'drum,hat', heard(soloed))
  check('and a track\'s solo clears it: solo is exclusive', heard(soloTrack(soloed, 'lead')) === 'lead' && !soloTrack(soloed, 'lead').folders![0].solo)
  check('and a folder\'s clears a track\'s', heard(soloFolder(soloTrack(filed, 'lead'), 'kit')) === 'drum,hat')
  check('pressed again, it lets everything back in', heard(soloFolder(soloed, 'kit')) === 'drum,hat,lead')
  const quiet = updateFolder(filed, 'kit', { gain: 0.5 })
  check('a folder\'s level multiplies its tracks\'', trackMix(quiet).drum.gain === 0.25 && trackMix(quiet).lead.gain === 1,
    JSON.stringify(trackMix(quiet).drum))
  check('a level past the fader\'s top stops there', updateFolder(filed, 'kit', { gain: 7 }).folders![0].gain === 1)
  check('changing a folder to what it is is no edit', updateFolder(filed, 'kit', { name: 'Drum kit', gain: 1 }) === filed)
  check('nor is an empty name', updateFolder(filed, 'kit', { name: '  ' }) === filed)

  const moved = moveToFolder(filed, ['hat'], null)
  check('a track can leave its folder', moved.tracks.find((t) => t.id === 'hat')!.folder === undefined)
  check('and join one', moveToFolder(moved, ['lead'], 'kit').tracks.find((t) => t.id === 'lead')!.folder === 'kit')
  check('but not one that is not there', moveToFolder(moved, ['lead'], 'nope') === moved)
  const unfiled = removeFolder(muted, 'kit')
  check('removing a folder keeps its tracks', unfiled.tracks.length === 3 && unfiled.tracks.every((t) => t.folder === undefined))
  check('and lets them be heard again', heard(unfiled) === 'drum,hat,lead')
  check('and leaves no folder list', !('folders' in unfiled))

  // Hiding is tidying: a hidden track plays on.
  const hidden = updateTrack(filed, 'lead', { hidden: true })
  check('a hidden track still plays', songEventTicks(hidden, 0, PPQ * 4).some((e) => e.track === 'lead'))

  check('a search finds tracks by name', [...tracksMatching(filed, 'hat')].join() === 'hat')
  check('and by their folder\'s name', [...tracksMatching(filed, 'KIT')].sort().join() === 'drum,hat')
  check('and an empty one finds everything', tracksMatching(filed, ' ').size === 3)

  const back = parseSong(JSON.parse(JSON.stringify(updateTrack(updateTrack(quiet, 'hat', { pinned: true }), 'lead', { hidden: true }))))!
  check('folders are saved with the song', back.folders?.[0].name === 'Drum kit' && back.folders[0].gain === 0.5)
  check('and which tracks are in them', back.tracks.find((t) => t.id === 'drum')?.folder === 'kit')
  check('and which are hidden and pinned', back.tracks.find((t) => t.id === 'lead')?.hidden === true && back.tracks.find((t) => t.id === 'hat')?.pinned === true)
  const dangling = parseSong({ ...JSON.parse(JSON.stringify(filed)), folders: [] })!
  check('a track filed in a folder that is not there is filed in none', dangling.tracks.every((t) => t.folder === undefined))
}

console.log('\nsections own their bars')
{
  const BAR = PPQ * 4
  // Three one-bar patterns, one note each, so where each lands can be read
  // straight off its notes. A four-bar clip of the first straddles two
  // sections.
  const three: Song = {
    tempo: 120,
    tracks: [{ id: 't', name: 'T', patch: 't', gain: 1 }],
    patterns: ['a', 'b', 'c'].map((id, i) => ({
      id,
      name: id.toUpperCase(),
      length: BAR,
      notes: [{ track: 't', tick: 0, length: PPQ, pitch: i, velocity: 1 }],
    })),
    playlist: [
      { pattern: 'a', tick: 0, length: 3 * BAR },
      { pattern: 'b', tick: 3 * BAR, lane: 1 },
      { pattern: 'c', tick: 4 * BAR, lane: 2 },
    ],
    sections: [
      { tick: 0, length: 2 * BAR, name: 'Intro' },
      { tick: 2 * BAR, length: 2 * BAR, name: 'Verse' },
      { tick: 4 * BAR, length: BAR, name: 'Chorus' },
    ],
  }
  const at = (s: Song) =>
    songEventTicks(s, 0, 16 * BAR)
      .filter((e) => e.kind === 'on')
      .map((e) => `${e.pitch}@${e.tick / BAR}`)
      .join(' ')
  check('the song as written', at(three) === '0@0 0@1 0@2 1@3 2@4', at(three))

  const chorusFirst = moveSection(three, 4 * BAR, 0)
  check('moving a section takes its music with it', at(chorusFirst) === '2@0 0@1 0@2 0@3 1@4', at(chorusFirst))
  check('and the sections follow in their new order',
    sectionsOf(chorusFirst).map((s) => `${s.name}@${s.tick / BAR}`).join() === 'Chorus@0,Intro@1,Verse@3',
    sectionsOf(chorusFirst).map((s) => `${s.name}@${s.tick / BAR}`).join())
  check('the song is as long as it was', songEnd(chorusFirst) === songEnd(three))
  const verseLast = moveSection(three, 2 * BAR, 3)
  check('a section moved to the end', at(verseLast) === '0@0 0@1 2@2 0@3 1@4', at(verseLast))
  check('a clip across its edge is split there, and plays the same', at(moveSection(verseLast, 3 * BAR, 1)) === at(three),
    at(moveSection(verseLast, 3 * BAR, 1)))
  check('a section moved to where it already is is no edit', moveSection(three, 2 * BAR, 1) === three && moveSection(three, 2 * BAR, 2) === three)

  const twice = duplicateSection(three, 2 * BAR)
  check('duplicating a section repeats its music straight after it', at(twice) === '0@0 0@1 0@2 1@3 0@4 1@5 2@6', at(twice))
  check('with the copy named after it', sectionsOf(twice).map((s) => s.name).join() === 'Intro,Verse,Verse 2,Chorus')

  // Slid into empty time: it and its music go there, and nothing else moves.
  const slid = slideSection(three, 4 * BAR, 6 * BAR)
  check('a section slides into empty time with its music', at(slid) === '0@0 0@1 0@2 1@3 2@6', at(slid))
  check('and leaves the rest where it was', sectionsOf(slid).map((s) => s.tick / BAR).join() === '0,2,6')
  check('but not onto another section', slideSection(three, 4 * BAR, 3 * BAR) === three)
  const chorusGone = deleteSectionAndMusic(three, 2 * BAR)
  check('deleting a section with its music takes its bars out', at(chorusGone) === '0@0 0@1 2@2', at(chorusGone))
  check('and closes the song up behind it', sectionsOf(chorusGone).map((s) => `${s.name}@${s.tick / BAR}`).join() === 'Intro@0,Chorus@2')

  // Only the label, for everything that is not a move or a copy.
  const gone = removeSection(three, 2 * BAR)
  check('removing a section leaves its music', at(gone) === at(three) && sectionsOf(gone).length === 2)
  const wider = resizeSection(three, 0, 'end', 3 * BAR, PPQ)
  check('an edge stops at the next section', sectionAt(wider, 0)?.to === 2 * BAR)
  const narrower = resizeSection(three, 0, 'end', BAR, PPQ)
  check('and moving one leaves the music alone', sectionAt(narrower, 0)?.to === BAR && at(narrower) === at(three))
  check('a start moves too, never past the end', sectionAt(resizeSection(three, 2 * BAR, 'start', 10 * BAR, PPQ), 4 * BAR - PPQ) !== null)
  const cut = splitSection(three, BAR)
  check('a section cuts in two at a bar', sectionsOf(cut).map((s) => `${s.name}@${s.tick / BAR}`).join() === 'Intro@0,Intro 2@1,Verse@2,Chorus@4')

  // Overlaps read from a file are trimmed where the next begins.
  const overlapped = parseSong({ ...JSON.parse(JSON.stringify(three)), sections: [{ tick: 0, length: 3 * BAR, name: 'A' }, { tick: BAR, length: BAR, name: 'B' }] })
  check('a section running into the next is cut short there', sectionAt(overlapped!, 0)?.to === BAR)
}

console.log('\na game plays sections')
{
  const BAR = PPQ * 4
  const FRAMES = 96000 // one bar at 120 bpm
  // Silence, then a note in B, then silence: when B is heard can be read off
  // the audio to the sample.
  const s: Song = {
    tempo: 120,
    tracks: [{ id: 'lead', name: 'Lead', patch: 'p1', gain: 1 }],
    patterns: [
      { id: 'quiet', name: 'Quiet', length: BAR, notes: [] },
      { id: 'loud', name: 'Loud', length: BAR, notes: [{ track: 'lead', tick: 0, length: 2 * PPQ, pitch: 12, velocity: 1 }] },
    ],
    playlist: [
      { pattern: 'quiet', tick: 0, length: 2 * BAR },
      { pattern: 'loud', tick: 2 * BAR },
      { pattern: 'quiet', tick: 3 * BAR, length: 2 * BAR },
    ],
    sections: [
      { tick: 0, length: 2 * BAR, name: 'Calm' },
      { tick: 2 * BAR, length: BAR, name: 'Combat' },
      { tick: 3 * BAR, length: 2 * BAR, name: 'After' },
    ],
  }
  const racks = { lead: band().lead }
  const make = () => new SongPlayer(s, racks, { sampleRate: SR, routing: { strips: true, sends: false, master: false } })
  /**
   * Render so many frames and hand back the left channel. In blocks of 250,
   * which a bar, a beat and a sixteenth all divide exactly, so every run
   * stops on the frame asked for.
   */
  const BLOCK = 250
  const run = (p: SongPlayer, frames: number) => {
    const out = new Float32Array(frames)
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    for (let i = 0; i < frames; i += BLOCK) {
      p.render(l, r)
      out.set(l.subarray(0, Math.min(BLOCK, frames - i)), i)
    }
    return out
  }
  const firstSound = (buf: Float32Array) => buf.findIndex((v) => Math.abs(v) > 1e-4)

  // How long the note takes to be heard after it starts: its attack. Every
  // timing below is that far after the moment it names.
  const now = make()
  run(now, FRAMES / 4)
  now.playSection('Combat', { when: 'now' })
  const straight = run(now, 4000)
  const onset = firstSound(straight)
  check('now means now', now.section === 'Combat' && onset >= 0 && onset < 200, `${now.section}, heard ${onset} frames in`)

  const p = make()
  check('it lists the sections', p.sections.map((x) => x.name).join() === 'Calm,Combat,After')
  run(p, FRAMES / 2)
  check('and says which one is playing', p.section === 'Calm' && p.tick === BAR / 2, `${p.section} at ${p.tick}`)
  check('a name no section has is refused', !p.playSection('Boss'))
  check('a section is asked for by name, in any case', p.playSection('combat'))
  // Asked for half way through bar one: it waits for bar two to begin.
  const wait = run(p, FRAMES / 2 - BLOCK)
  check('it waits for the bar line, in silence', firstSound(wait) < 0 && p.section === 'Calm', `${firstSound(wait)}, ${p.section}`)
  const then = run(p, FRAMES / 4)
  check('and starts on it, to the sample', firstSound(then) === BLOCK + onset, `heard at ${firstSound(then)}, bar line at ${BLOCK}`)
  check('where it says it is', p.section === 'Combat')
  run(p, FRAMES * 2)
  check('it loops the section until told otherwise', p.section === 'Combat', `${p.section} at ${p.tick / BAR} bars`)
  p.releaseSection()
  run(p, FRAMES * 1.25)
  check('let go of, the song plays on past it', p.section === 'After', `${p.section} at ${p.tick / BAR} bars`)

  const beat = make()
  run(beat, FRAMES / 16)
  beat.playSection('Combat', { when: 'beat' })
  const toBeat = run(beat, FRAMES / 4)
  check('on the next beat', firstSound(toBeat) === FRAMES / 4 - FRAMES / 16 + onset, String(firstSound(toBeat)))

  const phrase = make()
  run(phrase, FRAMES / 4)
  phrase.playSection('After', { when: 'section' })
  run(phrase, FRAMES)
  check('at the end of the section playing', phrase.section === 'Calm', String(phrase.section))
  run(phrase, FRAMES)
  check('and not before', phrase.section === 'After', String(phrase.section))

  const once = make()
  once.playSection('Combat', { when: 'now', loop: false })
  run(once, FRAMES + FRAMES / 2)
  check('played once, a section runs on into the next', once.section === 'After', String(once.section))
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
    chordPitches(root, chordById(id)!, inversion, scale, TWO_OCTAVES).join()
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

console.log('\na file that says something the editor never would')
{
  const scale = { root: 0, mode: 'major' }
  // Once, these walked forever: a fractional row never lands on another row.
  check('a scale step from a fractional pitch finishes', Number.isInteger(stepInScale(4.5, 1, scale)))
  check('and a count of degrees from one does too', Number.isInteger(degreesBetween(0.5, 7.25, scale)))
  check('a fractional root does not hang either', Number.isInteger(stepInScale(2, 3, { root: 0.4, mode: 'major' })))

  const parsed = parseSong({
    tempo: 120,
    tracks: [
      { id: 'lead', name: 'Lead', patch: 'lead', gain: 1 },
      { id: '__proto__', name: 'Sneaky', patch: '__proto__', gain: 1 },
    ],
    patterns: [
      {
        id: 'a',
        name: 'A',
        length: 3,
        notes: [
          { track: 'lead', tick: 10.4, length: 99.6, pitch: 4.5, velocity: 0 },
          { track: '__proto__', tick: 0, length: 10, pitch: 0, velocity: 1 },
        ],
      },
    ],
    playlist: [
      { pattern: 'a', tick: 0 },
      { pattern: 'a', tick: 0 },
      { pattern: 'a', tick: 1920.2 },
    ],
    // From before sections had lengths: markers, each running to the next.
    markers: [
      { tick: 0, name: 'Intro' },
      { tick: 0.2, name: 'Also intro' },
    ],
  })
  if (!parsed) {
    check('a strange file still reads', false)
  } else {
    const n = parsed.patterns[0].notes[0]
    check('ticks, lengths and pitches are whole', n.tick === 10 && n.length === 100 && n.pitch === 5, JSON.stringify(n))
    check('a silent note is lifted to the quietest the editor allows', n.velocity === 0.01, String(n.velocity))
    check('a pattern is never shorter than the editor allows', parsed.patterns[0].length === PPQ, String(parsed.patterns[0].length))
    check('a duplicate placement is dropped', parsed.playlist.length === 2, JSON.stringify(parsed.playlist))
    check('a placement tick is whole', parsed.playlist[1]?.tick === 1920)
    check('two old markers on one tick are one section', parsed.sections?.length === 1 && parsed.sections[0].name === 'Intro',
      JSON.stringify(parsed.sections))
    check('a track called __proto__ is refused', parsed.tracks.length === 1 && parsed.tracks[0].id === 'lead')
    check('and its notes with it', parsed.patterns[0].notes.length === 1)
    check('nothing leaked onto the prototype', Object.getPrototypeOf(parsed) === Object.prototype)
  }

  // Through the project reader, where track ids become keys of the racks.
  const project = fromStoredProject({
    version: 1,
    name: 'Proto',
    song: {
      tempo: 120,
      tracks: [
        { id: 'lead', name: 'Lead', patch: 'lead', gain: 1 },
        { id: '__proto__', name: 'Sneaky', patch: '__proto__', gain: 1 },
        { id: 'toString', name: 'Borrowed', patch: 'toString', gain: 1 },
      ],
      patterns: [{ id: 'a', name: 'A', length: PPQ * 4, notes: [] }],
      playlist: [],
    },
    racks: JSON.parse('{"lead": {"version": 1, "patch": {"modules": [], "cables": []}}, "__proto__": {"version": 1, "patch": {"modules": [], "cables": []}}}'),
  })
  if ('error' in project) {
    check('a project with a __proto__ track reads', false, project.error)
  } else {
    check('a project with a __proto__ track reads, without it', project.song.tracks.every((t) => t.id !== '__proto__'))
    check('the racks keep their ordinary prototype', Object.getPrototypeOf(project.racks) === Object.prototype)
    check('a track named like a built-in gets no borrowed rack', !('toString' in project.racks && Object.prototype.hasOwnProperty.call(project.racks, 'toString')))
  }

  // A clip on beat two of bar two stays on beat two of bar two, as far as the
  // new bar reaches.
  const folded = setMeter(
    song({ playlist: [{ pattern: 'a', tick: 4 * PPQ + PPQ }, { pattern: 'a', tick: 3 * PPQ }] }),
    { beats: 3, unit: 4 },
  )
  check('a meter change keeps a clip on its beat', folded.playlist[0].tick === 3 * PPQ + PPQ, JSON.stringify(folded.playlist))
  check('or at the end of a bar that no longer reaches it', folded.playlist[1].tick === 3 * PPQ - 1, JSON.stringify(folded.playlist))
}

console.log('\nsong edits that change nothing')
{
  const s = song()
  check('updating a track to what it already is', updateTrack(s, 'lead', { name: 'Lead', gain: 1 }) === s)
  check('updating a track that is not there', updateTrack(s, 'nope', { name: 'X' }) === s)
  check('but a real change is an edit', updateTrack(s, 'lead', { name: 'Tune' }) !== s)
  check('reordering into the same order', reorderTracks(s, ['lead', 'drum']) === s)
  check('setting a pattern to its own length', setPatternLength(s, 'a', PPQ * 4) === s)
  check('setting a pattern to the notes it has', setPatternNotes(s, 'a', s.patterns[0].notes.map((n) => ({ ...n }))) === s)
  check('but different notes are an edit', setPatternNotes(s, 'a', []) !== s)
  check('a strip set to what it already is', updateStrip(s, 'lead', { pan: 0, eq: { low: 0, mid: 0, high: 0 } }) === s)
  check('the desk set to what it already is', updateConsole(s, { master: { limiter: true }, space: {} }) === s)
  check('but a real desk change is an edit', updateConsole(s, { master: { limiter: false } }) !== s)
  check('solo on a track that is not there', soloTrack(s, 'nope') === s)
}

console.log('\nswing')
{
  const bar = PPQ * 4
  const S16 = PPQ / 4
  const straight = { length: bar }
  const hard = { length: bar, swing: { amount: 0.75, step: S16 } }
  check('straight leaves every tick alone', [0, 120, 240, 700].every((t) => swungTick(t, straight) === t))
  check('the first tick of every pair stays put', [0, 480, 960, 1440].every((t) => swungTick(t, hard) === t))
  check('the second step lands three quarters through its pair', swungTick(S16, hard) === 360, String(swungTick(S16, hard)))
  check('a tick between steps swings by its share', swungTick(120, hard) === 180, String(swungTick(120, hard)))
  let ordered = true
  for (let t = 1; t < bar; t++) if (!(swungTick(t, hard) > swungTick(t - 1, hard))) ordered = false
  check('nothing overtakes anything else', ordered)
  let inverse = 0
  for (let t = 0; t <= bar; t += 7) inverse = Math.max(inverse, Math.abs(unswungTick(swungTick(t, hard), hard) - t))
  check('a moment played can be turned back into the tick written', inverse < 1e-9, `worst ${inverse}`)
  // A pattern that stops half way through a pair would swing its last notes
  // past its own end and over whatever comes next.
  const ragged = { length: 480 + 240, swing: { amount: 0.75, step: S16 } }
  check('a pair cut short by the end of the pattern is left straight', swungTick(600, ragged) === 600)

  const swung = song({
    patterns: [
      {
        id: 'a',
        name: 'A',
        length: bar,
        notes: [
          { track: 'lead', tick: 0, length: S16, pitch: 0, velocity: 1 },
          { track: 'lead', tick: S16, length: S16, pitch: 2, velocity: 1 },
        ],
        swing: { amount: 2 / 3, step: S16 },
      },
    ],
    playlist: [{ pattern: 'a', tick: 0 }],
  })
  const ev = songEventTicks(swung, 0, bar)
  const on2 = ev.find((e) => e.kind === 'on' && e.pitch === 2)!.tick
  const off1 = ev.find((e) => e.kind === 'off' && e.pitch === 0)!.tick
  check('the off-step note plays late', Math.abs(on2 - 320) < 1e-9, String(on2))
  check('and the note before it holds until it does', Math.abs(off1 - on2) < 1e-9, `${off1} / ${on2}`)

  // Kept by the file, and only as a swing can be.
  const back = parseSong(JSON.parse(JSON.stringify(swung)))!
  check('a swing survives a save and a load', back.patterns[0].swing?.amount === 0.667, JSON.stringify(back.patterns[0].swing))
  const odd = parseSong(
    JSON.parse(
      JSON.stringify({
        ...swung,
        patterns: [
          { ...swung.patterns[0], id: 'x', swing: { amount: 3, step: 77 } },
          { ...swung.patterns[0], id: 'y', swing: { amount: 0.4 } },
          { ...swung.patterns[0], id: 'z', swing: 'lots' },
        ],
        playlist: [],
      }),
    ),
  )!
  check('too much swing is as much as there is', odd.patterns[0].swing?.amount === 0.75, JSON.stringify(odd.patterns[0].swing))
  check('and a step that is not one of the two is sixteenths', odd.patterns[0].swing?.step === S16)
  check('less than straight is straight', odd.patterns[1].swing === undefined)
  check('and nonsense is nothing', odd.patterns[2].swing === undefined)

  // Edits, and what undo sees of them.
  const same = setPatternSwing(swung, 'a', 2 / 3, S16)
  check('setting the swing it already has changes nothing', setPatternSwing(same, 'a', 0.667, S16) === same)
  const flat = setPatternSwing(swung, 'a', 0.5, S16)
  check('straightening it takes the swing off the pattern', !('swing' in flat.patterns[0]))
  check('and an unknown pattern is left alone', setPatternSwing(swung, 'nope', 0.6, S16) === swung)
  const copied = duplicatePattern(swung, 'a', 'b', 'B').patterns[1]
  check('a copy of a pattern swings the way it did', copied.swing?.amount === swung.patterns[0].swing?.amount)

  // A swing pulled back while a note holds. Swung hard, the note below
  // starts at 360 and ends at 420; straight, it would end at 360. With the
  // scheduler's cursor at 400 its start has gone out and its end has not --
  // and the new end is behind the cursor, where no pass will ever send it.
  const shortNote = song({
    patterns: [
      {
        id: 'a',
        name: 'A',
        length: bar,
        notes: [{ track: 'lead', tick: S16, length: S16 / 2, pitch: 7, velocity: 1 }],
        swing: { amount: 0.75, step: S16 },
      },
    ],
    playlist: [{ pattern: 'a', tick: 0 }],
  })
  const cursor = 400
  const released = releasedBySwing(shortNote, setPatternSwing(shortNote, 'a', 0.5, S16), cursor)
  check(
    'a note whose end the swing moved behind the cursor is let go of there',
    released.length === 1 && released[0].kind === 'off' && released[0].tick === cursor,
    JSON.stringify(released),
  )
  const longNote = {
    ...shortNote,
    patterns: [{ ...shortNote.patterns[0], notes: [{ ...shortNote.patterns[0].notes[0], length: S16 }] }],
  }
  check(
    'one whose end is still ahead is left for the scheduler',
    releasedBySwing(longNote, setPatternSwing(longNote, 'a', 0.5, S16), cursor).length === 0,
  )
  check('and a change of notes is not mistaken for a change of swing', releasedBySwing(shortNote, longNote, cursor).length === 0)

  // Another pattern's notes, drawn behind this one where they are heard.
  // Under a swung pattern, the straight pattern's off-step note is handed
  // back at the written tick this pattern would carry to the same moment.
  const layered = song({
    patterns: [
      { id: 'a', name: 'A', length: bar, notes: [], swing: { amount: 0.75, step: S16 } },
      { id: 'b', name: 'B', length: bar, notes: [{ track: 'drum', tick: S16, length: S16, pitch: 0, velocity: 1 }] },
    ],
    playlist: [{ pattern: 'a', tick: 0 }, { pattern: 'b', tick: 0 }],
  })
  const asWritten = contextNotes(layered, 'a', 0)[0]
  const asHeard = contextNotes(layered, 'a', 0, true)[0]
  check('behind a pattern, another is drawn as written unless asked', asWritten.tick === S16)
  check(
    'and where it is heard when asked',
    Math.abs(swungTick(asHeard.tick, layered.patterns[0]) - S16) < 1e-9 &&
      Math.abs(swungTick(asHeard.tick + asHeard.length, layered.patterns[0]) - 2 * S16) < 1e-9,
    JSON.stringify(asHeard),
  )

  // The game's handle on it.
  const player = new SongPlayer(swung, band(), { sampleRate: SR })
  check('a game can swing a pattern by name', player.setSwing(0.6, 'A') && player.getSwing('A') === 0.6)
  check('or every pattern at once', player.setSwing(0.7) && player.getSwing('a') === 0.7)
  check('and is told when there is no such pattern', player.setSwing(0.6, 'nothing') === false)
  const bl = new Float32Array(512)
  const br = new Float32Array(512)
  let finite = true
  for (let i = 0; i < 200; i++) {
    if (i % 20 === 0) player.setSwing(0.5 + (i % 40) / 160)
    player.render(bl, br)
    if (!bl.every(Number.isFinite)) finite = false
  }
  check('and turning it while the song plays is safe', finite)
}

console.log('\nnaming the rows by the notes they play')
{
  const mod = (id: string, type: string) => ({ id, type, params: {} })
  const wire = (from: string, fromPort: string, to: string, toPort: string) => ({
    id: `${from}-${to}-${toPort}`,
    from: { module: from, port: fromPort },
    to: { module: to, port: toPort },
  })
  type Extra = { modules?: ReturnType<typeof mod>[]; cables?: ReturnType<typeof wire>[] }
  const C4 = 261.6256
  const rack = (values: Record<string, number>, extra: Extra = {}) => ({
    patch: {
      modules: [mod('key1', 'keys'), mod('osc1', 'osc'), ...(extra.modules ?? [])],
      cables: extra.cables ?? [wire('key1', 'pitch', 'osc1', 'fm')],
    },
    values,
  })
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001

  const plain = tuningOf(rack({ 'osc1.pitch': C4 }))
  check('an oscillator at middle C names the bottom key C4',
    !!plain && near(rowZero(plain), 60) && midiName(rowZero(plain)) === 'C4', JSON.stringify(plain))
  check('and says which module it read', plain?.source === 'osc1')
  const up = tuningOf(rack({ 'osc1.pitch': C4, 'osc1.octave': 1, 'key1.octave': -2 }))
  check("the oscillator's Octave and the Keyboard's both count", !!up && near(rowZero(up), 60 + 12 - 24), JSON.stringify(up))
  const byPitch = tuningOf(rack({ 'osc1.pitch': 440 }, { cables: [wire('key1', 'pitch', 'osc1', 'pitch')] }))
  check('through the Pitch jack as well as FM', !!byPitch && near(rowZero(byPitch), 69))
  const quarter = tuningOf(rack({ 'osc1.pitch': 440 * 2 ** (0.5 / 12) }))
  check('a quarter tone is kept, not rounded', !!quarter && near(rowZero(quarter), 69.5), JSON.stringify(quarter))
  check('and reads as the nearest note and how far off it is',
    midiNameCents(69.26) === 'A4 +26¢' && midiNameCents(59.9) === 'C4 -10¢', `${midiNameCents(69.26)}, ${midiNameCents(59.9)}`)
  const glide = tuningOf(rack({ 'osc1.pitch': C4 }, {
    modules: [mod('slew1', 'slew')],
    cables: [wire('key1', 'pitch', 'slew1', 'in'), wire('slew1', 'out', 'osc1', 'fm')],
  }))
  check('it follows the pitch through a Slew', !!glide && near(rowZero(glide), 60))
  const stack = tuningOf(rack({ 'osc1.pitch': C4 * 2 ** (-0.07 / 12), 'osc2.pitch': C4 * 2 ** (0.07 / 12), 'osc3.pitch': C4 * 2 }, {
    modules: [mod('osc2', 'osc'), mod('osc3', 'osc')],
    cables: [wire('key1', 'pitch', 'osc1', 'fm'), wire('key1', 'pitch', 'osc2', 'fm'), wire('key1', 'pitch', 'osc3', 'fm')],
  }))
  check('a detuned pair reads as the note between them, and the octave above is left out',
    !!stack && near(rowZero(stack), 60), JSON.stringify(stack))
  check('nothing tuned on the Keyboard names nothing', tuningOf(rack({}, { cables: [] })) === null)
  check('and neither does a drum',
    tuningOf({ patch: { modules: [mod('gate1', 'gate'), mod('osc1', 'osc')], cables: [] }, values: {} }) === null)
  check('untuned, the bottom key is C0 as before',
    rowZero(null) === 12 && midiName(rowZero(null)) === 'C0' && midiName(0) === 'C-1')

  const aMinor = { root: 9, mode: 'minor' }
  check('A minor on a track tuned to A starts on its bottom row', scaleForRows(aMinor, 57)?.root === 0)
  check('and on a track tuned to C, nothing moves', scaleForRows(aMinor, 60)?.root === 9 && scaleForRows(aMinor, 12)?.root === 9)
}

console.log('\nthe roll\'s tools')
{
  const G = PPQ / 4
  const n = (tick: number, pitch: number, length = G, velocity = 0.8) => ({ track: 't', tick, length, pitch, velocity })
  const at = (e: { notes: { tick: number; pitch: number; length: number }[] }) =>
    [...e.notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch).map((x) => `${x.tick}:${x.pitch}:${x.length}`).join(' ')

  const chopped = chopNotes([n(0, 0, 4 * G + 100), n(0, 7)], [0], G)
  check('Chop cuts a held note into grid steps, the last one what is left',
    at(chopped) === `0:0:${G} 0:7:${G} ${G}:0:${G} ${2 * G}:0:${G} ${3 * G}:0:${G} ${4 * G}:0:100`, at(chopped))
  check('and leaves the pieces selected, and nothing else', chopped.selected.length === 5 &&
    chopped.selected.every((i) => chopped.notes[i].pitch === 0))

  const chord = [n(0, 7, 960), n(0, 0, 960), n(0, 4, 960)]
  const up = strumNotes(chord, [0, 1, 2], 30, false)
  check('Strum up plays a chord lowest first, a string at a time', at(up) === '0:0:960 30:4:930 60:7:900', at(up))
  const down = strumNotes(chord, [0, 1, 2], 30, true)
  check('and down, highest first, with every end where it was', at(down) === '0:7:960 30:4:930 60:0:900', at(down))

  const arp = arpeggiateNotes(chord, [0, 1, 2], G, false, 4 * PPQ)
  check('Arpeggiate runs up the chord a step at a time for as long as it is held',
    arp.notes.length === 4 && at(arp) === `0:0:${G} ${G}:4:${G} ${2 * G}:7:${G} ${3 * G}:0:${G}`, at(arp))
  const arpDown = arpeggiateNotes(chord, [0, 1, 2], G, true, 4 * PPQ)
  check('and down it, highest first', arpDown.notes.map((x) => x.pitch).join() === '7,4,0,7')
  check('a note on its own is not arpeggiated', at(arpeggiateNotes([n(G, 5)], [0], G, false, 4 * PPQ)) === `${G}:5:${G}`)

  const flam = flamNotes([n(0, 3), n(PPQ, 3)], [0, 1], 48)
  check('Flam puts a softer grace note just before each note',
    at(flam) === `0:3:${G} ${PPQ - 48}:3:48 ${PPQ}:3:${G}` && flam.notes.some((x) => x.tick === PPQ - 48 && x.velocity < 0.8), at(flam))
  check('and none where there is no room before it', flam.notes.filter((x) => x.tick < 48).length === 1)

  const phrase = [n(0, 0, G), n(G, 2, G), n(3 * G, 4, G)]
  const back = reverseNotes(phrase, [0, 1, 2])
  check('Reverse plays the phrase backwards in the same span', at(back) === `0:4:${G} ${2 * G}:2:${G} ${3 * G}:0:${G}`, at(back))

  let r = 0
  const seq = () => [0.99, 0, 0.5, 0.25][r++ % 4]
  const cMajor = { root: 0, mode: 'major' }
  const random = randomizePitches([n(0, 0), n(G, 0), n(2 * G, 0), n(3 * G, 0)], [0, 1, 2, 3], PITCH_RANGE,
    (p) => nearestInScale(p, cMajor), seq)
  const pitches = random.notes.map((x) => x.pitch)
  check('Randomize pitch keeps the rhythm and moves the pitches within an octave of where they were',
    random.notes.map((x) => x.tick).join() === `0,${G},${2 * G},${3 * G}` && pitches.every((p) => p >= 0 && p <= 12) &&
      new Set(pitches).size > 1, pitches.join())
  check('and onto the key when there is one', pitches.every((p) => inScale(p, cMajor)), pitches.join())

  const others = [n(0, 9), ...chord]
  const onlyPicked = strumNotes(others, [1, 2, 3], 30, false)
  check('a tool leaves the notes it was not given alone', onlyPicked.notes[0].pitch === 9 && onlyPicked.notes[0].tick === 0)
}

console.log('\nediting a range of bars')
{
  const BAR = PPQ * 4
  // A two-bar pattern played from bar 1 and bar 5, under a section on each.
  const base: Song = {
    tempo: 120,
    tracks: [{ id: 't', name: 'T', patch: 't', gain: 1 }],
    patterns: [{ id: 'p', name: 'P', length: 2 * BAR, notes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ track: 't', tick: i * PPQ, length: 240, pitch: i, velocity: 1 })) }],
    playlist: [{ pattern: 'p', tick: 0 }, { pattern: 'p', tick: 4 * BAR }],
    sections: [{ tick: 0, length: 2 * BAR, name: 'A' }, { tick: 4 * BAR, length: 2 * BAR, name: 'B' }],
  }
  const heard = (s: Song, from = 0, to = 12 * BAR) =>
    songEventTicks(s, from, to).filter((e) => e.kind === 'on').map((e) => `${e.tick}:${e.pitch}`).join(' ')

  const opened = insertTime(base, 3 * BAR, BAR)
  check('empty bars put in between clips move everything after them', opened.playlist[1].tick === 5 * BAR)
  check('and the sections after them', opened.sections![1].tick === 5 * BAR && opened.sections![0].tick === 0)
  check('with nothing played in the new bars', heard(opened, 3 * BAR, 4 * BAR) === '')
  const mid = insertTime(base, BAR, BAR)
  check('bars put in across a clip split it, and what it plays moves with its half',
    heard(mid, 0, BAR) === heard(base, 0, BAR) && heard(mid, 2 * BAR, 3 * BAR) === heard(base, BAR, 2 * BAR).split(' ').map((x) => {
      const [t, p] = x.split(':')
      return `${Number(t) + BAR}:${p}`
    }).join(' '), heard(mid, 0, 3 * BAR))
  check('and a section across them grows round them', mid.sections![0].length === 3 * BAR)
  check('taking the same bars back out is the song it was', heard(deleteTime(mid, { from: BAR, to: 2 * BAR })) === heard(base))

  const gone = deleteTime(base, { from: BAR, to: 5 * BAR })
  check('deleting a range closes the song up behind it', gone.playlist.every((p) => p.tick < 2 * BAR) && heard(gone, 0, BAR) === heard(base, 0, BAR))
  check('what was after it plays sooner by its length', heard(gone, BAR, 2 * BAR) === heard(base, 5 * BAR, 6 * BAR).split(' ').map((x) => {
    const [t, p] = x.split(':')
    return `${Number(t) - 4 * BAR}:${p}`
  }).join(' '))
  check('sections lose the bars that went', gone.sections!.map((s) => `${s.name}:${s.tick}+${s.length}`).join() === `A:0+${BAR},B:${BAR}+${BAR}`,
    JSON.stringify(gone.sections))
  check('and one with all its bars gone goes too', deleteTime(base, { from: 3 * BAR, to: 7 * BAR }).sections!.length === 1)

  const cleared = clearTime(base, { from: BAR, to: 5 * BAR })
  check('clearing a range empties it and moves nothing', heard(cleared, BAR, 5 * BAR) === '' && heard(cleared, 5 * BAR, 6 * BAR) === heard(base, 5 * BAR, 6 * BAR))
  check('clearing empty bars is no edit', clearTime(base, { from: 2 * BAR, to: 4 * BAR }) === base)

  const twice = duplicateTime(base, { from: 0, to: 2 * BAR })
  check('duplicating a range plays it twice running', heard(twice, 2 * BAR, 4 * BAR) === heard(base, 0, 2 * BAR).split(' ').map((x) => {
    const [t, p] = x.split(':')
    return `${Number(t) + 2 * BAR}:${p}`
  }).join(' '))
  check('the copy of a section in it gets a name of its own', twice.sections!.map((s) => s.name).join() === 'A,A 2,B', twice.sections!.map((s) => s.name).join())
  check('and what came after moves over', twice.sections![2].tick === 6 * BAR)

  const held = copyTime(base, { from: BAR, to: 2 * BAR })!
  const pasted = pasteTime(base, 8 * BAR, held)
  check('a copied range pastes in elsewhere, opening the song up there', heard(pasted, 8 * BAR, 9 * BAR) === heard(base, BAR, 2 * BAR).split(' ').map((x) => {
    const [t, p] = x.split(':')
    return `${Number(t) + 7 * BAR}:${p}`
  }).join(' '))
  check('a loop across inserted bars grows with them', insertTime({ ...base, loop: { from: 0, to: 4 * BAR } }, BAR, BAR).loop?.to === 5 * BAR)
  check('an empty range is no edit', deleteTime(base, { from: BAR, to: BAR }) === base && insertTime(base, BAR, 0) === base)
}

console.log('\nrecording notes played in')
{
  const L = PPQ * 4
  const loop = { from: 0, to: L }
  check('a note held over the seam lasts to the end and on from the top', spanTicks(L - 100, 50, loop) === 150)
  check('without a loop time only goes forward', spanTicks(500, 400, null) === 0)
  check('a song tick becomes a tick in the pattern', patternTick(L + 240, L, L) === 240)
  check('and nothing outside the bars the pattern is played over', patternTick(L - 10, L, L) === null && patternTick(2 * L, L, L) === null)

  const held = { start: 250, pitch: 7, velocity: 0.6 }
  const plain = recordedNote('t', held, 700, 0, L, loop)
  check('a released key is a note where it went down, as long as it was held',
    plain?.tick === 250 && plain.length === 450 && plain.pitch === 7 && plain.velocity === 0.6, JSON.stringify(plain))
  const tap = recordedNote('t', held, 251, 0, L, loop)
  check('a tap is never too short to see', tap?.length === MIN_RECORDED, String(tap?.length))
  const over = recordedNote('t', { ...held, start: L - 120 }, 300, 0, L, loop)
  check('a note held over the seam is cut at the end, not wrapped', over?.tick === L - 120 && over.length === 120, JSON.stringify(over))
  const snapped = recordedNote('t', held, 700, 0, L, loop, { grid: PPQ / 4, what: 'start', strength: 1 })
  check('quantize on input lands it on the grid as it is written', snapped?.tick === 240 && snapped.length === 450, JSON.stringify(snapped))
  const halfway = recordedNote('t', held, 700, 0, L, loop, { grid: PPQ / 4, what: 'start', strength: 0.5 })
  check('at the strength asked for', halfway?.tick === 245, JSON.stringify(halfway))
  const inSong = recordedNote('t', { ...held, start: 2 * L + 480 }, 2 * L + 960, 2 * L, L, { from: 2 * L, to: 3 * L })
  check('a pattern heard in the song records against its own start', inSong?.tick === 480, JSON.stringify(inSong))

  const a = { track: 't', tick: 240, length: 100, pitch: 7, velocity: 0.5 }
  const twice = addRecorded(addRecorded([], a), { ...a, velocity: 0.9 })
  check('playing the same note again on the next pass replaces it', twice.length === 1 && twice[0].velocity === 0.9)
  check('a different note beside it is added', addRecorded([a], { ...a, pitch: 9 }).length === 2)

  check('a MIDI note on is read with its velocity',
    JSON.stringify(parseMidi([0x93, 60, 127])) === JSON.stringify({ kind: 'on', note: 60, velocity: 1 }))
  check('a note on at velocity zero is a release', parseMidi([0x90, 60, 0])?.kind === 'off')
  check('so is a note off', parseMidi([0x80, 61, 40])?.kind === 'off' && parseMidi([0x80, 61, 40])?.note === 61)
  check('anything else is not a note', parseMidi([0xb0, 1, 64]) === null && parseMidi([0xf8]) === null)
  check('a controller key plays the row named for it', rowForMidi(60, { source: 'o', base: 48, octave: 0 }) === 12)
  check('with the Keyboard octave counted', rowForMidi(60, { source: 'o', base: 48, octave: 1 }) === 0)
  check('an untuned track still has a C4', rowForMidi(60, null) === 48)
  check('and nothing lands outside the rows', rowForMidi(127, { source: 'o', base: 0, octave: -3 }) === PITCH_RANGE.high)
}

console.log('\nthe History list names each edit')
{
  const patch = defaultPatch()
  const base = { name: 'P', song: benchSong(), racks: { bench: { patch, values: rackValues(patch) } } }
  const withNotes = (notes: Song['patterns'][0]['notes']) => ({
    ...base,
    song: setPatternNotes(base.song, 'main', notes),
  })
  const note = { track: 'bench', tick: 0, length: 240, pitch: 0, velocity: 0.8 }
  const one = withNotes([note])
  check('a drawn note is called one', describeEdit(base, one) === 'Add note', describeEdit(base, one))
  const moved = withNotes([{ ...note, tick: 240 }])
  check('a dragged note is a move', describeEdit(one, moved) === 'Move note', describeEdit(one, moved))
  check('the lane is velocity', describeEdit(one, withNotes([{ ...note, velocity: 0.3 }])) === 'Velocity · note')
  check('deleting says how many', describeEdit(withNotes([note, note, note]), base) === 'Delete 3 notes')
  const m = patch.modules[0]
  const spec = defOf(m.type).params[0]
  const knob = { ...base, racks: { bench: { patch, values: { ...base.racks.bench.values, [`${m.id}.${spec.id}`]: 0.123 } } } }
  check('a knob is named with its module', describeEdit(base, knob) === `${spec.label} · ${m.id}`, describeEdit(base, knob))
  const lost = { ...base, racks: { bench: { patch: { ...patch, modules: patch.modules.slice(1) }, values: base.racks.bench.values } } }
  check('a removed module is named by kind', describeEdit(base, lost) === `Remove ${defOf(m.type).name}`, describeEdit(base, lost))
  check('the tempo says what it is now', describeEdit(base, { ...base, song: { ...base.song, tempo: 128 } }) === 'Tempo 128')
  const split = {
    ...base,
    song: { ...base.song, playlist: [{ pattern: 'main', tick: 0, length: 960 }, { pattern: 'main', tick: 960, offset: 960, length: 2880 }] },
  }
  check('a split clip is a split', describeEdit(base, split) === 'Split clip', describeEdit(base, split))
}

console.log('\ntempo changes')
{
  const BAR = PPQ * 4
  // 120 for two bars, then 60: a quarter is 24000 samples, then 48000.
  const slow = song({
    tempos: [{ tick: 2 * BAR, bpm: 60 }],
    patterns: [
      {
        id: 'a',
        name: 'A',
        length: 4 * BAR,
        notes: [
          { track: 'lead', tick: 0, length: PPQ, pitch: 0, velocity: 1 },
          { track: 'lead', tick: 2 * BAR, length: PPQ, pitch: 1, velocity: 1 },
          { track: 'lead', tick: 2 * BAR + PPQ, length: PPQ, pitch: 2, velocity: 1 },
          // Across the change: starts at 120, lets go at 60.
          { track: 'drum', tick: 2 * BAR - PPQ / 2, length: PPQ, pitch: 0, velocity: 1 },
        ],
      },
    ],
  })
  const time = tempoMap(slow, SR)
  check('before the change, the old clock', time.frameAt(BAR) === 96000, `got ${time.frameAt(BAR)}`)
  check('the change lands where two bars at 120 end', time.frameAt(2 * BAR) === 192000, `got ${time.frameAt(2 * BAR)}`)
  check('and a beat after it takes twice as long', time.frameAt(2 * BAR + PPQ) === 240000, `got ${time.frameAt(2 * BAR + PPQ)}`)
  check('frames back to ticks, either side', time.tickAt(96000) === BAR && time.tickAt(240000) === 2 * BAR + PPQ)
  check('a span across the change is the sum of both sides', time.span(BAR, 2 * BAR + PPQ) === 144000)
  check('and advancing across it lands where the frames say', time.advance(BAR, 144000) === 2 * BAR + PPQ)
  check('the tempo at a tick is the last change before it', tempoAt(slow, 2 * BAR - 1) === 120 && tempoAt(slow, 2 * BAR) === 60)
  check('and a tick is in seconds from the start', secondsAt(slow, 2 * BAR + PPQ) === 5, `got ${secondsAt(slow, 2 * BAR + PPQ)}`)
  check('one tempo is the same clock as ever', T120.frameAt(12345) === 12345 * 25 && T120.span(10, 20) === 250)
  check('the map is kept while the tempo is', tempoMap(slow, SR) === time && tempoMap({ tempo: slow.tempo, tempos: slow.tempos }, SR) === time)

  const events = songEvents(slow, SR, 0, 4 * BAR)
  const onAt = (pitch: number) => events.find((e) => e.track === 'lead' && e.kind === 'on' && e.pitch === pitch)?.frame
  check('a note after the change is heard on the slower clock', onAt(1) === 192000 && onAt(2) === 240000, `${onAt(1)} ${onAt(2)}`)
  const drumOff = events.find((e) => e.track === 'drum' && e.kind === 'off')?.frame
  check('a note across the change lets go on the slower clock', drumOff === 192000 + 24000, `got ${drumOff}`)

  // The transport's windows, however they fall, have to agree with the whole.
  for (const step of [997, 4800, 24000]) {
    const tiled: SongEvent[] = []
    let cursor = { tick: 0, frame: 0 }
    for (let until = step; ; until += step) {
      const out = fill(slow, SR, cursor, until, null)
      tiled.push(...out.events)
      cursor = out.cursor
      if (out.ended) break
    }
    const key = (e: SongEvent) => `${e.frame}/${e.track}/${e.kind}/${e.pitch}`
    const whole = songEvents(slow, SR, 0, 4 * BAR + 1)
    check(`windows of ${step} frames schedule what the whole song does`,
      tiled.map(key).join() === whole.map(key).join(), `${tiled.length} vs ${whole.length}`)
  }

  // A loop across the change goes round in the frames the change makes it.
  const loop = { from: BAR, to: 3 * BAR }
  const pass = time.span(loop.from, loop.to)
  check('a pass of a loop across the change is a bar at each tempo', pass === 96000 + 192000, `got ${pass}`)
  const looped = fill(slow, SR, { tick: BAR, frame: 0 }, pass * 2 + 10, loop)
  const second = looped.events.filter((e) => e.track === 'lead' && e.kind === 'on' && e.pitch === 1).map((e) => e.frame)
  check('and comes round to the same note a pass later', second.length === 2 && second[1] - second[0] === pass, JSON.stringify(second))
  check('the playhead follows the slower clock', playheadTick(96000 + 48000, 0, BAR, time, null) === 2 * BAR + PPQ)
  check('and wraps a loop by its frames, not its ticks', playheadTick(pass + 96000 + 48000, 0, BAR, time, loop) === 2 * BAR + PPQ)
  check('a start before the loop plays up to it first', playheadTick(96000, 0, 0, time, loop) === BAR && playheadTick(96000 + pass, 0, 0, time, loop) === BAR)
  check('and a frame before the start is still inside the loop', playheadTick(-48000, 0, BAR, time, loop) === 3 * BAR - PPQ,
    `got ${playheadTick(-48000, 0, BAR, time, loop)}`)

  // A game hears the tick the tempo says.
  const player = new SongPlayer(slow, band(), { sampleRate: SR })
  const l = new Float32Array(192000 + 48000)
  const r = new Float32Array(l.length)
  player.render(l, r)
  check('the game hears the tick the tempo says', Math.abs(player.tick - (2 * BAR + PPQ)) < 1, `got ${player.tick}`)
}

console.log('\nmeter changes')
{
  const BAR = PPQ * 4
  // Two bars of 4/4, then 3/4.
  const s = song({ meters: [{ tick: 2 * BAR, meter: { beats: 3, unit: 4 } }] })
  const bars = barsOf(s)
  check('the bars before the change are 4/4', bars.bar(1).tick === BAR && bars.bar(1).length === BAR)
  check('the change starts a bar of 3/4', bars.bar(2).tick === 2 * BAR && bars.bar(2).length === 3 * PPQ)
  check('and the next is three beats on', bars.bar(3).tick === 2 * BAR + 3 * PPQ, `got ${bars.bar(3).tick}`)
  check('a tick finds its bar', bars.at(2 * BAR + 4 * PPQ).index === 3)
  check('the meter at a tick', bars.meterAt(2 * BAR).beats === 3 && bars.meterAt(2 * BAR - 1).beats === 4)
  check('snapping to a bar uses the bar it is in', bars.snapBar(2 * BAR + PPQ, 'ceil') === 2 * BAR + 3 * PPQ)
  check('and rounds to the nearer barline', bars.snapBar(2 * BAR + 2 * PPQ) === 2 * BAR + 3 * PPQ && bars.snapBar(BAR + PPQ) === BAR)
  check('a beat is counted from the start of its bar', bars.snapIn(2 * BAR + PPQ + 100, PPQ, 'floor') === 2 * BAR + PPQ)
  check('the bars between two ticks', bars.between(BAR, 2 * BAR + 4 * PPQ).map((b) => b.index).join() === '1,2,3')
  check('the playlist counts bars through the change',
    barsIn(bars, 2 * BAR + 3 * PPQ) === 3 && barsIn(bars, 2 * BAR + 3 * PPQ + 1) === 4)

  // A change that is not on a barline cuts the bar before it short.
  const odd = barsOf({ meters: [{ tick: BAR + 2 * PPQ, meter: { beats: 3, unit: 4 } }] })
  check('a change off the barline cuts the bar before it short', odd.bar(1).length === 2 * PPQ && odd.bar(2).tick === BAR + 2 * PPQ)

  // A pattern is ruled in the meter it first sits in.
  check('a pattern placed after the change is in 3/4', patternBars(s, 2 * BAR).bar(0).length === 3 * PPQ)
  check('one placed across it sees the change where it falls',
    patternBars(s, BAR).bar(1).tick === BAR && patternBars(s, BAR).bar(1).length === 3 * PPQ)
  check('and one not placed is in the opening meter', patternBars(s, null).bar(0).length === BAR)
  check('the shortest a pattern can be allows for the shortest bar',
    minPatternLength({ meters: [{ tick: BAR, meter: { beats: 1, unit: 8 } }] }) === PPQ / 2)
  check('the song view reaches a bar past the end, counted in the bars there are', playlistBars(s, 1) === 2)
  const waltzEnd = song({ meters: [{ tick: 1, meter: { beats: 3, unit: 4 } }] })
  check('and counts them in the meter they are in', playlistBars(waltzEnd, 1) === 4, String(playlistBars(waltzEnd, 1)))
}

console.log('\nediting tempo and meter changes')
{
  const BAR = PPQ * 4
  const s = song()
  const faster = setAt(TEMPO, s, 2 * BAR, 140)
  check('a tempo change is added at its tick', JSON.stringify(faster.tempos) === JSON.stringify([{ tick: 2 * BAR, bpm: 140 }]))
  check('setting it again changes it in place', setAt(TEMPO, faster, 2 * BAR, 90).tempos?.[0].bpm === 90)
  check('one that changes nothing is not kept', !('tempos' in setAt(TEMPO, s, 2 * BAR, 120)))
  check('at zero it is the opening tempo', setAt(TEMPO, faster, 0, 100).tempo === 100 && setAt(TEMPO, faster, 0, 100).tempos === faster.tempos)
  check('and held to the range', setAt(TEMPO, s, BAR, 999).tempos?.[0].bpm === 300)
  check('it is taken away', !('tempos' in removeAt(TEMPO, faster, 2 * BAR)))
  check('the opening tempo cannot be', removeAt(TEMPO, faster, 0) === faster)
  check('it moves', moveAt(TEMPO, faster, 2 * BAR, 3 * BAR).tempos?.[0].tick === 3 * BAR)
  const ramp = { ...s, tempos: Array.from({ length: 16 }, (_, i) => ({ tick: BAR + i * 120, bpm: 121 + i })) }
  const thinned = removeBetween(TEMPO, ramp, BAR, BAR + 8 * 120)
  check('a stretch of changes goes at once', thinned.tempos?.length === 8 && thinned.tempos[0].tick === BAR + 8 * 120, JSON.stringify(thinned.tempos?.[0]))
  check('and all of them, leaving the tempo at the start', !('tempos' in removeBetween(TEMPO, ramp, 1, Infinity)) && removeBetween(TEMPO, ramp, 1, Infinity).tempo === 120)
  check('a stretch with none in it changes nothing', removeBetween(TEMPO, ramp, 0, BAR) === ramp)
  check('but never onto the start', moveAt(TEMPO, faster, 2 * BAR, 0) === faster)
  const two = setAt(TEMPO, faster, 3 * BAR, 160)
  check('moved onto another, it replaces it', JSON.stringify(moveAt(TEMPO, two, 2 * BAR, 3 * BAR).tempos) === JSON.stringify([{ tick: 3 * BAR, bpm: 140 }]))
  check('a change back to what was before it goes', JSON.stringify(setAt(TEMPO, two, 3 * BAR, 140).tempos) === JSON.stringify([{ tick: 2 * BAR, bpm: 140 }]))

  const waltz = setAt(METER, s, BAR, { beats: 3, unit: 4 })
  check('a meter change is added', waltz.meters?.[0].meter.beats === 3)
  check('a meter that cannot be is refused', setAt(METER, s, BAR, { beats: 0, unit: 4 }) === s && setAt(METER, s, BAR, { beats: 3, unit: 5 as 4 }) === s)
  check('at zero it is the opening meter', setAt(METER, waltz, 0, { beats: 6, unit: 8 }).meter?.unit === 8)
  check('a beat can be a half note', barTicks({ meter: { beats: 2, unit: 2 } }) === 4 * PPQ && beatTicks({ meter: { beats: 3, unit: 2 } }) === 2 * PPQ)
  check('or a sixteenth', barTicks({ meter: { beats: 5, unit: 16 } }) === 5 * PPQ / 4 && beatTicks({ meter: { beats: 7, unit: 16 } }) === PPQ / 4)
  check('up to thirty-two of them to a bar', !!setAt(METER, s, BAR, { beats: 32, unit: 32 }).meters && setAt(METER, s, BAR, { beats: 33, unit: 16 }) === s)
  check('but only of a note a time signature can say', setAt(METER, s, BAR, { beats: 3, unit: 3 as 4 }) === s && setAt(METER, s, BAR, { beats: 3, unit: 64 as 4 }) === s)
  const odd = parseSong(JSON.parse(JSON.stringify({ ...s, meter: { beats: 3, unit: 2 }, meters: [{ tick: 12 * PPQ, meter: { beats: 7, unit: 16 } }] })))
  check('and they are saved with the song', odd?.meter?.unit === 2 && odd?.meters?.[0].meter.unit === 16, JSON.stringify({ m: odd?.meter, ms: odd?.meters }))
  check('a bar of 7/16 after two of 3/2', barsOf(odd!).bar(2).tick === 12 * PPQ && barsOf(odd!).bar(2).length === 7 * PPQ / 4)
  check('and 4/4 there is no meter at all', !('meter' in setAt(METER, setAt(METER, s, 0, { beats: 6, unit: 8 }), 0, { beats: 4, unit: 4 })))

  const messy = { ...s, tempos: [{ tick: 3 * BAR, bpm: 90 }, { tick: 0, bpm: 100 }, { tick: BAR, bpm: 100 }, { tick: 3 * BAR, bpm: 95 }, { tick: 2.4 * BAR + 0.3, bpm: 110 }] }
  const tidy = cleanTimings(messy)
  check('changes are kept in order, whole, one to a tick and each a change',
    tidy.tempo === 100 && JSON.stringify(tidy.tempos) === JSON.stringify([{ tick: Math.round(2.4 * BAR + 0.3), bpm: 110 }, { tick: 3 * BAR, bpm: 95 }]),
    JSON.stringify(tidy.tempos))
  check('and a song already tidy is handed back as it was', cleanTimings(tidy) === tidy && cleanTimings(s) === s)

  // With changes along the way, the opening meter moves only the barlines.
  const changing = setAt(METER, s, 2 * BAR, { beats: 3, unit: 4 })
  const opened = setMeter(changing, { beats: 2, unit: 4 })
  check('the opening meter of a song that changes meter moves no music',
    opened.meter?.beats === 2 && opened.patterns === changing.patterns && opened.playlist === changing.playlist)

  const retimed = setMeter(setAt(TEMPO, s, 2 * BAR + PPQ, 150), { beats: 3, unit: 4 })
  check('a whole-song change of meter keeps a tempo change in its bar, on its beat',
    retimed.tempos?.[0].tick === 2 * 3 * PPQ + PPQ, JSON.stringify(retimed.tempos))
  const saved = parseSong(JSON.parse(JSON.stringify(setAt(TEMPO, changing, BAR, 150))))
  check('changes are saved with the song', saved?.tempos?.[0].bpm === 150 && saved?.meters?.[0].meter.beats === 3)
  const junk = parseSong({
    ...JSON.parse(JSON.stringify(s)),
    tempos: [{ tick: BAR, bpm: 'fast' }, { tick: -5, bpm: 90 }, { tick: 2 * BAR, bpm: 1000 }, { tick: 0, bpm: 80 }],
    meters: [{ tick: BAR, meter: { beats: 40, unit: 3 } }, { tick: 2 * BAR }, 'x'],
  })
  check('a file\'s changes are read as the editor would have made them',
    junk?.tempo === 80 && JSON.stringify(junk?.tempos) === JSON.stringify([{ tick: 2 * BAR, bpm: 300 }]) &&
      JSON.stringify(junk?.meters) === JSON.stringify([{ tick: BAR, meter: { beats: 32, unit: 4 } }]),
    JSON.stringify({ t: junk?.tempo, ts: junk?.tempos, ms: junk?.meters }))

  // Time put in, taken out and copied carries its tempo and meter.
  const timed = setAt(METER, setAt(TEMPO, s, 2 * BAR, 90), 2 * BAR, { beats: 3, unit: 4 })
  const later = insertTime(timed, BAR, BAR)
  check('bars put in before a change move it later', later.tempos?.[0].tick === 3 * BAR && later.meters?.[0].tick === 3 * BAR)
  check('and the new bars are at the tempo before them', tempoAt(later, BAR) === 120)
  const cut = deleteTime(timed, { from: BAR, to: 2 * BAR + PPQ })
  check('taking out bars with a change in them keeps what it changed to after them',
    JSON.stringify(cut.tempos) === JSON.stringify([{ tick: BAR, bpm: 90 }]) && cut.meters?.[0].tick === BAR,
    JSON.stringify({ t: cut.tempos, m: cut.meters }))
  const twice = duplicateTime(timed, { from: 2 * BAR, to: 2 * BAR + 3 * PPQ })
  check('a copied bar keeps its tempo and meter, and the song goes on as it was after',
    tempoAt(twice, 2 * BAR + 3 * PPQ) === 90 && twice.meters?.length === 1, JSON.stringify({ t: twice.tempos, m: twice.meters }))
  const early = duplicateTime(timed, { from: 0, to: BAR })
  check('a copy of a bar before the change is at its own tempo, and the change still follows',
    tempoAt(early, BAR) === 120 && early.tempos?.[0].tick === 3 * BAR, JSON.stringify(early.tempos))
  const pasted = pasteTime(timed, 4 * BAR, copyTime(timed, { from: 2 * BAR, to: 3 * BAR })!)
  check('pasted bars bring their tempo', tempoAt(pasted, 4 * BAR) === 90 && tempoAt(pasted, 5 * BAR) === 90)
  const intoSlow = pasteTime(timed, 4 * BAR, copyTime(timed, { from: 0, to: BAR })!)
  check('and the song picks up where it was after them', tempoAt(intoSlow, 4 * BAR) === 120 && tempoAt(intoSlow, 5 * BAR) === 90,
    JSON.stringify(intoSlow.tempos))
  check('clearing bars leaves the changes', clearTime(timed, { from: 0, to: 4 * BAR }).tempos === timed.tempos)

  // So does a section, when its music moves.
  const sectioned = addSection(addSection(timed, 0, 2 * BAR, 'A'), 2 * BAR, BAR, 'B')
  const doubled = duplicateSection(sectioned, 2 * BAR)
  check('a duplicated section is at its tempo', tempoAt(doubled, 3 * BAR) === 90 && barsOf(doubled).meterAt(3 * BAR).beats === 3)
  const swapped = moveSection(sectioned, 2 * BAR, 0)
  check('a section moved takes its tempo and meter with it',
    tempoAt(swapped, 0) === 90 && swapped.meter?.beats === 3 && tempoAt(swapped, BAR) === 120 && barsOf(swapped).meterAt(BAR).beats === 4,
    JSON.stringify({ t: swapped.tempo, ts: swapped.tempos, m: swapped.meter, ms: swapped.meters }))
  const gone = deleteSectionAndMusic(sectioned, 0)
  check('a section deleted with its music leaves the tempo after it', gone.tempo === 90 && !('tempos' in gone), JSON.stringify(gone.tempos))

  // And the history says what happened.
  const patch = defaultPatch()
  const doc = (x: Song) => ({ name: 'P', song: x, racks: { bench: { patch, values: rackValues(patch) } } })
  check('adding a tempo change is named', describeEdit(doc(s), doc(faster)) === 'Add tempo change')
  check('moving one', describeEdit(doc(faster), doc(moveAt(TEMPO, faster, 2 * BAR, BAR))) === 'Move tempo change')
  check('and a meter change', describeEdit(doc(s), doc(waltz)) === 'Add meter change')
}

console.log('\nthe drum kit')
{
  const kitBuilt = templateById('drumkit')!.build()
  const kp = kitBuilt.patch
  const kit = kp.modules.find((m) => m.type === 'kit')!
  const pads = kitSlots(kit)
  check('the library kit has sixteen pads loaded', pads.every(Boolean))
  check('on the notes General MIDI puts them on', pads[0]?.note === 36 && pads[1]?.note === 38 && pads[2]?.note === 42 && pads[3]?.note === 46)
  check('named for what is in them', pads[0]?.name === 'Kick' && pads[1]?.name === 'Snare')
  check('with the hats in one choke group', kitBuilt.values['kit1.choke3'] === 1 && kitBuilt.values['kit1.choke4'] === 1)
  check('a pad holds a copy, with its knobs in its modules', pads[0]!.patch.modules.every((m) => !m.key) &&
    pads[0]!.patch.modules.some((m) => Object.keys(m.params).length > 0))

  const compiled = compile(kp)
  check('it compiles clean', compiled.warnings.length === 0, compiled.warnings.join('; '))
  check('each pad laid in under its own name', compiled.modules.some((m) => m.id === 'kit1/1/gate1') && compiled.modules.some((m) => m.id === 'kit1/16/gate1'))
  check('and described so it can sleep', compiled.pads?.length === 16 && compiled.pads[0].wake.includes('kit1/1/gate1'))
  const k = compiled.modules.find((m) => m.id === 'kit1')!
  const retAt = defOf('kit').inputs.findIndex((p) => p.id === 'ret1l')
  check('each pad comes back into the kit, not to the speakers', k.ins[retAt] > 0 && compiled.monitors.length === 1)
  check('a patch with no pads loaded is left as it was', flattenKits({ modules: [{ id: 'kit1', type: 'kit', params: {} }], cables: [] }).modules.length === 1)

  const bare = { modules: [{ id: 'gate1', type: 'gate', params: {} }, { id: 'kit1', type: 'kit', params: {} }], cables: [] }
  check('no cable can reach a pad\'s return', wireUp(bare, { module: 'gate1', port: 'gate' }, { module: 'kit1', port: 'ret1l' }) === bare)
  check('but a Trig jack takes one', wireUp(bare, { module: 'gate1', port: 'gate' }, { module: 'kit1', port: 'trig1' }).cables.length === 1)

  // Saved and read back.
  const saved = fromStored(JSON.parse(JSON.stringify(toStored('Kit', kp, kitBuilt.values))))
  const back = 'error' in saved ? null : saved.patch.modules.find((m) => m.type === 'kit')
  check('a kit is saved with its pads', !!back && kitSlots(back).every((p, i) => p?.name === pads[i]?.name && p?.note === pads[i]?.note))
  check('and compiles the same after', !('error' in saved) && compile(saved.patch).modules.length === compiled.modules.length)
  const junk = fromStored({
    version: 1,
    name: 'Junk',
    patch: {
      modules: [
        {
          id: 'kit1',
          type: 'kit',
          params: {},
          slots: [
            { name: 'Odd', note: 500, patch: kitBuilt.patch },
            'nonsense',
            { name: 'Broken', note: 40, patch: 'no' },
          ],
        },
      ],
      cables: [],
    },
  })
  const junkKit = 'error' in junk ? null : junk.patch.modules[0]
  const junkPads = junkKit ? kitSlots(junkKit) : []
  check('a pad read from a file keeps its note in range', junkPads[0]?.note === 127)
  check('and a kit inside a pad is left out', !junkPads[0]?.patch.modules.some((m) => m.type === 'kit'))
  check('a pad that is not a rack is left empty, and said', junkPads[1] === null && junkPads[2] === null &&
    !('error' in junk) && junk.warnings.some((w) => w.includes('pad 3')), 'error' in junk ? junk.error : junk.warnings.join('; '))

  // Notes reach pads.
  const target = noteTarget(kp)!
  check('a rack with a kit is played through it', target.kind === 'kit' && target.module === 'kit1')
  check('each pad on the row of its note', target.pads?.get(kitRow(36))?.[0].name === 'Kick' && kitRow(36) === 24)
  const on = engineEvents([{ frame: 10, track: 't', kind: 'on', pitch: kitRow(38), velocity: 0.7 }], target)
  check('a note plays the pad and tells the kit which', on.length === 2 &&
    on.some((e) => e.kind === 'noteOn' && e.module === 'kit1' && e.pitch === 1) &&
    on.some((e) => e.kind === 'noteOn' && e.module === 'kit1/2/gate1' && e.velocity === 0.7), JSON.stringify(on))
  check('a note on a row with no pad plays nothing', engineEvents([{ frame: 0, track: 't', kind: 'on', pitch: 0, velocity: 1 }], target).length === 0)
  check('a release for every note lets go of every pad',
    engineEvents([{ frame: 0, track: 't', kind: 'off', velocity: 0 }], target).filter((e) => e.kind === 'noteOff').length === 16)

  // Heard through the game player: a kick, then a snare, then a row with nothing on it.
  const kitSong: Song = {
    tempo: 120,
    tracks: [{ id: 'drums', name: 'Drums', patch: 'drums', gain: 1 }],
    patterns: [{
      id: 'a',
      name: 'A',
      length: PPQ * 4,
      notes: [
        { track: 'drums', tick: 0, length: PPQ / 4, pitch: kitRow(36), velocity: 1 },
        { track: 'drums', tick: PPQ, length: PPQ / 4, pitch: kitRow(38), velocity: 1 },
        { track: 'drums', tick: PPQ * 2, length: PPQ / 4, pitch: 0, velocity: 1 },
      ],
    }],
    playlist: [{ pattern: 'a', tick: 0 }],
  }
  const player = new SongPlayer(kitSong, { drums: { patch: kp, values: kitBuilt.values } }, { sampleRate: SR })
  const l = new Float32Array(SR * 2)
  const r = new Float32Array(SR * 2)
  player.render(l, r)
  const window = (from: number, to: number) => rms(l.subarray(Math.round(from * SR), Math.round(to * SR)))
  check('the kick sounds on the beat', window(0, 0.1) > 0.02, window(0, 0.1).toFixed(4))
  check('and the snare on the next', window(0.5, 0.6) > 0.02, window(0.5, 0.6).toFixed(4))
  // Against the same song without that note: whatever is still ringing
  // from the snare is the same in both.
  const without = new SongPlayer(
    { ...kitSong, patterns: [{ ...kitSong.patterns[0], notes: kitSong.patterns[0].notes.slice(0, 2) }] },
    { drums: { patch: kp, values: kitBuilt.values } },
    { sampleRate: SR },
  )
  const l2 = new Float32Array(SR * 2)
  const r2 = new Float32Array(SR * 2)
  without.render(l2, r2)
  const diff = l.subarray(SR, Math.round(1.4 * SR)).reduce((m, v, i) => Math.max(m, Math.abs(v - l2[SR + i])), 0)
  check('and a note on a row with no pad adds nothing', diff < 1e-6, diff.toExponential(2))

  // Choke: the open hat cut off by the closed one, in a group and out of one.
  const hats = (choke: number) => {
    let p = setKitSlot({ modules: [{ id: 'kit1', type: 'kit', params: {} }], cables: [] }, 'kit1', 0, { ...pads[3]!, note: 46 })
    p = setKitSlot(p, 'kit1', 1, { ...pads[2]!, note: 42 })
    const c = compile(p)
    const params = c.params.slice()
    params[c.paramIndex['kit1.choke1']] = choke
    params[c.paramIndex['kit1.choke2']] = choke
    // The closed hat silent in the mix, so what is heard is the open one.
    params[c.paramIndex['kit1.level2']] = 0
    const e = new GraphEngine(c, SR, params)
    const t = noteTarget(p)!
    for (const ev of engineEvents([
      { frame: 0, track: 't', kind: 'on', pitch: kitRow(46), velocity: 1 },
      { frame: 4800, track: 't', kind: 'on', pitch: kitRow(42), velocity: 1 },
    ], t)) e.schedule(ev)
    const out = new Float32Array(SR / 2)
    const bl = new Float32Array(128)
    const br = new Float32Array(128)
    for (let i = 0; i < out.length; i += 128) {
      e.render(bl, br)
      out.set(bl.subarray(0, Math.min(128, out.length - i)), i)
    }
    return { before: rms(out.subarray(2400, 4800)), after: rms(out.subarray(6000, 9600)), engine: e }
  }
  const open = hats(0)
  const choked = hats(1)
  check('an open hat rings on past a closed one in no group', open.after > open.before * 0.2, `${open.before.toFixed(4)} -> ${open.after.toFixed(4)}`)
  check('and is cut off by one in its group', choked.after < open.after * 0.1, `${choked.after.toFixed(5)} against ${open.after.toFixed(5)}`)

  // A pad that is not sounding sleeps, and a note wakes it.
  const e = new GraphEngine(compiled, SR, compiled.params)
  const awake = () => [...(e as unknown as { padAwake: Uint8Array }).padAwake].filter(Boolean).length
  const bl = new Float32Array(128)
  const br = new Float32Array(128)
  for (let i = 0; i < SR / 4; i += 128) e.render(bl, br)
  check('pads nobody plays fall asleep', awake() === 0, `${awake()} awake`)
  for (const ev of engineEvents([{ frame: 0, track: 't', kind: 'on', pitch: kitRow(38), velocity: 1 }], target)) e.schedule(ev)
  e.render(bl, br)
  check('a note wakes the pad it is for, and only that one', awake() === 1)
  let heard = 0
  for (let i = 0; i < SR / 10; i += 128) {
    e.render(bl, br)
    heard = Math.max(heard, ...bl.map(Math.abs))
  }
  check('and it sounds', heard > 0.05, heard.toFixed(3))

  // A gate into a Trig jack plays the pad: the library kit's Space is its kick.
  const g = new GraphEngine(compiled, SR, compiled.params)
  g.setModuleGate('gate1', true)
  let kick = 0
  for (let i = 0; i < SR / 10; i += 128) {
    g.render(bl, br)
    kick = Math.max(kick, ...bl.map(Math.abs))
  }
  check('a gate into Trig 1 plays the first pad', kick > 0.05, kick.toFixed(3))

  // Pads edited, and the history says how.
  const renamed = updateKitSlot(kp, 'kit1', 0, { name: 'Boom' })
  check('a pad renamed keeps its rack', kitSlots(renamed.modules.find((m) => m.id === 'kit1')!)[0]?.patch === pads[0]!.patch)
  check('a pad moved to another note', kitSlots(updateKitSlot(kp, 'kit1', 0, { note: 35 }).modules.find((m) => m.id === 'kit1')!)[0]?.note === 35)
  check('a pad emptied', kitSlots(setKitSlot(kp, 'kit1', 15, null).modules.find((m) => m.id === 'kit1')!)[15] === null)
  // One song for both sides: only the rack is being edited.
  const bench = benchSong()
  const doc = (p: Patch) => ({ name: 'P', song: bench, racks: { bench: { patch: p, values: {} } } })
  check('loading a pad is named', describeEdit(doc(setKitSlot(kp, 'kit1', 0, null)), doc(kp)) === 'Load Kick · pad 1',
    describeEdit(doc(setKitSlot(kp, 'kit1', 0, null)), doc(kp)))
  check('and renaming one', describeEdit(doc(kp), doc(renamed)) === 'Rename pad 1')
  check('and moving one', describeEdit(doc(kp), doc(updateKitSlot(kp, 'kit1', 0, { note: 35 }))) === 'Move pad 1 to note 35')
  const sampled = setKitSlot(kp, 'kit1', 0, {
    name: 'Sample',
    note: 36,
    patch: { modules: [{ id: 'smp1', type: 'sampler', params: {}, sample: { id: 'abc', name: 'a.wav' } }], cables: [] },
  })
  check('a sample in a pad is kept', sampleIdsIn(sampled).has('abc'))
}

console.log('\na pad opened on the bench')
{
  const built = templateById('drumkit')!.build()
  const rack = { patch: built.patch, values: { ...initialValues(built.patch), ...built.values } }
  check('a kit\'s knobs include its pads\', under their own ids', rack.values['kit1/1/osc1.decay'] === kitSlots(rack.patch.modules.find((m) => m.id === 'kit1')!)[0]!.patch.modules.find((m) => m.id === 'osc1')!.params.decay)
  const view = padView(rack, 'kit1', 0)!
  check('a pad opened is its rack, keyed as its own', view.patch.modules.some((m) => m.id === 'osc1') && 'osc1.decay' in view.values && !Object.keys(view.values).some((k) => k.includes('/')))

  // A knob turned in the pad.
  const turned = withPadView(rack, 'kit1', 0, { ...view, values: { ...view.values, 'osc1.decay': 1.5 } })
  check('a knob turned in a pad lands in the track under the pad\'s id', turned.values['kit1/1/osc1.decay'] === 1.5)
  check('and leaves the patch alone', turned.patch === rack.patch)
  check('and the other pads\' knobs', turned.values['kit1/2/osc1.decay'] === rack.values['kit1/2/osc1.decay'])
  check('a top-level edit keeps the pads\' knobs', reconcileValues(rack.patch, turned.values)['kit1/1/osc1.decay'] === 1.5)

  // The engine hears it: the kick with a longer decay is still sounding later.
  const play = (values: Record<string, number>) => {
    const s: Song = {
      tempo: 120,
      tracks: [{ id: 'd', name: 'D', patch: 'd', gain: 1 }],
      patterns: [{ id: 'a', name: 'A', length: PPQ * 4, notes: [{ track: 'd', tick: 0, length: PPQ / 4, pitch: kitRow(36), velocity: 1 }] }],
      playlist: [{ pattern: 'a', tick: 0 }],
    }
    const p = new SongPlayer(s, { d: { patch: rack.patch, values } }, { sampleRate: SR })
    const l = new Float32Array(SR)
    const r = new Float32Array(SR)
    p.render(l, r)
    return rms(l.subarray(Math.round(0.4 * SR), Math.round(0.6 * SR)))
  }
  const short = play(rack.values)
  const long = play(turned.values)
  check('and the track plays the pad with it', long > short * 1.1, `${short.toFixed(4)} -> ${long.toFixed(4)}`)

  // A cable edited in the pad replaces the pad's rack, and nothing else.
  const rewired = withPadView(rack, 'kit1', 0, { ...view, patch: { ...view.patch, cables: view.patch.cables.slice(1) } })
  const kitNow = rewired.patch.modules.find((m) => m.id === 'kit1')!
  check('a pad rewired is the pad changed', kitSlots(kitNow)[0]!.patch.cables.length === view.patch.cables.length - 1 &&
    kitSlots(kitNow)[1] === kitSlots(rack.patch.modules.find((m) => m.id === 'kit1')!)[1])
  const withKit = withPadView(rack, 'kit1', 0, { ...view, patch: { ...view.patch, modules: [...view.patch.modules, { id: 'kit9', type: 'kit', params: {} }] } })
  check('and a kit put inside a pad is left out', !kitSlots(withKit.patch.modules.find((m) => m.id === 'kit1')!)[0]!.patch.modules.some((m) => m.type === 'kit'))
  const loaded = withPadView(rack, 'kit1', 0, view, 'Boom')
  check('a patch loaded into a pad names it', kitSlots(loaded.patch.modules.find((m) => m.id === 'kit1')!)[0]!.name === 'Boom')

  // Saved, the pad's knobs are baked into the pad.
  const saved = toStored('Kit', turned.patch, turned.values)
  const savedKit = saved.patch.modules.find((m) => m.id === 'kit1')!
  check('a pad is saved with its knobs as they were turned', kitSlots(savedKit)[0]!.patch.modules.find((m) => m.id === 'osc1')!.params.decay === 1.5)

  // And the history says which pad.
  const bench = benchSong()
  const doc = (r: { patch: Patch; values: Record<string, number> }) => ({ name: 'P', song: bench, racks: { bench: r } })
  check('a knob in a pad is named with the pad', describeEdit(doc(rack), doc(turned)) === 'Decay · osc1 (Pad 1)', describeEdit(doc(rack), doc(turned)))
  check('and a cable in one', describeEdit(doc(rack), doc(rewired)) === 'Unplug cable (Pad 1)', describeEdit(doc(rack), doc(rewired)))
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
