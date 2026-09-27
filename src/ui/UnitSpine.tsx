import type { ModuleDef } from '../patch/types'
import { PresetButton } from './PresetButton'

interface Props {
  def: ModuleDef
  moduleId: string
  /** Begin a reorder drag. Omitted, the spine is just a label. */
  onGrab?: (e: React.PointerEvent) => void
  /** Whether the module is switched out of the signal path. */
  bypassed?: boolean
  /** Switch it in or out. Omitted on a module that cannot be bypassed. */
  onBypass?: () => void
  /** Saving and loading this module's knobs; omitted on one with none. */
  presets?: { current: () => Record<string, number>; onApply: (params: Record<string, number>) => void }
}

/**
 * The rack ear: the strip that would be bolted to the rails, carrying the
 * module's name and its instance id.
 *
 * It is also the handle the unit is dragged by, which is why it is one
 * component rather than the same markup on each face -- both faces have to
 * be grabbable, because reordering is exactly what you want to do while
 * looking at the wiring.
 */
export function UnitSpine({ def, moduleId, onGrab, bypassed, onBypass, presets }: Props) {
  return (
    <div
      className="unit-spine"
      onPointerDown={onGrab}
      title={onGrab ? `Drag to move ${moduleId} in the rack` : undefined}
    >
      {/* On the ear rather than on the face, so it is in the same place on
          every filter and effect, on both sides of the rack, and never
          competes with a knob for room. Lit while the module is in the path,
          like the lamp on a stompbox. */}
      {onBypass && (
        <button
          className={`unit-bypass${bypassed ? '' : ' on'}`}
          // Not the start of a drag: the ear is the handle everywhere else.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onBypass}
          title={bypassed ? `${moduleId} is bypassed: click to switch it back in` : `Bypass ${moduleId}`}
          aria-label={bypassed ? `Switch ${moduleId} back in` : `Bypass ${moduleId}`}
          aria-pressed={bypassed}
          type="button"
        />
      )}
      {presets && def.params.length > 0 && (
        <PresetButton type={def.type} moduleId={moduleId} current={presets.current} onApply={presets.onApply} />
      )}
      <span className="unit-name">{def.name.toUpperCase()}</span>
      {/* The instance id, for telling osc1 from osc2 once a rack has both. */}
      <span className="unit-id">{moduleId}</span>
    </div>
  )
}
