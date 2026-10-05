import { mapValue } from '../dsp/automation'
import { defOf } from '../patch/defs'
import { formatValue, type ParamSpec } from '../patch/param'
import type { Patch } from '../patch/types'
import { BUS_PARAMS, busTarget, moduleAt, parseTarget, rackSpec, rackTarget, STRIP_PARAMS, stripTarget, type Bus } from '../song/automation'
import type { Song } from '../song/types'
import { BALANCE, EQ, PAN, RETURNS, SEND_DELAY, SEND_SPACE } from './mixSpecs'

/**
 * What an automation lane's target is called, and how its values read, for
 * the roll's lane picker and the lane's own gutter. The song layer only
 * knows a target as a path; these are the words a person reads.
 */

type Racks = Readonly<Record<string, { patch: Patch } | undefined>>

const STRIP_NAMES: Record<string, string> = {
  gain: 'Level', pan: 'Pan', space: 'Space send', delay: 'Delay send', high: 'High', mid: 'Mid', low: 'Low',
}
const BUS_NAMES: Record<Bus, string> = { master: 'Master', space: 'Space', delay: 'Delay' }
const FIELD_NAMES: Record<string, string> = {
  level: 'Level', balance: 'Balance', high: 'High', mid: 'Mid', low: 'Low', size: 'Size', decay: 'Decay',
  damping: 'Damping', time: 'Time', feedback: 'Feedback',
}

export function targetLabel(target: string, song: Song, racks: Racks): string {
  const t = parseTarget(target)
  if (!t) return target
  if (t.kind === 'bus') return `${BUS_NAMES[t.bus]} ${(t.bus !== 'master' && t.what === 'level' ? 'return' : FIELD_NAMES[t.what] ?? t.what).toLowerCase()}`
  const track = song.tracks.find((x) => x.id === t.track)
  const name = track?.name || t.track
  if (t.kind === 'strip') return `${name} ${STRIP_NAMES[t.what].toLowerCase()}`
  const rack = racks[t.track]
  const m = rack && moduleAt(rack.patch, t.module)
  const spec = rack && rackSpec(rack.patch, t.module, t.param)
  if (!m || !spec) return `${t.key} (not in ${name})`
  const inner = t.module.split('/').pop()
  return `${defOf(m.type).name} ${spec.label} (${inner})`
}

const fader = (v: number) => (v <= 0 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1).replace('-', '−')} dB`)

/** A position 0..1 as the target would show it: "1.40 kHz", "−6.0 dB". */
export function targetFormat(target: string, racks: Racks): (t: number) => string {
  const p = parseTarget(target)
  const spec = (s: ParamSpec | null | undefined) => (s ? (t: number) => formatValue(s, mapValue(s.curve === 'exp' && !s.steps ? { kind: 'exp', min: s.min, max: s.max } : { kind: s.steps ? 'step' : 'lin', min: s.min, max: s.max }, t)) : null)
  if (!p) return (t) => `${Math.round(t * 100)}%`
  if (p.kind === 'rack') {
    const rack = racks[p.track]
    return spec(rack && rackSpec(rack.patch, p.module, p.param)) ?? ((t) => `${Math.round(t * 100)}%`)
  }
  const what = p.what
  if (what === 'gain' || (p.kind === 'bus' && p.bus === 'master' && what === 'level')) return (t) => fader(mapValue({ kind: 'fader', min: 0, max: 1 }, t))
  const desk: Record<string, ParamSpec> = {
    pan: PAN, balance: BALANCE, space: SEND_SPACE, delay: SEND_DELAY, high: EQ.high, mid: EQ.mid, low: EQ.low,
    size: RETURNS.size, decay: RETURNS.decay, damping: RETURNS.spaceDamp, time: RETURNS.time, feedback: RETURNS.feedback,
  }
  const s = p.kind === 'bus' && what === 'level' ? RETURNS.spaceLevel : desk[what]
  return spec(s) ?? ((t) => `${Math.round(t * 100)}%`)
}

export interface LaneOption {
  target: string
  label: string
}

/**
 * Everything a lane in the roll could be added for, on the track being
 * written: each knob in its rack, module by module, then its channel strip,
 * then the master and the two returns.
 */
export function laneOptions(trackId: string, song: Song, racks: Racks): { group: string; options: LaneOption[] }[] {
  const out: { group: string; options: LaneOption[] }[] = []
  const rack = racks[trackId]
  const track = song.tracks.find((t) => t.id === trackId)
  if (rack) {
    for (const m of rack.patch.modules) {
      const def = defOf(m.type)
      if (!def.params.length) continue
      out.push({
        group: `${def.name} (${m.id})`,
        options: def.params.map((s) => ({ target: rackTarget(trackId, `${m.id}.${s.id}`), label: s.label })),
      })
    }
  }
  if (track) {
    out.push({
      group: `${track.name || 'Track'} strip`,
      options: STRIP_PARAMS.map((w) => ({ target: stripTarget(trackId, w), label: STRIP_NAMES[w] })),
    })
  }
  for (const bus of ['master', 'space', 'delay'] as Bus[]) {
    out.push({
      group: BUS_NAMES[bus],
      options: BUS_PARAMS[bus].map((w) => ({ target: busTarget(bus, w), label: bus !== 'master' && w === 'level' ? 'Return' : FIELD_NAMES[w] ?? w })),
    })
  }
  return out
}
