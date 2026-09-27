import type { PortRef } from '../patch/edit'
import type { ModuleDef, PortDef } from '../patch/types'
import { Jack, type JackKind } from './Jack'
import { UnitSpine } from './UnitSpine'

interface Props {
  def: ModuleDef
  moduleId: string
  isOccupied: (ref: PortRef, kind: JackKind) => boolean
  isCandidate: (ref: PortRef, kind: JackKind) => boolean
  register: (key: string, el: HTMLElement | null) => void
  onJackDown: (ref: PortRef, kind: JackKind, e: React.PointerEvent) => void
  /** Begin a reorder drag from this unit's spine. */
  onGrab?: (e: React.PointerEvent) => void
  bypassed?: boolean
  onBypass?: () => void
}

interface Slot {
  port: PortDef
  kind: JackKind
}

interface Block {
  label: string
  slots: Slot[]
}

/** The headings for jacks that do not name a block of their own. */
const DEFAULT_BLOCK: Record<JackKind, string> = { input: 'in', output: 'out' }

/**
 * The panel's jacks, divided into the boxes they are drawn in.
 *
 * Gathered by name rather than by runs of adjacent ports, because a block is
 * allowed to hold both sides at once: the Sample & Hold groups by channel, so
 * CH 1 holds two inputs and two outputs and neither list could have spelled
 * that on its own. Blocks come out in the order their first port appears,
 * inputs before outputs within each one.
 */
function blocksOf(def: ModuleDef): Block[] {
  const blocks: Block[] = []
  const byLabel = new Map<string, Block>()

  const gather = (ports: PortDef[], kind: JackKind) => {
    for (const port of ports) {
      const label = port.block ?? DEFAULT_BLOCK[kind]
      let block = byLabel.get(label)
      if (!block) {
        block = { label, slots: [] }
        byLabel.set(label, block)
        blocks.push(block)
      }
      block.slots.push({ port, kind })
    }
  }

  gather(def.inputs, 'input')
  gather(def.outputs, 'output')
  return blocks
}

/**
 * The reverse of a rack unit: nothing but patch points, in labelled boxes.
 * Keeping the patch points on their own face is the whole point of the rack
 * metaphor -- the front stays readable because the wiring is not competing
 * with it for space.
 *
 * Boxed and headed rather than laid out as one long row of holes, the way the
 * back of a mixing desk is. A module with a dozen jacks was a row you had to
 * count along to patch, and below the one-column breakpoint the far end of
 * that row was clipped off the panel and out of reach. Blocks wrap.
 *
 * They pack from the left rather than holding inputs and outputs to opposite
 * edges. Blocks that hold a channel carry both sides anyway, so the old rule
 * could not have survived them, and a heading says which a jack is at least
 * as plainly as which end of the panel it sits on.
 */
export function BackPanel({
  def,
  moduleId,
  isOccupied,
  isCandidate,
  register,
  onJackDown,
  onGrab,
  bypassed,
  onBypass,
}: Props) {
  const renderJack = ({ port, kind }: Slot) => {
    const ref = { module: moduleId, port: port.id }
    return (
      <Jack
        key={port.id}
        moduleId={moduleId}
        portId={port.id}
        label={port.label}
        kind={kind}
        occupied={isOccupied(ref, kind)}
        candidate={isCandidate(ref, kind)}
        register={register}
        onPointerDown={onJackDown}
      />
    )
  }

  return (
    <div className="unit unit-rear">
      <UnitSpine def={def} moduleId={moduleId} onGrab={onGrab} bypassed={bypassed} onBypass={onBypass} />

      <div className="unit-face back-face">
        {blocksOf(def).map((block) => (
          <div className="jack-block" key={block.label}>
            <span className="jack-block-label">{block.label}</span>
            <div className="jack-block-jacks">{block.slots.map(renderJack)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
