import { useMemo } from 'react'
import type { Waveform } from '../dsp/PolyBlepOsc'
import { waveShape } from './waveShape'

const HEIGHT = 100
/**
 * How much of the height a full-scale sample uses. The rest is headroom for
 * the overshoot the band limiting leaves at a corner, which is real and would
 * otherwise be drawn flat against the top of the glass.
 */
const SWING = 42

interface Props {
  wave: Waveform
  width: number
  /**
   * How much of full scale the trace uses, for a source whose amplitude is
   * one of its controls. The LFO's Depth is exactly that -- a wobble at 0.20
   * is a fifth of the swing, and a picture that ignored it would be a picture
   * of a knob nobody had turned.
   */
  scale?: number
}

/** The waveform, drawn from the oscillator itself. */
export function WaveGraph({ wave, width, scale = 1 }: Props) {
  const values = useMemo(() => waveShape(wave, width), [wave, width])
  const n = values.length

  const line = useMemo(() => {
    let d = ''
    for (let i = 0; i < n; i++) {
      d += `${i === 0 ? 'M' : 'L'} ${i} ${(HEIGHT / 2 - values[i] * SWING * scale).toFixed(2)} `
    }
    return d
  }, [values, n, scale])

  return (
    <svg
      className="wave-graph"
      viewBox={`0 0 ${n} ${HEIGHT}`}
      // Stretched to fit, with the stroke opting out of the scaling so it
      // keeps an even weight rather than being smeared horizontally.
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1={HEIGHT / 2}
        x2={n}
        y2={HEIGHT / 2}
        className="wave-mid"
        vectorEffect="non-scaling-stroke"
      />
      <path d={line} className="wave-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
