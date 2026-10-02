import { useRef, useState } from 'react'
import { clamp } from '../dsp/util'

interface Props {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  /** What the arrows and the spinner step by, and what a typed value is rounded to. */
  step?: number
  label: string
  className?: string
}

/**
 * A number typed into a field, the way the dock's tempo is.
 *
 * Typing waits for Enter or for the field to lose focus before it counts: a
 * value committed on every keystroke is clamped half-typed -- the 1 of 140 is
 * below a floor of 20 -- and cannot be typed at all. The arrows and the
 * spinner land straight away, since a step is never half a number. Escape
 * puts the value back, and stops there rather than reaching the rack.
 */
export function NumberField({ value, onChange, min, max, step = 1, label, className }: Props) {
  const shown = String(roundTo(value, step))
  /** The text being typed, or null while the field just shows the value. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Set by a key or a spinner click, whose change is a step rather than typing. */
  const stepping = useRef(false)

  const commit = (text: string) => {
    setDraft(null)
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return
    const next = clamp(roundTo(n, step), min, max)
    if (next !== value) onChange(next)
  }

  return (
    <input
      type="number"
      className={className}
      min={min}
      max={max}
      step={step}
      value={draft ?? shown}
      aria-label={label}
      onPointerDown={() => {
        stepping.current = true
      }}
      onKeyDown={(e) => {
        stepping.current = e.key === 'ArrowUp' || e.key === 'ArrowDown'
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation()
          setDraft(null)
        }
      }}
      onChange={(e) => {
        const text = e.target.value
        if (stepping.current && draft === null && text !== '') {
          stepping.current = false
          commit(text)
          return
        }
        stepping.current = false
        setDraft(text)
      }}
      onBlur={(e) => {
        if (draft !== null) commit(e.currentTarget.value)
      }}
    />
  )
}

/** To the nearest step, without the float dust a step of 0.1 leaves behind. */
function roundTo(n: number, step: number): number {
  return Number((Math.round(n / step) * step).toFixed(6))
}
