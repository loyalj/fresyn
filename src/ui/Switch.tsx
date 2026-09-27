import type { ParamSpec } from '../patch/param'
import { useKnobHelp } from './KnobHelp'

interface Props {
  spec: ParamSpec
  value: number
  onChange: (value: number) => void
}

/** Discrete parameter: a row of buttons rather than a knob with detents. */
export function Switch({ spec, value, onChange }: Props) {
  const steps = spec.steps ?? []
  const current = Math.round(value)
  const help = useKnobHelp(spec.label)

  return (
    <div className="switch" {...help}>
      <div className="switch-buttons">
        {steps.map((label, i) => (
          <button
            key={label}
            className={i === current ? 'active' : ''}
            onClick={() => onChange(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="knob-label">{spec.label}</span>
    </div>
  )
}
