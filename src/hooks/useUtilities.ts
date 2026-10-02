import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { loadPrefs, savePrefs } from '../patch/storage'
import { UTILITIES, utilityById, type UtilityId, type UtilityProps } from '../utilities'

/**
 * Which utilities are open, in the order they are piled -- the last on top --
 * and each one's panel once its code has arrived.
 *
 * What is open is remembered with the page's other preferences, so a
 * calculator left beside the rack is still there after a reload. The code for
 * one is fetched the first time it opens and kept for the session.
 */
export function useUtilities(onFailed: (name: string) => void) {
  const [open, setOpen] = useState<UtilityId[]>(() =>
    (loadPrefs().utilitiesOpen ?? []).filter((id): id is UtilityId => !!utilityById(id)),
  )
  const [loaded, setLoaded] = useState<Partial<Record<UtilityId, ComponentType<UtilityProps>>>>({})

  useEffect(() => savePrefs({ utilitiesOpen: open }), [open])

  // Fetch whatever is open and not here yet, including what a reload reopened.
  useEffect(() => {
    for (const id of open) {
      if (loaded[id]) continue
      const utility = utilityById(id)!
      utility.load().then(
        (panel) => setLoaded((was) => (was[id] ? was : { ...was, [id]: panel })),
        () => {
          setOpen((was) => was.filter((x) => x !== id))
          onFailed(utility.name)
        },
      )
    }
  }, [open, loaded, onFailed])

  const close = useCallback((id: UtilityId) => setOpen((was) => was.filter((x) => x !== id)), [])
  const toggle = useCallback(
    (id: UtilityId) => setOpen((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id])),
    [],
  )
  /** To the top of the pile, where it is not already. */
  const raise = useCallback(
    (id: UtilityId) => setOpen((was) => (was[was.length - 1] === id ? was : [...was.filter((x) => x !== id), id])),
    [],
  )

  return { open, loaded, close, toggle, raise, all: UTILITIES }
}
