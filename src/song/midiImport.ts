import { unmapValue } from '../dsp/automation'
import type { Patch } from '../patch/types'
import { stripTarget } from './automation'
import { kitRow, noteTarget } from './bind'
import { nextPatternId, nextTrackId } from './edit'
import { gmName, GM_DEFAULT_PROGRAM } from './gm'
import type { MidiFile } from './midiFile'
import { normalizeSong } from './normalize'
import type { Rack } from './project'
import { barsOf } from './timeline'
import { rowForMidi, tuningOf } from './tuning'
import {
  minPatternLength,
  MIN_VELOCITY,
  PPQ,
  TEMPO_MAX,
  TEMPO_MIN,
  validMeter,
  type AutomationPoint,
  type Meter,
  type MeterChange,
  type Note,
  type Section,
  type Song,
  type TempoChange,
} from './types'

/**
 * A MIDI file brought into a song.
 *
 * In two steps. `readImport` turns what the file says into parts -- each
 * MIDI track's notes on each channel it uses, with the program it asked for
 * and its volume and pan -- in the song's own ticks. `songFromImport` makes
 * those into the song: a track and a rack for each part, a pattern for each
 * placed on its own lane of the playlist, volume and pan as automation of
 * the track's strip, and the file's tempo, meter and markers as the song's.
 * Which sound a part gets is the caller's: see `gm.ts`.
 */

export interface ImportedPart {
  /** The MIDI track's name, or none. */
  name: string
  /** The program it asked for, or null for none. */
  program: number | null
  /** On channel 10, which General MIDI keeps for drums. */
  drums: boolean
  channel: number
  /** As MIDI notes: number 60 is middle C. */
  notes: { tick: number; length: number; note: number; velocity: number }[]
  /** Volume (CC7, times CC11 expression) as a linear level, and pan (CC10) -1..1, where the file sets them. */
  gain: { tick: number; value: number }[]
  pan: { tick: number; value: number }[]
}

export interface ImportedMidi {
  tempo: number
  tempos: TempoChange[]
  meter: Meter
  meters: MeterChange[]
  markers: { tick: number; name: string }[]
  parts: ImportedPart[]
  /** One tick past the last thing in the file. */
  end: number
}

const clampTempo = (bpm: number) => Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, bpm)) * 100) / 100

/** A level from a MIDI volume and expression, 0..127 each: General MIDI's curve, a square of each. */
export const midiGain = (volume: number, expression = 127) => (volume / 127) ** 2 * (expression / 127) ** 2

export function readImport(file: MidiFile): ImportedMidi {
  const scale = PPQ / file.division
  const at = (t: number) => Math.round(t * scale)
  let end = 0

  // The song's clock and meter, from whichever track holds them -- in a type
  // 1 file, the first.
  const tempoAt = new Map<number, number>()
  const meterAt = new Map<number, Meter>()
  const markers: { tick: number; name: string }[] = []
  for (const track of file.tracks) {
    for (const e of track.events) {
      if (e.kind === 'tempo') tempoAt.set(at(e.tick), clampTempo(e.bpm))
      else if (e.kind === 'meter') {
        const m = validMeter(e.beats, e.unit)
        if (m) meterAt.set(at(e.tick), m)
      } else if (e.kind === 'marker' && e.text.trim()) markers.push({ tick: at(e.tick), name: e.text.trim() })
    }
  }
  const tempoTicks = [...tempoAt.keys()].sort((a, b) => a - b)
  const tempo = tempoTicks.length && tempoTicks[0] === 0 ? tempoAt.get(0)! : 120
  const tempos: TempoChange[] = []
  let last = tempo
  for (const t of tempoTicks) {
    if (t === 0) continue
    const bpm = tempoAt.get(t)!
    if (bpm !== last) tempos.push({ tick: t, bpm })
    last = bpm
  }
  const meterTicks = [...meterAt.keys()].sort((a, b) => a - b)
  const meter = meterTicks.length && meterTicks[0] === 0 ? meterAt.get(0)! : { beats: 4, unit: 4 as const }
  const meters: MeterChange[] = []
  let was = meter
  for (const t of meterTicks) {
    if (t === 0) continue
    const m = meterAt.get(t)!
    if (m.beats !== was.beats || m.unit !== was.unit) meters.push({ tick: t, meter: m })
    was = m
  }
  markers.sort((a, b) => a.tick - b.tick)

  // A part for each channel each track uses.
  const parts: ImportedPart[] = []
  file.tracks.forEach((track) => {
    const name = track.events.find((e) => e.kind === 'name')?.kind === 'name'
      ? (track.events.find((e) => e.kind === 'name') as { text: string }).text.trim()
      : ''
    const byChannel = new Map<number, ImportedPart & { open: Map<number, { tick: number; velocity: number }[]>; volume: number; expression: number }>()
    const part = (channel: number) => {
      let p = byChannel.get(channel)
      if (!p) {
        p = { name, program: null, drums: channel === 10, channel, notes: [], gain: [], pan: [], open: new Map(), volume: 100, expression: 127 }
        byChannel.set(channel, p)
      }
      return p
    }
    for (const e of track.events) {
      if (e.kind !== 'note' && e.kind !== 'cc' && e.kind !== 'program') continue
      const p = part(e.channel)
      const tick = at(e.tick)
      if (e.kind === 'program') {
        if (p.program === null) p.program = e.program
      } else if (e.kind === 'cc') {
        if (e.number === 7 || e.number === 11) {
          if (e.number === 7) p.volume = e.value
          else p.expression = e.value
          p.gain.push({ tick, value: midiGain(p.volume, p.expression) })
        } else if (e.number === 10) {
          p.pan.push({ tick, value: Math.max(-1, Math.min(1, (e.value - 64) / 63)) })
        }
        end = Math.max(end, tick + 1)
      } else if (e.on) {
        const stack = p.open.get(e.note) ?? []
        stack.push({ tick, velocity: e.velocity })
        p.open.set(e.note, stack)
      } else {
        // The earliest still held: a note pressed twice is let go in order.
        const held = p.open.get(e.note)?.shift()
        if (!held) continue
        p.notes.push({ tick: held.tick, length: Math.max(1, tick - held.tick), note: e.note, velocity: held.velocity / 127 })
        end = Math.max(end, tick)
      }
    }
    for (const p of byChannel.values()) {
      // Never let go of: held to the last thing the file does.
      for (const [note, stack] of p.open) {
        for (const h of stack) p.notes.push({ tick: h.tick, length: Math.max(1, Math.max(end, h.tick + PPQ) - h.tick), note, velocity: h.velocity / 127 })
      }
      if (!p.notes.length) continue
      p.notes.sort((a, b) => a.tick - b.tick || a.note - b.note)
      end = Math.max(end, ...p.notes.map((n) => n.tick + n.length))
      if (byChannel.size > 1 && p.name) p.name = `${p.name} (ch ${p.channel})`
      const { open: _o, volume: _v, expression: _e, ...out } = p
      parts.push(out)
    }
  })
  for (const m of markers) end = Math.max(end, m.tick + 1)
  return { tempo, tempos, meter, meters, markers, parts, end }
}

/** What to call a part's track: its own name, or its program's. */
export function partName(part: ImportedPart): string {
  if (part.name) return part.name
  if (part.drums) return 'Drums'
  return gmName(part.program ?? GM_DEFAULT_PROGRAM)
}

export type ImportMode = { kind: 'new' } | { kind: 'add'; song: Song; at: number }

/**
 * The song a MIDI file makes: a new one, or the one given with the file's
 * tracks added at `at`. Added, the song keeps its own tempo, meter and
 * sections, and the notes keep their places in the beat.
 *
 * `rackFor` gives each part its sound. Every part is a track of its own and
 * a pattern of its own, on its own lane, so each can be moved, muted and
 * edited by itself.
 */
export function songFromImport(
  imp: ImportedMidi,
  rackFor: (part: ImportedPart) => Rack,
  mode: ImportMode,
): { song: Song; racks: Record<string, Rack>; tracks: string[] } {
  let song: Song =
    mode.kind === 'add'
      ? mode.song
      : {
          tempo: imp.tempo,
          ...(imp.tempos.length ? { tempos: imp.tempos } : {}),
          ...(imp.meter.beats !== 4 || imp.meter.unit !== 4 ? { meter: imp.meter } : {}),
          ...(imp.meters.length ? { meters: imp.meters } : {}),
          tracks: [],
          patterns: [],
          playlist: [],
        }
  const at = mode.kind === 'add' ? Math.max(0, Math.round(mode.at)) : 0
  const firstLane = mode.kind === 'add' ? song.playlist.reduce((n, p) => Math.max(n, (p.lane ?? 0) + 1), 0) : 0
  const bars = barsOf(song)
  const length = Math.max(minPatternLength(song), bars.snapBar(at + Math.max(1, imp.end), 'ceil') - at)

  const racks: Record<string, Rack> = {}
  const added: string[] = []
  imp.parts.forEach((part, i) => {
    const id = mode.kind === 'new' && i === 0 ? 'track1' : nextTrackId(song)
    const rack = rackFor(part)
    racks[id] = rack
    added.push(id)
    const name = partName(part)
    const target = noteTarget(rack.patch as Patch)
    const tuning = target?.kind === 'note' ? tuningOf(rack) : null
    const notes: Note[] = part.notes.map((n) => ({
      track: id,
      tick: n.tick,
      length: n.length,
      pitch: target?.kind === 'kit' ? kitRow(n.note) : target?.kind === 'note' ? rowForMidi(n.note, tuning) : 0,
      velocity: Math.max(MIN_VELOCITY, Math.min(1, n.velocity)),
    }))
    const lanes = [
      lane(stripTarget(id, 'gain'), part.gain, (v) => unmapValue({ kind: 'fader', min: 0, max: 1 }, v), length),
      lane(stripTarget(id, 'pan'), part.pan, (v) => (v + 1) / 2, length),
    ].filter((l) => l !== null)
    const patternId = nextPatternId(song)
    // Where the file starts each part's volume and pan is where its fader
    // and pan start; anything after is the lanes'.
    const gain = part.gain[0]?.tick === 0 ? Math.min(1, part.gain[0].value) : 1
    const pan = part.pan[0]?.tick === 0 ? part.pan[0].value : 0
    song = {
      ...song,
      tracks: [
        ...song.tracks,
        { id, name, patch: id, gain, ...(pan !== 0 ? { strip: { pan, eq: { low: 0, mid: 0, high: 0 }, space: 0, delay: 0 } } : {}) },
      ],
      patterns: [
        ...song.patterns,
        { id: patternId, name, length, notes: notes.filter((n) => n.tick < length), ...(lanes.length ? { automation: lanes } : {}) },
      ],
      playlist: [...song.playlist, { pattern: patternId, tick: at, lane: firstLane + i }],
    }
  })

  // The file's markers, as sections from each to the next.
  if (mode.kind === 'new' && imp.markers.length) {
    const sections: Section[] = []
    const stop = Math.max(length, imp.markers[imp.markers.length - 1].tick + 1)
    imp.markers.forEach((m, i) => {
      const next = imp.markers[i + 1]?.tick ?? stop
      if (next > m.tick && !sections.some((s) => s.tick === m.tick)) sections.push({ tick: m.tick, length: next - m.tick, name: m.name })
    })
    if (sections.length) song = { ...song, sections }
  }
  return { song: normalizeSong(song), racks, tracks: added }
}

/** A strip's automation from a part's changes, as steps: a MIDI controller holds until it is told otherwise. */
function lane(
  target: string,
  changes: readonly { tick: number; value: number }[],
  position: (v: number) => number,
  length: number,
): { target: string; points: AutomationPoint[] } | null {
  const points: AutomationPoint[] = []
  for (const c of changes) {
    if (c.tick >= length) break
    const value = Math.round(position(c.value) * 10000) / 10000
    const prev = points[points.length - 1]
    if (prev && prev.tick === c.tick) prev.value = value
    else if (!prev || prev.value !== value) points.push({ tick: c.tick, value, shape: 'hold' })
  }
  // A level set once and never changed is a level, not a movement: the
  // fader is where it is, and a lane would only pin it there.
  if (points.length <= 1) return null
  return { target, points: points.length > 4000 ? points.filter((_, i) => i % Math.ceil(points.length / 4000) === 0) : points }
}
