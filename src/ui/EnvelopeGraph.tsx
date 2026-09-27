import { memo, useId, useMemo } from 'react'
import { envelopeShape, type EnvelopeParams } from './envelopeShape'

const HEIGHT = 100

interface Props {
  params: EnvelopeParams
}

/** The envelope's shape, drawn from the envelope itself. */
export const EnvelopeGraph = memo(function EnvelopeGraph({ params }: Props) {
  const gradientId = useId()
  // Keyed on the six numbers rather than on the object, so a caller that
  // builds a fresh one each render does not cost a fresh curve.
  const { delay, attack, hold, decay, sustain, release } = params
  const shape = useMemo(
    () => envelopeShape({ delay, attack, hold, decay, sustain, release }),
    [delay, attack, hold, decay, sustain, release],
  )
  const n = shape.values.length

  const line = useMemo(() => {
    let d = ''
    for (let i = 0; i < n; i++) {
      d += `${i === 0 ? 'M' : 'L'} ${i} ${(HEIGHT - shape.values[i] * HEIGHT).toFixed(2)} `
    }
    return d
  }, [shape, n])

  return (
    <svg
      className="env-graph"
      viewBox={`0 0 ${n} ${HEIGHT}`}
      // Stretched to the panel width; every stroke opts out of the scaling so
      // it stays an even weight rather than being smeared horizontally.
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {shape.marks.map((x, i) => (
        <line
          key={i}
          x1={x * n}
          y1="0"
          x2={x * n}
          y2={HEIGHT}
          className="env-mark"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <path d={`${line} L ${n - 1} ${HEIGHT} L 0 ${HEIGHT} Z`} fill={`url(#${gradientId})`} />
      <path d={line} className="env-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
})
