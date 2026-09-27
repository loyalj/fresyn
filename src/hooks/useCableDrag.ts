import { useCallback, useEffect, useRef, useState } from 'react'
import { cableInto, connect, disconnect, disconnectAt, type PortRef } from '../patch/edit'
import type { Patch } from '../patch/types'
import { cursorStore, type DragState, type Point } from '../ui/Cables'
import { jackKey, type JackKind } from '../ui/Jack'
import type { JackGeometry } from '../ui/cableGeometry'

interface Options {
  rackRef: React.RefObject<HTMLDivElement | null>
  patch: Patch
  geometry: JackGeometry
  editPatch: (fn: (p: Patch) => Patch) => void
  /** A new cable let go of over nothing: offer the modules that could take it. */
  onDropLoose: (cable: DragState) => void
}

/**
 * A cable in hand: picked up by a drag from a jack or by a key on one, and
 * plugged in, put down or offered to the module search when it is let go.
 *
 * Which cable is in hand is state, and changes twice a drag. Where its loose
 * end is changes on every pointer move, so it is not: it lives in `cursor`,
 * which only the loose cable itself listens to. Held in state, it re-rendered
 * the whole app for every pixel of every drag.
 */
export function useCableDrag({ rackRef, patch, geometry, editPatch, onDropLoose }: Options) {
  const [drag, setDragState] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [cursor] = useState(cursorStore)

  /** Set the cable in hand, and where its loose end is. */
  const setDrag = useCallback(
    (next: DragState | null, at?: Point) => {
      dragRef.current = next
      if (at) cursor.set(at)
      setDragState(next)
    },
    [cursor],
  )

  const cursorIn = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const base = rackRef.current?.getBoundingClientRect()
      if (!base) return { x: 0, y: 0 }
      return { x: e.clientX - base.left, y: e.clientY - base.top }
    },
    [rackRef],
  )

  const onJackDown = useCallback(
    (ref: PortRef, kind: JackKind, e: React.PointerEvent) => {
      e.preventDefault()

      // Right-click clears a jack outright; the context menu is suppressed by
      // the input layer so the button is free for this.
      if (e.button === 2) {
        editPatch((p) => disconnectAt(p, ref))
        return
      }

      const at = cursorIn(e)

      // Grabbing a patched input pulls that cable out and leaves you holding
      // the loose end, the way it works on a real panel.
      if (kind === 'input') {
        const existing = cableInto(patch, ref)
        if (existing) {
          editPatch((p) => disconnect(p, existing.id))
          setDrag({ anchor: existing.from, anchorKind: 'output', pulled: true }, at)
          return
        }
      }
      setDrag({ anchor: ref, anchorKind: kind }, at)
    },
    [patch, editPatch, cursorIn, setDrag],
  )

  /**
   * Patching from the keyboard: Enter or Space on a jack.
   *
   * The same cable in hand as a drag, marked as the keyboard's so the
   * pointer's release does not end it. With nothing in hand, a press picks
   * a cable up -- pulling it out of a patched input, as grabbing one does.
   * With a cable in hand, a press on a jack of the other kind plugs it in;
   * on one of the same kind it starts again from there. Escape puts it down.
   * As the focus moves between jacks the loose end follows it, so you can
   * see where it would go.
   */
  const onJackKey = useCallback(
    (ref: PortRef, kind: JackKind, action: 'press' | 'focus') => {
      const at = geometry[jackKey(ref)]
      const current = dragRef.current
      if (action === 'focus') {
        if (current?.keyboard && at) cursor.set(at)
        return
      }
      const point = at ?? { x: 0, y: 0 }

      if (current?.keyboard && kind !== current.anchorKind) {
        setDrag(null)
        const from = current.anchorKind === 'output' ? current.anchor : ref
        const to = current.anchorKind === 'output' ? ref : current.anchor
        editPatch((p) => connect(p, from, to))
        return
      }

      if (kind === 'input') {
        const existing = cableInto(patch, ref)
        if (existing) {
          editPatch((p) => disconnect(p, existing.id))
          setDrag({ anchor: existing.from, anchorKind: 'output', pulled: true, keyboard: true }, point)
          return
        }
      }
      setDrag({ anchor: ref, anchorKind: kind, keyboard: true }, point)
    },
    [geometry, patch, editPatch, cursor, setDrag],
  )

  const latestDrop = useRef(onDropLoose)
  useEffect(() => {
    latestDrop.current = onDropLoose
  })

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent) => cursor.set(cursorIn(e))

    const up = (e: PointerEvent) => {
      const current = dragRef.current
      setDrag(null)
      if (!current) return

      // Hit-test through the document rather than capturing the pointer:
      // capture would deliver pointerup to the jack the drag started on.
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const target = el instanceof Element ? el.closest('.jack') : null
      // A new cable let go of over nothing: offer the modules that could take
      // it, the way the fastest racks work -- the cable stays in hand until a
      // module is chosen for it, and Escape drops it. One pulled out of a jack
      // and let go of is unplugged, which is what that gesture has always been.
      // A cable picked up from the keyboard and clicked away is put down:
      // offering modules for it would be answering a question nobody asked.
      if (!(target instanceof HTMLElement)) {
        if (!current.pulled && !current.keyboard) latestDrop.current(current)
        return
      }

      const kind = target.dataset.kind as JackKind | undefined
      const ref = { module: target.dataset.module ?? '', port: target.dataset.port ?? '' }
      if (!kind || kind === current.anchorKind) return

      const from = current.anchorKind === 'output' ? current.anchor : ref
      const to = current.anchorKind === 'output' ? ref : current.anchor
      editPatch((p) => connect(p, from, to))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, editPatch, cursor, cursorIn, setDrag])

  /** Whether a jack would take the cable in hand: one of the other kind. */
  const isCandidate = useCallback(
    (_ref: PortRef, kind: JackKind) => drag !== null && kind !== drag.anchorKind,
    [drag],
  )

  /** Put down a cable picked up from the keyboard. True if there was one. */
  const putDownKeyboard = useCallback(() => {
    if (!dragRef.current?.keyboard) return false
    setDrag(null)
    return true
  }, [setDrag])

  return { drag, dragRef, cursor, cursorIn, onJackDown, onJackKey, isCandidate, putDownKeyboard }
}
