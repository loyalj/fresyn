import { curveAt, type Curve, type ValueMap } from '../dsp/automation'
import { defOf } from '../patch/defs'
import { kitSlots } from '../patch/kit'
import type { ParamSpec } from '../patch/param'
import type { Patch } from '../patch/types'
import { clipEnd, clipOffset } from './clip'
import { MASTER_RACK, type AutomationLane, type AutomationPoint, type Pattern, type Placement, type Song } from './types'

/**
 * Automation: knobs that move by themselves while a pattern plays.
 *
 * A lane lives in a pattern, beside its notes, and plays wherever the
 * pattern's clips play -- repeated, trimmed and split with them, and taken
 * with a section that is moved. This file is everything about it that is a
 * question about the song: what a lane's target names, where its curve
 * stands at a tick, and which stretch of which curve is in force across a
 * window of the song. Like the rest of `song/`, it knows nothing of the
 * browser, so the live transport, a bounce and a game all ask it the same
 * questions and get the same answers.
 *
 * Where no clip is automating a knob, the knob is wherever its panel says.
 * Where two clips automating the same knob overlap, the one that started
 * later has it, until it ends.
 */

// --- targets -------------------------------------------------------------

/**
 * What a lane moves, written as a path:
 *
 *   rack/<track>/<module>.<param>   a knob in a track's rack; inside a Drum
 *                                   Kit's pad the module carries the pad's
 *                                   prefix, as the rack's own keys do
 *   strip/<track>/<what>            gain, pan, space, delay, high, mid, low
 *   master/<what>                   level, balance, high, mid, low
 *   space/<what>, delay/<what>      the shared effects' size, decay, damping,
 *                                   level; time, feedback, damping, level
 *
 * A track is named by its id, not its place: a song has to know exactly what
 * it moves, where a MIDI controller's mapping is about the desk in front of
 * you.
 */
export type TargetInfo =
  | { kind: 'rack'; track: string; key: string; module: string; param: string }
  | { kind: 'strip'; track: string; what: StripParam }
  | { kind: 'bus'; bus: Bus; what: string }

export type Bus = 'master' | 'space' | 'delay'
export const STRIP_PARAMS = ['gain', 'pan', 'space', 'delay', 'high', 'mid', 'low'] as const
export type StripParam = (typeof STRIP_PARAMS)[number]
export const BUS_PARAMS: Record<Bus, readonly string[]> = {
  master: ['level', 'balance', 'high', 'mid', 'low'],
  space: ['size', 'decay', 'damping', 'level'],
  delay: ['time', 'feedback', 'damping', 'level'],
}

export const rackTarget = (track: string, key: string) => `rack/${track}/${key}`
export const stripTarget = (track: string, what: StripParam) => `strip/${track}/${what}`
export const busTarget = (bus: Bus, what: string) => `${bus}/${what}`

export function parseTarget(target: string): TargetInfo | null {
  const slash = target.indexOf('/')
  if (slash < 0) return null
  const scope = target.slice(0, slash)
  const rest = target.slice(slash + 1)
  if (scope === 'rack' || scope === 'strip') {
    const at = rest.indexOf('/')
    if (at <= 0) return null
    const track = rest.slice(0, at)
    const tail = rest.slice(at + 1)
    if (scope === 'strip') {
      return (STRIP_PARAMS as readonly string[]).includes(tail) ? { kind: 'strip', track, what: tail as StripParam } : null
    }
    const dot = tail.lastIndexOf('.')
    if (dot <= 0 || dot === tail.length - 1) return null
    return { kind: 'rack', track, key: tail, module: tail.slice(0, dot), param: tail.slice(dot + 1) }
  }
  if (scope === 'master' || scope === 'space' || scope === 'delay') {
    return BUS_PARAMS[scope].includes(rest) ? { kind: 'bus', bus: scope, what: rest } : null
  }
  return null
}

/** The track a target belongs to, or null for the master and the returns. */
export function targetTrack(target: string): string | null {
  const t = parseTarget(target)
  return t && t.kind !== 'bus' ? t.track : null
}

/** A module in a rack, or in one of its Drum Kit's pads by its laid-in id (`kit/slot/inner`). */
export function moduleAt(patch: Patch, id: string): { type: string } | null {
  const own = patch.modules.find((m) => m.id === id)
  if (own) return own
  const [kit, slot, ...inner] = id.split('/')
  if (!inner.length) return null
  const host = patch.modules.find((m) => m.id === kit)
  const pad = host ? kitSlots(host)[Number(slot) - 1] : null
  return pad ? moduleAt(pad.patch, inner.join('/')) : null
}

/** The knob a rack target is, in a patch: its spec, or null for one the rack does not have. */
export function rackSpec(patch: Patch, module: string, param: string): ParamSpec | null {
  const m = moduleAt(patch, module)
  return (m && defOf(m.type).params.find((p) => p.id === param)) || null
}

/** How a knob's position becomes its value. */
export function mapOf(spec: Pick<ParamSpec, 'min' | 'max' | 'curve' | 'steps' | 'unit'>): ValueMap {
  if (spec.steps || spec.unit === '#') return { kind: 'step', min: spec.min, max: spec.max }
  return { kind: spec.curve === 'exp' ? 'exp' : 'lin', min: spec.min, max: spec.max }
}

/** The desk's ranges, as the Mix view's knobs have them. */
const DESK_MAPS: Record<string, ValueMap> = {
  gain: { kind: 'fader', min: 0, max: 1 },
  level: { kind: 'fader', min: 0, max: 1 },
  pan: { kind: 'lin', min: -1, max: 1 },
  balance: { kind: 'lin', min: -1, max: 1 },
  space: { kind: 'lin', min: 0, max: 1 },
  delay: { kind: 'lin', min: 0, max: 1 },
  high: { kind: 'lin', min: -24, max: 12 },
  mid: { kind: 'lin', min: -24, max: 12 },
  low: { kind: 'lin', min: -24, max: 12 },
  size: { kind: 'lin', min: 0, max: 1 },
  decay: { kind: 'exp', min: 0.05, max: 20 },
  damping: { kind: 'lin', min: 0, max: 1 },
  time: { kind: 'exp', min: 0.002, max: 2 },
  feedback: { kind: 'lin', min: 0, max: 0.95 },
}
/** A return's level is not a fader: 0..2, straight. */
const RETURN_LEVEL: ValueMap = { kind: 'lin', min: 0, max: 2 }

/**
 * Where a target's automation is sent, and how its positions become values:
 * a knob in a track's engine, or a control on the desk. The desk's are sent
 * to the track `DESK` and keyed by the target itself.
 */
export interface AutomationBinding {
  track: string
  key: string
  map: ValueMap
}

/** The engine's name for the desk, which no track can have: ids are never empty. */
export const DESK = ''

/**
 * Every lane's target in the song, bound to where it goes, given each
 * track's patch. A target that is not there -- a knob on a module since
 * removed, a track since deleted -- is left out, and its lanes play nothing.
 */
export function automationBindings(
  song: Song,
  racks: Readonly<Record<string, { patch: Patch } | undefined>>,
): Map<string, AutomationBinding> {
  const out = new Map<string, AutomationBinding>()
  const tracks = new Set(song.tracks.map((t) => t.id))
  for (const pattern of song.patterns) {
    for (const lane of pattern.automation ?? []) {
      if (out.has(lane.target)) continue
      const b = bindingOf(lane.target, tracks, racks)
      if (b) out.set(lane.target, b)
    }
  }
  return out
}

export function bindingOf(
  target: string,
  tracks: ReadonlySet<string>,
  racks: Readonly<Record<string, { patch: Patch } | undefined>>,
): AutomationBinding | null {
  const t = parseTarget(target)
  if (!t) return null
  if (t.kind === 'rack') {
    const rack = racks[t.track]
    const spec = (tracks.has(t.track) || t.track === MASTER_RACK) && rack ? rackSpec(rack.patch, t.module, t.param) : null
    return spec ? { track: t.track, key: t.key, map: mapOf(spec) } : null
  }
  if (t.kind === 'strip' && !tracks.has(t.track)) return null
  const what = t.what
  const map = t.kind === 'bus' && t.bus !== 'master' && what === 'level' ? RETURN_LEVEL : DESK_MAPS[what]
  return map ? { track: DESK, key: target, map } : null
}

/**
 * What a target is set to by hand -- the knob, the fader -- as the document
 * has it, for telling when a hand has moved one the automation is playing.
 * Undefined for one that is not there.
 */
export function ownValue(
  target: string,
  song: Song,
  racks: Readonly<Record<string, { values: Readonly<Record<string, number>> } | undefined>>,
): number | undefined {
  const t = parseTarget(target)
  if (!t) return undefined
  if (t.kind === 'rack') return racks[t.track]?.values[t.key]
  if (t.kind === 'strip') {
    const track = song.tracks.find((x) => x.id === t.track)
    if (!track) return undefined
    if (t.what === 'gain') return track.gain
    const strip = track.strip
    if (t.what === 'high' || t.what === 'mid' || t.what === 'low') return strip?.eq[t.what] ?? 0
    return strip?.[t.what] ?? 0
  }
  const c = song.console
  if (!c) return undefined
  if (t.bus === 'master') {
    if (t.what === 'high' || t.what === 'mid' || t.what === 'low') return c.master.eq[t.what]
    return (c.master as unknown as Record<string, number>)[t.what]
  }
  return (c[t.bus] as unknown as Record<string, number>)[t.what]
}

/**
 * Every control set by hand that differs between two versions of the
 * document, with its new value: the knobs of every rack, each track's strip
 * and the desk. What a hand on a knob, a fader or a controller's slider looks
 * like from outside -- for taking it from the automation, and for recording
 * it into a lane.
 */
export function movedTargets(
  was: { song: Song; racks: Readonly<Record<string, { values: Readonly<Record<string, number>> } | undefined>> },
  now: { song: Song; racks: Readonly<Record<string, { values: Readonly<Record<string, number>> } | undefined>> },
): { target: string; value: number }[] {
  const out: { target: string; value: number }[] = []
  if (was.racks !== now.racks) {
    for (const [track, rack] of Object.entries(now.racks)) {
      const before = was.racks[track]
      if (!rack || !before || before.values === rack.values) continue
      for (const [key, value] of Object.entries(rack.values)) {
        if (before.values[key] !== value) out.push({ target: rackTarget(track, key), value })
      }
    }
  }
  if (was.song.tracks !== now.song.tracks) {
    for (const track of now.song.tracks) {
      const before = was.song.tracks.find((t) => t.id === track.id)
      if (!before || before === track) continue
      for (const what of STRIP_PARAMS) {
        const target = stripTarget(track.id, what)
        const v = ownValue(target, now.song, now.racks)
        if (v !== undefined && v !== ownValue(target, was.song, was.racks)) out.push({ target, value: v })
      }
    }
  }
  if (was.song.console !== now.song.console) {
    for (const bus of ['master', 'space', 'delay'] as Bus[]) {
      for (const what of BUS_PARAMS[bus]) {
        const target = busTarget(bus, what)
        const v = ownValue(target, now.song, now.racks)
        if (v !== undefined && v !== ownValue(target, was.song, was.racks)) out.push({ target, value: v })
      }
    }
  }
  return out
}

/**
 * A recorded stretch of movement with the points it does not need taken out:
 * any point a straight line from its neighbours already passes within `eps`
 * of (Ramer-Douglas-Peucker, on the value). A slow turn of a knob that sent
 * sixty values a second comes out as the handful of points that draw it.
 */
export function thinPoints(samples: readonly { tick: number; value: number }[], eps = 0.006): { tick: number; value: number }[] {
  if (samples.length <= 2) return [...samples]
  const keep = new Uint8Array(samples.length)
  keep[0] = 1
  keep[samples.length - 1] = 1
  const stack: [number, number][] = [[0, samples.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const pa = samples[a]
    const pb = samples[b]
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const p = samples[i]
      const u = pb.tick === pa.tick ? 0 : (p.tick - pa.tick) / (pb.tick - pa.tick)
      const d = Math.abs(p.value - (pa.value + (pb.value - pa.value) * u))
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst > eps) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return samples.filter((_, i) => keep[i])
}

/**
 * A lane with a recorded stretch written over it: the points it had between
 * the stretch's first and last tick replaced by the stretch, thinned. What
 * was there either side is kept -- recording over two bars of a sweep leaves
 * the rest of it alone.
 */
export function recordOver(points: readonly AutomationPoint[], samples: readonly { tick: number; value: number }[]): AutomationPoint[] {
  if (!samples.length) return [...points]
  const lo = samples[0].tick
  const hi = samples[samples.length - 1].tick
  // Ticks only go forward within a stretch, and two on one tick keep the last.
  const ordered: { tick: number; value: number }[] = []
  for (const s of samples) {
    const last = ordered[ordered.length - 1]
    if (last && s.tick <= last.tick) ordered[ordered.length - 1] = { tick: last.tick, value: s.value }
    else ordered.push({ tick: Math.round(s.tick), value: Math.round(clamp01(s.value) * 10000) / 10000 })
  }
  const kept = points.filter((p) => p.tick < lo || p.tick > hi)
  const out: AutomationPoint[] = [...kept, ...thinPoints(ordered)]
  out.sort((a, b) => a.tick - b.tick)
  return out
}

// --- a lane's curve --------------------------------------------------------

/** A lane's points as they play: in order, inside the pattern, positions in range. */
export function playedPoints(lane: AutomationLane, length: number): AutomationPoint[] {
  const points = lane.points.filter((p) => p.tick >= 0 && p.tick < length && Number.isFinite(p.value))
  // Stable, so two points sharing a tick keep the order they were written in.
  return points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.tick - b.p.tick || a.i - b.i)
    .map(({ p }) => p)
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * A lane as curves across one pass of its pattern, from tick 0 to `length`:
 * the first point's value held up to it, a curve from each point to the
 * next, and the last point's value held to the end. Nothing for a lane with
 * no points.
 */
export function laneCurves(lane: AutomationLane, length: number): Curve[] {
  const points = playedPoints(lane, length)
  if (!points.length) return []
  const out: Curve[] = []
  const first = points[0]
  if (first.tick > 0) out.push({ from: 0, to: first.tick, v0: clamp01(first.value), v1: clamp01(first.value), shape: 'hold', tension: 0 })
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const next = points[i + 1]
    const v0 = clamp01(p.value)
    if (!next) {
      out.push({ from: p.tick, to: length, v0, v1: v0, shape: 'hold', tension: 0 })
      break
    }
    // Two points on one tick: a jump, which is nothing to play.
    if (next.tick === p.tick) continue
    out.push({
      from: p.tick,
      to: next.tick,
      v0,
      v1: clamp01(next.value),
      shape: p.shape ?? 'linear',
      tension: p.shape === 'curve' ? Math.max(-1, Math.min(1, p.tension ?? 0)) : 0,
    })
  }
  return out
}

/** The curve in force at a tick of one pass of the pattern. */
function curveIn(curves: readonly Curve[], tick: number): Curve | null {
  let found: Curve | null = null
  for (const c of curves) {
    if (c.from <= tick) found = c
    else break
  }
  return found
}

/** Where a lane has its knob at a tick of its pattern, 0..1, or null for a lane with no points. */
export function laneValueAt(lane: AutomationLane, length: number, tick: number): number | null {
  const c = curveIn(laneCurves(lane, length), tick)
  return c ? curveAt(c, tick) : null
}

// --- across the song ---------------------------------------------------------

/** A stretch of the song in which one clip's lane has a target. */
interface Piece {
  from: number
  to: number
  place: Placement
  pattern: Pattern
  curves: Curve[]
}

/**
 * Each target's pieces, across the whole song: every clip of a pattern with
 * a lane for it, and where clips overlap, the later-starting one -- the one
 * further down the playlist, between two starting together.
 */
const piecesCache = new WeakMap<Song, Map<string, Piece[]>>()
export function automationPieces(song: Song): Map<string, Piece[]> {
  let cached = piecesCache.get(song)
  if (cached) return cached
  cached = new Map()
  const patterns = new Map(song.patterns.map((p) => [p.id, p]))
  const spans = new Map<string, { from: number; to: number; order: number; place: Placement; pattern: Pattern; curves: Curve[] }[]>()
  song.playlist.forEach((place, order) => {
    const pattern = patterns.get(place.pattern)
    if (!pattern?.automation?.length || !(pattern.length > 0) || place.mute) return
    const to = clipEnd(place, pattern)
    if (!(to > place.tick)) return
    for (const lane of pattern.automation) {
      const curves = laneCurves(lane, pattern.length)
      if (!curves.length) continue
      const list = spans.get(lane.target) ?? []
      list.push({ from: place.tick, to, order, place, pattern, curves })
      spans.set(lane.target, list)
    }
  })
  for (const [target, list] of spans) {
    const edges = [...new Set(list.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b)
    const pieces: Piece[] = []
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i]
      const b = edges[i + 1]
      let win: (typeof list)[number] | null = null
      for (const s of list) {
        if (s.from > a || s.to <= a) continue
        if (!win || s.from > win.from || (s.from === win.from && s.order > win.order)) win = s
      }
      if (!win) continue
      const last = pieces[pieces.length - 1]
      if (last && last.place === win.place && last.to === a) last.to = b
      else pieces.push({ from: a, to: b, place: win.place, pattern: win.pattern, curves: win.curves })
    }
    cached.set(target, pieces)
  }
  piecesCache.set(song, cached)
  return cached
}

/** Where a pass of a clip's pattern begins, for the pass playing at `tick`. */
function passStart(place: Placement, pattern: Pattern, tick: number): number {
  const origin = place.tick - clipOffset(place, pattern)
  return origin + Math.floor((tick - origin) / pattern.length) * pattern.length
}

/** The curve a piece has in force at a song tick, in song ticks. */
function pieceCurve(piece: Piece, tick: number): Curve | null {
  const base = passStart(piece.place, piece.pattern, tick)
  const c = curveIn(piece.curves, tick - base)
  return c ? { ...c, from: c.from + base, to: c.to + base } : null
}

const pieceAt = (pieces: readonly Piece[], tick: number) => pieces.find((p) => p.from <= tick && tick < p.to) ?? null

/** Where a target stands at a song tick, 0..1, or null where nothing automates it. */
export function automationValueAt(song: Song, target: string, tick: number): number | null {
  const pieces = automationPieces(song).get(target)
  const piece = pieces && pieceAt(pieces, tick)
  const c = piece && pieceCurve(piece, tick)
  return c ? curveAt(c, tick) : null
}

/** Whether any clip in the song automates a target. */
export function isAutomated(song: Song, target: string): boolean {
  return automationPieces(song).has(target)
}

/**
 * A change in what a target is following: from `tick` on, the curve given
 * (in song ticks), or with none, back to the knob's own value.
 */
export interface AutomationChange {
  tick: number
  target: string
  curve: Curve | null
}

/**
 * Every change in `[from, to)`, in order of tick.
 *
 * With `snapshot`, what every automated target is doing at `from` comes
 * first, whether or not anything changes there: for the start of playback,
 * the far side of a loop's seam, or anywhere the caller has dropped what it
 * queued before. A target nothing automates at `from` is sent back to its
 * knob then, which is what makes a jump out of a clip let go of it.
 *
 * A curve already under way at a window's start is not sent again: the
 * engine has it. Only where one curve hands over to another, or to the knob,
 * is there anything to say.
 */
export function automationChanges(song: Song, from: number, to: number, snapshot = false): AutomationChange[] {
  const out: AutomationChange[] = []
  if (!(to > from)) return out
  for (const [target, pieces] of automationPieces(song)) {
    if (snapshot) {
      const piece = pieceAt(pieces, from)
      out.push({ tick: from, target, curve: piece ? pieceCurve(piece, from) : null })
    }
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      // Its end, unless another piece takes over right there. An end on the
      // window's first tick is this window's: the last one stopped short of it.
      const next = pieces[i + 1]
      if (piece.to >= from && piece.to < to && !(next && next.from === piece.to) && !(snapshot && piece.to === from)) {
        out.push({ tick: piece.to, target, curve: null })
      }
      if (piece.to <= from || piece.from >= to) continue
      // Where it begins, and where each curve inside it begins.
      const ticks: number[] = []
      if (piece.from >= from && !(snapshot && piece.from === from)) ticks.push(piece.from)
      const len = piece.pattern.length
      const lo = Math.max(from, piece.from)
      const hi = Math.min(to, piece.to)
      for (let base = passStart(piece.place, piece.pattern, lo); base < hi; base += len) {
        for (const c of piece.curves) {
          const at = base + c.from
          if (at > lo || (at === lo && lo > piece.from && !(snapshot && at === from))) {
            if (at < hi) ticks.push(at)
          }
        }
      }
      for (const t of [...new Set(ticks)].sort((a, b) => a - b)) {
        out.push({ tick: t, target, curve: pieceCurve(piece, t) })
      }
    }
  }
  out.sort((a, b) => a.tick - b.tick)
  return out
}

/** Every target any lane names, for knowing what to let go of at a seam. */
export function automatedTargets(song: Song): string[] {
  return [...automationPieces(song).keys()]
}

// --- editing -----------------------------------------------------------------

/** A pattern's lane for a target, if it has one. */
export function laneOf(pattern: Pattern, target: string): AutomationLane | undefined {
  return pattern.automation?.find((l) => l.target === target)
}

/**
 * A pattern with a lane replaced, added or -- given null -- removed. The same
 * song back when nothing changed, so a drag held still adds nothing to undo.
 */
export function setLane(song: Song, patternId: string, target: string, lane: AutomationLane | null): Song {
  const pattern = song.patterns.find((p) => p.id === patternId)
  if (!pattern) return song
  const lanes = pattern.automation ?? []
  const at = lanes.findIndex((l) => l.target === target)
  if (lane === null && at < 0) return song
  if (lane && at >= 0 && samePoints(lanes[at].points, lane.points)) return song
  const next = lane === null ? lanes.filter((_, i) => i !== at) : at < 0 ? [...lanes, lane] : lanes.map((l, i) => (i === at ? lane : l))
  const changed: Pattern = { ...pattern }
  if (next.length) changed.automation = next
  else delete changed.automation
  return { ...song, patterns: song.patterns.map((p) => (p.id === patternId ? changed : p)) }
}

function samePoints(a: readonly AutomationPoint[], b: readonly AutomationPoint[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const q = b[i]
    return p.tick === q.tick && p.value === q.value && p.shape === q.shape && (p.tension ?? 0) === (q.tension ?? 0)
  })
}

/** A point as it may be kept: whole tick, position in range, and only the fields its shape uses. */
export function cleanPoint(raw: unknown, length = Number.MAX_SAFE_INTEGER): AutomationPoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.tick !== 'number' || typeof p.value !== 'number' || !Number.isFinite(p.tick) || !Number.isFinite(p.value)) return null
  const point: AutomationPoint = {
    tick: Math.max(0, Math.min(length, Math.round(p.tick))),
    value: Math.round(clamp01(p.value) * 10000) / 10000,
  }
  if (p.shape === 'hold') point.shape = 'hold'
  else if (p.shape === 'curve') {
    point.shape = 'curve'
    const t = typeof p.tension === 'number' && Number.isFinite(p.tension) ? Math.max(-1, Math.min(1, p.tension)) : 0
    point.tension = Math.round(t * 1000) / 1000
  }
  return point
}

/** Lanes as they may be kept, for tracks that exist: from a file, or after an edit. */
export function cleanLanes(raw: unknown, tracks: ReadonlySet<string>): AutomationLane[] {
  if (!Array.isArray(raw)) return []
  const out: AutomationLane[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const l = item as Record<string, unknown>
    if (typeof l.target !== 'string' || !parseTarget(l.target) || out.some((x) => x.target === l.target)) continue
    const track = targetTrack(l.target)
    // The master rack's knobs are lanes too, though it is no track.
    if (track !== null && !tracks.has(track) && track !== MASTER_RACK) continue
    const points = (Array.isArray(l.points) ? l.points : []).map((p) => cleanPoint(p)).filter((p): p is AutomationPoint => !!p)
    points.sort((a, b) => a.tick - b.tick)
    out.push({ target: l.target, points })
  }
  return out
}
