/**
 * The furthest a signal is allowed to go anywhere a patch can make it grow.
 *
 * A thousand is two orders of magnitude past anything a rack means by a
 * signal -- the loudest CV in normal use is a handful of units, audio is one
 * -- so nothing that is working ever touches it. It exists for the patch that
 * is not working: a VCA with its own output on its CV jack, a ring modulator
 * fed back into its carrier, a CV utility at gain 2 round a loop. Each of
 * those multiplies a signal by itself, or by more than one, on every sample,
 * and without a rail reaches infinity in a few milliseconds -- after which
 * infinity minus infinity is NaN, and NaN goes everywhere and stays there.
 *
 * Held at the rail instead, the patch is broken and loud, which is honest,
 * and it comes back the moment the cable is pulled.
 */
export const RAIL = 1000

/** Held to ±RAIL, and a NaN to nothing. */
export function railed(x: number) {
  if (x >= -RAIL && x <= RAIL) return x
  return x > 0 ? RAIL : x < 0 ? -RAIL : 0
}
