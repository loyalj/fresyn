import { useCallback } from 'react'
import { svfResponse } from '../dsp/modules/Svf'
import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { useEngine } from './EngineContext'
import { ResponseGraph } from './ResponseGraph'

const KNOBS = ['cutoff', 'resonance', 'cvAmount']

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  faceExtra?: React.ReactNode
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
export function SvfFace({ def, valueOf, onChange, faceExtra }: Props) {
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
    (hz: number) => svfResponse(hz, cutoff, res, mode, sampleRate),
    [cutoff, res, mode, sampleRate],
  )

  return (
    <div className="ladder-face">
      <div className="controls">
        {KNOBS.map(render)}
        {faceExtra}
      </div>
      <div className="ladder-mode svf-mode">
        {render('mode')}
        <ResponseGraph gain={gain} corner={cutoff} nyquist={sampleRate / 2} />
      </div>
    </div>
  )
}
