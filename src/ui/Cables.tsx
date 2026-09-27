import type { CSSProperties } from 'react'
import { jackKey } from './Jack'
import { cablePath, type JackGeometry, type Point } from './cableGeometry'
import { signalOf, type Signal } from '../patch/defs'
import type { Cable, Patch } from '../patch/types'
import type { PortRef } from '../patch/edit'

export type { JackGeometry, Point }

export interface DragState {
  anchor: PortRef
  anchorKind: 'input' | 'output'
  cursor: Point
  /**
   * The cable was pulled out of a jack it was plugged into, rather than
   * started from a free one. Let go of over nothing, such a cable is simply
   * unplugged -- that is how a cable is taken out -- where a new one offers
   * the modules it could go to.
   */
  pulled?: true
}

interface Props {
  patch: Patch
  geometry: JackGeometry
  drag: DragState | null
  /** The cable under the pointer, highlighted as grabbable. */
  hovered?: string
  /**
   * How cables are coloured when they have not been given a colour of their
   * own: by what they carry, or by the module they leave.
   */
  colorBy: 'signal' | 'module'
}

/**
 * Sound warm, control cool, gates green: three hues far enough apart to read
 * at a glance on every theme, which sets how saturated and light they are.
 */
const SIGNAL_HUE: Record<Signal, number> = { audio: 30, cv: 205, gate: 130 }

/**
 * The cable layer, drawn over the flipped rack. Cables hang rather than run
 * straight: the droop is what makes a dense patch readable, because two cables
 * between the same pair of rows take visibly different paths.
 *
 * Purely visual -- the layer never takes pointer events. Grabbing a cable is
 * resolved against the curve in `nearestCable`, so a jack underneath a cable
 * stays usable.
 */
export function Cables({ patch, geometry, drag, hovered, colorBy }: Props) {
  const anchorPoint = drag ? geometry[jackKey(drag.anchor)] : undefined
  const typeOf = new Map(patch.modules.map((m) => [m.id, m.type]))
  /** A cable's own colour, or the rack's for it. */
  const hueFor = (from: PortRef, own?: number) => {
    if (own !== undefined) return own
    if (colorBy === 'module') return hueOf(from.module)
    return SIGNAL_HUE[signalOf(typeOf.get(from.module) ?? '', from.port)]
  }

  return (
    <svg className="cables" aria-hidden="true">
      {patch.cables.map((c) => {
        const a = geometry[jackKey(c.from)]
        const b = geometry[jackKey(c.to)]
        if (!a || !b) return null
        const d = cablePath(a, b)
        const hue = hueFor(c.from, (c as Cable).color)

        return (
          <g key={c.id} className={`cable${hovered === c.id ? ' hovered' : ''}`} style={hueVar(hue)}>
            <path d={d} className="cable-shadow" />
            <path d={d} className="cable-line" />
            <circle cx={a.x} cy={a.y} r={4} className="cable-end" />
            <circle cx={b.x} cy={b.y} r={4} className="cable-end" />
          </g>
        )
      })}

      {drag && anchorPoint && (
        <g className="cable cable-dragging" style={hueVar(hueFor(drag.anchor))}>
          <path d={cablePath(anchorPoint, drag.cursor)} className="cable-shadow" />
          <path d={cablePath(anchorPoint, drag.cursor)} className="cable-line" />
          <circle cx={anchorPoint.x} cy={anchorPoint.y} r={4} className="cable-grip" />
        </g>
      )}
    </svg>
  )
}

/**
 * Only the hue is the cable's; how saturated and how light it is belongs to
 * the theme, which paints a cream rack's cables deep and a dark rack's lit.
 */
function hueVar(hue: number) {
  return { '--cable-h': String(hue) } as CSSProperties
}

/** Cables take their colour from the module they leave, as on a patched rack. */
function hueOf(moduleId: string) {
  let h = 0
  for (let i = 0; i < moduleId.length; i++) h = (h * 31 + moduleId.charCodeAt(i)) % 360
  return h
}
