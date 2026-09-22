import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Held {
  id: string
  /** Where the rack sits right now, which is not yet where the patch sits. */
  order: string[]
  /** The panel's size, so the thing under the pointer is the right shape. */
  ghost: { width: number; height: number }
}

export interface RackDrag {
  /** The unit being dragged, or null when nothing is. */
  id: string | null
  /** Module ids in the order to render; the patch's own order when idle. */
  order: string[]
  /** Size of the panel riding under the pointer, fixed when the drag began. */
  ghost: { width: number; height: number } | null
  /** Attach to the element that follows the pointer. */
  ghostRef: React.RefObject<HTMLDivElement | null>
  /** Begin a drag, from a pointer down on a unit's spine. */
  start: (id: string, e: React.PointerEvent) => void
}

/**
 * Dragging a unit around the rack by its spine.
 *
 * The rack reorders under the pointer as you drag, but the patch does not:
 * the provisional order lives here until the drag is let go, and only then
 * does one edit land. Committing each crossing instead would recompile the
 * graph a dozen times on the way past and leave a dozen steps to undo
 * afterwards, when what happened was that a unit was moved once.
 */
export function useRackDrag(
  ids: string[],
  rackRef: React.RefObject<HTMLElement | null>,
  onReorder: (ids: string[]) => void,
): RackDrag {
  const [held, setHeld] = useState<Held | null>(null)

  /**
   * The handlers run on the window for the life of the drag, so they read
   * everything through refs rather than through a closure captured when the
   * drag began.
   */
  const state = useRef<Held | null>(null)
  const latest = useRef({ ids, onReorder })
  const pointer = useRef({ x: 0, y: 0 })
  /** Where in the panel it was picked up, so it does not jump to the cursor. */
  const grab = useRef({ x: 0, y: 0 })
  const ghostRef = useRef<HTMLDivElement | null>(null)
  /**
   * False between asking for a new order and the browser having laid it out.
   * The pointer is compared against rectangles read from the page, and a
   * rectangle read before the last move has been painted describes where a
   * unit used to be -- which is how a drag ends up jumping two places at
   * once, or swapping back and forth against its own stale position.
   */
  const settled = useRef(true)
  /** Chained steps left before the next pointer event, as a stop. */
  const chase = useRef(0)

  useEffect(() => {
    latest.current = { ids, onReorder }
  })

  /**
   * The carried panel is moved by writing its transform straight to the
   * element. Putting the pointer into state instead would re-render the whole
   * rack sixty times a second for the sake of one box moving.
   */
  const place = useCallback(() => {
    const el = ghostRef.current
    if (!el) return
    const x = pointer.current.x - grab.current.x
    const y = pointer.current.y - grab.current.y
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }, [])

  /**
   * Move the held unit one place, if the pointer has earned it.
   *
   * One place at a time, and only once the pointer is past the middle of the
   * neighbour it would displace -- see `passed`. Half a neighbour of travel is
   * what stops a rack of tall and short units from flickering as they trade
   * places.
   */
  const step = useCallback(() => {
    const drag = state.current
    const host = rackRef.current
    if (!drag || !host || !settled.current) return

    const from = drag.order.indexOf(drag.id)
    if (from < 0) return

    // Units are matched to ids rather than taken by position, so there is
    // never a question of which rectangle belongs to which module.
    const rects = new Map<string, DOMRect>()
    for (const el of host.querySelectorAll<HTMLElement>('.unit-flip')) {
      const id = el.dataset.module
      if (id) rects.set(id, el.getBoundingClientRect())
    }

    // The gap the unit left behind, which is what says whether a neighbour is
    // beside it or below it.
    const self = rects.get(drag.id)
    let to = from
    const next = rects.get(drag.order[from + 1])
    const prev = rects.get(drag.order[from - 1])
    if (next && passed(next, 1, self, pointer.current)) to = from + 1
    else if (prev && passed(prev, -1, self, pointer.current)) to = from - 1
    if (to === from) return

    const order = drag.order.slice()
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    settled.current = false
    setHeld({ ...drag, order })
  }, [rackRef])

  useLayoutEffect(() => {
    state.current = held
    // Before the first paint of the drag, so the panel never flashes up in
    // the corner on its way to the pointer.
    place()
    if (settled.current) return
    settled.current = true
    // A flick can cross several units between two pointer events, and the
    // events that would have carried the rest of the journey are already
    // over. Keep stepping towards where the pointer is until the rack has
    // caught up with it; the midpoint rule is what makes that terminate,
    // and the counter is there in case some layout finds a way round it.
    if (chase.current > 0) {
      chase.current--
      step()
    }
  })

  const start = useCallback((id: string, e: React.PointerEvent) => {
    // Left button only: right-click anywhere on a unit belongs to the rack,
    // which uses it to clear a jack.
    if (e.button !== 0) return
    const unit = (e.target as Element).closest('.unit-flip')
    if (!unit) return
    e.preventDefault()

    const box = unit.getBoundingClientRect()
    pointer.current = { x: e.clientX, y: e.clientY }
    grab.current = { x: e.clientX - box.left, y: e.clientY - box.top }
    setHeld({
      id,
      order: latest.current.ids.slice(),
      ghost: { width: box.width, height: box.height },
    })
  }, [])

  const dragging = held !== null
  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
      place()
      chase.current = state.current?.order.length ?? 0
      step()
    }

    const end = () => {
      const drag = state.current
      chase.current = 0
      setHeld(null)
      if (!drag) return
      const before = latest.current.ids
      const changed =
        drag.order.length === before.length && drag.order.some((id, i) => id !== before[i])
      if (changed) latest.current.onReorder(drag.order)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [dragging, step, place])

  return {
    id: held?.id ?? null,
    order: held?.order ?? ids,
    ghost: held?.ghost ?? null,
    ghostRef,
    start,
  }
}

/**
 * Has the pointer earned this neighbour's place?
 *
 * Half a neighbour of travel, measured down the rack -- or across it when the
 * two are sharing a row, which is what a pair of half-width panels does. Two
 * panels side by side trade places sideways; anything else is passed by
 * dropping below it. A pointer that has left the row vertically falls back to
 * the vertical test either way, so a half panel dragged straight down is never
 * held up by the one beside it.
 */
function passed(
  neighbour: DOMRect,
  dir: 1 | -1,
  self: DOMRect | undefined,
  p: { x: number; y: number },
) {
  const sharesRow = self !== undefined && neighbour.top < self.bottom && neighbour.bottom > self.top
  if (sharesRow && p.y > neighbour.top && p.y < neighbour.bottom) {
    const mid = neighbour.left + neighbour.width / 2
    return dir > 0 ? p.x > mid : p.x < mid
  }
  const mid = neighbour.top + neighbour.height / 2
  return dir > 0 ? p.y > mid : p.y < mid
}
