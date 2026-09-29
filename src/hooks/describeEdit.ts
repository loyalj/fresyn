import { defOf } from '../patch/defs'
import type { Patch } from '../patch/types'
import type { Rack } from '../song/project'
import type { Note, Placement, Song, Track } from '../song/types'
import type { Doc } from './useDocument'

/**
 * What an edit did, in a few words, for the History list.
 *
 * Worked out by comparing the document before and after rather than handed
 * in by each of the hundred places that edit it: every edit already goes
 * through one commit, and a name that has to be remembered at every call
 * site is a name that ends up saying "Edit" at most of them. The few edits
 * that know better -- a new project, a loaded template -- say so themselves.
 *
 * Pure, and cheap on the common path: the document is persistent, so a knob
 * turn is found by reference in a couple of comparisons whatever the size of
 * the song.
 */
export function describeEdit(prev: Doc, next: Doc): string {
  if (prev.song !== next.song) {
    const s = describeSong(prev.song, next.song)
    // A song edit that took racks with it -- a track added or removed -- is
    // named for the track, which is what it was.
    if (s) return s
  }
  if (prev.racks !== next.racks) {
    const r = describeRacks(prev, next)
    if (r) return r
  }
  if (prev.name !== next.name) return 'Rename project'
  return 'Edit'
}

function describeRacks(prev: Doc, next: Doc): string | null {
  const changed = Object.keys(next.racks).filter((id) => prev.racks[id] !== next.racks[id])
  if (changed.length === 0) return null
  if (changed.length > 1) return 'Edit racks'
  const id = changed[0]
  const what = describeRack(prev.racks[id], next.racks[id])
  // Named for the track when there is more than one to tell apart.
  const track = next.song.tracks.length > 1 ? next.song.tracks.find((t) => t.id === id)?.name : ''
  return track ? `${what} · ${track}` : what
}

function describeRack(a: Rack | undefined, b: Rack): string {
  if (!a) return 'New rack'
  if (a.patch !== b.patch) return describePatch(a.patch, b.patch)
  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)])
  const moved = [...keys].filter((k) => a.values[k] !== b.values[k])
  if (moved.length === 0) return 'Edit rack'
  const modules = new Set(moved.map((k) => k.slice(0, k.indexOf('.'))))
  if (modules.size > 1) return `Set ${moved.length} knobs`
  const [moduleId] = modules
  const type = b.patch.modules.find((m) => m.id === moduleId)?.type
  if (moved.length > 1) return `Set ${moduleId} knobs`
  const paramId = moved[0].slice(moduleId.length + 1)
  const label = type ? safeDef(type)?.params.find((p) => p.id === paramId)?.label : undefined
  return `${label ?? paramId} · ${moduleId}`
}

function describePatch(a: Patch, b: Patch): string {
  const before = new Map(a.modules.map((m) => [m.id, m]))
  const after = new Map(b.modules.map((m) => [m.id, m]))
  const added = b.modules.filter((m) => !before.has(m.id))
  const removed = a.modules.filter((m) => !after.has(m.id))

  if (added.length && removed.length) return 'Replace rack'
  if (added.length === 1) return `Add ${nameOf(added[0].type)}`
  if (added.length > 1) return `Add ${added.length} modules`
  if (removed.length === 1) return `Remove ${nameOf(removed[0].type)}`
  if (removed.length > 1) return `Remove ${removed.length} modules`

  if (a.cables !== b.cables) {
    const was = new Set(a.cables.map((c) => c.id))
    const is = new Set(b.cables.map((c) => c.id))
    const plugged = b.cables.filter((c) => !was.has(c.id)).length
    const pulled = a.cables.filter((c) => !is.has(c.id)).length
    if (plugged && pulled) return 'Repatch cable'
    if (plugged) return plugged > 1 ? `Connect ${plugged} cables` : 'Connect cable'
    if (pulled) return pulled > 1 ? `Unplug ${pulled} cables` : 'Unplug cable'
    return 'Colour cable'
  }

  for (const m of b.modules) {
    const was = before.get(m.id)
    if (!was || was === m) continue
    if (!!was.bypass !== !!m.bypass) return `${m.bypass ? 'Bypass' : 'Un-bypass'} ${m.id}`
    if (was.key !== m.key) return `Set key · ${m.id}`
    if (was.sample?.id !== m.sample?.id) return `Load sample · ${m.id}`
  }
  if (a.modules.map((m) => m.id).join() !== b.modules.map((m) => m.id).join()) return 'Reorder rack'
  return 'Edit rack'
}

function describeSong(a: Song, b: Song): string | null {
  if (a.tracks !== b.tracks) {
    const t = describeTracks(a.tracks, b.tracks)
    if (t) return t
  }
  if (a.patterns !== b.patterns) {
    const p = describePatterns(a, b)
    if (p) return p
  }
  // Before the playlist: moving a section carries its clips, and the edit
  // is the section's.
  if (a.sections !== b.sections) {
    const n = (s: Song) => s.sections?.length ?? 0
    if (n(b) > n(a)) return a.playlist !== b.playlist ? 'Duplicate section' : 'Add section'
    if (n(b) < n(a)) return a.playlist !== b.playlist ? 'Delete section' : 'Remove section'
    return a.playlist !== b.playlist ? 'Move section' : 'Edit sections'
  }
  if (a.playlist !== b.playlist) return describePlaylist(a.playlist, b.playlist)
  if (a.tempo !== b.tempo) return `Tempo ${Math.round(b.tempo * 100) / 100}`
  if (a.meter !== b.meter) return `Meter ${b.meter?.beats ?? 4}/${b.meter?.unit ?? 4}`
  if (a.loop !== b.loop) return b.loop ? 'Set loop' : 'Clear loop'
  if (a.console !== b.console) return 'Mix'
  if (a.folders !== b.folders) {
    const n = (s: Song) => s.folders?.length ?? 0
    if (n(b) > n(a)) return 'Add folder'
    if (n(b) < n(a)) return 'Remove folder'
    return 'Edit folder'
  }
  if (a.scale !== b.scale) return b.scale ? 'Set key' : 'Clear key'
  return null
}

function describeTracks(a: Track[], b: Track[]): string | null {
  const was = new Map(a.map((t) => [t.id, t]))
  const is = new Set(b.map((t) => t.id))
  const added = b.filter((t) => !was.has(t.id))
  const removed = a.filter((t) => !is.has(t.id))
  if (added.length === 1 && removed.length === 0) return `Add track ${added[0].name}`.trim()
  if (removed.length === 1 && added.length === 0) return `Remove track ${removed[0].name}`.trim()
  if (added.length || removed.length) return 'Replace tracks'

  for (const t of b) {
    const o = was.get(t.id)
    if (!o || o === t) continue
    const name = t.name || 'track'
    if (o.name !== t.name) return 'Rename track'
    if (o.gain !== t.gain) return `Level · ${name}`
    if (!!o.mute !== !!t.mute) return `${t.mute ? 'Mute' : 'Unmute'} ${name}`
    if (!!o.solo !== !!t.solo) return `${t.solo ? 'Solo' : 'Unsolo'} ${name}`
    if (o.strip !== t.strip) return `Channel · ${name}`
    if (o.color !== t.color) return `Colour · ${name}`
    if (o.folder !== t.folder) return t.folder ? `File ${name}` : `Unfile ${name}`
    if (!!o.hidden !== !!t.hidden) return `${t.hidden ? 'Hide' : 'Show'} ${name}`
    if (!!o.pinned !== !!t.pinned) return `${t.pinned ? 'Pin' : 'Unpin'} ${name}`
    return `Edit ${name}`
  }
  if (a.map((t) => t.id).join() !== b.map((t) => t.id).join()) return 'Reorder tracks'
  return null
}

function describePatterns(a: Song, b: Song): string | null {
  const was = new Map(a.patterns.map((p) => [p.id, p]))
  const is = new Set(b.patterns.map((p) => p.id))
  const added = b.patterns.filter((p) => !was.has(p.id))
  const removed = a.patterns.filter((p) => !is.has(p.id))
  if (added.length === 1 && !removed.length) return `Add pattern ${added[0].name}`.trim()
  if (removed.length === 1 && !added.length) return `Remove pattern ${removed[0].name}`.trim()
  if (added.length || removed.length) return 'Replace patterns'

  const edited = b.patterns.filter((p) => was.get(p.id) !== p)
  if (edited.length > 1) return 'Edit patterns'
  const p = edited[0]
  if (!p) return a.patterns.length === b.patterns.length ? 'Reorder patterns' : null
  const o = was.get(p.id)!
  if (o.notes !== p.notes) return describeNotes(o.notes, p.notes)
  if (o.name !== p.name) return 'Rename pattern'
  if (o.length !== p.length) return `Length · ${p.name}`
  if (o.swing !== p.swing) return `Swing · ${p.name}`
  if (o.color !== p.color) return `Colour · ${p.name}`
  return `Edit ${p.name}`
}

function describeNotes(a: Note[], b: Note[]): string {
  const d = b.length - a.length
  if (d === 1) return 'Add note'
  if (d > 1) return `Add ${d} notes`
  if (d === -1) return 'Delete note'
  if (d < -1) return `Delete ${-d} notes`
  // The same number of notes: which way they changed, where every changed
  // note changed the same way. A drag moves; a grip lengthens; the lane sets
  // velocity. Anything mixed is an edit.
  const kinds = new Set<string>()
  for (let i = 0; i < b.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.tick !== y.tick || x.pitch !== y.pitch || x.track !== y.track) kinds.add('Move')
    if (x.length !== y.length) kinds.add('Resize')
    if (x.velocity !== y.velocity) kinds.add('Velocity')
  }
  const n = b.filter((y, i) => a[i] !== y).length
  const noun = n === 1 ? 'note' : `${n} notes`
  if (kinds.size === 1) {
    const [k] = kinds
    return k === 'Velocity' ? `Velocity · ${noun}` : `${k} ${noun}`
  }
  return n ? `Edit ${noun}` : 'Edit notes'
}

function describePlaylist(a: Placement[], b: Placement[]): string {
  const d = b.length - a.length
  if (d === 1 && a.filter((x, i) => b[i] !== x).length === 1) return 'Split clip'
  if (d === 1) return 'Add clip'
  if (d > 1) return `Add ${d} clips`
  if (d === -1) return 'Delete clip'
  if (d < -1) return `Delete ${-d} clips`
  const n = b.filter((y, i) => a[i] !== y).length
  const moved = b.every(
    (y, i) => a[i] === y || ((a[i].offset ?? 0) === (y.offset ?? 0) && a[i].length === y.length),
  )
  const noun = n === 1 ? 'clip' : `${n} clips`
  return moved ? `Move ${noun}` : `Trim ${noun}`
}

function safeDef(type: string) {
  try {
    return defOf(type)
  } catch {
    return undefined
  }
}

const nameOf = (type: string) => safeDef(type)?.name ?? type
