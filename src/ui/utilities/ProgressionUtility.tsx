import { useEffect, useRef, useState } from 'react'
import { setPatternLength, setPatternNotes } from '../../song/edit'
import { barTicks, beatTicks, PPQ, type Note, type Song } from '../../song/types'
import type { UtilityProps } from '../../utilities'
import {
  chordMidi,
  diatonicChords,
  fitProgression,
  keyName,
  progressionNotes,
  PROGRESSIONS,
  RHYTHMS,
  VOICINGS,
  type ProgressionSpec,
  type Rhythm,
  type Voicing,
  type WrittenNote,
} from '../../utilities/harmony'
import type { HarmonyPrefs } from '../../patch/storage'
import { NumberField } from '../NumberField'
import { rowOf, useAudition } from './audition'
import { MAX_CHORDS, useHarmony } from './harmonyStore'
import { KeyPicker } from './KeyPicker'

/** How long each chord can last, in bars. */
const LENGTHS: [bars: number, label: string][] = [
  [0.25, '1 beat'],
  [0.5, '½ bar'],
  [1, '1 bar'],
  [2, '2 bars'],
  [4, '4 bars'],
]

const VELOCITY = 0.8

/** The progression as a spec, at the song's opening meter. */
function specOf(h: HarmonyPrefs, song: Song): ProgressionSpec {
  const bar = barTicks(song)
  return {
    root: h.root,
    mode: h.mode,
    degrees: h.degrees,
    sevenths: h.sevenths,
    voicing: h.voicing,
    rhythm: h.rhythm,
    octave: h.octave,
    // A quarter of a bar in 4/4 is a beat; in 3/4 it is not, so a beat is a beat.
    chordTicks: h.bars === 0.25 ? beatTicks(song) : Math.round(h.bars * bar),
    beatTicks: beatTicks(song),
    barTicks: bar,
    velocity: VELOCITY,
  }
}

/**
 * The Progressions utility: a chord progression, sketched and written in.
 *
 * Start from one everybody knows or build one chord at a time -- from the
 * row of the key's chords here, or with **+** in Scales & chords, which
 * shares the key and the progression. Pick a voicing, a rhythm and how long
 * each chord lasts, hear it at the song's tempo, and **Write** puts it into
 * the pattern open in the roll, on the track on the bench, as one step of
 * undo: the pattern is lengthened to hold it if it has to be.
 */
export function ProgressionUtility(props: UtilityProps) {
  const { song, editSong, tracks, bench, patternId } = props
  const [h, set] = useHarmony(song)
  const { play, track } = useAudition(props)
  const [status, setStatus] = useState<string | null>(null)
  const [hearing, setHearing] = useState<number | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const chords = diatonicChords(h.root, h.mode, h.sevenths)
  const pattern = song.patterns.find((p) => p.id === patternId) ?? null
  const benchTrack = tracks.find((t) => t.id === bench) ?? null
  const spec = specOf(h, song)
  const once = h.degrees.length * spec.chordTicks
  const canWrite = !!pattern && !!benchTrack && benchTrack.kind === 'note' && h.degrees.length > 0

  const stop = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    setHearing(null)
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  // A different progression is a different thing to be hearing.
  useEffect(stop, [h.degrees, h.root, h.mode])

  /** Once through, at the song's tempo, each hit sounded as it comes round. */
  const hear = () => {
    stop()
    if (!h.degrees.length) return
    const sec = 60 / (song.tempo * PPQ)
    const groups = new Map<string, WrittenNote[]>()
    for (const n of progressionNotes(spec)) {
      const key = `${n.tick}|${n.length}`
      groups.set(key, [...(groups.get(key) ?? []), n])
    }
    for (const notes of groups.values()) {
      const { tick, length } = notes[0]
      timers.current.push(setTimeout(() => void play(notes.map((n) => n.midi), length * sec * 0.95, VELOCITY), tick * sec * 1000))
    }
    spec.degrees.forEach((_, i) => timers.current.push(setTimeout(() => setHearing(i), i * spec.chordTicks * sec * 1000)))
    timers.current.push(setTimeout(() => setHearing(null), once * sec * 1000))
  }

  const write = () => {
    if (!canWrite || !pattern || !benchTrack) return
    const fitted = fitProgression(progressionNotes(spec), once, pattern.length, h.fill)
    const written: Note[] = fitted.notes.map((n) => ({
      track: bench,
      tick: n.tick,
      length: n.length,
      pitch: rowOf(benchTrack, n.midi),
      velocity: n.velocity,
    }))
    const kept = h.replace ? pattern.notes.filter((n) => n.track !== bench) : pattern.notes
    const notes = [...kept, ...written].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    editSong((s) => setPatternNotes(setPatternLength(s, pattern.id, fitted.length), pattern.id, notes), undefined, 'Write progression')
    const longer = fitted.length > pattern.length
    setStatus(
      `Wrote ${h.degrees.length} chord${h.degrees.length === 1 ? '' : 's'} into ${pattern.name}` +
        (longer ? `, lengthened to ${Math.round((fitted.length / barTicks(song)) * 100) / 100} bars` : '') +
        ' -- undo takes it back',
    )
  }

  const numerals = (degrees: readonly number[]) => degrees.map((d) => chords[d % 7].numeral).join('–')

  return (
    <div className="progression">
      <div className="timing-row">
        <KeyPicker root={h.root} mode={h.mode} onChange={set} />
        <div className="timing-units" role="group" aria-label="Chord size">
          <button type="button" className={h.sevenths ? '' : 'on'} aria-pressed={!h.sevenths} onClick={() => set({ sevenths: false })}>
            Triads
          </button>
          <button type="button" className={h.sevenths ? 'on' : ''} aria-pressed={h.sevenths} onClick={() => set({ sevenths: true })}>
            Sevenths
          </button>
        </div>
      </div>

      <div className="pitch-section">
        <h3>Start from</h3>
        <div className="progression-presets">
          {PROGRESSIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="progression-preset"
              title={`${p.name}: ${numerals(p.degrees)} in ${keyName(h.root, h.mode)}`}
              onClick={() => {
                set({ degrees: [...p.degrees] })
                setStatus(null)
              }}
            >
              <span>{p.name}</span> <span className="timing-dim">{p.degrees.length > 4 ? `${p.degrees.length} chords` : numerals(p.degrees)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pitch-section">
        <div className="timing-sections-head">
          <h3>Progression</h3>
          <button type="button" disabled={!h.degrees.length} onClick={() => set({ degrees: h.degrees.slice(0, -1) })}>
            Undo last
          </button>
          <button type="button" disabled={!h.degrees.length} onClick={() => set({ degrees: [] })}>
            Clear
          </button>
        </div>
        <ol className="progression-strip" aria-label="The progression">
          {h.degrees.map((d, i) => {
            const c = chords[d % 7]
            return (
              <li key={i} className={hearing === i ? 'on' : ''}>
                <button type="button" className="progression-chord" title={`${c.name}: ${c.notes.join(' ')}. Click to hear it.`} onClick={() => void play(chordMidi(c, h.octave))}>
                  <span className="scales-numeral">{c.numeral}</span>
                  <span className="scales-name">{c.name}</span>
                </button>
                <button
                  type="button"
                  className="timing-remove"
                  aria-label={`Take out chord ${i + 1}, ${c.name}`}
                  onClick={() => set({ degrees: h.degrees.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </li>
            )
          })}
          {h.degrees.length === 0 && <li className="timing-dim progression-empty">Empty -- add chords below, or start from one above</li>}
        </ol>
        <div className="progression-add" role="group" aria-label="Add a chord">
          {chords.map((c, i) => (
            <button
              key={i}
              type="button"
              className={c.outside ? 'outside' : ''}
              disabled={h.degrees.length >= MAX_CHORDS}
              title={`Add ${c.name} (${c.notes.join(' ')})`}
              onClick={() => {
                set({ degrees: [...h.degrees, i] })
                void play(chordMidi(c, h.octave), 0.6)
              }}
            >
              + {c.numeral}
            </button>
          ))}
        </div>
      </div>

      <div className="timing-row">
        <label className="timing-field">
          <span>Voicing</span>
          <select value={h.voicing} aria-label="Voicing" title={VOICINGS.find((v) => v.id === h.voicing)?.description} onChange={(e) => set({ voicing: e.target.value as Voicing })}>
            {VOICINGS.map((v) => (
              <option key={v.id} value={v.id} title={v.description}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="timing-field">
          <span>Rhythm</span>
          <select value={h.rhythm} aria-label="Rhythm" title={RHYTHMS.find((r) => r.id === h.rhythm)?.description} onChange={(e) => set({ rhythm: e.target.value as Rhythm })}>
            {RHYTHMS.map((r) => (
              <option key={r.id} value={r.id} title={r.description}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="timing-field">
          <span>Each chord</span>
          <select value={h.bars} aria-label="How long each chord lasts" onChange={(e) => set({ bars: Number(e.target.value) })}>
            {LENGTHS.map(([bars, label]) => (
              <option key={bars} value={bars}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="timing-field">
          <span>Octave</span>
          <NumberField value={h.octave} min={0} max={7} label="The octave the chords are in: 3 is from C3" onChange={(octave) => set({ octave })} />
        </label>
      </div>

      <div className="progression-options">
        <label className="metronome-check" title="Off, the progression is added to what the track already has in the pattern">
          <input type="checkbox" checked={h.replace} onChange={(e) => set({ replace: e.target.checked })} />
          Replace the track's notes
        </label>
        <label className="metronome-check" title="Round again until the pattern is full, when the progression is shorter than it">
          <input type="checkbox" checked={h.fill} onChange={(e) => set({ fill: e.target.checked })} />
          Repeat to fill the pattern
        </label>
      </div>

      <div className="progression-actions">
        <button type="button" className="timing-song" disabled={!h.degrees.length} onClick={() => (hearing === null ? hear() : stop())}>
          {hearing === null ? '▶ Hear it' : '■ Stop'}
        </button>
        <button
          type="button"
          className="timing-song progression-write"
          disabled={!canWrite}
          title={canWrite ? `Into ${pattern!.name}, on ${benchTrack!.name}, as one step of undo` : undefined}
          onClick={write}
        >
          Write into {pattern?.name ?? 'the pattern'}
        </button>
      </div>

      <p className="timing-dim timing-status" aria-live="polite">
        {status ??
          (!benchTrack || benchTrack.kind !== 'note'
            ? 'The track on the bench has no Keyboard to play chords: put one in its rack, or pick a track that has one.'
            : `${once / barTicks(song) >= 1 ? `${Math.round((once / barTicks(song)) * 100) / 100} bars` : 'Less than a bar'}, written to ${track?.name || 'the rack'} in ${pattern?.name ?? 'the pattern'}.`)}
      </p>
    </div>
  )
}
