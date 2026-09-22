import type { ModuleDef } from '../patch/types'

interface Props {
  def: ModuleDef
  moduleId: string
  /** Begin a reorder drag. Omitted, the spine is just a label. */
  onGrab?: (e: React.PointerEvent) => void
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
export function UnitSpine({ def, moduleId, onGrab }: Props) {
  return (
    <div
      className="unit-spine"
      onPointerDown={onGrab}
      title={onGrab ? `Drag to move ${moduleId} in the rack` : undefined}
    >
      <span className="unit-name">{def.name.toUpperCase()}</span>
      {/* The instance id, for telling osc1 from osc2 once a rack has both. */}
      <span className="unit-id">{moduleId}</span>
    </div>
  )
}
