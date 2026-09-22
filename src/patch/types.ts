export interface PortDef {
  id: string
  label: string
}

/**
 * Which part of a patch a module belongs to, for the menus that list them.
 *
 * Declared here rather than in the menu because two places show the
 * catalogue -- the Modules menu and the panel under the rack -- and a module
 * that arrived in one grouping and not the other would be a bug nobody
 * noticed until they went looking for it.
 */
export type ModuleGroup = 'voice' | 'effects' | 'modulation' | 'control' | 'output'

export interface ModuleDef {
  type: string
  name: string
  group: ModuleGroup
  /**
   * Prefix for generated instance ids. Kept separate from `type` so the ids
   * read the way the panel does -- a ladder filter is lpf1, not ladder1.
   */
  slug: string
  /** The module has a trigger of its own, and gets a button on its panel. */
  trigger?: boolean
  /**
   * The trigger can also be fired from the keyboard, and the panel draws the
   * cap that says which key. Only the Trigger module: everything else in the
   * rack is played through a cable from one, which is what the Trigger module
   * is for.
   */
  keyed?: boolean
  /**
   * How much of a rack row the panel takes. Full by default; a module with
   * few enough controls to sit in half a row says so here, and the rack pairs
   * it with whichever half-width panel is next to it in the order.
   */
  width?: 'full' | 'half'
  /**
   * Two output port ids forming a stereo bus. A bus that is not patched on
   * into the rack is a main mix, and main mixes are what the speakers hear.
   * Declared here so the compiler never has to name a module type.
   */
  bus?: [string, string]
  /**
   * Two input port ids the render is taken from. The module that declares
   * this is the recorder: what reaches these jacks is what lands in the wav.
   */
  tap?: [string, string]
  inputs: PortDef[]
  outputs: PortDef[]
  params: import('./param').ParamSpec[]
}

export interface PatchModule {
  id: string
  type: string
  /** Sparse: anything absent falls back to the def's default. */
  params: Record<string, number>
  /**
   * The key this module's gate answers to, as a `KeyboardEvent.code`.
   *
   * Beside `params` rather than in it because it is not a number and has no
   * range: the values machinery interpolates, clamps and smooths, and none of
   * those mean anything for a key. Absent means the module is played by its
   * button alone.
   */
  key?: string
}

export interface Cable {
  id: string
  from: { module: string; port: string }
  to: { module: string; port: string }
}

export interface Patch {
  modules: PatchModule[]
  cables: Cable[]
}
