import { MIN_VELOCITY, type Note } from './types'

/**
 * Edits to a group of notes in one pattern, for the roll.
 *
 * Pure, and in the song layer rather than beside the component, because every
 * one of these has an edge that is easy to get wrong -- a group pushed against
 * the end of the pattern, a note shortened past nothing, a paste that runs off
 * the end -- and those are far easier to pin down in a check than by dragging.
 *
 * A selection is a list of indices into the notes. Everything that returns
 * notes also returns the selection as it stands afterwards, so the roll never
 * has to work out where its notes went.
 */
export interface Edited {
  notes: Note[]
  selected: number[]
}

/** The group moved by the same amount, stopped as a whole at every edge. */
export function moveNotes(
  notes: readonly Note[],
  selected: readonly number[],
  dTick: number,
  dPitch: number,
  lengthTicks: number,
  keys: number,
): Edited {
  const group = selected.map((i) => notes[i]).filter(Boolean)
  if (group.length === 0) return { notes: [...notes], selected: [...selected] }
  // Clamped on the group's extremes rather than per note, or a chord pushed
  // into the top row would fold into a unison instead of stopping.
  const first = Math.min(...group.map((n) => n.tick))
  const last = Math.max(...group.map((n) => n.tick + n.length))
  const low = Math.min(...group.map((n) => n.pitch))
  const high = Math.max(...group.map((n) => n.pitch))
  const t = clamp(dTick, -first, Math.max(-first, lengthTicks - last))
  const p = clamp(dPitch, -low, keys - 1 - high)
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (n) out[i] = { ...n, tick: n.tick + t, pitch: n.pitch + p }
  }
  return { notes: out, selected: [...selected] }
}

/**
 * Every note in the group made longer or shorter by the same number of ticks,
 * from its end. A note never shrinks below one grid step, or below what it
 * already was if it is shorter than that, and never runs past the pattern.
 */
export function stretchEnds(
  notes: readonly Note[],
  selected: readonly number[],
  dLength: number,
  grid: number,
  lengthTicks: number,
): Edited {
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (!n) continue
    const shortest = Math.min(grid, n.length)
    const longest = Math.max(shortest, lengthTicks - n.tick)
    out[i] = { ...n, length: clamp(n.length + dLength, shortest, longest) }
  }
  return { notes: out, selected: [...selected] }
}

/** The same from the start: the ends stay put and the starts move. */
export function stretchStarts(
  notes: readonly Note[],
  selected: readonly number[],
  dTick: number,
  grid: number,
): Edited {
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (!n) continue
    const end = n.tick + n.length
    const shortest = Math.min(grid, n.length)
    const tick = clamp(n.tick + dTick, 0, end - shortest)
    out[i] = { ...n, tick, length: end - tick }
  }
  return { notes: out, selected: [...selected] }
}

/** Velocity moved by the same amount across the group, kept inside 0.01..1. */
export function shiftVelocity(
  notes: readonly Note[],
  selected: readonly number[],
  dVelocity: number,
): Edited {
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (n) out[i] = { ...n, velocity: round2(clamp(n.velocity + dVelocity, MIN_VELOCITY, 1)) }
  }
  return { notes: out, selected: [...selected] }
}

export function removeNotes(notes: readonly Note[], selected: readonly number[]): Edited {
  const gone = new Set(selected)
  return { notes: notes.filter((_, i) => !gone.has(i)), selected: [] }
}

/**
 * What a copy holds: the notes, in time order, counted from the first one's
 * start. Relative, so a paste can put them anywhere, and in time order so
 * the earliest one is the one that lands on the column that was asked for.
 */
export function copyNotes(notes: readonly Note[], selected: readonly number[]): Note[] {
  const group = selected.map((i) => notes[i]).filter(Boolean)
  if (group.length === 0) return []
  const first = Math.min(...group.map((n) => n.tick))
  return group
    .map((n) => ({ ...n, tick: n.tick - first }))
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
}

/**
 * A copy dropped in at `tick`, on `track`, and selected.
 *
 * On `track` whatever track it was copied from, so a riff lifted off the lead
 * pastes as the lead's when the lead is the part being written. Anything that
 * would start past the end of the pattern is left out, and anything that
 * would run past it is cut at the end, the way the scheduler would cut it.
 */
export function pasteNotes(
  notes: readonly Note[],
  clip: readonly Note[],
  tick: number,
  track: string,
  lengthTicks: number,
): Edited {
  const out = [...notes]
  const selected: number[] = []
  for (const c of clip) {
    const at = tick + c.tick
    if (at < 0 || at >= lengthTicks) continue
    selected.push(out.length)
    out.push({ ...c, track, tick: at, length: Math.min(c.length, lengthTicks - at) })
  }
  return { notes: out, selected }
}

/**
 * The group copied to start where it ends, rounded up to the grid, so a
 * one-bar phrase becomes two bars of it with the second one selected -- and
 * pressed again, three.
 */
export function duplicateNotes(
  notes: readonly Note[],
  selected: readonly number[],
  grid: number,
  lengthTicks: number,
  track: string,
): Edited {
  const group = selected.map((i) => notes[i]).filter(Boolean)
  if (group.length === 0) return { notes: [...notes], selected: [...selected] }
  const first = Math.min(...group.map((n) => n.tick))
  const last = Math.max(...group.map((n) => n.tick + n.length))
  const span = Math.max(grid, Math.ceil((last - first) / grid) * grid)
  return pasteNotes(notes, copyNotes(notes, selected), first + span, track, lengthTicks)
}

/**
 * The notes a rubber band touches: any overlap in time, and a row inside its
 * pitch range. Touching rather than enclosing, because a long note that starts
 * before the band is still plainly one of the notes it was drawn over.
 */
export function notesIn(
  notes: readonly Note[],
  fromTick: number,
  toTick: number,
  lowPitch: number,
  highPitch: number,
): number[] {
  const out: number[] = []
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (n.tick < toTick && n.tick + n.length > fromTick && n.pitch >= lowPitch && n.pitch <= highPitch) {
      out.push(i)
    }
  }
  return out
}

/**
 * Starts snapped to the nearest grid line, lengths kept. The ends are left
 * alone on purpose: a note's length is how it was played, and quantizing it
 * as well turns a legato line into a row of identical blocks.
 */
export function quantizeNotes(
  notes: readonly Note[],
  selected: readonly number[],
  grid: number,
  lengthTicks: number,
): Edited {
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (!n) continue
    const tick = clamp(Math.round(n.tick / grid) * grid, 0, Math.max(0, lengthTicks - grid))
    out[i] = { ...n, tick, length: Math.max(1, Math.min(n.length, lengthTicks - tick)) }
  }
  return { notes: out, selected: [...selected] }
}

/**
 * Each note nudged a little early or late, and a little softer or harder --
 * what separates a part that was played from one that was typed in.
 *
 * `random` is handed in rather than reached for, so a check can pin it down.
 * The result is written into the notes like any other edit, so a render of
 * the song afterwards is exactly as reproducible as it was before.
 */
export function humanizeNotes(
  notes: readonly Note[],
  selected: readonly number[],
  timing: number,
  velocity: number,
  lengthTicks: number,
  random: () => number,
): Edited {
  const out = [...notes]
  for (const i of selected) {
    const n = out[i]
    if (!n) continue
    const tick = clamp(Math.round(n.tick + (random() * 2 - 1) * timing), 0, Math.max(0, lengthTicks - 1))
    out[i] = {
      ...n,
      tick,
      length: Math.max(1, Math.min(n.length, lengthTicks - tick)),
      velocity: round2(clamp(n.velocity + (random() * 2 - 1) * velocity, MIN_VELOCITY, 1)),
    }
  }
  return { notes: out, selected: [...selected] }
}

/**
 * The group moved up or down by a number of scale degrees, each note along
 * the scale rather than by the same number of semitones -- so a C major triad
 * moved up one becomes D minor, which is what staying in the key means. Held
 * back as a whole, a degree at a time, if any note would leave the keyboard.
 */
export function transposeNotes(
  notes: readonly Note[],
  selected: readonly number[],
  degrees: number,
  keys: number,
  step: (pitch: number, degrees: number) => number,
): Edited {
  const group = selected.filter((i) => notes[i])
  for (let d = degrees; d !== 0; d -= Math.sign(d)) {
    const pitches = group.map((i) => step(notes[i].pitch, d))
    if (pitches.every((p) => p >= 0 && p < keys)) {
      const out = [...notes]
      group.forEach((i, k) => (out[i] = { ...out[i], pitch: pitches[k] }))
      return { notes: out, selected: [...selected] }
    }
  }
  return { notes: [...notes], selected: [...selected] }
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)
const round2 = (n: number) => Math.round(n * 100) / 100
