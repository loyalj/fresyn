import type { ParamSpec } from '../patch/param'
import { Knob } from './Knob'
import { Switch } from './Switch'

interface Props {
  spec: ParamSpec
  value: number | undefined
  onChange: (value: number) => void
}

/** A knob, or a switch when the parameter is a discrete one. */
export function Control({ spec, value, onChange }: Props) {
  const v = value ?? spec.default
  return spec.steps ? (
    <Switch spec={spec} value={v} onChange={onChange} />
  ) : (
    // A count lands on whole numbers: there is no such thing as four and a
    // half pulses, and the readout rounds anyway, so a knob that reported the
    // values in between would be lying about where it was.
    <Knob spec={spec} value={v} onChange={onChange} step={spec.unit === '#' ? 1 : undefined} />
  )
}
