/**
 * First-order antiderivative anti-aliasing, shared by the shapers.
 *
 * A waveshaper run a sample at a time makes harmonics whether or not there is
 * room for them below Nyquist, and the ones with no room fold back down as
 * tones that have nothing to do with the note: the whistle in a hard-driven
 * high note. Oversampling pushes the problem up; this makes most of it go
 * away for the price of a subtraction and a divide.
 *
 * The trick is to output the shaper's *average* over the straight line between
 * the previous input and this one, rather than its value at this one point.
 * That average is the difference of the shaper's antiderivative at the two
 * ends, divided by the distance between them. A corner in the curve -- a clip,
 * a fold -- is smeared over the sample it falls in instead of landing on one
 * side of it, and a smeared corner has far less energy up where it would fold.
 *
 * What it costs: half a sample of delay, and a gentle roll-off at the very top
 * (the same as averaging two neighbouring samples -- half a decibel at 5 kHz,
 * two at 10 kHz). Level, curve and harmonics are otherwise what they were.
 */

/**
 * Closer than this and the divide is noise over noise, so the shaper is taken
 * at the midpoint instead, which is what the average tends to anyway.
 */
export const ADAA_EPS = 1e-5

/**
 * Past this the input is not a signal but a fault. Held to zero, so that the
 * previous-input state the average needs can never become NaN or infinite
 * and take every sample after it with it.
 */
const SANE = 1e6

/** Zero for a NaN, an infinity or something absurd; the value otherwise. */
export function saneInput(x: number) {
  return x > -SANE && x < SANE ? x : 0
}

/** The antiderivative of tanh, ln cosh x, written so it cannot overflow. */
export function logCosh(x: number) {
  const a = x < 0 ? -x : x
  // cosh overflows past about 710; this form is exact and never does.
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2
}

/** Antiderivative of a hard clip at ±1. */
export function clipIntegral(x: number) {
  const a = x < 0 ? -x : x
  return a <= 1 ? 0.5 * x * x : a - 0.5
}
