import type { Patch } from '../patch/types'
import { MASTER_RACK, DEFAULT_STRIP, type Song, type Track } from './types'

/**
 * Bus routing: which tracks' channels feed which.
 *
 * A bus is a track like any other -- a rack -- with a Bus In in it, which
 * plays whatever the song routes to that track. A channel reaches a bus two
 * ways: its output goes there in place of the master (`strip.out`), or a send
 * splits some of it off on the way past (`strip.sends`). Either way it is an
 * edge from one track to another, and the edges must never close a loop: a
 * bus is rendered after everything that feeds it, and a loop has no "after".
 *
 * The song layer cannot see racks, so it cannot tell a bus from a track
 * without a Bus In. It does not need to: an edge to a track that is not a bus
 * is let through here, and the engine sends that channel to the master.
 *
 * A rack can also hear another track through a Track In -- a sidechain --
 * which puts that track before it in the render order just as a route does.
 * Those edges live in the racks, so a caller that has them hands them in as
 * `Taps` (see `tapsOf`), and the loop checks count them too.
 */

/** The tracks each rack hears through its Track Ins, by the id of the track hearing them. */
export type Taps = ReadonlyMap<string, readonly string[]>

/** Which tracks each track's rack hears: tracks of the song only, and never itself. */
export function tapsOf(song: Song, racks: Readonly<Record<string, { patch: Patch } | undefined>>): Map<string, string[]> {
  const ids = new Set(song.tracks.map((t) => t.id))
  const taps = new Map<string, string[]>()
  for (const t of song.tracks) {
    const heard = new Set<string>()
    for (const m of racks[t.id]?.patch.modules ?? []) {
      if (m.type === 'trackin' && m.text && m.text !== t.id && ids.has(m.text)) heard.add(m.text)
    }
    if (heard.size) taps.set(t.id, [...heard])
  }
  // The master rack hears whatever its Track Ins name, and is always heard.
  const master = new Set<string>()
  for (const m of racks[MASTER_RACK]?.patch.modules ?? []) {
    if (m.type === 'trackin' && m.text && ids.has(m.text)) master.add(m.text)
  }
  if (master.size) taps.set(MASTER_RACK, [...master])
  return taps
}

/**
 * Every edge of the render order: each channel's routes, and from each
 * track to every rack that hears it. What a loop is a loop of.
 */
export function orderEdges(song: Song, taps?: Taps): Map<string, string[]> {
  const edges = busEdges(song)
  for (const [listener, sources] of taps ?? []) {
    for (const src of sources) {
      const to = edges.get(src)
      if (!to) edges.set(src, [listener])
      else if (!to.includes(listener)) to.push(listener)
    }
  }
  return edges
}

/** The bus a track's channel goes to in place of the master, if it names one. */
export function busOut(song: Song, track: Track): string | undefined {
  const out = track.strip?.out
  return out && out !== track.id && song.tracks.some((t) => t.id === out) ? out : undefined
}

/** A track's sends to other tracks of the song that are turned up, by bus id. */
export function busSends(song: Song, track: Track): Record<string, number> | undefined {
  const sends = track.strip?.sends
  if (!sends) return undefined
  let out: Record<string, number> | undefined
  for (const [bus, amount] of Object.entries(sends)) {
    if (!(amount > 0) || bus === track.id || !song.tracks.some((t) => t.id === bus)) continue
    ;(out ??= {})[bus] = amount
  }
  return out
}

/** Every track's edges: where its channel goes besides the master, by track id. */
export function busEdges(song: Song): Map<string, string[]> {
  const edges = new Map<string, string[]>()
  for (const t of song.tracks) {
    const to = new Set<string>()
    const out = busOut(song, t)
    if (out) to.add(out)
    for (const bus of Object.keys(busSends(song, t) ?? {})) to.add(bus)
    if (to.size) edges.set(t.id, [...to])
  }
  return edges
}

/** The same edges turned round: who feeds each track. */
export function reversed(edges: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const back = new Map<string, string[]>()
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const list = back.get(to)
      if (list) list.push(from)
      else back.set(to, [from])
    }
  }
  return back
}

/**
 * Everything reachable from `start` along `edges`, `start` included. `pass`
 * says whether a track can be stepped onto; one it refuses is not reached,
 * and nothing past it is reached through it.
 */
export function reach(
  edges: ReadonlyMap<string, readonly string[]>,
  start: Iterable<string>,
  pass: (id: string) => boolean = () => true,
): Set<string> {
  const seen = new Set(start)
  const todo = [...seen]
  while (todo.length) {
    for (const next of edges.get(todo.pop()!) ?? []) {
      if (seen.has(next) || !pass(next)) continue
      seen.add(next)
      todo.push(next)
    }
  }
  return seen
}

/**
 * Whether `from` can feed `to` -- by its output or by a send -- without a
 * loop: never itself, and never a track whose own audio already reaches
 * `from`, however many buses or Track Ins away.
 */
export function canRoute(song: Song, from: string, to: string, taps?: Taps): boolean {
  if (from === to || !song.tracks.some((t) => t.id === to)) return false
  return !reach(orderEdges(song, taps), [to]).has(from)
}

/**
 * Whether the rack of `listener` can hear `source` through a Track In
 * without a loop: never itself, and never a track that the listener's own
 * audio already reaches.
 */
export function canHear(song: Song, listener: string, source: string, taps?: Taps): boolean {
  if (listener === source || !song.tracks.some((t) => t.id === source)) return false
  return !reach(orderEdges(song, taps), [listener]).has(source)
}

/** Send one track's channel to a bus in place of the master, or with undefined back to the master. */
export function routeTo(song: Song, id: string, bus: string | undefined, taps?: Taps): Song {
  const track = song.tracks.find((t) => t.id === id)
  if (!track || (bus !== undefined && !canRoute(song, id, bus, taps))) return song
  if ((track.strip?.out ?? undefined) === bus) return song
  return withStrip(song, id, (s) => {
    const { out: _, ...rest } = s
    return bus === undefined ? rest : { ...rest, out: bus }
  })
}

/** Set one track's send to a bus, 0..1. Zero takes the send away. */
export function setSend(song: Song, id: string, bus: string, amount: number, taps?: Taps): Song {
  const track = song.tracks.find((t) => t.id === id)
  if (!track || !Number.isFinite(amount)) return song
  const a = Math.max(0, Math.min(1, amount))
  const was = track.strip?.sends?.[bus] ?? 0
  if (a === was) return song
  if (a > 0 && !canRoute(song, id, bus, taps)) return song
  return withStrip(song, id, (s) => {
    const sends = { ...s.sends }
    if (a > 0) sends[bus] = a
    else delete sends[bus]
    const { sends: _, ...rest } = s
    return Object.keys(sends).length ? { ...rest, sends } : rest
  })
}

/** Every route to a track taken away, as when the track itself is. */
export function unrouteFrom(song: Song, bus: string): Song {
  let changed = false
  const tracks = song.tracks.map((t) => {
    const s = t.strip
    if (!s || (s.out !== bus && !(s.sends && bus in s.sends))) return t
    changed = true
    const { out, sends, ...rest } = s
    const kept = { ...sends }
    delete kept[bus]
    return {
      ...t,
      strip: {
        ...rest,
        ...(out !== undefined && out !== bus ? { out } : {}),
        ...(Object.keys(kept).length ? { sends: kept } : {}),
      },
    }
  })
  return changed ? { ...song, tracks } : song
}

function withStrip(song: Song, id: string, change: (s: NonNullable<Track['strip']>) => NonNullable<Track['strip']>): Song {
  return {
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === id ? { ...t, strip: change(t.strip ?? DEFAULT_STRIP) } : t,
    ),
  }
}
