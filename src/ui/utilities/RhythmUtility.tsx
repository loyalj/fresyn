import { useEffect, useRef, useState } from 'react'
import { GM_DRUMS } from '../../patch/kit'
import { loadPrefs, savePrefs, type RhythmPrefs } from '../../patch/storage'
import { setPatternNotes } from '../../song/edit'
import { barTicks, PPQ, type Note } from '../../song/types'
import type { UtilityProps, UtilityTrack } from '../../utilities'
import { laneSteps, MAX_STEPS, notation, RHYTHM_PRESETS, rhythmNotes, type Lane, type RhythmPreset } from '../../utilities/euclid'
import { NumberField } from '../NumberField'
import { useAudition } from './audition'

type LanePrefs = RhythmPrefs['lanes'][number]

/** Grid steps to a quarter note, and what they are called. */
const GRIDS: [perBeat: number, label: string][] = [
  [2, '1/8'],
  [3, '1/8 triplet'],
  [4, '1/16'],
  [6, '1/16 triplet'],
  [8, '1/32'],
]
/** The most lanes a rhythm has: one for each pad of a kit. */
const MAX_LANES = 16
const VELOCITY = 0.7
const ACCENT = 1
/** The row a plain Trigger track's hits are written on: any row fires it. */
const TRIGGER_ROW = 0
/** How much of a rhythm Hear it plays: enough to hear a long lane go round. */
const HEAR_BARS = 2

const presetLanes = (p: RhythmPreset): LanePrefs[] =>
  p.lanes.map(({ note, steps, hits, rotate, accents, probability, fit }) => ({
    note,
    steps,
    hits,
    rotate,
    accents: accents ?? 0,
    probability: probability ?? 1,
    ...(fit ? { fit } : {}),
  }))

function initial(): RhythmPrefs {
  return { lanes: presetLanes(RHYTHM_PRESETS[0]), perBeat: 4, seed: 1, replace: true, ...loadPrefs().rhythm }
}

const isDrums = (t: UtilityTrack) => t.kind === 'kit' || t.kind === 'trigger'

/**
 * The Rhythm utility: Euclidean rhythms, a lane per drum.
 *
 * Each lane spreads so many hits over so many steps as evenly as they go --
 * three in eight is the tresillo -- turned round by a rotation, with some of
 * its hits accented the same even way and the rest left to chance. Lanes of
 * different lengths drift against each other; a lane fitted to the bar
 * plays its steps across the bar whatever the grid, which is how four
 * against three is made. **Write** fills the pattern open in the roll on a
 * Drum Kit track (or a track played by a Trigger) as one step of undo,
 * taking away what was on the lanes' pads first unless told not to.
 */
export function RhythmUtility(props: UtilityProps) {
  const { song, tracks, bench, patternId, editSong } = props
  const [state, setState] = useState<RhythmPrefs>(initial)
  useEffect(() => savePrefs({ rhythm: state }), [state])
  const set = (change: Partial<RhythmPrefs>) => setState((s) => ({ ...s, ...change }))
  const setLane = (i: number, change: Partial<LanePrefs>) =>
    setState((s) => ({ ...s, lanes: s.lanes.map((l, j) => (j === i ? tidy({ ...l, ...change }) : l)) }))
  const [status, setStatus] = useState<string | null>(null)
  const { strike } = useAudition(props)
  const [hearing, setHearing] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const stop = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    setHearing(false)
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const drums = tracks.filter(isDrums)
  const target =
    drums.find((t) => t.id === state.track) ?? drums.find((t) => t.id === bench) ?? drums[0] ?? null
  const pattern = song.patterns.find((p) => p.id === patternId) ?? null
  const kit = target?.kind === 'kit'

  /** The row a lane writes on, in the target: the pad on its note, or nothing for a kit with none. */
  const rowOf = (lane: LanePrefs): number | null => {
    if (!target) return null
    if (!kit) return TRIGGER_ROW
    return target.pads.find((p) => p.note === lane.note)?.row ?? null
  }
  const padName = (note: number) => target?.pads.find((p) => p.note === note)?.name ?? GM_DRUMS[note] ?? `Note ${note}`

  const lanes = (): Lane[] =>
    state.lanes.flatMap((l) => {
      const row = rowOf(l)
      return row === null ? [] : [{ ...l, row }]
    })

  const spec = (length: number) => ({
    lanes: lanes(),
    step: PPQ / state.perBeat,
    bar: barTicks(song),
    length,
    velocity: VELOCITY,
    accent: ACCENT,
    seed: state.seed,
  })

  const hear = () => {
    stop()
    if (!target) return
    const sec = 60 / (song.tempo * PPQ)
    const length = Math.min(pattern?.length ?? barTicks(song), barTicks(song) * HEAR_BARS)
    for (const hit of rhythmNotes(spec(length))) {
      timers.current.push(setTimeout(() => strike(target.id, hit.row, hit.velocity, 0.12), hit.tick * sec * 1000))
    }
    timers.current.push(setTimeout(() => setHearing(false), length * sec * 1000))
    setHearing(true)
  }

  const write = () => {
    if (!target || !pattern) return
    const written = rhythmNotes(spec(pattern.length))
    const rows = new Set(lanes().filter((l) => !l.mute).map((l) => l.row))
    const kept = state.replace
      ? pattern.notes.filter((n) => n.track !== target.id || (kit && !rows.has(n.pitch)))
      : pattern.notes
    const notes: Note[] = [
      ...kept,
      ...written.map((h) => ({ track: target.id, tick: h.tick, length: h.length, pitch: h.row, velocity: h.velocity })),
    ].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    editSong((s) => setPatternNotes(s, pattern.id, notes), undefined, 'Write rhythm')
    setStatus(`Wrote ${written.length} hit${written.length === 1 ? '' : 's'} into ${pattern.name} on ${target.name} -- undo takes it back`)
  }

  const addLane = () => {
    const used = new Set(state.lanes.map((l) => l.note))
    const free = target?.pads.find((p) => !used.has(p.note))?.note ?? 42
    set({ lanes: [...state.lanes, { note: free, steps: 16, hits: 4, rotate: 0, accents: 0, probability: 1 }] })
  }

  const missing = kit ? state.lanes.filter((l) => !l.mute && rowOf(l) === null).length : 0

  return (
    <div className="rhythm">
      <div className="timing-row">
        <label className="timing-field">
          <span>Track</span>
          <select
            value={target?.id ?? ''}
            aria-label="The drum track written to"
            disabled={!drums.length}
            onChange={(e) => set({ track: e.target.value })}
          >
            {!drums.length && <option value="">No drum track</option>}
            {drums.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || t.id}
                {t.kind === 'trigger' ? ' (Trigger)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="timing-field">
          <span>Step</span>
          <select value={state.perBeat} aria-label="How long a step is" onChange={(e) => set({ perBeat: Number(e.target.value) })}>
            {GRIDS.map(([perBeat, label]) => (
              <option key={perBeat} value={perBeat}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="timing-song"
          title="Roll the dice again for the hits left to chance"
          onClick={() => set({ seed: (state.seed % 9999) + 1 })}
        >
          Reroll
        </button>
      </div>

      <div className="pitch-section">
        <h3>Start from</h3>
        <div className="progression-presets">
          {RHYTHM_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="progression-preset"
              title={p.description}
              onClick={() => {
                set({ lanes: presetLanes(p), perBeat: p.perBeat })
                setStatus(null)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="pitch-section">
        <div className="timing-sections-head">
          <h3>Lanes</h3>
          <button type="button" disabled={state.lanes.length >= MAX_LANES} onClick={addLane}>
            + Lane
          </button>
        </div>
        <div className="rhythm-lanes" role="list" aria-label="Lanes">
          <div className="rhythm-lane rhythm-head" aria-hidden="true">
            <span>Pad</span>
            <span title="How many steps the lane has before it goes round again">Steps</span>
            <span title="How many of them are hits, spread as evenly as they go">Hits</span>
            <span title="How many steps later the rhythm starts">Rotate</span>
            <span title="How many of the hits are accented, spread evenly among them">Accent</span>
            <span title="How likely an unaccented hit is to be written, in percent">Chance</span>
            <span title="Spread the lane's steps evenly over a bar, whatever the grid: a polyrhythm">Bar</span>
            <span />
          </div>
            {state.lanes.map((lane, i) => {
              const cycle = laneSteps(lane)
              const lost = kit && rowOf(lane) === null
              return (
                <div key={i} role="listitem" className={`rhythm-row${lane.mute ? ' muted' : ''}${lost ? ' lost' : ''}`}>
                    <div className="rhythm-lane">
                      <div className="rhythm-pad">
                        <button
                          type="button"
                          className="rhythm-hit"
                          aria-label={`Hear ${padName(lane.note)}`}
                          title="Hear the pad"
                          disabled={!target || rowOf(lane) === null}
                          onClick={() => {
                            const row = rowOf(lane)
                            if (target && row !== null) strike(target.id, row, ACCENT, 0.2)
                          }}
                        >
                          ▶
                        </button>
                        {kit ? (
                          <select
                            value={lane.note}
                            aria-label={`Lane ${i + 1}'s pad`}
                            onChange={(e) => setLane(i, { note: Number(e.target.value) })}
                          >
                            {lost && <option value={lane.note}>{padName(lane.note)} (no pad)</option>}
                            {target!.pads.map((p) => (
                              <option key={p.row} value={p.note}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="rhythm-pad-name">{padName(lane.note)}</span>
                        )}
                      </div>
                      <NumberField value={lane.steps} min={1} max={MAX_STEPS} label={`Lane ${i + 1}: steps`} onChange={(steps) => setLane(i, { steps })} />
                      <NumberField value={lane.hits} min={0} max={lane.steps} label={`Lane ${i + 1}: hits`} onChange={(hits) => setLane(i, { hits })} />
                      <NumberField value={lane.rotate} min={0} max={Math.max(0, lane.steps - 1)} label={`Lane ${i + 1}: rotation`} onChange={(rotate) => setLane(i, { rotate })} />
                      <NumberField value={lane.accents} min={0} max={lane.hits} label={`Lane ${i + 1}: accents`} onChange={(accents) => setLane(i, { accents })} />
                      <NumberField
                        value={Math.round(lane.probability * 100)}
                        min={0}
                        max={100}
                        label={`Lane ${i + 1}: chance of an unaccented hit, in percent`}
                        onChange={(p) => setLane(i, { probability: p / 100 })}
                      />
                      <input
                        type="checkbox"
                        checked={!!lane.fit}
                        aria-label={`Lane ${i + 1}: fit to the bar`}
                        onChange={(e) => setLane(i, { fit: e.target.checked || undefined })}
                      />
                      <span className="rhythm-actions">
                        <button
                          type="button"
                          className={`rhythm-mute${lane.mute ? ' on' : ''}`}
                          aria-pressed={!!lane.mute}
                          title={lane.mute ? 'Muted: left out of what is written' : 'Leave this lane out of what is written'}
                          onClick={() => setLane(i, { mute: !lane.mute || undefined })}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          className="timing-remove"
                          aria-label={`Remove lane ${i + 1}`}
                          onClick={() => set({ lanes: state.lanes.filter((_, j) => j !== i) })}
                        >
                          ×
                        </button>
                      </span>
                    </div>
                    <div className="rhythm-steps" aria-label={`Lane ${i + 1}: ${notation(cycle.map((c) => c.hit))}`} role="img">
                      {cycle.map((c, k) => (
                        <span key={k} className={c.accent ? 'accent' : c.hit ? (lane.probability < 1 ? 'hit chance' : 'hit') : ''} />
                      ))}
                    </div>
                </div>
              )
            })}
        </div>
        {state.lanes.length === 0 && <p className="timing-dim timing-empty">No lanes: add one, or start from a groove above.</p>}
      </div>

      <div className="progression-options">
        <label className="metronome-check" title="Off, the hits are added to what is already on the lanes' pads">
          <input type="checkbox" checked={state.replace} onChange={(e) => set({ replace: e.target.checked })} />
          Replace what is on these pads
        </label>
      </div>

      <div className="progression-actions">
        <button type="button" className="timing-song" disabled={!target || !state.lanes.length} onClick={() => (hearing ? stop() : hear())}>
          {hearing ? '■ Stop' : '▶ Hear it'}
        </button>
        <button
          type="button"
          className="timing-song progression-write"
          disabled={!target || !pattern || !state.lanes.length}
          title={target && pattern ? `Fill ${pattern.name} on ${target.name}, as one step of undo` : undefined}
          onClick={write}
        >
          Write into {pattern?.name ?? 'the pattern'}
        </button>
      </div>

      <p className="timing-dim timing-status" aria-live="polite">
        {status ??
          (!target
            ? 'No drum track in the song: add a track whose rack has a Drum Kit, or a Trigger.'
            : missing
              ? `${missing} lane${missing === 1 ? ' is' : 's are'} on a note no pad of this kit is on, and will not be written.`
              : `Fills ${pattern?.name ?? 'the pattern'} on ${target.name}, round and round to its end.`)}
      </p>
    </div>
  )
}

/** A lane with its numbers inside one another: no more hits than steps, no more accents than hits. */
function tidy(l: LanePrefs): LanePrefs {
  const steps = Math.min(MAX_STEPS, Math.max(1, Math.round(l.steps)))
  const hits = Math.min(steps, Math.max(0, Math.round(l.hits)))
  return {
    ...l,
    steps,
    hits,
    rotate: Math.min(steps - 1, Math.max(0, Math.round(l.rotate))),
    accents: Math.min(hits, Math.max(0, Math.round(l.accents))),
    probability: Math.min(1, Math.max(0, l.probability)),
  }
}
