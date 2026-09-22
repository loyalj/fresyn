import { MODULE_DEFS, defOf } from './defs'
import type { Cable, Patch, PatchModule } from './types'

export const PATCH_FORMAT = 1

interface Migration {
  /** What this module type is called now. */
  type?: string
  /** Port and parameter ids that have been renamed, old to new. */
  ids?: Record<string, string>
}

/**
 * Modules that have been renamed or rearranged since patches were first
 * saved, keyed by the type as the file spells it.
 *
 * The format version stays where it is: nothing about the file changed
 * shape, and a patch saved yesterday should still open. Ports and parameters
 * share one table because their ids are unique within a module.
 */
const MIGRATIONS: Record<string, Migration> = {
  // The output stage became the recorder when the mixer started driving the
  // speakers by itself. Its jacks kept their ids, so its cables still land.
  out: { type: 'rec' },
  // The sample and hold grew from one channel to four, and its lone set of
  // ports became channel 1.
  sh: { ids: { in: 'in1', trig: 'trig1', out: 'out1', clock: 'clk1', rate: 'rate1' } },
}

export interface StoredPatch {
  version: number
  name: string
  patch: Patch
}

export interface LoadResult {
  name: string
  patch: Patch
  /** Anything dropped or repaired on the way in. */
  warnings: string[]
}

/**
 * Bake the live knob positions into the patch so a saved file is
 * self-contained. Values are held separately while editing, keyed by
 * `moduleId.paramId`; on the way out they belong with their module.
 *
 * A module's key binding is already on the module and needs no gathering: it
 * is not a knob and is never held apart from the patch.
 */
export function toStored(name: string, patch: Patch, values: Record<string, number>): StoredPatch {
  const modules: PatchModule[] = patch.modules.map((m) => {
    const params: Record<string, number> = {}
    for (const spec of defOf(m.type).params) {
      const v = values[`${m.id}.${spec.id}`]
      params[spec.id] = Number.isFinite(v) ? v : (m.params[spec.id] ?? spec.default)
    }
    const out: PatchModule = { id: m.id, type: m.type, params }
    // Omitted rather than written as null when there is none, so a patch that
    // binds nothing reads the same as one saved before keys existed.
    if (m.key) out.key = m.key
    return out
  })

  return {
    version: PATCH_FORMAT,
    name,
    patch: { modules, cables: patch.cables.map((c) => ({ ...c })) },
  }
}

/**
 * Parse a stored patch defensively. Files get hand-edited, and shipped racks
 * outlive the module list they were saved against, so anything unrecognised is
 * dropped with a warning rather than allowed to throw at load.
 */
export function fromStored(input: unknown): LoadResult | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'not a patch file' }
  const data = input as Record<string, unknown>

  if (typeof data.version !== 'number') return { error: 'missing format version' }
  if (data.version > PATCH_FORMAT) {
    return { error: `patch format ${data.version} is newer than this build understands` }
  }

  const raw = data.patch
  if (typeof raw !== 'object' || raw === null) return { error: 'no patch in file' }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.modules)) return { error: 'patch has no modules' }

  const warnings: string[] = []
  const modules: PatchModule[] = []
  const seen = new Set<string>()
  /**
   * Which migration each module's cables have to be read through. A cable
   * names a port, and only the module it lands on knows what that port is
   * called now.
   */
  const movedIds = new Map<string, Record<string, string>>()

  for (const entry of body.modules) {
    if (typeof entry !== 'object' || entry === null) continue
    const m = entry as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id : ''
    const declared = typeof m.type === 'string' ? m.type : ''
    const moved = MIGRATIONS[declared]
    const type = moved?.type ?? declared

    if (!id || !type) {
      warnings.push('skipped a module with no id or type')
      continue
    }
    if (!MODULE_DEFS[type]) {
      warnings.push(`skipped "${id}": this build has no "${type}" module`)
      continue
    }
    if (seen.has(id)) {
      warnings.push(`skipped a second module called "${id}"`)
      continue
    }
    seen.add(id)
    if (moved?.ids) movedIds.set(id, moved.ids)

    // Only parameters the module still declares survive, and only as numbers.
    const params: Record<string, number> = {}
    const stored = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>
    for (const spec of defOf(type).params) {
      const v = stored[spec.id] ?? stored[oldName(moved, spec.id)]
      if (typeof v === 'number' && Number.isFinite(v)) {
        params[spec.id] = Math.min(spec.max, Math.max(spec.min, v))
      }
    }
    // A key binding is taken on trust as far as being a string goes, and no
    // further: a `code` this browser never produces simply never fires, which
    // is what a patch from another keyboard layout should do rather than
    // refuse to open.
    const key = typeof m.key === 'string' && m.key ? m.key : undefined
    modules.push(key ? { id, type, params, key } : { id, type, params })
  }

  const cables: Cable[] = []
  for (const entry of Array.isArray(body.cables) ? body.cables : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const c = entry as Record<string, unknown>
    const stored = { from: asPort(c.from), to: asPort(c.to) }
    if (!stored.from || !stored.to) continue
    if (!seen.has(stored.from.module) || !seen.has(stored.to.module)) {
      warnings.push('dropped a cable to a module that is not in the patch')
      continue
    }
    // Renamed before the id is built, so a migrated cable is named after the
    // jacks it actually lands on.
    const from = rename(stored.from)
    const to = rename(stored.to)
    cables.push({
      id: typeof c.id === 'string' ? c.id : `${from.module}.${from.port}->${to.module}.${to.port}`,
      from,
      to,
    })
  }

  return {
    name: typeof data.name === 'string' && data.name ? data.name : 'Untitled',
    patch: { modules, cables },
    warnings,
  }

  function rename(ref: { module: string; port: string }) {
    const ids = movedIds.get(ref.module)
    const now = ids?.[ref.port]
    return now ? { module: ref.module, port: now } : ref
  }
}

/**
 * The id a port or parameter was stored under before it was renamed. The
 * table reads old-to-new, because that is the direction it is applied in
 * everywhere else; this is the one place that needs it the other way round.
 */
function oldName(moved: Migration | undefined, id: string): string {
  if (!moved?.ids) return id
  for (const [was, now] of Object.entries(moved.ids)) if (now === id) return was
  return id
}

function asPort(v: unknown): { module: string; port: string } | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  if (typeof p.module !== 'string' || typeof p.port !== 'string') return null
  return { module: p.module, port: p.port }
}
