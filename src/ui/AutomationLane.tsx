import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { curveAt } from '../dsp/automation'
import { laneCurves } from '../song/automation'
import { PPQ, type AutomationLane, type AutomationPoint } from '../song/types'
import { ContextMenu, type MenuItem } from './Menu'
import type { RollColors, RollView } from './rollDraw'

/** How tall a lane is drawn until it is resized. Taller than the velocity lane: a curve wants room. */
export const LANE_H = 96
/** How short and how tall a lane can be dragged. */
export const LANE_MIN_H = 44
export const LANE_MAX_H = 320
/** Room above and below the curve, so a point at either end can still be grabbed. */
const PAD = 7
/** How close the pointer has to be to a point to take hold of it. */
const HIT = 7
/** Pixels of vertical drag for a curve's tension to go from straight to its fullest. */
const BEND = 60

interface Props {
  lane: AutomationLane
  /** The roll's geometry, so a point lines up with the notes above it. */
  view: RollView
  colors: RefObject<RollColors>
  /** Where the roll's playhead is, in the pattern's ticks, or null. Read every frame. */
  playTick: RefObject<number | null>
  /** What the lane moves, for the gutter. */
  label: string
  /** A position 0..1 as the knob would read it: "1.40 kHz". */
  format: (value: number) => string
  /** Snapping is off for the whole roll. */
  snapOff: boolean
  /** The lane's points after an edit: one call per gesture, which is one step of undo. */
  onChange: (points: AutomationPoint[]) => void
  /** How tall it is drawn, and a new height dragged to on its bottom edge. */
  height?: number
  onHeight?: (height: number) => void
  /** Close it, leaving it playing; or take it out of the pattern. */
  onHide?: () => void
  onRemove?: () => void
}

type Gesture =
  | { kind: 'point'; point: AutomationPoint; moved: boolean }
  | { kind: 'bend'; point: AutomationPoint; y0: number; tension0: number; rising: boolean }

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)

/**
 * One automation lane of a pattern, under the roll.
 *
 * Click to add a point, drag one to move it, drag the small handle half way
 * along a stretch to bend it, and right-click a point for its shape or to
 * delete it. Shift moves a point off the grid, as it moves a note. Drawn to a
 * canvas with its own loop, like the roll, and laid out on the roll's own
 * geometry -- the same gutter, the same scroll, the same width of a tick --
 * so a point sits exactly under the note it was put beside.
 *
 * A drag is a draft until it is let go, and then one edit.
 */
export function AutomationLaneEditor({
  lane,
  view,
  colors,
  playTick,
  label,
  format,
  snapOff,
  onChange,
  height = LANE_H,
  onHeight,
  onHide,
  onRemove,
}: Props) {
  /** A drag of the bottom edge: where it began, and the height then. */
  const resize = useRef<{ y: number; h: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draft = useRef<AutomationPoint[] | null>(null)
  const gesture = useRef<Gesture | null>(null)
  /** The point under the pointer, or being dragged: lit, and its value in the gutter. */
  const hot = useRef<AutomationPoint | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; point: AutomationPoint } | null>(null)

  const latest = useRef({ lane, view, label, format })
  latest.current = { lane, view, label, format }
  // A new lane from the song is what the draft was waiting for.
  useEffect(() => {
    draft.current = null
  }, [lane])

  const points = () => draft.current ?? latest.current.lane.points
  const length = () => Math.max(1, latest.current.view.lengthTicks)
  const xOf = (tick: number, v: RollView) => v.gutterW - v.scrollX + tick * v.pxPerTick
  const tickOf = (x: number, v: RollView) => (x - v.gutterW + v.scrollX) / v.pxPerTick
  const yOf = (value: number, h: number) => PAD + (1 - value) * (h - 2 * PAD)
  const valueOf = (y: number, h: number) => clamp(1 - (y - PAD) / (h - 2 * PAD), 0, 1)

  /** The handle on the stretch after each point that has one: its middle, on the curve. */
  const handles = (list: readonly AutomationPoint[], v: RollView, h: number) => {
    const sorted = [...list].sort((a, b) => a.tick - b.tick)
    const out: { point: AutomationPoint; x: number; y: number; rising: boolean }[] = []
    for (let i = 0; i + 1 < sorted.length; i++) {
      const p = sorted[i]
      const q = sorted[i + 1]
      if (p.shape === 'hold' || q.tick - p.tick < 2) continue
      const mid = (p.tick + q.tick) / 2
      const c = { from: p.tick, to: q.tick, v0: p.value, v1: q.value, shape: p.shape === 'curve' ? ('curve' as const) : ('linear' as const), tension: p.tension ?? 0 }
      out.push({ point: p, x: xOf(mid, v), y: yOf(curveAt(c, mid), h), rising: q.value >= p.value })
    }
    return out
  }

  // --- drawing ---------------------------------------------------------------
  useEffect(() => {
    let raf = 0
    let drawn: unknown[] = []
    const tick = () => {
      const canvas = canvasRef.current
      const c = colors.current
      if (canvas && c) {
        const inputs = [points(), latest.current.view, latest.current.label, playTick.current, c, hot.current, window.devicePixelRatio, canvas.clientWidth]
        if (inputs.some((x, i) => x !== drawn[i])) {
          drawn = inputs
          draw(canvas, c)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draw = (canvas: HTMLCanvasElement, c: RollColors) => {
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { view: v, label: name, format: fmt } = latest.current
    const len = length()
    const list = points()
    ctx.save()
    ctx.scale(dpr, dpr)
    // Cleared first: the background is translucent, and drawn over the last
    // frame it would leave every old playhead showing through.
    ctx.clearRect(0, 0, width, h)
    ctx.fillStyle = c.bg
    ctx.fillRect(0, 0, width, h)

    const right = width - v.scrollW
    ctx.save()
    ctx.beginPath()
    ctx.rect(v.gutterW, 0, Math.max(0, right - v.gutterW), h)
    ctx.clip()

    // Past the end of the pattern is not the pattern's.
    const end = xOf(len, v)
    if (end < right) {
      ctx.fillStyle = c.track
      ctx.globalAlpha = 0.5
      ctx.fillRect(end, 0, right - end, h)
      ctx.globalAlpha = 1
    }
    // The grid, with the beats stronger.
    const step = Math.max(1, v.grid)
    for (let t = 0; t <= len; t += step) {
      const x = Math.round(xOf(t, v)) + 0.5
      if (x < v.gutterW || x > right) continue
      ctx.strokeStyle = t % PPQ === 0 ? c.rule : c.hairline
      ctx.globalAlpha = t % PPQ === 0 ? 0.7 : 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // The curve, a pixel at a time, from the same arithmetic the engine plays.
    const curves = laneCurves({ target: '', points: list }, len)
    if (curves.length) {
      const from = Math.max(v.gutterW, xOf(0, v))
      const to = Math.min(right, end)
      ctx.beginPath()
      let k = 0
      for (let x = from; x <= to; x++) {
        const t = tickOf(x, v)
        while (k + 1 < curves.length && curves[k + 1].from <= t) k++
        const y = yOf(curveAt(curves[k], t), h)
        if (x === from) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = c.accentLine
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineTo(to, h)
      ctx.lineTo(from, h)
      ctx.closePath()
      ctx.fillStyle = c.accent
      ctx.globalAlpha = 0.14
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.lineWidth = 1
    }

    // The bending handles, then the points over them.
    for (const hd of handles(list, v, h)) {
      ctx.beginPath()
      ctx.arc(hd.x, hd.y, 3, 0, Math.PI * 2)
      ctx.strokeStyle = c.accentLine
      ctx.fillStyle = c.bg
      ctx.fill()
      ctx.stroke()
    }
    for (const p of list) {
      const x = xOf(p.tick, v)
      const y = yOf(p.value, h)
      ctx.beginPath()
      ctx.arc(x, y, p === hot.current ? 5 : 4, 0, Math.PI * 2)
      ctx.fillStyle = p === hot.current ? c.ink : c.accent
      ctx.fill()
      if (p.shape === 'hold') {
        // A hold is drawn with a square, so it can be told from a slope.
        ctx.fillRect(x - 1, y - 1, 2, 2)
      }
    }

    const play = playTick.current
    if (play !== null) {
      const x = Math.round(xOf(play, v)) + 0.5
      ctx.strokeStyle = c.ink
      ctx.globalAlpha = 0.8
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.restore()

    // The gutter: what this lane moves, and the value of the point in hand.
    ctx.fillStyle = c.gutter
    ctx.fillRect(0, 0, v.gutterW, h)
    ctx.fillStyle = c.ink
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    wrap(ctx, name, 4, 5, v.gutterW - 8, 12, 4)
    if (hot.current) {
      ctx.fillStyle = c.accent
      ctx.textBaseline = 'bottom'
      ctx.fillText(fmt(hot.current.value), 4, h - 4, v.gutterW - 8)
    }
    ctx.strokeStyle = c.rule
    ctx.beginPath()
    ctx.moveTo(0, 0.5)
    ctx.lineTo(width, 0.5)
    ctx.stroke()
    ctx.restore()
  }

  // --- the pointer -------------------------------------------------------------
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, h: r.height }
  }

  const pointAt = (x: number, y: number, h: number) => {
    const v = latest.current.view
    let best: AutomationPoint | null = null
    let dist = HIT
    for (const p of points()) {
      const d = Math.hypot(xOf(p.tick, v) - x, yOf(p.value, h) - y)
      if (d <= dist) {
        dist = d
        best = p
      }
    }
    return best
  }

  const snapTick = (tick: number, free: boolean) => {
    const grid = latest.current.view.grid
    const t = free || snapOff || !(grid > 0) ? Math.round(tick) : Math.round(tick / grid) * grid
    return clamp(t, 0, length() - 1)
  }

  /** The draft with one point replaced, in order of tick. */
  const replace = (old: AutomationPoint, next: AutomationPoint) => {
    const list = points().map((p) => (p === old ? next : p))
    list.sort((a, b) => a.tick - b.tick)
    draft.current = list
    return next
  }

  const commit = () => {
    const list = draft.current
    if (list) onChange(list)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, h } = at(e)
    const v = latest.current.view
    if (x < v.gutterW || x > e.currentTarget.clientWidth - v.scrollW) return
    if (e.button === 2) {
      const p = pointAt(x, y, h)
      if (p) setMenu({ x: e.clientX, y: e.clientY, point: p })
      return
    }
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const hd = handles(points(), v, h).find((k) => Math.hypot(k.x - x, k.y - y) <= HIT)
    const p = pointAt(x, y, h)
    if (!p && hd) {
      gesture.current = { kind: 'bend', point: hd.point, y0: y, tension0: hd.point.shape === 'curve' ? (hd.point.tension ?? 0) : 0, rising: hd.rising }
      return
    }
    if (p) {
      gesture.current = { kind: 'point', point: p, moved: false }
      hot.current = p
      return
    }
    // A new point, where the click was, and in hand straight away.
    if (xOf(snapTick(tickOf(x, v), e.shiftKey), v) > xOf(length(), v)) return
    const made: AutomationPoint = { tick: snapTick(tickOf(x, v), e.shiftKey), value: Math.round(valueOf(y, h) * 1000) / 1000 }
    draft.current = [...points(), made].sort((a, b) => a.tick - b.tick)
    gesture.current = { kind: 'point', point: made, moved: true }
    hot.current = made
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, h } = at(e)
    const g = gesture.current
    const v = latest.current.view
    if (!g) {
      hot.current = pointAt(x, y, h)
      e.currentTarget.style.cursor = hot.current
        ? 'grab'
        : handles(points(), v, h).some((k) => Math.hypot(k.x - x, k.y - y) <= HIT)
          ? 'ns-resize'
          : 'crosshair'
      return
    }
    if (g.kind === 'point') {
      const next: AutomationPoint = { ...g.point, tick: snapTick(tickOf(x, v), e.shiftKey), value: Math.round(valueOf(y, h) * 1000) / 1000 }
      g.point = replace(g.point, next)
      g.moved = true
      hot.current = g.point
      return
    }
    // Up bends the stretch up, whichever way it runs: a rising curve that
    // bulges upward starts quickly, which is a negative tension.
    const amount = clamp(g.tension0 + ((g.y0 - y) / BEND) * (g.rising ? -1 : 1), -1, 1)
    const next: AutomationPoint = { ...g.point, shape: 'curve', tension: Math.round(amount * 1000) / 1000 }
    g.point = replace(g.point, next)
  }

  const finish = () => {
    const g = gesture.current
    gesture.current = null
    if (g && (g.kind === 'bend' || g.moved)) commit()
    else draft.current = null
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y, h } = at(e)
    // Double-click a handle to straighten its stretch again.
    const hd = handles(points(), latest.current.view, h).find((k) => Math.hypot(k.x - x, k.y - y) <= HIT)
    if (hd && !pointAt(x, y, h)) {
      replace(hd.point, { tick: hd.point.tick, value: hd.point.value })
      commit()
    }
  }

  const menuItems = useCallback(
    (point: AutomationPoint): MenuItem[] => {
      const set = (change: Partial<AutomationPoint> | null) => {
        const list = points()
          .filter((p) => change !== null || p !== point)
          .map((p) => {
            if (p !== point || change === null) return p
            const next: AutomationPoint = { tick: p.tick, value: p.value, ...change }
            if (next.shape !== 'curve') delete next.tension
            if (!next.shape) delete next.shape
            return next
          })
        onChange(list)
      }
      const shape = point.shape ?? 'linear'
      return [
        { kind: 'toggle', label: 'Linear', checked: shape === 'linear', onSelect: () => set({ shape: undefined }) },
        { kind: 'toggle', label: 'Hold', checked: shape === 'hold', onSelect: () => set({ shape: 'hold' }) },
        { kind: 'toggle', label: 'Curve', checked: shape === 'curve', onSelect: () => set({ shape: 'curve', tension: point.tension ?? 0.5 }) },
        { kind: 'separator' },
        { kind: 'action', label: 'Delete point', onSelect: () => set(null) },
      ]
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onChange],
  )

  return (
    <div className="auto-lane" data-target={lane.target}>
      <div className="auto-lane-head">
        <span className="auto-lane-name">{label}</span>
        {onHide && (
          <button className="auto-lane-btn" onClick={onHide} title="Close this lane; it keeps playing" type="button">
            Hide
          </button>
        )}
        {onRemove && (
          <button className="auto-lane-btn" onClick={onRemove} title="Take this lane out of the pattern (Ctrl+Z brings it back)" type="button">
            Remove lane
          </button>
        )}
      </div>
      <div className="auto-lane-body" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="auto-lane-canvas"
        aria-label={`Automation of ${label}`}
        data-length={view.lengthTicks}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={() => {
          if (!gesture.current) hot.current = null
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      </div>
      {onHeight && (
        <div
          className="auto-lane-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize the ${label} lane`}
          title="Drag to make this lane taller or shorter"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            resize.current = { y: e.clientY, h: height }
          }}
          onPointerMove={(e) => {
            const r = resize.current
            if (!r) return
            onHeight(Math.round(Math.min(LANE_MAX_H, Math.max(LANE_MIN_H, r.h + e.clientY - r.y))))
          }}
          onPointerUp={() => (resize.current = null)}
          onPointerCancel={() => (resize.current = null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.point)} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Text across lines, word by word, up to `lines` of them. */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineH: number, lines: number) {
  const words = text.split(' ')
  let line = ''
  let n = 0
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width > width && line) {
      ctx.fillText(line, x, y + n * lineH, width)
      if (++n >= lines) return
      line = w
    } else line = next
  }
  if (line) ctx.fillText(line, x, y + n * lineH, width)
}
