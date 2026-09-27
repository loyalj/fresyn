import type { ModuleDef } from '../patch/types'

/** Neither side of a pair gets less than this, however bare it is. */
const MIN_SHARE = 0.34

/**
 * How much of a row each half-width unit takes, by module id.
 *
 * Two half panels side by side used to split the row down the middle, which
 * left a two-knob VCA beside a five-knob filter with most of its panel empty.
 * Each pair now splits the row by how much is on the two faces -- within
 * limits, so a bare unit still reads as a panel and not a strip.
 *
 * The pairing is the one the rack has always made: in rack order, a half
 * panel pairs with the half panel after it, and one with no half panel after
 * it keeps half a row to itself, the rest left as blank rack space.
 */
export function rackShares(
  order: readonly string[],
  defOf: (id: string) => ModuleDef | undefined,
): Map<string, number> {
  const shares = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    const a = defOf(order[i])
    if (a?.width !== 'half') continue
    const b = defOf(order[i + 1] ?? '')
    if (b?.width !== 'half') {
      shares.set(order[i], 0.5)
      continue
    }
    const wa = weight(a)
    const wb = weight(b)
    const share = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, wa / (wa + wb)))
    shares.set(order[i], share)
    shares.set(order[i + 1], 1 - share)
    i++
  }
  return shares
}

/** What is on the face: the knobs and switches, which is what takes room. */
function weight(def: ModuleDef) {
  return Math.max(1, def.params.filter((p) => !p.played).length)
}
