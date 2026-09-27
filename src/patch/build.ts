import { defOf } from './defs'
import { addModule, connect, nextModuleId } from './edit'
import type { Patch } from './types'

/**
 * The building blocks every shipped rack is written with.
 *
 * Here rather than in `library.ts`, which is where they grew up, because two
 * modules build racks and one of them is read by the other at load: the
 * library lists every instrument, so it imports `instruments.ts`, and the
 * instruments were importing their tools back out of the library. Whichever
 * of the two a program happened to touch first decided whether the other was
 * finished yet, and importing the instruments first threw. Both depend on
 * this instead, and this depends on neither.
 */

export interface Built {
  patch: Patch
  /**
   * Knob positions, keyed `moduleId.paramId` and sparse: anything a template
   * does not mention is left wherever the module's own default puts it.
   */
  values: Record<string, number>
}

/** `"osc1.out -> lpf1.in"`, as the manual writes a cable. */
export function wire(patch: Patch, ...wires: string[]): Patch {
  let next = patch
  for (const w of wires) {
    const [from, to] = w.split(' -> ')
    const [fromModule, fromPort] = from.split('.')
    const [toModule, toPort] = to.split('.')
    const before = next
    next = connect(next, { module: fromModule, port: fromPort }, { module: toModule, port: toPort })
    // `connect` silently declines a cable it cannot make, which would leave a
    // template quietly missing a step and sounding like nothing much.
    if (next === before) throw new Error(`the cable "${w}" did not connect`)
  }
  return next
}

/**
 * Add a module, at the top.
 *
 * Where the Modules menu puts them, and these racks are meant to be the ones
 * a reader following the tutorial ends up with. What a patch does is decided
 * by its cables rather than by the order of its units, but a template built
 * in an order nobody can actually produce would not match the prose.
 */
export function add(patch: Patch, type: string): Patch {
  return addModule(patch, { id: nextModuleId(patch, type), type, params: {} }, 'top')
}

/** `[id, type, knobs]`, in rack order. Ids use the Modules menu's slugs. */
export type Unit = [id: string, type: string, knobs?: Record<string, number>]

/**
 * A rack from a list of units and the cables between them.
 *
 * Knobs are checked against the catalogue as the rack is made, so a typo
 * throws here -- and so in the check -- instead of shipping a voice with a
 * knob quietly left at its default.
 */
export function rack(units: Unit[], cables: string[]): Built {
  const patch: Patch = {
    modules: units.map(([id, type]) => ({
      id,
      type,
      params: {},
      ...(type === 'gate' ? { key: 'Space' } : {}),
    })),
    cables: [],
  }
  const values: Record<string, number> = {}
  for (const [id, type, knobs] of units) {
    const specs = defOf(type).params
    for (const [knob, value] of Object.entries(knobs ?? {})) {
      const spec = specs.find((s) => s.id === knob)
      if (!spec) throw new Error(`${id} (${type}) has no knob "${knob}"`)
      // Out of range is a typo too: the panel would clamp it, and the voice
      // would ship sounding like a setting nobody chose.
      if (value < spec.min || value > spec.max) {
        throw new Error(`${id}.${knob} = ${value} is outside ${spec.min}..${spec.max}`)
      }
      values[`${id}.${knob}`] = value
    }
  }
  return { patch: wire(patch, ...cables), values }
}
