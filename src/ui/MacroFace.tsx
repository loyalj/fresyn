import { useMemo, useRef, useState } from 'react'
import { MACRO_LANES, macroLane } from '../dsp/modules/Macro'
import type { ModuleDef } from '../patch/types'
import { useFace } from './useFace'

/** Where each lane's colour sits on the wheel; the theme sets the rest. */
const LANE_HUES = [30, 190, 300, 95]

const WIDTH = 240
const HEIGHT = 100
/** How close, in screen pixels, a press has to land to pick up a handle. */
const REACH = 12
/** Samples across the graph per lane. */
const POINTS = 96

const LANES = Array.from({ length: MACRO_LANES }, (_, i) => i + 1)

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  /** Several knobs at once, as one step of undo: a handle is two of them. */
  onChanges?: (values: Record<string, number>) => void
  faceExtra?: React.ReactNode
}

/** A lane end being dragged: its window edge and its value move together. */
interface Grab {
  lane: number
  end: 'start' | 'end'
}

/**
 * The Macro: one big knob, and a picture of what it does to each lane.
 *
 * Every lane is drawn as the line its output follows as Amount goes from
 * nought to one, in its own colour, with a marker where Amount is now. That
 * picture is the point of the panel. Thirteen knobs cannot tell you what
 * happens at seventy percent; four lines crossing a marker can.
 *
 * Each lane has a handle at each end of its travel. Dragging one moves two
 * things at once: sideways is the lane's window -- where on the knob's turn
 * it starts or stops moving -- and up and down is its From or To. Windows are
 * how lanes take turns, and there are no knobs for them on purpose: eight more
 * knobs is a worse way to set four ranges than dragging them where you can
 * see them. A double-click on a handle opens its window back out to that edge.
 *
 * A press anywhere else on the graph sets Amount, so the macro can be played
 * from the picture as well as from the knob.
 */
export function MacroFace({ def, valueOf, onChange, onChanges, faceExtra }: Props) {
  const { read, control: render } = useFace(def, valueOf, onChange)
  const set = (values: Record<string, number>) => {
    if (onChanges) onChanges(values)
    else for (const [id, v] of Object.entries(values)) onChange(id, v)
  }

  const amount = read('amount')
  const lanes = LANES.map((n) => ({
    n,
    from: read(`from${n}`),
    to: read(`to${n}`),
    curve: read(`curve${n}`),
    start: read(`start${n}`),
    end: read(`end${n}`),
  }))
  const shape = lanes.map((l) => `${l.from},${l.to},${l.curve},${l.start},${l.end}`).join(';')

  const xOf = (t: number) => t * WIDTH
  const yOf = (v: number) => ((1 - v) / 2) * HEIGHT

  const paths = useMemo(
    () =>
      lanes.map((l) => {
        let d = ''
        for (let i = 0; i <= POINTS; i++) {
          const t = i / POINTS
          const v = macroLane(t, l.from, l.to, l.curve, l.start, l.end)
          d += `${i === 0 ? 'M' : 'L'} ${xOf(t).toFixed(2)} ${yOf(v).toFixed(2)} `
        }
        return d
      }),
    // `lanes` is rebuilt every render; `shape` is what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape],
  )

  const svg = useRef<SVGSVGElement>(null)
  const glass = useRef<HTMLDivElement>(null)
  const grab = useRef<Grab | 'amount' | null>(null)
  /** The lane last touched, drawn on top and picked first where ends overlap. */
  const [active, setActive] = useState(1)
  const order = [...LANES.filter((n) => n !== active), active]

  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const v = Math.min(1, Math.max(-1, 1 - (2 * (e.clientY - r.top)) / r.height))
    return { t, v, r }
  }

  /** The handle under the pointer, the active lane's first. */
  const handleAt = (e: React.PointerEvent): Grab | null => {
    const { r } = at(e)
    let best: Grab | null = null
    let bestDist = REACH
    for (const n of [...order].reverse()) {
      const l = lanes[n - 1]
      for (const end of ['start', 'end'] as const) {
        const hx = r.left + (end === 'start' ? l.start : l.end) * r.width
        const hy = r.top + ((1 - (end === 'start' ? l.from : l.to)) / 2) * r.height
        const dist = Math.hypot(e.clientX - hx, e.clientY - hy)
        if (dist < bestDist) {
          best = { lane: n, end }
          bestDist = dist
        }
      }
    }
    return best
  }

  const drag = (e: React.PointerEvent) => {
    const g = grab.current
    if (!g) return
    const { t, v } = at(e)
    if (g === 'amount') {
      onChange('amount', t)
      return
    }
    const l = lanes[g.lane - 1]
    // A window cannot turn inside out: each edge stops at the other.
    if (g.end === 'start') set({ [`start${g.lane}`]: Math.min(t, l.end), [`from${g.lane}`]: v })
    else set({ [`end${g.lane}`]: Math.max(t, l.start), [`to${g.lane}`]: v })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const hit = handleAt(e)
    grab.current = hit ?? 'amount'
    if (hit) setActive(hit.lane)
    glass.current!.setPointerCapture(e.pointerId)
    if (!hit) drag(e)
  }

  const onPointerUp = () => {
    grab.current = null
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = handleAt(e as unknown as React.PointerEvent)
    if (!hit) return
    if (hit.end === 'start') onChange(`start${hit.lane}`, 0)
    else onChange(`end${hit.lane}`, 1)
  }

  return (
    <div className="macro-face">
      <div className="macro-top">
        <div className="macro-amount">
          {render('amount')}
          {faceExtra}
        </div>
        {/* The events are on the glass and the plot is inset inside it, so a
            handle sitting on the edge of the travel -- where every lane's
            ends start -- is wholly inside something that can be pressed. */}
        <div
          ref={glass}
          className="macro-glass"
          onPointerDown={onPointerDown}
          onPointerMove={drag}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          role="img"
          aria-label="What each lane puts out as Amount turns. Drag a lane's ends to set its window and range; press anywhere else to set Amount."
        >
          <svg
            ref={svg}
            className="macro-graph"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
          >
            <line x1="0" y1={yOf(0)} x2={WIDTH} y2={yOf(0)} className="wave-mid" vectorEffect="non-scaling-stroke" />
            {order.map((n) => {
              const l = lanes[n - 1]
              return (
                <g key={n} className={`macro-lane-line${n === active ? ' active' : ''}`} style={laneColour(n)}>
                  {/* The window, as a band behind the line, so a lane that sits
                      still for half the turn shows where it wakes up. */}
                  <rect
                    x={xOf(l.start)}
                    y="0"
                    width={Math.max(0, xOf(l.end) - xOf(l.start))}
                    height={HEIGHT}
                    className="macro-window"
                  />
                  <path d={paths[n - 1]} className="macro-path" vectorEffect="non-scaling-stroke" />
                </g>
              )
            })}
            <line
              x1={xOf(amount)}
              y1="0"
              x2={xOf(amount)}
              y2={HEIGHT}
              className="macro-marker"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Handles are HTML over the glass rather than SVG inside it, so they
              stay round however the graph is stretched to fit the panel. */}
          <div className="macro-handles" aria-hidden="true">
            {order.flatMap((n) => {
              const l = lanes[n - 1]
              return (['start', 'end'] as const).map((end) => (
                <span
                  key={`${n}${end}`}
                  className={`macro-handle${n === active ? ' active' : ''}`}
                  style={{
                    ...laneColour(n),
                    left: `${(end === 'start' ? l.start : l.end) * 100}%`,
                    top: `${((1 - (end === 'start' ? l.from : l.to)) / 2) * 100}%`,
                  }}
                />
              ))
            })}
          </div>
        </div>
      </div>
      <div className="macro-lanes">
        {lanes.map((l) => (
          <div
            key={l.n}
            className={`macro-lane${l.n === active ? ' active' : ''}`}
            style={laneColour(l.n)}
            onPointerDown={() => setActive(l.n)}
          >
            <div className="macro-lane-head">
              <span className="macro-lane-number">{l.n}</span>
              <span className="macro-lane-window" title="The part of Amount's turn this lane moves across. Drag its ends on the graph to change it.">
                {l.start.toFixed(2)}–{l.end.toFixed(2)}
              </span>
            </div>
            <div className="macro-lane-knobs">
              {render(`from${l.n}`)}
              {render(`to${l.n}`)}
              {render(`curve${l.n}`)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function laneColour(n: number): React.CSSProperties {
  return { '--lane-hue': LANE_HUES[(n - 1) % LANE_HUES.length] } as React.CSSProperties
}
