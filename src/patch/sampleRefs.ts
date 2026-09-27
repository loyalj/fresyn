/**
 * Which samples are still wanted: every id some patch, somewhere, names.
 *
 * What `pruneSamples` is handed as its keep list, so the one rule here is that
 * it must never come up short. A sample left out of it is deleted, and a
 * sample is somebody's recording; one kept for nothing costs a few hundred
 * kilobytes. So the walk is structural rather than typed -- it finds a module
 * with a sample on it inside anything shaped like a patch, a project, a rack,
 * a saved-patch shelf or a list of any of them, whether it is the live
 * document or JSON read back out of storage -- and where it cannot read a
 * place it answers null, which means "do not prune", rather than an empty
 * set, which would mean "prune everything".
 */

/**
 * Add every sample id found anywhere inside `value` to `into`.
 *
 * A module is anything with a string `type` and a `sample` carrying a string
 * `id`, which is what a patch module is both live and stored. Depth is capped
 * only so that something cyclic cannot hang the walk; no real document comes
 * near it.
 */
export function sampleIdsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  const seen = new Set<object>()
  const walk = (v: unknown, depth: number) => {
    if (typeof v !== 'object' || v === null || depth > 64 || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    const o = v as Record<string, unknown>
    const sample = o.sample
    if (typeof o.type === 'string' && typeof sample === 'object' && sample !== null) {
      const id = (sample as Record<string, unknown>).id
      if (typeof id === 'string' && id) into.add(id)
    }
    for (const key of Object.keys(o)) walk(o[key], depth + 1)
  }
  walk(value, 0)
  return into
}

/**
 * Every sample id named by anything this app keeps in localStorage: the
 * autosaved project, the saved-patches shelf, and whatever is added there
 * later under the same prefixes. Null when storage cannot be read, or when
 * any of it will not parse -- in either case something might name a sample
 * and there is no way to tell what.
 */
export function sampleIdsInLocalStorage(prefixes: readonly string[] = ['fresyn.', 'freeson.']): Set<string> | null {
  const into = new Set<string>()
  try {
    const store = globalThis.localStorage
    if (!store) return null
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key === null) return null
      if (!prefixes.some((p) => key.startsWith(p))) continue
      const text = store.getItem(key)
      if (text === null) continue
      sampleIdsIn(JSON.parse(text), into)
    }
  } catch {
    return null
  }
  return into
}
