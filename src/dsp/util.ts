/**
 * The small pieces of arithmetic that nearly every module needs, kept in one
 * place so that they are spelt one way.
 *
 * Each of these used to be written out wherever it was wanted, and a thing
 * written out five times is five chances for one copy to drift: a pan law a
 * hair different in the granulator than in the mixer, a trigger a sample
 * longer on one module than on its neighbour. Nothing here is clever. What
 * matters is that it is the same everywhere, and that every one of these is
 * a plain function small enough for the JIT to inline, so a module that calls
 * one per sample pays nothing for the name.
 *
 * Each is also written with exactly the operations, in exactly the order, of
 * the copies it replaced. Floating point is not associative, and a helper that
 * tidied `a * b * c` into `a * (b * c)` would change what every patch sounds
 * like by a rounding error -- inaudible, but enough that a render stops being
 * bit-for-bit what it was, which is the property the checks lean on.
 *
 * `Rail.ts` and `Adaa.ts` are the same kind of thing and stay where they are:
 * each has a single job and a long story about why, and is easier to find
 * under its own name.
 */

/** `v` held to `lo..hi`. A NaN passes through untouched, as it always has. */
export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

// --- one-pole time constants -----------------------------------------------
//
// Every glide, smoother and envelope segment in the rack is a one-pole, and
// every one of them is specified by a *time constant*: the time to cover
// 1 - 1/e (about 63%) of the distance, not the time to fall 60 dB. The reverb
// is the only thing that thinks in 60 dB times, and it keeps its own formula
// (`feedbackFor`), because it is the per-round gain of a delay line and not a
// per-sample coefficient at all.
//
// A one-pole can be written two ways round, and the rack uses both, so there
// are two helpers rather than one and a subtraction at every call site:
//
//   y = target + (y - target) * decay     -- what is *left* of the gap
//   y += (target - y) * step              -- how much of it is *closed*
//
// where step = 1 - decay. Both take the time constant already in samples.
// Callers disagree about what to do with a time shorter than a sample (the
// compressor jumps straight there, the envelope clamps to one sample), and
// that belongs to each of them, so it is left at the call site.

/**
 * How much of the gap to a target a one-pole leaves after one sample, for a
 * time constant of `samples`.
 */
export function tauDecay(samples: number) {
  return Math.exp(-1 / samples)
}

/**
 * How much of the gap to a target a one-pole closes in one sample, for a time
 * constant of `samples`. One minus `tauDecay`, written out rather than calling
 * it so that the operations are the same ones the call sites always did.
 */
export function tauStep(samples: number) {
  return 1 - Math.exp(-1 / samples)
}

// --- triggers ----------------------------------------------------------------

/**
 * How long every trigger and End pulse in the rack stays high: long enough for
 * anything downstream to catch, short enough never to read as a gate. One
 * number, so that an Envelope's End patched to a Burst lines up with the
 * Burst's own End, and the Dust's triggers are the same width as the Drunk's.
 */
export const PULSE_SECONDS = 0.002

/** That pulse in samples at `sampleRate`, and never less than one. */
export function pulseSamples(sampleRate: number) {
  return Math.max(1, Math.round(PULSE_SECONDS * sampleRate))
}

// --- control voltage ---------------------------------------------------------

/**
 * A knob moved by an exponential CV: `base` times two to the `cv * amount`.
 *
 * The rack's CV convention is a volt per octave, so a rate, a cutoff or a
 * pitch doubles for every unit of CV at an amount of one, and a fixed amount
 * moves it by the same musical interval wherever the knob sits. Almost every
 * module with a CV jack beside a frequency-like knob does exactly this.
 */
export function expCv(base: number, cv: number, amount: number) {
  return base * Math.pow(2, cv * amount)
}

// --- panning -----------------------------------------------------------------

/**
 * The constant-power pan law, for a pan of -1 (left) to 1 (right): a quarter
 * turn of a circle, so the two gains' squares always sum to one and a sound
 * swept across the field keeps its loudness rather than dipping in the middle
 * as a straight crossfade does. Centre is -3 dB each side.
 *
 * Split into two functions rather than returning a pair, so that nothing on
 * the audio thread allocates to pan.
 */
export function panLeft(pan: number) {
  return Math.cos(((pan + 1) / 2) * (Math.PI / 2))
}

/** The right-hand gain of the same law as `panLeft`. */
export function panRight(pan: number) {
  return Math.sin(((pan + 1) / 2) * (Math.PI / 2))
}
