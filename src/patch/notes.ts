import type { Patch, RackNote, RackNoteColor } from './types'

/**
 * Notes stuck to the rack's modules: making them, editing them, keeping them
 * with their modules through every other edit, and reading them back from a
 * file that may say anything.
 *
 * A note is part of the patch, so it goes wherever a patch goes -- a project,
 * a patch file, the library, a Drum Kit's pad -- and every change to one is a
 * step of undo. It is never part of the sound: the compiler reads modules and
 * cables only, and a change to nothing but notes leaves the audio thread alone
 * (see `AudioEngine.setTrackPatch`).
 */

export const NOTE_COLORS: readonly RackNoteColor[] = ['yellow', 'green', 'blue', 'pink', 'violet']

/** The most a note holds: a few paragraphs, not a document. */
export const NOTE_MAX_TEXT = 4000

/** How far from a unit's corner a note can sit, so a hand-edited file cannot fling one off the page. */
const NOTE_REACH = 2000

const NONE: readonly RackNote[] = []

export function notesOf(patch: Patch): readonly RackNote[] {
  return patch.notes ?? NONE
}

/** The patch with these notes, written as no field at all when there are none. */
function withNotes(patch: Patch, notes: RackNote[]): Patch {
  const { notes: _, ...rest } = patch
  return notes.length ? { ...rest, notes } : rest
}

/** An id no note in the patch has: n1, n2, ... */
export function nextNoteId(patch: Patch): string {
  let n = 0
  for (const note of notesOf(patch)) {
    const k = /^n(\d+)$/.exec(note.id)
    if (k) n = Math.max(n, Number(k[1]))
  }
  return `n${n + 1}`
}

/** A new, empty note on a module. The id comes back with it, for focusing. */
export function addNote(
  patch: Patch,
  module: string,
  face: RackNote['face'],
  x: number,
  y: number,
  /** An id chosen beforehand, so the caller knows it; a fresh one if it is taken. */
  wanted?: string,
): { patch: Patch; id: string } {
  const id = wanted && !notesOf(patch).some((n) => n.id === wanted) ? wanted : nextNoteId(patch)
  const note: RackNote = { id, module, face, x: Math.round(x), y: Math.round(y), text: '' }
  return { patch: withNotes(patch, [...notesOf(patch), note]), id }
}

/** Some of a note's fields changed. The same patch back when nothing does. */
export function editNote(
  patch: Patch,
  id: string,
  change: Partial<Pick<RackNote, 'text' | 'color' | 'collapsed' | 'module' | 'face' | 'x' | 'y'>>,
): Patch {
  const notes = notesOf(patch)
  const at = notes.findIndex((n) => n.id === id)
  if (at < 0) return patch
  const was = notes[at]
  const next: RackNote = { ...was }
  if (change.text !== undefined) next.text = change.text.slice(0, NOTE_MAX_TEXT)
  if (change.module !== undefined && patch.modules.some((m) => m.id === change.module)) next.module = change.module
  if (change.face !== undefined) next.face = change.face
  if (change.x !== undefined) next.x = Math.round(change.x)
  if (change.y !== undefined) next.y = Math.round(change.y)
  if ('color' in change) {
    if (!change.color || change.color === 'yellow') delete next.color
    else next.color = change.color
  }
  if ('collapsed' in change) {
    if (change.collapsed) next.collapsed = true
    else delete next.collapsed
  }
  if (
    next.text === was.text &&
    next.module === was.module &&
    next.face === was.face &&
    next.x === was.x &&
    next.y === was.y &&
    next.color === was.color &&
    next.collapsed === was.collapsed
  ) {
    return patch
  }
  const out = notes.slice()
  out[at] = next
  return withNotes(patch, out)
}

export function removeNote(patch: Patch, id: string): Patch {
  const notes = notesOf(patch)
  if (!notes.some((n) => n.id === id)) return patch
  return withNotes(
    patch,
    notes.filter((n) => n.id !== id),
  )
}

/**
 * Only the notes on modules the patch still has: what every edit that takes
 * modules away hands back, so a note never outlives the module it was on.
 */
export function keepNotes(patch: Patch): Patch {
  const notes = notesOf(patch)
  if (notes.length === 0) return patch
  const ids = new Set(patch.modules.map((m) => m.id))
  const kept = notes.filter((n) => ids.has(n.module))
  return kept.length === notes.length ? patch : withNotes(patch, kept)
}

/**
 * Copies of the notes on `from`, stuck to `to` instead: a duplicated module
 * comes with its notes, as a pasted one does.
 */
export function copyNotes(patch: Patch, from: string, to: string): Patch {
  const mine = notesOf(patch).filter((n) => n.module === from)
  if (mine.length === 0) return patch
  let next = patch
  for (const note of mine) {
    const made = addNote(next, to, note.face, note.x, note.y)
    next = editNote(made.patch, made.id, { text: note.text, color: note.color, collapsed: note.collapsed })
  }
  return next
}

/**
 * Notes as a file holds them, read defensively: anything unusable is dropped
 * with a warning, the way a cable to a missing module is. A note has to be on
 * a module the patch has, with a face, a place and some text; colours and
 * folding fall back to the plain note.
 */
export function readNotes(raw: unknown, modules: ReadonlySet<string>, warnings: string[]): RackNote[] {
  if (!Array.isArray(raw)) return []
  const out: RackNote[] = []
  const ids = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const n = entry as Record<string, unknown>
    if (typeof n.module !== 'string' || !modules.has(n.module)) {
      warnings.push('dropped a note on a module that is not in the patch')
      continue
    }
    const place = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(-NOTE_REACH, Math.min(NOTE_REACH, v))) : 0)
    let id = typeof n.id === 'string' && n.id && !ids.has(n.id) ? n.id : ''
    if (!id) {
      let k = out.length + 1
      while (ids.has(`n${k}`)) k++
      id = `n${k}`
    }
    ids.add(id)
    const note: RackNote = {
      id,
      module: n.module,
      face: n.face === 'back' ? 'back' : 'front',
      x: place(n.x),
      y: place(n.y),
      text: typeof n.text === 'string' ? n.text.slice(0, NOTE_MAX_TEXT) : '',
    }
    if (typeof n.color === 'string' && NOTE_COLORS.includes(n.color as RackNoteColor) && n.color !== 'yellow') {
      note.color = n.color as RackNoteColor
    }
    if (n.collapsed === true) note.collapsed = true
    out.push(note)
  }
  return out
}

/** Notes as a file writes them: copies, with nothing but their own fields. */
export function writeNotes(notes: readonly RackNote[]): RackNote[] {
  return notes.map((n) => {
    const out: RackNote = { id: n.id, module: n.module, face: n.face, x: n.x, y: n.y, text: n.text }
    if (n.color) out.color = n.color
    if (n.collapsed) out.collapsed = true
    return out
  })
}

/**
 * The parts of two patches the audio cares about are the same: the same
 * modules and cables, whatever has happened to the notes. Identity first, as
 * every edit shares what it did not change.
 */
export function sameSound(a: Patch, b: Patch): boolean {
  return a === b || (a.modules === b.modules && a.cables === b.cables)
}
