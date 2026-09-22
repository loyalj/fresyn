import { defOf } from './defs'
import type { Cable, Patch, PatchModule } from './types'

export interface PortRef {
  module: string
  port: string
}

export function cableId(from: PortRef, to: PortRef) {
  return `${from.module}.${from.port}->${to.module}.${to.port}`
}

/** Every knob in the patch, keyed `moduleId.paramId`, defaults filled in. */
export function initialValues(patch: Patch): Record<string, number> {
  const values: Record<string, number> = {}
  for (const m of patch.modules) {
    for (const spec of defOf(m.type).params) {
      values[`${m.id}.${spec.id}`] = m.params[spec.id] ?? spec.default
    }
  }
  return values
}

/**
 * Knob values for a changed rack: seeded from the defaults for modules that
 * just arrived, carried over for the ones that survived, dropped for the ones
 * that left.
 */
export function reconcileValues(
  patch: Patch,
  previous: Record<string, number>,
): Record<string, number> {
  const next = initialValues(patch)
  for (const key of Object.keys(next)) {
    if (key in previous) next[key] = previous[key]
  }
  return next
}

export function portKind(patch: Patch, ref: PortRef): 'input' | 'output' | null {
  const m = patch.modules.find((x) => x.id === ref.module)
  if (!m) return null
  const def = defOf(m.type)
  if (def.inputs.some((p) => p.id === ref.port)) return 'input'
  if (def.outputs.some((p) => p.id === ref.port)) return 'output'
  return null
}

/** The cable occupying an input jack, if any. */
export function cableInto(patch: Patch, ref: PortRef): Cable | undefined {
  return patch.cables.find((c) => c.to.module === ref.module && c.to.port === ref.port)
}

/**
 * Patch a cable from an output to an input. An input jack holds one cable, as
 * on hardware, so connecting to an occupied jack unplugs what was there.
 */
export function connect(patch: Patch, from: PortRef, to: PortRef): Patch {
  if (portKind(patch, from) !== 'output' || portKind(patch, to) !== 'input') return patch

  const id = cableId(from, to)
  const kept = patch.cables.filter(
    (c) => !(c.to.module === to.module && c.to.port === to.port) && c.id !== id,
  )
  return { ...patch, cables: [...kept, { id, from: { ...from }, to: { ...to } }] }
}

/** Remove every cable touching a jack, for a right-click unplug. */
export function disconnectAt(patch: Patch, ref: PortRef): Patch {
  const cables = patch.cables.filter(
    (c) =>
      !(c.from.module === ref.module && c.from.port === ref.port) &&
      !(c.to.module === ref.module && c.to.port === ref.port),
  )
  return cables.length === patch.cables.length ? patch : { ...patch, cables }
}

export function disconnect(patch: Patch, id: string): Patch {
  return { ...patch, cables: patch.cables.filter((c) => c.id !== id) }
}

/**
 * @param at Where in the rack it lands. The menu that adds modules is at the
 *   top of the page, so a unit added from it appears where the eye already
 *   is, rather than off the bottom of a rack that may be pages long.
 */
export function addModule(
  patch: Patch,
  module: PatchModule,
  at: 'top' | 'bottom' = 'bottom',
): Patch {
  const modules = at === 'top' ? [module, ...patch.modules] : [...patch.modules, module]
  return { ...patch, modules }
}

/**
 * Put a module into the rack directly below another one.
 *
 * Where a copy belongs. Adding it at the end would drop it pages away in a
 * long rack, and the first thing anyone does with a copy is compare it with
 * what it was copied from.
 */
export function addModuleAfter(patch: Patch, afterId: string, module: PatchModule): Patch {
  const at = patch.modules.findIndex((m) => m.id === afterId)
  if (at < 0) return addModule(patch, module)

  const modules = patch.modules.slice()
  modules.splice(at + 1, 0, module)
  return { ...patch, modules }
}

/**
 * Bind a module's gate to a key, or clear the binding with `undefined`.
 *
 * Two modules on one key is allowed and useful -- it fires both, which is how
 * you layer a body and a transient on one press -- so nothing here unbinds
 * anybody else.
 */
export function setModuleKey(patch: Patch, id: string, key: string | undefined): Patch {
  const at = patch.modules.findIndex((m) => m.id === id)
  if (at < 0 || patch.modules[at].key === key) return patch

  const modules = patch.modules.slice()
  const { key: _dropped, ...rest } = modules[at]
  modules[at] = key ? { ...rest, key } : rest
  return { ...patch, modules }
}

/** A free id for a new module of this type: osc1, osc2, ... */
export function nextModuleId(patch: Patch, type: string): string {
  const slug = defOf(type).slug
  const taken = new Set(patch.modules.map((m) => m.id))
  for (let n = 1; ; n++) {
    const id = `${slug}${n}`
    if (!taken.has(id)) return id
  }
}

/** Pull a module out of the rack, along with everything patched to it. */
export function removeModule(patch: Patch, id: string): Patch {
  return {
    modules: patch.modules.filter((m) => m.id !== id),
    cables: patch.cables.filter((c) => c.from.module !== id && c.to.module !== id),
  }
}

/**
 * Put the rack in the given order, for a drag that has just been let go.
 *
 * Forgiving about what it is handed: an id that is no longer in the patch is
 * skipped, and a module the list never mentions keeps its place at the end.
 * The order comes from a gesture that can be interrupted by anything, and no
 * version of that is worth losing a unit over.
 */
export function reorderModules(patch: Patch, ids: string[]): Patch {
  const remaining = new Map(patch.modules.map((m) => [m.id, m]))
  const modules: PatchModule[] = []
  for (const id of ids) {
    const m = remaining.get(id)
    if (!m) continue
    modules.push(m)
    remaining.delete(id)
  }
  for (const m of patch.modules) if (remaining.has(m.id)) modules.push(m)
  return { ...patch, modules }
}

/**
 * Move a unit up or down the rack. Purely cosmetic: execution order comes from
 * the topological sort, not from where a unit sits on the rails.
 */
export function moveModule(patch: Patch, id: string, delta: number): Patch {
  const from = patch.modules.findIndex((m) => m.id === id)
  if (from < 0) return patch
  const to = from + delta
  if (to < 0 || to >= patch.modules.length) return patch

  const modules = patch.modules.slice()
  const [moved] = modules.splice(from, 1)
  modules.splice(to, 0, moved)
  return { ...patch, modules }
}
