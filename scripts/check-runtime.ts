/**
 * Headless checks for the game runtime: a song a game plays into, and the
 * host that runs several of them at once.
 *
 * What is being proved is that a game can trust what it is told. A note sent
 * for the next beat starts on the beat's sample, not somewhere near it. A
 * note-off survives the song changing course under it. A track faded to
 * nought is silent, and one panned hard left is not in the right speaker. A
 * sound effect synced to another player's grid lands on that player's beat.
 *
 * Run with: npm run check:runtime
 */
import type { Cable, Patch, PatchModule } from '../src/patch/types'
import { toStoredProject } from '../src/song/project'
import { SongPlayer } from '../src/song/runtime'
import { RuntimeHost } from '../src/runtime/host'
import type { FromRuntime } from '../src/runtime/protocol'
import { PPQ, type Song } from '../src/song/types'

const SR = 48000
/** A beat at 120 bpm. */
const BEAT = SR / 2

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const mod = (id: string, type: string, params: Record<string, number> = {}): PatchModule => ({ id, type, params })
function cable(fromModule: string, fromPort: string, toModule: string, toPort: string): Cable {
  return {
    id: `${fromModule}.${fromPort}->${toModule}.${toPort}`,
    from: { module: fromModule, port: fromPort },
    to: { module: toModule, port: toPort },
  }
}

/** A Keyboard into an oscillator with its own envelope; `sustain` decides whether a held note stays. */
function voice(pitch: number, sustain = 0): Patch {
  return {
    modules: [
      mod('key1', 'keys', { voices: 4 }),
      mod('osc1', 'osc', { pitch, fmAmount: 1, envAmount: 1, decay: 0.2, sustain, release: 0.01 }),
      mod('mix1', 'mixer'),
    ],
    cables: [
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('key1', 'gate', 'osc1', 'gate'),
      cable('osc1', 'out', 'mix1', 'in1'),
    ],
  }
}

/** A Trigger firing an oscillator: a hit, with no pitch to play. */
function hit(): Patch {
  return {
    modules: [mod('gate1', 'gate'), mod('osc1', 'osc', { pitch: 330, envAmount: 1, decay: 0.1 }), mod('mix1', 'mixer')],
    cables: [cable('gate1', 'gate', 'osc1', 'gate'), cable('osc1', 'out', 'mix1', 'in1')],
  }
}

/** A song with tracks and nothing placed: a bank of sounds the game plays. */
function bank(): { song: Song; racks: Record<string, { patch: Patch; values: Record<string, number> }> } {
  return {
    song: {
      tempo: 120,
      tracks: [
        { id: 't1', name: 'Brick', patch: 't1', gain: 1 },
        { id: 't2', name: 'Hum', patch: 't2', gain: 1 },
        { id: 't3', name: 'Wall', patch: 't3', gain: 1 },
      ],
      patterns: [{ id: 'p1', name: 'Empty', length: PPQ * 4, notes: [] }],
      playlist: [],
      scale: { root: 9, mode: 'minor' },
    },
    racks: {
      t1: { patch: voice(220), values: {} },
      t2: { patch: voice(110, 0.8), values: {} },
      t3: { patch: hit(), values: {} },
    },
  }
}

/** Music: a bar of quarter notes on one track, looping. */
function music(): { song: Song; racks: Record<string, { patch: Patch; values: Record<string, number> }> } {
  const notes = [0, 1, 2, 3].map((b) => ({ track: 'm1', tick: b * PPQ, length: PPQ / 2, pitch: 0, velocity: 1 }))
  return {
    song: {
      tempo: 120,
      tracks: [{ id: 'm1', name: 'Drums', patch: 'm1', gain: 1 }],
      patterns: [{ id: 'p1', name: 'Beat', length: PPQ * 4, notes }],
      playlist: [{ pattern: 'p1', tick: 0 }],
      sections: [{ tick: 0, length: PPQ * 4, name: 'Loop' }],
    },
    racks: { m1: { patch: voice(440), values: {} } },
  }
}

function render(p: { render(l: Float32Array, r: Float32Array): void }, frames: number, block = 128) {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const bl = new Float32Array(block)
  const br = new Float32Array(block)
  for (let i = 0; i < frames; i += block) {
    p.render(bl, br)
    const n = Math.min(block, frames - i)
    left.set(bl.subarray(0, n), i)
    right.set(br.subarray(0, n), i)
  }
  return { left, right }
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length))
const firstSound = (x: Float32Array, from = 0) => {
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > 1e-5) return i
  return -1
}

console.log('\nthe game plays notes')
{
  const { song, racks } = bank()
  const p = new SongPlayer(song, racks, { sampleRate: SR })
  check('a track is played by its name', p.noteOn('Brick', 7, 0.9, { length: 0.1 }))
  const a = render(p, SR / 2)
  check('and it sounds', rms(a.left.subarray(0, 4800)) > 0.01, `rms ${rms(a.left.subarray(0, 4800)).toFixed(4)}`)
  check('and dies away', rms(a.left.subarray(SR / 2 - 4800)) < 1e-4)
  check('a track with nothing to play is refused', !p.noteOn('Nobody', 0))
  check('so is a pitch that is not a number', !p.noteOn('Brick', Number.NaN))

  check('a hit fires', p.trigger('Wall', 1))
  const b = render(p, SR / 4)
  check('and sounds', rms(b.left.subarray(0, 2400)) > 0.01, `rms ${rms(b.left.subarray(0, 2400)).toFixed(4)}`)

  // A held sound stays until it is let go of.
  p.noteOn('Hum', 0, 1)
  const held = render(p, SR)
  check('a note with no length is held', rms(held.left.subarray(SR - 4800)) > 0.01, `rms ${rms(held.left.subarray(SR - 4800)).toFixed(4)}`)
  check('until the game lets go', p.noteOff('Hum'))
  const gone = render(p, SR / 2)
  check('and then it stops', rms(gone.left.subarray(SR / 4)) < 1e-4, `rms ${rms(gone.left.subarray(SR / 4)).toExponential(2)}`)
}

console.log('\nnotes on the grid')
{
  const { song, racks } = bank()
  const p = new SongPlayer(song, racks, { sampleRate: SR })
  check('now is the next block', p.frameOf('now') === 0)
  render(p, 1000)
  check('the next sixteenth', p.frameOf('16th') === BEAT / 4, `${p.frameOf('16th')}`)
  check('the next beat', p.frameOf('beat') === BEAT, `${p.frameOf('beat')}`)
  check('the next bar', p.frameOf('bar') === BEAT * 4, `${p.frameOf('bar')}`)

  // Played for the beat, a note starts on the beat's sample, in any block size.
  const starts: number[] = []
  for (const block of [128, 512]) {
    const q = new SongPlayer(song, racks, { sampleRate: SR })
    render(q, 1024, block)
    q.noteOn('Brick', 0, 1, { at: q.frameOf('beat'), length: 0.05 })
    const out = render(q, BEAT * 2, block)
    // Less the master limiter's lookahead, which every note shares.
    starts.push(1024 + firstSound(out.left) - q.latency)
  }
  check('a note for the beat starts on it', starts[0] >= BEAT && starts[0] < BEAT + 32, `first sound at ${starts[0]}`)
  check('whatever the block size', starts[0] === starts[1], starts.join(' vs '))
  check('a frame in the past is the next block', (() => {
    const q = new SongPlayer(song, racks, { sampleRate: SR })
    render(q, 4096)
    q.noteOn('Brick', 0, 1, { at: 10, length: 0.05 })
    const at = firstSound(render(q, 512).left) - q.latency
    return at >= 0 && at < 32
  })())
}

console.log('\nthe song changes course under a held note')
{
  const { song, racks } = music()
  song.tracks.push({ id: 'h1', name: 'Hum', patch: 'h1', gain: 1 })
  racks.h1 = { patch: voice(110, 0.8), values: {} }
  const p = new SongPlayer(song, racks, { sampleRate: SR, only: ['h1'], loop: { from: 0, to: PPQ * 4 } })
  render(p, 1024)
  p.noteOn('Hum', 0, 1, { length: 0.5 })
  render(p, 4800)
  // Both drop everything queued past now -- which would include the
  // note-off the game asked for half a second out.
  p.setTempoScale(0.75)
  p.playSection('Loop', { when: 'now' })
  const out = render(p, SR)
  check('a game note is still let go of', rms(out.left.subarray(SR / 2)) < 1e-4, `rms ${rms(out.left.subarray(SR / 2)).toExponential(2)}`)
}

console.log('\ntempo')
{
  const { song, racks } = music()
  const p = new SongPlayer(song, racks, { sampleRate: SR, loop: { from: 0, to: PPQ * 4 } })
  render(p, BEAT)
  const before = p.clock
  check('the clock reads the song', before.bpm === 120 && before.beatsPerBar === 4, JSON.stringify(before))
  p.setTempoScale(0.5)
  check('the scale is kept', p.tempoScale === 0.5)
  const t0 = p.tick
  render(p, BEAT)
  const moved = p.tick - t0
  check('half the tempo is half the ticks', Math.abs(moved - PPQ / 2) < 2, `${moved.toFixed(1)} ticks in a beat`)
  check('and the clock says so', p.clock.bpm === 60)

  // The notes come at the new spacing: a beat is now a second long.
  const q = new SongPlayer(song, racks, { sampleRate: SR, loop: { from: 0, to: PPQ * 4 } })
  q.setTempoScale(0.5)
  const out = render(q, SR * 2 + 4800)
  const second = firstSound(out.left, SR - 2400) - q.latency
  check('a note lands on the slower beat', second >= SR - 64 && second < SR + 64, `second note at ${second}`)
  check('and a section waiting for its bar still lands on one', (() => {
    const r = new SongPlayer(song, racks, { sampleRate: SR, loop: { from: 0, to: PPQ * 4 } })
    render(r, BEAT / 2)
    r.playSection('Loop', { when: 'bar' })
    r.setTempoScale(2)
    // At double speed the bar ends 1.75 beats of the new tempo later.
    render(r, BEAT * 2)
    return r.clock.bar === 0 && r.tick < PPQ * 2
  })())
}

console.log('\nthe mix from the game')
{
  const { song, racks } = bank()
  const p = new SongPlayer(song, racks, { sampleRate: SR })
  // A strip glides about 10 ms to where it is set, so each change is given
  // a tenth of a second to arrive before anything is measured.
  check('a track can be faded', p.setTrackGain('Brick', 0))
  render(p, 4800)
  p.noteOn('Brick', 0, 1, { length: 0.1 })
  check('and faded out it is silent', rms(render(p, 4800).left) < 1e-5)
  p.setTrackGain('Brick', 1)
  p.setTrackPan('Brick', -1)
  render(p, 4800)
  p.noteOn('Brick', 0, 1, { length: 0.1 })
  const panned = render(p, 4800)
  check('panned hard left it is only on the left', rms(panned.left) > 0.01 && rms(panned.right) < 1e-5,
    `left ${rms(panned.left).toFixed(4)} right ${rms(panned.right).toExponential(2)}`)
  p.setTrackPan('Brick', 0)
  p.setTrackMute('Brick', true)
  render(p, 4800)
  p.noteOn('Brick', 0, 1, { length: 0.1 })
  check('a muted track is silent', rms(render(p, 4800).left) < 1e-5)
  check('a track not in the song is refused', !p.setTrackGain('Nobody', 1))
  check('the key comes from the roll', JSON.stringify(p.key) === JSON.stringify({ root: 9, mode: 'minor', steps: [0, 2, 3, 5, 7, 8, 10] }))
  check('it names its tracks', p.trackNames.join() === 'Brick,Hum,Wall')
  p.setTrackMute('Brick', false)
  render(p, 1024)
  p.levels()
  p.noteOn('Brick', 0, 1, { length: 0.1 })
  render(p, 2400)
  const levels = p.levels()
  check('levels come by track name', levels.tracks.Brick > 0.01 && levels.tracks.Hum === 0, JSON.stringify(levels.tracks))
}

console.log('\nthe host: several projects at once')
{
  const host = new RuntimeHost(SR)
  const m = music()
  const b = bank()
  const loaded = (r: FromRuntime | undefined) => (r && r.type === 'loaded' ? r.info : null)
  const musicInfo = loaded(host.handle({ type: 'load', id: 'music', request: 1, project: JSON.stringify(toStoredProject('Music', m.song, m.racks)) }))
  const sfxInfo = loaded(host.handle({ type: 'load', id: 'sfx', request: 2, project: JSON.stringify(toStoredProject('Sfx', b.song, b.racks)), loop: null }))
  check('a project loads, and says what is in it', !!musicInfo && musicInfo.sections[0]?.name === 'Loop' && musicInfo.tracks[0] === 'Drums')
  check('with its key and its playable tracks', !!sfxInfo && sfxInfo.key?.root === 9 && sfxInfo.playable.join() === 'Brick,Hum,Wall')
  check('and its knobs by track', !!sfxInfo && sfxInfo.params.Brick.includes('osc1.decay'))
  const bad = host.handle({ type: 'load', id: 'x', request: 3, project: '{nope' })
  check('a broken file is refused, not thrown', bad?.type === 'failed')

  check('loaded players are silent until started', rms(render(host, 4800).left) === 0)
  host.handle({ type: 'start', id: 'music', section: 'Loop' })
  host.handle({ type: 'start', id: 'sfx' })
  const playing = render(host, 4800)
  check('started, the music plays', rms(playing.left) > 0.01)

  // The sound effects started later, so their clock is not the music's --
  // but a note synced to the music's beat lands on the music's beat.
  // Started a third of a beat apart, so the two clocks disagree; the music
  // is muted, so the only sound is the note.
  const synced = new RuntimeHost(SR)
  synced.handle({ type: 'load', id: 'music', request: 1, project: JSON.stringify(toStoredProject('Music', m.song, m.racks)) })
  synced.handle({ type: 'load', id: 'sfx', request: 2, project: JSON.stringify(toStoredProject('Sfx', b.song, b.racks)), loop: null })
  synced.handle({ type: 'track', id: 'music', track: 'Drums', mute: true })
  synced.handle({ type: 'start', id: 'music' })
  render(synced, BEAT / 3)
  synced.handle({ type: 'start', id: 'sfx' })
  render(synced, 1024)
  const beatPlayer = synced.player('music')!
  const wait = beatPlayer.frameOf('beat') - beatPlayer.frame
  check('the sound effects keep their own clock', synced.player('sfx')!.frame !== beatPlayer.frame)
  synced.handle({ type: 'note', id: 'sfx', track: 'Brick', pitch: 0, velocity: 1, length: 0.05, when: 'beat', sync: 'music' })
  const heard = firstSound(render(synced, BEAT).left) - synced.player('sfx')!.latency
  check('a note synced to the music lands on the music\'s beat', heard >= wait && heard < wait + 32, `${heard} for ${wait}`)

  const r = host.report(1.5)
  check('a report has every player', r.type === 'report' && r.players.music.playing && r.players.sfx.playing)
  check('with the music\'s clock', r.type === 'report' && r.players.music.clock.bpm === 120 && r.players.music.section === 'Loop')

  // The bus: muffled, the top end goes; faded out, the player stops.
  const open = new RuntimeHost(SR)
  const shut = new RuntimeHost(SR)
  for (const h of [open, shut]) {
    h.handle({ type: 'load', id: 'm', request: 1, project: JSON.stringify(toStoredProject('Music', m.song, m.racks)) })
    h.handle({ type: 'start', id: 'm' })
  }
  shut.handle({ type: 'bus', id: 'm', muffle: 1 })
  const bright = render(open, SR / 2)
  const dull = render(shut, SR / 2)
  check('a muffled player is quieter at the top', rms(dull.left) < rms(bright.left) * 0.5,
    `${rms(dull.left).toFixed(4)} vs ${rms(bright.left).toFixed(4)}`)
  shut.handle({ type: 'stop', id: 'm', fade: 0.1 })
  render(shut, SR / 4)
  const after = shut.report(0)
  check('a faded stop stops', after.type === 'report' && !after.players.m.playing)
  check('and is silent', rms(render(shut, 4800).left) === 0)
  const quiet = new RuntimeHost(SR)
  const loud = new RuntimeHost(SR)
  for (const h of [quiet, loud]) {
    h.handle({ type: 'load', id: 'm', request: 1, project: JSON.stringify(toStoredProject('Music', m.song, m.racks)) })
    h.handle({ type: 'start', id: 'm' })
  }
  quiet.handle({ type: 'master', gain: 0.5 })
  const half = render(quiet, 4800)
  const full = render(loud, 4800)
  check('the master scales everything', Math.abs(rms(half.left) - rms(full.left) * 0.5) < 1e-4,
    `${rms(half.left).toFixed(4)} vs ${(rms(full.left) * 0.5).toFixed(4)}`)
}

console.log('\nautomation is heard, and the game can take a knob from it')
{
  // A steady tone into the Mixer, whose first level the song automates: off
  // for the first half of bar 2, then up to full for the second half.
  const BAR = PPQ * 4
  const drone: Patch = {
    modules: [mod('osc1', 'osc', { pitch: 220 }), mod('mix1', 'mixer', { level1: 0.8 })],
    cables: [cable('osc1', 'out', 'mix1', 'in1')],
  }
  const lanes = (target: string) => [{ target, points: [{ tick: 0, value: 0, shape: 'hold' as const }, { tick: BAR / 2, value: 1 }] }]
  const songWith = (target: string): Song => ({
    tempo: 120,
    tracks: [{ id: 'd1', name: 'Drone', patch: 'd1', gain: 1 }],
    patterns: [
      { id: 'e', name: 'Empty', length: BAR, notes: [] },
      { id: 'a', name: 'Auto', length: BAR, notes: [], automation: lanes(target) },
    ],
    playlist: [
      { pattern: 'e', tick: 0 },
      { pattern: 'a', tick: BAR },
      { pattern: 'e', tick: 2 * BAR },
    ],
  })
  const racks = { d1: { patch: drone, values: { 'mix1.level1': 0.8 } } }
  const barFrames = BEAT * 4
  /** The level of each half bar, a little in from its edges so the glides have settled. */
  const halves = (left: Float32Array) =>
    Array.from({ length: 6 }, (_, i) => rms(left.subarray(i * (barFrames / 2) + 2400, (i + 1) * (barFrames / 2) - 2400)))
  const say = (h: number[]) => h.map((v) => v.toFixed(3)).join(' ')

  const knob = halves(render(new SongPlayer(songWith('rack/d1/mix1.level1'), racks, { sampleRate: SR }), barFrames * 3).left)
  check('before its clip the knob is where its panel has it', knob[0] > 0.01 && Math.abs(knob[1] - knob[0]) < knob[0] * 0.02, say(knob))
  check('the clip holds it at nothing for half a bar', knob[2] < knob[0] * 0.01, say(knob))
  check('then at the top of its travel', Math.abs(knob[3] / knob[0] - 1 / 0.8) < 0.03, say(knob))
  check('and after the clip it is the panel\'s again', Math.abs(knob[4] - knob[0]) < knob[0] * 0.02, say(knob))

  const fader = halves(render(new SongPlayer(songWith('strip/d1/gain'), racks, { sampleRate: SR }), barFrames * 3).left)
  check('a fader\'s automation is heard on the desk', fader[2] < fader[0] * 0.01 && fader[3] > fader[0] * 1.5, say(fader))
  check('and the fader is the song\'s again after the clip', Math.abs(fader[4] - fader[0]) < fader[0] * 0.02, say(fader))

  // The game turns the knob half way through the clip's quiet half, and
  // hands it back half a bar later.
  const p = new SongPlayer(songWith('rack/d1/mix1.level1'), racks, { sampleRate: SR })
  const first = render(p, barFrames + barFrames / 4)
  p.setParam('Drone', 'mix1.level1', 0.4)
  const held = render(p, barFrames / 2)
  check('a knob the game sets is the game\'s, whatever the automation says', Math.abs(rms(held.left.subarray(2400)) / knob[0] - 0.5) < 0.03,
    `${(rms(held.left.subarray(2400)) / knob[0]).toFixed(3)}`)
  check('releaseParam is false for a knob the song has not got', !p.releaseParam('Drone', 'mix1.nothing'))
  p.releaseParam('Drone', 'mix1.level1')
  const back = render(p, barFrames / 4)
  check('released, the automation picks it up where its curve has got to',
    Math.abs(rms(back.left.subarray(2400)) / knob[0] - 1 / 0.8) < 0.03 && first.left.length > 0,
    `${(rms(back.left.subarray(2400)) / knob[0]).toFixed(3)}`)

  // A section jump straight into the middle of the clip's loud half.
  const looped = new SongPlayer(
    { ...songWith('rack/d1/mix1.level1'), sections: [{ tick: BAR + BAR / 2, length: BAR / 2, name: 'Up' }] },
    racks,
    { sampleRate: SR },
  )
  render(looped, BEAT)
  looped.playSection('Up', { when: 'now' })
  const jumped = render(looped, BEAT)
  check('a section jumped to has its automation from its first block', Math.abs(rms(jumped.left.subarray(4800)) / knob[0] - 1 / 0.8) < 0.03,
    `${(rms(jumped.left.subarray(4800)) / knob[0]).toFixed(3)}`)
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
