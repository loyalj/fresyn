import { useState } from 'react'
import type { NoteTarget } from '../song/bind'
import type { Track } from '../song/types'
import { nextHue } from './palette'

interface Props {
  tracks: readonly Track[]
  selected: string
  /** Which tracks have something a note can be played on. */
  targets: ReadonlyMap<string, NoteTarget>
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onChange: (id: string, change: Partial<Omit<Track, 'id'>>, key?: string) => void
  /**
   * Solo is its own handler because it is not a change to one track: pressing
   * it clears solo everywhere else, which is what makes one button enough.
   */
  onSolo: (id: string) => void
  /** Put the tracks in this order, when a drag by the grip is let go. */
  onReorder: (ids: string[]) => void
}

/**
 * A level as a desk prints it. The slider is linear, which is what a track's
 * gain is, but a mix is balanced in decibels: "6 dB down" is a thing people
 * say, and "0.50" is not.
 */
function decibels(gain: number) {
  if (gain <= 0.0001) return '−∞ dB'
  const db = 20 * Math.log10(gain)
  return `${db > -0.05 ? '0.0' : db.toFixed(1).replace('-', '−')} dB`
}

/**
 * The tracks, down the side of the dock.
 *
 * Selecting one puts its rack on the bench. That is the whole of the
 * relationship between this list and the rack above it: a track is a rack,
 * and the thing you are looking at up there is whichever row is lit down
 * here.
 */
export function TrackList({
  tracks,
  selected,
  targets,
  onSelect,
  onAdd,
  onRemove,
  onChange,
  onSolo,
  onReorder,
}: Props) {
  const soloed = tracks.some((t) => t.solo)
  /** The order while a track is being dragged by its grip, or null. */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const shown = dragOrder
    ? dragOrder.flatMap((id) => tracks.find((t) => t.id === id) ?? [])
    : tracks

  /** Which row a point on the page is over, as an index into what is shown. */
  const rowAt = (y: number, x: number) => {
    const el = document.elementFromPoint(x, y)
    const row = el instanceof Element ? el.closest<HTMLElement>('.track[data-index]') : null
    return row ? Number(row.dataset.index) : null
  }

  return (
    <div className="tracks">
      <div className="tracks-rows">
        {shown.map((track, index) => {
          const target = targets.get(track.id)
          // What a desk shows: a track that is not soloed while something
          // else is reads as dimmed, the same as one that is muted.
          const silent = soloed ? !track.solo : !!track.mute
          return (
            <div
              key={track.id}
              data-index={index}
              className={`track${track.id === selected ? ' on' : ''}${silent ? ' silent' : ''}${
                dragging === track.id ? ' dragging' : ''
              }${track.color !== undefined ? ' colored' : ''}`}
              style={track.color !== undefined ? ({ '--track-h': track.color } as React.CSSProperties) : undefined}
              onPointerDown={() => onSelect(track.id)}
            >
              {/* The grip a track is dragged up and down the list by. The
                  order is only how the list reads -- every track plays either
                  way -- so this is housekeeping, and lives on the edge. */}
              <span
                className="track-grip"
                title="Drag to reorder"
                aria-hidden="true"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDragging(track.id)
                  setDragOrder(tracks.map((t) => t.id))
                }}
                onPointerMove={(e) => {
                  if (dragging !== track.id || !dragOrder) return
                  const over = rowAt(e.clientY, e.clientX)
                  const from = dragOrder.indexOf(track.id)
                  if (over === null || over === from) return
                  const next = dragOrder.filter((id) => id !== track.id)
                  next.splice(over, 0, track.id)
                  setDragOrder(next)
                }}
                onPointerUp={() => {
                  if (dragOrder && dragOrder.some((id, i) => id !== tracks[i]?.id)) onReorder(dragOrder)
                  setDragging(null)
                  setDragOrder(null)
                }}
                onPointerCancel={() => {
                  setDragging(null)
                  setDragOrder(null)
                }}
              >
                ⋮⋮
              </span>
              <button
                className={`swatch${track.color === undefined ? ' none' : ''}`}
                style={track.color !== undefined ? ({ '--swatch-h': track.color } as React.CSSProperties) : undefined}
                onClick={() => onChange(track.id, { color: nextHue(track.color) })}
                title="Colour this track"
                aria-label={`Colour ${track.name}`}
                type="button"
              />
              <input
                className="track-name"
                value={track.name}
                spellCheck={false}
                aria-label="Track name"
                onChange={(e) => onChange(track.id, { name: e.target.value }, `track:${track.id}`)}
                // Selecting on focus as well as on the row, so tabbing into a
                // name puts that rack on the bench rather than renaming a
                // track you cannot see.
                onFocus={() => onSelect(track.id)}
              />

              {/* Said here rather than only on the transport bar, because with
                  several tracks the one that cannot be played is not
                  necessarily the one you are looking at. */}
              {!target && <span className="track-warn" title="No Keyboard or Trigger in this rack">!</span>}
              {target?.kind === 'trigger' && (
                <span className="track-kind" title="No Keyboard: every note fires the Trigger">
                  T
                </span>
              )}

              <input
                className="track-gain"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={track.gain}
                aria-label="Track level"
                title={decibels(track.gain)}
                onChange={(e) =>
                  onChange(track.id, { gain: Number(e.target.value) }, `gain:${track.id}`)
                }
              />
              <span className="track-db">{decibels(track.gain)}</span>

              <button
                className={`track-flag${track.mute ? ' on' : ''}`}
                onClick={() => onChange(track.id, { mute: track.mute ? undefined : true })}
                title="Mute"
                type="button"
              >
                M
              </button>
              <button
                className={`track-flag${track.solo ? ' on' : ''}`}
                onClick={() => onSolo(track.id)}
                title="Solo"
                type="button"
              >
                S
              </button>
              <button
                className="track-remove"
                onClick={() => onRemove(track.id)}
                // The last track is the rack on the bench; there has to be one.
                disabled={tracks.length <= 1}
                title="Remove this track"
                type="button"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      <button className="track-add" onClick={onAdd} type="button">
        + Track
      </button>
    </div>
  )
}
