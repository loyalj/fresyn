import { useLayoutEffect, useRef, useState } from 'react'

type Actions<T> = { [K in keyof T]: (...args: never[]) => unknown }

/**
 * One object of callbacks whose identity never changes, each of which runs
 * the newest version of itself.
 *
 * For handing a lot of handlers down to something memoized. A callback that
 * closes over the patch is a new function every time the patch changes, and
 * a panel handed a new function re-renders -- so a knob turned on one unit
 * redrew every unit in the rack. Through this, the units are handed the same
 * object for the life of the page and re-render only for what they show.
 *
 * The keys are fixed by the first call. A handler is only ever called from an
 * event, after the render that defined it has committed, so reading it off a
 * ref updated in a layout effect is always the current one.
 */
export function useStableActions<T extends Actions<T>>(impl: T): T {
  const latest = useRef(impl)
  useLayoutEffect(() => {
    latest.current = impl
  })
  const [stable] = useState(() => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(impl) as (keyof T & string)[]) {
      out[key] = (...args: never[]) => latest.current[key](...args)
    }
    return out as T
  })
  return stable
}
