import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { Transport } from '../audio/Transport'
import type { LiveNotes } from '../input/liveNotes'
import { addRecorded } from '../song/record'
import { loadPrefs, savePrefs } from '../patch/storage'
import type { NoteTarget } from '../song/bind'
import type { Tuning } from '../song/tuning'
import {
  contextNotes,
  firstPlacement,
  setMeter,
  setPatternLength,
  setPatternNotes,
  setPatternSwing,
  updatePattern,
  soloTrack,
} from '../song/edit'
import { barsIn, patternBars } from '../song/timeline'
import {
  PPQ,
  SWING_MAX,
  SWING_MIN,
  SWING_STEPS,
  TEMPO_MAX,
  TEMPO_MIN,
  validMeter,
  type Note,
  type Song,
  type Track,
} from '../song/types'
import { MixView } from './MixView'
import { TrackList } from './TrackList'
import { dockHeightWithin, DOCK_MIN_H, useDockMax } from './useDockMax'

/**
 * The roll and the playlist are not in the page's own script: the dock
 * starts folded, and nothing in them is needed to draw the rack. They are
 * fetched as soon as the dock has first been drawn, behind the rack rather
 * than ahead of it, so that by the time anybody opens the dock they are
 * already here and it opens as quickly as it always did.
 *
 * Held in state rather than behind React.lazy and Suspense. A Suspense
 * boundary that has shown its fallback holds the content back for a few
 * hundred milliseconds when it resolves, so the first open of the dock would
 * have lagged even with both files long since arrived.
 */
interface DockParts {
  PianoRoll: typeof import('./PianoRoll').PianoRoll
  Playlist: typeof import('./Playlist').Playlist
}
let dockParts: DockParts | null = null
let dockLoading: Promise<DockParts> | undefined
const loadDockParts = () =>
  (dockLoading ??= Promise.all([import('./PianoRoll'), import('./Playlist')]).then(
    ([roll, list]) => (dockParts = { PianoRoll: roll.PianoRoll, Playlist: list.Playlist }),
  ))

/** Pattern lengths offered, in bars of whatever meter the pattern sits in. */
const BARS = [1, 2, 4, 8]
/**
 * What a note snaps to, as a fraction of a bar. The triplets are three in the
 * space of two: a quarter-note triplet is a third of a half note. Off keeps a
 * sixteenth grid on screen to line things up by eye and snaps to none of it.
 */
const GRIDS = [
  { label: '1/4', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: '1/4 T', ticks: (PPQ * 2) / 3 },
  { label: '1/8 T', ticks: PPQ / 3 },
  { label: '1/16 T', ticks: PPQ / 6 },
  { label: 'Off', ticks: 0 },
]
/** The time signatures offered: the common ones, simple and compound. Any other is typed on the Time lane. */
const METERS = ['2/2', '3/2', '2/4', '3/4', '4/4', '5/4', '6/4', '6/8', '7/8', '9/8', '12/8', '5/16', '7/16']

/** What the grid is drawn at when snapping is off. */
const OFF_GRID = PPQ / 4

interface Props {
  transport: Transport
  /** Notes being played by hand, for the roll's Rec button. */
  live: LiveNotes
  /** The project's name: what Save project and the bounces are called. */
  projectName: string
  onProjectName: (name: string) => void
  song: Song
  onNotes: (notes: Note[]) => void
  trackId: string
  onSelectTrack: (id: string) => void
  onAddTrack: () => void
  onRemoveTrack: (id: string) => void
  onTrack: (id: string, change: Partial<Omit<Track, 'id'>>, key?: string) => void
  patternId: string
  onSelectPattern: (id: string) => void
  onAddPattern: (from?: string) => void
  /** Delete a pattern and its placements. The app says how to undo it. */
  onRemovePattern: (id: string) => void
  targets: ReadonlyMap<string, NoteTarget>
  /** What the benched track's Keyboard plays, to name the roll's rows by. */
  tuning: Tuning | null
  view: 'roll' | 'song' | 'mix'
  onView: (view: 'roll' | 'song' | 'mix') => void
  /**
   * Every edit the dock makes to the song, as a function of the song as it
   * stands when the edit lands rather than as it stood when the dock last
   * drew -- two edits in one frame would otherwise have the second undo the
   * first.
   *
   * `key` is for continuous controls only: a tempo being stepped, a knob on
   * the desk being turned. Edits under the same key in quick succession
   * fold into one step of undo. A discrete action -- placing a pattern,
   * muting a track, adding a marker -- passes none, and is always its own
   * step, however quickly the next one follows it.
   */
  onEdit: (fn: (song: Song) => Song, key?: string) => void
  /** For the Mix view's meters. */
  engine: AudioEngine
  /** The marker whose section the playlist is looping, or null for the whole song. */
  section: number | null
  onSection: (tick: number | null) => void
  /** What the roll plays: its pattern alone, or the song over that pattern's bars. */
  rollPlays: 'pattern' | 'song'
  onRollPlays: (plays: 'pattern' | 'song') => void
  looping: boolean
  onLooping: (looping: boolean) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  height: number
  onHeight: (height: number) => void
  /** Draw a swung pattern where its notes are heard, rather than on its written grid. */
  showSwing: boolean
}

/** The pattern menu's last row, which makes one rather than picking one. */
const NEW_PATTERN = '__new'

/**
 * The music, docked under the rack.
 *
 * A drawer rather than a screen of its own, and that is the whole reason this
 * went into the app instead of beside it: the panel you are editing stays
 * visible above the pattern that is playing it, so reaching for the filter
 * while the loop runs is one movement rather than a trip through two windows.
 *
 * Two views over the same document. **Roll** writes notes into one pattern,
 * and plays that pattern round and round. **Song** places patterns in bars,
 * and plays the arrangement. The transport does not know which: it is handed
 * a different song in each case, which is a thing it already knew how to do.
 */
export const SongDock = memo(function SongDock({
  transport,
  live,
  projectName,
  onProjectName,
  song,
  onNotes,
  trackId,
  onSelectTrack,
  onAddTrack,
  onRemoveTrack,
  onTrack,
  patternId,
  onSelectPattern,
  onAddPattern,
  onRemovePattern,
  targets,
  tuning,
  view,
  onView,
  onEdit,
  engine,
  rollPlays,
  onRollPlays,
  section,
  onSection,
  looping,
  onLooping,
  open,
  onOpenChange,
  height,
  onHeight,
  showSwing,
}: Props) {
  const [parts, setParts] = useState(dockParts)
  useEffect(() => {
    let live = true
    void loadDockParts().then((loaded) => live && setParts(loaded))
    return () => {
      live = false
    }
  }, [])
  const [playing, setPlaying] = useState(transport.state.playing)
  // The grid you last wrote in, if it is still one this dock offers.
  /** Whether hidden tracks are listed, and given strips, after all. */
  const [showHidden, setShowHiddenState] = useState(() => loadPrefs().showHiddenTracks ?? false)
  const setShowHidden = (show: boolean) => {
    setShowHiddenState(show)
    savePrefs({ showHiddenTracks: show })
  }
  const [grid, setGridState] = useState(() => {
    const saved = loadPrefs().grid
    return GRIDS.some((g) => g.ticks === saved) ? (saved as number) : PPQ / 4
  })
  const setGrid = (ticks: number) => {
    setGridState(ticks)
    savePrefs({ grid: ticks })
  }
  const [dragFrom, setDragFrom] = useState<{ y: number; height: number } | null>(null)

  const pattern = song.patterns.find((p) => p.id === patternId)
  const target = targets.get(trackId)
  // A Drum Kit's rows are its pads, named for what is in them. Two pads on
  // one note are both named: a note there plays both.
  const rowNames = useMemo(
    () =>
      target?.kind === 'kit' && target.pads
        ? new Map([...target.pads].map(([row, hits]) => [row, hits.map((h) => h.name).join(' + ')]))
        : undefined,
    [target],
  )

  // Only the run state reaches React. The playhead moves thirty times a
  // second and is drawn straight to the canvas; putting it through state here
  // would re-render the rack at the same rate.
  useEffect(
    () =>
      transport.subscribe((state) =>
        setPlaying((was) => (was === state.playing ? was : state.playing)),
      ),
    [transport],
  )

  // Where this pattern first sits in the song. It is what the roll loops
  // when it plays the song, and where the rest of the song is read from to
  // draw behind it.
  const placedAt = firstPlacement(song, patternId)
  const inContext = view === 'roll' && rollPlays === 'song'
  // Its bars are the song's where it first sits: see `patternBars`.
  const rollBars = patternBars(song, placedAt)
  const bars = Math.max(1, barsIn(rollBars, pattern?.length ?? rollBars.bar(0).length))

  const show = (next: 'roll' | 'song' | 'mix') => {
    onView(next)
    if (!open) onOpenChange(true)
  }

  // The notes in this pattern, split into the ones this track plays and the
  // ones it does not. A pattern spans tracks, so the rest are drawn behind as
  // a guide -- writing a bass line against a drum part you cannot see is
  // writing it blind. So is whatever the other patterns play over the same
  // bars, which is drawn behind it too, whichever way the roll is playing.
  const mine = pattern?.notes.filter((n) => n.track === trackId) ?? []
  const others = pattern?.notes.filter((n) => n.track !== trackId) ?? []
  // Hidden tracks still play, but are left out of what is drawn behind.
  const hiddenTracks = new Set(song.tracks.filter((t) => t.hidden).map((t) => t.id))
  const ghosts = [
    ...others,
    ...(placedAt === null ? [] : contextNotes(song, patternId, placedAt, showSwing)),
  ].filter((n) => !hiddenTracks.has(n.track))

  const trackHues = useMemo(
    () => new Map(song.tracks.flatMap((t) => (t.color === undefined ? [] : [[t.id, t.color] as const]))),
    [song.tracks],
  )

  // This pattern's other tracks go back in with the edit; the notes of other
  // patterns drawn behind it do not. They belong to their own patterns, and
  // written back here they were copied into this one on every edit.
  const setMine = useCallback((notes: Note[]) => onNotes([...others, ...notes]), [onNotes, others])

  const setBars = useCallback(
    (next: number) => {
      // Notes past the new end are kept rather than cut. The scheduler
      // ignores anything outside the pattern, so shortening is a thing you
      // can take back -- and losing half a part to a mis-click on a dropdown
      // is not a trade anybody would make knowingly.
      onEdit((s) => setPatternLength(s, patternId, patternBars(s, firstPlacement(s, patternId)).bar(next).tick))
    },
    [onEdit, patternId],
  )

  // Dragged within what this window allows, not the most any window does:
  // past it the drawn height stops moving and the handle comes off the hand.
  // Everything of the dock that is not the body -- the bar, which wraps to
  // several rows on a narrow window, and the grip and padding around it --
  // counts against the same share of the window the body does.
  const dockRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState(0)
  useEffect(() => {
    const dock = dockRef.current
    if (!dock) return
    const measure = () => setChrome(dock.offsetHeight - (bodyRef.current?.offsetHeight ?? 0))
    const watch = new ResizeObserver(measure)
    watch.observe(dock)
    return () => watch.disconnect()
  }, [])
  const dockMax = useDockMax(chrome)
  const bodyHeight = dockHeightWithin(height, dockMax)

  const onGrabResize = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragFrom({ y: e.clientY, height: bodyHeight })
    },
    [bodyHeight],
  )

  const onResize = useCallback(
    (e: React.PointerEvent) => {
      if (!dragFrom) return
      // Upward is taller: the dock is anchored to the bottom of the window.
      onHeight(
        clamp(dragFrom.height + (dragFrom.y - e.clientY), Math.min(DOCK_MIN_H, dockMax), dockMax),
      )
    },
    [dragFrom, onHeight, dockMax],
  )

  return (
    <div className={`dock${open ? '' : ' dock-closed'}`} ref={dockRef}>
      {open && (
        <div
          className="dock-grip"
          onPointerDown={onGrabResize}
          onPointerMove={onResize}
          onPointerUp={() => setDragFrom(null)}
          onPointerCancel={() => setDragFrom(null)}
          role="separator"
          aria-label="Resize the Music dock"
        />
      )}

      {/* In groups, each set off from the next, and read left to right the way
          the work goes: which piece, how it plays, what you are looking at,
          and then what you are editing in it. A group that has nothing to do
          with the view on screen is not on the bar at all. */}
      <div className="dock-bar">
        {/* The project is named here rather than up on the masthead because
            this bar is the project: the song, its tracks, its tempo. The rack
            above is one patch, and is named on its track. */}
        <div className="dock-group">
          <input
            className="dock-name"
            value={projectName}
            onChange={(e) => onProjectName(e.target.value)}
            aria-label="Project name"
            title="Project name: what Save project and the bounces are called"
            spellCheck={false}
          />
        </div>

        <div className="dock-group" role="group" aria-label="Transport">
          <button
            className={`dock-play${playing ? ' on' : ''}`}
            onClick={() =>
              transport.toggle(
                inContext && placedAt !== null ? placedAt : view !== 'roll' && section !== null ? section : 0,
              )
            }
            title={
              playing
                ? 'Stop'
                : view !== 'roll'
                  ? 'Play the song'
                  : inContext
                    ? 'Play the song over this pattern'
                    : 'Play the pattern'
            }
            type="button"
          >
            {playing ? '■' : '▶'}
          </button>

          <button
            className={`dock-toggle${looping ? ' on' : ''}`}
            onClick={() => onLooping(!looping)}
            title="Come round again at the end"
            type="button"
          >
            Loop
          </button>

          {/* The tempo and meter the song starts in. Changes along the way
              are on the Song view's Tempo and Time lanes, and the fields
              say so when there are any. */}
          <TempoField
            tempo={song.tempo}
            changes={song.tempos?.length ?? 0}
            onTempo={(tempo) => onEdit((s) => (s.tempo === tempo ? s : { ...s, tempo }), 'tempo')}
          />

          {/* Beside the tempo, as it is written on a score. Changing it keeps
              every pattern and placement the same number of bars -- in a song
              with no changes of meter, where there is only one length of bar
              to keep them in. */}
          <label
            className="dock-field"
            title={
              song.meters?.length
                ? 'Time signature at the start. This song changes meter along the way: see the Time lane in the Song view. Changing this moves only the barlines up to the first change'
                : 'Time signature: beats to a bar, and what a beat is'
            }
          >
            <span>Time</span>
            <select
              value={meterName(song.meter)}
              onChange={(e) => {
                const [beats, unit] = e.target.value.split('/').map(Number)
                // Only one of the meters offered; anything else is not a change.
                if (!METERS.includes(e.target.value) || !(beats > 0)) return
                const m = validMeter(beats, unit)
                if (m) onEdit((s) => setMeter(s, m))
              }}
            >
              {/* One from a file or the Time lane that is not on the list is
                  still shown for what it is. */}
              {(METERS.includes(meterName(song.meter)) ? METERS : [meterName(song.meter), ...METERS]).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {song.meters?.length ? <span className="dock-more" aria-hidden="true">+{song.meters.length}</span> : null}
          </label>
        </div>

        {/* Which view is showing decides what plays, so the switch sits with
            the transport rather than over the thing it switches. Pressed
            while the dock is folded, a view button opens it as well: asking
            for the roll is asking to see it. They never fold it -- that is
            the fold button's job. */}
        <div className="dock-group dock-views" role="group" aria-label="View">
          <button
            className={`dock-toggle${view === 'roll' ? ' on' : ''}`}
            onClick={() => show('roll')}
            type="button"
          >
            Roll
          </button>
          <button
            className={`dock-toggle${view === 'song' ? ' on' : ''}`}
            onClick={() => show('song')}
            type="button"
          >
            Song
          </button>
          <button
            className={`dock-toggle${view === 'mix' ? ' on' : ''}`}
            onClick={() => show('mix')}
            title="The song's mixing desk: a channel per track, shared effects, and the master bus"
            type="button"
          >
            Mix
          </button>
        </div>

        {/* Which pattern the roll writes into, and a new one. Only for the
            roll: the Song view lists its patterns beside the lanes, where
            they are picked, named and added, and the desk has no use for
            them. */}
        {view === 'roll' && (
          <div className="dock-group" role="group" aria-label="Pattern">
            <label className="dock-field">
              <select
                value={patternId}
                aria-label="Pattern"
                onChange={(e) => {
                  if (e.target.value === NEW_PATTERN) onAddPattern()
                  else onSelectPattern(e.target.value)
                }}
              >
                {song.patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {/* The playlist has its own add button, but the roll has no
                    playlist beside it, and starting a new pattern is the
                    first thing done in the roll after finishing one. */}
                <option value={NEW_PATTERN}>New pattern</option>
              </select>
            </label>
          </div>
        )}

        {/* The roll's own settings: what it plays, and how it is ruled. */}
        {view === 'roll' && (
          <div className="dock-group" role="group" aria-label="Roll">
            <span className="dock-field" title="What the play button plays while the roll is showing">
              Plays
            </span>
            <div className="dock-views">
              <button
                className={`dock-toggle${rollPlays === 'pattern' ? ' on' : ''}`}
                onClick={() => onRollPlays('pattern')}
                title="Play this pattern on its own"
                type="button"
              >
                Pattern
              </button>
              <button
                className={`dock-toggle${rollPlays === 'song' ? ' on' : ''}`}
                onClick={() => onRollPlays('song')}
                title="Play the song over the bars where this pattern sits, so you hear what it plays against"
                type="button"
              >
                In song
              </button>
            </div>
            <label className="dock-field">
              <span>Bars</span>
              <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
                {(BARS.includes(bars) ? BARS : [...BARS, bars].sort((a, b) => a - b)).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>

            <label className="dock-field">
              <span>Grid</span>
              <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                {GRIDS.map((g) => (
                  <option key={g.label} value={g.ticks}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            {pattern && (
              <SwingField
                key={patternId}
                amount={pattern.swing?.amount ?? SWING_MIN}
                step={pattern.swing?.step ?? SWING_STEPS[1]}
                // One undo step for a whole drag of the slider, the way a
                // knob is one; the step it swings is a choice of its own.
                onAmount={(amount, step) =>
                  onEdit((s) => setPatternSwing(s, patternId, amount, step), `swing:${patternId}`)
                }
                onStep={(amount, step) => onEdit((s) => setPatternSwing(s, patternId, amount, step))}
              />
            )}
          </div>
        )}

        {/* Said, rather than left to be worked out from the song playing
            without it. Placing it is the playlist's job. */}
        {inContext && placedAt === null && <span className="dock-hint">Not in the song yet</span>}
        {/* Said plainly rather than left for the user to work out from
            silence: a rack with no way in is the ordinary state of one that
            is still being built, and the fix is one module. */}
        {view === 'roll' && !target && (
          <span className="dock-hint">Add a Keyboard or a Trigger to play this rack</span>
        )}
        {view === 'roll' && target?.kind === 'trigger' && (
          <span className="dock-hint">No Keyboard: every note fires the Trigger</span>
        )}
        {view === 'roll' && target?.kind === 'kit' && (
          <span className="dock-hint">
            {target.pads?.size ? 'Drum Kit: each named row plays a pad' : 'Drum Kit: load a pad to play it'}
          </span>
        )}

        <button
          className="dock-fold"
          onClick={() => onOpenChange(!open)}
          title={open ? 'Hide the Music dock (Ctrl+M)' : 'Show the Music dock (Ctrl+M)'}
          type="button"
        >
          {open ? 'Hide' : 'Music'}
        </button>
      </div>

      {open && (
        <div className="dock-body" ref={bodyRef} style={{ height: bodyHeight }}>
          {/* The desk has a strip per track, so the track list would say
              everything twice: it gives the room to the strips. */}
          {view === 'mix' ? (
            <MixView
              song={song}
              onEdit={onEdit}
              onTrack={onTrack}
              onSolo={(id) => onEdit((s) => soloTrack(s, id))}
              engine={engine}
              showHidden={showHidden}
            />
          ) : (
          <>
          {/* Only for the roll, which writes one track at a time and needs to
              say which. The song lists its patterns in that room instead, and
              the desk has a strip per track. */}
          {view === 'roll' && (
          <TrackList
            song={song}
            selected={trackId}
            targets={targets}
            onSelect={onSelectTrack}
            onAdd={onAddTrack}
            onRemove={onRemoveTrack}
            onChange={onTrack}
            onSolo={(id) => onEdit((s) => soloTrack(s, id))}
            onEdit={onEdit}
            showHidden={showHidden}
            onShowHidden={setShowHidden}
          />
          )}

          {parts && (view === 'roll' && pattern ? (
            <parts.PianoRoll
              notes={mine}
              ghosts={ghosts}
              track={trackId}
              lengthTicks={pattern.length}
              grid={grid || OFF_GRID}
              bars={rollBars}
              rowNames={rowNames}
              snapOff={grid === 0}
              scale={song.scale}
              tuning={tuning}
              trackHues={trackHues}
              onScale={(scale) =>
                onEdit((s) => {
                  const { scale: _, ...rest } = s
                  return scale ? { ...s, scale } : rest
                })
              }
              playOffset={inContext ? (placedAt ?? Infinity) : 0}
              onChange={setMine}
              transport={transport}
              live={live}
              onRecord={(note, take) =>
                // Against the pattern as it stands when the note lands, and
                // under the take's key, so a take is one step of undo.
                onEdit((s) => {
                  const p = s.patterns.find((x) => x.id === patternId)
                  return p ? setPatternNotes(s, patternId, addRecorded(p.notes, note)) : s
                }, take)
              }
              swing={showSwing ? pattern.swing : undefined}
            />
          ) : (
            <parts.Playlist
              song={song}
              patternId={patternId}
              onSelectPattern={onSelectPattern}
              // Renamed a keystroke at a time, so folded like a track name is.
              onRenamePattern={(id, name) => onEdit((s) => updatePattern(s, id, { name }), `pattern-name:${id}`)}
              onColorPattern={(id, color) => onEdit((s) => updatePattern(s, id, { color }))}
              onAddPattern={onAddPattern}
              onRemovePattern={onRemovePattern}
              onEdit={(fn) => onEdit(fn)}
              onOpenPattern={(id) => {
                onSelectPattern(id)
                show('roll')
              }}
              section={section}
              onSection={onSection}
              transport={transport}
            />
          ))}
          </>
          )}
        </div>
      )}
    </div>
  )
})

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)

/** A time signature as it is written, and as the menu lists it. */
const meterName = (m: Song['meter']) => `${m?.beats ?? 4}/${m?.unit ?? 4}`

/**
 * The tempo, typed.
 *
 * What is typed is held here until it is finished with -- Enter, or moving
 * away -- and only then clamped and sent. Clamped on every keystroke, as it
 * was, the first digit of 140 was a 1, which is below the floor, which made
 * it 20: the field could not be typed into at all, only stepped. Escape puts
 * back whatever the song says. The same rules as typing into a knob's
 * readout.
 *
 * The arrow keys and the spinner still step it straight away, since a step
 * is never a half-typed number. They go out under one undo key, so a run of
 * them is one step back.
 */
function TempoField({
  tempo,
  changes,
  onTempo,
}: {
  tempo: number
  /** How many times the tempo changes after the start, to say so beside it. */
  changes: number
  onTempo: (tempo: number) => void
}) {
  const shown = String(Math.round(tempo))
  /** The text being typed, or null while the field just shows the tempo. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Set by a key or a spinner click, whose change is a step rather than typing. */
  const stepping = useRef(false)

  const commit = (text: string) => {
    setDraft(null)
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return
    const next = clamp(Math.round(n), TEMPO_MIN, TEMPO_MAX)
    if (next !== Math.round(tempo)) onTempo(next)
  }

  return (
    <label
      className="dock-field"
      title={
        changes
          ? `Tempo at the start. It changes ${changes === 1 ? 'once' : `${changes} times`} along the way: see the Tempo lane in the Song view`
          : 'Tempo, beats per minute'
      }
    >
      <span>Tempo</span>
      <input
        type="number"
        min={TEMPO_MIN}
        max={TEMPO_MAX}
        value={draft ?? shown}
        aria-label="Tempo, beats per minute"
        onPointerDown={() => {
          stepping.current = true
        }}
        onKeyDown={(e) => {
          stepping.current = e.key === 'ArrowUp' || e.key === 'ArrowDown'
          if (e.key === 'Enter') {
            commit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            // Handled here, so the rack's own Escape does not also fire.
            e.stopPropagation()
            setDraft(null)
          }
        }}
        onChange={(e) => {
          const text = e.target.value
          // A step from the arrows or the spinner lands as it is made; typing
          // waits. A click that only put the caret in the field changes
          // nothing, so it never gets here.
          if (stepping.current && draft === null && text !== '') {
            stepping.current = false
            commit(text)
            return
          }
          stepping.current = false
          setDraft(text)
        }}
        onBlur={(e) => {
          if (draft !== null) commit(e.currentTarget.value)
        }}
      />
      {changes ? <span className="dock-more" aria-hidden="true">+{changes}</span> : null}
    </label>
  )
}

/**
 * The pattern's swing: how late every second step lands, and which steps.
 *
 * Shown as the percentage drum machines have always used, with Off for
 * straight rather than 50%, which reads like half of something. Double-click
 * puts it back to straight, as it does for the faders.
 */
function SwingField({
  amount,
  step,
  onAmount,
  onStep,
}: {
  amount: number
  step: number
  onAmount: (amount: number, step: number) => void
  onStep: (amount: number, step: number) => void
}) {
  // Straight is stored as no swing at all, which has no step in it -- so the
  // step picked while it is off is held here until there is a swing to keep
  // it in, rather than snapping back to sixteenths on the first drag.
  const swung = amount > SWING_MIN
  const [chosen, setChosen] = useState(step)
  useEffect(() => {
    if (swung) setChosen(step)
  }, [swung, step])
  const percent = Math.round(amount * 100)
  const said = swung ? `${percent}%` : 'Off'
  return (
    <div
      className="dock-field swing-field"
      title="Swing: pushes every second step late. 50% is straight, 67% a triplet feel, 75% a hard shuffle"
    >
      <span>Swing</span>
      <input
        className="swing-amount"
        type="range"
        min={SWING_MIN * 100}
        max={SWING_MAX * 100}
        step={1}
        value={percent}
        aria-label="Swing"
        aria-valuetext={said === 'Off' ? 'Off, straight' : said}
        onChange={(e) => onAmount(Number(e.target.value) / 100, chosen)}
        onDoubleClick={() => onAmount(SWING_MIN, chosen)}
      />
      <span className="swing-readout">{said}</span>
      {/* "on", so it reads as what is swung rather than as a second Grid. */}
      <span>on</span>
      <select
        value={chosen}
        aria-label="Swing steps"
        title="Which steps are swung"
        onChange={(e) => {
          const next = Number(e.target.value)
          setChosen(next)
          if (swung) onStep(amount, next)
        }}
      >
        <option value={SWING_STEPS[0]}>1/8</option>
        <option value={SWING_STEPS[1]}>1/16</option>
      </select>
    </div>
  )
}
