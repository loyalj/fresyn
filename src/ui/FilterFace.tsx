import { useCallback } from 'react'
import { ladderResponse } from '../dsp/LadderFilter'
import { svfResponse } from '../dsp/modules/Svf'
import type { ModuleDef } from '../patch/types'
import { useEngine } from './EngineContext'
import { ResponseGraph } from './ResponseGraph'
import { useFace } from './useFace'

/** A filter's gain at a frequency, for its Cutoff, Res and Mode as set. */
type Response = (hz: number, cutoff: number, res: number, mode: number, sampleRate: number) => number

interface Filter {
  /** The knobs along the top; Mode sits apart, under the picture of it. */
  knobs: readonly string[]
  response: Response
  /** Extra class on the mode row, for a filter whose switch is laid out differently. */
  modeClass?: string
}

/**
 * The ladder, with its response drawn beside the Mode buttons.
 *
 * Cutoff and Res are two numbers, and what they add up to -- how sharp the
 * peak is, how steep the slope, which side of the corner survives -- is a
 * shape. The curve is worked out from the same weights the filter uses
 * rather than measured, so it moves with the knobs as they turn.
 *
 * It is the filter as set, not as played: CV moves the corner while a note
 * sounds, and Drive's saturation has no one curve to draw, so neither is in
 * the picture.
 *
 * Next to the switch rather than over the panel, because the switch row had
 * the room already -- the panel does not grow for it.
 */
export const LADDER: Filter = {
  knobs: ['cutoff', 'resonance', 'drive', 'cvAmount'],
  response: ladderResponse,
}

/**
 * The Multimode Filter, laid out as the Ladder is: knobs along the top, and
 * the response drawn beside the Mode buttons it is a picture of.
 *
 * It earns the picture more than the Ladder does. Seven modes behind one set
 * of knobs is seven different meanings for Res -- a squelch, a narrower band,
 * a taller bump, a comb's ring -- and the shape says which one is in play
 * faster than the manual can. The comb modes draw their teeth, which is how
 * you see that Cutoff has become a pitch.
 */
export const SVF: Filter = {
  knobs: ['cutoff', 'resonance', 'cvAmount'],
  response: svfResponse,
  modeClass: 'svf-mode',
}

interface Props {
  def: ModuleDef
  filter: Filter
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  faceExtra?: React.ReactNode
}

/** A filter's panel: its knobs, and its Mode beside the curve it draws. */
export function FilterFace({ def, filter, valueOf, onChange, faceExtra }: Props) {
  const { read, control } = useFace(def, valueOf, onChange)

  const sampleRate = useEngine()?.sampleRate ?? 48000
  const cutoff = read('cutoff')
  const res = read('resonance')
  const mode = Math.round(read('mode'))
  const { response } = filter
  const gain = useCallback(
    (hz: number) => response(hz, cutoff, res, mode, sampleRate),
    [response, cutoff, res, mode, sampleRate],
  )

  return (
    <div className="ladder-face">
      <div className="controls">
        {filter.knobs.map(control)}
        {faceExtra}
      </div>
      <div className={`ladder-mode${filter.modeClass ? ` ${filter.modeClass}` : ''}`}>
        {control('mode')}
        <ResponseGraph gain={gain} corner={cutoff} nyquist={sampleRate / 2} />
      </div>
    </div>
  )
}
