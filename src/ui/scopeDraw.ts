import { fft } from './fft'

export interface ScopeView {
  mode: 'wave' | 'spectrum'
  /** How many captured samples fill the width, in wave mode. */
  samples: number
  gain: number
  sampleRate: number
  accent: string
  /** The second trace, which is deliberately not the accent colour. */
  accentB: string
  grid: string
  dim: string
}

/** Lowest frequency the spectrum shows; below this is out of scope for SFX. */
const MIN_HZ = 20
/** Everything quieter than this reads as silence. */
const FLOOR_DB = -78

/** Scratch buffers, so a redraw at 30 Hz allocates nothing. */
let re = new Float32Array(0)
let im = new Float32Array(0)

export function drawScope(
  canvas: HTMLCanvasElement,
  data: Float32Array | null,
  dataB: Float32Array | null,
  view: ScopeView,
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

  ctx.clearRect(0, 0, w, h)
  ctx.lineWidth = Math.max(1, dpr)

  if (view.mode === 'spectrum') {
    drawGrid(ctx, w, h, view, true)
    // A alone. Two log spectra on one screen is a wall rather than a
    // comparison, and the answer to "what is B made of" is to turn the knob.
    if (data) drawSpectrum(ctx, w, h, data, view)
  } else {
    drawGrid(ctx, w, h, view, false)
    // Both traces are drawn from A's trigger point, never from their own.
    // Triggering each on itself would put them at unrelated phases, and two
    // traces you cannot line up are worse than one -- the whole use of a
    // second channel is reading one against the other.
    const lead = data ?? dataB
    if (!lead) {
      flatLine(ctx, w, h, view)
      return
    }
    const start = triggerAt(lead, Math.min(view.samples, lead.length))
    if (dataB) drawWave(ctx, w, h, dataB, view, start, view.accentB)
    if (data) drawWave(ctx, w, h, data, view, start, view.accent)
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: ScopeView,
  spectrum: boolean,
) {
  ctx.strokeStyle = view.grid
  ctx.beginPath()
  for (let i = 1; i < 8; i++) {
    const x = Math.round((w * i) / 8) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  // The centre line is the zero axis on a waveform, so it is worth more than
  // a grid line. A spectrum has no midpoint, so it does not get one.
  if (spectrum) return
  ctx.strokeStyle = view.dim
  ctx.beginPath()
  ctx.moveTo(0, Math.round(h / 2) + 0.5)
  ctx.lineTo(w, Math.round(h / 2) + 0.5)
  ctx.stroke()
}

function flatLine(ctx: CanvasRenderingContext2D, w: number, h: number, view: ScopeView) {
  ctx.strokeStyle = view.accent
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * The first rising zero crossing, so the waveform stands still instead of
 * sliding across the screen at the difference between its frequency and the
 * refresh rate. Only the part of the capture that is not going to be drawn is
 * searched, so a trigger never costs us samples we need.
 */
function triggerAt(data: Float32Array, samples: number): number {
  const limit = data.length - samples
  for (let i = 1; i < limit; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) return i
  }
  return 0
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: Float32Array,
  view: ScopeView,
  start: number,
  colour: string,
) {
  const samples = Math.min(view.samples, data.length)
  const mid = h / 2
  const scale = (h / 2) * 0.92 * view.gain

  ctx.strokeStyle = colour
  ctx.lineJoin = 'round'
  ctx.beginPath()

  if (samples > w) {
    // More samples than pixels: each column spans the min and max of the
    // samples inside it, or a waveform above the pixel rate turns into an
    // aliased mess that looks nothing like what you are hearing.
    //
    // One connected path, not a separate stroke per column. A column holding
    // a single sample -- which is most of them as soon as the timebase is
    // near the pixel rate -- would otherwise be a zero-length line, and a
    // zero-length line with butt caps paints nothing at all. That draws a
    // steady tone as scattered dots and a silent input as an empty screen.
    for (let x = 0; x < w; x++) {
      const from = start + Math.floor((x * samples) / w)
      const to = start + Math.floor(((x + 1) * samples) / w)
      let lo = data[from] ?? 0
      let hi = lo
      for (let i = from; i < to && i < data.length; i++) {
        const v = data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const top = clamp(mid - hi * scale, 0, h)
      const bottom = clamp(mid - lo * scale, 0, h)
      if (x === 0) ctx.moveTo(x + 0.5, top)
      else ctx.lineTo(x + 0.5, top)
      ctx.lineTo(x + 0.5, bottom)
    }
  } else {
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1 || 1)) * w
      const y = clamp(mid - data[start + i] * scale, 0, h)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  }

  ctx.stroke()
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: Float32Array,
  view: ScopeView,
) {
  const n = data.length
  if (re.length !== n) {
    re = new Float32Array(n)
    im = new Float32Array(n)
  }

  // Hann window: without one, the ends of the capture are a discontinuity and
  // every partial smears into a wide skirt that hides everything near it.
  for (let i = 0; i < n; i++) {
    re[i] = data[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
    im[i] = 0
  }
  fft(re, im)

  const bins = n / 2
  const nyquist = view.sampleRate / 2
  const binHz = nyquist / bins
  const logMin = Math.log(MIN_HZ)
  const span = Math.log(nyquist) - logMin

  ctx.strokeStyle = view.accent
  ctx.beginPath()

  // One column per pixel, taking the loudest bin that falls in it. A peak
  // that lands between two columns still shows at its real height, which
  // matters more on a spectrum than an averaged shape would.
  let started = false
  for (let x = 0; x < w; x++) {
    const hz = Math.exp(logMin + (span * x) / w)
    const lo = Math.max(1, Math.floor(hz / binHz))
    const hiHz = Math.exp(logMin + (span * (x + 1)) / w)
    const hi = Math.max(lo + 1, Math.ceil(hiHz / binHz))

    let peak = 0
    for (let b = lo; b < hi && b < bins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b])
      if (mag > peak) peak = mag
    }

    // Normalised so a full-scale sine reads near the top of the screen.
    const db = 20 * Math.log10((peak * 4 * view.gain) / n + 1e-12)
    const y = h - clamp((db - FLOOR_DB) / -FLOOR_DB, 0, 1) * h

    if (!started) {
      ctx.moveTo(x + 0.5, y)
      started = true
    } else {
      ctx.lineTo(x + 0.5, y)
    }
  }

  ctx.stroke()
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
