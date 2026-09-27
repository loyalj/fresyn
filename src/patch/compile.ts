import { defOf } from './defs'
import type { Cable, Patch } from './types'

export interface CompiledModule {
  id: string
  type: string
  /** Slot index per input port, in the def's port order. 0 means unpatched. */
  ins: number[]
  /** Slot index per output port. */
  outs: number[]
  paramBase: number
  paramCount: number
  /** Which sample this module asks the bank for, if any. */
  sample?: string
  /**
   * Runs once per sounding note rather than once for the rack. True for the
   * Keyboard a track plays and everything downstream of it, up to the first
   * shared module; see `shared` in types.ts.
   */
  poly?: boolean
}

export interface CompiledPatch {
  /** Execution order. */
  modules: CompiledModule[]
  slotCount: number
  /** Flat initial parameter values, indexed by `paramIndex`. */
  params: number[]
  /** `${moduleId}.${paramId}` to flat parameter index. */
  paramIndex: Record<string, number>
  /** Cables that became back edges and so carry a one-sample delay. */
  feedbackCables: string[]
  /** Bus outputs the engine sums into the speaker pair, as slot indices. */
  monitors: { l: number; r: number }[]
  /** Where that sum lands. Nothing in the patch owns these two slots. */
  monitorSlotL: number
  monitorSlotR: number
  /** Slots an offline render reads: the recorder's input, or the speakers. */
  renderSlotL: number
  renderSlotR: number
  /**
   * The Keyboard notes are played on, when the patch has one: the module the
   * engine hands each note to, and whose Voices knob says how many can sound
   * at once. The same module a track finds with `noteTarget`.
   */
  voices?: {
    root: string
    /**
     * What reaches its Gate jack, as a slot, or 0. Once there is more than
     * one voice the engine listens here itself and gives each press a voice
     * of its own; see `voiced` on the Keyboard.
     */
    gateSlot: number
    /** Flat indices of its Voices and Note knobs, or -1. */
    voicesParam: number
    noteParam: number
  }
  warnings: string[]
}

/** The outputs a bypassed module's input goes straight on to. */
const THROUGH = new Set(['out', 'l', 'r'])

/**
 * The patch with every bypassed module taken out of the signal path.
 *
 * Whatever fed a bypassed module's first input is patched on to everything
 * its Out went to -- both sides, for a stereo pair -- and whatever its other
 * outputs fed (a delay's Wet, a compressor's GR) is left unpatched, since a
 * module that is not there is doing none of that. The module itself stays in
 * the rack, still fed and still running, with nothing listening to it: its
 * knobs, its meter and its state are all where they were when it comes back.
 *
 * A chain of them works in any order. A module whose input comes from
 * another bypassed one is handed that one's Out, and the Out is replaced in
 * turn when that one is dealt with.
 */
export function withBypass(patch: Patch): Patch {
  const bypassed = patch.modules.filter((m) => m.bypass && defOf(m.type).bypass)
  if (bypassed.length === 0) return patch

  let cables = patch.cables
  for (const m of bypassed) {
    const def = defOf(m.type)
    const inPort = def.inputs[0]?.id
    const source = cables.find((c) => c.to.module === m.id && c.to.port === inPort)
    // Fed by itself, a bypassed module has nothing to pass on.
    const from = source && source.from.module !== m.id ? source.from : null
    const next: Cable[] = []
    for (const c of cables) {
      if (c.from.module !== m.id) {
        next.push(c)
        continue
      }
      if (!from || !THROUGH.has(c.from.port)) continue
      next.push({ ...c, id: `${c.id}~bypass`, from: { ...from } })
    }
    cables = next
  }
  return { ...patch, cables }
}

/**
 * Turns a patch into a flat execution plan for the audio thread.
 *
 * Signals live in a single slot array, one float per output port, and the
 * graph is stepped one sample at a time. That is what makes a feedback cable
 * cost exactly one sample: a back edge simply reads the slot before its
 * producer has written it this sample. Running the graph a block at a time
 * instead would make every cycle cost a whole 128-sample block, which is the
 * limitation of native Web Audio nodes that this engine exists to avoid.
 */
export function compile(input: Patch): CompiledPatch {
  // Bypass is wiring, so it is settled before anything else is: by the time
  // the slots are laid out, a bypassed module simply has nothing downstream
  // of it, and what fed it feeds what it used to. Every path that compiles a
  // patch -- the rack, a render, a bounce, a game -- hears the same thing.
  const patch = withBypass(input)
  const warnings: string[] = []
  const byId = new Map(patch.modules.map((m) => [m.id, m]))

  // --- slots ---------------------------------------------------------
  // Slot 0 is ground: unpatched inputs read it and nothing ever writes it.
  let nextSlot = 1
  const outSlotOf = new Map<string, number>()
  for (const m of patch.modules) {
    for (const port of defOf(m.type).outputs) {
      outSlotOf.set(`${m.id}.${port.id}`, nextSlot++)
    }
  }
  // The speaker pair. No module writes these: the engine sums every main mix
  // into them, and they are what an unpatched recorder falls back to.
  const monitorSlotL = nextSlot++
  const monitorSlotR = nextSlot++

  // --- cables --------------------------------------------------------
  // One cable per input, as on real hardware; a second cable into the same
  // jack replaces the first rather than summing.
  const sourceOfInput = new Map<string, string>()
  const validCables = patch.cables.filter((c) => {
    const from = byId.get(c.from.module)
    const to = byId.get(c.to.module)
    if (!from || !to) {
      warnings.push(`cable ${c.id}: references a module that is not in the patch`)
      return false
    }
    if (!defOf(from.type).outputs.some((p) => p.id === c.from.port)) {
      warnings.push(`cable ${c.id}: ${from.type} has no output "${c.from.port}"`)
      return false
    }
    if (!defOf(to.type).inputs.some((p) => p.id === c.to.port)) {
      warnings.push(`cable ${c.id}: ${to.type} has no input "${c.to.port}"`)
      return false
    }
    return true
  })

  for (const c of validCables) {
    const key = `${c.to.module}.${c.to.port}`
    if (sourceOfInput.has(key)) {
      warnings.push(`input ${key} had more than one cable; keeping the last`)
    }
    sourceOfInput.set(key, `${c.from.module}.${c.from.port}`)
  }
  const connected = validCables.filter(
    (c) => sourceOfInput.get(`${c.to.module}.${c.to.port}`) === `${c.from.module}.${c.from.port}`,
  )

  // --- ordering ------------------------------------------------------
  const { order, feedbackCables } = topoSort(patch, connected)

  // --- parameters ----------------------------------------------------
  const params: number[] = []
  const paramIndex: Record<string, number> = {}
  const paramBaseOf = new Map<string, number>()
  for (const m of patch.modules) {
    paramBaseOf.set(m.id, params.length)
    for (const spec of defOf(m.type).params) {
      paramIndex[`${m.id}.${spec.id}`] = params.length
      params.push(m.params[spec.id] ?? spec.default)
    }
  }

  // --- what the speakers hear ----------------------------------------
  /**
   * A stereo bus is a main mix unless it feeds something that can carry the
   * signal on. That single rule covers both of the ways a mixer gets used:
   * patch one into another and you hear it through the second rather than
   * twice, and patch one into a recorder or a scope -- modules with no
   * outputs at all -- and it is still a main mix, because a tap is not a
   * destination.
   */
  const carriedOn = new Set<string>()
  for (const c of connected) {
    const to = byId.get(c.to.module)!
    if (defOf(to.type).outputs.length > 0) carriedOn.add(`${c.from.module}.${c.from.port}`)
  }

  const monitors: { l: number; r: number }[] = []
  for (const m of patch.modules) {
    const bus = defOf(m.type).bus
    if (!bus || bus.some((port) => carriedOn.has(`${m.id}.${port}`))) continue
    monitors.push({
      l: outSlotOf.get(`${m.id}.${bus[0]}`)!,
      r: outSlotOf.get(`${m.id}.${bus[1]}`)!,
    })
  }
  if (monitors.length === 0) {
    warnings.push('nothing in this patch reaches the speakers; a mixer does that')
  }

  // Where a render is taken from. Unpatched, the recorder records the
  // speakers, so a rack you can hear is a rack you can render.
  let renderSlotL = monitorSlotL
  let renderSlotR = monitorSlotR
  const tapModule = patch.modules.find((m) => defOf(m.type).tap)
  if (tapModule) {
    const [portL, portR] = defOf(tapModule.type).tap!
    const l = sourceOfInput.get(`${tapModule.id}.${portL}`)
    const r = sourceOfInput.get(`${tapModule.id}.${portR}`)
    if (l || r) {
      renderSlotL = l ? (outSlotOf.get(l) ?? 0) : 0
      // R normals to L, so a mono patch needs one cable.
      renderSlotR = r ? (outSlotOf.get(r) ?? 0) : renderSlotL
    }
  }

  // --- voices --------------------------------------------------------
  // Everything a note passes through before it reaches something shared.
  // Walked along the cables from the Keyboard, feedback included: a module
  // fed by a voice is part of that voice, and a module fed only by the rest
  // of the rack -- a free-running LFO, a noise source -- stays single and is
  // heard by every voice alike.
  const root = patch.modules.find((m) => defOf(m.type).playable)
  const poly = new Set<string>()
  if (root) {
    poly.add(root.id)
    const queue = [root.id]
    while (queue.length) {
      const id = queue.pop()!
      for (const c of connected) {
        if (c.from.module !== id || poly.has(c.to.module)) continue
        if (defOf(byId.get(c.to.module)!.type).shared) continue
        poly.add(c.to.module)
        queue.push(c.to.module)
      }
    }
  }

  // --- assemble ------------------------------------------------------

  const modules: CompiledModule[] = order.map((id) => {
    const m = byId.get(id)!
    const def = defOf(m.type)
    return {
      id: m.id,
      type: m.type,
      ins: def.inputs.map((p) => {
        const src = sourceOfInput.get(`${m.id}.${p.id}`)
        return src ? (outSlotOf.get(src) ?? 0) : 0
      }),
      outs: def.outputs.map((p) => outSlotOf.get(`${m.id}.${p.id}`)!),
      paramBase: paramBaseOf.get(m.id)!,
      paramCount: def.params.length,
      // The id only; the audio travels beside the patch, never inside it.
      sample: m.sample?.id,
      ...(poly.has(m.id) ? { poly: true } : {}),
    }
  })

  return {
    modules,
    slotCount: nextSlot,
    params,
    paramIndex,
    feedbackCables,
    monitors,
    monitorSlotL,
    monitorSlotR,
    renderSlotL,
    renderSlotR,
    ...(root
      ? {
          voices: {
            root: root.id,
            // The Keyboard's only input is its Gate jack.
            gateSlot: modules.find((m) => m.id === root.id)!.ins[0] ?? 0,
            voicesParam: paramIndex[`${root.id}.voices`] ?? -1,
            noteParam: paramIndex[`${root.id}.note`] ?? -1,
          },
        }
      : {}),
    warnings,
  }
}

/**
 * Depth-first topological sort. Edges that close a cycle are reported as
 * feedback rather than treated as an error: a patch with a feedback loop is a
 * legitimate patch, and the one-sample delay falls out of the slot ordering
 * for free.
 */
function topoSort(patch: Patch, cables: { id: string; from: { module: string }; to: { module: string } }[]) {
  const edges = new Map<string, { to: string; cable: string }[]>()
  for (const m of patch.modules) edges.set(m.id, [])
  for (const c of cables) {
    edges.get(c.from.module)!.push({ to: c.to.module, cable: c.id })
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(patch.modules.map((m) => [m.id, WHITE]))
  const postOrder: string[] = []
  const feedbackCables: string[] = []

  for (const root of patch.modules) {
    if (color.get(root.id) !== WHITE) continue

    // Iterative to keep deep patches off the JS call stack.
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }]
    color.set(root.id, GRAY)

    while (stack.length) {
      const frame = stack[stack.length - 1]
      const out = edges.get(frame.id)!

      if (frame.next >= out.length) {
        color.set(frame.id, BLACK)
        postOrder.push(frame.id)
        stack.pop()
        continue
      }

      const edge = out[frame.next++]
      const c = color.get(edge.to)
      if (c === GRAY) {
        // Back edge: this cable reads last sample's value.
        feedbackCables.push(edge.cable)
      } else if (c === WHITE) {
        color.set(edge.to, GRAY)
        stack.push({ id: edge.to, next: 0 })
      }
    }
  }

  return { order: postOrder.reverse(), feedbackCables }
}
