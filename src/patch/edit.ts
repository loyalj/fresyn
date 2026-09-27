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
  const cables = patch.cables.filter((c) => c.id !== id)
  // No such cable is no edit: the same patch back, so nothing lands in the
  // undo history for a click that changed nothing.
  return cables.length === patch.cables.length ? patch : { ...patch, cables }
}

/**
 * @param at Where in the rack it lands. The menu that adds modules is at the
 *   top of the page, so a unit added from it appears where the eye already
 *   is, rather than off the bottom of a rack that may be pages long.
 */
/**
 * Point a module at a sample, or at none.
 *
 * An edit like any other, so it lands in the history: dropping the wrong file
 * on a panel is undone the same way a mistaken cable is.
 */
export function setSample(
  patch: Patch,
  moduleId: string,
  sample: { id: string; name: string } | null,
): Patch {
  const at = patch.modules.findIndex((m) => m.id === moduleId)
  if (at < 0) return patch
  const had = patch.modules[at].sample
  // The same file dropped again, or clearing a panel with nothing in it.
  if (sample ? had?.id === sample.id && had.name === sample.name : !had) return patch
  const modules = patch.modules.map((m) => {
    if (m.id !== moduleId) return m
    if (!sample) {
      const { sample: _dropped, ...rest } = m
      return rest
    }
    return { ...m, sample: { ...sample } }
  })
  return { ...patch, modules }
}

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
 * Put a module into the rack directly above another one.
 *
 * Where a new unit goes when something is picked: the picked unit is where
 * you are working, and a new one arriving at the top of a long rack would be
 * pages from it.
 */
export function addModuleBefore(patch: Patch, beforeId: string, module: PatchModule): Patch {
  const at = patch.modules.findIndex((m) => m.id === beforeId)
  if (at < 0) return addModule(patch, module, 'top')

  const modules = patch.modules.slice()
  modules.splice(at, 0, module)
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

/**
 * What copying some modules holds: the modules with their knobs where they
 * were standing, and the cables that ran between them. Cables to anything
 * left behind are not in it -- a pasted group arrives wired to itself and to
 * nothing else, the way a duplicated unit arrives unpatched.
 */
export interface ModuleClip {
  modules: PatchModule[]
  cables: Cable[]
}

export function copyModules(
  patch: Patch,
  values: Record<string, number>,
  ids: Iterable<string>,
): ModuleClip {
  const wanted = new Set(ids)
  // In rack order, so they paste in the order they were seen.
  const modules = patch.modules
    .filter((m) => wanted.has(m.id))
    .map((m) => {
      const params: Record<string, number> = { ...m.params }
      for (const spec of defOf(m.type).params) {
        const v = values[`${m.id}.${spec.id}`]
        if (v !== undefined) params[spec.id] = v
      }
      const copy: PatchModule = { ...m, params }
      if (m.sample) copy.sample = { ...m.sample }
      return copy
    })
  const cables = patch.cables
    .filter((c) => wanted.has(c.from.module) && wanted.has(c.to.module))
    .map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } }))
  return { modules, cables }
}

/**
 * Put a copied group into a rack -- the same one or another track's -- with
 * fresh ids, its own cables re-pointed at the new ids, and its knobs where
 * they were copied from. At the top, where a module added from the menu goes,
 * because that is where the eye is.
 */
export function pasteModules(
  patch: Patch,
  values: Record<string, number>,
  clip: ModuleClip,
): { patch: Patch; values: Record<string, number>; ids: string[] } {
  let next = patch
  const renamed = new Map<string, string>()
  const added: PatchModule[] = []
  for (const m of clip.modules) {
    const id = nextModuleId({ ...next, modules: [...next.modules, ...added] }, m.type)
    renamed.set(m.id, id)
    added.push({ ...m, id, params: { ...m.params } })
  }
  next = { ...next, modules: [...added, ...next.modules] }
  for (const c of clip.cables) {
    const from = { module: renamed.get(c.from.module)!, port: c.from.port }
    const to = { module: renamed.get(c.to.module)!, port: c.to.port }
    const wired = connect(next, from, to)
    next = c.color === undefined ? wired : setCableColor(wired, cableId(from, to), c.color)
  }
  const out = reconcileValues(next, values)
  for (const m of added) {
    for (const [param, v] of Object.entries(m.params)) out[`${m.id}.${param}`] = v
  }
  return { patch: next, values: out, ids: added.map((m) => m.id) }
}

/** Switch a module out of the signal path, or back in. */
export function toggleBypass(patch: Patch, id: string): Patch {
  const target = patch.modules.find((m) => m.id === id)
  if (!target || !defOf(target.type).bypass) return patch
  const modules = patch.modules.map((m) => {
    if (m.id !== id || !defOf(m.type).bypass) return m
    if (m.bypass) {
      const { bypass: _dropped, ...rest } = m
      return rest
    }
    return { ...m, bypass: true as const }
  })
  return { ...patch, modules }
}

/** Give one cable a colour of its own, or none to hand it back to the rack's. */
export function setCableColor(patch: Patch, id: string, color: number | undefined): Patch {
  const target = patch.cables.find((c) => c.id === id)
  if (!target || target.color === color) return patch
  const cables = patch.cables.map((c) => {
    if (c.id !== id) return c
    if (color === undefined) {
      const { color: _dropped, ...rest } = c
      return rest
    }
    return { ...c, color }
  })
  return { ...patch, cables }
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
  // A drag let go where it started.
  if (modules.every((m, i) => m === patch.modules[i])) return patch
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
