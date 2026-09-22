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
}: Props) {
  const key = jackKey({ module: moduleId, port: portId })

  return (
    <div className="jack-slot">
      <div
        className={`jack jack-${kind}${occupied ? ' occupied' : ''}${candidate ? ' candidate' : ''}`}
        data-module={moduleId}
        data-port={portId}
        data-kind={kind}
        ref={(el) => register(key, el)}
        onPointerDown={(e) => onPointerDown({ module: moduleId, port: portId }, kind, e)}
        role="button"
        aria-label={`${kind} ${label}`}
      >
        <span className="jack-hole" />
      </div>
      <span className="jack-label">{label}</span>
    </div>
  )
}
