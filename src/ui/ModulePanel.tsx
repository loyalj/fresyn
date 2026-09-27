import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { KeysFace } from './KeysFace'
import { LadderFace } from './LadderFace'
import { LfoFace } from './LfoFace'
import { MixerFace } from './MixerFace'
import { SamplerFace } from './SamplerFace'
import { OscFace } from './OscFace'
import { ScopeFace } from './ScopeFace'
import { SeqFace } from './SeqFace'
import { KnobHelpModule } from './KnobHelp'
import { UnitSpine } from './UnitSpine'

interface Props {
  /** What a Sampler is pointed at, and what to do when that changes. */
  sample?: { id: string; name: string }
  onSample?: (file: File | null) => void
  def: ModuleDef
  moduleId: string
  /** Controls a module needs that are not knobs, such as a trigger button. */
  faceExtra?: React.ReactNode
  /** Begin a reorder drag from this unit's spine. */
  onGrab?: (e: React.PointerEvent) => void
  bypassed?: boolean
  onBypass?: () => void
  presets?: { current: () => Record<string, number>; onApply: (params: Record<string, number>) => void }
  /** Open and close this module's own gate, for a panel that is played. */
  onGate?: (open: boolean) => void
  /** Undefined for a module whose knobs have not been seeded yet. */
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/**
 * The front panel of one rack unit, built from the module's definition. The
 * back panel with its patch points is a separate view; this side only ever
 * shows controls.
 */
export function ModulePanel({
  def,
  moduleId,
  faceExtra,
  onGrab,
  bypassed,
  onBypass,
  presets,
  onGate,
  valueOf,
  onChange,
  sample,
  onSample,
}: Props) {
  return (
    <div className="unit">
      <UnitSpine
        def={def}
        moduleId={moduleId}
        onGrab={onGrab}
        bypassed={bypassed}
        onBypass={onBypass}
        presets={presets}
      />
      {/* Every knob on the face finds its help under this module's name. */}
      <KnobHelpModule.Provider value={def.name}>
        <div className="unit-face">{face()}</div>
      </KnobHelpModule.Provider>
    </div>
  )

  function face() {
    // A few modules are worth laying out by hand; the rest are a row of knobs.
    if (def.type === 'osc') {
      return (
        <OscFace
          def={def}
          moduleId={moduleId}
          valueOf={valueOf}
          onChange={onChange}
          faceExtra={faceExtra}
        />
      )
    }
    if (def.type === 'lfo') {
      return (
        <LfoFace def={def} valueOf={valueOf} onChange={onChange} faceExtra={faceExtra} />
      )
    }
    if (def.type === 'ladder') {
      return (
        <LadderFace def={def} valueOf={valueOf} onChange={onChange} faceExtra={faceExtra} />
      )
    }
    if (def.type === 'sampler') {
      return (
        <SamplerFace
          def={def}
          moduleId={moduleId}
          sample={sample}
          valueOf={valueOf}
          onChange={onChange}
          onLoad={(file) => onSample?.(file)}
          onClear={() => onSample?.(null)}
          faceExtra={faceExtra}
        />
      )
    }
    // The recorder has no knobs of its own -- it takes the level it is given
    // -- so its panel is nothing but the render controls and the takes.
    if (def.type === 'rec') {
      return <div className="rec-face">{faceExtra}</div>
    }
    if (def.type === 'scope') {
      return (
        <>
          <ScopeFace def={def} moduleId={moduleId} valueOf={valueOf} onChange={onChange} />
          {faceExtra}
        </>
      )
    }
    if (def.type === 'keys') {
      return (
        <KeysFace
          def={def}
          valueOf={valueOf}
          onChange={onChange}
          onGate={onGate}
        />
      )
    }
    if (def.type === 'seq') {
      return (
        <>
          <SeqFace def={def} moduleId={moduleId} valueOf={valueOf} onChange={onChange} />
          {faceExtra}
        </>
      )
    }
    if (def.type === 'mixer') {
      return (
        <>
          <MixerFace def={def} moduleId={moduleId} valueOf={valueOf} onChange={onChange} />
          {faceExtra}
        </>
      )
    }
    // Played parameters are set by a module's own face, so the generic row
    // must not draw a knob for them as well.
    const knobs = def.params.filter((spec) => !spec.played)
    return (
      <>
        {knobs.length > 0 && (
          <div className="controls">
            {knobs.map((spec) => (
              <Control
                key={spec.id}
                spec={spec}
                value={valueOf(spec.id)}
                onChange={(v) => onChange(spec.id, v)}
              />
            ))}
          </div>
        )}
        {faceExtra}
      </>
    )
  }
}
