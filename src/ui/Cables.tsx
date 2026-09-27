import { memo, useSyncExternalStore, type CSSProperties } from 'react'
import { jackKey } from './Jack'
import { cablePath, type JackGeometry, type Point } from './cableGeometry'
import { signalOf, type Signal } from '../patch/defs'
import type { Cable, Patch } from '../patch/types'
import type { PortRef } from '../patch/edit'

export type { JackGeometry, Point }

export interface DragState {
  anchor: PortRef
  anchorKind: 'input' | 'output'
  /**
   * The cable was pulled out of a jack it was plugged into, rather than
   * started from a free one. Let go of over nothing, such a cable is simply
   * unplugged -- that is how a cable is taken out -- where a new one offers
   * the modules it could go to.
   */
  pulled?: true
  /**
   * Picked up with Enter or Space on a jack rather than by a drag. Nothing
   * is holding a pointer down, so a pointer's release does not plug it in
   * anywhere unless it lands on a jack, and Escape puts it down.
   */
  keyboard?: true
}

/**
 * Where the loose end of the cable in hand is, in rack coordinates.
 *
 * A little store rather than state, because it changes on every pointer
 * move: only the loose cable listens to it, so a drag redraws one path and
 * nothing else in the room.
 */
export interface CursorStore {
  get: () => Point
  set: (p: Point) => void
  subscribe: (fn: () => void) => () => void
}

export function cursorStore(): CursorStore {
  let at: Point = { x: 0, y: 0 }
  const listeners = new Set<() => void>()
  return {
    get: () => at,
    set: (p) => {
      if (p.x === at.x && p.y === at.y) return
      at = p
      for (const fn of listeners) fn()
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

interface Props {
  patch: Patch
  geometry: JackGeometry
  drag: DragState | null
  /** Where the loose end of `drag` is. */
  cursor: CursorStore
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
export const Cables = memo(function Cables({ patch, geometry, drag, cursor, hovered, colorBy }: Props) {
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

      {drag && anchorPoint && <LooseCable anchor={anchorPoint} hue={hueFor(drag.anchor)} cursor={cursor} />}
    </svg>
  )
})

/** The cable in hand, from its jack to wherever the pointer or the focus is. */
function LooseCable({ anchor, hue, cursor }: { anchor: Point; hue: number; cursor: CursorStore }) {
  const at = useSyncExternalStore(cursor.subscribe, cursor.get)
  const d = cablePath(anchor, at)
  return (
    <g className="cable cable-dragging" style={hueVar(hue)}>
      <path d={d} className="cable-shadow" />
      <path d={d} className="cable-line" />
      <circle cx={anchor.x} cy={anchor.y} r={4} className="cable-grip" />
    </g>
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
