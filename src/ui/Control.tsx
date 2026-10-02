import { memo, useCallback } from 'react'
import type { ParamSpec } from '../patch/param'
import { Knob } from './Knob'
import { Switch } from './Switch'

interface Props {
  spec: ParamSpec
  value: number | undefined
  /**
   * The unit's one handler for all of its knobs, told which one moved. Handed
   * the id rather than a closure made for this knob, which would be a new
   * function on every render and redraw every control on the panel whenever
   * any one of them turned.
   */
  onChange: (paramId: string, value: number) => void
}

/**
 * A knob, or a switch when the parameter is a discrete one. Memoized: a turn
 * of one knob redraws that knob, not its neighbours.
 */
export const Control = memo(function Control({ spec, value, onChange }: Props) {
  const v = value ?? spec.default
  const id = spec.id
  const change = useCallback((next: number) => onChange(id, next), [onChange, id])
  return spec.steps ? (
    <Switch spec={spec} value={v} onChange={change} />
  ) : (
    // A count lands on whole numbers: there is no such thing as four and a
    // half pulses, and the readout rounds anyway, so a knob that reported the
    // values in between would be lying about where it was.
    <Knob spec={spec} value={v} onChange={change} step={spec.unit === '#' ? 1 : undefined} />
  )
})
