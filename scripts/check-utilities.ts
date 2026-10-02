/**
 * Checks for the utilities' arithmetic: the numbers the Timing utility gives
 * are the numbers the song plays at.
 *
 * The one thing held hardest is that a tempo counts quarter notes whatever
 * the time signature, because that is what the engine does -- a calculator
 * that counted eighths in 6/8 would give delay times half a beat out.
 *
 * Run with: npm run check:utilities
 */
import { PPQ, type Song } from '../src/song/types'
import { secondsAt } from '../src/song/timeline'
import { UTILITIES } from '../src/utilities'
import { euclid, laneSteps, notation, RHYTHM_PRESETS, rhythmNotes, rotate } from '../src/utilities/euclid'
import {
  chordMidi,
  CIRCLE,
  diatonicChords,
  fitProgression,
  keyName,
  progressionNotes,
  scaleClasses,
  spelling,
  voiceProgression,
} from '../src/utilities/harmony'
import { ClickCounter, type MetronomeSettings } from '../src/utilities/metronome'
import { harmonics, midiToHz, nearest, parsePitch, semitoneRatio } from '../src/utilities/pitch'
import {
  barSeconds,
  barsToSeconds,
  beatSeconds,
  countBars,
  formatDuration,
  formatUnit,
  inUnit,
  noteName,
  noteSeconds,
  parseDuration,
  TapTempo,
} from '../src/utilities/timing'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps

console.log('\nsong length')
{
  const four = { beats: 4, unit: 4 }
  const c = countBars(180, 120, four)
  check('three minutes at 120 in 4/4 is 90 bars', c.bars === 90 && c.extraBeats === 0 && c.remainder === 0, JSON.stringify(c))
  check('and 360 beats', c.beats === 360)

  const odd = countBars(100, 120, four)
  check('a length that is not whole bars says what is over', odd.bars === 50 && odd.extraBeats === 0, JSON.stringify(odd))
  const over = countBars(101, 120, four)
  check('two beats over', over.bars === 50 && over.extraBeats === 2 && near(over.remainder, 0), JSON.stringify(over))
  const part = countBars(101.25, 120, four)
  check('and half a beat past those', part.extraBeats === 2 && near(part.remainder, 0.5), JSON.stringify(part))

  check('bars back to time', near(barsToSeconds(90, 120, four), 180))
  check('a bar of 4/4 at 120 is two seconds', near(barSeconds(120, four), 2))
  check('a bar of 3/4 at 90 is two seconds', near(barSeconds(90, { beats: 3, unit: 4 }), 2))
}

console.log('\ntempo counts quarter notes, as the engine does')
{
  const sixEight = { beats: 6, unit: 8 }
  check('a bar of 6/8 at 120 is a second and a half', near(barSeconds(120, sixEight), 1.5))
  check('and its beat is an eighth: a quarter of a second', near(beatSeconds(120, sixEight), 0.25))
  // The song's own clock, for a song in each meter: a bar's ticks in seconds.
  for (const meter of [
    { beats: 4, unit: 4 },
    { beats: 6, unit: 8 },
    { beats: 7, unit: 8 },
    { beats: 3, unit: 2 },
    { beats: 5, unit: 16 },
  ] as const) {
    const song = { tempo: 97, meter } as unknown as Song
    const barTicks = (meter.beats * PPQ * 4) / meter.unit
    check(
      `a bar of ${meter.beats}/${meter.unit} lasts what the song plays it for`,
      near(barSeconds(97, meter), secondsAt(song, barTicks), 1e-9),
      `${barSeconds(97, meter)} against ${secondsAt(song, barTicks)}`,
    )
  }
}

console.log('\nnote lengths')
{
  check('a quarter at 120 is 500 ms', near(noteSeconds(120, 4, 'straight') * 1000, 500))
  check('a dotted eighth at 120 is 375 ms', near(noteSeconds(120, 8, 'dotted') * 1000, 375))
  check('an eighth triplet at 120 is a third of a beat', near(noteSeconds(120, 8, 'triplet'), 1 / 6))
  check('a whole note at 60 is four seconds', near(noteSeconds(60, 1, 'straight'), 4))
  check('a sixteenth at 120 is 8 Hz', near(inUnit(noteSeconds(120, 16, 'straight'), 'hz', 48000), 8))
  check('a quarter at 120 is 24000 samples at 48k', near(inUnit(noteSeconds(120, 4, 'straight'), 'samples', 48000), 24000))
  check('names read as written', noteName(4) === '1/4' && noteName(8, 'dotted') === '1/8 dotted' && noteName(1) === '1/1')
  check('ms keep two places', formatUnit(166.66666, 'ms') === '166.67' && formatUnit(500, 'ms') === '500')
  check('samples are whole', formatUnit(24000.4, 'samples') === '24000')
  check('slow rates keep their digits', formatUnit(0.3333333, 'hz') === '0.3333')
}

console.log('\ndurations as people type them')
{
  const cases: [string, number | null][] = [
    ['3:00', 180],
    ['2:30.5', 150.5],
    ['1:02:03', 3723],
    ['180', 180],
    ['3m', 180],
    ['90s', 90],
    ['2m30s', 150],
    ['1h', 3600],
    ['  3:00  ', 180],
    ['3:60', null],
    ['', null],
    ['0', null],
    ['abc', null],
    ['-3:00', null],
  ]
  for (const [text, want] of cases) {
    const got = parseDuration(text)
    check(`"${text}" is ${want ?? 'not a length'}`, got === want, `got ${got}`)
  }
  check('three minutes reads 3:00', formatDuration(180) === '3:00')
  check('with tenths when there are any', formatDuration(192.5) === '3:12.5')
  check('rounded to a tenth without reading 2:60', formatDuration(179.99) === '3:00', formatDuration(179.99))
  check('past an hour', formatDuration(3723) === '1:02:03')
  check('and back again', parseDuration(formatDuration(150.5)) === 150.5)
}

console.log('\ntap tempo')
{
  const tapper = new TapTempo()
  check('one tap is no tempo yet', tapper.tap(10) === null)
  let r = null as ReturnType<TapTempo['tap']>
  for (let i = 1; i < 8; i++) r = tapper.tap(10 + i * 0.5)
  check('taps half a second apart are 120', !!r && near(r.bpm, 120, 1e-9), JSON.stringify(r))
  check('and perfectly steady', !!r && near(r.steadiness, 1, 1e-9) && r.taps === 8)

  // A human hand: every tap up to 15 ms either side of the beat.
  const hand = new TapTempo()
  const jitter = [0.012, -0.008, 0.015, -0.014, 0.003, -0.011, 0.009, -0.004, 0.013, -0.015, 0.006, -0.002]
  let h = null as ReturnType<TapTempo['tap']>
  jitter.forEach((j, i) => (h = hand.tap(100 + i * (60 / 97) + j)))
  check('a slightly uneven hand still reads within a beat a minute', !!h && Math.abs(h.bpm - 97) < 1, h?.bpm.toFixed(2))
  check('and reads as not quite steady', !!h && h.steadiness < 1 && h.steadiness > 0.9, h?.steadiness.toFixed(3))

  const paused = new TapTempo()
  paused.tap(0)
  paused.tap(0.5)
  check('a pause starts a new count', paused.tap(3) === null && paused.tap(3.4)?.taps === 2)
  const back = new TapTempo()
  back.tap(5)
  check('a clock that goes backwards starts a new count', back.tap(4) === null)

  const recent = new TapTempo()
  let w = null as ReturnType<TapTempo['tap']>
  for (let i = 0; i < 40; i++) w = recent.tap(i * 0.4)
  check('only the latest taps count', !!w && w.taps === 16 && near(w.bpm, 150, 1e-9), JSON.stringify(w))
}

console.log('\nnotes and frequencies')
{
  const at = (text: string, a4?: number) => parsePitch(text, a4)
  check('A4 is 440', near(at('A4')!.hz, 440) && at('A4')!.midi === 69)
  check('middle C is C4, MIDI 60, 261.63 Hz', at('C4')!.midi === 60 && Math.abs(at('C4')!.hz - 261.6256) < 1e-3)
  check('flats, sharps and doubles', at('Bb2')!.midi === 46 && at('A#2')!.midi === 46 && at('c##4')!.midi === 62 && at('E#3')!.midi === 53 && at('F♯1')!.midi === 30)
  check('a whole number up to 127 is a MIDI note', at('60')!.midi === 60 && at('midi 72')!.midi === 72)
  check('anything else is hertz', near(at('60.5')!.hz, 60.5) && near(at('440 Hz')!.hz, 440) && near(at('1.2 kHz')!.hz, 1200))
  check('nonsense is nothing', at('H4') === null && at('') === null && at('0 hz') === null && at('A')=== null)
  const off = nearest(at('445')!.midi)
  check('445 Hz is an A4 a little sharp', off.name === 'A4' && Math.abs(off.cents - 19.6) < 0.1, JSON.stringify(off))
  check('a reference of 432 moves every note', near(at('A4', 432)!.hz, 432) && near(midiToHz(57, 432), 216))
  const h = harmonics(110, 6)
  check('the harmonics of A2 are A3, E4 and C#5 among them', h[1].name === 'A3' && h[2].name === 'E4' && Math.abs(h[2].cents - 2) < 0.1 && h[4].name === 'C#5' && Math.abs(h[4].cents + 13.7) < 0.1, JSON.stringify(h.map((x) => `${x.name}${x.cents}`)))
  check('an octave is twice the speed, a fifth half as much again', near(semitoneRatio(12), 2) && Math.abs(semitoneRatio(7) - 1.4983) < 1e-4)
}

console.log('\nmetronome')
{
  const four: MetronomeSettings = { bpm: 120, sig: { beats: 4, unit: 4 }, subdivision: 1, accent: true }
  const bar = new ClickCounter(0).until(2, four)
  check('a bar of 4/4 at 120 is four clicks half a second apart', bar.map((c) => c.time).join() === '0,0.5,1,1.5')
  check('the first accented, the rest beats', bar.map((c) => c.kind).join() === 'accent,beat,beat,beat' && bar.map((c) => c.beat).join() === '0,1,2,3')
  check('and then the next bar', new ClickCounter(0).until(2.1, four)[4]?.kind === 'accent')
  const subs = new ClickCounter(0).until(2, { ...four, subdivision: 2 })
  check('two a beat puts a quieter click between', subs.length === 8 && subs[1].kind === 'sub' && subs[1].beat === 0 && subs[2].kind === 'beat')
  const triplets = new ClickCounter(0).until(0.5, { ...four, subdivision: 3 })
  check('triplets are three to the beat', triplets.length === 3 && Math.abs(triplets[1].time - 1 / 6) < 1e-12)
  const sixEight = new ClickCounter(0).until(1.6, { ...four, sig: { beats: 6, unit: 8 } })
  check('6/8 at 120 counts eighths, a quarter second apart, six to the bar', sixEight.length === 7 && near(sixEight[1].time, 0.25) && sixEight[6].kind === 'accent')
  check('without the accent the first beat is a beat', new ClickCounter(0).until(0.1, { ...four, accent: false })[0].kind === 'beat')
  const piecewise = new ClickCounter(0)
  const joined = [...piecewise.until(0.7, four), ...piecewise.until(1.3, four), ...piecewise.until(2, four)]
  check('asked for in pieces, the same clicks as asked for at once', joined.map((c) => `${c.time}${c.kind}`).join() === bar.map((c) => `${c.time}${c.kind}`).join())
  const slower = new ClickCounter(0)
  slower.until(0.6, four)
  const after = slower.until(3, { ...four, bpm: 60 })
  check('a change of tempo lands on the next click, not the one already counted', near(after[0].time, 1) && near(after[1].time, 2))
}

console.log('\nscales and chords')
{
  const names = (root: number, mode: string, sevenths = false) => diatonicChords(root, mode, sevenths).map((c) => c.name).join(' ')
  const numerals = (root: number, mode: string, sevenths = false) => diatonicChords(root, mode, sevenths).map((c) => c.numeral).join(' ')
  check('C major: C Dm Em F G Am Bdim', names(0, 'major') === 'C Dm Em F G Am Bdim', names(0, 'major'))
  check('numbered I ii iii IV V vi vii°', numerals(0, 'major') === 'I ii iii IV V vi vii°', numerals(0, 'major'))
  check('A minor: i ii° ♭III iv v ♭VI ♭VII', numerals(9, 'minor') === 'i ii° ♭III iv v ♭VI ♭VII', numerals(9, 'minor'))
  check('harmonic minor has a major V and a leading-tone vii°', names(9, 'harmonic').split(' ')[4] === 'E' && numerals(9, 'harmonic').endsWith('vii°'), names(9, 'harmonic'))
  check('sevenths in C: Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7♭5', names(0, 'major', true) === 'Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7♭5', names(0, 'major', true))
  check('F major is spelled with a B♭', scaleClasses(5, 'major').map(spelling(5, 'major')).join(' ') === 'F G A B♭ C D E')
  check('D major with sharps', scaleClasses(2, 'major').map(spelling(2, 'major')).join(' ') === 'D E F♯ G A B C♯')
  check('a C♯ root in major is D♭ major, fewer accidentals', keyName(1, 'major') === 'D♭ Major', keyName(1, 'major'))
  check('and in minor C♯ minor', keyName(1, 'minor') === 'C♯ Minor', keyName(1, 'minor'))
  check('a tie goes to sharps: D♯ minor, beside F♯ major', keyName(3, 'minor') === 'D♯ Minor' && keyName(10, 'minor') === 'B♭ Minor', keyName(3, 'minor'))
  const penta = diatonicChords(0, 'pentatonic')
  check('a pentatonic borrows its parent major chords, marked where they reach outside it', penta.length === 7 && penta[0].name === 'C' && !penta[0].outside && penta[1].outside && !penta[5].outside)
  check('every chord a stack of the scale', diatonicChords(7, 'dorian').every((c) => c.intervals.length === 3 && c.quality !== null))
  check('the circle of fifths goes C G D A E B ...', CIRCLE.slice(0, 6).join() === '0,7,2,9,4,11' && CIRCLE.length === 12 && new Set(CIRCLE).size === 12)
  check('a chord in root position in its octave: Dm in 4 is D4 F4 A4', chordMidi(diatonicChords(0, 'major')[1], 4).join() === '62,65,69')
}

console.log('\nprogressions')
{
  const base = {
    root: 0,
    mode: 'major',
    degrees: [0, 4, 5, 3],
    sevenths: false,
    octave: 3,
    chordTicks: PPQ * 4,
    beatTicks: PPQ,
    barTicks: PPQ * 4,
    velocity: 0.8,
  }
  const close = voiceProgression({ ...base, voicing: 'close' })
  check('close voicing is root position: C E G, G B D, A C E, F A C', close.map((c) => c.join(' ')).join(' | ') === '48 52 55 | 55 59 62 | 57 60 64 | 53 57 60')
  const smooth = voiceProgression({ ...base, voicing: 'smooth' })
  const moved = (v: number[][]) => v.slice(1).reduce((sum, c, i) => sum + c.reduce((s, p, k) => s + Math.abs(p - v[i][k]), 0), 0)
  check('smooth voicing moves less than close', moved(smooth) < moved(close), `${moved(smooth)} < ${moved(close)}`)
  check('smooth keeps every chord its own notes', smooth.every((c, i) => c.map((p) => p % 12).sort().join() === close[i].map((p) => p % 12).sort().join()))
  check('and stays near where it started', smooth.every((c) => Math.abs(c[0] - smooth[0][0]) <= 7))
  const bass = voiceProgression({ ...base, voicing: 'bass' })
  check('with bass puts the root an octave under', bass.every((c, i) => c[0] === close[i][0] - 12 && c.length === 4))
  const spread = voiceProgression({ ...base, voicing: 'spread' })
  check('spread lifts the third: C G E', spread[0].join() === '48,55,64')

  const held = progressionNotes({ ...base, voicing: 'close', rhythm: 'held' })
  check('held: one hit a chord, a bar long', held.length === 12 && held.every((n) => n.length === PPQ * 4) && held[3].tick === PPQ * 4)
  const beats = progressionNotes({ ...base, voicing: 'close', rhythm: 'beats' })
  check('beats: four hits a bar', beats.length === 4 * 4 * 3 && beats.every((n) => n.tick % PPQ === 0))
  const off = progressionNotes({ ...base, voicing: 'close', rhythm: 'offbeats' })
  check('off-beats land between the beats', off.every((n) => n.tick % PPQ === PPQ / 2))
  const arp = progressionNotes({ ...base, degrees: [0], voicing: 'close', rhythm: 'arpUpDown' })
  check('arp up & down: C E G E C E G E', arp.map((n) => n.midi).join() === '48,52,55,52,48,52,55,52', arp.map((n) => n.midi).join())
  const half = progressionNotes({ ...base, voicing: 'close', rhythm: 'charleston', chordTicks: PPQ * 2 })
  check('no hit runs past the end of its chord', half.every((n) => Math.floor(n.tick / (PPQ * 2)) === Math.floor((n.tick + n.length - 1) / (PPQ * 2))))

  const once = 4 * PPQ * 4
  const two = fitProgression(held, once, once * 2, true)
  check('filling a pattern twice as long plays it twice', two.length === once * 2 && two.notes.length === 24)
  const unfilled = fitProgression(held, once, once * 2, false)
  check('or once, unasked', unfilled.notes.length === 12 && unfilled.length === once * 2)
  const longer = fitProgression(held, once, PPQ * 4, true)
  check('a pattern too short to hold it is lengthened', longer.length === once && longer.notes.length === 12)
}

console.log('\neuclidean rhythms')
{
  check('three in eight is the tresillo', notation(euclid(3, 8)) === 'x..x..x.')
  check('five in eight is the cinquillo', notation(euclid(5, 8)) === 'x.xx.xx.')
  check('four in sixteen is four on the floor', notation(euclid(4, 16)) === 'x...x...x...x...')
  check('five in sixteen is the bossa', notation(euclid(5, 16)) === 'x..x..x..x..x...')
  check('none and all', notation(euclid(0, 4)) === '....' && notation(euclid(4, 4)) === 'xxxx')
  check('more hits than steps is every step', notation(euclid(9, 4)) === 'xxxx')
  check('every k and n has k hits', [...Array(16)].every((_, n) => [...Array(n + 2)].every((__, k) => euclid(k, n + 1).filter(Boolean).length === Math.min(k, n + 1))))
  check('rotation turns it later', notation(rotate(euclid(3, 8), 1)) === '.x..x..x' && notation(rotate(euclid(3, 8), -1)) === '..x..x.x')
  const lane = laneSteps({ steps: 8, hits: 4, rotate: 0, accents: 2 })
  check('two accents of four hits are every other hit', lane.filter((s) => s.accent).length === 2 && lane[0].accent && !lane[2].accent && lane[4].accent)

  const spec = {
    lanes: [{ row: 24, steps: 8, hits: 3, rotate: 0, accents: 1, probability: 1 }],
    step: PPQ / 4,
    bar: PPQ * 4,
    length: PPQ * 8,
    velocity: 0.7,
    accent: 1,
    seed: 1,
  }
  const hits = rhythmNotes(spec)
  check('a lane goes round to fill the length', hits.length === 12 && hits.map((h) => h.tick / (PPQ / 4)).slice(0, 6).join() === '0,3,6,8,11,14')
  check('accented hits are louder', hits[0].velocity === 1 && hits[1].velocity === 0.7)
  const fitted = rhythmNotes({ ...spec, lanes: [{ row: 0, steps: 3, hits: 3, rotate: 0, accents: 0, probability: 1, fit: true }], length: PPQ * 4 })
  check('fitted to the bar, three steps are three in the bar', fitted.map((h) => h.tick).join() === '0,1280,2560', fitted.map((h) => h.tick).join())
  const chance = { ...spec, lanes: [{ row: 0, steps: 16, hits: 16, rotate: 0, accents: 4, probability: 0.5 }], length: PPQ * 64 }
  const some = rhythmNotes(chance)
  check('half the chance writes about half the plain hits', some.length > 64 + 96 - 30 && some.length < 64 + 96 + 30, `${some.length} of 256, 64 accented`)
  check('accents always play', some.filter((h) => h.velocity === 1).length === 64)
  check('the same seed is the same rhythm', JSON.stringify(rhythmNotes(chance)) === JSON.stringify(some))
  check('another seed is another', JSON.stringify(rhythmNotes({ ...chance, seed: 2 })) !== JSON.stringify(some))
  check('a muted lane writes nothing', rhythmNotes({ ...spec, lanes: [{ ...spec.lanes[0], mute: true }] }).length === 0)
  check('every preset has lanes that fit', RHYTHM_PRESETS.every((p) => p.lanes.length > 0 && p.lanes.every((l) => l.hits <= l.steps)))
}

console.log('\nthe registry')
{
  check('every utility has a name and a way to load', UTILITIES.every((u) => u.name && typeof u.load === 'function'))
  check('ids are unique', new Set(UTILITIES.map((u) => u.id)).size === UTILITIES.length)
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
