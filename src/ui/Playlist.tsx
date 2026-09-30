import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import { loadPrefs, savePrefs } from '../patch/storage'
import {
  addClip,
  clipEnd,
  clipLength,
  duplicateClips,
  laneOf,
  lanesUsed,
  MAX_LANE,
  moveClips,
  removeClips,
  splitClip,
  trimClip,
} from '../song/clip'
import { playlistBars } from '../song/edit'
import {
  clearTime,
  copyTime,
  deleteTime,
  duplicateTime,
  insertTime,
  pasteTime,
  type TickRange,
  type TimeClip,
} from '../song/range'
import { addSection, sectionAt, sectionOver, sectionsOf, splitSection } from '../song/section'
import { clipHits, clipRepeats } from '../song/schedule'
import { barsIn, barsOf, type Snap } from '../song/timeline'
import { barTicks, beatTicks, type Pattern, type Placement, type Song } from '../song/types'
import { NameField } from './NameField'
import { SectionStrip } from './SectionStrip'
import { TimingLane } from './TimingLane'
import { nextHue } from './palette'

interface Props {
  song: Song
  /** The pattern the roll is writing into, and the one a click paints. */
  patternId: string
  onSelectPattern: (id: string) => void
  /** Called on every keystroke, like a track's name; see `PatternName`. */
  onRenamePattern: (id: string, name: string) => void
  /** A hue, or null for none. */
  onColorPattern: (id: string, color: number | null) => void
  /** A new pattern: empty, or a copy of the one named. */
  onAddPattern: (from?: string) => void
  onRemovePattern: (id: string) => void
  /** Every change to the clips, as an edit of the song as it stands. */
  onEdit: (fn: (song: Song) => Song) => void
  /** Open a pattern in the roll: a double-click on one of its clips. */
  onOpenPattern: (id: string) => void
  /** The section being looped, by the tick it starts on, or null. */
  section: number | null
  onSection: (tick: number | null) => void
  transport: Transport
}

type SnapName = 'bar' | 'beat' | 'half' | 'quarter' | 'off'
/** A snap as a share of the beat of the bar it lands in. */
const BEAT_SHARE: Record<SnapName, number> = { bar: 0, beat: 1, half: 1 / 2, quarter: 1 / 4, off: 0 }
const SNAPS: { id: SnapName; label: string }[] = [
  { id: 'bar', label: 'Bar' },
  { id: 'beat', label: 'Beat' },
  { id: 'half', label: '½ beat' },
  { id: 'quarter', label: '¼ beat' },
  { id: 'off', label: 'Off' },
]

/** A lane's height, in pixels. Matches `--lane-h` in the stylesheet. */
const LANE_H = 24
/** The width of a bar, in pixels, as far as zoom goes each way. */
const ZOOM_MIN = 12
const ZOOM_MAX = 480
/** Lanes shown past the last one used, so there is always an empty one to paint in. */
const SPARE_LANES = 2
const MIN_LANES = 4

/**
 * A stretch of the song copied or cut, for pasting. The session's, like the
 * roll's clipboard, so bars copied in one project paste into the next.
 */
let timeClip: TimeClip | null = null

/** How far the pointer goes along the ruler before a press is a drag, in pixels. */
const RANGE_DRAG_PX = 4

/** A pointer on the timeline, in ticks across and lanes down. */
interface Point {
  tick: number
  lane: number
}

/** What a press on the playlist is doing until it lets go. */
type Drag =
  /** A new clip of the chosen pattern, placed where it is let go. */
  | { kind: 'paint'; pattern: string; start: number; x0: number; tick: number; lane: number }
  /**
   * The picked clips moving together, or copies of them with Shift. `toggle`
   * is a clip Shift+clicked while already picked: let go without moving, it
   * leaves the selection.
   */
  | {
      kind: 'move'
      indices: number[]
      grab: number
      x0: number
      lane0: number
      dt: number
      dl: number
      copy: boolean
      moved: boolean
      toggle: number | null
    }
  | { kind: 'trim'; index: number; edge: 'start' | 'end'; at: number }
  /** A right-button sweep: every clip it passes over is deleted on release. */
  | { kind: 'erase'; hit: number[] }
  /** Ctrl+drag on empty lanes: a box that picks every clip it touches. */
  | { kind: 'marquee'; from: Point; to: Point; base: number[] }

/**
 * The arrangement: clips of patterns, anywhere, in any lane.
 *
 * Patterns are listed on the left. The one lit there is the one the roll is
 * writing into and the one a click on an empty lane paints. A clip is
 * dragged by its body to move it, by an edge to trim it, split with a
 * Ctrl+click and deleted with the right button -- the way FL's playlist has
 * taught a generation of people to arrange. Snap is to the bar unless asked
 * otherwise, and Alt held while dragging lets go of it.
 *
 * Every drag is drawn by applying the edit it would make to the song and
 * drawing that, rather than by drawing a guess at it. What is on screen while
 * the button is down is exactly what letting go will do, because it is the
 * same function.
 *
 * Laid out in the DOM rather than on a canvas, unlike the roll. There are
 * dozens of clips here and not thousands of notes, and only the playhead
 * moves -- which is one element sliding, not a picture being redrawn.
 */
export function Playlist({
  song,
  patternId,
  onSelectPattern,
  onRenamePattern,
  onColorPattern,
  onAddPattern,
  onRemovePattern,
  onEdit,
  onOpenPattern,
  section,
  onSection,
  transport,
}: Props) {
  // The song's bars, however its meter changes. The zoom is a width for the
  // song's first bar, and every other bar is as wide as its ticks make it.
  const grid = barsOf(song)
  const BAR = barTicks(song)
  const [snapName, setSnapNameState] = useState<SnapName>(() => loadPrefs().playlistSnap ?? 'bar')
  const setSnapName = (next: SnapName) => {
    setSnapNameState(next)
    savePrefs({ playlistSnap: next })
  }
  const [barPx, setBarPxState] = useState(() => clamp(loadPrefs().playlistZoom ?? 64, ZOOM_MIN, ZOOM_MAX))
  const setBarPx = (next: number) => {
    const px = clamp(Math.round(next), ZOOM_MIN, ZOOM_MAX)
    setBarPxState(px)
    savePrefs({ playlistZoom: px })
  }
  const ppt = barPx / BAR
  // Read by the playhead, which is drawn by a loop set up once.
  const pptRef = useRef(ppt)
  pptRef.current = ppt

  const looped = section === null ? null : sectionAt(song, section)

  const scrollRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

  const [picked, setPicked] = useState<number[]>([])
  /**
   * The bars chosen by dragging along the ruler, across every lane: what the
   * range buttons and keys act on. Independent of the clips picked.
   */
  const [range, setRange] = useState<TickRange | null>(null)
  const [hasTimeClip, setHasTimeClip] = useState(timeClip !== null)
  /** A drag along the ruler, from where it was pressed. */
  const rangeDrag = useRef<{ anchor: number; x0: number; moved: boolean } | null>(null)
  /** Set when a ruler drag ends, so the click that follows is not a bar click too. */
  const swallowClick = useRef(false)
  // An undo can take clips away from under a selection; what is left of it
  // is what counts.
  const selected = picked.filter((i) => i < song.playlist.length)

  const [drag, setDragState] = useState<Drag | null>(null)
  /**
   * The same, for the handlers to read. A quick click lands its press and its
   * release before React has re-rendered, so a release reading the state it
   * was rendered with would never see the press at all.
   */
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }

  /** The song as it would be if the drag in hand let go now. */
  const view = useMemo(() => {
    if (!drag) return song
    switch (drag.kind) {
      case 'paint':
        return addClip(song, drag.pattern, drag.tick, drag.lane)
      case 'move':
        return drag.copy
          ? duplicateClips(song, drag.indices, drag.dt, drag.dl)
          : moveClips(song, drag.indices, drag.dt, drag.dl)
      case 'trim':
        return trimClip(song, drag.index, drag.edge, drag.at)
      default:
        return song
    }
  }, [song, drag])

  /** Which clips are drawn picked: the copies, while they are being made. */
  const shownPicked = useMemo(() => {
    if (drag?.kind === 'move' && drag.copy && drag.moved) {
      return new Set(drag.indices.map((_, k) => song.playlist.length + k))
    }
    if (drag?.kind === 'paint') return new Set([song.playlist.length])
    return new Set(selected)
  }, [drag, selected, song.playlist.length])
  const erasing = new Set(drag?.kind === 'erase' ? drag.hit : [])

  // Wide enough to fill the pane, whatever is arranged.
  const [paneWidth, setPaneWidth] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const watch = new ResizeObserver(() => setPaneWidth(el.clientWidth))
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const barCount = Math.max(playlistBars(view), barsIn(grid, Math.ceil(paneWidth / ppt)))
  const span = grid.bar(barCount).tick
  const lanes = Math.max(MIN_LANES, lanesUsed(view) + SPARE_LANES)

  // A zoom from the wheel keeps the tick under the pointer where it was,
  // which means scrolling once the new width has been laid out.
  const zoomAnchor = useRef<{ tick: number; x: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const scroller = scrollRef.current
    const layer = layerRef.current
    if (!anchor || !scroller || !layer) return
    zoomAnchor.current = null
    const left = layer.getBoundingClientRect().left + anchor.tick * ppt
    scroller.scrollLeft += left - anchor.x
  }, [ppt])

  // The playhead is moved by writing to the element, never through state: at
  // thirty frames a second React would re-render every clip for it. The loop
  // runs only while the transport plays.
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = 0
      const head = headRef.current
      const state = transport.state
      if (head) {
        if (!state.playing) {
          head.style.display = 'none'
        } else {
          head.style.display = 'block'
          head.style.transform = `translateX(${state.tick * pptRef.current}px)`
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

  const pointAt = (e: { clientX: number; clientY: number }): Point => {
    const r = layerRef.current!.getBoundingClientRect()
    return { tick: (e.clientX - r.left) / ppt, lane: Math.floor((e.clientY - r.top) / LANE_H) }
  }
  /**
   * A tick on the snap, or on the tick with Alt held or snap off. Never before
   * the start. A bar is the bar the tick is in, and a beat is counted from
   * the start of that bar, so snapping follows the meter wherever it changes.
   */
  const snapTo = (name: SnapName, tick: number, how: Snap) => {
    if (name === 'off') return Math.max(0, Math.round(tick))
    const t = name === 'bar' ? grid.snapBar(tick, how) : grid.snapIn(tick, grid.at(tick).beat * BEAT_SHARE[name], how)
    return Math.max(0, Math.round(t))
  }
  const snap = (tick: number, free: boolean, how: 'round' | 'floor' = 'round') => snapTo(free ? 'off' : snapName, tick, how)
  /** The snap, or beats while it is off: what a range and the arrow keys step in. */
  const step = (tick: number, how: Snap) => snapTo(snapName === 'off' ? 'beat' : snapName, tick, how)
  const clipUnder = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)
    const clip = el instanceof Element ? el.closest<HTMLElement>('.playlist-clip') : null
    return clip?.dataset.index !== undefined ? Number(clip.dataset.index) : null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return
    claimKeyboard(scrollRef.current)
    const target = e.target instanceof Element ? e.target : null
    const clipEl = target?.closest<HTMLElement>('.playlist-clip')
    const index = clipEl ? Number(clipEl.dataset.index) : null
    const edge = target?.closest<HTMLElement>('.playlist-clip-edge')?.dataset.edge as 'start' | 'end' | undefined
    const p = pointAt(e)
    const ctrl = e.ctrlKey || e.metaKey
    e.currentTarget.setPointerCapture(e.pointerId)
    // Working on clips lets go of the bars chosen on the ruler.
    setRange(null)

    if (e.button === 2) {
      setDrag({ kind: 'erase', hit: index === null ? [] : [index] })
      return
    }

    if (index === null) {
      if (ctrl) {
        const base = e.shiftKey ? selected : []
        setPicked(base)
        setDrag({ kind: 'marquee', from: p, to: p, base })
        return
      }
      setPicked([])
      const tick = snap(p.tick, e.altKey, 'floor')
      setDrag({ kind: 'paint', pattern: patternId, start: tick, x0: p.tick, tick, lane: clamp(p.lane, 0, MAX_LANE) })
      return
    }

    const place = song.playlist[index]
    if (!place) return
    // A clip touched is its pattern chosen: the next click paints it, and the
    // roll is writing into it.
    if (place.pattern !== patternId) onSelectPattern(place.pattern)
    const pattern = song.patterns.find((x) => x.id === place.pattern)

    if (ctrl && pattern) {
      // Split where the pointer is, on the snap -- unless the snap would put
      // the cut on the clip's own edge, which would cut nothing.
      const stop = clipEnd(place, pattern)
      let at = snap(p.tick, e.altKey)
      if (at <= place.tick || at >= stop) at = Math.round(p.tick)
      onEdit((s) => splitClip(s, index, at))
      setPicked([])
      e.currentTarget.releasePointerCapture(e.pointerId)
      return
    }

    if (edge && pattern) {
      setPicked([index])
      setDrag({ kind: 'trim', index, edge, at: edge === 'start' ? place.tick : clipEnd(place, pattern) })
      return
    }

    const already = selected.includes(index)
    const indices = already ? selected : e.shiftKey ? [...selected, index] : [index]
    setPicked(indices)
    setDrag({
      kind: 'move',
      indices,
      grab: place.tick,
      x0: p.tick,
      lane0: p.lane,
      dt: 0,
      dl: 0,
      copy: e.shiftKey,
      moved: false,
      toggle: e.shiftKey && already ? index : null,
    })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const p = pointAt(e)
    switch (d.kind) {
      case 'paint': {
        const tick = snap(d.start + p.tick - d.x0, e.altKey)
        const lane = clamp(p.lane, 0, MAX_LANE)
        if (tick !== d.tick || lane !== d.lane) setDrag({ ...d, tick, lane })
        break
      }
      case 'move': {
        const dt = snap(d.grab + p.tick - d.x0, e.altKey) - d.grab
        const dl = p.lane - d.lane0
        if (dt !== d.dt || dl !== d.dl) setDrag({ ...d, dt, dl, moved: d.moved || dt !== 0 || dl !== 0 })
        break
      }
      case 'trim': {
        const at = snap(p.tick, e.altKey)
        if (at !== d.at) setDrag({ ...d, at })
        break
      }
      case 'erase': {
        const i = clipUnder(e.clientX, e.clientY)
        if (i !== null && !d.hit.includes(i)) setDrag({ ...d, hit: [...d.hit, i] })
        break
      }
      case 'marquee': {
        const t0 = Math.min(d.from.tick, p.tick)
        const t1 = Math.max(d.from.tick, p.tick)
        const l0 = Math.min(d.from.lane, p.lane)
        const l1 = Math.max(d.from.lane, p.lane)
        const hits: number[] = []
        song.playlist.forEach((place, i) => {
          const pattern = song.patterns.find((x) => x.id === place.pattern)
          if (!pattern) return
          const lane = laneOf(place)
          if (lane < l0 || lane > l1) return
          if (place.tick > t1 || clipEnd(place, pattern) < t0) return
          hits.push(i)
        })
        setPicked([...new Set([...d.base, ...hits])])
        setDrag({ ...d, to: p })
        break
      }
    }
  }

  const onPointerUp = () => {
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    const count = song.playlist.length
    switch (d.kind) {
      case 'paint':
        onEdit((s) => addClip(s, d.pattern, d.tick, d.lane))
        setPicked([count])
        break
      case 'move':
        if (!d.moved) {
          if (d.toggle !== null) setPicked(d.indices.filter((i) => i !== d.toggle))
        } else if (d.copy) {
          onEdit((s) => duplicateClips(s, d.indices, d.dt, d.dl))
          setPicked(d.indices.map((_, k) => count + k))
        } else {
          onEdit((s) => moveClips(s, d.indices, d.dt, d.dl))
        }
        break
      case 'trim':
        onEdit((s) => trimClip(s, d.index, d.edge, d.at))
        break
      case 'erase':
        if (d.hit.length) {
          onEdit((s) => removeClips(s, d.hit))
          setPicked([])
        }
        break
      case 'marquee':
        break
    }
  }

  /** The bars under a stretch of the ruler, out to whole snap steps either way. */
  const rangeOver = (a: number, b: number): TickRange => {
    const from = step(Math.min(a, b), 'floor')
    const to = step(Math.max(a, b), 'ceil')
    return { from, to: to > from ? to : step(from + 1, 'ceil') }
  }
  const onRulerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A drag that ended without a click after it leaves nothing to swallow.
    swallowClick.current = false
    if (e.button !== 0) return
    const tick = pointAt(e).tick
    // Shift stretches the range there is out to the press.
    const anchor = e.shiftKey && range ? (tick < range.from ? range.to : range.from) : tick
    rangeDrag.current = { anchor, x0: e.clientX, moved: e.shiftKey }
    if (e.shiftKey) {
      setRange(rangeOver(anchor, tick))
      setPicked([])
    }
  }
  const onRulerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = rangeDrag.current
    if (!d) return
    // Let go somewhere else before it was a drag: nothing is held any more.
    if (e.buttons === 0) {
      rangeDrag.current = null
      return
    }
    if (!d.moved && Math.abs(e.clientX - d.x0) < RANGE_DRAG_PX) return
    // Held only once it is a drag: taken on the press, it would take the
    // click from the bar number too.
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId)
    // Picking bars lets go of any clips picked, so the keys act on the bars.
    if (!d.moved) setPicked([])
    d.moved = true
    setRange(rangeOver(d.anchor, pointAt(e).tick))
  }
  const onRulerUp = () => {
    const d = rangeDrag.current
    rangeDrag.current = null
    if (d?.moved) {
      swallowClick.current = true
      claimKeyboard(scrollRef.current)
    }
  }

  /** The range buttons' and keys' edits. Each keeps the range on what it made. */
  const rangeLen = range ? range.to - range.from : 0
  const rangeActions = {
    insert: () => range && onEdit((s) => insertTime(s, range.from, rangeLen)),
    remove: () => {
      if (!range) return
      onEdit((s) => deleteTime(s, range))
      setRange(null)
    },
    clear: () => range && onEdit((s) => clearTime(s, range)),
    duplicate: () => {
      if (!range) return
      onEdit((s) => duplicateTime(s, range))
      setRange({ from: range.to, to: range.to + rangeLen })
    },
    copy: () => {
      if (!range) return
      timeClip = copyTime(song, range)
      setHasTimeClip(timeClip !== null)
    },
    cut: () => {
      if (!range) return
      timeClip = copyTime(song, range)
      setHasTimeClip(timeClip !== null)
      onEdit((s) => deleteTime(s, range))
      setRange(null)
    },
    paste: () => {
      const clip = timeClip
      if (!range || !clip) return
      onEdit((s) => pasteTime(s, range.from, clip))
      setRange({ from: range.from, to: range.from + clip.length })
    },
  }
  const barOf = (tick: number) => grid.at(tick).index + 1
  const onBarline = (tick: number) => grid.at(tick).tick === tick
  const rangeName = range
    ? onBarline(range.from) && onBarline(range.to)
      ? barOf(range.from) === barOf(range.to - 1)
        ? `Bar ${barOf(range.from)}`
        : `Bars ${barOf(range.from)}–${barOf(range.to - 1)}`
      : `${+(rangeLen / grid.at(range.from).beat).toFixed(2)} beats from bar ${barOf(range.from)}`
    : ''

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into a marker's name are the name's.
    if (e.target !== e.currentTarget || dragRef.current) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key
    let handled = true
    if (ctrl && key.toLowerCase() === 'a') {
      setPicked(song.playlist.map((_, i) => i))
    } else if (key === 'Escape') {
      if (!selected.length && range) setRange(null)
      setPicked([])
      handled = false
    } else if (!selected.length && range) {
      // With no clips picked, the keys act on the bars chosen on the ruler.
      const k = key.toLowerCase()
      if (key === 'Delete' || key === 'Backspace') {
        if (ctrl) rangeActions.remove()
        else rangeActions.clear()
      } else if (key === 'Insert') rangeActions.insert()
      else if (ctrl && k === 'd') rangeActions.duplicate()
      else if (ctrl && k === 'c') rangeActions.copy()
      else if (ctrl && k === 'x') rangeActions.cut()
      else if (ctrl && k === 'v') rangeActions.paste()
      else handled = false
    } else if (!selected.length) {
      handled = false
    } else if (key === 'Delete' || key === 'Backspace') {
      onEdit((s) => removeClips(s, selected))
      setPicked([])
    } else if (ctrl && key.toLowerCase() === 'd') {
      // Copies straight after the selection, as a block: a four-bar phrase
      // duplicated is the same phrase again, starting where it ended.
      let from = Infinity
      let to = 0
      for (const i of selected) {
        const place = song.playlist[i]
        const pattern = song.patterns.find((x) => x.id === place.pattern)
        if (!pattern) continue
        from = Math.min(from, place.tick)
        to = Math.max(to, clipEnd(place, pattern))
      }
      if (to > from) {
        const count = song.playlist.length
        onEdit((s) => duplicateClips(s, selected, to - from, 0))
        setPicked(selected.map((_, k) => count + k))
      }
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      // A snap step from where the earliest of them starts, in the meter
      // there: a bar of 3/4 is three beats, and the next one may be four.
      const first = Math.min(...selected.map((i) => song.playlist[i].tick))
      const to = key === 'ArrowLeft' ? step(first - 1, 'floor') : step(first + 1, 'ceil')
      if (to !== first) onEdit((s) => moveClips(s, selected, to - first, 0))
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      onEdit((s) => moveClips(s, selected, 0, key === 'ArrowUp' ? -1 : 1))
    } else {
      handled = false
    }
    if (handled) e.preventDefault()
  }

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Ctrl+wheel zooms. The page's own zoom on the same gesture is stopped
    // by the input layer, for the whole app.
    if (!(e.ctrlKey || e.metaKey) || !layerRef.current) return
    const next = clamp(Math.round(barPx * (e.deltaY < 0 ? 1.2 : 1 / 1.2)), ZOOM_MIN, ZOOM_MAX)
    if (next === barPx) return
    zoomAnchor.current = { tick: pointAt(e).tick, x: e.clientX }
    setBarPx(next)
  }

  const patterns = useMemo(() => new Map(view.patterns.map((p) => [p.id, p])), [view.patterns])
  const marquee = drag?.kind === 'marquee' ? drag : null
  // At a small zoom only every so many bar numbers fit.
  const numberEvery = barPx >= 28 ? 1 : barPx >= 16 ? 2 : 4
  const rulerBars = grid.between(0, span)
  // Each stretch of one meter draws its own bar and beat lines.
  const meterBands = grid.segments
    .filter((m) => m.tick < span)
    .map((m) => ({ ...m, end: Math.min(m.end, span) }))

  return (
    <div className="playlist-pane">
      {/* The patterns, with their add button underneath, the way the track
          list has its own. The one lit is the one a click paints. */}
      <div className="playlist-patterns">
        <div className="playlist-patterns-list" role="list" aria-label="Patterns">
          {song.patterns.map((pattern) => (
            <div
              key={pattern.id}
              role="listitem"
              className={`playlist-pattern${pattern.id === patternId ? ' on' : ''}`}
            >
              {/* The track list's colour chip: a click steps it on round the
                  wheel, and round to none. */}
              <button
                className={`swatch${pattern.color === undefined ? ' none' : ''}`}
                style={pattern.color !== undefined ? ({ '--swatch-h': pattern.color } as React.CSSProperties) : undefined}
                onClick={() => onColorPattern(pattern.id, nextHue(pattern.color) ?? null)}
                title="Colour this pattern"
                aria-label={`Colour ${pattern.name}`}
                type="button"
              />
              <NameField
                className="playlist-name"
                value={pattern.name}
                label="Pattern name"
                title="Paint with this pattern and write into it; double-click to rename it"
                onSelect={() => onSelectPattern(pattern.id)}
                onRename={(name) => onRenamePattern(pattern.id, name)}
              />
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
                title="Delete this pattern, and every clip of it in the song"
                aria-label={`Delete ${pattern.name}`}
                type="button"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="track-add" onClick={() => onAddPattern()} type="button">
          + Pattern
        </button>
      </div>

      <div className="playlist-main">
        <div className="playlist-tools">
          <label className="playlist-snap">
            Snap
            <select value={snapName} onChange={(e) => setSnapName(e.target.value as SnapName)} aria-label="Playlist snap">
              {SNAPS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button className="playlist-zoom" onClick={() => setBarPx(barPx / 1.5)} title="Zoom out (Ctrl+wheel)" aria-label="Zoom out" type="button">
            −
          </button>
          <button className="playlist-zoom" onClick={() => setBarPx(barPx * 1.5)} title="Zoom in (Ctrl+wheel)" aria-label="Zoom in" type="button">
            +
          </button>
          {range && (
            <div className="playlist-range-tools" role="group" aria-label="Range">
              <span className="playlist-range-name">{rangeName}</span>
              <button className="dock-toggle" onClick={rangeActions.insert} title="Put in as many empty bars before these, moving the rest of the song later (Insert)" type="button">
                Insert
              </button>
              <button className="dock-toggle" onClick={rangeActions.remove} title="Take these bars out of the song and close the gap (Ctrl+Delete)" type="button">
                Delete
              </button>
              <button className="dock-toggle" onClick={rangeActions.clear} title="Empty these bars and leave the space (Delete)" type="button">
                Clear
              </button>
              <button className="dock-toggle" onClick={rangeActions.duplicate} title="Put a copy of these bars straight after them (Ctrl+D)" type="button">
                Duplicate
              </button>
              <button className="dock-toggle" onClick={rangeActions.copy} title="Copy these bars (Ctrl+C)" type="button">
                Copy
              </button>
              <button className="dock-toggle" onClick={rangeActions.cut} title="Copy these bars and take them out (Ctrl+X)" type="button">
                Cut
              </button>
              <button className="dock-toggle" onClick={rangeActions.paste} disabled={!hasTimeClip} title="Put the copied bars in here, before these (Ctrl+V)" type="button">
                Paste
              </button>
              <button className="track-remove" onClick={() => setRange(null)} title="Let go of these bars (Esc)" aria-label="Let go of the range" type="button">
                ×
              </button>
            </div>
          )}
          <span className="playlist-hint">
            Drag the bar numbers to pick bars · click paints · drag edges to trim · Ctrl+click splits · right-click deletes · Shift+drag copies · Alt ignores snap
          </span>
        </div>

        <div
          className="playlist"
          ref={scrollRef}
          tabIndex={0}
          aria-label="Playlist"
          onKeyDown={onKeyDown}
          onPointerMove={() => claimKeyboard(scrollRef.current)}
          onWheel={onWheel}
        >
          <div
            className="playlist-grid"
            // The zoom, as the width of the song's first bar. Each stretch of
            // one meter sets its own for the lines it draws.
            style={{ '--bar-w': `${barPx}px`, '--lane-h': `${LANE_H}px` } as React.CSSProperties}
          >
            <TimingLane kind="tempo" song={song} width={span * ppt} ppt={ppt} bars={grid} snap={snap} onEdit={onEdit} />
            <TimingLane kind="meter" song={song} width={span * ppt} ppt={ppt} bars={grid} snap={snap} onEdit={onEdit} />
            <SectionStrip
              song={song}
              width={span * ppt}
              ppt={ppt}
              bars={grid}
              minimum={grid.bar(0).beat}
              snap={snap}
              section={section}
              onSection={onSection}
              onEdit={onEdit}
            />

            <div
              className="playlist-ruler"
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={() => (rangeDrag.current = null)}
              onClickCapture={(e) => {
                if (!swallowClick.current) return
                swallowClick.current = false
                e.stopPropagation()
              }}
            >
              <span className="playlist-label" />
              {rulerBars.map((b) => {
                const i = b.index
                const tick = b.tick
                const inSection = looped !== null && tick >= looped.from && tick < looped.to
                // A bar number cuts the section over it in two there, or
                // starts a new one where there is none.
                const over = sectionOver(song, tick)
                const splits = over !== undefined && over.tick < tick
                return (
                  <button
                    key={i}
                    className={`playlist-bar${i % 4 === 0 ? ' strong' : ''}${inSection ? ' in-section' : ''}`}
                    style={{ width: b.length * ppt }}
                    onClick={() => {
                      if (splits) onEdit((x) => splitSection(x, tick))
                      else if (!over) onEdit((x) => addSection(x, tick, grid.bar(i + 4).tick - tick))
                    }}
                    title={
                      splits
                        ? `Split ${over.name} at bar ${i + 1}`
                        : over
                          ? `Bar ${i + 1}`
                          : `Start a section at bar ${i + 1}`
                    }
                    type="button"
                  >
                    {i % numberEvery === 0 ? i + 1 : ''}
                  </button>
                )
              })}
              {range && (
                <span
                  className="playlist-range-mark"
                  style={{ left: `calc(var(--label-w) + ${range.from * ppt}px)`, width: rangeLen * ppt }}
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="playlist-lanes" style={{ height: lanes * LANE_H }}>
              <div className="playlist-lane-labels" aria-hidden="true">
                {Array.from({ length: lanes }, (_, lane) => (
                  <span key={lane} className="playlist-lane-label">
                    {lane + 1}
                  </span>
                ))}
              </div>
              <div
                className="playlist-layer"
                ref={layerRef}
                style={{ width: span * ppt }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                onContextMenu={(e) => e.preventDefault()}
                onDoubleClick={(e) => {
                  const clip = e.target instanceof Element ? e.target.closest<HTMLElement>('.playlist-clip') : null
                  const place = clip ? song.playlist[Number(clip.dataset.index)] : undefined
                  if (place) onOpenPattern(place.pattern)
                }}
              >
                {/* The bar and beat lines, a stretch of one meter at a time:
                    drawn by each stretch's background, so a thousand bars
                    still cost no elements. */}
                {meterBands.map((m) => (
                  <div
                    key={`meter${m.tick}`}
                    className="playlist-meter"
                    style={
                      {
                        left: m.tick * ppt,
                        width: (m.end - m.tick) * ppt,
                        '--bar-w': `${barTicks(m) * ppt}px`,
                        '--beat-w': `${beatTicks(m) * ppt}px`,
                      } as React.CSSProperties
                    }
                    aria-hidden="true"
                  />
                ))}
                {range && (
                  <div
                    className="playlist-range"
                    style={{ left: range.from * ppt, width: rangeLen * ppt }}
                    aria-hidden="true"
                  />
                )}
                {/* Each section tints the lanes under it, so it is plain which
                    bars go with it when it is moved. */}
                {sectionsOf(song).map((x) => (
                  <div
                    key={`band${x.tick}`}
                    className={`playlist-band${x.color !== undefined ? ' colored' : ''}${section === x.tick ? ' on' : ''}`}
                    style={
                      {
                        left: x.tick * ppt,
                        width: x.length * ppt,
                        ...(x.color !== undefined ? { '--sec-h': x.color } : {}),
                      } as React.CSSProperties
                    }
                    aria-hidden="true"
                  />
                ))}
                {view.playlist.map((place, i) => {
                  const pattern = patterns.get(place.pattern)
                  if (!pattern) return null
                  return (
                    <Clip
                      key={i}
                      index={i}
                      place={place}
                      pattern={pattern}
                      ppt={ppt}
                      picked={shownPicked.has(i)}
                      erasing={erasing.has(i)}
                    />
                  )
                })}
                {marquee && (
                  <div
                    className="playlist-marquee"
                    style={{
                      left: Math.min(marquee.from.tick, marquee.to.tick) * ppt,
                      width: Math.abs(marquee.to.tick - marquee.from.tick) * ppt,
                      top: Math.min(marquee.from.lane, marquee.to.lane) * LANE_H,
                      height: (Math.abs(marquee.to.lane - marquee.from.lane) + 1) * LANE_H,
                    }}
                  />
                )}
                <div className="playlist-head" ref={headRef} aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ClipProps {
  index: number
  place: Placement
  pattern: Pattern
  ppt: number
  picked: boolean
  erasing: boolean
}

/**
 * One clip: its pattern's name, and its notes drawn small, repeat after
 * repeat, with a faint line where each repeat begins. Memoized, because a
 * drag re-renders the playlist every time the pointer crosses a snap line and
 * most clips have not moved.
 */
const Clip = memo(function Clip({ index, place, pattern, ppt, picked, erasing }: ClipProps) {
  const length = clipLength(place, pattern)
  const art = useMemo(() => clipArt(place, pattern), [place, pattern])
  const colored = pattern.color !== undefined
  return (
    <div
      className={`playlist-clip${picked ? ' picked' : ''}${erasing ? ' erasing' : ''}${colored ? ' colored' : ''}`}
      data-index={index}
      style={
        {
          left: place.tick * ppt,
          width: Math.max(3, length * ppt),
          top: laneOf(place) * LANE_H,
          ...(colored ? { '--pat-h': pattern.color } : {}),
        } as React.CSSProperties
      }
      aria-label={`${pattern.name}, clip ${index + 1}`}
      title={`${pattern.name} -- drag to move, drag an edge to trim, Ctrl+click to split, right-click to delete, double-click to edit`}
    >
      <svg className="playlist-clip-notes" viewBox={`0 0 ${length} ${art.rows}`} preserveAspectRatio="none" aria-hidden="true">
        {art.seams.map((x) => (
          <line key={`s${x}`} className="seam" x1={x} x2={x} y1={0} y2={art.rows} vectorEffect="non-scaling-stroke" />
        ))}
        {art.notes.map((n, k) => (
          <rect key={k} x={n.x} y={n.y} width={n.w} height={1} />
        ))}
      </svg>
      <span className="playlist-clip-name">{pattern.name}</span>
      <span className="playlist-clip-edge" data-edge="start" />
      <span className="playlist-clip-edge" data-edge="end" />
    </div>
  )
})

/** Past this many notes a clip is drawn without them: a solid block reads as well. */
const MAX_DRAWN = 2000

/** A clip's notes and seams, in ticks from its start and rows from the top. */
function clipArt(place: Placement, pattern: Pattern) {
  const stop = clipEnd(place, pattern)
  const hits = clipHits(place, pattern, place.tick, stop)
  let lo = Infinity
  let hi = -Infinity
  for (const n of pattern.notes) {
    lo = Math.min(lo, n.pitch)
    hi = Math.max(hi, n.pitch)
  }
  // A drum pattern on one pitch would be one row the full height of the clip;
  // a few rows of headroom keep it a line of hits.
  const span = Number.isFinite(lo) ? hi - lo + 1 : 1
  const rows = Math.max(span, 8)
  const top = hi + Math.floor((rows - span) / 2)
  const notes =
    hits.length > MAX_DRAWN
      ? []
      : hits
          .filter((h) => h.on < stop)
          .map((h) => ({ x: h.on - place.tick, y: top - h.note.pitch, w: Math.max(1, h.off - h.on) }))
  const seams = clipRepeats(place, pattern, place.tick, stop)
    .filter((base) => base > place.tick && base < stop)
    .map((base) => base - place.tick)
  return { rows, notes, seams }
}

/**
 * Give the playlist the keyboard while the pointer is over it, the way the
 * roll takes it: so Delete deletes clips without a click first. Anything
 * being typed into keeps it.
 */
function claimKeyboard(el: HTMLElement | null) {
  if (!el) return
  const active = document.activeElement
  if (active === el) return
  if (active instanceof HTMLElement) {
    if (active.isContentEditable || active instanceof HTMLTextAreaElement) return
    if (active instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range'].includes(active.type)) return
  }
  el.focus({ preventScroll: true })
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)
