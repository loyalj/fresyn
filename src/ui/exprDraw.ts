import { ExprMachine, VAR_A, VAR_B, VAR_T, VAR_X, VAR_Y, type ExprProgram } from '../dsp/Expr'

/**
 * The Expression's graph: its formula drawn on a grid, the way a graphing
 * calculator draws y = f(x).
 *
 * What runs along the bottom depends on what the formula reads. A formula
 * of x is drawn against x, from -2 to 2, with Y, t, A and B as they are now
 * -- so a shaper shows its curve, and the dot shows where the input is on
 * it. A formula of t alone is drawn against the last two seconds of t,
 * scrolling as it plays. Bytebeat is drawn against the last ticks of t, as
 * the wave it makes.
 */

export interface ExprView {
  program: ExprProgram | null
  bytebeat: boolean
  a: number
  b: number
  /** The latest from the audio thread, or null before anything has played. */
  live: { x: number; y: number; t: number; out: number } | null
  colors: { line: string; grid: string; axis: string; text: string; dot: string }
}

/** What the bottom of the graph is, for the legend. */
export function horizontalOf(view: Pick<ExprView, 'program' | 'bytebeat'>): 'x' | 't' {
  const p = view.program
  if (view.bytebeat) return 't'
  if (!p) return 'x'
  return !p.uses[VAR_X] && p.uses[VAR_T] ? 't' : 'x'
}

/** Ticks of t on the screen in bytebeat mode: an eighth of a second at 8 kHz. */
const BYTEBEAT_SPAN = 1024
/** Seconds of t on the screen when a formula of t is drawn against it. */
const TIME_SPAN = 2
/** The x the graph covers either side of zero: a CV's whole range, and some. */
const X_SPAN = 2

/** The vertical ranges the graph steps between, and its grid step at each. */
const RANGES = [
  { top: 1, step: 0.5 },
  { top: 2, step: 0.5 },
  { top: 5, step: 1 },
  { top: 10, step: 2 },
]

const machine = new ExprMachine()
let samples = new Float64Array(0)

/** The last range used, per canvas, so the scale steps up at once and back down only when it has room to spare. */
const lastRange = new WeakMap<HTMLCanvasElement, number>()

export function drawExpr(canvas: HTMLCanvasElement, view: ExprView) {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width <= 0 || height <= 0) return
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, width, height)

  const { colors, live } = view
  const along = horizontalOf(view)
  const now = live?.t ?? 0
  // The window along the bottom.
  let x0: number
  let x1: number
  if (view.bytebeat) {
    x1 = Math.max(BYTEBEAT_SPAN, Math.floor(now))
    x0 = x1 - BYTEBEAT_SPAN
  } else if (along === 't') {
    x1 = Math.max(TIME_SPAN, now)
    x0 = x1 - TIME_SPAN
  } else {
    x0 = -X_SPAN
    x1 = X_SPAN
  }

  // The curve, one value a pixel.
  const n = Math.max(2, Math.round(width))
  if (samples.length < n) samples = new Float64Array(n)
  machine.program = view.program
  machine.reseed(1)
  const vars = machine.vars
  vars[VAR_A] = view.a
  vars[VAR_B] = view.b
  vars[VAR_Y] = live?.y ?? 0
  vars[VAR_X] = live?.x ?? 0
  vars[VAR_T] = now
  let peak = 0
  for (let i = 0; i < n; i++) {
    const h = x0 + ((x1 - x0) * i) / (n - 1)
    let v: number
    if (view.bytebeat) {
      vars[VAR_T] = Math.floor(h)
      v = ((machine.run() | 0) & 255) / 127.5 - 1
    } else {
      if (along === 't') vars[VAR_T] = h
      else vars[VAR_X] = h
      v = machine.run()
      v = v > 10 ? 10 : v < -10 ? -10 : v
    }
    samples[i] = v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }

  // The vertical range: the smallest that holds the curve, stepping down
  // only once the curve fits the next size down with room to spare, so a
  // curve breathing near a boundary does not make the grid flicker.
  let r = 0
  if (!view.bytebeat) {
    while (r < RANGES.length - 1 && peak > RANGES[r].top * 1.02) r++
    const was = lastRange.get(canvas)
    if (was !== undefined && was > r && peak > RANGES[r].top * 0.7) r = was
    lastRange.set(canvas, r)
  }
  const { top, step } = RANGES[r]
  const pad = 6
  const px = (h: number) => pad + ((h - x0) / (x1 - x0)) * (width - pad * 2)
  const py = (v: number) => height / 2 - (v / top) * (height / 2 - pad)

  // The grid: a line every step up the side, every half unit (or second, or
  // 128 ticks) along the bottom, and the axes heavier.
  g.lineWidth = 1
  g.strokeStyle = colors.grid
  g.beginPath()
  for (let v = step; v < top + 1e-9; v += step) {
    for (const s of [v, -v]) {
      const y = Math.round(py(s)) + 0.5
      g.moveTo(pad, y)
      g.lineTo(width - pad, y)
    }
  }
  const hStep = view.bytebeat ? 128 : along === 't' ? 0.25 : 0.5
  for (let h = Math.ceil(x0 / hStep) * hStep; h <= x1 + 1e-9; h += hStep) {
    const x = Math.round(px(h)) + 0.5
    g.moveTo(x, pad)
    g.lineTo(x, height - pad)
  }
  g.stroke()

  g.strokeStyle = colors.axis
  g.beginPath()
  const zeroY = Math.round(py(0)) + 0.5
  g.moveTo(pad, zeroY)
  g.lineTo(width - pad, zeroY)
  if (x0 <= 0 && x1 >= 0) {
    const zeroX = Math.round(px(0)) + 0.5
    g.moveTo(zeroX, pad)
    g.lineTo(zeroX, height - pad)
  }
  g.stroke()

  // Numbers on the axes, as a calculator labels them: the top and bottom of
  // the window up the vertical axis, and whole values of x along the
  // horizontal one. A window of time has no zero on it, so its marks sit
  // at the left edge instead.
  const minus = (v: number) => (v < 0 ? `−${-v}` : `${v}`)
  g.fillStyle = colors.text
  g.font = '9px system-ui, sans-serif'
  const yAxisX = x0 <= 0 && x1 >= 0 ? px(0) : pad
  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.fillText(view.bytebeat ? '+1' : `+${top}`, yAxisX + 3, pad + 1)
  g.textBaseline = 'bottom'
  g.fillText(view.bytebeat ? '−1' : `−${top}`, yAxisX + 3, height - pad - 1)
  if (along === 'x') {
    g.textAlign = 'center'
    g.textBaseline = 'top'
    for (let h = Math.ceil(x0); h <= Math.floor(x1); h++) {
      if (h === 0) continue
      g.fillText(minus(h), px(h), zeroY + 2)
    }
  } else {
    // The time at the right edge -- now -- and at the left.
    g.textBaseline = 'top'
    const fmt = (h: number) => (view.bytebeat ? `${Math.round(h)}` : `${h.toFixed(1)} s`)
    g.textAlign = 'left'
    g.fillText(fmt(x0), pad + 2, zeroY + 2)
    g.textAlign = 'right'
    g.fillText(fmt(x1), width - pad - 2, zeroY + 2)
  }

  if (!view.program) return

  // The curve.
  g.strokeStyle = colors.line
  g.lineWidth = 1.5
  g.lineJoin = 'round'
  g.beginPath()
  for (let i = 0; i < n; i++) {
    const x = pad + ((width - pad * 2) * i) / (n - 1)
    const y = py(samples[i])
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()

  // Where the formula is right now.
  if (live) {
    const h = along === 'x' ? live.x : x1
    if (h >= x0 && h <= x1) {
      g.fillStyle = colors.dot
      g.beginPath()
      g.arc(px(h), py(Math.max(-top, Math.min(top, live.out))), 3.5, 0, Math.PI * 2)
      g.fill()
    }
  }
}
