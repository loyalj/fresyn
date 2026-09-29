export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /**
   * What each step was, for the History list: `labels[i]` names the edit
   * that produced `past[i]`, then `label` the one that produced `present`,
   * then `futureLabels[i]` the one that produces `future[i]`. Kept beside the
   * states rather than wrapped round them, so everything that reads a state
   * out of a history reads it the way it always has.
   */
  labels: string[]
  label: string
  futureLabels: string[]
}

/** How many steps back you can go before the oldest is forgotten. */
export const HISTORY_LIMIT = 100

/** What the first entry in the list is called: where the session started. */
export const OPENED = 'Opened'

export function initHistory<T>(present: T, label = OPENED): History<T> {
  return { past: [], present, future: [], labels: [], label, futureLabels: [] }
}

/**
 * Record a new state.
 *
 * `coalesce` folds the change into the current entry instead of pushing a new
 * one. Dragging a knob produces a value every frame, and without this a single
 * gesture would fill the whole history with steps nobody wants to undo one at
 * a time.
 *
 * `label` is what the step is called in the History list. A folded edit keeps
 * the name of the gesture it joined unless it brings one of its own.
 */
export function commit<T>(h: History<T>, next: T, coalesce = false, label?: string): History<T> {
  if (next === h.present) return h
  if (coalesce) {
    return { ...h, present: next, future: [], futureLabels: [], label: label ?? h.label }
  }

  const full = h.past.length >= HISTORY_LIMIT
  return {
    past: [...(full ? h.past.slice(1) : h.past), h.present],
    labels: [...(full ? h.labels.slice(1) : h.labels), h.label],
    present: next,
    label: label ?? 'Edit',
    future: [],
    futureLabels: [],
  }
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h
  return {
    past: h.past.slice(0, -1),
    labels: h.labels.slice(0, -1),
    present: h.past[h.past.length - 1],
    label: h.labels[h.labels.length - 1],
    future: [h.present, ...h.future],
    futureLabels: [h.label, ...h.futureLabels],
  }
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h
  return {
    past: [...h.past, h.present],
    labels: [...h.labels, h.label],
    present: h.future[0],
    label: h.futureLabels[0],
    future: h.future.slice(1),
    futureLabels: h.futureLabels.slice(1),
  }
}

/**
 * Go to the step at `index` in `steps(h)` in one move: several undos or
 * several redos, whichever way it lies. Nothing is lost on the way -- every
 * step jumped over is still there to jump back to, until the next edit.
 */
export function jumpTo<T>(h: History<T>, index: number): History<T> {
  const here = h.past.length
  const to = Math.max(0, Math.min(index, here + h.future.length))
  if (to === here) return h
  const all = [...h.past, h.present, ...h.future]
  const names = [...h.labels, h.label, ...h.futureLabels]
  return {
    past: all.slice(0, to),
    labels: names.slice(0, to),
    present: all[to],
    label: names[to],
    future: all.slice(to + 1),
    futureLabels: names.slice(to + 1),
  }
}

/** Every step in order, oldest first, and which one you are on. */
export function steps(h: History<unknown>): { labels: string[]; current: number } {
  return { labels: [...h.labels, h.label, ...h.futureLabels], current: h.past.length }
}

export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0
