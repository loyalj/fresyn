/**
 * Deterministic randomness for the audio thread.
 *
 * Reproducible renders are the foundation of the whole export workflow: a
 * variation batch is the same patch rendered under a series of known seeds,
 * and a bug report is only useful if the sound can be produced again.
 * `Math.random` cannot do either.
 */

/** mulberry32: small, fast, and good enough for noise and modulation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a, for turning a module id into a seed. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * A module's own stream, derived from the patch seed and its id.
 *
 * Deriving per module rather than sharing one stream means adding or removing
 * a module does not reshuffle what every other module hears -- one extra LFO
 * should not change the noise in a render that was otherwise identical.
 */
export function streamSeed(seed: number, moduleId: string): number {
  return (hashString(moduleId) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0
}

export function streamFor(seed: number, moduleId: string): () => number {
  return mulberry32(streamSeed(seed, moduleId))
}

/** The seed a rack plays on until a render asks for a different one. */
export const DEFAULT_SEED = 0x5eed
