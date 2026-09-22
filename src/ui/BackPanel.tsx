import type { PortRef } from '../patch/edit'
import type { ModuleDef } from '../patch/types'
import { Jack, type JackKind } from './Jack'
import { UnitSpine } from './UnitSpine'

interface Props {
  def: ModuleDef
  moduleId: string
  isOccupied: (ref: PortRef, kind: JackKind) => boolean
  isCandidate: (ref: PortRef, kind: JackKind) => boolean
  register: (key: string, el: HTMLElement | null) => void
  onJackDown: (ref: PortRef, kind: JackKind, e: React.PointerEvent) => void
  /** Begin a reorder drag from this unit's spine. */
  onGrab?: (e: React.PointerEvent) => void
}

/**
 * The reverse of a rack unit: signal in on the left, out on the right, and
 * nothing else. Keeping the patch points on their own face is the whole point
 * of the rack metaphor -- the front stays readable because the wiring is not
 * competing with it for space.
 */
export function BackPanel({
  def,
  moduleId,
  isOccupied,
  isCandidate,
  register,
  onJackDown,
  onGrab,
}: Props) {
  const renderJack = (portId: string, label: string, kind: JackKind) => {
    const ref = { module: moduleId, port: portId }
    return (
      <Jack
        key={portId}
        moduleId={moduleId}
        portId={portId}
        label={label}
        kind={kind}
        occupied={isOccupied(ref, kind)}
        candidate={isCandidate(ref, kind)}
        register={register}
        onPointerDown={onJackDown}
      />
    )
  }

  return (
    <div className="unit unit-rear">
      <UnitSpine def={def} moduleId={moduleId} onGrab={onGrab} />

      <div className="unit-face back-face">
        <div className="jack-group">
          {def.inputs.length > 0 && <span className="jack-group-label">in</span>}
          {def.inputs.map((p) => renderJack(p.id, p.label, 'input'))}
        </div>

        <div className="jack-group jack-group-out">
          {def.outputs.map((p) => renderJack(p.id, p.label, 'output'))}
          {def.outputs.length > 0 && <span className="jack-group-label">out</span>}
        </div>
      </div>
    </div>
  )
}
