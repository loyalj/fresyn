/**
 * The hues a pattern or a track can be given, stepped through one click at a
 * time and round to none. Spread round the wheel so neighbours differ, and
 * only hues: how saturated and light they are is the theme's business, the
 * same as the cables'.
 */
export const HUES = [0, 30, 55, 95, 150, 190, 215, 260, 300, 335]

/** The next colour after this one, ending at none. */
export function nextHue(current: number | undefined): number | undefined {
  if (current === undefined) return HUES[0]
  const at = HUES.indexOf(current)
  return at >= 0 && at + 1 < HUES.length ? HUES[at + 1] : undefined
}
