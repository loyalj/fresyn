export interface PortDef {
  id: string
  label: string
  /**
   * The box on the back panel this jack is drawn in, headed by this name.
   * Ports naming the same block share a box, and a block may hold both an
   * input and an output -- the Sample & Hold groups by channel, so its CH 3
   * box holds everything to do with channel 3 and nothing else.
   *
   * Absent means the panel's own grouping, which is the inputs in one box and
   * the outputs in another. That is what most modules want.
   *
   * Called `block` and not `group` because ModuleDef already has a group and
   * it means something else entirely: which menu the module is listed under.
   */
  block?: string
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
  /**
   * Notes can be played on this module: it has a pitch and a velocity as well
   * as a gate. Declared here so that finding what a sequencer should play in
   * a given patch is a question about the catalogue rather than a list of
   * module types kept somewhere else and forgotten about.
   */
  playable?: true
  /**
   * One of these serves every voice at once. A chord is played by giving each
   * held note its own copy of the modules it passes through, and those copies
   * are summed where they reach a module marked here -- the mixer, the room,
   * the echo. Copying a reverb per note would cost eight reverbs and sound
   * like one, and a compressor or a scope has to hear the chord, not a note.
   */
  shared?: true
  /**
   * The module can be switched out of the signal path, leaving whatever
   * reaches its In jack to go straight on to wherever its Out went (both of
   * them, for a stereo pair). For the filters and effects, which is where a
   * before-and-after is what you want to hear.
   */
  bypass?: true
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
   * The audio this module plays, when it plays any.
   *
   * Beside `params` for the same reason a key binding is: it is not a number,
   * and nothing about interpolating, clamping or smoothing it means anything.
   * Only the hash and the name travel with the patch -- a patch stays a small
   * file you can read -- and the audio itself lives in the browser's own
   * storage, or arrives in a bundle. A patch whose sample is not to hand
   * still loads; the module comes up silent and says which file it wants.
   */
  sample?: { id: string; name: string }
  /**
   * The key this module's gate answers to, as a `KeyboardEvent.code`.
   *
   * Beside `params` rather than in it because it is not a number and has no
   * range: the values machinery interpolates, clamps and smooths, and none of
   * those mean anything for a key. Absent means the module is played by its
   * button alone.
   */
  key?: string
  /**
   * Switched out of the signal path; see `bypass` on the def. The module is
   * still there, cables and knobs and all, so switching it back in is the
   * sound it was.
   */
  bypass?: true
}

export interface Cable {
  id: string
  from: { module: string; port: string }
  to: { module: string; port: string }
  /**
   * A hue, 0..360, chosen for this cable, overriding however the rack colours
   * the rest. For picking out the one cable that matters in a dense patch.
   */
  color?: number
}

export interface Patch {
  modules: PatchModule[]
  cables: Cable[]
}
