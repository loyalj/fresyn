import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import type { LiveNotes } from '../input/liveNotes'
import { loadPrefs, savePrefs } from '../patch/storage'
import {
  arpeggiateNotes,
  chopNotes,
  copyNotes,
  duplicateNotes,
  flamNotes,
  humanizeNotes,
  moveNotes,
  notesIn,
  pasteNotes,
  quantizeNotes,
  randomizePitches,
  removeNotes,
  reverseNotes,
  shiftVelocity,
  stretchEnds,
  stretchStarts,
  strumNotes,
  transposeNotes,
  type Edited,
  type QuantizeWhat,
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
import { midiNameCents, rowZero, scaleForRows, type Tuning } from '../song/tuning'
import { PITCH_RANGE, type Note, type Swing } from '../song/types'
import {
  drawRoll,
  gridBottom,
  gridTop,
  highPitch,
  maxScroll,
  SCROLL_W,
  scrollThumb,
  partAt,
  pitchToY,
  spanX,
  tickToX,
  velTop,
  xToTick,
  yToPitch,
  type NotePart,
  type RollColors,
  type RollOverlay,
  type RollView,
} from './rollDraw'
import { ContextMenu, type MenuItem } from './Menu'
import { useAppearance } from './ThemeContext'
import { useNoteRecording } from './useNoteRecording'

/**
 * Rows, bottom and top: the full range, well past the Keyboard's own two
 * octaves, so a part is never cut off by the panel it happens to be played on.
 */
const LOW = PITCH_RANGE.low
const HIGH = PITCH_RANGE.high
const ROWS = HIGH - LOW + 1
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
/** The row an empty track opens centred on: C1, the middle of the Keyboard. */
const HOME_PITCH = 12
/**
 * The row a track opens centred on: the middle of its notes, since with the
 * whole range to scroll through they could be anywhere, or the Keyboard's
 * middle when it has none yet.
 */
const middleOf = (notes: readonly Note[]) => {
  if (notes.length === 0) return HOME_PITCH
  let low = Infinity
  let high = -Infinity
  for (const n of notes) {
    if (n.pitch < low) low = n.pitch
    if (n.pitch > high) high = n.pitch
  }
  return clamp(Math.round((low + high) / 2), LOW, HIGH)
}
/**
 * How many rows one notch of a mouse wheel moves. A notch is a fixed jump
 * that the OS sizes for pages of text -- a hundred pixels or a whole screen --
 * which in a short dock is most of what can be seen. Three rows is enough to
 * travel and few enough to land where you meant.
 */
const NOTCH_ROWS = 3
/**
 * Anything this big from a wheel in one event is a notch rather than a
 * trackpad's stream, which arrives a few pixels at a time and is followed
 * exactly.
 */
const NOTCH_PX = 50
/** How long a notch takes to glide to where it is going, in ms. */
const GLIDE_MS = 110
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
/**
 * How far apart a strum's strings are, and how far ahead of its note a flam's
 * grace note sits: about fifteen and twenty-five milliseconds at 120, which
 * is a hand's width rather than a rhythm.
 */
const STRUM_TICKS = 28
const FLAM_TICKS = 48
/**
 * The Tools menu: what each does is in its name, because an option in a
 * dropdown has nowhere to put a tooltip.
 */
const TOOLS = [
  ['chop', 'Chop into grid steps'],
  ['strum-up', 'Strum up'],
  ['strum-down', 'Strum down'],
  ['arp-up', 'Arpeggiate up'],
  ['arp-down', 'Arpeggiate down'],
  ['flam', 'Flam'],
  ['reverse', 'Reverse'],
  ['random', 'Randomize pitch'],
] as const
type Tool = (typeof TOOLS)[number][0]
/** What Quantize can move, in the order its menu lists them. */
const QUANTIZE_WHAT: [QuantizeWhat, string][] = [
  ['start', 'Starts'],
  ['end', 'Ends'],
  ['both', 'Starts and ends'],
  ['length', 'Lengths'],
]
const QUANTIZE_STRENGTHS = [1, 0.75, 0.5, 0.25]
/** How Quantize is set up, remembered with the other preferences. */
export interface QuantizeSetup {
  what: QuantizeWhat
  strength: number
  /** Notes played in while recording are quantized as they land. */
  onInput: boolean
}
const DEFAULT_QUANTIZE: QuantizeSetup = { what: 'start', strength: 1, onInput: false }
const loadQuantize = (): QuantizeSetup => {
  const q = loadPrefs().quantize
  return {
    what: QUANTIZE_WHAT.some(([id]) => id === q?.what) ? q!.what : DEFAULT_QUANTIZE.what,
    strength: QUANTIZE_STRENGTHS.includes(q?.strength ?? NaN) ? q!.strength : DEFAULT_QUANTIZE.strength,
    onInput: q?.onInput === true,
  }
}
/** The same notes in any order, so a transform that only shuffled the list is not an edit. */
const sameSet = (a: readonly Note[], b: readonly Note[]) => {
  const order = (x: Note, y: Note) => x.tick - y.tick || x.pitch - y.pitch || x.length - y.length || x.velocity - y.velocity
  return sameNotes([...a].sort(order), [...b].sort(order))
}
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
  /** The song's key, in the notes you hear rather than this track's rows. */
  scale: Scale | undefined
  onScale: (scale: Scale | undefined) => void
  /** What this track's Keyboard plays, to name the rows by; null names them by key position. */
  tuning: Tuning | null
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
  /** Notes being played by hand, which the Rec button writes in. */
  live: LiveNotes
  /** Write one played-in note into the pattern; see `useNoteRecording`. */
  onRecord: (note: Note, take: string) => void
  /**
   * The pattern's swing, to draw it as it sounds; absent draws the written
   * grid. Only ever the drawing: the notes handed back are on the grid.
   */
  swing?: Swing
}

type Gesture =
  /** The scroll bar's thumb, held `grab` pixels below its top. */
  | { kind: 'scrollbar'; grab: number }
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
  scale: songScale,
  swing,
  onScale,
  tuning,
  trackHues,
  playOffset,
  onChange,
  transport,
  live,
  onRecord,
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
  /** Pixels scrolled from the top row, or null to sit centred on `homePitch`. */
  const [scroll, setScroll] = useState<number | null>(null)
  /** The MIDI note the bottom key sounds, and the key as this track's rows count it. */
  const zero = rowZero(tuning)
  const scale = useMemo(() => scaleForRows(songScale, zero), [songScale, zero])
  /**
   * The row the view centres on until it is scrolled. Taken when a track
   * comes onto the bench rather than worked out afresh from the notes, or the
   * rows would slide under the pointer with every note drawn.
   */
  const [homePitch, setHomePitch] = useState(() => middleOf(notes))
  const [benched, setBenched] = useState(track)
  if (benched !== track) {
    setBenched(track)
    setScroll(null)
    setHomePitch(middleOf(notes))
  }

  const view = useMemo<RollView>(() => {
    const room = Math.max(1, size.h - RULER_H - VEL_H - 2)
    // Never shorter than asked, and taller when the dock has room to spare
    // -- a tall dock with the rows huddled at the top of it would be space
    // thrown away.
    const rowH = Math.min(MAX_ROW_H, Math.max(rowZoom, room / ROWS))
    const viewH = Math.min(room, ROWS * rowH)
    const top = Math.max(0, ROWS * rowH - viewH)
    const home = (HIGH - homePitch) * rowH + rowH / 2 - viewH / 2
    return {
      gutterW: GUTTER_W,
      rulerH: RULER_H,
      rowH,
      viewH,
      scrollY: clamp(scroll ?? home, 0, top),
      scrollW: top > 0.5 ? SCROLL_W : 0,
      velH: VEL_H,
      low: LOW,
      keys: ROWS,
      rowZero: zero,
      // The pattern always fills the width. With one pattern on the bench
      // there is nothing to scroll to, and a roll that fits is a roll whose
      // every note can be reached without moving anything first.
      pxPerTick: (size.w - GUTTER_W - (top > 0.5 ? SCROLL_W : 0)) / Math.max(1, lengthTicks),
      lengthTicks,
      beat,
      bar,
      grid,
      playTick: null,
      scale,
      trackHues,
      colors: colors.current,
      swing,
    }
  }, [size, lengthTicks, grid, bar, beat, rowZoom, scroll, homePitch, zero, scale, trackHues, swing])

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

  /**
   * A wheel notch in flight: where it is going, and where it set out from
   * and when. Another notch while it glides goes on from where this one was
   * going, so a quick spin adds up rather than being cut short.
   */
  const glide = useRef<{ from: number; to: number; start: number; raf: number } | null>(null)
  const stopGlide = useCallback(() => {
    const g = glide.current
    if (!g) return
    cancelAnimationFrame(g.raf)
    glide.current = null
    // For the browser check, which waits for the rows to come to rest.
    delete canvasRef.current?.dataset.gliding
  }, [])
  /** Scroll straight to a place, dropping any glide on its way somewhere else. */
  const scrollTo = useCallback(
    (px: number) => {
      stopGlide()
      setScroll(px)
    },
    [stopGlide],
  )
  const glideTo = useCallback((to: number) => {
    const now = performance.now()
    const g = glide.current
    if (g) cancelAnimationFrame(g.raf)
    const from = viewRef.current.scrollY
    const step = () => {
      const t = Math.min(1, (performance.now() - now) / GLIDE_MS)
      // Eased out: quick to start, so it answers the hand, and gentle to stop.
      const eased = 1 - Math.pow(1 - t, 3)
      setScroll(from + (to - from) * eased)
      if (t < 1) glide.current = { from, to, start: now, raf: requestAnimationFrame(step) }
      else {
        glide.current = null
        delete canvasRef.current?.dataset.gliding
      }
    }
    glide.current = { from, to, start: now, raf: requestAnimationFrame(step) }
    if (canvasRef.current) canvasRef.current.dataset.gliding = '1'
  }, [])
  useEffect(() => stopGlide, [stopGlide])

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
      const dy = e.deltaY

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
        scrollTo(row * next - into)
        return
      }

      // The wheel is the roll's whenever the pointer is over it, even with
      // nowhere left to scroll: letting it through at the top or the bottom
      // would scroll the rack behind instead, and the rack moving under a
      // hand that is working in the roll is the last thing it expects.
      e.preventDefault()
      const top = maxScroll(v)
      if (top <= 0 || dy === 0) return

      // A notch glides a few rows, by the pixel, rather than jumping.
      if (e.deltaMode !== 0 || Math.abs(dy) >= NOTCH_PX) {
        const from = glide.current?.to ?? v.scrollY
        const to = clamp(from + Math.sign(dy) * NOTCH_ROWS * v.rowH, 0, top)
        if (to !== from) glideTo(to)
        return
      }
      // A trackpad's stream is followed pixel for pixel, as it arrives.
      const next = clamp(v.scrollY + dy, 0, top)
      if (next !== v.scrollY) scrollTo(next)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [glideTo, scrollTo])

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
        const width = Math.max(3, spanX(n.tick, n.length, v))
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
      const p = clamp(pitch, LOW, HIGH)
      if (!railed) return p
      const q = nearestInScale(p, scale)
      if (q >= LOW && q <= HIGH) return q
      // The nearest was off the end of the rows; the nearest the other way is not.
      const dir = q < LOW ? 1 : -1
      let r = p
      while (r >= LOW && r <= HIGH && !inScale(r, scale)) r += dir
      return clamp(r, LOW, HIGH)
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
    (root: number) => (activeChord ? chordPitches(root, activeChord, chord.inversion, scale, PITCH_RANGE) : [root]),
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

      // Over the scroll bar there is nothing to draw or pick: the bar lights.
      const bar = canvas ? scrollThumb(v, canvas.clientWidth) : null
      if (bar && x >= bar.x && inGrid) {
        overlay.current = { ...overlay.current, hover: null, hoverNote: null, preview: null, scrollbar: 'hover' }
        if (canvas && canvas.style.cursor !== 'default') canvas.style.cursor = 'default'
        return
      }
      if (overlay.current.scrollbar) overlay.current = { ...overlay.current, scrollbar: null }

      const inRoll = x >= v.gutterW && x <= tickToX(v.lengthTicks, v)
      const pitch = inGrid ? clamp(yToPitch(y, v), LOW, HIGH) : null
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

      // The scroll bar: the thumb is dragged from wherever it was taken hold
      // of, and a click on the track jumps it there, centred, and keeps hold.
      const bar = scrollThumb(v, e.currentTarget.clientWidth)
      if (bar && x >= bar.x) {
        if (e.button !== 0 || y < bar.top || y > bar.top + v.viewH) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const onThumb = y >= bar.y && y <= bar.y + bar.h
        const grab = onThumb ? y - bar.y : bar.h / 2
        gesture.current = { kind: 'scrollbar', grab }
        overlay.current = { ...overlay.current, hover: null, hoverNote: null, preview: null, scrollbar: 'drag' }
        if (!onThumb) scrollTo(clamp(((y - grab - bar.top) / bar.range) * bar.max, 0, bar.max))
        return
      }

      // A key down the side: heard for as long as it is held, and dragged
      // down the keys it plays each one it crosses, as a real keyboard would.
      if (x < v.gutterW) {
        if (e.button !== 0 || y < gridTop(v) || y > gridBottom(v)) return
        const pitch = clamp(yToPitch(y, v), LOW, HIGH)
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

      if (g.kind === 'scrollbar') {
        const bar = scrollThumb(v, e.currentTarget.clientWidth)
        if (bar) scrollTo(clamp(((y - g.grab - bar.top) / bar.range) * bar.max, 0, bar.max))
        return
      }

      if (g.kind === 'key') {
        const pitch = clamp(yToPitch(y, v), LOW, HIGH)
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
        const low = clamp(yToPitch(Math.max(y0, y1), v), LOW, HIGH)
        const high = clamp(yToPitch(Math.min(y0, y1), v), LOW, HIGH)
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
              moveNotes(g.origin, g.sel, dTick, 0, lengthTicks, PITCH_RANGE).notes,
              g.sel,
              degreesBetween(a.pitch, clamp(target, LOW, HIGH), scale),
              PITCH_RANGE,
              degreeStep,
            )
          : moveNotes(g.origin, g.sel, dTick, target - a.pitch, lengthTicks, PITCH_RANGE)
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

    if (g.kind === 'scrollbar') {
      const over = pointer.current
      const bar = scrollThumb(viewRef.current, canvasRef.current?.clientWidth ?? 0)
      overlay.current = { ...overlay.current, scrollbar: over && bar && over.x >= bar.x ? 'hover' : null }
      return
    }

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
    overlay.current = { ...overlay.current, hover: null, hoverNote: null, preview: null, scrollbar: null }
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
    const top = (highPitch(v) - high) * v.rowH
    const bottom = (highPitch(v) - low + 1) * v.rowH
    if (top < v.scrollY) scrollTo(top)
    else if (bottom > v.scrollY + v.viewH) scrollTo(Math.min(top, bottom - v.viewH))
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
        if (sel.length) commit(moveNotes(list, sel, key === 'arrowleft' ? -step : step, 0, lengthTicks, PITCH_RANGE))
      } else if (!ctrl && (key === 'arrowup' || key === 'arrowdown')) {
        // A semitone, or an octave with Shift -- or with the key as a rail, a
        // step along the scale.
        const step = e.shiftKey ? 12 : 1
        const sign = key === 'arrowdown' ? -1 : 1
        if (sel.length) {
          const out =
            railed && !e.shiftKey
              ? transposeNotes(list, sel, sign, PITCH_RANGE, degreeStep)
              : moveNotes(list, sel, 0, sign * step, lengthTicks, PITCH_RANGE)
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
  const [quant, setQuantState] = useState(loadQuantize)
  const setQuant = (next: QuantizeSetup) => {
    setQuantState(next)
    savePrefs({ quantize: next })
  }
  /** Where the Quantize menu is open, if it is. */
  const [quantMenu, setQuantMenu] = useState<{ x: number; y: number } | null>(null)
  const quantize = () => {
    const list = notesRef.current
    const out = quantizeNotes(list, targets(), grid, lengthTicks, quant)
    if (!sameNotes(out.notes, list)) commit({ ...out, selected: [...overlay.current.selected] })
  }
  const quantizeItems: MenuItem[] = [
    ...QUANTIZE_WHAT.map(([id, name]): MenuItem => ({
      kind: 'toggle',
      label: `Quantize ${name.toLowerCase()}`,
      checked: quant.what === id,
      onSelect: () => setQuant({ ...quant, what: id }),
    })),
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: `Strength ${Math.round(quant.strength * 100)}%`,
      items: QUANTIZE_STRENGTHS.map((k): MenuItem => ({
        kind: 'toggle',
        label: `${Math.round(k * 100)}%`,
        checked: quant.strength === k,
        onSelect: () => setQuant({ ...quant, strength: k }),
      })),
    },
    { kind: 'separator' },
    {
      kind: 'toggle',
      label: 'Quantize while recording',
      checked: quant.onInput,
      onSelect: () => setQuant({ ...quant, onInput: !quant.onInput }),
    },
  ]
  const recording = useNoteRecording({
    live,
    transport,
    track,
    lengthTicks,
    zero: Number.isFinite(playOffset) ? playOffset : 0,
    quantize: quant.onInput && !snapOff ? { grid, what: quant.what, strength: quant.strength } : undefined,
    onRecord,
  })
  const quantTitle =
    `Snap the ${quant.what === 'start' ? 'starts' : quant.what === 'end' ? 'ends' : quant.what === 'both' ? 'starts and ends' : 'lengths'}` +
    ` of the selected notes to the grid${quant.strength < 1 ? `, ${Math.round(quant.strength * 100)}% of the way` : ''}` +
    ' (every note, if none are selected)'
  const humanize = () => {
    const list = notesRef.current
    const timing = Math.min(HUMANIZE_TICKS, grid / 6)
    // Math.random is fine here, unlike in the DSP: this is an edit, and what
    // it decides is written into the notes like any other.
    const out = humanizeNotes(list, targets(), timing, HUMANIZE_VELOCITY, lengthTicks, Math.random)
    commit({ ...out, selected: [...overlay.current.selected] })
  }
  /**
   * One of the Tools menu's transforms, on the selection or every note, as
   * one step of undo. What it made is left selected when there was a
   * selection to begin with, so two in a row act on the same notes.
   */
  const transform = (tool: Tool) => {
    const list = notesRef.current
    const sel = targets()
    const step = Math.max(1, grid)
    const onScale = (p: number) => (hasScale(scale) ? nearestInScale(p, scale) : p)
    const out =
      tool === 'chop' ? chopNotes(list, sel, step)
      : tool === 'strum-up' ? strumNotes(list, sel, STRUM_TICKS, false)
      : tool === 'strum-down' ? strumNotes(list, sel, STRUM_TICKS, true)
      : tool === 'arp-up' ? arpeggiateNotes(list, sel, step, false, lengthTicks)
      : tool === 'arp-down' ? arpeggiateNotes(list, sel, step, true, lengthTicks)
      : tool === 'flam' ? flamNotes(list, sel, FLAM_TICKS)
      : tool === 'reverse' ? reverseNotes(list, sel)
      : randomizePitches(list, sel, PITCH_RANGE, onScale, Math.random)
    if (sameSet(out.notes, list)) return
    commit(overlay.current.selected.size ? out : { ...out, selected: [] })
  }
  const keyed = hasScale(songScale)

  return (
    <div className="roll">
      <div className="roll-tools">
        <button
          className={`dock-toggle roll-rec${recording.armed ? ' on' : ''}`}
          onClick={() => recording.toggle(Number.isFinite(playOffset) ? playOffset : 0)}
          aria-pressed={recording.armed}
          title={
            recording.armed
              ? 'Stop recording (the loop keeps playing)'
              : 'Record: play the Keyboard, a Trigger or a MIDI controller and the notes are written in at the playhead'
          }
          type="button"
        >
          ● Rec
        </button>
        <span className="roll-split">
          <button className="dock-toggle" onClick={quantize} title={quantTitle} type="button">
            Quantize
          </button>
          <button
            className="dock-toggle roll-split-more"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setQuantMenu(quantMenu ? null : { x: r.left, y: r.bottom + 2 })
            }}
            aria-label="Quantize settings"
            aria-haspopup="menu"
            aria-expanded={quantMenu !== null}
            title="What Quantize moves, how far, and whether it quantizes as you record"
            type="button"
          >
            ▾
          </button>
        </span>
        {quantMenu && (
          <ContextMenu x={quantMenu.x} y={quantMenu.y} items={quantizeItems} onClose={() => setQuantMenu(null)} />
        )}
        <button
          className="dock-toggle"
          onClick={humanize}
          title="Nudge the selected notes a little early or late, and a little softer or harder (every note, if none are selected)"
          type="button"
        >
          Humanize
        </button>
        <select
          className="roll-tools-menu"
          value=""
          onChange={(e) => {
            const tool = e.target.value as Tool | ''
            if (tool) transform(tool)
            // Back to its label, so the same tool can be chosen twice running.
            e.target.value = ''
          }}
          aria-label="Tools"
          title="Transform the selected notes (every note, if none are selected)"
        >
          <option value="">Tools…</option>
          {TOOLS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>

        <label className="dock-field roll-tools-key">
          <span>Key</span>
          <select
            value={keyed ? songScale.root : 0}
            disabled={!keyed}
            onChange={(e) => keyed && onScale({ ...songScale, root: Number(e.target.value) })}
            aria-label="Key root"
          >
            {ROOT_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={keyed ? songScale.mode : ''}
            onChange={(e) =>
              onScale(
                e.target.value
                  ? { root: keyed ? songScale.root : 0, mode: e.target.value, ...(songScale?.snap ? { snap: true } : {}) }
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
          className={`dock-toggle${keyed && songScale.snap ? ' on' : ''}`}
          onClick={() => keyed && onScale({ root: songScale.root, mode: songScale.mode, ...(songScale.snap ? {} : { snap: true }) })}
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
        <span
          className="roll-tools-tuning"
          title={
            tuning
              ? `The rows are named by the notes they sound: read from ${tuning.source}'s Pitch and Octave, and the Keyboard's Octave`
              : "Nothing tuned is patched to the Keyboard's Pitch, so the rows are named by key position"
          }
        >
          {tuning ? `Bottom key ${midiNameCents(zero)} · ${tuning.source}` : 'Rows by key position'}
        </span>
      </div>
      <div className="roll-area" ref={hostRef}>
        <canvas
          ref={canvasRef}
          className="roll-canvas"
          tabIndex={0}
          aria-label="Piano roll"
          // Where the rows are, for the browser check to aim at.
          data-row-h={view.rowH}
          data-high={highPitch(view)}
          data-rows={view.keys}
          data-row-zero={zero}
          data-scroll={view.scrollY}
          data-scroll-w={view.scrollW}
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
