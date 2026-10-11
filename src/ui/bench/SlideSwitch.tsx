interface Props<T extends string> {
  /** What the switch picks, for anything that cannot see the legend. */
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  onChange: (value: T) => void
}

/**
 * A slide switch of a few positions, its positions printed over the slot.
 * Click a position's legend, or the slot where it is, to throw it there; the
 * arrow keys move it one position, as a radio group's do.
 */
export function SlideSwitch<T extends string>({ label, options, value, onChange }: Props<T>) {
  const at = Math.max(0, options.findIndex(([id]) => id === value))
  const move = (by: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, at + by))]
    if (next[0] !== value) onChange(next[0])
  }
  return (
    <div
      className="slide-switch"
      role="radiogroup"
      aria-label={label}
      style={{ '--positions': options.length, '--at': at } as React.CSSProperties}
      onKeyDown={(e) => {
        const by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!by) return
        e.preventDefault()
        move(by)
        // The focus goes with the switch, as it does along a radio group.
        const to = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[Math.min(options.length - 1, Math.max(0, at + by))]
        to?.focus()
      }}
    >
      <div className="slide-switch-legends">
        {options.map(([id, name], i) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={i === at}
            tabIndex={i === at ? 0 : -1}
            className={i === at ? 'on' : ''}
            onClick={() => onChange(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="slide-switch-slot"
        aria-hidden="true"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const r = e.currentTarget.getBoundingClientRect()
          const i = Math.min(options.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * options.length)))
          if (options[i][0] !== value) onChange(options[i][0])
        }}
      >
        <span className="slide-switch-thumb" />
      </div>
    </div>
  )
}
