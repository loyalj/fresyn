import type { ParamSpec } from '../patch/param'
import type { ModuleDef } from '../patch/types'
import { Control } from './Control'

/**
 * A module's knobs by id, worked out once per module type rather than on
 * every render of every panel of that type.
 */
const specs = new WeakMap<ModuleDef, Readonly<Record<string, ParamSpec>>>()

export function specsOf(def: ModuleDef): Readonly<Record<string, ParamSpec>> {
  let out = specs.get(def)
  if (!out) {
    out = Object.fromEntries(def.params.map((p) => [p.id, p]))
    specs.set(def, out)
  }
  return out
}

/**
 * What every hand-laid face needs from its module: the knobs by id, a
 * knob's value with the default standing in for one not yet seeded, and the
 * control for a knob, ready to drop into the layout.
 *
 * Every face used to build these three for itself, the same way each time.
 */
export function useFace(
  def: ModuleDef,
  valueOf: (paramId: string) => number | undefined,
  onChange: (paramId: string, value: number) => void,
) {
  const spec = specsOf(def)
  const read = (id: string) => valueOf(id) ?? spec[id].default
  const control = (id: string) => (
    <Control key={id} spec={spec[id]} value={valueOf(id)} onChange={(v) => onChange(id, v)} />
  )
  return { spec, read, control }
}
