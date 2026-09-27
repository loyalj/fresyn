import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { Transport } from '../audio/Transport'
import { loadPrefs, savePrefs } from '../patch/storage'
import type { NoteTarget } from '../song/bind'
import {
  contextNotes,
  addMarker,
  firstPlacement,
  movePlacement,
  removeMarker,
  renameMarker,
  setMeter,
  removePattern,
  reorderTracks,
  setPatternLength,
  updatePattern,
  soloTrack,
  togglePlacement,
} from '../song/edit'
import { barTicks, beatTicks, PPQ, type Note, type Song, type Track } from '../song/types'
import { MixView } from './MixView'
import { PianoRoll } from './PianoRoll'
import { Playlist } from './Playlist'
import { TrackList } from './TrackList'

/** Pattern lengths offered, in bars of four. */
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
/** The time signatures offered: the common ones, simple and compound. */
const METERS = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8']

/** What the grid is drawn at when snapping is off. */
const OFF_GRID = PPQ / 4

export const DOCK_MIN_H = 160
export const DOCK_MAX_H = 620

interface Props {
  transport: Transport
  /** The project's name: what Save project and the bounces are called. */
  projectName: string
  onProjectName: (name: string) => void
  song: Song
  onSong: (next: Song) => void
  onNotes: (notes: Note[]) => void
  trackId: string
  onSelectTrack: (id: string) => void
  onAddTrack: () => void
  onRemoveTrack: (id: string) => void
  onTrack: (id: string, change: Partial<Omit<Track, 'id'>>, key?: string) => void
  patternId: string
  onSelectPattern: (id: string) => void
  onAddPattern: (from?: string) => void
  targets: ReadonlyMap<string, NoteTarget>
  view: 'roll' | 'song' | 'mix'
  onView: (view: 'roll' | 'song' | 'mix') => void
  /** An edit to the song, grouped for undo under `key`: the Mix view's knobs. */
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
}

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
/** The pattern menu's last row, which makes one rather than picking one. */
const NEW_PATTERN = '__new'

export function SongDock({
  transport,
  projectName,
  onProjectName,
  song,
  onSong,
  onNotes,
  trackId,
  onSelectTrack,
  onAddTrack,
  onRemoveTrack,
  onTrack,
  patternId,
  onSelectPattern,
  onAddPattern,
  targets,
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
}: Props) {
  const [playing, setPlaying] = useState(transport.state.playing)
  // The grid you last wrote in, if it is still one this dock offers.
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
  const bar = barTicks(song)
  const bars = Math.max(1, Math.round((pattern?.length ?? bar) / bar))
  const target = targets.get(trackId)

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

  // The notes in this pattern, split into the ones this track plays and the
  // ones it does not. A pattern spans tracks, so the rest are drawn behind as
  // a guide -- writing a bass line against a drum part you cannot see is
  // writing it blind. So is whatever the other patterns play over the same
  // bars, which is drawn behind it too, whichever way the roll is playing.
  const mine = pattern?.notes.filter((n) => n.track === trackId) ?? []
  const ghosts = [
    ...(pattern?.notes.filter((n) => n.track !== trackId) ?? []),
    ...(placedAt === null ? [] : contextNotes(song, patternId, placedAt)),
  ]

  const trackHues = useMemo(
    () => new Map(song.tracks.flatMap((t) => (t.color === undefined ? [] : [[t.id, t.color] as const]))),
    [song.tracks],
  )

  const setMine = useCallback((notes: Note[]) => onNotes([...ghosts, ...notes]), [onNotes, ghosts])

  const setBars = useCallback(
    (next: number) => {
      // Notes past the new end are kept rather than cut. The scheduler
      // ignores anything outside the pattern, so shortening is a thing you
      // can take back -- and losing half a part to a mis-click on a dropdown
      // is not a trade anybody would make knowingly.
      onSong(setPatternLength(song, patternId, next * bar))
    },
    [onSong, song, patternId, bar],
  )

  const onGrabResize = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragFrom({ y: e.clientY, height })
    },
    [height],
  )

  const onResize = useCallback(
    (e: React.PointerEvent) => {
      if (!dragFrom) return
      // Upward is taller: the dock is anchored to the bottom of the window.
      onHeight(clamp(dragFrom.height + (dragFrom.y - e.clientY), DOCK_MIN_H, DOCK_MAX_H))
    },
    [dragFrom, onHeight],
  )

  return (
    <div className={`dock${open ? '' : ' dock-closed'}`}>
      {open && (
        <div
          className="dock-grip"
          onPointerDown={onGrabResize}
          onPointerMove={onResize}
          onPointerUp={() => setDragFrom(null)}
          onPointerCancel={() => setDragFrom(null)}
          role="separator"
          aria-label="Resize the dock"
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

          <label className="dock-field">
            <span>Tempo</span>
            <input
              type="number"
              min={20}
              max={300}
              value={Math.round(song.tempo)}
              onChange={(e) => onSong({ ...song, tempo: clamp(Number(e.target.value), 20, 300) })}
            />
          </label>

          {/* Beside the tempo, as it is written on a score. Changing it keeps
              every pattern and placement the same number of bars. */}
          <label className="dock-field" title="Time signature: beats to a bar, and what a beat is">
            <span>Time</span>
            <select
              value={`${song.meter?.beats ?? 4}/${song.meter?.unit ?? 4}`}
              onChange={(e) => {
                const [beats, unit] = e.target.value.split('/').map(Number)
                // Only one of the meters offered; anything else is not a change.
                if (!METERS.includes(e.target.value) || !(beats > 0)) return
                onSong(setMeter(song, { beats, unit: unit === 8 ? 8 : 4 }))
              }}
            >
              {METERS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Which view is showing decides what plays, so the switch sits with
            the transport rather than over the thing it switches. */}
        <div className="dock-group dock-views" role="group" aria-label="View">
          <button
            className={`dock-toggle${view === 'roll' ? ' on' : ''}`}
            onClick={() => onView('roll')}
            type="button"
          >
            Roll
          </button>
          <button
            className={`dock-toggle${view === 'song' ? ' on' : ''}`}
            onClick={() => onView('song')}
            type="button"
          >
            Song
          </button>
          <button
            className={`dock-toggle${view === 'mix' ? ' on' : ''}`}
            onClick={() => onView('mix')}
            title="The song's mixing desk: a channel per track, shared effects, and the master bus"
            type="button"
          >
            Mix
          </button>
        </div>

        {/* Patterns are what the roll edits and what the playlist places, so
            they are on the bar for both; the desk mixes tracks and has no use
            for them. */}
        {view !== 'mix' && (
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
                {BARS.map((b) => (
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
          </div>
        )}

        {/* Said plainly rather than left for the user to work out from
            silence: a rack with no way in is the ordinary state of one that
            is still being built, and the fix is one module. */}
        {/* Said, and fixed in one click, rather than left to be worked out
            from the song playing without it. */}
        {inContext && placedAt === null && (
          <span className="dock-hint">
            Not in the song yet{' '}
            <button
              className="dock-toggle"
              onClick={() => onSong(togglePlacement(song, patternId, 0))}
              type="button"
            >
              Put it at bar 1
            </button>
          </span>
        )}
        {view === 'roll' && !target && (
          <span className="dock-hint">Add a Keyboard or a Trigger to play this rack</span>
        )}
        {view === 'roll' && target?.kind === 'trigger' && (
          <span className="dock-hint">No Keyboard: every note fires the Trigger</span>
        )}

        <button
          className="dock-fold"
          onClick={() => onOpenChange(!open)}
          title={open ? 'Hide the dock' : 'Show the dock'}
          type="button"
        >
          {open ? 'Hide' : 'Music'}
        </button>
      </div>

      {open && (
        <div className="dock-body" style={{ height }}>
          {/* The desk has a strip per track, so the track list would say
              everything twice: it gives the room to the strips. */}
          {view === 'mix' ? (
            <MixView
              song={song}
              onEdit={onEdit}
              onTrack={onTrack}
              onSolo={(id) => onSong(soloTrack(song, id))}
              engine={engine}
            />
          ) : (
          <>
          <TrackList
            tracks={song.tracks}
            selected={trackId}
            targets={targets}
            onSelect={onSelectTrack}
            onAdd={onAddTrack}
            onRemove={onRemoveTrack}
            onChange={onTrack}
            onSolo={(id) => onSong(soloTrack(song, id))}
            onReorder={(ids) => onSong(reorderTracks(song, ids))}
          />

          {view === 'roll' && pattern ? (
            <PianoRoll
              notes={mine}
              ghosts={ghosts}
              track={trackId}
              lengthTicks={pattern.length}
              grid={grid || OFF_GRID}
              bar={bar}
              beat={beatTicks(song)}
              snapOff={grid === 0}
              scale={song.scale}
              trackHues={trackHues}
              onScale={(scale) => {
                const { scale: _, ...rest } = song
                onSong(scale ? { ...song, scale } : rest)
              }}
              playOffset={inContext ? (placedAt ?? Infinity) : 0}
              onChange={setMine}
              transport={transport}
            />
          ) : (
            <Playlist
              song={song}
              patternId={patternId}
              onSelectPattern={onSelectPattern}
              onRenamePattern={(id, name) => onSong(updatePattern(song, id, { name }))}
              onColorPattern={(id, color) => onSong(updatePattern(song, id, { color }))}
              onAddPattern={onAddPattern}
              onRemovePattern={(id) => onSong(removePattern(song, id))}
              onToggle={(id, tick) => onSong(togglePlacement(song, id, tick))}
              onMove={(id, from, to) => onSong(movePlacement(song, id, from, to))}
              section={section}
              onSection={onSection}
              onAddMarker={(tick) => onSong(addMarker(song, tick))}
              onRenameMarker={(tick, name) => onSong(renameMarker(song, tick, name))}
              onRemoveMarker={(tick) => {
                if (section === tick) onSection(null)
                onSong(removeMarker(song, tick))
              }}
              transport={transport}
            />
          )}
          </>
          )}
        </div>
      )}
    </div>
  )
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)
