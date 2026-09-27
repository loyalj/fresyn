import type { PortRef } from '../patch/edit'

export type JackKind = 'input' | 'output'

export function jackKey(ref: PortRef) {
  return `${ref.module}.${ref.port}`
}

interface Props {
  moduleId: string
  portId: string
  label: string
  kind: JackKind
  /** True while a cable is plugged into, or being dragged from, this jack. */
  occupied: boolean
  /** A drag is in flight and this jack is a legal destination. */
  candidate: boolean
  register: (key: string, el: HTMLElement | null) => void
  onPointerDown: (ref: PortRef, kind: JackKind, e: React.PointerEvent) => void
  /**
   * The keyboard's way of patching: Enter or Space on a jack picks a cable
   * up from it, or plugs the one in hand into it. `focus` says the focus has
   * arrived on the jack, so a cable in hand can be drawn reaching for it.
   */
  onKey?: (ref: PortRef, kind: JackKind, action: 'press' | 'focus') => void
}

/** One patch point on a module's back panel. */
export function Jack({
  moduleId,
  portId,
  label,
  kind,
  occupied,
  candidate,
  register,
  onPointerDown,
  onKey,
}: Props) {
  const key = jackKey({ module: moduleId, port: portId })
  const ref = { module: moduleId, port: portId }

  return (
    <div className="jack-slot">
      <div
        className={`jack jack-${kind}${occupied ? ' occupied' : ''}${candidate ? ' candidate' : ''}`}
        data-module={moduleId}
        data-port={portId}
        data-kind={kind}
        ref={(el) => register(key, el)}
        onPointerDown={(e) => onPointerDown(ref, kind, e)}
        onKeyDown={(e) => {
          if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          onKey?.(ref, kind, 'press')
        }}
        onFocus={() => onKey?.(ref, kind, 'focus')}
        // A stop in the tab order, so a rack can be patched without a
        // pointer. Only while its face is turned towards you: the face
        // turned away is inert, which takes every jack on it out as well.
        tabIndex={0}
        role="button"
        // Everything needed to patch by ear: whose jack, which one, which
        // way the signal goes, and whether a cable is in it already.
        aria-label={`${moduleId} ${label} ${kind}${occupied ? ', patched' : ''}${candidate ? ', press to plug in' : ''}`}
      >
        <span className="jack-hole" />
      </div>
      <span className="jack-label">{label}</span>
    </div>
  )
}
