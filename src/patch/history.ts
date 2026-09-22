export interface History<T> {
  past: T[]
  present: T
  future: T[]
}

/** How many steps back you can go before the oldest is forgotten. */
export const HISTORY_LIMIT = 100

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

/**
 * Record a new state.
 *
 * `coalesce` folds the change into the current entry instead of pushing a new
 * one. Dragging a knob produces a value every frame, and without this a single
 * gesture would fill the whole history with steps nobody wants to undo one at
 * a time.
 */
export function commit<T>(h: History<T>, next: T, coalesce = false): History<T> {
  if (next === h.present) return h
  if (coalesce) return { past: h.past, present: next, future: [] }

  const past = h.past.length >= HISTORY_LIMIT ? h.past.slice(1) : h.past
  return { past: [...past, h.present], present: next, future: [] }
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  }
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h
  return {
    past: [...h.past, h.present],
    present: h.future[0],
    future: h.future.slice(1),
  }
}

export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0
