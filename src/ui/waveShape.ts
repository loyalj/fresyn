import { PolyBlepOsc, type Waveform } from '../dsp/PolyBlepOsc'

/**
 * Two cycles of a wave, produced by running the same oscillator the audio
 * thread runs.
 *
 * Drawing it from line segments instead would be easier and would quietly
 * lie, the same way a hand-drawn envelope would. Width puts the triangle's
 * peak where it puts the pulse's falling edge, by rules that live in the
 * core; a picture drawn from a second copy of those rules would stop matching
 * the sound the first time either changed.
 *
 * Two cycles rather than one because a single period drawn on its own reads
 * as a shape, and what this is for is reading it as a wave -- the jump from
 * the end of one cycle back to the start of the next is the part of a saw
 * that makes it a saw.
 */
export function waveShape(wave: Waveform, width: number, perCycle = 128, cycles = 2) {
  // A sample rate of `perCycle` against a frequency of 1 gives exactly that
  // many samples per cycle, whatever the panel happens to be tuned to. The
  // band limiting is then a corner rounded across a column or so, which is
  // both true and nearly invisible -- which is the right amount of honesty
  // for a picture this size.
  const osc = new PolyBlepOsc(perCycle)
  const values = new Float32Array(perCycle * cycles)
  for (let i = 0; i < values.length; i++) values[i] = osc.process(1, wave, width)
  return values
}
