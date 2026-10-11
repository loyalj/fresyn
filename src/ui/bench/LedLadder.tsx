/**
 * A row of lamps with one lit: the needle of an LED tuner. Centre-zero, so
 * the middle lamp is "in tune" and the ones either side say which way and
 * roughly how far. The middle lamp lights in the meter's own green-end
 * colour when it is lit at all, as a tuner's centre lamp is a different
 * colour from the rest; every other lamp is the theme's lamp colour.
 */

interface Props {
  /** How far off, in cents; null leaves every lamp dark. */
  cents: number | null
  /** Lamps either side of the centre. */
  side?: number
  /** Cents at the last lamp; past it, the end lamp stays lit. */
  range?: number
  vertical?: boolean
  className?: string
}

export function LedLadder({ cents, side = 10, range = 50, vertical = false, className = '' }: Props) {
  const step = range / side
  const lit = cents === null ? null : Math.max(-side, Math.min(side, Math.round(cents / step)))
  const lamps = Array.from({ length: side * 2 + 1 }, (_, i) => i - side)
  // Sharp is up on a column, as a needle swings up toward sharp.
  if (vertical) lamps.reverse()
  return (
    <span className={`led-ladder${vertical ? ' vertical' : ''} ${className}`} aria-hidden="true">
      {lamps.map((k) => (
        <i key={k} className={`${k === 0 ? 'centre' : ''}${k === lit ? ' lit' : ''}${k % 5 === 0 ? ' major' : ''}`} />
      ))}
    </span>
  )
}
