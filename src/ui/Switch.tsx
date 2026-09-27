import { useRef, useState } from 'react'
import type { ParamSpec } from '../patch/param'
import { useKnobHelp } from './KnobHelp'
import { ContextMenu } from './Menu'

interface Props {
  spec: ParamSpec
  value: number
  onChange: (value: number) => void
}

/**
 * Discrete parameter: a row of buttons rather than a knob with detents.
 *
 * A radio group to anything reading the page, because that is what it is --
 * one of several, exactly one lit -- and it moves the way one does: the
 * group is a single stop in the tab order, on the lit position, and the
 * arrows step along it. Double-clicking the name and the right-click menu
 * put it back to its default, as they do a knob; on the buttons themselves a
 * double-click is two presses of a position and nothing more.
 */
export function Switch({ spec, value, onChange }: Props) {
  const steps = spec.steps ?? []
  const current = Math.round(value)
  const help = useKnobHelp(spec.label)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const fallback = Math.round(spec.default)

  const go = (i: number) => {
    const n = steps.length
    if (n === 0) return
    const next = ((i % n) + n) % n
    onChange(next)
    buttons.current[next]?.focus()
  }

  return (
    <div
      className="switch"
      {...help}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
    >
      <div
        className="switch-buttons"
        role="radiogroup"
        aria-label={spec.label}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(current + 1)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(current - 1)
          else if (e.key === 'Home') go(0)
          else if (e.key === 'End') go(steps.length - 1)
          else return
          e.preventDefault()
        }}
      >
        {steps.map((label, i) => (
          <button
            key={label}
            ref={(el) => {
              buttons.current[i] = el
            }}
            className={i === current ? 'active' : ''}
            onClick={() => onChange(i)}
            role="radio"
            aria-checked={i === current}
            // One stop for the group, on the lit one; the arrows do the rest.
            tabIndex={i === current || (current < 0 && i === 0) ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <span
        className="knob-label"
        onDoubleClick={() => onChange(fallback)}
        title="Double-click to reset"
      >
        {spec.label}
      </span>

      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={[
            {
              kind: 'action',
              label: 'Reset',
              shortcut: steps[fallback] ?? '',
              disabled: current === fallback,
              onSelect: () => onChange(fallback),
            },
          ]}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  )
}
