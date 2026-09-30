import { defOf } from './defs'
import type { Cable, KitSlot, Patch, PatchModule } from './types'

/**
 * The Drum Kit: sixteen pads, each holding a whole rack from the library.
 *
 * The audio thread never hears of a kit holding racks. Before a patch is
 * compiled, every pad's rack is laid into the patch beside the kit, its
 * modules renamed under the pad -- `kit1/3/osc1` -- and its way out wired
 * into that pad's return on the kit. From there on it is one flat patch like
 * any other: the same compiler, the same engine, the same voices, the same
 * bounce, and a game plays it the same way. The kit module itself does only
 * what a drum module's own panel does: each pad's level and pan, the choke
 * groups, and the sum.
 *
 * A note reaches a pad the same way it reaches any rack: straight to the
 * Trigger (or Keyboard) inside it, by its renamed id. `song/bind.ts` works
 * out which, from the pad's note.
 */

export const KIT_SLOTS = 16

/** Separates the kit, the pad and the module in a laid-in module's id. */
const SEP = '/'

/** Whether a module in a compiled patch is one laid in from a pad. */
export const isPadModule = (id: string) => id.includes(SEP)

/** The id a module inside a pad's rack has once it is laid into the patch. */
export const padModuleId = (kit: string, slot: number, inner: string) => `${kit}${SEP}${slot + 1}${SEP}${inner}`

/**
 * The pads as they stand: sixteen entries, null for an empty one, whatever
 * the module holds -- a kit saved with fewer, or none yet.
 */
export function kitSlots(m: Pick<PatchModule, 'slots'>): (KitSlot | null)[] {
  const out: (KitSlot | null)[] = []
  for (let i = 0; i < KIT_SLOTS; i++) out.push(m.slots?.[i] ?? null)
  return out
}

/**
 * General MIDI's drum map, by note: what a pad on that note is expected to
 * be, for naming the roll's rows and for bringing a MIDI file's drums in.
 */
export const GM_DRUMS: Readonly<Record<number, string>> = {
  35: 'Kick 2', 36: 'Kick', 37: 'Side Stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2',
  41: 'Low Floor Tom', 42: 'Closed Hat', 43: 'High Floor Tom', 44: 'Pedal Hat', 45: 'Low Tom',
  46: 'Open Hat', 47: 'Low-Mid Tom', 48: 'High-Mid Tom', 49: 'Crash', 50: 'High Tom',
  51: 'Ride', 52: 'China', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash', 56: 'Cowbell',
  57: 'Crash 2', 58: 'Vibraslap', 59: 'Ride 2', 60: 'High Bongo', 61: 'Low Bongo',
  62: 'Mute High Conga', 63: 'Open High Conga', 64: 'Low Conga', 65: 'High Timbale',
  66: 'Low Timbale', 67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
  71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves',
  76: 'High Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica', 79: 'Open Cuica',
  80: 'Mute Triangle', 81: 'Open Triangle',
}

/**
 * What a new kit's pads are loaded with, and on which notes: the library's
 * drums laid out the way General MIDI lays out a kit, so a drum part from any
 * MIDI file lands on the sound it was written for. The hats share a choke
 * group, as a real pair of hats does.
 */
export const DEFAULT_KIT: readonly { instrument: string; note: number; choke?: number }[] = [
  { instrument: 'kick', note: 36 },
  { instrument: 'snare', note: 38 },
  { instrument: 'closedhat', note: 42, choke: 1 },
  { instrument: 'openhat', note: 46, choke: 1 },
  { instrument: 'clap', note: 39 },
  { instrument: 'rimshot', note: 37 },
  { instrument: 'tom', note: 45 },
  { instrument: 'crash', note: 49 },
  { instrument: 'ride', note: 51 },
  { instrument: 'tambourine', note: 54 },
  { instrument: 'cowbell', note: 56 },
  { instrument: 'conga', note: 63 },
  { instrument: 'bongo', note: 60 },
  { instrument: 'shaker', note: 70 },
  { instrument: 'claves', note: 75 },
  { instrument: 'woodblock', note: 76 },
]

/**
 * A rack as a pad holds it: knob positions baked into its modules, as a saved
 * patch has them, and nothing a pad cannot use. A kit inside a pad would be a
 * kit inside a kit, and a recorder decides where a render is taken from --
 * one in a pad would take it from the snare.
 */
export function padPatch(patch: Patch, values: Readonly<Record<string, number>> = {}): Patch {
  const dropped = new Set(patch.modules.filter((m) => m.type === 'kit' || defOf(m.type).tap).map((m) => m.id))
  const modules = patch.modules
    .filter((m) => !dropped.has(m.id))
    .map((m) => {
      const params: Record<string, number> = { ...m.params }
      for (const spec of defOf(m.type).params) {
        const v = values[`${m.id}.${spec.id}`]
        if (Number.isFinite(v)) params[spec.id] = v
      }
      // A key binding belongs to the rack a hand plays, and a pad is played
      // through the kit.
      const { key: _key, slots: _slots, ...rest } = m
      return { ...rest, params }
    })
  const cables = patch.cables
    .filter((c) => !dropped.has(c.from.module) && !dropped.has(c.to.module))
    .map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } }))
  return { modules, cables }
}

/**
 * The module a pad is played through: its Trigger, where it has one -- that
 * is what a hand reaches in the rack it came from -- or else its Keyboard.
 * Null for a rack with neither, which a pad plays nothing of.
 */
export function padEntry(patch: Patch): PatchModule | null {
  return (
    patch.modules.find((m) => defOf(m.type).keyed) ?? patch.modules.find((m) => defOf(m.type).playable) ?? null
  )
}

/**
 * The module a note is played on inside a pad, and whether it takes a pitch:
 * the Keyboard of a pitched rack, or the Trigger of a drum. The same rule
 * `noteTarget` uses for a track, so a pad plays the way its rack did on its
 * own track.
 */
export function padTarget(patch: Patch): { module: string; pitched: boolean } | null {
  const keys = patch.modules.find((m) => defOf(m.type).playable)
  if (keys) return { module: keys.id, pitched: true }
  const trig = patch.modules.find((m) => defOf(m.type).keyed)
  return trig ? { module: trig.id, pitched: false } : null
}

/**
 * Where a pad's rack comes out: its main mix, the one bus nothing in the
 * rack carries on. Null for a rack with none, which is a pad that plays
 * nothing anybody hears.
 */
function padOut(patch: Patch): { module: string; l: string; r: string } | null {
  const carried = new Set<string>()
  const byId = new Map(patch.modules.map((m) => [m.id, m]))
  for (const c of patch.cables) {
    const to = byId.get(c.to.module)
    if (to && defOf(to.type).outputs.length > 0) carried.add(`${c.from.module}.${c.from.port}`)
  }
  for (const m of patch.modules) {
    const bus = defOf(m.type).bus
    if (bus && !bus.some((port) => carried.has(`${m.id}.${port}`))) return { module: m.id, l: bus[0], r: bus[1] }
  }
  return null
}

/**
 * The patch with every kit's pads laid in beside it. A patch with no kit, or
 * none with anything loaded, comes back as it was, the same object.
 */
export function flattenKits(patch: Patch): Patch {
  const kits = patch.modules.filter((m) => m.type === 'kit' && m.slots?.some(Boolean))
  if (kits.length === 0) return patch

  const modules: PatchModule[] = [...patch.modules]
  const cables: Cable[] = [...patch.cables]
  for (const kit of kits) {
    kitSlots(kit).forEach((slot, i) => {
      if (!slot) return
      const inner = padPatch(slot.patch)
      const id = (m: string) => padModuleId(kit.id, i, m)
      for (const m of inner.modules) modules.push({ ...m, id: id(m.id) })
      for (const c of inner.cables) {
        cables.push({
          ...c,
          id: id(c.id),
          from: { module: id(c.from.module), port: c.from.port },
          to: { module: id(c.to.module), port: c.to.port },
        })
      }

      // Its way out, into the kit's return for this pad.
      const out = padOut(inner)
      if (out) {
        const n = i + 1
        cables.push(
          { id: `${kit.id}${SEP}${n}${SEP}ret-l`, from: { module: id(out.module), port: out.l }, to: { module: kit.id, port: `ret${n}l` } },
          { id: `${kit.id}${SEP}${n}${SEP}ret-r`, from: { module: id(out.module), port: out.r }, to: { module: kit.id, port: `ret${n}r` } },
        )
      }

      // A cable into the kit's Trig jack for this pad plays the pad, by
      // arriving at its Trigger as well -- unless something in the pad's own
      // rack already fires that, which the rack's own wiring wins.
      const trig = patch.cables.find((c) => c.to.module === kit.id && c.to.port === `trig${i + 1}`)
      const entry = padEntry(inner)
      const port = entry ? defOf(entry.type).inputs[0]?.id : undefined
      if (trig && entry && port && !inner.cables.some((c) => c.to.module === entry.id && c.to.port === port)) {
        cables.push({ id: `${kit.id}${SEP}${i + 1}${SEP}trig`, from: { ...trig.from }, to: { module: id(entry.id), port } })
      }
    })
  }
  return { modules, cables }
}

/**
 * A pad loaded, replaced or emptied. An edit like any other, so it lands in
 * the history and a wrong drum is one Ctrl+Z.
 */
export function setKitSlot(patch: Patch, kitId: string, slot: number, value: KitSlot | null): Patch {
  return putSlot(patch, kitId, slot, value && { name: value.name, note: value.note, patch: padPatch(value.patch) })
}

/** A pad's contents replaced as they are given: its rack already a pad's. */
function putSlot(patch: Patch, kitId: string, slot: number, value: KitSlot | null): Patch {
  const at = patch.modules.findIndex((m) => m.id === kitId && m.type === 'kit')
  if (at < 0 || slot < 0 || slot >= KIT_SLOTS) return patch
  const kit = patch.modules[at]
  const slots = kitSlots(kit)
  if (!value && !slots[slot]) return patch
  slots[slot] = value
  // Trailing empty pads are left off, so a kit with nothing in it saves as
  // a module with no pads rather than sixteen nulls.
  while (slots.length && !slots[slots.length - 1]) slots.pop()
  const { slots: _was, ...rest } = kit
  const next: PatchModule = slots.length ? { ...rest, slots } : rest
  return { ...patch, modules: patch.modules.map((m, i) => (i === at ? next : m)) }
}

/** A pad renamed or moved to another note, and nothing else changed. */
export function updateKitSlot(
  patch: Patch,
  kitId: string,
  slot: number,
  change: Partial<Pick<KitSlot, 'name' | 'note'>>,
): Patch {
  const kit = patch.modules.find((m) => m.id === kitId && m.type === 'kit')
  const was = kit ? kitSlots(kit)[slot] : null
  if (!kit || !was) return patch
  const name = change.name === undefined ? was.name : change.name.trim() || was.name
  const note = change.note === undefined ? was.note : clampNote(change.note)
  if (name === was.name && note === was.note) return patch
  // The same rack, not a fresh copy of it: only the name or the note moved.
  return putSlot(patch, kitId, slot, { ...was, name, note })
}

export const clampNote = (n: number) => Math.max(0, Math.min(127, Math.round(Number.isFinite(n) ? n : 0)))

// --- a pad opened on the bench ---------------------------------------------

/**
 * What every module id inside a pad starts with once laid in, and so what
 * that pad's knob values are kept under in its track's values: `kit1/3/`.
 */
export const padPrefix = (kit: string, slot: number) => padModuleId(kit, slot, '')

/** The pad as a rack of its own: its patch, and its knobs as that rack would key them. */
export interface PadView {
  patch: Patch
  values: Record<string, number>
}

/**
 * A pad as the bench shows it: the rack inside it, and its knobs lifted out
 * of the track's values with the pad's prefix taken off -- so every panel,
 * cable and edit on the bench works on it exactly as it does on a rack of
 * its own. Null for a pad that is not there.
 */
export function padView(
  rack: { patch: Patch; values: Readonly<Record<string, number>> },
  kit: string,
  slot: number,
): PadView | null {
  const module = rack.patch.modules.find((m) => m.id === kit && m.type === 'kit')
  const pad = module ? kitSlots(module)[slot] : null
  if (!pad) return null
  const prefix = padPrefix(kit, slot)
  const values: Record<string, number> = {}
  for (const m of pad.patch.modules) {
    for (const spec of defOf(m.type).params) {
      const key = `${m.id}.${spec.id}`
      const live = rack.values[prefix + key]
      values[key] = Number.isFinite(live) ? live : (m.params[spec.id] ?? spec.default)
    }
  }
  return { patch: pad.patch, values }
}

/**
 * The track's rack with a pad's view put back into it: the pad's rack
 * replaced, and its knobs written back under the pad's prefix. Anything a
 * pad cannot hold -- a kit, a recorder -- is left out on the way in.
 * `name` renames the pad as well, for a patch loaded into it.
 */
export function withPadView<R extends { patch: Patch; values: Record<string, number> }>(
  rack: R,
  kit: string,
  slot: number,
  view: PadView,
  name?: string,
): R {
  const module = rack.patch.modules.find((m) => m.id === kit && m.type === 'kit')
  const pad = module ? kitSlots(module)[slot] : null
  if (!pad) return rack
  const patch =
    view.patch === pad.patch && (name === undefined || name === pad.name)
      ? rack.patch
      : putSlot(rack.patch, kit, slot, { name: name ?? pad.name, note: pad.note, patch: padContents(view.patch) })
  const prefix = padPrefix(kit, slot)
  const values: Record<string, number> = {}
  for (const [key, value] of Object.entries(rack.values)) if (!key.startsWith(prefix)) values[key] = value
  for (const [key, value] of Object.entries(view.values)) values[prefix + key] = value
  return { ...rack, patch, values }
}

/**
 * A rack as a pad may hold it while it is being edited: without a kit or a
 * recorder, and otherwise exactly as it is -- its key bindings and its knobs
 * stay where the bench has them. Handed back as it was when there is nothing
 * to take out.
 */
function padContents(patch: Patch): Patch {
  const out = patch.modules.filter((m) => m.type === 'kit' || defOf(m.type).tap).map((m) => m.id)
  if (out.length === 0) return patch
  const dropped = new Set(out)
  return {
    modules: patch.modules.filter((m) => !dropped.has(m.id)),
    cables: patch.cables.filter((c) => !dropped.has(c.from.module) && !dropped.has(c.to.module)),
  }
}

/** Modules a pad cannot hold, and so the Modules menu does not offer while one is open. */
export const NOT_IN_A_PAD: ReadonlySet<string> = new Set(['kit', 'rec'])
