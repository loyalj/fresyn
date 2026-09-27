import { useEffect, useRef } from 'react'
import type { Waveform } from '../dsp/PolyBlepOsc'
import { formatNote } from '../patch/param'
import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { useEngine } from './EngineContext'
import { EnvelopeGraph } from './EnvelopeGraph'
import { FALL, scale } from './meter'
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
  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  const render = (id: string) => (
    <Control
      key={id}
      spec={byId[id]}
      value={valueOf(id)}
      onChange={(v) => onChange(id, v)}
    />
  )

  // Read off the catalogue rather than from a list of our own, so the picture
  // follows the switch even if the switch grows a position.
  const wave = (byId.wave.steps?.[Math.round(valueOf('wave') ?? byId.wave.default)] ??
    'saw') as Waveform

  // The note this is tuned to, Octave included -- which is the whole reason it
  // is reported here rather than under the Pitch knob. The knob knows what it
  // is set to; only the module knows what comes out, and at Octave +1 a knob
  // reading A2 is an oscillator sounding A3.
  const octave = Math.round(valueOf('octave') ?? byId.octave.default)
  const note = formatNote((valueOf('pitch') ?? byId.pitch.default) * Math.pow(2, octave))

  return (
    <div className="osc-face">
      <div className="osc-row">
        <div className="controls">{TONE.map(render)}</div>
        <div className="osc-wave">
          <WaveGraph wave={wave} width={valueOf('width') ?? byId.width.default} />
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

        <EnvelopeGraph
          params={{
            delay: valueOf('delay') ?? byId.delay.default,
            attack: valueOf('attack') ?? byId.attack.default,
            hold: valueOf('hold') ?? byId.hold.default,
            decay: valueOf('decay') ?? byId.decay.default,
            sustain: valueOf('sustain') ?? byId.sustain.default,
            release: valueOf('release') ?? byId.release.default,
          }}
        />

        <div className="controls osc-env-knobs">
          {ENVELOPE.map(render)}
          <div className="osc-amount">{DESTINATIONS.map(render)}</div>
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
  const bar = useRef<HTMLDivElement | null>(null)
  /** The newest peak, consumed and cleared by the draw loop. */
  const incoming = useRef(0)
  /** What the bar is currently showing, which is what falls. */
  const shown = useRef(0)

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[moduleId]
      if (next) incoming.current = next[0]
    })
  }, [engine, moduleId])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      // Taken once. Left in place it would hold the bar up for good once the
      // rack went quiet.
      const target = scale(incoming.current)
      incoming.current = 0

      const fallen = shown.current - FALL
      const v = target > fallen ? target : fallen > 0 ? fallen : 0
      if (v !== shown.current) {
        shown.current = v
        const el = bar.current
        if (el) el.style.clipPath = `inset(${(1 - v) * 100}% 0 0 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="osc-meter level-meter" aria-hidden="true">
      <div className="osc-meter-fill level-meter-fill" ref={bar} />
    </div>
  )
}
