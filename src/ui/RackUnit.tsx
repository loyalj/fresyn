import type { PortRef } from '../patch/edit'
import type { ModuleDef } from '../patch/types'
import { BackPanel } from './BackPanel'
import type { JackKind } from './Jack'
import { ModulePanel } from './ModulePanel'

interface Props {
  def: ModuleDef
  moduleId: string
  flipped: boolean
  /** The part of a row a half-width unit takes; see `rackShares`. */
  share?: number
  faceExtra?: React.ReactNode
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  /** What this module plays, for the one kind that plays a file. */
  sample?: { id: string; name: string }
  onSample?: (file: File | null) => void
  isOccupied: (ref: PortRef, kind: JackKind) => boolean
  isCandidate: (ref: PortRef, kind: JackKind) => boolean
  register: (key: string, el: HTMLElement | null) => void
  onJackDown: (ref: PortRef, kind: JackKind, e: React.PointerEvent) => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
  /** Begin a reorder drag from this unit's spine. */
  onGrab: (e: React.PointerEvent) => void
  /** Open and close this unit's own gate, for a panel that is played. */
  onGate: (open: boolean) => void
  /** True while this is the unit being dragged up and down the rack. */
  dragging?: boolean
  /** Picked for copying, by a click on its ear. */
  selected?: boolean
  /** Switched out of the signal path. */
  bypassed?: boolean
  /** Switch it in or out; omitted on a module that cannot be bypassed. */
  onBypass?: () => void
  /** Saving and loading this module's knobs as a preset. */
  presets?: { current: () => Record<string, number>; onApply: (params: Record<string, number>) => void }
}

/**
 * A rack unit with both of its faces. The two are stacked in the same grid
 * cell so the unit is as tall as the taller face and nothing shifts when the
 * rack turns around.
 */
export function RackUnit({
  def,
  moduleId,
  flipped,
  share,
  faceExtra,
  onMove,
  onDuplicate,
  onRemove,
  onGrab,
  onGate,
  dragging,
  selected,
  bypassed,
  onBypass,
  presets,
  ...rest
}: Props) {

  return (
    // Named on the element so a drag can match a rectangle on the page back
    // to the module it belongs to, rather than trusting its position.
    <div
      className={`unit-flip${def.width === 'half' ? ' half' : ''}${
        flipped ? ' flipped' : ''
      }${dragging ? ' dragging' : ''}${selected ? ' selected' : ''}${bypassed ? ' bypassed' : ''}`}
      data-module={moduleId}
      style={share === undefined ? undefined : ({ '--share': share } as React.CSSProperties)}
    >
      {/* The face turned away is hidden from assistive technology as well as
          from the pointer. */}
      <div className="unit-face-front" aria-hidden={flipped}>
        <ModulePanel
          def={def}
          moduleId={moduleId}
          faceExtra={faceExtra}
          onGrab={onGrab}
          bypassed={bypassed}
          onBypass={onBypass}
          presets={presets}
          onGate={onGate}
          valueOf={rest.valueOf}
          onChange={rest.onChange}
          sample={rest.sample}
          onSample={rest.onSample}
        />
      </div>

      <div className="unit-face-back" aria-hidden={!flipped}>
        <BackPanel
          def={def}
          moduleId={moduleId}
          isOccupied={rest.isOccupied}
          isCandidate={rest.isCandidate}
          register={rest.register}
          onJackDown={rest.onJackDown}
          onGrab={onGrab}
          bypassed={bypassed}
          onBypass={onBypass}
        />
        <UnitControls
          moduleId={moduleId}
          onMove={onMove}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      </div>
    </div>
  )
}

interface ControlProps {
  moduleId: string
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
}

/**
 * Rack screws: on the back panel only, and visible on hover.
 *
 * Building a rack is what you do from behind it -- that is where the wiring
 * is, and where a unit being moved or pulled has consequences you can see.
 * The front is for playing, so nothing there competes with the controls that
 * make a sound. Dragging a unit by its spine works from either side.
 *
 * The arrows stay alongside the drag because a drag is a pointer gesture and
 * nothing else: they are the way to move a unit from the keyboard.
 */
function UnitControls({ moduleId, onMove, onDuplicate, onRemove }: ControlProps) {
  return (
    <div className="unit-controls">
      <button title="Move up" aria-label={`Move ${moduleId} up`} onClick={() => onMove(-1)}>
        &#9650;
      </button>
      <button title="Move down" aria-label={`Move ${moduleId} down`} onClick={() => onMove(1)}>
        &#9660;
      </button>
      {/* Beside the screws rather than on the front, because a copy arrives
          unpatched and the back is where you are when that matters. */}
      <button
        className="unit-duplicate"
        title="Duplicate"
        aria-label={`Duplicate ${moduleId}`}
        onClick={onDuplicate}
      >
        &#10697;
      </button>
      <button
        className="unit-remove"
        title="Remove"
        aria-label={`Remove ${moduleId}`}
        onClick={onRemove}
      >
        &times;
      </button>
    </div>
  )
}
