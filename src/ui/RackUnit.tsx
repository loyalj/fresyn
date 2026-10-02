import { memo, useCallback, useContext, useMemo, useState } from 'react'
import type { PortRef } from '../patch/edit'
import type { ModuleDef, PatchModule, RackNote } from '../patch/types'
import { BackPanel } from './BackPanel'
import { UnitBoundary } from './ErrorBoundary'
import type { JackKind } from './Jack'
import { ContextMenu } from './Menu'
import { ModulePanel } from './ModulePanel'
import { NOTE_WIDTH, NoteActionsContext, UnitNotes } from './RackNotes'
import { TriggerButton } from './TriggerButton'
import { FaceShown } from './useFallingMeter'

/**
 * Everything a unit can ask the rack to do, each taking the unit's id.
 *
 * One object for the whole rack, the same one on every render (see
 * `useStableActions`), so that handing it down never counts as a change:
 * a unit re-renders for what it shows, not because its parent made new
 * closures.
 */
export interface RackActions {
  /** A press on the ear: picking, and the start of a reorder drag. */
  grab: (id: string, e: React.PointerEvent) => void
  /**
   * Open and close this unit's own gate, for a panel that is played. `ahead`
   * is knobs of this unit to send to the audio thread first; see KeysFace.
   */
  gate: (id: string, open: boolean, ahead?: Record<string, number>) => void
  /** A Trigger's button, pressed and let go. */
  press: (id: string) => void
  release: (id: string) => void
  /** A Trigger's key cap, waiting for a key or given one. */
  listen: (id: string, on: boolean) => void
  assignKey: (id: string, code: string | undefined) => void
  bypass: (id: string) => void
  /** Load a preset's knobs, as one step of undo. */
  applyPreset: (id: string, params: Record<string, number>) => void
  setParam: (id: string, paramId: string, value: number) => void
  /** Several of a module's knobs at once, as one step of undo. */
  setParams: (id: string, changes: Record<string, number>) => void
  /** What a Sampler plays, or nothing. */
  sample: (id: string, file: File | null) => void
  /** A Drum Kit's pad loaded from the library by instrument id, or emptied. */
  kitLoad: (id: string, slot: number, instrument: string | null) => void
  /** A pad renamed, or moved to another note. */
  kitPad: (id: string, slot: number, change: { name?: string; note?: number }) => void
  /** Every pad of a kit loaded with the standard kit. */
  kitStandard: (id: string) => void
  /** A pad sounded while it is held. */
  kitAudition: (id: string, slot: number, on: boolean) => void
  /** A pad's rack opened on the bench, to be edited while the kit plays. */
  kitEdit: (id: string, slot: number) => void
  register: (key: string, el: HTMLElement | null) => void
  jackDown: (ref: PortRef, kind: JackKind, e: React.PointerEvent) => void
  /** Patching from the keyboard; see `Jack`. */
  jackKey: (ref: PortRef, kind: JackKind, action: 'press' | 'focus') => void
  move: (id: string, delta: number) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
}

interface Props {
  def: ModuleDef
  module: PatchModule
  /**
   * The whole rack's knobs. Only this module's are looked at, and only a
   * change to one of those redraws the unit: see `sameUnit`.
   */
  values: Readonly<Record<string, number>>
  flipped: boolean
  /** The part of a row a half-width unit takes; see `rackShares`. */
  share?: number
  /** True while this is the unit being dragged up and down the rack. */
  dragging?: boolean
  /** Picked for copying, by a click on its ear. */
  selected?: boolean
  /** A Trigger held open by its latch. */
  latched?: boolean
  /** A Trigger's key cap waiting for a key. */
  listening?: boolean
  /** The render controls and takes, on the recorder that hosts them. */
  recorder?: React.ReactNode
  isOccupied: (ref: PortRef, kind: JackKind) => boolean
  isCandidate: (ref: PortRef, kind: JackKind) => boolean
  actions: RackActions
  /** For a Keyboard: the note its bottom key plays, to name its keys by. */
  tuning?: number
  /** The notes stuck to this module, on either face. The same array until one of them changes. */
  notes?: readonly RackNote[]
}

/**
 * Whether a unit would draw the same as it did: every prop the same, and of
 * the rack's knobs, this module's the same. Without the second half every
 * knob turned anywhere would redraw every unit, because the rack's values
 * are one object and a turn replaces it.
 */
function sameUnit(a: Props, b: Props) {
  const keys = Object.keys(a) as (keyof Props)[]
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (key !== 'values' && a[key] !== b[key]) return false
  }
  if (a.values === b.values) return true
  const prefix = `${a.module.id}.`
  for (const spec of a.def.params) {
    const key = prefix + spec.id
    if (a.values[key] !== b.values[key]) return false
  }
  return true
}

/**
 * A rack unit with both of its faces, in its own error boundary.
 *
 * The boundary is inside the memo rather than around it. A class component
 * re-renders whenever its parent does, and the unit it wraps is new children
 * every time, so a boundary out in the rack drew again for every knob turned
 * anywhere -- forty-five of them on a long rack, to find forty-four units
 * unchanged. In here it only draws when its unit does.
 */
export const RackUnit = memo(function RackUnit(props: Props) {
  return (
    <UnitBoundary moduleId={props.module.id} onRemove={props.actions.remove}>
      <UnitFaces {...props} />
    </UnitBoundary>
  )
}, sameUnit)

/**
 * Both faces. The two are stacked in the same grid cell so the unit is as
 * tall as the taller face and nothing shifts when the rack turns around.
 */
function UnitFaces({
  def,
  module,
  values,
  flipped,
  share,
  dragging,
  selected,
  latched,
  listening,
  recorder,
  isOccupied,
  isCandidate,
  actions,
  tuning,
  notes,
}: Props) {
  const moduleId = module.id
  const bypassed = !!module.bypass

  // --- notes --------------------------------------------------------------
  const noteActions = useContext(NoteActionsContext)
  const [front, back] = useMemo(() => {
    const all = notes ?? []
    return [all.filter((n) => n.face === 'front'), all.filter((n) => n.face === 'back')]
  }, [notes])
  /** Where a right-click asked for a menu, and where on the face showing it was. */
  const [menu, setMenu] = useState<{ x: number; y: number; at: { x: number; y: number } } | null>(null)
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // A knob and a switch have menus of their own, a jack is cleared by a
    // right-click, and a field keeps the browser's; a note says what it does
    // on its own buttons.
    const target = e.target as Element
    if (!noteActions || target.closest('.knob, .switch, .jack, .cables, .rack-note, input, textarea, select')) return
    const face = e.currentTarget.querySelector<HTMLElement>(flipped ? '.unit-face-back' : '.unit-face-front')
    if (!face) return
    const rect = face.getBoundingClientRect()
    // Where it was clicked, pulled in so the note fits on the unit.
    const at = {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width - NOTE_WIDTH)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height - 24)),
    }
    setMenu({ x: e.clientX, y: e.clientY, at })
  }

  const valueOf = useCallback((paramId: string) => values[`${moduleId}.${paramId}`], [values, moduleId])
  const onChange = useCallback(
    (paramId: string, v: number) => actions.setParam(moduleId, paramId, v),
    [actions, moduleId],
  )
  const onChanges = useCallback(
    (changes: Record<string, number>) => actions.setParams(moduleId, changes),
    [actions, moduleId],
  )
  const onGrab = useCallback((e: React.PointerEvent) => actions.grab(moduleId, e), [actions, moduleId])
  const onGate = useCallback(
    (open: boolean, ahead?: Record<string, number>) => actions.gate(moduleId, open, ahead),
    [actions, moduleId],
  )
  const onSample = useCallback((file: File | null) => actions.sample(moduleId, file), [actions, moduleId])
  const kit = useMemo(
    () =>
      def.type === 'kit'
        ? {
            slots: module.slots,
            onLoad: (slot: number, instrument: string | null) => actions.kitLoad(moduleId, slot, instrument),
            onPad: (slot: number, change: { name?: string; note?: number }) => actions.kitPad(moduleId, slot, change),
            onStandard: () => actions.kitStandard(moduleId),
            onAudition: (slot: number, on: boolean) => actions.kitAudition(moduleId, slot, on),
            onEdit: (slot: number) => actions.kitEdit(moduleId, slot),
          }
        : undefined,
    [def, module.slots, actions, moduleId],
  )
  const onBypass = useMemo(
    () => (def.bypass ? () => actions.bypass(moduleId) : undefined),
    [def, actions, moduleId],
  )
  const presets = useMemo(
    () => ({
      current: () =>
        Object.fromEntries(def.params.map((spec) => [spec.id, values[`${moduleId}.${spec.id}`] ?? spec.default])),
      // One edit, so a preset loaded by mistake is one Ctrl+Z.
      onApply: (params: Record<string, number>) => actions.applyPreset(moduleId, params),
    }),
    [def, values, actions, moduleId],
  )

  const faceExtra = def.trigger ? (
    <TriggerButton
      onDown={() => actions.press(moduleId)}
      onUp={() => actions.release(moduleId)}
      latched={latched}
      // Only a keyed module is handed the assignment props, so the cap
      // appears on the Trigger and nowhere else.
      {...(def.keyed
        ? {
            keyCode: module.key,
            listening,
            onListen: (on: boolean) => actions.listen(moduleId, on),
            onAssign: (code: string | undefined) => actions.assignKey(moduleId, code),
          }
        : {})}
    />
  ) : (
    recorder
  )

  return (
    // Named on the element so a drag can match a rectangle on the page back
    // to the module it belongs to, rather than trusting its position.
    <div
      className={`unit-flip${def.width === 'half' ? ' half' : ''}${
        flipped ? ' flipped' : ''
      }${dragging ? ' dragging' : ''}${selected ? ' selected' : ''}${bypassed ? ' bypassed' : ''}`}
      data-module={moduleId}
      // Focusable by script only, so jumping to a unit can put the focus on
      // it and the next Tab lands on its first control.
      tabIndex={-1}
      role="group"
      aria-label={`${def.name}, ${moduleId}`}
      style={share === undefined ? undefined : ({ '--share': share } as React.CSSProperties)}
      onContextMenu={onContextMenu}
    >
      {/* The face turned away is inert: out of the tab order, out of reach
          of the pointer and of elementFromPoint during a cable drag, and
          hidden from assistive technology, all in one attribute. Hidden with
          aria-hidden alone, its knobs were still Tab stops you could not see
          and its jacks still answered a click through the face in front. */}
      <div className="unit-face-front" inert={flipped}>
        {/* Its meters stand down while it faces the wall. */}
        <FaceShown.Provider value={!flipped}>
          <ModulePanel
            def={def}
            moduleId={moduleId}
            faceExtra={faceExtra}
            onGrab={onGrab}
            bypassed={bypassed}
            onBypass={onBypass}
            presets={presets}
            onGate={onGate}
            valueOf={valueOf}
            onChange={onChange}
            onChanges={onChanges}
            sample={module.sample}
            onSample={onSample}
            tuning={tuning}
            kit={kit}
          />
        </FaceShown.Provider>
        <UnitNotes notes={front} />
      </div>

      <div className="unit-face-back" inert={!flipped}>
        <BackPanel
          def={def}
          moduleId={moduleId}
          isOccupied={isOccupied}
          isCandidate={isCandidate}
          register={actions.register}
          onJackDown={actions.jackDown}
          onJackKey={actions.jackKey}
          onGrab={onGrab}
          bypassed={bypassed}
          onBypass={onBypass}
        />
        <UnitControls moduleId={moduleId} actions={actions} />
        <UnitNotes notes={back} />
      </div>

      {menu && noteActions && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              kind: 'action',
              label: 'Add note here',
              onSelect: () => noteActions.add(moduleId, flipped ? 'back' : 'front', menu.at.x, menu.at.y),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

interface ControlProps {
  moduleId: string
  actions: RackActions
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
function UnitControls({ moduleId, actions }: ControlProps) {
  return (
    <div className="unit-controls">
      <button
        title="Move up"
        aria-label={`Move ${moduleId} up`}
        onClick={() => actions.move(moduleId, -1)}
        type="button"
      >
        &#9650;
      </button>
      <button
        title="Move down"
        aria-label={`Move ${moduleId} down`}
        onClick={() => actions.move(moduleId, 1)}
        type="button"
      >
        &#9660;
      </button>
      {/* Beside the screws rather than on the front, because a copy arrives
          unpatched and the back is where you are when that matters. */}
      <button
        className="unit-duplicate"
        title="Duplicate"
        aria-label={`Duplicate ${moduleId}`}
        onClick={() => actions.duplicate(moduleId)}
      >
        &#10697;
      </button>
      <button
        className="unit-remove"
        title="Remove"
        aria-label={`Remove ${moduleId}`}
        onClick={() => actions.remove(moduleId)}
      >
        &times;
      </button>
    </div>
  )
}
