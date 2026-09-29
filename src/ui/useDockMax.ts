import { useEffect, useState } from 'react'

/** The tallest the Music dock's body is drawn on a big screen. */
export const DOCK_MAX_H = 620
/** The shortest it can be dragged to, when the window has room for it. */
export const DOCK_MIN_H = 160
/**
 * The most of the window the whole dock may take, bar and body together.
 * Past it the rack above has nowhere left to be.
 */
const DOCK_SHARE = 0.6

function maxFor(windowHeight: number, reserve: number) {
  return Math.max(120, Math.min(DOCK_MAX_H, Math.round(windowHeight * DOCK_SHARE - reserve)))
}

/**
 * How tall the dock may be in this window, kept up to date as it resizes.
 *
 * A saved height is a height that suited some other window. Restored on a
 * phone, or kept through a window dragged smaller, 620 pixels of roll left
 * the rack no room at all -- so the height is capped here, where it is drawn,
 * rather than rewritten, and turning the phone round gives it back.
 *
 * `reserve` is what else of the dock is standing: its bar, which on a narrow
 * window wraps to four rows and is most of the problem.
 */
export function useDockMax(reserve = 0) {
  const [windowHeight, setWindowHeight] = useState(() =>
    typeof window === 'undefined' ? Infinity : window.innerHeight,
  )
  useEffect(() => {
    const update = () => setWindowHeight(window.innerHeight)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return maxFor(windowHeight, reserve)
}

/** The height to draw: what was asked for, within what the window allows. */
export function dockHeightWithin(height: number, max: number) {
  return Math.max(Math.min(DOCK_MIN_H, max), Math.min(height, max))
}
