import { useEffect, useRef, useState } from 'react'

/** Pixels of drag for one `step`. */
const PX_PER_STEP = 4
/** How far the face turns for a pixel of drag, in degrees. */
const DEG_PER_PX = 1.5
/** And for one click of the mouse wheel or an arrow key. */
const DEG_PER_CLICK = 6

interface Props {
  /** What the wheel sets, for anything that cannot see it. */
  label: string
  value: number
  min: number
  max: number
  /** One click, and the finer one Shift gives, as it does on a knob. */
  step?: number
  fine?: number
  /** One press of Page Up or Page Down. */
  coarse?: number
  /** Called with the new value, already clamped; never with the old one. */
  onChange: (value: number) => void
  /** What a screen reader hears for the value. */
  valueText?: string
}

/**
 * A jog wheel: an endless dial with a finger dimple. It is handled as every
 * knob in the rack is -- drag up for more, down for less, Shift for finer --
 * and the face turns smoothly under the hand while the value moves a `step`
 * every few pixels. The mouse wheel and the arrow keys move it a step a
 * click, Shift a `fine` one; Page Up and Page Down a `coarse` one. It has no
 * ends of its own -- the value it sets does -- so it keeps turning past them
 * without moving the value further.
 */
export function JogWheel({ label, value, min, max, step = 1, fine = 0.1, coarse = 5, onChange, valueText }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  /** How far the face is drawn turned, in degrees. */
  const [angle, setAngle] = useState(0)
  /** The drag: where the pointer was, and the value it is carrying, unrounded. */
  const drag = useRef<{ y: number; at: number } | null>(null)
  const current = useRef(value)
  current.current = value

  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const send = (v: number, grid: number) => {
    const next = clamp(Number((Math.round(v / grid) * grid).toFixed(6)))
    if (next !== current.current) {
      current.current = next
      onChange(next)
    }
  }
  const click = (clicks: number, size: number) => {
    if (!clicks) return
    setAngle((a) => a + clicks * DEG_PER_CLICK)
    send(current.current + clicks * size, size)
  }
  const clickRef = useRef(click)
  clickRef.current = click

  // Not React's onWheel: that one is passive, and the page would scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let spare = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      spare += e.deltaMode === 0 ? e.deltaY / 100 : e.deltaY / 3
      const clicks = Math.trunc(spare)
      spare -= clicks
      // Wheel up is more, as it is on every knob in the rack.
      clickRef.current(-clicks, e.shiftKey ? fine : step)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [step, fine])

  return (
    <div
      ref={ref}
      className="jog"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={valueText}
      title={`${label}: drag up or down, or scroll. Shift: finer.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        drag.current = { y: e.clientY, at: current.current }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dy = d.y - e.clientY
        if (!dy) return
        d.y = e.clientY
        setAngle((a) => a + dy * DEG_PER_PX)
        const grid = e.shiftKey ? fine : step
        // Held inside the range, so turning on past an end and back moves it at once.
        d.at = clamp(d.at + (dy / PX_PER_STEP) * grid)
        send(d.at, grid)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        const up = e.key === 'ArrowUp' || e.key === 'ArrowRight'
        const down = e.key === 'ArrowDown' || e.key === 'ArrowLeft'
        if (up || down) click(up ? 1 : -1, e.shiftKey ? fine : step)
        else if (e.key === 'PageUp' || e.key === 'PageDown') click(e.key === 'PageUp' ? 1 : -1, coarse)
        else return
        e.preventDefault()
      }}
    >
      <div className="jog-face" style={{ transform: `rotate(${angle}deg)` }}>
        <span className="jog-dimple" />
      </div>
    </div>
  )
}
