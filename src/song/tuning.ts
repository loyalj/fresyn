import { defOf } from '../patch/defs'
import { semitonesFrom440 } from '../patch/param'
import type { ParamSpec } from '../patch/param'
import type { PatchModule } from '../patch/types'
import { noteTarget } from './bind'
import type { Rack } from './project'
import type { Scale } from './scale'
import { PITCH_RANGE } from './types'

/** MIDI 69 is A4, which is what puts C4 on 60. */
const A4_MIDI = 69
/**
 * The row names a track gets when there is nothing to read them from: its
 * Keyboard's bottom key reads C0, which is MIDI 12.
 */
export const UNTUNED_ROW_ZERO = 12

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const mod12 = (n: number) => ((n % 12) + 12) % 12

/**
 * What a track's Keyboard actually plays, so the roll and the panel can name
 * its keys by the notes you hear rather than by where they sit on it.
 *
 * Read off the knobs, not heard: the sound source the Keyboard's Pitch cable
 * reaches, at its Pitch knob and its own Octave switch, plus the Keyboard's
 * Octave switch. That is what the bottom key plays in any patch
 * wired the ordinary way. Everything after the knobs is left out on purpose --
 * FM Amt, an envelope summed into the same jack, a CV Utility in between --
 * because the names are there to say what a key is tuned to, and a sweep on
 * top of it is not a different note.
 */
export interface Tuning {
  /** The module the tuning is read from, so the roll can say where the names came from. */
  source: string
  /**
   * The note that module sounds with nothing at its jacks, as a MIDI note
   * number. Fractional and never rounded: a patch tuned between two notes is
   * tuned between them, and someone working in quarter tones needs to see it.
   */
  base: number
  /** The Keyboard's Octave switch, which moves every key it has. */
  octave: number
}

/**
 * Modules a pitch passes through as the same pitch: a Slew glides between
 * notes and a Quantizer lands them on a scale, and neither changes what note
 * the bottom key is. Followed from their Out, into their In.
 */
const PASS_THROUGH: Record<string, { in: string; out: string }> = {
  slew: { in: 'in', out: 'out' },
  quant: { in: 'in', out: 'out' },
}
/** Sources this close above the lowest are one note played thick, not two notes. */
const SPREAD_SEMITONES = 0.3

/**
 * The tuning of a rack, or null when there is no Keyboard or it reaches no
 * tuned source -- a drum, a Sampler, a patch still being wired.
 *
 * With several sources on the Keyboard's pitch, the lowest names the keys:
 * in a stack it is the fundamental. Sources a few cents above it are a
 * detuned layer of the same note, so the name is the middle of that spread
 * -- a pair a few cents either side of C4 reads C4, as it sounds.
 */
export function tuningOf(rack: Rack): Tuning | null {
  const target = noteTarget(rack.patch)
  if (!target || target.kind !== 'note') return null
  const byId = new Map(rack.patch.modules.map((m) => [m.id, m]))
  const keys = byId.get(target.module)
  if (!keys) return null

  // Out from the Keyboard's Pitch jack, and on through anything that passes
  // a pitch along unchanged.
  const sources: { source: string; base: number }[] = []
  const seen = new Set<string>()
  const from: { module: string; port: string }[] = [{ module: keys.id, port: 'pitch' }]
  while (from.length) {
    const out = from.pop()!
    for (const cable of rack.patch.cables) {
      if (cable.from.module !== out.module || cable.from.port !== out.port) continue
      const m = byId.get(cable.to.module)
      if (!m) continue
      const pass = PASS_THROUGH[m.type]
      if (pass) {
        if (cable.to.port === pass.in && !seen.has(m.id)) {
          seen.add(m.id)
          from.push({ module: m.id, port: pass.out })
        }
        continue
      }
      if (cable.to.port !== 'pitch' && cable.to.port !== 'fm') continue
      const def = defOf(m.type)
      const tuned = def.params.find((p) => p.tuned)
      if (!tuned) continue
      const octaveSpec = def.params.find((p) => p.id === 'octave')
      const hz = valueOf(rack, m, tuned) * 2 ** (octaveSpec ? Math.round(valueOf(rack, m, octaveSpec)) : 0)
      if (hz > 0) sources.push({ source: m.id, base: A4_MIDI + semitonesFrom440(hz) })
    }
  }
  if (sources.length === 0) return null

  const lowest = sources.reduce((a, b) => (b.base < a.base ? b : a))
  const layer = sources.filter((s) => s.base < lowest.base + SPREAD_SEMITONES)
  const base = layer.reduce((sum, s) => sum + s.base, 0) / layer.length
  const octaveSpec = defOf(keys.type).params.find((p) => p.id === 'octave')
  return {
    source: lowest.source,
    base,
    octave: octaveSpec ? Math.round(valueOf(rack, keys, octaveSpec)) : 0,
  }
}

/** The knob as it stands: turned, saved, or at its default. */
function valueOf(rack: Rack, m: PatchModule, spec: ParamSpec): number {
  const turned = rack.values[`${m.id}.${spec.id}`]
  if (Number.isFinite(turned)) return turned
  const saved = m.params[spec.id]
  return Number.isFinite(saved) ? saved : spec.default
}

/** The MIDI note a track's bottom row sounds, fractional. */
export const rowZero = (tuning: Tuning | null) =>
  tuning ? tuning.base + 12 * tuning.octave : UNTUNED_ROW_ZERO

/**
 * The row a MIDI note plays on a track: the row whose name is that note, so
 * a controller's C4 is the C4 you hear on every track, whatever each one's
 * patch is tuned to. Rounded to the nearest row for a patch tuned between
 * notes, and held inside the rows there are.
 */
export function rowForMidi(midi: number, tuning: Tuning | null): number {
  const row = Math.round(midi - rowZero(tuning))
  return Math.min(PITCH_RANGE.high, Math.max(PITCH_RANGE.low, row))
}

/**
 * A note's name, from a MIDI note number: the nearest note, with its octave
 * counted the scientific way, so 60 is C4 and 12 is C0. Below that the
 * octaves go on negative -- C-1, C-2 -- rather than stopping.
 */
export function midiName(midi: number): string {
  const n = Math.round(midi)
  return `${NAMES[mod12(n)]}${Math.floor(n / 12) - 1}`
}

/** The same, with how far off the named note it is: "C4", or "C4 +26¢". */
export function midiNameCents(midi: number): string {
  const cents = Math.round((midi - Math.round(midi)) * 100)
  return cents === 0 ? midiName(midi) : `${midiName(midi)} ${cents > 0 ? '+' : '-'}${Math.abs(cents)}¢`
}

/**
 * The song's key as the rows of one track see it.
 *
 * The key is kept in real notes -- A minor means the A you hear -- and every
 * track's rows start on whatever note its Keyboard is tuned to, so the root
 * is turned into this track's row numbering before anything shades, snaps or
 * builds a chord from it. For a patch whose bottom key is a C, which is every
 * one in the library, this changes nothing.
 */
export function scaleForRows(scale: Scale | undefined, zero: number): Scale | undefined {
  if (!scale) return scale
  return { ...scale, root: mod12(scale.root - Math.round(zero)) }
}
