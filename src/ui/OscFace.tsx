import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { EnvelopeGraph } from './EnvelopeGraph'

const TONE = ['pitch', 'wave', 'width', 'fmAmount']
const ENVELOPE = ['delay', 'attack', 'hold', 'decay', 'sustain', 'release']

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  /** The oscillator's own trigger button. */
  faceExtra?: React.ReactNode
}

/**
 * The oscillator, with its envelope alongside it.
 *
 * The graph earns its space by being the only part of an envelope you can read
 * at a glance -- six knobs tell you the numbers but not the shape.
 */
export function OscFace({ def, valueOf, onChange, faceExtra }: Props) {
  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  const render = (id: string) => (
    <Control
      key={id}
      spec={byId[id]}
      value={valueOf(id)}
      onChange={(v) => onChange(id, v)}
    />
  )

  return (
    <div className="osc-face">
      <div className="osc-row">
        <div className="controls">{TONE.map(render)}</div>
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
          <div className="osc-amount">{render('envAmount')}</div>
        </div>
      </div>
    </div>
  )
}
