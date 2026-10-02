import { Fragment, useEffect, useRef, useState } from 'react'
import { loadPrefs, savePrefs, type TimingPrefs } from '../../patch/storage'
import { barsOf, tempoAt } from '../../song/timeline'
import { setAt, TEMPO } from '../../song/timing'
import { TEMPO_MAX, TEMPO_MIN, type Song } from '../../song/types'
import type { UtilityProps } from '../../utilities'
import {
  barSeconds,
  barsToSeconds,
  countBars,
  DIVISIONS,
  FEELS,
  formatDuration,
  formatUnit,
  inUnit,
  noteName,
  noteSeconds,
  parseDuration,
  TapTempo,
  type Signature,
  type TapReading,
  type TimeUnit,
} from '../../utilities/timing'
import { NumberField } from '../NumberField'
import { usePanelKey } from '../UtilityPanel'

/** The note values a time signature can be written in, as the dock offers them. */
const UNITS = [1, 2, 4, 8, 16, 32]

/** A song's shape, for a first go at a budget: the sections most pop songs are built from. */
const TEMPLATE = [
  { name: 'Intro', bars: 8 },
  { name: 'Verse', bars: 16 },
  { name: 'Chorus', bars: 8 },
  { name: 'Verse', bars: 16 },
  { name: 'Chorus', bars: 8 },
  { name: 'Bridge', bars: 8 },
  { name: 'Chorus', bars: 16 },
  { name: 'Outro', bars: 8 },
]

/** The Delay's longest time: a value past this is one its Time knob cannot reach. */
const DELAY_MAX_MS = 2000

/** The song's opening tempo and time signature. */
function songTiming(song: Song) {
  return { bpm: song.tempo, beats: song.meter?.beats ?? 4, unit: song.meter?.unit ?? 4 }
}

function initial(song: Song): TimingPrefs {
  return {
    tab: 'length',
    length: '3:00',
    ...songTiming(song),
    sections: [],
    show: 'ms',
    ...loadPrefs().timing,
  }
}

/**
 * The Timing utility: how much music fits in a length of time, and how long a
 * note is.
 *
 * **Song length** turns a running time into bars at a tempo, and bars back
 * into time, with a budget of sections underneath that adds up against it --
 * so a three-minute song can be planned in the roll before a note is in it.
 * **Note lengths** is every note value at a tempo, straight, dotted and
 * triplet, in the unit a knob wants: milliseconds for a delay, hertz for an
 * LFO's rate, samples for anything counted in them. Click one to copy it.
 * **Tap tempo** finds a tempo from taps -- Space, or clicks -- and can set the
 * song to it, at the start or from a bar, as a step of undo.
 *
 * It starts at the song's tempo and time signature and keeps its own from
 * then on -- a calculator is for trying numbers, not for changing the song --
 * with a button to catch up with the song again. Everything is remembered
 * between visits.
 */
export function TimingUtility({ song, sampleRate, editSong, playhead }: UtilityProps) {
  const [state, setState] = useState<TimingPrefs>(() => initial(song))
  useEffect(() => savePrefs({ timing: state }), [state])
  const set = (change: Partial<TimingPrefs>) => setState((s) => ({ ...s, ...change }))

  const sig: Signature = { beats: state.beats, unit: state.unit }
  const fromSong = songTiming(song)
  const matchesSong = fromSong.bpm === state.bpm && fromSong.beats === state.beats && fromSong.unit === state.unit

  return (
    <div className="timing">
      <div className="timing-tabs" role="tablist" aria-label="Calculator">
        {(
          [
            ['length', 'Song length'],
            ['notes', 'Note lengths'],
            ['tap', 'Tap tempo'],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.tab === tab}
            className={state.tab === tab ? 'on' : ''}
            onClick={(e) => {
              set({ tab })
              // Chosen, the Tap tab has the focus to take Space with at once;
              // after a reload it waits to be clicked into, so Space stays the
              // rack's until then.
              if (tab === 'tap') (e.currentTarget.closest('.utility-panel') as HTMLElement | null)?.focus()
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="timing-row">
        <label className="timing-field">
          <span>Tempo</span>
          <NumberField
            value={state.bpm}
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            step={0.1}
            label="Tempo, quarter notes a minute"
            onChange={(bpm) => set({ bpm })}
          />
        </label>
        <div className="timing-field">
          <span>Time</span>
          <span className="timing-sig">
            <NumberField value={state.beats} min={1} max={32} label="Beats in a bar" onChange={(beats) => set({ beats })} />
            <span aria-hidden="true">/</span>
            <select
              value={state.unit}
              aria-label="Note a beat is"
              onChange={(e) => set({ unit: Number(e.target.value) })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </span>
        </div>
        <button
          type="button"
          className="timing-song"
          disabled={matchesSong}
          title="Take the tempo and time signature the song starts with"
          onClick={() => set(fromSong)}
        >
          Use song's
        </button>
      </div>

      {state.tab === 'length' ? (
        <SongLength state={state} set={set} sig={sig} />
      ) : state.tab === 'notes' ? (
        <NoteLengths state={state} set={set} sig={sig} sampleRate={sampleRate} />
      ) : (
        <TapTab state={state} set={set} sig={sig} song={song} editSong={editSong} playhead={playhead} />
      )}
    </div>
  )
}

interface TabProps {
  state: TimingPrefs
  set: (change: Partial<TimingPrefs>) => void
  sig: Signature
}

function SongLength({ state, set, sig }: TabProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const seconds = parseDuration(state.length)
  const count = seconds ? countBars(seconds, state.bpm, sig) : null
  const bar = barSeconds(state.bpm, sig)
  const beatWord = (n: number) => `${n} beat${n === 1 ? '' : 's'}`

  const commitLength = (text: string) => {
    setDraft(null)
    const s = parseDuration(text)
    if (s) set({ length: formatDuration(s) })
  }

  // The sections, laid end to end.
  let at = 0
  const rows = state.sections.map((section) => {
    const start = at
    const length = barsToSeconds(section.bars, state.bpm, sig)
    at += length
    return { ...section, start, length }
  })
  const totalBars = state.sections.reduce((n, s) => n + s.bars, 0)
  const targetBars = count ? count.bars + (count.extraBeats + count.remainder) / sig.beats : 0
  const leftBars = count ? targetBars - totalBars : 0

  const editSection = (i: number, change: Partial<{ name: string; bars: number }>) =>
    set({ sections: state.sections.map((s, k) => (k === i ? { ...s, ...change } : s)) })

  return (
    <div className="timing-length" role="tabpanel">
      <div className="timing-row">
        <label className="timing-field">
          <span>Length</span>
          <input
            type="text"
            inputMode="decimal"
            className={`timing-duration${draft !== null && !parseDuration(draft) ? ' invalid' : ''}`}
            value={draft ?? state.length}
            aria-label="Length of the song, as minutes:seconds"
            title="3:00, 2:30.5, 180 (seconds), 3m or 2m30s"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLength(e.currentTarget.value)
              else if (e.key === 'Escape' && draft !== null) {
                e.stopPropagation()
                setDraft(null)
              }
            }}
            onBlur={(e) => {
              if (draft !== null) commitLength(e.currentTarget.value)
            }}
          />
        </label>
        <label className="timing-field">
          <span>Bars</span>
          <NumberField
            value={count ? count.bars : 0}
            min={1}
            max={9999}
            label="Bars"
            onChange={(bars) => set({ length: formatDuration(barsToSeconds(bars, state.bpm, sig)) })}
          />
        </label>
      </div>

      {count && (
        <p className="timing-answer" aria-live="polite">
          <strong>
            {count.bars} bar{count.bars === 1 ? '' : 's'}
          </strong>
          {count.extraBeats > 0 || count.remainder > 0 ? (
            <>
              {' '}
              and {beatWord(count.extraBeats)}
              {count.remainder > 0 ? ` and ${Math.round(count.remainder * 100)}% of one` : ''}
            </>
          ) : null}
          <span className="timing-dim">
            {' '}
            · {Number(count.beats.toFixed(2))} beats · a bar is {formatDuration(bar)}
          </span>
          {count.extraBeats > 0 || count.remainder > 0 ? (
            <span className="timing-dim timing-round">
              {count.bars} bars is {formatDuration(barsToSeconds(count.bars, state.bpm, sig))}, {count.bars + 1} is{' '}
              {formatDuration(barsToSeconds(count.bars + 1, state.bpm, sig))}
            </span>
          ) : null}
        </p>
      )}

      <div className="timing-sections">
        <div className="timing-sections-head">
          <h3>Sections</h3>
          <button type="button" onClick={() => set({ sections: [...state.sections, { name: 'Section', bars: 8 }] })}>
            Add
          </button>
          <button type="button" onClick={() => set({ sections: TEMPLATE.map((s) => ({ ...s })) })}>
            Typical song
          </button>
          <button type="button" disabled={state.sections.length === 0} onClick={() => set({ sections: [] })}>
            Clear
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="timing-dim timing-empty">
            Plan the song's parts in bars and see how they add up against its length.
          </p>
        ) : (
          <table className="timing-table timing-plan">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Bars</th>
                <th scope="col">Starts</th>
                <th scope="col">Lasts</th>
                <th scope="col">
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="text"
                      value={row.name}
                      aria-label={`Section ${i + 1} name`}
                      onChange={(e) => editSection(i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <NumberField
                      value={row.bars}
                      min={0}
                      max={999}
                      label={`${row.name} bars`}
                      onChange={(bars) => editSection(i, { bars })}
                    />
                  </td>
                  <td className="timing-num">{formatDuration(row.start)}</td>
                  <td className="timing-num">{formatDuration(row.length)}</td>
                  <td>
                    <button
                      type="button"
                      className="timing-remove"
                      aria-label={`Remove ${row.name}`}
                      onClick={() => set({ sections: state.sections.filter((_, k) => k !== i) })}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="timing-num">{totalBars}</td>
                <td />
                <td className="timing-num">{formatDuration(barsToSeconds(totalBars, state.bpm, sig))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
        {rows.length > 0 && count && (
          <p className={`timing-budget${leftBars < -1e-9 ? ' over' : ''}`} aria-live="polite">
            {Math.abs(leftBars) < 1e-9
              ? `Exactly ${formatDuration(seconds!)}.`
              : leftBars > 0
                ? `${formatBars(leftBars)} to go: ${formatDuration(barsToSeconds(leftBars, state.bpm, sig))} short of ${formatDuration(seconds!)}.`
                : `${formatBars(-leftBars)} over: ${formatDuration(barsToSeconds(-leftBars, state.bpm, sig))} past ${formatDuration(seconds!)}.`}
          </p>
        )}
      </div>
    </div>
  )
}

/** A number of bars that may not be whole, to a quarter of a bar. */
function formatBars(bars: number) {
  const n = Math.round(bars * 4) / 4
  return `${n} bar${n === 1 ? '' : 's'}`
}

function NoteLengths({ state, set, sig, sampleRate }: TabProps & { sampleRate: number }) {
  const unit: TimeUnit = state.show === 'hz' || state.show === 'samples' ? state.show : 'ms'
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(`Copied ${text} (${what})`)
    } catch {
      setCopied(`${what}: ${text}`)
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 2500)
  }

  const suffix = unit === 'ms' ? 'ms' : unit === 'hz' ? 'Hz' : 'samples'
  const cell = (seconds: number, what: string) => {
    const text = formatUnit(inUnit(seconds, unit, sampleRate), unit)
    const long = unit === 'ms' && seconds * 1000 > DELAY_MAX_MS
    return (
      <td className="timing-num">
        <button
          type="button"
          className={`timing-copy${long ? ' long' : ''}`}
          title={`${what}: ${text} ${suffix}${long ? ', longer than the Delay can reach' : ''}. Click to copy.`}
          onClick={() => copy(text, what)}
        >
          {text}
        </button>
      </td>
    )
  }

  return (
    <div className="timing-notes" role="tabpanel">
      <div className="timing-units" role="radiogroup" aria-label="Show lengths as">
        {(
          [
            ['ms', 'ms'],
            ['hz', 'Hz'],
            ['samples', `samples @ ${Math.round(sampleRate / 100) / 10} kHz`],
          ] as const
        ).map(([u, label]) => (
          <button
            key={u}
            type="button"
            role="radio"
            aria-checked={unit === u}
            className={unit === u ? 'on' : ''}
            onClick={() => set({ show: u })}
          >
            {label}
          </button>
        ))}
      </div>
      <table className="timing-table">
        <thead>
          <tr>
            <th scope="col">Note</th>
            {FEELS.map((f) => (
              <th scope="col" key={f}>
                {f === 'straight' ? 'Straight' : f === 'dotted' ? 'Dotted' : 'Triplet'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="timing-bar-row">
            <th scope="row">
              1 bar <span className="timing-dim">{sig.beats}/{sig.unit}</span>
            </th>
            {cell(barSeconds(state.bpm, sig), `1 bar of ${sig.beats}/${sig.unit}`)}
            <td />
            <td />
          </tr>
          {DIVISIONS.map((d) => (
            <tr key={d}>
              <th scope="row">{noteName(d)}</th>
              {FEELS.map((f) => (
                <Fragment key={f}>{cell(noteSeconds(state.bpm, d, f), noteName(d, f))}</Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="timing-dim timing-status" aria-live="polite">
        {copied ?? (unit === 'hz' ? 'A rate in Hz repeats once per note: an LFO set to it lands on the beat.' : 'Click a value to copy it.')}
      </p>
    </div>
  )
}

/** How a reading's steadiness reads: settled enough to trust, or not yet. */
function steadyWord(r: TapReading) {
  if (r.taps < 4) return 'keep going'
  return r.steadiness >= 0.95 ? 'steady' : r.steadiness >= 0.85 ? 'settling' : 'uneven'
}

/**
 * Tap tempo: the tempo a hand taps out, from Space or from the pad, into the
 * panel's tempo -- which both other tabs use -- and, on its own button, into
 * the song.
 *
 * Space is the rack's play key everywhere else, so the panel claims it only
 * while this tab is showing and the panel has the focus (see
 * `useUtilityPanel`); click anywhere in the panel to give it the focus.
 * Taps are timed from the event's own timestamp rather than from when it is
 * handled, so a busy page does not make a steady hand look uneven.
 *
 * Setting the song asks where: from the start, which is the song's opening
 * tempo, or from a bar -- the one the playhead is in, to begin with -- as a
 * tempo change there. A song that already changes tempo keeps its other
 * changes either way, and says so. The tempo set is a whole number: tapping
 * is good to a beat a minute, not to a tenth.
 */
function TapTab({
  state,
  set,
  song,
  editSong,
  playhead,
}: TabProps & Pick<UtilityProps, 'song' | 'editSong' | 'playhead'>) {
  const counter = useRef(new TapTempo())
  const [reading, setReading] = useState<TapReading | null>(null)
  const [beat, setBeat] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const bars = barsOf(song)
  const playheadBar = () => bars.at(Math.max(0, playhead())).index + 1
  const [bar, setBar] = useState(playheadBar)

  const tap = (seconds: number) => {
    const r = counter.current.tap(seconds)
    setBeat((n) => n + 1)
    setDone(null)
    setReading(r)
    if (r) set({ bpm: Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(r.bpm * 10) / 10)) })
  }
  // Space, while the panel has the focus.
  usePanelKey('Space', (e) => {
    if (!e.repeat) tap(e.timeStamp / 1000)
  })

  const bpm = Math.round(state.bpm)
  const changes = song.tempos?.length ?? 0
  const barTick = bars.bar(Math.max(0, bar - 1)).tick
  const atStart = song.tempo
  const atBar = tempoAt(song, barTick)

  const apply = (tick: number, what: string) => {
    editSong((s) => setAt(TEMPO, s, tick, bpm))
    setDone(what)
  }

  return (
    <div className="timing-tap" role="tabpanel" ref={root}>
      <button
        type="button"
        className="timing-pad"
        aria-label="Tap"
        data-beat={beat % 2}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          // The press is the tap, not the click after it; and the panel,
          // rather than the pad, keeps the focus, so Space goes on tapping.
          e.preventDefault()
          ;(root.current?.closest('.utility-panel') as HTMLElement | null)?.focus()
          tap(e.timeStamp / 1000)
        }}
        onClick={(e) => e.preventDefault()}
      >
        Tap
      </button>
      <p className="timing-answer timing-tapped" aria-live="polite">
        {reading ? (
          <>
            <strong>{(Math.round(reading.bpm * 10) / 10).toFixed(1)} BPM</strong>
            <span className="timing-dim">
              {' '}
              · {reading.taps} taps · {steadyWord(reading)}
            </span>
          </>
        ) : (
          <span className="timing-dim">
            Tap in time with Space, while this panel has the focus, or on the pad. A pause of two seconds starts a new
            count.
          </span>
        )}
      </p>
      <div className="timing-row">
        <button
          type="button"
          className="timing-song"
          disabled={!reading}
          onClick={() => {
            counter.current.reset()
            setReading(null)
          }}
        >
          Start again
        </button>
      </div>

      <div className="timing-apply">
        <h3>Set the song to {bpm} BPM</h3>
        <div className="timing-apply-row">
          <button type="button" disabled={atStart === bpm} onClick={() => apply(0, `The song now starts at ${bpm} BPM.`)}>
            From the start
          </button>
          <span className="timing-dim">
            now {Math.round(atStart * 10) / 10}
            {changes > 0 ? ` · its ${changes} later tempo change${changes === 1 ? '' : 's'} stay` : ''}
          </span>
        </div>
        <div className="timing-apply-row">
          <button
            type="button"
            disabled={atBar === bpm}
            onClick={() => apply(barTick, bar <= 1 ? `The song now starts at ${bpm} BPM.` : `${bpm} BPM from bar ${bar}.`)}
          >
            From bar
          </button>
          <NumberField value={bar} min={1} max={9999} label="Bar the tempo changes at" onChange={setBar} />
          <button type="button" className="timing-link" onClick={() => setBar(playheadBar())} title="The bar the playhead is in">
            Playhead
          </button>
          <span className="timing-dim">now {Math.round(atBar * 10) / 10}</span>
        </div>
        <p className="timing-dim timing-status" aria-live="polite">
          {done ? `${done} Ctrl+Z takes it back.` : ''}
        </p>
      </div>
    </div>
  )
}

