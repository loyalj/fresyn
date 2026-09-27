import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import { loadPrefs, savePrefs } from '../patch/storage'
import {
  copyNotes,
  duplicateNotes,
  humanizeNotes,
  moveNotes,
  notesIn,
  pasteNotes,
  quantizeNotes,
  removeNotes,
  shiftVelocity,
  stretchEnds,
  stretchStarts,
  transposeNotes,
  type Edited,
} from '../song/noteEdit'
import { chordById, chordPitches, CHORDS } from '../song/chord'
import {
  degreesBetween,
  hasScale,
  inScale,
  nearestInScale,
  ROOT_NAMES,
  SCALES,
  stepInScale,
  type Scale,
} from '../song/scale'
import type { Note } from '../song/types'
import {
  drawRoll,
  gridBottom,
  gridTop,
  maxScroll,
  partAt,
  pitchToY,
  tickToX,
  velTop,
  xToTick,
  yToPitch,
  type NotePart,
  type RollColors,
  type RollOverlay,
  type RollView,
} from './rollDraw'
import { useAppearance } from './ThemeContext'

/** Rows, which is exactly the Keyboard module's range: two octaves and the C. */
const KEYS = 25
const GUTTER_W = 40
const RULER_H = 16
const VEL_H = 34
/**
 * The row heights Ctrl+wheel zooms between, and where it starts. Sixteen is
 * tall enough to click on without aiming and to carry a note's name; the rows
 * scroll rather than shrink when the dock is too short to show all of them.
 */
const MIN_ROW_H = 10
const MAX_ROW_H = 32
const DEFAULT_ROW_H = 16
/** The row the view opens centred on: C1, the middle of the keyboard. */
const HOME_PITCH = 12
/** What one notch of a wheel that reports in lines is worth, in pixels. */
const LINE_PX = 16
/** What a note is worth when it is drawn rather than played in. */
const DEFAULT_VELOCITY = 0.8
/**
 * How far the pointer has to travel before a press becomes a drag. Without
 * it a click on a note nudges it by whatever the hand shook, and a click on
 * empty space throws away the remembered length for one grid step.
 */
const DRAG_PX = 3
/**
 * How far Humanize may move a note either way: a sixth of a grid step, and
 * never more than forty ticks -- about twenty milliseconds at 120, which is
 * the size of a real player's looseness rather than a mistake.
 */
const HUMANIZE_TICKS = 40
const HUMANIZE_VELOCITY = 0.1
/** How far apart an erasing sweep is sampled, so a fast one misses nothing. */
const ERASE_STEP_PX = 4

interface Props {
  notes: readonly Note[]
  /** Other tracks' notes, and other patterns' over the same bars, drawn behind as a guide. */
  ghosts: readonly Note[]
  /** Which track new notes belong to. */
  track: string
  lengthTicks: number
  /** What notes snap to, in ticks, and what the grid lines are drawn at. */
  grid: number
  /** Ticks in a bar and in a beat, which the song's time signature decides. */
  bar: number
  beat: number
  /**
   * The grid is only drawn: notes go exactly where they are put, as though
   * Shift were held through every drag.
   */
  snapOff: boolean
  /** The song's key, if it has one. */
  scale: Scale | undefined
  onScale: (scale: Scale | undefined) => void
  /** Each track's colour, for the ghosts of its notes. */
  trackHues?: ReadonlyMap<string, number>
  /**
   * Where this pattern starts in whatever the transport is playing. Zero
   * when the pattern plays on its own; its placement in the song when it is
   * being heard in context, so the playhead is drawn only while it is inside
   * this pattern's bars.
   */
  playOffset: number
  /** Called once per gesture, when it is let go. */
  onChange: (notes: Note[]) => void
  transport: Transport
}

type Gesture =
  | {
      kind: 'move'
      origin: Note[]
      sel: number[]
      anchor: number
      grabTick: number
      grabPitch: number
      /** The note under the pointer, to select alone if this was only a click. */
      clicked: number
      x0: number
      y0: number
      dragging: boolean
      /** The row being heard, so moving to a new one plays it. */
      heard: number
    }
  | {
      kind: 'start' | 'end'
      origin: Note[]
      sel: number[]
      anchor: number
      x0: number
      y0: number
      dragging: boolean
      /** The notes being drawn -- one, or a chord -- heard until let go. */
      heard: number[]
    }
  | { kind: 'velocity'; origin: Note[]; sel: number[]; anchor: number }
  | {
      /** Alt+drag on empty grid: a note on every step the pointer crosses. */
      kind: 'paint'
      /** Where the first note went, and how far apart they are laid. */
      start: number
      spacing: number
      length: number
      /** The last step painted, counted from `start`. */
      cell: number
      /** Indices of the notes laid, which are the selection afterwards. */
      added: number[]
      /** The row the stroke is on, and the notes being heard there. */
      row: number
      heard: number[]
    }
  | {
      /** The right button, or Alt on a note: everything swept over goes. */
      kind: 'erase'
      x: number
      y: number
      /** The notes that were selected, to find again once some have gone. */
      kept: Set<Note>
    }
  | { kind: 'marquee'; x0: number; y0: number; base: number[]; ruler: boolean }
  | { kind: 'key'; pitch: number }

/**
 * What Ctrl+C holds, shared by every roll in the session so a phrase copied
 * in one pattern pastes into the next. `from` is where it was copied from, for
 * a paste with the pointer off the grid.
 */
let clipboard: { notes: Note[]; from: number } | null = null

/**
 * The chord a click lays, or '' for a single note. Kept for the session
 * rather than per roll, so switching tracks or patterns does not put it back
 * to single notes halfway through writing a progression.
 */
let chordChoice = loadPrefs().chord ?? { id: '', inversion: 0 }

/**
 * The roll.
 *
 * Notes are drawn to a canvas rather than laid out as elements: the playhead
 * moves thirty times a second, and a pattern is a few hundred small
 * rectangles, which React would spend the whole frame reconciling for no
 * benefit. Hit-testing is done against the same geometry the drawing uses, so
 * a note lands under the cursor that drew it.
 *
 * A gesture -- drawing a note, moving a group, stretching one, changing
 * velocities -- is kept as a draft while the pointer is down and committed
 * once when it is let go. That is what makes one drag one step of undo
 * instead of sixty.
 *
 * The selection is the roll's own and not the document's: indices into the
 * notes it was handed. It survives the roll's own edits, which say where
 * their notes went, and is dropped by anything else that changes the notes --
 * an undo, another track -- because the indices no longer mean anything then.
 */
export function PianoRoll({
  notes,
  ghosts,
  track,
  lengthTicks,
  grid,
  bar,
  beat,
  snapOff,
  scale,
  onScale,
  trackHues,
  playOffset,
  onChange,
  transport,
}: Props) {
  const appearance = useAppearance()
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 640, h: 320 })
  /**
   * The gesture in progress, if any: the whole pattern as it would be if the
   * pointer were let go now.
   *
   * A ref and not state. The canvas already redraws off refs, on the frame
   * after any of them changes, so a drag needs no re-render at all to be
   * visible -- and committing through state would mean calling the parent's
   * setter from inside an updater, which React runs during render.
   */
  const draftRef = useRef<Note[] | null>(null)
  const gesture = useRef<Gesture | null>(null)
  /** Everything the pointer shows that is not the notes. Read by the draw loop. */
  const overlay = useRef<RollOverlay>({
    hover: null,
    hoverNote: null,
    selected: new Set(),
    marquee: null,
    pressedKey: null,
    preview: null,
  })
  /** The selection the roll's own last commit left, waiting for the notes to come back. */
  const pending = useRef<Edited | null>(null)
  const previous = useRef<readonly Note[]>(notes)
  /**
   * How long the last note drawn or stretched was. A new note starts at this
   * length rather than one grid step, so a line of quarter notes is a line of
   * clicks rather than a line of drags.
   */
  const lastLength = useRef(grid)
  const colors = useRef<RollColors>({
    // Replaced from the stylesheet on mount and on every theme change; these
    // only stand in for the frame before that happens.
    bg: '#16181d',
    gutter: '#1d2026',
    keyWhite: '#cfd3da',
    keyBlack: '#30343c',
    hairline: '#2c2f37',
    rule: '#3d424c',
    accent: '#f0a641',
    accentLine: '#f0a641',
    inkFaint: '#7b8290',
    track: '#2c2f37',
    ink: '#e2e0d9',
  })
  /** Written by the transport subscription; never React state. */
  const playTick = useRef<number | null>(null)
  /** How tall a row is asked to be. The rows grow past it to fill a tall dock. */
  const [rowZoom, setRowZoom] = useState(() => clamp(loadPrefs().rowZoom ?? DEFAULT_ROW_H, MIN_ROW_H, MAX_ROW_H))
  /** Pixels scrolled from the top row, or null to open centred on the middle C. */
  const [scroll, setScroll] = useState<number | null>(null)

  const view = useMemo<RollView>(() => {
    const room = Math.max(1, size.h - RULER_H - VEL_H - 2)
    // Never shorter than asked, and taller when the dock has room to spare
    // -- a tall dock with the rows huddled at the top of it would be space
    // thrown away.
    const rowH = Math.min(MAX_ROW_H, Math.max(rowZoom, room / KEYS))
    const viewH = Math.min(room, KEYS * rowH)
    const top = Math.max(0, KEYS * rowH - viewH)
    const home = (KEYS - 1 - HOME_PITCH) * rowH + rowH / 2 - viewH / 2
    return {
      gutterW: GUTTER_W,
      rulerH: RULER_H,
      rowH,
      viewH,
      scrollY: clamp(scroll ?? home, 0, top),
      velH: VEL_H,
      keys: KEYS,
      // The pattern always fills the width. With one pattern on the bench
      // there is nothing to scroll to, and a roll that fits is a roll whose
      // every note can be reached without moving anything first.
      pxPerTick: (size.w - GUTTER_W) / Math.max(1, lengthTicks),
      lengthTicks,
      beat,
      bar,
      grid,
      playTick: null,
      scale,
      trackHues,
      colors: colors.current,
    }
  }, [size, lengthTicks, grid, bar, beat, rowZoom, scroll, scale, trackHues])

  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setSize({ w: host.clientWidth, h: host.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // The palette is read off the DOM because a canvas cannot see the
  // stylesheet, and again whenever the theme changes underneath it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const style = getComputedStyle(canvas)
    const pick = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback
    colors.current = {
      bg: pick('--recess', colors.current.bg),
      gutter: pick('--panel', colors.current.gutter),
      keyWhite: pick('--key-white', colors.current.keyWhite),
      keyBlack: pick('--key-black', colors.current.keyBlack),
      hairline: pick('--hairline', colors.current.hairline),
      rule: pick('--rule', colors.current.rule),
      accent: pick('--accent', colors.current.accent),
      accentLine: pick('--accent-line', colors.current.accentLine),
      inkFaint: pick('--ink-faint', colors.current.inkFaint),
      track: pick('--meter-track', colors.current.track),
      ink: pick('--ink', colors.current.ink),
    }
  }, [appearance])

  // One draw loop for the life of the panel. It reads the notes off a ref so
  // that the playhead, which moves every frame, never goes through React.
  const notesRef = useRef(notes)
  notesRef.current = notes
  const ghostsRef = useRef(ghosts)
  ghostsRef.current = ghosts

  // Drawn only when something it draws has changed. Everything the picture is
  // made of is replaced rather than edited in place -- a new draft, a new
  // overlay, a new view -- so comparing what was drawn last against what is
  // there now is the dirty flag, and nobody can forget to set it. A roll that
  // is sitting still, which is most of the time, costs a handful of
  // comparisons a frame instead of a full repaint.
  useEffect(() => {
    let raf = 0
    let drawn: unknown[] = []
    const tick = () => {
      const canvas = canvasRef.current
      if (canvas) {
        const inputs = [
          draftRef.current ?? notesRef.current,
          ghostsRef.current,
          viewRef.current,
          playTick.current,
          colors.current,
          overlay.current,
          // The canvas is sized in device pixels, so a zoom is a change too.
          window.devicePixelRatio,
        ]
        if (inputs.some((v, i) => v !== drawn[i])) {
          drawn = inputs
          drawRoll(
            canvas,
            draftRef.current ?? notesRef.current,
            ghostsRef.current,
            { ...viewRef.current, playTick: playTick.current, colors: colors.current },
            overlay.current,
          )
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const select = useCallback((indices: Iterable<number>) => {
    overlay.current = { ...overlay.current, selected: new Set(indices) }
  }, [])

  // The draft is dropped when the committed notes come back, not when the
  // pointer is let go: clearing it first would leave one frame drawn from the
  // old pattern, which reads as the note jumping back before it lands.
  //
  // The selection is settled here too. The roll's own commit says where its
  // notes went; notes that come back unchanged keep what was selected; and
  // anything else -- an undo, another track -- starts afresh.
  useEffect(() => {
    draftRef.current = null
    const mine = pending.current
    pending.current = null
    if (mine && sameNotes(mine.notes, notes)) select(mine.selected)
    else if (!sameNotes(previous.current, notes)) select([])
    previous.current = notes
  }, [notes, select])

  const offsetRef = useRef(playOffset)
  offsetRef.current = playOffset

  useEffect(
    () =>
      transport.subscribe((state) => {
        if (!state.playing) {
          playTick.current = null
          return
        }
        // Inside this pattern's bars, or not drawn at all: a playhead parked
        // at either edge while the song plays something else would read as
        // this pattern being stuck there.
        const local = state.tick - offsetRef.current
        playTick.current = local >= 0 && local < viewRef.current.lengthTicks ? local : null
      }),
    [transport],
  )

  // --- scrolling -----------------------------------------------------

  // The wheel scrolls the rows, and Ctrl+wheel makes them taller or shorter
  // around the row under the pointer. A native listener, because React's
  // wheel handler is passive and cannot stop the page scrolling as well.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current
      const rect = canvas.getBoundingClientRect()
      const y = e.clientY - rect.top
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? v.viewH : 1
      const dy = e.deltaY * unit

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // One notch is about a tenth taller or shorter, whatever the device
        // says a notch is worth.
        const next = clamp(v.rowH * Math.pow(1.1, -Math.sign(dy)), MIN_ROW_H, MAX_ROW_H)
        if (next === v.rowH) return
        // The same row stays under the pointer, so zooming in on a note keeps
        // that note where you were looking at it.
        const into = clamp(y, gridTop(v), gridBottom(v)) - gridTop(v)
        const row = (into + v.scrollY) / v.rowH
        setRowZoom(next)
        savePrefs({ rowZoom: next })
        setScroll(row * next - into)
        return
      }

      // The wheel is the roll's whenever the pointer is over it, even with
      // nowhere left to scroll: letting it through at the top or the bottom
      // would scroll the rack behind instead, and the rack moving under a
      // hand that is working in the roll is the last thing it expects.
      e.preventDefault()
      const top = maxScroll(v)
      if (top <= 0 || dy === 0) return
      const next = clamp(v.scrollY + dy, 0, top)
      if (next !== v.scrollY) setScroll(next)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // --- editing -------------------------------------------------------

  const commit = useCallback(
    (edit: Edited) => {
      pending.current = edit
      select(edit.selected)
      onChange(edit.notes)
    },
    [onChange, select],
  )

  const at = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  /** The topmost note under a point and which part of it, or null. Last drawn wins, as it is drawn. */
  const hitTest = useCallback(
    (x: number, y: number, list: readonly Note[], v: RollView): { index: number; part: NotePart } | null => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i]
        const top = pitchToY(n.pitch, v)
        if (y < top || y > top + v.rowH) continue
        const left = tickToX(n.tick, v)
        const width = Math.max(3, n.length * v.pxPerTick)
        if (x >= left && x <= left + width) return { index: i, part: partAt(x, left, width) }
      }
      return null
    },
    [],
  )

  /** The note nearest a point horizontally, for the velocity lane. */
  const nearest = useCallback((x: number, list: readonly Note[], v: RollView) => {
    let best = -1
    let bestDistance = Infinity
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(tickToX(list[i].tick, v) - x)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    }
    // Only if the pointer is actually near one; otherwise a click on empty
    // lane would grab whatever note happened to be furthest along.
    return bestDistance <= 14 ? best : -1
  }, [])

  /** Onto the grid, or left alone with Shift held -- for a push or a swing. */
  const snap = useCallback(
    (tick: number, free: boolean) =>
      free || snapOff ? Math.round(tick) : Math.round(tick / grid) * grid,
    [grid, snapOff],
  )

  /** Whether moves and new notes are held to the key. */
  const railed = !!scale?.snap && hasScale(scale)
  /** A row as it would be drawn: onto the scale when the key is a rail. */
  const onKey = useCallback(
    (pitch: number) => {
      const p = clamp(pitch, 0, KEYS - 1)
      if (!railed) return p
      const q = nearestInScale(p, scale)
      if (q >= 0 && q < KEYS) return q
      // The nearest was off the keyboard; the nearest the other way is not.
      const dir = q < 0 ? 1 : -1
      let r = p
      while (r >= 0 && r < KEYS && !inScale(r, scale)) r += dir
      return clamp(r, 0, KEYS - 1)
    },
    [railed, scale],
  )
  const degreeStep = useCallback((pitch: number, degrees: number) => stepInScale(pitch, degrees, scale), [scale])

  const [chord, setChordState] = useState(chordChoice)
  const setChord = (next: typeof chordChoice) => {
    chordChoice = next
    savePrefs({ chord: next })
    setChordState(next)
  }
  /** The chord in force: none when it is built from a key the song no longer has. */
  const shape = chordById(chord.id)
  const activeChord = shape && (!shape.fromKey || hasScale(scale)) ? shape : undefined
  /** Every row a click at `root` lays: the chord, or the one note. */
  const pitchesAt = useCallback(
    (root: number) => (activeChord ? chordPitches(root, activeChord, chord.inversion, scale, KEYS) : [root]),
    [activeChord, chord.inversion, scale],
  )

  /** The start of the grid column a tick falls in, and never past the last one. */
  const column = useCallback(
    (tick: number) => clamp(Math.floor(tick / grid) * grid, 0, Math.max(0, lengthTicks - 1)),
    [grid, lengthTicks],
  )

  const hear = useCallback((pitch: number, velocity = DEFAULT_VELOCITY) => {
    transport.preview(track, pitch, velocity)
  }, [transport, track])
  const unhear = useCallback((pitch: number) => transport.release(track, pitch), [transport, track])

  /** Take out whatever note is under a point in the draft. */
  const eraseAt = useCallback(
    (x: number, y: number) => {
      const list = draftRef.current
      if (!list) return
      const hit = hitTest(x, y, list, viewRef.current)
      if (hit) draftRef.current = list.filter((_, i) => i !== hit.index)
    },
    [hitTest],
  )

  /** What the pointer is over when nothing is being dragged: the highlight, the grips, the cursor. */
  const hover = useCallback(
    (x: number, y: number, ctrl: boolean) => {
      const v = viewRef.current
      const canvas = canvasRef.current
      const list = draftRef.current ?? notesRef.current
      const inGrid = y >= gridTop(v) && y <= gridBottom(v)
      const inRoll = x >= v.gutterW && x <= tickToX(v.lengthTicks, v)
      const pitch = inGrid ? clamp(yToPitch(y, v), 0, KEYS - 1) : null
      const tick = inRoll ? column(xToTick(x, v)) : null
      const hit = inGrid && inRoll ? hitTest(x, y, list, v) : null

      // In chord mode, over empty grid where a click would draw, the chord
      // that click would lay: placed and sized exactly as the draw will be.
      let preview: RollOverlay['preview'] = null
      if (activeChord && inGrid && inRoll && !hit && !ctrl && pitch !== null) {
        const at = snapOff
          ? clamp(Math.round(xToTick(x, v)), 0, lengthTicks - 1)
          : clamp(Math.floor(xToTick(x, v) / grid) * grid, 0, lengthTicks - grid)
        preview = {
          tick: at,
          length: clamp(lastLength.current, 1, lengthTicks - at),
          pitches: pitchesAt(onKey(pitch)),
        }
      }

      overlay.current = {
        ...overlay.current,
        hover: pitch === null && tick === null ? null : { tick, pitch },
        hoverNote: hit,
        preview,
      }

      let cursor = 'default'
      if (x < v.gutterW) cursor = inGrid ? 'pointer' : 'default'
      else if (y < gridTop(v)) cursor = 'cell'
      else if (y >= velTop(v)) cursor = nearest(x, list, v) >= 0 ? 'ns-resize' : 'default'
      else if (hit) cursor = hit.part === 'body' ? (ctrl ? 'copy' : 'grab') : 'ew-resize'
      else if (inGrid) cursor = ctrl ? 'cell' : 'crosshair'
      if (canvas && canvas.style.cursor !== cursor) canvas.style.cursor = cursor
    },
    [column, hitTest, nearest, activeChord, snapOff, grid, lengthTicks, pitchesAt, onKey],
  )
  /** Where the pointer last was over the roll, or null once it has left. */
  const pointer = useRef<{ x: number; y: number; ctrl: boolean } | null>(null)

  // Scrolling or zooming moves the rows under a pointer that has not moved,
  // so what it is over is worked out again once the new view is in.
  useEffect(() => {
    const p = pointer.current
    if (p && !gesture.current) hover(p.x, p.y, p.ctrl)
  }, [view, hover])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const v = viewRef.current
      const { x, y } = at(e)
      // Focus, so the keyboard shortcuts reach the roll and not the rack.
      e.currentTarget.focus({ preventScroll: true })
      // The outline has done its job: whatever this press makes is drawn for
      // real from here.
      overlay.current = { ...overlay.current, preview: null }
      if (e.button === 1) return
      const ctrl = e.ctrlKey || e.metaKey
      const selected = overlay.current.selected

      // A key down the side: heard for as long as it is held, and dragged
      // down the keys it plays each one it crosses, as a real keyboard would.
      if (x < v.gutterW) {
        if (e.button !== 0 || y < gridTop(v) || y > gridBottom(v)) return
        const pitch = clamp(yToPitch(y, v), 0, KEYS - 1)
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { kind: 'key', pitch }
        overlay.current = { ...overlay.current, pressedKey: pitch }
        hear(pitch)
        return
      }

      // The ruler selects every note in the span dragged across it.
      if (y < gridTop(v)) {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { kind: 'marquee', x0: x, y0: 0, base: e.shiftKey || ctrl ? [...selected] : [], ruler: true }
        select(gesture.current.base)
        return
      }

      const list = [...notes]

      if (y >= velTop(v)) {
        const index = nearest(x, list, v)
        if (index < 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        // Every note starting where this bar is, because their bars are drawn
        // on top of one another and look like one: a chord's velocity is one
        // bar to the eye, and taking hold of it moved only whichever note
        // happened to be found first -- hidden under the others, so the drag
        // looked as if it did nothing at all.
        const stack = list.flatMap((n, i) => (n.tick === list[index].tick ? [i] : []))
        // And the whole selection when the bar taken hold of is one of it, so
        // a phrase can be made louder without losing its accents.
        const sel = selected.has(index) ? [...new Set([...selected, ...stack])] : stack
        select(sel)
        gesture.current = { kind: 'velocity', origin: list, sel, anchor: index }
        draftRef.current = shiftVelocity(list, sel, velocityAt(y, v) - list[index].velocity).notes
        return
      }

      if (y > gridBottom(v)) return

      const hit = hitTest(x, y, list, v)

      // The right button erases, and so does Alt on a note: whatever is under
      // the pointer goes, and so does everything it is swept across, as one
      // step of undo. A single click is the sweep that went nowhere.
      if (e.button === 2 || (hit && e.altKey)) {
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { kind: 'erase', x, y, kept: new Set([...selected].map((i) => list[i])) }
        draftRef.current = list
        eraseAt(x, y)
        return
      }
      if (e.button !== 0) return

      // Alt on empty grid paints: a note on every step the pointer crosses,
      // at the row it is on, spaced by the last length used. A hi-hat line
      // is one stroke.
      if (!hit && e.altKey) {
        e.currentTarget.setPointerCapture(e.pointerId)
        const spacing = snapOff ? grid : Math.max(grid, Math.round(lastLength.current / grid) * grid)
        const start = clamp(Math.floor(xToTick(x, v) / grid) * grid, 0, lengthTicks - 1)
        const row = onKey(yToPitch(y, v))
        const pitches = pitchesAt(row)
        const length = Math.min(spacing, lengthTicks - start)
        const added: number[] = []
        for (const pitch of pitches) {
          list.push({ track, tick: start, length, pitch, velocity: DEFAULT_VELOCITY })
          added.push(list.length - 1)
        }
        gesture.current = { kind: 'paint', start, spacing, length: spacing, cell: 0, added, row, heard: pitches }
        draftRef.current = list
        select(added)
        for (const p of pitches) hear(p)
        return
      }

      // Ctrl on empty grid pulls out a rubber band; Shift with it adds to
      // what is already selected.
      if (!hit && ctrl) {
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { kind: 'marquee', x0: x, y0: y, base: e.shiftKey ? [...selected] : [], ruler: false }
        select(gesture.current.base)
        return
      }

      if (hit) {
        // Shift+click adds a note to the selection or takes it out, and does
        // nothing else: it is a way of choosing, not of dragging.
        if (e.shiftKey) {
          const next = new Set(selected)
          if (next.has(hit.index)) next.delete(hit.index)
          else next.add(hit.index)
          select(next)
          return
        }

        e.currentTarget.setPointerCapture(e.pointerId)
        // Taking hold of a selected note takes hold of the whole selection;
        // taking hold of any other note selects it alone.
        let sel = selected.has(hit.index) ? [...selected] : [hit.index]
        if (!selected.has(hit.index)) select(sel)
        const n = list[hit.index]

        if (hit.part !== 'body') {
          gesture.current = {
            kind: hit.part,
            origin: list,
            sel,
            anchor: hit.index,
            x0: x,
            y0: y,
            dragging: false,
            heard: [],
          }
          draftRef.current = list
          return
        }

        // Ctrl+drag on a note drags a copy and leaves the original where it
        // was. The copies go on the end and become the selection.
        let origin = list
        let anchor = hit.index
        if (ctrl) {
          const copies = sel.map((i) => ({ ...list[i] }))
          origin = [...list, ...copies]
          anchor = list.length + sel.indexOf(hit.index)
          sel = copies.map((_, k) => list.length + k)
          select(sel)
        }
        gesture.current = {
          kind: 'move',
          origin,
          sel,
          anchor,
          grabTick: xToTick(x, v) - n.tick,
          grabPitch: yToPitch(y, v) - n.pitch,
          clicked: hit.index,
          x0: x,
          y0: y,
          dragging: false,
          heard: n.pitch,
        }
        draftRef.current = origin
        hear(n.pitch, n.velocity)
        return
      }

      // Empty space: draw a note at the last length used and stay in the
      // stretch, so one gesture both places it and sets its length -- the way
      // a roll is actually used. A click alone leaves it at that length.
      e.currentTarget.setPointerCapture(e.pointerId)
      const tick = snapOff
        ? clamp(Math.round(xToTick(x, v)), 0, lengthTicks - 1)
        : clamp(Math.floor(xToTick(x, v) / grid) * grid, 0, lengthTicks - grid)
      // With a chord chosen, every note of it, all stretched together.
      const pitches = pitchesAt(onKey(yToPitch(y, v)))
      const length = clamp(lastLength.current, 1, lengthTicks - tick)
      const sel: number[] = []
      for (const pitch of pitches) {
        list.push({ track, tick, length, pitch, velocity: DEFAULT_VELOCITY })
        sel.push(list.length - 1)
      }
      select(sel)
      gesture.current = {
        kind: 'end',
        origin: list,
        sel,
        anchor: sel[0],
        x0: x,
        y0: y,
        dragging: false,
        heard: pitches,
      }
      draftRef.current = list
      for (const p of pitches) hear(p)
    },
    [at, notes, hitTest, nearest, grid, snapOff, lengthTicks, track, select, hear, eraseAt, onKey, pitchesAt],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const v = viewRef.current
      const { x, y } = at(e)
      pointer.current = { x, y, ctrl: e.ctrlKey || e.metaKey }
      const g = gesture.current
      if (!g) {
        claimKeyboard(e.currentTarget)
        hover(x, y, e.ctrlKey || e.metaKey)
        return
      }
      const free = e.shiftKey

      if (g.kind === 'key') {
        const pitch = clamp(yToPitch(y, v), 0, KEYS - 1)
        if (pitch !== g.pitch) {
          unhear(g.pitch)
          hear(pitch)
          gesture.current = { kind: 'key', pitch }
          overlay.current = { ...overlay.current, pressedKey: pitch, hover: { tick: null, pitch } }
        }
        return
      }

      if (g.kind === 'marquee') {
        const y0 = g.ruler ? gridTop(v) : g.y0
        const y1 = g.ruler ? gridBottom(v) : y
        const list = notesRef.current
        const from = xToTick(Math.min(g.x0, x), v)
        const to = xToTick(Math.max(g.x0, x), v)
        const low = clamp(yToPitch(Math.max(y0, y1), v), 0, KEYS - 1)
        const high = clamp(yToPitch(Math.min(y0, y1), v), 0, KEYS - 1)
        overlay.current = {
          ...overlay.current,
          // No crosshair under a rubber band: it would mark one cell inside a
          // box that is choosing many.
          hover: null,
          hoverNote: null,
          marquee: { x0: g.x0, y0, x1: x, y1 },
          selected: new Set([...g.base, ...notesIn(list, from, to, low, high)]),
        }
        return
      }

      if (g.kind === 'velocity') {
        const d = velocityAt(y, v) - g.origin[g.anchor].velocity
        draftRef.current = shiftVelocity(g.origin, g.sel, d).notes
        return
      }

      if (g.kind === 'erase') {
        // Sampled along the line from the last point, so a quick sweep takes
        // out a short note it passed over between two pointer events.
        const steps = Math.max(1, Math.ceil(Math.hypot(x - g.x, y - g.y) / ERASE_STEP_PX))
        for (let i = 1; i <= steps; i++) {
          eraseAt(g.x + ((x - g.x) * i) / steps, g.y + ((y - g.y) * i) / steps)
        }
        g.x = x
        g.y = y
        return
      }

      if (g.kind === 'paint') {
        const list = draftRef.current
        if (!list) return
        const cell = Math.floor((xToTick(x, v) - g.start) / g.spacing)
        const row = onKey(yToPitch(y, v))
        const pitches = pitchesAt(row)
        const dir = Math.sign(cell - g.cell)
        // Every step between the last one painted and this one, so a fast
        // stroke leaves no gaps -- a chord on each, with a chord chosen.
        for (let c = g.cell + dir; dir !== 0 && c !== cell + dir; c += dir) {
          const tick = g.start + c * g.spacing
          if (tick < 0 || tick >= lengthTicks) continue
          const length = Math.min(g.length, lengthTicks - tick)
          for (const pitch of pitches) {
            const taken = list.some((n) => n.pitch === pitch && n.tick < tick + length && n.tick + n.length > tick)
            if (taken) continue
            list.push({ track, tick, length, pitch, velocity: DEFAULT_VELOCITY })
            g.added.push(list.length - 1)
          }
        }
        g.cell = cell
        draftRef.current = [...list]
        select(g.added)
        overlay.current = { ...overlay.current, hover: { tick: column(g.start + cell * g.spacing), pitch: row } }
        if (row !== g.row) {
          for (const p of g.heard) unhear(p)
          for (const p of pitches) hear(p)
          g.row = row
          g.heard = pitches
        }
        return
      }

      // A press only becomes a drag once it has gone somewhere.
      if (!g.dragging) {
        if (Math.abs(x - g.x0) < DRAG_PX && Math.abs(y - g.y0) < DRAG_PX) return
        g.dragging = true
      }
      const a = g.origin[g.anchor]

      if (g.kind === 'move') {
        const dTick = snap(xToTick(x, v) - g.grabTick, free) - a.tick
        const target = yToPitch(y, v) - g.grabPitch
        // On the key, the group moves by scale degrees, so a chord stays a
        // chord of the key rather than sliding out of it a semitone at a time.
        const out = railed
          ? transposeNotes(
              moveNotes(g.origin, g.sel, dTick, 0, lengthTicks, KEYS).notes,
              g.sel,
              degreesBetween(a.pitch, clamp(target, 0, KEYS - 1), scale),
              KEYS,
              degreeStep,
            )
          : moveNotes(g.origin, g.sel, dTick, target - a.pitch, lengthTicks, KEYS)
        draftRef.current = out.notes
        const moved = out.notes[g.anchor]
        overlay.current = { ...overlay.current, hover: { tick: column(moved.tick), pitch: moved.pitch } }
        if (moved.pitch !== g.heard) {
          unhear(g.heard)
          hear(moved.pitch, moved.velocity)
          g.heard = moved.pitch
        }
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
        return
      }

      if (g.kind === 'end') {
        const end = snap(xToTick(x, v), free)
        const out = stretchEnds(g.origin, g.sel, end - (a.tick + a.length), grid, lengthTicks)
        draftRef.current = out.notes
        const n = out.notes[g.anchor]
        overlay.current = { ...overlay.current, hover: { tick: column(n.tick + n.length - 1), pitch: n.pitch } }
        return
      }

      const start = snap(xToTick(x, v), free)
      const out = stretchStarts(g.origin, g.sel, start - a.tick, grid)
      draftRef.current = out.notes
      const n = out.notes[g.anchor]
      overlay.current = { ...overlay.current, hover: { tick: column(n.tick), pitch: n.pitch } }
    },
    [at, hover, snap, grid, lengthTicks, column, hear, unhear, eraseAt, onKey, railed, scale, degreeStep, track, select, pitchesAt],
  )

  const finish = useCallback(() => {
    const g = gesture.current
    if (!g) return
    gesture.current = null

    if (g.kind === 'key') {
      unhear(g.pitch)
      overlay.current = { ...overlay.current, pressedKey: null }
      return
    }
    if (g.kind === 'marquee') {
      overlay.current = { ...overlay.current, marquee: null }
      return
    }

    const out = draftRef.current
    if (g.kind === 'move') unhear(g.heard)
    if (g.kind === 'end' || g.kind === 'start' || g.kind === 'paint') for (const p of g.heard) unhear(p)

    if (g.kind === 'erase') {
      if (!out || out.length === notesRef.current.length) {
        draftRef.current = null
        return
      }
      const selected: number[] = []
      out.forEach((n, i) => g.kept.has(n) && selected.push(i))
      commit({ notes: out, selected })
      return
    }
    if (g.kind === 'paint') {
      if (out) commit({ notes: out, selected: g.added })
      return
    }

    // A press on a note that went nowhere was a click on that note, and it
    // becomes the whole selection -- including when it was one of several,
    // and when Ctrl had made copies to drag that were never dragged.
    if (g.kind === 'move' && !g.dragging) {
      draftRef.current = null
      select([g.clicked])
      return
    }

    if (!out || sameNotes(out, notesRef.current)) {
      draftRef.current = null
      return
    }
    // One note stretched, or one chord drawn: that is the length the next
    // one starts at.
    if ((g.kind === 'end' || g.kind === 'start') && (g.sel.length === 1 || g.heard.length > 0)) {
      lastLength.current = out[g.anchor].length
    }
    commit({ notes: out, selected: g.sel })
  }, [commit, select, unhear])

  const onPointerLeave = useCallback(() => {
    pointer.current = null
    if (gesture.current) return
    overlay.current = { ...overlay.current, hover: null, hoverNote: null, preview: null }
  }, [])

  // --- keyboard -------------------------------------------------------

  /**
   * Scroll just far enough that these rows can be seen. For notes moved with
   * the arrow keys, which would otherwise walk an octave off the top of the
   * view and leave you pressing keys at something you cannot see.
   */
  const reveal = useCallback((pitches: number[]) => {
    if (pitches.length === 0) return
    const v = viewRef.current
    const high = Math.max(...pitches)
    const low = Math.min(...pitches)
    const top = (v.keys - 1 - high) * v.rowH
    const bottom = (v.keys - low) * v.rowH
    if (top < v.scrollY) setScroll(top)
    else if (bottom > v.scrollY + v.viewH) setScroll(Math.min(top, bottom - v.viewH))
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (gesture.current) return
      const list = notesRef.current
      const sel = [...overlay.current.selected].filter((i) => i < list.length)
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      let handled = true

      if (ctrl && key === 'a') {
        select(list.map((_, i) => i))
      } else if (ctrl && (key === 'c' || key === 'x')) {
        if (sel.length) {
          clipboard = { notes: copyNotes(list, sel), from: Math.min(...sel.map((i) => list[i].tick)) }
          if (key === 'x') commit(removeNotes(list, sel))
        }
      } else if (ctrl && key === 'v') {
        // At the start of the column under the pointer, which is the column
        // the highlight is showing; where it was copied from if the pointer is
        // off the grid.
        if (clipboard?.notes.length) {
          const tick = overlay.current.hover?.tick ?? clipboard.from
          commit(pasteNotes(list, clipboard.notes, tick, track, lengthTicks))
        }
      } else if (ctrl && key === 'd') {
        if (sel.length) commit(duplicateNotes(list, sel, grid, lengthTicks, track))
      } else if (key === 'delete' || key === 'backspace') {
        if (sel.length) commit(removeNotes(list, sel))
      } else if (key === 'escape') {
        select([])
      } else if (!ctrl && (key === 'arrowleft' || key === 'arrowright')) {
        // A grid step, or a whole bar with Shift.
        const step = e.shiftKey ? bar : grid
        if (sel.length) commit(moveNotes(list, sel, key === 'arrowleft' ? -step : step, 0, lengthTicks, KEYS))
      } else if (!ctrl && (key === 'arrowup' || key === 'arrowdown')) {
        // A semitone, or an octave with Shift -- or with the key as a rail, a
        // step along the scale.
        const step = e.shiftKey ? 12 : 1
        const sign = key === 'arrowdown' ? -1 : 1
        if (sel.length) {
          const out =
            railed && !e.shiftKey
              ? transposeNotes(list, sel, sign, KEYS, degreeStep)
              : moveNotes(list, sel, 0, sign * step, lengthTicks, KEYS)
          commit(out)
          reveal(out.selected.map((i) => out.notes[i].pitch))
        }
      } else {
        handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [commit, select, reveal, track, lengthTicks, grid, bar, railed, degreeStep],
  )

  // --- the tools over the roll -----------------------------------------

  /** The selection, or every note when nothing is selected. */
  const targets = () => {
    const list = notesRef.current
    const sel = [...overlay.current.selected].filter((i) => i < list.length)
    return sel.length ? sel : list.map((_, i) => i)
  }
  const quantize = () => {
    const list = notesRef.current
    const out = quantizeNotes(list, targets(), grid, lengthTicks)
    if (!sameNotes(out.notes, list)) commit({ ...out, selected: [...overlay.current.selected] })
  }
  const humanize = () => {
    const list = notesRef.current
    const timing = Math.min(HUMANIZE_TICKS, grid / 6)
    // Math.random is fine here, unlike in the DSP: this is an edit, and what
    // it decides is written into the notes like any other.
    const out = humanizeNotes(list, targets(), timing, HUMANIZE_VELOCITY, lengthTicks, Math.random)
    commit({ ...out, selected: [...overlay.current.selected] })
  }
  const keyed = hasScale(scale)

  return (
    <div className="roll">
      <div className="roll-tools">
        <button
          className="dock-toggle"
          onClick={quantize}
          title="Snap the starts of the selected notes to the grid (every note, if none are selected)"
          type="button"
        >
          Quantize
        </button>
        <button
          className="dock-toggle"
          onClick={humanize}
          title="Nudge the selected notes a little early or late, and a little softer or harder (every note, if none are selected)"
          type="button"
        >
          Humanize
        </button>

        <label className="dock-field roll-tools-key">
          <span>Key</span>
          <select
            value={keyed ? scale.root : 0}
            disabled={!keyed}
            onChange={(e) => keyed && onScale({ ...scale, root: Number(e.target.value) })}
            aria-label="Key root"
          >
            {ROOT_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={keyed ? scale.mode : ''}
            onChange={(e) =>
              onScale(
                e.target.value
                  ? { root: keyed ? scale.root : 0, mode: e.target.value, ...(scale?.snap ? { snap: true } : {}) }
                  : undefined,
              )
            }
            aria-label="Scale"
          >
            <option value="">No scale</option>
            {SCALES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`dock-toggle${keyed && scale.snap ? ' on' : ''}`}
          onClick={() => keyed && onScale({ root: scale.root, mode: scale.mode, ...(scale.snap ? {} : { snap: true }) })}
          disabled={!keyed}
          title="Keep notes on the scale as they are drawn and moved"
          type="button"
        >
          Snap to key
        </button>

        <label className="dock-field roll-tools-key">
          <span>Chord</span>
          <select
            value={activeChord?.id ?? ''}
            onChange={(e) => setChord({ ...chord, id: e.target.value })}
            aria-label="Chord"
            title="What a click lays: one note, or every note of a chord rooted on the row clicked"
          >
            <option value="">Single note</option>
            {CHORDS.filter((c) => !c.fromKey || keyed).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={chord.inversion}
            disabled={!activeChord}
            onChange={(e) => setChord({ ...chord, inversion: Number(e.target.value) })}
            aria-label="Inversion"
            title="Which note of the chord is at the bottom"
          >
            {['Root', '1st inv', '2nd inv', '3rd inv'].map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <span className="roll-tools-hint">Alt+drag paints · right-drag erases · Ctrl+drag selects</span>
      </div>
      <div className="roll-area" ref={hostRef}>
        <canvas
          ref={canvasRef}
          className="roll-canvas"
          tabIndex={0}
          aria-label="Piano roll"
          // Where the rows are, for the browser check to aim at.
          data-row-h={view.rowH}
          data-scroll={view.scrollY}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onPointerLeave={onPointerLeave}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  )
}

/**
 * Give the roll the keyboard while the pointer is over it.
 *
 * Its shortcuts only reach it when it has focus, and focus is wherever the
 * last click was -- which, after choosing a pattern from the dropdown to
 * paste into, is the dropdown. Ctrl+V then went nowhere, and the only way to
 * get the keyboard back was a click on the roll, which draws a note. Anything
 * being typed into keeps it: a pointer drifting across the roll must not
 * pull the cursor out of the project's name.
 */
function claimKeyboard(canvas: HTMLCanvasElement) {
  const active = document.activeElement
  if (active === canvas) return
  if (active instanceof HTMLElement) {
    if (active.isContentEditable || active instanceof HTMLTextAreaElement) return
    if (active instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range'].includes(active.type)) return
  }
  canvas.focus({ preventScroll: true })
}

function velocityAt(y: number, v: RollView) {
  const into = (velTop(v) + v.velH - y) / v.velH
  return clamp(Math.round(into * 100) / 100, 0.01, 1)
}

function sameNotes(a: readonly Note[], b: readonly Note[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.tick !== y.tick ||
      x.length !== y.length ||
      x.pitch !== y.pitch ||
      x.velocity !== y.velocity ||
      x.track !== y.track
    ) {
      return false
    }
  }
  return true
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)
