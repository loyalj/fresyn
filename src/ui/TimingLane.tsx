import { useRef, useState } from 'react'
import { setMeter } from '../song/edit'
import { barsOf, secondsAt, type Bars } from '../song/timeline'
import { METER, moveAt, removeAt, removeBetween, setAt, TEMPO, valueAt } from '../song/timing'
import { TEMPO_MAX, TEMPO_MIN, validMeter, type Meter, type Song } from '../song/types'
import { ContextMenu, type MenuItem } from './Menu'

interface Props {
  /** Which of the two this lane is: the song's tempo, or its time signature. */
  kind: 'tempo' | 'meter'
  song: Song
  /** How wide the timeline is, in pixels, and how many pixels a tick is. */
  width: number
  ppt: number
  bars: Bars
  /** A tick onto the playlist's snap, or onto the tick with `free`. */
  snap: (tick: number, free: boolean, how?: 'round' | 'floor') => number
  onEdit: (fn: (song: Song) => Song) => void
}

/** How far a press on a change travels before it is a drag and not a click. */
const DRAG_PX = 4
/** How close two changes can be drawn: nearer than this, the later one is left to the curve. */
const MARK_GAP_PX = 8
/** A change's label is about this wide a character, at the lane's size of type. */
const CHAR_PX = 5.5
const LANE_H = 16

/**
 * The time signatures suggested as one is typed. Any will do from 1 to 32
 * beats, of whole notes down to thirty-seconds.
 */
const METERS = ['2/2', '3/2', '2/4', '3/4', '4/4', '5/4', '6/4', '6/8', '7/8', '9/8', '12/8', '5/16', '7/16']

/** A change being dragged: from where, to where it would land. */
interface Drag {
  from: number
  x0: number
  at: number
  moved: boolean
}

/** The value being typed into a change, or into a new one not made yet. */
interface Editing {
  tick: number
  text: string
}

/**
 * One of the playlist's two timing lanes: where the tempo changes, or where
 * the time signature does.
 *
 * The value at the start of the song sits at the left edge, and each change
 * after it where it happens. Click a change to type a new value into it;
 * click empty lane to put a new one there; drag one to move it; right-click
 * for the rest. The one at the start is the song's own tempo or meter: it
 * can be changed but not moved or taken away.
 *
 * A meter change goes on a barline -- the barlines as they would be without
 * it, since a change of meter moves the ones after it. A tempo change goes
 * wherever the playlist's snap says, since it moves no barlines at all.
 */
export function TimingLane({ kind, song, width, ppt, bars, snap, onEdit }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }
  const [editing, setEditing] = useState<Editing | null>(null)
  /**
   * A press on empty lane, waiting for its release to open a new change.
   * Opened on the press, the field would be focused and then lose the focus
   * straight away to the press itself, which takes it when it lands.
   */
  const pressedAt = useRef<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const tempo = kind === 'tempo'
  const what = tempo ? 'tempo' : 'time signature'
  const changes: { tick: number; text: string }[] = tempo
    ? [{ tick: 0, text: bpmText(song.tempo) }, ...(song.tempos ?? []).map((c) => ({ tick: c.tick, text: bpmText(c.bpm) }))]
    : [{ tick: 0, text: meterText(song.meter) }, ...(song.meters ?? []).map((c) => ({ tick: c.tick, text: meterText(c.meter) }))]

  const tickAt = (clientX: number) => (clientX - layerRef.current!.getBoundingClientRect().left) / ppt
  const changeEl = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('.timing-change') : null

  /** Where a change dragged or put down at a tick would go. */
  const place = (tick: number, free: boolean, moving?: number) => {
    if (tempo) return snap(tick, free)
    // Onto the barlines the song would have without the change being moved.
    const without = moving === undefined ? bars : barsOf(removeAt(METER, song, moving))
    return Math.max(0, Math.round(without.snapBar(tick)))
  }

  const valueText = (tick: number) =>
    tempo ? bpmText(valueAt(TEMPO, song, tick)) : meterText(valueAt(METER, song, tick))

  /** Set the value at a tick from what was typed. Anything that is not a value leaves it as it was. */
  const commit = (e: Editing) => {
    setEditing(null)
    if (tempo) {
      const bpm = Number(e.text)
      if (e.text.trim() === '' || !Number.isFinite(bpm)) return
      const v = Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, bpm)) * 100) / 100
      onEdit((s) => setAt(TEMPO, s, e.tick, v))
      return
    }
    const m = parseMeter(e.text)
    if (!m) return
    // The one at the start is the song's own, changed the way the dock's
    // Time menu changes it.
    onEdit((s) => (e.tick <= 0 ? setMeter(s, m) : setAt(METER, s, e.tick, m)))
  }

  const remove = (tick: number) => {
    if (tick > 0) onEdit((s) => (tempo ? removeAt(TEMPO, s, tick) : removeAt(METER, s, tick)))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('input')) return
    const el = changeEl(e.target)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (el) {
      const from = Number(el.dataset.tick)
      setDrag({ from, x0: e.clientX, at: from, moved: false })
      return
    }
    // Empty lane: a new change, typed in before it is made, carrying on at
    // what is in force there until something else is typed.
    setDrag(null)
    pressedAt.current = place(tickAt(e.clientX), e.altKey)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    // The one at the start stays at the start.
    if (!d || d.from === 0) return
    const moved = d.moved || Math.abs(e.clientX - d.x0) > DRAG_PX
    if (!moved) return
    // Never onto the start: that is the song's own value, not a change.
    const at = place(tickAt(e.clientX), e.altKey, d.from)
    if (at <= 0) return
    if (at !== d.at || !d.moved) setDrag({ ...d, at, moved })
  }

  const onPointerUp = () => {
    const at = pressedAt.current
    pressedAt.current = null
    if (at !== null) {
      setEditing({ tick: at, text: valueText(at) })
      return
    }
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    if (d.moved) {
      if (d.at !== d.from) onEdit((s) => (tempo ? moveAt(TEMPO, s, d.from, d.at) : moveAt(METER, s, d.from, d.at)))
      return
    }
    // A click: type into it.
    setEditing({ tick: d.from, text: valueText(d.from) })
  }

  /** Every change in a stretch taken away at once. */
  const clear = (from: number, to: number) =>
    onEdit((s) => (tempo ? removeBetween(TEMPO, s, from, to) : removeBetween(METER, s, from, to)))

  /**
   * The menu's ways to clear many changes at once: a ramp brought in from a
   * file is a hundred steps, and nobody removes those one at a time.
   */
  const clearing = (tick: number): MenuItem[] => {
    const bar = bars.at(tick)
    const all = changes.filter((c) => c.tick > 0)
    const inBar = all.filter((c) => c.tick >= bar.tick && c.tick < bar.tick + bar.length).length
    return [
      {
        kind: 'action',
        label: `Remove the changes in bar ${bar.index + 1}${inBar ? ` (${inBar})` : ''}`,
        disabled: inBar === 0,
        onSelect: () => clear(bar.tick, bar.tick + bar.length),
      },
      {
        kind: 'action',
        label: `Remove every ${what} change${all.length ? ` (${all.length})` : ''}`,
        disabled: all.length === 0,
        onSelect: () => clear(1, Infinity),
      },
    ]
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = changeEl(e.target)
    if (!el) {
      const x = tickAt(e.clientX)
      const at = place(x, false)
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            kind: 'action',
            label: `Change the ${what} here...`,
            onSelect: () => setEditing({ tick: at, text: valueText(at) }),
          },
          { kind: 'separator' },
          ...clearing(x),
        ],
      })
      return
    }
    const tick = Number(el.dataset.tick)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'action', label: `Set ${what}...`, shortcut: 'Click', onSelect: () => setEditing({ tick, text: valueText(tick) }) },
        { kind: 'separator' },
        {
          kind: 'action',
          label: tick > 0 ? `Remove this change` : `The ${what} at the start cannot be removed`,
          shortcut: 'Del',
          disabled: tick <= 0,
          onSelect: () => remove(tick),
        },
        ...clearing(tick),
      ],
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, tick: number) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') setEditing({ tick, text: valueText(tick) })
    else if (e.key === 'Delete' || e.key === 'Backspace') remove(tick)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // A change being typed at a tick that has none yet is drawn as one.
  const listed =
    editing && !changes.some((c) => c.tick === editing.tick)
      ? [...changes, { tick: editing.tick, text: editing.text }].sort((a, b) => a.tick - b.tick)
      : changes

  // Thinned to what there is room for. A change gets its label where the
  // last one's has ended and the next does not start under it -- so a ramp
  // is labelled where it starts from and where it ends up; short of that, a
  // mark with no label; and nearer than a few pixels to the last mark,
  // nothing -- the curve shows it, and zooming in brings it back. The one
  // being typed into or dragged is always drawn. Without this a ramp brought
  // in as a hundred small steps is a hundred labels on top of each other.
  const shown: { tick: number; text: string; mini: boolean }[] = []
  let labelEnd = -Infinity
  let markAt = -Infinity
  for (let i = 0; i < listed.length; i++) {
    const c = listed[i]
    const x = c.tick * ppt
    const next = i + 1 < listed.length ? listed[i + 1].tick * ppt : Infinity
    const room = c.text.length * CHAR_PX + 12
    const held = editing?.tick === c.tick || (drag?.moved && drag.from === c.tick)
    if (held || (x >= labelEnd + 2 && next >= x + room + 2)) {
      shown.push({ ...c, mini: false })
      labelEnd = x + room
      markAt = x
    } else if (x >= markAt + MARK_GAP_PX) {
      shown.push({ ...c, mini: true })
      markAt = x
    }
  }

  // The tempo drawn as a line across the lane, a step at each change, from
  // the slowest to the fastest the song goes -- so the shape of a ramp is
  // there to see however thinly its changes are labelled.
  let curve: string | null = null
  if (tempo && song.tempos?.length) {
    const steps = [{ tick: 0, bpm: song.tempo }, ...song.tempos]
    const low = Math.min(...steps.map((c) => c.bpm))
    const high = Math.max(...steps.map((c) => c.bpm))
    const y = (bpm: number) => (high > low ? LANE_H - 3 - ((bpm - low) / (high - low)) * (LANE_H - 6) : LANE_H / 2)
    const points: string[] = []
    steps.forEach((c, i) => {
      const x = c.tick * ppt
      if (i > 0) points.push(`${x.toFixed(1)},${y(steps[i - 1].bpm).toFixed(1)}`)
      points.push(`${x.toFixed(1)},${y(c.bpm).toFixed(1)}`)
    })
    points.push(`${width.toFixed(1)},${y(steps[steps.length - 1].bpm).toFixed(1)}`)
    curve = points.join(' ')
  }

  return (
    <div className="playlist-timing">
      <span className="playlist-label playlist-label-quiet" title={tempo ? 'Tempo' : 'Time signature'}>
        {tempo ? 'BPM' : 'Time'}
      </span>
      <div
        className={`timing-layer${drag?.moved ? ' dragging' : ''}`}
        ref={layerRef}
        style={{ width }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressedAt.current = null
          setDrag(null)
        }}
        onContextMenu={onContextMenu}
        title={`Click to change the ${what} from here on`}
      >
        {curve && (
          <svg className="timing-curve" width={width} height={LANE_H} aria-hidden="true">
            <polyline points={curve} />
          </svg>
        )}
        {shown.map((c) => {
          const lifted = drag?.moved && drag.from === c.tick
          const left = (lifted ? drag.at : c.tick) * ppt
          const bar = bars.at(c.tick).index + 1
          const beat = c.tick - bars.at(c.tick).tick
          const at = `Bar ${bar}${beat ? ` + ${+(beat / bars.at(c.tick).beat).toFixed(2)} beats` : ''}, ${clock(secondsAt(song, c.tick))}`
          return (
            <div
              key={c.tick}
              data-tick={c.tick}
              className={`timing-change${c.tick === 0 ? ' opening' : ''}${lifted ? ' lifted' : ''}${c.mini ? ' mini' : ''}`}
              style={{ left }}
              role="button"
              tabIndex={0}
              aria-label={`${tempo ? `${c.text} beats per minute` : c.text} from ${at}`}
              title={
                c.tick === 0
                  ? `The song starts at ${tempo ? `${c.text} bpm` : c.text}: click to change it`
                  : `${tempo ? `${c.text} bpm` : c.text} from ${at}: click to change it, drag to move it, right-click for more`
              }
              onKeyDown={(e) => onKeyDown(e, c.tick)}
            >
              {editing?.tick === c.tick ? (
                <input
                  className="timing-edit"
                  value={editing.text}
                  autoFocus
                  inputMode={tempo ? 'decimal' : 'text'}
                  list={tempo ? undefined : 'timing-meters'}
                  aria-label={tempo ? 'Tempo, beats per minute' : 'Time signature, like 3/4 or 7/8'}
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setEditing({ tick: c.tick, text: e.target.value })}
                  onKeyDown={(e) => {
                    // Its keys are its own: Delete deletes a digit, not the change.
                    e.stopPropagation()
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={() => editing && commit(editing)}
                />
              ) : c.mini ? null : (
                <span className="timing-value">{c.text}</span>
              )}
            </div>
          )
        })}
        {!tempo && (
          <datalist id="timing-meters">
            {METERS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** A tempo as it is shown: whole where it is whole, and never more than two places. */
const bpmText = (bpm: number) => String(Math.round(bpm * 100) / 100)

const meterText = (m: Meter | undefined) => `${m?.beats ?? 4}/${m?.unit ?? 4}`

/** "7/8" as a meter, or null for anything that is not one this song can be in. */
export function parseMeter(text: string): Meter | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(text)
  return m ? validMeter(Number(m[1]), Number(m[2])) : null
}

/** Seconds as minutes and seconds to a tenth: 1:04.5. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}
