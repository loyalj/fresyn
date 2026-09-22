import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from './theme'

/**
 * The current appearance, for the one kind of panel that cannot read the
 * stylesheet itself: a canvas. The scope pulls its palette off the DOM once
 * and then draws from a ref, so it needs to be told when that palette has
 * been replaced underneath it.
 */
export const ThemeContext = createContext<Appearance>(DEFAULT_APPEARANCE)

export function useAppearance() {
  return useContext(ThemeContext)
}

/**
 * Owns the choice: restores it, paints the document, and writes it back.
 *
 * A layout effect rather than an ordinary one, so the attributes are on
 * <html> before the browser paints the frame in which the theme changed.
 * main.tsx applies the stored appearance before React mounts at all, which
 * is what keeps the first paint from being the wrong colour.
 */
export function useAppearanceState() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance)

  useLayoutEffect(() => {
    applyAppearance(appearance)
    saveAppearance(appearance)
  }, [appearance])

  /**
   * Changing theme cross-fades rather than cuts.
   *
   * A transition on colour would only carry half the rack: most of a panel
   * is a gradient, and gradients do not interpolate, so the flat parts would
   * fade while the panels behind them snapped. A view transition fades a
   * picture of the old page into a picture of the new one, which does not
   * care what any of it was painted with.
   *
   * flushSync is what makes the callback worth snapshotting: the API wants
   * the DOM already changed by the time it returns, and an ordinary setState
   * would still be queued.
   */
  const change = useCallback((next: Appearance) => {
    const start = document.startViewTransition?.bind(document)
    if (!start || prefersReducedMotion()) {
      setAppearance(next)
      return
    }
    start(() => flushSync(() => setAppearance(next)))
  }, [])

  return [appearance, change] as const
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
