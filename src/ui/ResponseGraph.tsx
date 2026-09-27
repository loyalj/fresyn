import { useMemo } from 'react'

const WIDTH = 240
const HEIGHT = 100
/** The frequency range drawn, on a log axis: the whole of what is heard. */
const LOW_HZ = 20
const HIGH_HZ = 20000
/**
 * The level range drawn. Room above zero for a resonant peak to stand up in,
 * and enough below it to see a slope's steepness before it leaves the glass;
 * a lowpass three octaves past its corner is gone either way.
 */
const TOP_DB = 24
const BOTTOM_DB = -48
/** A line at each decade, which is where the ear's landmarks are. */
const DECADES = [100, 1000, 10000]

interface Props {
  /** The linear gain at a frequency in Hz. */
  gain: (hz: number) => number
  /** Where to mark the corner, in Hz. */
  corner?: number
  /** For a graph at a sample rate low enough to lose the top of the range. */
  nyquist?: number
}

/**
 * A filter's frequency response: how loud each frequency comes out, on the
 * axes an equaliser is drawn on -- log frequency across, dB up.
 *
 * Built around a function rather than a filter, so any module whose response
 * has a closed form can draw one; which modules those are is up to them.
 */
export function ResponseGraph({ gain, corner, nyquist = HIGH_HZ }: Props) {
  const top = Math.min(HIGH_HZ, nyquist)
  const logLow = Math.log(LOW_HZ)
  const span = Math.log(top) - logLow
  const xOf = (hz: number) => ((Math.log(hz) - logLow) / span) * WIDTH
  const yOf = (db: number) => ((TOP_DB - db) / (TOP_DB - BOTTOM_DB)) * HEIGHT
  const zero = yOf(0)

  const line = useMemo(() => {
    let d = ''
    for (let x = 0; x <= WIDTH; x++) {
      const hz = Math.exp(logLow + (span * x) / WIDTH)
      const db = 20 * Math.log10(gain(hz) + 1e-9)
      // Clamped to just past the glass, so a curve that leaves it is cut off
      // by the edge rather than drawn off to infinity at a resonant peak.
      const y = Math.min(HEIGHT + 2, Math.max(-2, yOf(db)))
      d += `${x === 0 ? 'M' : 'L'} ${x} ${y.toFixed(2)} `
    }
    return d
  }, [gain, logLow, span])

  return (
    <svg
      className="response-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // Stretched to fit, with the strokes opting out of the scaling so they
      // keep an even weight whatever shape the panel gives the glass.
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {DECADES.filter((hz) => hz < top).map((hz) => (
        <line
          key={hz}
          x1={xOf(hz)}
          y1="0"
          x2={xOf(hz)}
          y2={HEIGHT}
          className="response-grid"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Unity: above it is boosted, below it is cut. */}
      <line x1="0" y1={zero} x2={WIDTH} y2={zero} className="wave-mid" vectorEffect="non-scaling-stroke" />
      {corner !== undefined && corner > LOW_HZ && corner < top && (
        <line
          x1={xOf(corner)}
          y1="0"
          x2={xOf(corner)}
          y2={HEIGHT}
          className="response-corner"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path d={`${line} L ${WIDTH} ${HEIGHT + 2} L 0 ${HEIGHT + 2} Z`} className="response-fill" />
      <path d={line} className="wave-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
