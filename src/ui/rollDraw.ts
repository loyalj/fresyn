import { hasScale, inScale, isRoot, type Scale } from '../song/scale'
import type { Note } from '../song/types'

/**
 * Drawing the roll.
 *
 * Kept out of the component for the same reason the scope's drawing is: the
 * playhead moves thirty times a second, and putting that through React state
 * would re-render the rack at the same rate and make every knob in the room
 * feel sticky. The component renders once and this runs off refs.
 */

/** Semitones within an octave that are black keys. */
const SHARP = new Set([1, 3, 6, 8, 10])
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const isSharp = (pitch: number) => SHARP.has(((pitch % 12) + 12) % 12)
export const noteName = (pitch: number) => NAMES[((pitch % 12) + 12) % 12]

export interface RollColors {
  bg: string
  gutter: string
  keyWhite: string
  keyBlack: string
  hairline: string
  rule: string
  accent: string
  accentLine: string
  inkFaint: string
  track: string
  /** Full-strength text, for the outline that marks a note as selected. */
  ink: string
}

/**
 * Everything the drawing and the hit-testing both need.
 *
 * One object rather than a pile of arguments because the pointer handlers
 * have to invert exactly the same arithmetic the drawing uses -- a note has
 * to land under the cursor that drew it, and two copies of the geometry drift
 * apart the first time either is touched.
 */
export interface RollView {
  /** Width of the key names down the left. */
  gutterW: number
  /** Height of the bar and beat numbers across the top. */
  rulerH: number
  /** Height of one semitone row. */
  rowH: number
  /**
   * How much of the rows can be seen: the height between the ruler and the
   * velocity lane, or all the rows if they fit. The rows scroll inside it;
   * the ruler and the lane stay where they are.
   */
  viewH: number
  /** How far the rows are scrolled down from the top row, in pixels. */
  scrollY: number
  /** Height of the velocity lane under the grid. */
  velH: number
  /** How many semitone rows, counting up from the bottom. */
  keys: number
  pxPerTick: number
  /** The pattern's length, which is the whole width of the roll. */
  lengthTicks: number
  /** Ticks per beat, for the beat lines, and per bar, for the bar lines and numbers. */
  beat: number
  bar: number
  /** What a note snaps to, in ticks. */
  grid: number
  /** Where the playhead is, or null when nothing is playing. */
  playTick: number | null
  /** The key to highlight, if the song has one. */
  scale?: Scale
  /** Each track's colour, for its notes drawn behind another track's. */
  trackHues?: ReadonlyMap<string, number>
  colors: RollColors
}

/** Which part of a note the pointer is over, which decides what a drag does. */
export type NotePart = 'body' | 'start' | 'end'

/**
 * What the pointer is doing to the roll this frame. Kept apart from
 * `RollView` because it changes on every mouse move, and the view is memoised
 * on the size of the panel.
 */
export interface RollOverlay {
  /**
   * The grid cell under the pointer, or where the note being dragged will
   * land: the start of its column, and its row. Pitch is null over the ruler
   * and the velocity lane, where there is a column and no row, and the column
   * is null over the keys, where there is a row and no column.
   */
  hover: { tick: number | null; pitch: number | null } | null
  /** The note under the pointer and which part of it, for its grips. */
  hoverNote: { index: number; part: NotePart } | null
  /** Indices into the notes being drawn. */
  selected: ReadonlySet<number>
  /** The rubber band being dragged out, in canvas pixels. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  /** The key in the gutter being held down to hear it. */
  pressedKey: number | null
  /**
   * The notes a click here would lay, drawn as outlines before it is made:
   * a chord's shape, where it lands and how long it will be.
   */
  preview: { tick: number; length: number; pitches: number[] } | null
}

export const NO_OVERLAY: RollOverlay = {
  hover: null,
  hoverNote: null,
  selected: new Set(),
  marquee: null,
  pressedKey: null,
  preview: null,
}

/**
 * How wide a note's grips are at each end, in pixels.
 *
 * Six at most, and never more than a third of the note: a sixteenth at full
 * pattern width can be ten pixels across, and two six-pixel grips on it would
 * leave nothing to take hold of to move it.
 */
export const gripWidth = (widthPx: number) => Math.min(6, widthPx / 3)

/** Which part of a note an x position is in, given the note's extent. */
export function partAt(x: number, left: number, width: number): NotePart {
  const grip = gripWidth(width)
  if (x >= left + width - grip) return 'end'
  if (x < left + grip) return 'start'
  return 'body'
}

export const tickToX = (tick: number, v: RollView) => v.gutterW + tick * v.pxPerTick
export const xToTick = (x: number, v: RollView) => (x - v.gutterW) / v.pxPerTick
/** Pitch counts up, the screen counts down. */
export const pitchToY = (pitch: number, v: RollView) =>
  v.rulerH - v.scrollY + (v.keys - 1 - pitch) * v.rowH
export const yToPitch = (y: number, v: RollView) =>
  v.keys - 1 - Math.floor((y - v.rulerH + v.scrollY) / v.rowH)

/** The name a row plays, with its octave counted the way the keys are labelled. */
export const pitchName = (pitch: number) => `${noteName(pitch)}${Math.floor(pitch / 12)}`

/** The top and bottom of the visible rows, which is not the top and bottom of the rows. */
export const gridTop = (v: RollView) => v.rulerH
export const gridBottom = (v: RollView) => v.rulerH + v.viewH
/** How far the rows can scroll: none when they all fit. */
export const maxScroll = (v: RollView) => Math.max(0, v.keys * v.rowH - v.viewH)
export const velTop = (v: RollView) => gridBottom(v) + 1

export function drawRoll(
  canvas: HTMLCanvasElement,
  notes: readonly Note[],
  ghosts: readonly Note[],
  v: RollView,
  o: RollOverlay = NO_OVERLAY,
) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.scale(dpr, dpr)
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const c = v.colors

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, width, height)

  // Everything that scrolls with the rows is drawn inside their window, so a
  // row half scrolled away is cut at the ruler rather than drawn over it.
  clipToRows(ctx, width, v, () => {
    drawRows(ctx, width, v)
    drawHover(ctx, v, o)
    drawGrid(ctx, v)
    // The other tracks' notes, behind and faint: this pattern's, and whatever
    // the rest of the song plays over the same bars. Writing a bass line
    // against a drum part you cannot see is writing it blind, and they are
    // deliberately not clickable: this is a guide, not a second editor.
    drawGhosts(ctx, ghosts, v)
    drawNotes(ctx, notes, v, o)
    drawPreview(ctx, v, o)
  })
  drawVelocity(ctx, notes, v, o)
  clipToRows(ctx, width, v, () => drawGutter(ctx, v, o))
  drawScrollbar(ctx, width, v)
  drawRuler(ctx, width, v, o)
  drawMarquee(ctx, o, v)
  drawPlayhead(ctx, v)

  ctx.restore()
}

function clipToRows(ctx: CanvasRenderingContext2D, width: number, v: RollView, draw: () => void) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, gridTop(v), width, v.viewH)
  ctx.clip()
  draw()
  ctx.restore()
}

/**
 * A thin bar down the right of the rows when there are more of them than
 * fit, so it is plain there is somewhere to scroll to and roughly where in
 * the range the view is.
 */
function drawScrollbar(ctx: CanvasRenderingContext2D, width: number, v: RollView) {
  const total = v.keys * v.rowH
  if (total <= v.viewH + 0.5) return
  const top = gridTop(v)
  const thumb = Math.max(16, (v.viewH / total) * v.viewH)
  const y = top + (v.scrollY / (total - v.viewH)) * (v.viewH - thumb)
  ctx.fillStyle = v.colors.inkFaint
  ctx.globalAlpha = 0.15
  ctx.fillRect(width - 5, top, 4, v.viewH)
  ctx.globalAlpha = 0.6
  ctx.fillRect(width - 5, y, 4, thumb)
  ctx.globalAlpha = 1
}

/**
 * The rows' shading. With no key set, the black keys laid across the grid as
 * stripes. With one, the stripes follow the scale instead -- the rows off it
 * are the dark ones, whatever colour their key is -- and the tonic gets a
 * warm band, so the home note can be found at a glance in any octave.
 */
function drawRows(ctx: CanvasRenderingContext2D, width: number, v: RollView) {
  const right = Math.min(width, tickToX(v.lengthTicks, v))
  const w = right - v.gutterW
  const keyed = hasScale(v.scale)
  for (let p = 0; p < v.keys; p++) {
    const y = pitchToY(p, v)
    const dark = keyed ? !inScale(p, v.scale) : isSharp(p)
    if (dark) {
      ctx.globalAlpha = keyed ? 0.3 : 0.16
      ctx.fillStyle = v.colors.keyBlack
      ctx.fillRect(v.gutterW, y, w, v.rowH)
    }
    if (keyed && isRoot(p, v.scale)) {
      ctx.globalAlpha = 0.08
      ctx.fillStyle = v.colors.accent
      ctx.fillRect(v.gutterW, y, w, v.rowH)
    }
  }
  ctx.globalAlpha = 1
}

/**
 * The row and the column under the pointer, a shade lighter than the rest, so
 * a note can be lined up with the one three bars away without counting lines.
 * A whole grid cell wide rather than a hairline, because the cell is where a
 * note drawn there would land.
 */
function drawHover(ctx: CanvasRenderingContext2D, v: RollView, o: RollOverlay) {
  if (!o.hover) return
  const right = tickToX(v.lengthTicks, v)
  ctx.fillStyle = v.colors.inkFaint
  ctx.globalAlpha = 0.12
  if (o.hover.tick !== null) {
    ctx.fillRect(tickToX(o.hover.tick, v), gridTop(v), cellWidth(o.hover.tick, v), v.viewH)
  }
  const pitch = o.hover.pitch
  if (pitch !== null && pitch >= 0 && pitch < v.keys) {
    ctx.fillRect(v.gutterW, pitchToY(pitch, v), right - v.gutterW, v.rowH)
  }
  ctx.globalAlpha = 1
}

/** One grid cell from `tick`, cut short where the pattern ends. */
const cellWidth = (tick: number, v: RollView) =>
  Math.max(0, Math.min(v.grid, v.lengthTicks - tick)) * v.pxPerTick

function drawGrid(ctx: CanvasRenderingContext2D, v: RollView) {
  const top = gridTop(v)
  const bottom = gridBottom(v)

  // Every division of the snap grid, then beats over the top of them, then
  // bars over those: three weights, so the eye can count without reading the
  // numbers along the ruler.
  for (let tick = 0; tick <= v.lengthTicks; tick += v.grid) {
    const onBar = tick % v.bar === 0
    const onBeat = tick % v.beat === 0
    ctx.strokeStyle = onBar ? v.colors.rule : v.colors.hairline
    ctx.globalAlpha = onBar ? 1 : onBeat ? 0.8 : 0.35
    ctx.lineWidth = 1
    const x = Math.round(tickToX(tick, v)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
    ctx.stroke()
  }

  // An octave line every twelve semitones, so two octaves of rows do not read
  // as one undifferentiated field.
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = v.colors.rule
  for (let p = 0; p < v.keys; p += 12) {
    const y = Math.round(pitchToY(p, v) + v.rowH) + 0.5
    ctx.beginPath()
    ctx.moveTo(v.gutterW, y)
    ctx.lineTo(tickToX(v.lengthTicks, v), y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  notes: readonly Note[],
  v: RollView,
  o: RollOverlay,
) {
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (n.pitch < 0 || n.pitch >= v.keys) continue
    const x = tickToX(n.tick, v)
    const y = pitchToY(n.pitch, v)
    const w = Math.max(2, n.length * v.pxPerTick)
    const h = Math.max(2, v.rowH - 1)

    // Velocity reads as weight rather than as a number on the note: at this
    // size there is no room for a number, and the point of seeing it here at
    // all is to spot the one that is wrong at a glance.
    ctx.globalAlpha = 0.4 + 0.6 * clamp01(n.velocity)
    ctx.fillStyle = v.colors.accent
    ctx.fillRect(x, y, w, h)
    ctx.globalAlpha = 1

    drawGrips(ctx, x, y, w, h, o.hoverNote?.index === i ? o.hoverNote.part : null, v)
    drawName(ctx, n.pitch, x, y, w, h, v)

    // Selected is an outline in the room's own ink, heavier than the note's
    // edge: it has to read against the accent in every theme, and on a quiet
    // note as well as a loud one.
    if (o.selected.has(i)) {
      ctx.strokeStyle = v.colors.ink
      ctx.lineWidth = 2
      ctx.strokeRect(Math.round(x) + 1, Math.round(y) + 1, Math.max(1, Math.round(w) - 2), Math.max(1, Math.round(h) - 2))
      ctx.lineWidth = 1
    } else {
      ctx.strokeStyle = v.colors.accentLine
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1)
    }
  }
}

/**
 * The two ends of a note, drawn as a pair of short ridges, so where to take
 * hold to stretch it is something you can see rather than something you find
 * by hovering until the cursor changes. Faint on every note, and lit on the
 * end under the pointer.
 */
function drawGrips(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  hovered: NotePart | null,
  v: RollView,
) {
  const grip = gripWidth(w)
  // Dark on the accent, in every theme: `--key-black` is kept dark
  // everywhere, and the room's ink is light in a dark theme, which vanished
  // into an orange note.
  ctx.fillStyle = v.colors.keyBlack
  // Too small to carry ridges and still show a note between them. The grips
  // are there to take hold of all the same, the cursor says so, and the end
  // under the pointer still lights.
  if (w < 12 || h < 6) {
    if (hovered === 'start' || hovered === 'end') {
      ctx.globalAlpha = 0.5
      ctx.fillRect(hovered === 'end' ? x + w - grip : x, y, grip, h)
      ctx.globalAlpha = 1
    }
    return
  }
  const inset = Math.max(1, Math.round(h * 0.25))
  for (const part of ['start', 'end'] as const) {
    const gx = part === 'start' ? x : x + w - grip
    if (hovered === part) {
      ctx.globalAlpha = 0.35
      ctx.fillRect(gx, y, grip, h)
    }
    ctx.globalAlpha = hovered === part ? 0.9 : 0.45
    const ridge = Math.round(gx + grip / 2 - 1.5)
    ctx.fillRect(ridge, y + inset, 1, h - inset * 2)
    ctx.fillRect(ridge + 2, y + inset, 1, h - inset * 2)
  }
  ctx.globalAlpha = 1
}

/**
 * The note's name inside it, so a line reads as notes rather than as
 * positions. Only where it fits whole: a name cut in half is worse than none,
 * and the key down the side still says which row it is.
 */
function drawName(
  ctx: CanvasRenderingContext2D,
  pitch: number,
  x: number,
  y: number,
  w: number,
  h: number,
  v: RollView,
) {
  if (h < 10) return
  const size = Math.min(11, Math.floor(h - 3))
  ctx.font = `600 ${size}px "Inter", system-ui, sans-serif`
  const text = pitchName(pitch)
  const inset = gripWidth(w) + 2
  if (ctx.measureText(text).width > w - inset * 2) return
  // Dark on the accent in every theme, for the same reason the grips are.
  ctx.fillStyle = v.colors.keyBlack
  ctx.globalAlpha = 0.85
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + inset, y + h / 2 + 0.5)
  ctx.globalAlpha = 1
}

function drawGhosts(ctx: CanvasRenderingContext2D, notes: readonly Note[], v: RollView) {
  if (notes.length === 0) return
  for (const n of notes) {
    if (n.pitch < 0 || n.pitch >= v.keys) continue
    // A track with a colour shows it here, so with three parts behind the one
    // being written it is plain which is the bass and which the drums.
    const hue = v.trackHues?.get(n.track)
    ctx.globalAlpha = hue === undefined ? 0.18 : 0.32
    ctx.fillStyle = hue === undefined ? v.colors.inkFaint : `hsl(${hue} 62% 55%)`
    ctx.fillRect(
      tickToX(n.tick, v),
      pitchToY(n.pitch, v),
      Math.max(2, n.length * v.pxPerTick),
      Math.max(2, v.rowH - 1),
    )
  }
  ctx.globalAlpha = 1
}

function drawVelocity(
  ctx: CanvasRenderingContext2D,
  notes: readonly Note[],
  v: RollView,
  o: RollOverlay,
) {
  if (v.velH <= 0) return
  const top = velTop(v)
  ctx.fillStyle = v.colors.track
  ctx.globalAlpha = 0.5
  ctx.fillRect(v.gutterW, top, tickToX(v.lengthTicks, v) - v.gutterW, v.velH)
  ctx.globalAlpha = 1

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    const x = tickToX(n.tick, v)
    const h = Math.max(1, clamp01(n.velocity) * v.velH)
    // The selection's bars in ink, so which of them a drag in the lane will
    // move together is plain before it starts.
    ctx.fillStyle = o.selected.has(i) ? v.colors.ink : v.colors.accent
    ctx.fillRect(x, top + v.velH - h, Math.max(2, Math.min(5, n.length * v.pxPerTick)), h)
  }

  ctx.strokeStyle = v.colors.rule
  ctx.globalAlpha = 0.6
  ctx.beginPath()
  ctx.moveTo(v.gutterW, Math.round(top) + 0.5)
  ctx.lineTo(tickToX(v.lengthTicks, v), Math.round(top) + 0.5)
  ctx.stroke()
  ctx.globalAlpha = 1
}

/** The keyboard down the left, which is what says which row is which note. */
function drawGutter(ctx: CanvasRenderingContext2D, v: RollView, o: RollOverlay) {
  ctx.fillStyle = v.colors.gutter
  ctx.fillRect(0, gridTop(v), v.gutterW, v.viewH)
  // Every white key is named once the rows are tall enough to carry it;
  // below that only the Cs, which are enough to count from.
  const nameAll = v.rowH >= 13

  ctx.font = '9px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (let p = 0; p < v.keys; p++) {
    const y = pitchToY(p, v)
    const black = isSharp(p)
    const keyW = v.gutterW - (black ? v.gutterW * 0.35 : 0)
    ctx.fillStyle = black ? v.colors.keyBlack : v.colors.keyWhite
    ctx.fillRect(0, y, keyW, v.rowH - 1)

    // The key's tonic, marked down the edge of its key.
    if (isRoot(p, v.scale)) {
      ctx.fillStyle = v.colors.accent
      ctx.fillRect(0, y, 3, v.rowH - 1)
    } else if (!inScale(p, v.scale)) {
      // Off the scale: dimmed, so the keys that belong read as a set.
      ctx.fillStyle = v.colors.gutter
      ctx.globalAlpha = 0.45
      ctx.fillRect(0, y, keyW, v.rowH - 1)
      ctx.globalAlpha = 1
    }

    // The key being held down, and the row the pointer is on: the first is
    // what you are hearing, the second is what a click there would play.
    if (o.pressedKey === p || o.hover?.pitch === p) {
      ctx.fillStyle = v.colors.accent
      ctx.globalAlpha = o.pressedKey === p ? 0.85 : 0.35
      ctx.fillRect(0, y, keyW, v.rowH - 1)
      ctx.globalAlpha = 1
    }

    // Lettered in the black keys' colour rather than the room's ink, because
    // it is printed on a white key: `--ink` is light in a dark theme, which
    // put the labels on a pale key in a colour almost exactly as pale. Every
    // theme keeps `--key-black` dark, for the obvious reason. The Cs are
    // heavier, so the octaves still stand out when every key is named.
    if (p % 12 === 0 || (nameAll && !black)) {
      ctx.fillStyle = v.colors.keyBlack
      ctx.globalAlpha = p % 12 === 0 ? 1 : 0.6
      ctx.font = `${p % 12 === 0 ? '600 ' : ''}9px "Inter", system-ui, sans-serif`
      ctx.textAlign = 'right'
      ctx.fillText(pitchName(p), v.gutterW - 4, y + v.rowH / 2)
      ctx.globalAlpha = 1
    }
  }

  ctx.strokeStyle = v.colors.rule
  ctx.beginPath()
  ctx.moveTo(Math.round(v.gutterW) + 0.5, gridTop(v))
  ctx.lineTo(Math.round(v.gutterW) + 0.5, gridBottom(v))
  ctx.stroke()
}

function drawRuler(ctx: CanvasRenderingContext2D, width: number, v: RollView, o: RollOverlay) {
  ctx.fillStyle = v.colors.gutter
  ctx.fillRect(0, 0, width, v.rulerH)
  if (o.hover && o.hover.tick !== null) {
    ctx.fillStyle = v.colors.inkFaint
    ctx.globalAlpha = 0.25
    ctx.fillRect(tickToX(o.hover.tick, v), 0, cellWidth(o.hover.tick, v), v.rulerH)
    ctx.globalAlpha = 1
  }
  ctx.font = '9px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  const bar = v.bar
  for (let tick = 0, n = 1; tick < v.lengthTicks; tick += bar, n++) {
    const x = tickToX(tick, v)
    ctx.strokeStyle = v.colors.rule
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, v.rulerH)
    ctx.stroke()
    ctx.fillStyle = v.colors.inkFaint
    ctx.fillText(String(n), x + 3, v.rulerH / 2)
  }

  ctx.strokeStyle = v.colors.rule
  ctx.beginPath()
  ctx.moveTo(0, Math.round(v.rulerH) + 0.5)
  ctx.lineTo(width, Math.round(v.rulerH) + 0.5)
  ctx.stroke()
}

/** The rubber band a Ctrl+drag pulls out. */
/**
 * Where a click would put its notes: the accent, faint, inside a dashed
 * edge, with the names on -- a chord you can read before you commit to it.
 */
function drawPreview(ctx: CanvasRenderingContext2D, v: RollView, o: RollOverlay) {
  const p = o.preview
  if (!p) return
  const x = tickToX(p.tick, v)
  const w = Math.max(2, p.length * v.pxPerTick)
  const h = Math.max(2, v.rowH - 1)
  ctx.lineWidth = 1
  ctx.setLineDash([3, 2])
  for (const pitch of p.pitches) {
    if (pitch < 0 || pitch >= v.keys) continue
    const y = pitchToY(pitch, v)
    ctx.fillStyle = v.colors.accent
    ctx.globalAlpha = 0.22
    ctx.fillRect(x, y, w, h)
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = v.colors.accentLine
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1)
    if (h >= 10) {
      const size = Math.min(11, Math.floor(h - 3))
      ctx.font = `600 ${size}px "Inter", system-ui, sans-serif`
      const text = pitchName(pitch)
      if (ctx.measureText(text).width <= w - 6) {
        ctx.fillStyle = v.colors.accent
        ctx.globalAlpha = 0.95
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + 3, y + h / 2 + 0.5)
      }
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

function drawMarquee(ctx: CanvasRenderingContext2D, o: RollOverlay, v: RollView) {
  const m = o.marquee
  if (!m) return
  const x = Math.min(m.x0, m.x1)
  const y = Math.min(m.y0, m.y1)
  const w = Math.abs(m.x1 - m.x0)
  const h = Math.abs(m.y1 - m.y0)
  ctx.fillStyle = v.colors.accent
  ctx.globalAlpha = 0.12
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = v.colors.accentLine
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

function drawPlayhead(ctx: CanvasRenderingContext2D, v: RollView) {
  if (v.playTick === null) return
  const x = Math.round(tickToX(v.playTick, v)) + 0.5
  ctx.strokeStyle = v.colors.accentLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, velTop(v) + v.velH)
  ctx.stroke()
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
