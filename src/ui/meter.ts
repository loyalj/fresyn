/**
 * What a level bar does with a number, shared by every panel that has one.
 *
 * The loop that draws them is `useFallingMeter`; the scale and the fall are
 * here because they are policy, not plumbing, and two meters in the same
 * rack that disagreed about either would be two meters you could not
 * compare.
 */

/** Quieter than this reads as silence, as it does on the scope. */
export const FLOOR_DB = -48

/**
 * How far a bar falls per frame at 60 Hz: full scale to silence in about
 * three quarters of a second. A meter that tracked a 30 Hz peak exactly
 * would be a strobe -- the fall is what the eye actually reads a level off.
 */
export const FALL = 1 / 45

/**
 * Amplitude to a fraction of the bar, on a decibel scale. A linear meter
 * spends almost all of its travel in the loudest few decibels, so everything
 * below a shout sits flat on the floor and tells you nothing.
 */
export function scale(amplitude: number) {
  if (amplitude <= 0) return 0
  const db = 20 * Math.log10(amplitude)
  if (db <= FLOOR_DB) return 0
  return db >= 0 ? 1 : 1 - db / FLOOR_DB
}

/**
 * Show a bar at a fraction of its height. Clipped rather than scaled:
 * scaling the fill would squash its gradient, so a bar at a tenth would be
 * painted in the colour the top of the scale is meant to be reserved for.
 */
export function fillBar(el: HTMLElement | null | undefined, fraction: number) {
  if (el) el.style.clipPath = `inset(${(1 - fraction) * 100}% 0 0 0)`
}
