import { useCallback } from 'react'
import { ladderResponse } from '../dsp/LadderFilter'
import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { useEngine } from './EngineContext'
import { ResponseGraph } from './ResponseGraph'

const KNOBS = ['cutoff', 'resonance', 'drive', 'cvAmount']

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  faceExtra?: React.ReactNode
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
export function LadderFace({ def, valueOf, onChange, faceExtra }: Props) {
  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  const read = (id: string) => valueOf(id) ?? byId[id].default
  const render = (id: string) => (
    <Control key={id} spec={byId[id]} value={valueOf(id)} onChange={(v) => onChange(id, v)} />
  )

  const sampleRate = useEngine()?.sampleRate ?? 48000
  const cutoff = read('cutoff')
  const res = read('resonance')
  const mode = Math.round(read('mode'))
  const gain = useCallback(
    (hz: number) => ladderResponse(hz, cutoff, res, mode, sampleRate),
    [cutoff, res, mode, sampleRate],
  )

  return (
    <div className="ladder-face">
      <div className="controls">
        {KNOBS.map(render)}
        {faceExtra}
      </div>
      <div className="ladder-mode">
        {render('mode')}
        <ResponseGraph gain={gain} corner={cutoff} nyquist={sampleRate / 2} />
      </div>
    </div>
  )
}
