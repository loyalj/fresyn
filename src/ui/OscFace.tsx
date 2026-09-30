import { useEffect, useMemo, useRef } from 'react'
import type { Waveform } from '../dsp/PolyBlepOsc'
import { formatNote } from '../patch/param'
import type { ModuleDef } from '../patch/types'
import { useEngine, useEngineId } from './EngineContext'
import { EnvelopeGraph } from './EnvelopeGraph'
import { FALL, fillBar, scale } from './meter'
import { useFace } from './useFace'
import { useFallingMeter } from './useFallingMeter'
import { WaveGraph } from './WaveGraph'

const TONE = ['pitch', 'octave', 'wave', 'width', 'fmAmount', 'fmMode', 'level']
const ENVELOPE = ['delay', 'attack', 'hold', 'decay', 'sustain', 'release']
/** Where the envelope goes, which is the part of it worth reading together. */
const DESTINATIONS = ['envAmount', 'envPitch', 'envWidth']

interface Props {
  def: ModuleDef
  moduleId: string
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  /** The oscillator's own trigger button. */
  faceExtra?: React.ReactNode
}

/**
 * The oscillator, with its envelope alongside it.
 *
 * Both graphs earn their space the same way: by showing the one thing the
 * knobs cannot. Six knobs tell you an envelope's numbers but not its shape,
 * and a switch reading "pulse" next to a Width of 0.14 tells you even less --
 * the picture is how you know a sliver from a square without playing it. The
 * note under the wave is the same idea for the pitch: what is coming out,
 * rather than what any one knob is set to.
 *
 * The three amounts beside the envelope are the other half of that story:
 * what the shape is being done to.
 */
export function OscFace({ def, moduleId, valueOf, onChange, faceExtra }: Props) {
  const { spec, read, control } = useFace(def, valueOf, onChange)

  // Read off the catalogue rather than from a list of our own, so the picture
  // follows the switch even if the switch grows a position.
  const wave = (spec.wave.steps?.[Math.round(read('wave'))] ?? 'saw') as Waveform

  // The note this is tuned to, Octave included -- which is the whole reason it
  // is reported here rather than under the Pitch knob. The knob knows what it
  // is set to; only the module knows what comes out, and at Octave +1 a knob
  // reading A2 is an oscillator sounding A3.
  const octave = Math.round(read('octave'))
  const note = formatNote(read('pitch') * Math.pow(2, octave))

  // Rebuilt only when one of its six numbers moves, so the graph's own memo
  // holds while the other knobs on the panel turn.
  const delay = read('delay')
  const attack = read('attack')
  const hold = read('hold')
  const decay = read('decay')
  const sustain = read('sustain')
  const release = read('release')
  const envelope = useMemo(
    () => ({ delay, attack, hold, decay, sustain, release }),
    [delay, attack, hold, decay, sustain, release],
  )

  return (
    <div className="osc-face">
      <div className="osc-row">
        <div className="controls">{TONE.map(control)}</div>
        <div className="osc-wave">
          <WaveGraph wave={wave} width={read('width')} />
          {/* Held open when there is no note to give, which below C0 there is
              not, so the row does not change height as the pitch crosses it. */}
          <span className="osc-wave-note" aria-hidden="true">{note || ' '}</span>
        </div>
        <OscMeter moduleId={moduleId} />
        {faceExtra}
      </div>

      <div className="osc-env">
        <div className="osc-env-head">
          <span className="section-label">Envelope</span>
          <span className="osc-env-note">Env jack follows this shape</span>
        </div>

        <EnvelopeGraph params={envelope} />

        <div className="controls osc-env-knobs">
          {ENVELOPE.map(control)}
          <div className="osc-amount">{DESTINATIONS.map(control)}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * What this oscillator is putting out, after its envelope and its Level.
 *
 * Driven from the audio thread rather than through React, exactly as the
 * mixer's bars are: at thirty frames a second, state would make every knob in
 * the rack feel sticky. Hidden from assistive technology for the same reason
 * -- a live region shouting a number sixty times a second is unusable, and
 * the Level knob's own readout says everything a screen reader needs.
 */
function OscMeter({ moduleId }: { moduleId: string }) {
  const engine = useEngine()
  /** How the engine reports this module: by its id in the track, a pad's included. */
  const engineId = useEngineId(moduleId)
  const bar = useRef<HTMLDivElement | null>(null)
  const feed = useFallingMeter(FALL, (_: 0, v) => fillBar(bar.current, v))

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[engineId]
      if (next) feed(0, scale(next[0]))
    })
  }, [engine, engineId, feed])

  return (
    <div className="osc-meter level-meter" aria-hidden="true">
      <div className="osc-meter-fill level-meter-fill" ref={bar} />
    </div>
  )
}
