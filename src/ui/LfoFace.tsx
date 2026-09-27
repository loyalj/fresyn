import type { Waveform } from '../dsp/PolyBlepOsc'
import type { ModuleDef } from '../patch/types'
import { useFace } from './useFace'
import { WaveGraph } from './WaveGraph'

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  faceExtra?: React.ReactNode
}

/**
 * The LFO, with its shape drawn directly above the Shape buttons.
 *
 * The same window the oscillator has, and it earns its place here for a
 * better reason: an LFO's whole job is a shape you cannot hear on its own,
 * and reading "pulse" and "0.14" off two controls is not the same as seeing
 * the sliver they add up to. Width in particular does two different things
 * depending on the shape -- it narrows a pulse and tilts a triangle -- which
 * is two paragraphs in the manual and one glance here.
 *
 * Over the switch rather than across the panel, because that is what it is a
 * picture of, and because the room was already there: a switch is shorter
 * than a knob, and the space above it was empty.
 *
 * Scaled by Depth, unlike the oscillator's, whose Level it ignores. An
 * oscillator is heard, and has a meter for how loud it is; an LFO is only
 * ever seen, so how far it swings belongs in the only picture of it there is.
 *
 * Time is normalised to two cycles, so Rate does not change the picture. A
 * window that showed real time would be a flat line at 0.02 Hz and a blur at
 * 200.
 */
export function LfoFace({ def, valueOf, onChange, faceExtra }: Props) {
  const { spec, read, control } = useFace(def, valueOf, onChange)
  const shape = (spec.shape.steps?.[Math.round(read('shape'))] ?? 'sine') as Waveform

  return (
    <div className="controls lfo-face">
      {control('rate')}
      <div className="lfo-shape">
        <WaveGraph wave={shape} width={read('width')} scale={read('depth')} />
        {control('shape')}
      </div>
      {control('width')}
      {control('depth')}
      {faceExtra}
    </div>
  )
}
