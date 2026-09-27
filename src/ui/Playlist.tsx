import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import { markersOf, placementAt, playlistBars } from '../song/edit'
import { barTicks, type Song } from '../song/types'
import { nextHue } from './palette'

interface Props {
  song: Song
  /** The pattern the roll is writing into, lit so the two views agree. */
  patternId: string
  onSelectPattern: (id: string) => void
  /** Called on every keystroke, like a track's name; see `PatternName`. */
  onRenamePattern: (id: string, name: string) => void
  /** A hue, or null for none. */
  onColorPattern: (id: string, color: number | null) => void
  /** A new pattern: empty, or a copy of the one named. */
  onAddPattern: (from?: string) => void
  onRemovePattern: (id: string) => void
  onToggle: (patternId: string, tick: number) => void
  /** Slide a placement to start at another bar. */
  onMove: (patternId: string, from: number, to: number) => void
  /** The marker whose section is being looped, or null. */
  section: number | null
  onSection: (tick: number | null) => void
  onAddMarker: (tick: number) => void
  onRenameMarker: (tick: number, name: string) => void
  onRemoveMarker: (tick: number) => void
  transport: Transport
}

/** A placement being slid along its row. */
interface Slide {
  pattern: string
  /** Where the placement started, in ticks, and the bar it was taken hold of by. */
  from: number
  grabBar: number
  /** Where it would start if let go now. */
  to: number
  moved: boolean
}

/**
 * The arrangement: which pattern plays in which bar.
 *
 * A grid rather than free-floating blocks on a timeline. A pattern is already
 * a fixed length, so the only thing a placement can say is where it starts --
 * and a grid of bars says that with one click. A placement can be slid along
 * its row by dragging it, snapping to bars; a click without a drag takes it
 * away, as it always has.
 *
 * Laid out in the DOM rather than on a canvas, unlike the roll. There are
 * dozens of cells here and not hundreds of notes, they want to be buttons
 * that can be tabbed to, and only the playhead moves -- which is one element
 * sliding, not a picture being redrawn.
 */
export function Playlist({
  song,
  patternId,
  onSelectPattern,
  onRenamePattern,
  onColorPattern,
  onAddPattern,
  onRemovePattern,
  onToggle,
  onMove,
  section,
  onSection,
  onAddMarker,
  onRenameMarker,
  onRemoveMarker,
  transport,
}: Props) {
  const bars = playlistBars(song)
  // A bar is as long as the time signature says. Read through a ref by the
  // playhead, which is drawn by a loop set up once.
  const BAR = barTicks(song)
  const barRef = useRef(BAR)
  barRef.current = BAR
  const markers = markersOf(song)
  /** Where the last placement ends, for how far the last section reaches. */
  let songEndTicks = 0
  for (const place of song.playlist) {
    const p = song.patterns.find((x) => x.id === place.pattern)
    if (p) songEndTicks = Math.max(songEndTicks, place.tick + p.length)
  }
  /** The marker being renamed, and what it is being called. */
  const [renaming, setRenaming] = useState<{ tick: number; name: string } | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [slide, setSlideState] = useState<Slide | null>(null)
  /**
   * The same, for the handlers to read. A quick click lands its press and its
   * release before React has re-rendered, so a release reading the state it
   * was rendered with would never see the press at all.
   */
  const slideRef = useRef<Slide | null>(null)
  /**
   * Set when a press on a placement was dealt with on release. The click the
   * browser sends after it arrives once the grid has already re-rendered --
   * on a cell that is now empty, which would put the placement straight back.
   */
  const swallowClick = useRef(false)
  const setSlide = (next: Slide | null) => {
    slideRef.current = next
    setSlideState(next)
  }

  // The playhead is moved by writing to the element, never through state: at
  // thirty frames a second React would re-render the whole grid for it.
  //
  // Where a bar sits is measured off two real cells rather than worked out
  // from the width of the grid, because the grid also holds the column of
  // pattern names down its left -- scaling across the whole of it put the
  // playhead most of a bar early, and on top of the labels at the start.
  //
  // Measured once per layout rather than once per frame: after every render,
  // which is when cells come and go, and whenever the grid changes size.
  // Both are offsets within the grid, so scrolling it does not change them.
  const cellGeometry = useRef<{ left: number; perBar: number } | null>(null)
  const measureCells = useCallback(() => {
    const grid = gridRef.current
    const cells = grid?.querySelectorAll('.playlist-cell')
    if (!grid || !cells || cells.length < 2) {
      cellGeometry.current = null
      return
    }
    const origin = grid.getBoundingClientRect().left
    const first = cells[0].getBoundingClientRect()
    // The gap between cells is a stylesheet's business, so it is read
    // rather than repeated here.
    cellGeometry.current = {
      left: first.left - origin,
      perBar: cells[1].getBoundingClientRect().left - first.left,
    }
  }, [])
  useLayoutEffect(measureCells)
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const watch = new ResizeObserver(measureCells)
    watch.observe(grid)
    return () => watch.disconnect()
  }, [measureCells])

  // The loop runs only while the transport plays. Stopped, the head is hidden
  // once and nothing is drawn until the next Play.
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = 0
      const head = headRef.current
      const state = transport.state
      const at = cellGeometry.current
      if (head) {
        if (!state.playing || !at) {
          head.style.display = 'none'
        } else {
          head.style.display = 'block'
          head.style.transform = `translateX(${at.left + (state.tick / barRef.current) * at.perBar}px)`
        }
      }
      if (state.playing) raf = requestAnimationFrame(draw)
    }
    draw()
    const unsubscribe = transport.subscribe(() => {
      if (!raf) raf = requestAnimationFrame(draw)
    })
    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
    }
  }, [transport])

  /** The bar under a point on the page, read off the cell there. */
  const barAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)
    const cell = el instanceof Element ? el.closest<HTMLElement>('.playlist-cell') : null
    return cell?.dataset.bar !== undefined ? Number(cell.dataset.bar) : null
  }

  return (
    // The list of patterns with its add button underneath, the way the track
    // list has its own: the button stays put while the playlist scrolls.
    <div className="playlist-pane">
      <div className="playlist">
        <div className="playlist-grid" ref={gridRef}>
          <div className="playlist-head" ref={headRef} aria-hidden="true" />

          {/* The sections: a click on an empty bar puts a marker there, a click
              on a marker plays from it and loops its section, and a double-click
              renames it -- or, with the name emptied, is the way to delete it. */}
          <div className="playlist-markers">
            <span className="playlist-label playlist-label-quiet">Sections</span>
            {Array.from({ length: bars }, (_, bar) => {
              const tick = bar * BAR
              const at = markers.findIndex((m) => m.tick >= tick && m.tick < tick + BAR)
              const marker = at >= 0 ? markers[at] : null
              if (!marker) {
                return (
                  <button
                    key={bar}
                    className="playlist-marker-slot"
                    onClick={() => onAddMarker(tick)}
                    aria-label={`Add a section marker at bar ${bar + 1}`}
                    title="Add a section marker here"
                    type="button"
                  />
                )
              }
              // A marker runs until the next one -- or, the last one, to the end
              // of what is arranged -- so its label can use the room without
              // covering the empty bars past the end, where more can be added.
              const next = markers[at + 1]
              const end = Math.ceil(songEndTicks / BAR)
              const span = Math.max(1, Math.min(bars - bar, next ? Math.round((next.tick - marker.tick) / BAR) : end - bar))
              const on = section === marker.tick
              return (
                <span
                  key={bar}
                  className={`playlist-marker-slot has${next ? '' : ' last'}`}
                  style={{ '--span': span } as React.CSSProperties}
                >
                  {renaming?.tick === marker.tick ? (
                    <span className="playlist-marker-edit">
                      <input
                        value={renaming.name}
                        autoFocus
                        aria-label="Section name"
                        spellCheck={false}
                        onChange={(e) => setRenaming({ tick: marker.tick, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => {
                          if (renaming.name.trim()) onRenameMarker(marker.tick, renaming.name.trim())
                          setRenaming(null)
                        }}
                      />
                      <button
                        className="playlist-marker-delete"
                        // Before the input's blur would commit the name.
                        onPointerDown={(e) => {
                          e.preventDefault()
                          setRenaming(null)
                          onRemoveMarker(marker.tick)
                        }}
                        aria-label={`Delete ${marker.name}`}
                        title="Delete this marker"
                        type="button"
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <button
                      className={`playlist-marker${on ? ' on' : ''}`}
                      onClick={() => onSection(on ? null : marker.tick)}
                      onDoubleClick={() => setRenaming({ tick: marker.tick, name: marker.name })}
                      title={on ? 'Looping this section: click to play the whole song' : 'Play from here and loop this section (double-click to rename)'}
                      aria-pressed={on}
                      type="button"
                    >
                      {marker.name}
                    </button>
                  )}
                </span>
              )
            })}
          </div>

          <div className="playlist-ruler">
            <span className="playlist-label" />
            {Array.from({ length: bars }, (_, i) => {
              const inSection =
                section !== null && i * BAR >= section && i * BAR < (markers.find((m) => m.tick > section)?.tick ?? Infinity)
              // A bar number adds a marker there, which is the way to split a
              // section the strip above is already covering.
              const marked = markers.some((m) => m.tick === i * BAR)
              return (
                <button
                  key={i}
                  className={`playlist-bar${i % 4 === 0 ? ' strong' : ''}${inSection ? ' in-section' : ''}`}
                  onClick={() => !marked && onAddMarker(i * BAR)}
                  title={marked ? `Bar ${i + 1}` : `Add a section marker at bar ${i + 1}`}
                  type="button"
                >
                  {i + 1}
                </button>
              )
            })}
          </div>

          {song.patterns.map((pattern) => {
            const sliding = slide?.pattern === pattern.id && slide.moved ? slide : null
            const spanBars = Math.max(1, Math.ceil(pattern.length / BAR))
            return (
              <div
                key={pattern.id}
                className={`playlist-row${pattern.id === patternId ? ' on' : ''}${pattern.color !== undefined ? ' colored' : ''}`}
                style={pattern.color !== undefined ? ({ '--pat-h': pattern.color } as React.CSSProperties) : undefined}
              >
                <div className="playlist-label">
                  {/* The track list's colour chip: a click steps it on round
                      the wheel, and round to none. */}
                  <button
                    className={`swatch${pattern.color === undefined ? ' none' : ''}`}
                    style={pattern.color !== undefined ? ({ '--swatch-h': pattern.color } as React.CSSProperties) : undefined}
                    onClick={() => onColorPattern(pattern.id, nextHue(pattern.color) ?? null)}
                    title="Colour this pattern"
                    aria-label={`Colour ${pattern.name}`}
                    type="button"
                  />
                  <PatternName
                    name={pattern.name}
                    onSelect={() => onSelectPattern(pattern.id)}
                    onRename={(name) => onRenamePattern(pattern.id, name)}
                  />
                  {/* On the row, as a track's remove button is on its own: the
                      pattern they act on is the one they are next to, rather
                      than whichever one the bar happens to have picked. */}
                  <button
                    className="track-remove"
                    onClick={() => onAddPattern(pattern.id)}
                    title="Copy this pattern into a new one"
                    aria-label={`Copy ${pattern.name}`}
                    type="button"
                  >
                    ⧉
                  </button>
                  <button
                    className="track-remove"
                    onClick={() => onRemovePattern(pattern.id)}
                    // There has to be one for the roll to write into.
                    disabled={song.patterns.length <= 1}
                    title="Delete this pattern, and every place it is used in the song"
                    aria-label={`Delete ${pattern.name}`}
                    type="button"
                  >
                    ×
                  </button>
                </div>

                {Array.from({ length: bars }, (_, bar) => {
                  // Where the placement covering this bar begins, if one does. A
                  // pattern longer than a bar fills several cells, and clicking
                  // any of them takes the whole placement away rather than
                  // leaving a block nothing can reach.
                  const start = placementAt(song, pattern.id, bar * BAR)
                  const here = start !== null
                  const isStart = start === bar * BAR
                  // Where the placement in hand would land, drawn over the grid
                  // while it is dragged.
                  const landing =
                    sliding !== null && bar * BAR >= sliding.to && bar < sliding.to / BAR + spanBars
                  const leaving = sliding !== null && start === sliding.from
                  return (
                    <button
                      key={bar}
                      data-bar={bar}
                      className={`playlist-cell${here ? ' filled' : ''}${isStart ? ' start' : ''}${
                        landing ? ' landing' : ''
                      }${leaving ? ' leaving' : ''}`}
                      onPointerDown={(e) => {
                        // A fresh press: whatever the last one left behind is
                        // not about this one.
                        swallowClick.current = false
                        if (!here || e.button !== 0) return
                        e.currentTarget.setPointerCapture(e.pointerId)
                        setSlide({ pattern: pattern.id, from: start, grabBar: bar, to: start, moved: false })
                      }}
                      onPointerMove={(e) => {
                        const slide = slideRef.current
                        if (!slide || slide.pattern !== pattern.id) return
                        const over = barAt(e.clientX, e.clientY)
                        if (over === null) return
                        const to = Math.max(0, slide.from + (over - slide.grabBar) * BAR)
                        if (to !== slide.to || (!slide.moved && over !== slide.grabBar)) {
                          setSlide({ ...slide, to, moved: slide.moved || over !== slide.grabBar })
                        }
                      }}
                      onPointerUp={() => {
                        const slide = slideRef.current
                        if (!slide || slide.pattern !== pattern.id) return
                        setSlide(null)
                        swallowClick.current = true
                        if (slide.moved && slide.to !== slide.from) onMove(pattern.id, slide.from, slide.to)
                        else if (!slide.moved) onToggle(pattern.id, slide.from)
                      }}
                      onPointerCancel={() => setSlide(null)}
                      // An empty cell places the pattern on a click. A filled one
                      // is handled by the pointer above -- except from the
                      // keyboard, where there is no pointer and a click is all
                      // there is.
                      onClick={(e) => {
                        if (swallowClick.current) {
                          swallowClick.current = false
                          return
                        }
                        if (!here || e.detail === 0) onToggle(pattern.id, here ? start : bar * BAR)
                      }}
                      aria-label={`${pattern.name}, bar ${bar + 1}`}
                      aria-pressed={here}
                      title={here ? 'Drag to move, click to remove' : 'Click to place'}
                      type="button"
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <button className="track-add" onClick={() => onAddPattern()} type="button">
        + Pattern
      </button>
    </div>
  )
}

/**
 * A pattern's name, edited where it is shown -- the way a track's is on the
 * track list, rather than behind a rename button on the bar.
 *
 * Focusing it picks the pattern, as clicking a track's name picks the track,
 * so the name you are typing into is always the pattern the roll is on. It
 * cannot be left blank: a pattern with no name is a row nobody can find, so
 * clearing it and walking away puts back the name it had.
 */
function PatternName({
  name,
  onSelect,
  onRename,
}: {
  name: string
  onSelect: () => void
  onRename: (name: string) => void
}) {
  /** What the name was when editing began, for Escape and for a blank. */
  const before = useRef(name)

  return (
    <input
      className="playlist-name"
      value={name}
      spellCheck={false}
      aria-label="Pattern name"
      title="Write into this pattern; type to rename it"
      onFocus={() => {
        before.current = name
        onSelect()
      }}
      onChange={(e) => onRename(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          onRename(before.current)
          // Blurred after the render that puts the old name back, so the
          // blank check below sees the restored name rather than the edit.
          const el = e.currentTarget
          requestAnimationFrame(() => el.blur())
        }
      }}
      onBlur={(e) => {
        const trimmed = e.currentTarget.value.trim()
        if (!trimmed) onRename(before.current)
        else if (trimmed !== e.currentTarget.value) onRename(trimmed)
      }}
    />
  )
}
